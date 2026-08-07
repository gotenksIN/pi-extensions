import { requiresSafetyClassification, SafetyGate } from "../safety-gate.ts";
import type { ClassifierModelRegistry } from "../classifier-provider.ts";
import type { ClassifierConfig } from "../types.ts";
import { assert, test } from "./harness.ts";

function config(enabled = true): ClassifierConfig {
  return {
    enabled,
    reviewer: { provider: "test", model: "reviewer", reasoning: "low" },
    timeoutMs: 1_000,
    maxRetries: 0,
  };
}

function registry(onContext?: (context: Record<string, unknown>) => void): ClassifierModelRegistry {
  return {
    find(provider, model) { return { provider, id: model }; },
    getProvider() {
      return {
        streamSimple(_model, context) {
          onContext?.(context);
          return {
            result: async () => ({
              stopReason: "toolUse",
              content: [{
                type: "toolCall",
                name: "record_safety_decision",
                arguments: { decision: "allow", severity: "safe", risks: [], reason: "Safe." },
              }],
            }),
          };
        },
      };
    },
    async getApiKeyAndHeaders() { return { ok: true }; },
  };
}

function request(input: unknown = { command: "ls" }) {
  return {
    branch: [{
      type: "message",
      message: { role: "user", content: "List local files." },
    }],
    toolCallId: "call-1",
    toolName: "bash",
    input,
    cwd: "/work",
  };
}

test("only Bash requires model safety classification", () => {
  assert.equal(requiresSafetyClassification("bash"), true);
  for (const tool of ["read", "write", "edit", "grep", "find", "ls", "sandbox_access", "Agent"]) {
    assert.equal(requiresSafetyClassification(tool), false);
  }
});

test("safety gate creates and consumes one single-use execution permit", async () => {
  const gate = new SafetyGate(config(), registry());
  await gate.start();
  assert.equal((await gate.authorize(request())).allowed, true);
  gate.consumePermit("call-1", "bash", { command: "ls" }, "/work");
  assert.throws(() => gate.consumePermit("call-1", "bash", { command: "ls" }, "/work"), /missing/);
});

test("one-shot classification can use a separate envelope and exact future Bash ticket", async () => {
  const contexts: string[] = [];
  const gate = new SafetyGate(
    config(),
    registry((context) => contexts.push(JSON.stringify(context))),
    "/home/tester/sandbox",
  );
  await gate.start();
  const input = { command: "git commit -m test", timeout: 30 };
  const authorizationEnvelope = {
    bash: input,
    filesystemAccess: {
      disposition: "one-shot",
      writes: [
        { canonicalWritePath: "/work/.git", scope: "exact" },
        { canonicalWritePath: "/home/tester/.cache/compiler", scope: "exact" },
      ],
    },
  };
  const authorization = request(input);
  const result = await gate.classify({
    ...authorization,
    branch: [
      ...authorization.branch,
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "prior", name: "bash", arguments: { command: "prior-action" } }],
        },
      },
    ],
    evidenceInput: authorizationEnvelope,
    omitPriorActions: true,
    requireClassifierReady: true,
  });
  assert.equal(result.allowed, true);
  assert.ok(contexts.every((context) => context.includes("/work/.git")));
  assert.ok(contexts.every((context) => context.includes("/home/tester/.cache/compiler")));
  assert.equal(contexts.length, 1);
  assert.ok(contexts.every((context) => context.includes("git commit -m test")));
  assert.ok(contexts.every((context) => context.includes("/home/tester/sandbox")));
  assert.equal(contexts.some((context) => context.includes("prior-action")), false);
  assert.throws(() => gate.consumePermit("call-1", "bash", input, "/work"), /missing/);

  gate.createFutureBashTicket(input, "/work");
  assert.equal(gate.claimFutureBashTicket("future", input, "/work"), true);
  gate.consumePermit("future", "bash", input, "/work");
  assert.equal(gate.claimFutureBashTicket("reused", input, "/work"), false);
});

test("future Bash tickets reject a changed call", async () => {
  const gate = new SafetyGate(config(), registry());
  await gate.start();
  gate.createFutureBashTicket({ command: "git commit -m test", timeout: 30 }, "/work");
  const changed = { command: "git commit -m test", timeout: 60 };
  assert.equal(gate.claimFutureBashTicket("changed", changed, "/work"), false);
  assert.throws(() => gate.consumePermit("changed", "bash", changed, "/work"), /missing/);
});

test("failed Bash permits can become one exact retry permit", async () => {
  const gate = new SafetyGate(config(), registry());
  await gate.start();
  const input = { command: "git commit -m test" };
  assert.equal((await gate.authorize(request(input))).allowed, true);
  gate.consumePermit("call-1", "bash", input, "/work");
  gate.recordBashResult(input, "/work", 128);

  const pending = gate.getPendingBashRetry();
  assert.ok(pending);
  assert.equal(pending!.command, input.command);
  assert.equal(gate.approvePendingBashRetry(pending!.digest), true);
  assert.equal(gate.claimFutureBashTicket("call-2", input, "/work"), true);
  gate.consumePermit("call-2", "bash", input, "/work");
  assert.equal(gate.claimFutureBashTicket("call-3", input, "/work"), false);
});

