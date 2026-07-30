import { SafetyClassifier } from "../classifier.ts";
import type {
  ClassifierStageInvoker,
  ResolvedClassifierStage,
  StageInvocation,
  StageOutcome,
} from "../classifier-provider.ts";
import type { Stage1Decision, Stage2Decision } from "../safety-policy.ts";
import type { ClassifierConfig, ClassifierPairConfig, ClassifierStageConfig } from "../types.ts";
import { assert, test } from "./harness.ts";

const google: ClassifierPairConfig = {
  provider: "google",
  stage1: { model: "fast", reasoning: "minimal" },
  stage2: { model: "strong", reasoning: "low" },
};
const openai: ClassifierPairConfig = {
  provider: "openai",
  stage1: { model: "nano", reasoning: "none" },
  stage2: { model: "mini", reasoning: "low" },
};

function config(pairs = [google, openai]): ClassifierConfig {
  return { enabled: true, pairs, stage1TimeoutMs: 2_000, stage2TimeoutMs: 3_000, maxRetries: 1 };
}

const allow1: StageOutcome<Stage1Decision> = {
  kind: "decision", decision: { decision: "allow", reason: "Routine local action." },
};
const review1: StageOutcome<Stage1Decision> = {
  kind: "decision", decision: { decision: "review", reason: "External mutation risk." },
};
const allow2: StageOutcome<Stage2Decision> = {
  kind: "decision", decision: { decision: "allow", severity: "safe", risks: [], reason: "Safe." },
};
const review2: StageOutcome<Stage2Decision> = {
  kind: "decision", decision: { decision: "review", severity: "high", risks: ["external_mutation"], reason: "Risk." },
};

class FakeInvoker implements ClassifierStageInvoker {
  readonly calls: string[] = [];
  readonly unavailable = new Set<string>();
  readonly stage1 = new Map<string, StageOutcome<Stage1Decision>>();
  readonly stage2 = new Map<string, StageOutcome<Stage2Decision>>();

  async resolve(provider: string, stage: ClassifierStageConfig): Promise<ResolvedClassifierStage | undefined> {
    this.calls.push(`resolve:${provider}/${stage.model}`);
    if (this.unavailable.has(`${provider}/${stage.model}`)) return undefined;
    return {
      provider,
      config: stage,
      model: { provider, id: stage.model },
      runtime: { streamSimple: () => { throw new Error("not used"); } },
      auth: { ok: true },
    };
  }

  async invokeStage1(input: StageInvocation): Promise<StageOutcome<Stage1Decision>> {
    const key = `${input.resolved.provider}/${input.resolved.config.model}`;
    this.calls.push(`stage1:${key}`);
    return this.stage1.get(key) ?? allow1;
  }

  async invokeStage2(input: StageInvocation): Promise<StageOutcome<Stage2Decision>> {
    const key = `${input.resolved.provider}/${input.resolved.config.model}`;
    this.calls.push(`stage2:${key}`);
    return this.stage2.get(key) ?? allow2;
  }
}

test("classifier requires two valid allows from the preferred pair", async () => {
  const invoker = new FakeInvoker();
  const classifier = new SafetyClassifier(config(), invoker);
  const result = await classifier.evaluate("evidence");
  assert.equal(result.allowed, true);
  assert.deepEqual(invoker.calls.filter((call) => call.startsWith("stage")), [
    "stage1:google/fast", "stage2:google/strong",
  ]);
});

test("an unavailable Google pair selects the complete OpenAI pair", async () => {
  const invoker = new FakeInvoker();
  invoker.unavailable.add("google/strong");
  const result = await new SafetyClassifier(config(), invoker).evaluate("evidence");
  assert.equal(result.allowed, true);
  assert.deepEqual(invoker.calls.filter((call) => call.startsWith("stage")), [
    "stage1:openai/nano", "stage2:openai/mini",
  ]);
});

test("a technical Stage 2 failure restarts fallback at Stage 1", async () => {
  const invoker = new FakeInvoker();
  invoker.stage2.set("google/strong", { kind: "technical", category: "provider-error" });
  const result = await new SafetyClassifier(config(), invoker).evaluate("evidence");
  assert.equal(result.allowed, true);
  assert.deepEqual(invoker.calls.filter((call) => call.startsWith("stage")), [
    "stage1:google/fast", "stage2:google/strong", "stage1:openai/nano", "stage2:openai/mini",
  ]);
});

test("a valid review never invokes a fallback pair", async () => {
  const invoker = new FakeInvoker();
  invoker.stage1.set("google/fast", review1);
  const result = await new SafetyClassifier(config(), invoker).evaluate("evidence");
  assert.equal(result.allowed, false);
  assert.ok(!result.allowed && result.reason.includes("External mutation risk."));
  assert.deepEqual(invoker.calls.filter((call) => call.startsWith("stage")), ["stage1:google/fast"]);
});

test("Stage 1 invalid output, timeout, and cancellation do not use fallback", async () => {
  for (const outcome of [
    { kind: "invalid", category: "invalid-output" } as const,
    { kind: "timeout" } as const,
    { kind: "cancelled" } as const,
  ]) {
    const invoker = new FakeInvoker();
    invoker.stage1.set("google/fast", outcome);
    const result = await new SafetyClassifier(config(), invoker).evaluate("evidence");
    assert.equal(result.allowed, false);
    assert.deepEqual(invoker.calls.filter((call) => call.startsWith("stage")), ["stage1:google/fast"]);
  }
});

test("Stage 2 review and invalid output fail closed without fallback", async () => {
  for (const outcome of [review2, { kind: "invalid", category: "invalid-output" } as const]) {
    const invoker = new FakeInvoker();
    invoker.stage2.set("google/strong", outcome);
    const result = await new SafetyClassifier(config(), invoker).evaluate("evidence");
    assert.equal(result.allowed, false);
    if (outcome.kind === "decision") assert.ok(!result.allowed && result.reason.includes("Risk."));
    assert.deepEqual(invoker.calls.filter((call) => call.startsWith("stage")), [
      "stage1:google/fast", "stage2:google/strong",
    ]);
  }
});

test("classifier availability reports complete pairs without inference", async () => {
  const invoker = new FakeInvoker();
  invoker.unavailable.add("google/fast");
  const classifier = new SafetyClassifier(config(), invoker);
  const status = await classifier.inspectAvailability();
  assert.equal(status.state, "ready");
  assert.deepEqual(status.pairs.map((pair) => pair.available), [false, true]);
  assert.equal(invoker.calls.some((call) => call.startsWith("stage")), false);
});

test("classifier fails closed when no complete pair is available", async () => {
  const invoker = new FakeInvoker();
  invoker.unavailable.add("google/fast");
  invoker.unavailable.add("openai/nano");
  const classifier = new SafetyClassifier(config(), invoker);
  const status = await classifier.inspectAvailability();
  const result = await classifier.evaluate("evidence");
  assert.equal(status.state, "unavailable");
  assert.equal(result.allowed, false);
});

test("explicit classifier disablement bypasses model calls", async () => {
  const invoker = new FakeInvoker();
  const classifier = new SafetyClassifier({ ...config(), enabled: false }, invoker);
  assert.equal((await classifier.inspectAvailability()).state, "disabled");
  assert.equal((await classifier.evaluate("evidence")).allowed, true);
  assert.deepEqual(invoker.calls, []);
});
