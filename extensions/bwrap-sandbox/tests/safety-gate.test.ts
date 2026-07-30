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
                  ? { decision: "allow" }
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

test("only model-generated Bash requires safety classification", async () => {
  assert.equal(requiresSafetyClassification("bash"), true);
  for (const tool of ["read", "write", "edit", "grep", "find", "ls", "sandbox_access", "Agent"]) {
    assert.equal(requiresSafetyClassification(tool), false);
  }

  let providerUsed = false;
  const source = registry();
  source.getProvider = () => ({
    streamSimple() {
      providerUsed = true;
      throw new Error("direct tools must not use the classifier");
    },
  });
  const gate = new SafetyGate(config(), source);
  await gate.start();
  const result = await gate.authorize({ ...request({ path: "a" }), toolName: "read" });
  assert.equal(result.allowed, true);
  assert.equal(providerUsed, false);
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

test("human review approval creates one single-use Bash permit", async () => {
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
