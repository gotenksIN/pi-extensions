import { PiClassifierStageInvoker, type ClassifierModelRegistry } from "../classifier-provider.ts";
import { assert, test } from "./harness.ts";

function assistant(content: unknown[], stopReason = "toolUse") {
  return { stopReason, content };
}

function registryWithResponse(response: unknown, capture: Record<string, unknown> = {}): ClassifierModelRegistry {
  return {
    find(provider, model) { return { provider, id: model, baseUrl: "https://model.example" }; },
    getProvider() {
      return {
        streamSimple(model, context, options) {
          capture.model = model;
          capture.context = context;
          capture.options = options;
          return { result: async () => response as any };
        },
      };
    },
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "test-key", headers: { "X-Test": "one" }, env: { REGION: "test" } };
    },
    async getProviderAuth() { return { auth: { baseUrl: "https://auth.example" } }; },
  };
}

test("Pi classifier invocation reuses resolved auth and provider transport", async () => {
  const capture: Record<string, any> = {};
  const invoker = new PiClassifierStageInvoker(registryWithResponse(assistant([
    { type: "toolCall", name: "record_stage1_decision", arguments: { decision: "allow", reason: "Safe." } },
  ]), capture));
  const resolved = await invoker.resolve("google", { model: "fast", reasoning: "minimal" });
  assert.ok(resolved);
  const outcome = await invoker.invokeStage1({
    stage: 1, resolved: resolved!, evidence: "{}", timeoutMs: 1_000, maxRetries: 1,
  });
  assert.deepEqual(outcome, { kind: "decision", decision: { decision: "allow", reason: "Safe." } });
  assert.equal(capture.model.baseUrl, "https://auth.example");
  assert.equal(capture.options.apiKey, "test-key");
  assert.deepEqual(capture.options.headers, { "X-Test": "one" });
  assert.deepEqual(capture.options.env, { REGION: "test" });
  assert.equal(capture.options.reasoning, "minimal");
  assert.equal(capture.options.maxRetries, 1);
  assert.equal(capture.options.maxTokens, 256);
  assert.ok(capture.context.messages[0].content.includes("Only proposedAction may run now"));
  assert.ok(capture.context.messages[0].content.includes("completedPriorActions already finished"));
});

test("none reasoning omits the Pi reasoning option", async () => {
  const capture: Record<string, any> = {};
  const invoker = new PiClassifierStageInvoker(registryWithResponse(assistant([
    {
      type: "toolCall",
      name: "record_stage2_decision",
      arguments: { decision: "allow", severity: "safe", risks: [], reason: "Safe." },
    },
  ]), capture));
  const resolved = await invoker.resolve("openai", { model: "nano", reasoning: "none" });
  const outcome = await invoker.invokeStage2({
    stage: 2, resolved: resolved!, evidence: "{}", timeoutMs: 1_000, maxRetries: 0,
  });
  assert.equal(outcome.kind, "decision");
  assert.equal(Object.hasOwn(capture.options, "reasoning"), false);
  assert.equal(capture.options.maxTokens, 2_048);
  assert.ok(capture.context.messages[0].content.includes("Only proposedAction may run now"));
  assert.ok(capture.context.messages[0].content.includes("completedPriorActions already finished"));
});

test("classifier provider rejects prose, extra calls, and contradictory output", async () => {
  const responses = [
    assistant([{ type: "text", text: "allow" }], "stop"),
    assistant([
      { type: "toolCall", name: "record_stage1_decision", arguments: { decision: "allow" } },
      { type: "toolCall", name: "record_stage1_decision", arguments: { decision: "allow" } },
    ]),
    assistant([
      { type: "text", text: "Here is the result." },
      { type: "toolCall", name: "record_stage1_decision", arguments: { decision: "allow" } },
    ]),
  ];
  for (const response of responses) {
    const invoker = new PiClassifierStageInvoker(registryWithResponse(response));
    const resolved = await invoker.resolve("google", { model: "fast", reasoning: "minimal" });
    const outcome = await invoker.invokeStage1({
      stage: 1, resolved: resolved!, evidence: "{}", timeoutMs: 1_000, maxRetries: 0,
    });
    assert.equal(outcome.kind, "invalid");
  }
});

test("provider errors are technical but output limits are semantic failures", async () => {
  for (const [stopReason, expected] of [["error", "technical"], ["length", "invalid"]] as const) {
    const invoker = new PiClassifierStageInvoker(registryWithResponse(assistant([], stopReason)));
    const resolved = await invoker.resolve("google", { model: "fast", reasoning: "minimal" });
    const outcome = await invoker.invokeStage1({
      stage: 1, resolved: resolved!, evidence: "{}", timeoutMs: 1_000, maxRetries: 0,
    });
    assert.equal(outcome.kind, expected);
  }
});

test("classifier stage timeout is distinct from technical fallback", async () => {
  const registry = registryWithResponse({});
  registry.getProvider = () => ({
    streamSimple(_model, _context, options) {
      return {
        result: () => new Promise((resolve) => {
          (options.signal as AbortSignal).addEventListener("abort", () => resolve(assistant([], "aborted")), { once: true });
        }),
      };
    },
  });
  const invoker = new PiClassifierStageInvoker(registry);
  const resolved = await invoker.resolve("google", { model: "fast", reasoning: "minimal" });
  const outcome = await invoker.invokeStage1({
    stage: 1, resolved: resolved!, evidence: "{}", timeoutMs: 5, maxRetries: 0,
  });
  assert.equal(outcome.kind, "timeout");
});

test("missing models and failed Pi auth make a stage unavailable", async () => {
  const missing = registryWithResponse({});
  missing.find = () => undefined;
  assert.equal(await new PiClassifierStageInvoker(missing).resolve("p", { model: "m", reasoning: "off" }), undefined);

  const unauthenticated = registryWithResponse({});
  unauthenticated.getApiKeyAndHeaders = async () => ({ ok: false, error: "not logged in" });
  assert.equal(
    await new PiClassifierStageInvoker(unauthenticated).resolve("p", { model: "m", reasoning: "off" }),
    undefined,
  );
});