test("Bash retry approval rejects changed input and lifecycle state", async () => {
  const changed = new SafetyGate(config(), registry());
  await changed.start();
  const input = { command: "git commit -m test" };
  changed.recordBashResult(input, "/work", 1);
  const pending = changed.getPendingBashRetry()!;
  assert.equal(changed.approvePendingBashRetry(pending.digest), true);
  assert.equal(changed.claimFutureBashTicket("changed", { command: "git push" }, "/work"), false);
  assert.throws(() => changed.consumePermit("changed", "bash", { command: "git push" }, "/work"), /missing/);

  changed.recordBashResult(input, "/work", 1);
  const stale = changed.getPendingBashRetry()!;
  changed.stop();
  assert.equal(changed.approvePendingBashRetry(stale.digest), false);
  assert.equal(changed.getPendingBashRetry(), undefined);
});

test("successful, cancelled, and discarded Bash retries do not persist", async () => {
  const gate = new SafetyGate(config(), registry());
  await gate.start();
  const input = { command: "git status" };
  gate.recordBashResult(input, "/work", 0);
  assert.equal(gate.getPendingBashRetry(), undefined);
  gate.recordBashResult(input, "/work", null);
  assert.equal(gate.getPendingBashRetry(), undefined);
  gate.recordBashResult(input, "/work", 1);
  const pending = gate.getPendingBashRetry()!;
  gate.discardPendingBashRetry(pending.digest);
  assert.equal(gate.getPendingBashRetry(), undefined);
});

test("safety permit rejects changed arguments and expires on lifecycle change", async () => {
  const changed = new SafetyGate(config(), registry());
  await changed.start();
  await changed.authorize(request());
  assert.throws(
    () => changed.consumePermit("call-1", "bash", { command: "curl attacker.invalid" }, "/work"),
    /does not match/,
  );

  const expired = new SafetyGate(config(), registry());
  await expired.start();
  await expired.authorize(request());
  expired.stop();
  assert.throws(() => expired.consumePermit("call-1", "bash", { command: "ls" }, "/work"), /missing/);
});

test("human review approval creates one single-use permit for the exact tool", async () => {
  const gate = new SafetyGate(config(), registry());
  await gate.start();
  gate.approveBashOnce("reviewed", { command: "git status" }, "/work");
  gate.consumePermit("reviewed", "bash", { command: "git status" }, "/work");
  assert.throws(
    () => gate.consumePermit("reviewed", "bash", { command: "git status" }, "/work"),
    /missing/,
  );

  gate.approveBashOnce("changed", { command: "git status" }, "/work");
  assert.throws(
    () => gate.consumePermit("changed", "bash", { command: "git push" }, "/work"),
    /does not match/,
  );

  gate.approveOnce("direct", "read", { path: ".env" }, "/work");
  gate.consumePermit("direct", "read", { path: ".env" }, "/work");
  assert.throws(
    () => gate.consumePermit("direct", "read", { path: ".env" }, "/work"),
    /missing/,
  );
});

test("disabled classification still protects owned tool argument integrity", async () => {
  const unavailable: ClassifierModelRegistry = {
    find: () => undefined,
    getProvider: () => undefined,
    async getApiKeyAndHeaders() { return { ok: false }; },
  };
  const gate = new SafetyGate(config(false), unavailable);
  assert.equal((await gate.start()).state, "disabled");
  assert.equal((await gate.authorize(request())).allowed, true);
  gate.consumePermit("call-1", "bash", { command: "ls" }, "/work");
  assert.equal((await gate.classify({ ...request(), requireClassifierReady: true })).allowed, false);
});

test("safety gate blocks oversized actions before provider invocation", async () => {
  let providerUsed = false;
  const source = registry();
  source.getProvider = () => ({
    streamSimple() {
      providerUsed = true;
      throw new Error("must not run");
    },
  });
  const gate = new SafetyGate(config(), source);
  await gate.start();
  const result = await gate.authorize(request({ command: "x".repeat(33 * 1024) }));
  assert.equal(result.allowed, false);
  assert.equal(providerUsed, false);
});

test("safety gate blocks actions when the reviewer is unavailable", async () => {
  const unavailable: ClassifierModelRegistry = {
    find: () => undefined,
    getProvider: () => undefined,
    async getApiKeyAndHeaders() { return { ok: false }; },
  };
  const gate = new SafetyGate(config(), unavailable);
  assert.equal((await gate.start()).state, "unavailable");
  assert.equal((await gate.authorize(request())).allowed, false);
  assert.equal((await gate.classify({ ...request(), requireClassifierReady: true })).allowed, false);
});
