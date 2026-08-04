import { REVIEWER_UNAVAILABLE_REASON, SafetyClassifier } from "../classifier.ts";
import type {
  ClassifierInvoker,
  ClassifierInvocation,
  ClassifierOutcome,
  ResolvedClassifierReviewer,
} from "../classifier-provider.ts";
import type { ClassifierConfig, ClassifierReviewerConfig } from "../types.ts";
import { assert, test } from "./harness.ts";

function config(enabled = true): ClassifierConfig {
  return {
    enabled,
    reviewer: { provider: "openai", model: "luna", reasoning: "low" },
    timeoutMs: 2_000,
    maxRetries: 1,
  };
}

const allow: ClassifierOutcome = {
  kind: "decision",
  decision: { decision: "allow", severity: "safe", risks: [], reason: "Safe." },
};

class FakeInvoker implements ClassifierInvoker {
  readonly calls: string[] = [];
  unavailable = false;
  outcome: ClassifierOutcome = allow;

  async resolve(reviewer: ClassifierReviewerConfig): Promise<ResolvedClassifierReviewer | undefined> {
    this.calls.push(`resolve:${reviewer.provider}/${reviewer.model}`);
    if (this.unavailable) return undefined;
    return {
      config: reviewer,
      model: { provider: reviewer.provider, id: reviewer.model },
      runtime: { streamSimple: () => { throw new Error("not used"); } },
      auth: { ok: true },
    };
  }

  async invoke(_input: ClassifierInvocation): Promise<ClassifierOutcome> {
    this.calls.push("invoke");
    return this.outcome;
  }
}

test("classifier uses one configured reviewer and requires a safe allow", async () => {
  const invoker = new FakeInvoker();
  const classifier = new SafetyClassifier(config(), invoker);
  assert.equal((await classifier.evaluate("evidence")).allowed, true);
  assert.deepEqual(invoker.calls, ["resolve:openai/luna", "invoke"]);

  invoker.outcome = {
    kind: "decision",
    decision: { decision: "review", severity: "high", risks: ["external_mutation"], reason: "Risk." },
  };
  const reviewed = await classifier.evaluate("evidence");
  assert.equal(reviewed.allowed, false);
  assert.ok(!reviewed.allowed && reviewed.reason.includes("Risk."));
});

test("classifier availability checks the configured reviewer without inference", async () => {
  const invoker = new FakeInvoker();
  const classifier = new SafetyClassifier(config(), invoker);
  const status = await classifier.inspectAvailability();
  assert.equal(status.state, "ready");
  assert.equal(status.reviewer.available, true);
  assert.equal(invoker.calls.includes("invoke"), false);
});

test("unavailable and technical reviewer failures use the configuration guidance", async () => {
  const unavailable = new FakeInvoker();
  unavailable.unavailable = true;
  const classifier = new SafetyClassifier(config(), unavailable);
  assert.equal((await classifier.inspectAvailability()).state, "unavailable");
  assert.deepEqual(await classifier.evaluate("evidence"), { allowed: false, reason: REVIEWER_UNAVAILABLE_REASON });

  const technical = new FakeInvoker();
  technical.outcome = { kind: "technical", category: "provider-error" };
  assert.deepEqual(
    await new SafetyClassifier(config(), technical).evaluate("evidence"),
    { allowed: false, reason: REVIEWER_UNAVAILABLE_REASON },
  );
  assert.deepEqual(technical.calls, ["resolve:openai/luna", "invoke"]);
});

test("invalid output, timeout, and cancellation fail closed", async () => {
  for (const outcome of [
    { kind: "invalid", category: "invalid-output" } as const,
    { kind: "timeout" } as const,
    { kind: "cancelled" } as const,
  ]) {
    const invoker = new FakeInvoker();
    invoker.outcome = outcome;
    assert.equal((await new SafetyClassifier(config(), invoker).evaluate("evidence")).allowed, false);
    assert.deepEqual(invoker.calls, ["resolve:openai/luna", "invoke"]);
  }
});

test("explicit classifier disablement bypasses reviewer calls", async () => {
  const invoker = new FakeInvoker();
  const classifier = new SafetyClassifier(config(false), invoker);
  assert.equal((await classifier.inspectAvailability()).state, "disabled");
  assert.equal((await classifier.evaluate("evidence")).allowed, true);
  assert.deepEqual(invoker.calls, []);
});
