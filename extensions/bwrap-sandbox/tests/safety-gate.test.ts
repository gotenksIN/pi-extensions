import { requiresSafetyClassification, SafetyGate } from "../safety-gate.ts";
import type { ClassifierModelRegistry } from "../classifier-provider.ts";
import type { ClassifierConfig } from "../types.ts";
import { assert, test } from "./harness.ts";

function config(enabled = true): ClassifierConfig {
  return {
    enabled,
    pairs: [{
      provider: "test",
      stage1: { model: "fast", reasoning: "off" },
      stage2: { model: "strong", reasoning: "low" },
    }],
    stage1TimeoutMs: 1_000,
    stage2TimeoutMs: 1_000,
    maxRetries: 0,
  };
}

function registry(): ClassifierModelRegistry {
  return {
    find(provider, model) { return { provider, id: model }; },
    getProvider() {
      return {
        streamSimple(model) {
          const stage1 = model.id === "fast";
          return {
            result: async () => ({
              stopReason: "toolUse",
              content: [{
                type: "toolCall",
                name: stage1 ? "record_stage1_decision" : "record_stage2_decision",
                arguments: stage1
                  ? { decision: "allow", reason: "Safe." }
                  : { decision: "allow", severity: "safe", risks: [], reason: "Safe." },
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

test("Bash and content-access direct tools require safety classification", async () => {
  for (const tool of ["bash", "read", "write", "edit", "grep"]) {
    assert.equal(requiresSafetyClassification(tool), true);
  }
  for (const tool of ["find", "ls", "sandbox_access", "Agent"]) {
    assert.equal(requiresSafetyClassification(tool), false);
  }

  let providerCalls = 0;
  const providerRequests: string[] = [];
  const source = registry();
  const provider = source.getProvider("test")!;
  source.getProvider = () => ({
    streamSimple(model, context, options) {
      providerCalls += 1;
      providerRequests.push(JSON.stringify(context));
      return provider.streamSimple(model, context, options);
    },
  });
  const gate = new SafetyGate(config(), source);
  await gate.start();
  const input = { path: "a", content: "must-not-be-provider-evidence" };
  const result = await gate.authorize({
    ...request(input),
    toolName: "write",
    classifierInput: { domain: "direct-project-secret-access", target: { path: "a" } },
    classifierCwd: ":project",
    omitPriorActions: true,
  });
  assert.equal(result.allowed, true);
  assert.equal(providerCalls, 2);
  assert.ok(providerRequests.every((value) => !value.includes("must-not-be-provider-evidence")));
  assert.ok(providerRequests.every((value) => !value.includes("/work")));
  gate.consumePermit("call-1", "write", input, "/work");
});

test("safety gate creates and consumes one single-use execution permit", async () => {
  const gate = new SafetyGate(config(), registry());
  await gate.start();
  assert.equal((await gate.authorize(request())).allowed, true);
  gate.consumePermit("call-1", "bash", { command: "ls" }, "/work");
  assert.throws(() => gate.consumePermit("call-1", "bash", { command: "ls" }, "/work"), /missing/);
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

test("direct-tool indicators remain classifier evidence instead of local vetoes", async () => {
  const gate = new SafetyGate(config(), registry());
  await gate.start();
  const input = { path: ".env" };
  const result = await gate.authorize({
    ...request(input),
    toolName: "read",
    classifierInput: { target: { path: ".env", knownSecretPath: true } },
    omitPriorActions: true,
  });
  assert.equal(result.allowed, true);
  gate.consumePermit("call-1", "read", input, "/work");
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

test("safety gate blocks actions when no complete pair is available", async () => {
  const unavailable: ClassifierModelRegistry = {
    find: () => undefined,
    getProvider: () => undefined,
    async getApiKeyAndHeaders() { return { ok: false }; },
  };
  const gate = new SafetyGate(config(), unavailable);
  assert.equal((await gate.start()).state, "unavailable");
  assert.equal((await gate.authorize(request())).allowed, false);
});
