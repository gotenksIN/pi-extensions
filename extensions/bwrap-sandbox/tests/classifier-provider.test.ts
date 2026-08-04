import { PiClassifierInvoker, type ClassifierModelRegistry } from "../classifier-provider.ts";
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

const reviewer = { provider: "openai", model: "luna", reasoning: "low" } as const;

test("Pi classifier invocation reuses resolved auth and provider transport", async () => {
  const capture: Record<string, any> = {};
  const invoker = new PiClassifierInvoker(registryWithResponse(assistant([{
    type: "toolCall",
    name: "record_safety_decision",
    arguments: { decision: "allow", severity: "safe", risks: [], reason: "Safe." },
  }]), capture));
  const resolved = await invoker.resolve(reviewer);
  assert.ok(resolved);
  const outcome = await invoker.invoke({
    resolved: resolved!, evidence: "{}", timeoutMs: 1_000, maxRetries: 1,
  });
  assert.deepEqual(outcome, {
    kind: "decision",
    decision: { decision: "allow", severity: "safe", risks: [], reason: "Safe." },
  });
  assert.equal(capture.model.baseUrl, "https://auth.example");
  assert.equal(capture.options.apiKey, "test-key");
  assert.deepEqual(capture.options.headers, { "X-Test": "one" });
  assert.deepEqual(capture.options.env, { REGION: "test" });
  assert.equal(capture.options.reasoning, "low");
  assert.equal(capture.options.maxRetries, 1);
});

test("none reasoning omits the Pi reasoning option", async () => {
  const capture: Record<string, any> = {};
  const invoker = new PiClassifierInvoker(registryWithResponse(assistant([{
    type: "toolCall",
    name: "record_safety_decision",
    arguments: { decision: "allow", severity: "safe", risks: [], reason: "Safe." },
  }]), capture));
  const resolved = await invoker.resolve({ provider: "openai", model: "luna", reasoning: "none" });
  assert.equal((await invoker.invoke({
    resolved: resolved!, evidence: "{}", timeoutMs: 1_000, maxRetries: 0,
  })).kind, "decision");
  assert.equal(Object.hasOwn(capture.options, "reasoning"), false);
});

test("classifier provider rejects prose, extra calls, and contradictory output", async () => {
  const valid = { decision: "allow", severity: "safe", risks: [], reason: "Safe." };
  const responses = [
    assistant([{ type: "text", text: "allow" }], "stop"),
    assistant([
      { type: "toolCall", name: "record_safety_decision", arguments: valid },
      { type: "toolCall", name: "record_safety_decision", arguments: valid },
    ]),
    assistant([{
      type: "toolCall",
      name: "record_safety_decision",
      arguments: { decision: "allow", severity: "low", risks: [], reason: "Contradiction." },
    }]),
  ];
  for (const response of responses) {
    const invoker = new PiClassifierInvoker(registryWithResponse(response));
    const resolved = await invoker.resolve(reviewer);
    const outcome = await invoker.invoke({
      resolved: resolved!, evidence: "{}", timeoutMs: 1_000, maxRetries: 0,
    });
    assert.equal(outcome.kind, "invalid");
  }
});

test("provider errors are technical and output limits are invalid", async () => {
  for (const [stopReason, expected] of [["error", "technical"], ["length", "invalid"]] as const) {
    const invoker = new PiClassifierInvoker(registryWithResponse(assistant([], stopReason)));
    const resolved = await invoker.resolve(reviewer);
    assert.equal((await invoker.invoke({
      resolved: resolved!, evidence: "{}", timeoutMs: 1_000, maxRetries: 0,
    })).kind, expected);
  }
});

test("classifier timeout is distinct from a provider error", async () => {
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
  const invoker = new PiClassifierInvoker(registry);
  const resolved = await invoker.resolve(reviewer);
  assert.equal((await invoker.invoke({
    resolved: resolved!, evidence: "{}", timeoutMs: 5, maxRetries: 0,
  })).kind, "timeout");
});

test("missing models and failed Pi auth make the reviewer unavailable", async () => {
  const missing = registryWithResponse({});
  missing.find = () => undefined;
  assert.equal(await new PiClassifierInvoker(missing).resolve(reviewer), undefined);

  const unauthenticated = registryWithResponse({});
  unauthenticated.getApiKeyAndHeaders = async () => ({ ok: false, error: "not logged in" });
  assert.equal(await new PiClassifierInvoker(unauthenticated).resolve(reviewer), undefined);
});
