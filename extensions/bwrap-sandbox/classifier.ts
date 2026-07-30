import type { ClassifierConfig, ClassifierPairConfig } from "./types.ts";
import type {
  ClassifierStageInvoker,
  ResolvedClassifierStage,
  StageInvocation,
  StageOutcome,
} from "./classifier-provider.ts";

export interface ClassifierPairStatus {
  readonly label: string;
  readonly available: boolean;
}

export interface ClassifierStatus {
  readonly enabled: boolean;
  readonly state: "disabled" | "ready" | "unavailable";
  readonly pairs: readonly ClassifierPairStatus[];
  readonly lastOutcome?: string;
}

export type ClassifierEvaluation =
  | { readonly allowed: true; readonly pair: string }
  | { readonly allowed: false; readonly reason: string };

function pairLabel(pair: ClassifierPairConfig): string {
  return `${pair.provider}/${pair.stage1.model} → ${pair.provider}/${pair.stage2.model}`;
}

function blockedOutcome(stage: 1 | 2, outcome: Exclude<StageOutcome<any>, { kind: "technical" }>): string {
  if (outcome.kind === "decision") return `stage-${stage}-${outcome.decision.decision}`;
  if (outcome.kind === "invalid") return `stage-${stage}-${outcome.category}`;
  return `stage-${stage}-${outcome.kind}`;
}

function reviewReason(stage: 1 | 2, outcome: Exclude<StageOutcome<any>, { kind: "technical" }>): string {
  const normalized = blockedOutcome(stage, outcome);
  const reason = outcome.kind === "decision" ? outcome.decision.reason : undefined;
  return `Safety classification blocked the action at Stage ${stage} (${normalized})${reason ? `: ${reason}` : ""}`;
}

export class SafetyClassifier {
  private pairStatus: ClassifierPairStatus[] = [];
  private lastOutcome: string | undefined;

  constructor(
    private readonly config: ClassifierConfig,
    private readonly invoker: ClassifierStageInvoker,
  ) {}

  private async resolvePair(pair: ClassifierPairConfig): Promise<{
    stage1: ResolvedClassifierStage;
    stage2: ResolvedClassifierStage;
  } | undefined> {
    const [stage1, stage2] = await Promise.all([
      this.invoker.resolve(pair.provider, pair.stage1),
      this.invoker.resolve(pair.provider, pair.stage2),
    ]);
    return stage1 && stage2 ? { stage1, stage2 } : undefined;
  }

  async inspectAvailability(): Promise<ClassifierStatus> {
    if (!this.config.enabled) {
      this.pairStatus = this.config.pairs.map((pair) => ({ label: pairLabel(pair), available: false }));
      return this.status();
    }
    this.pairStatus = await Promise.all(this.config.pairs.map(async (pair) => ({
      label: pairLabel(pair),
      available: !!(await this.resolvePair(pair)),
    })));
    return this.status();
  }

  status(): ClassifierStatus {
    const state = !this.config.enabled
      ? "disabled"
      : this.pairStatus.some((pair) => pair.available)
        ? "ready"
        : "unavailable";
    return {
      enabled: this.config.enabled,
      state,
      pairs: this.pairStatus,
      ...(this.lastOutcome ? { lastOutcome: this.lastOutcome } : {}),
    };
  }

  async evaluate(evidence: string, signal?: AbortSignal): Promise<ClassifierEvaluation> {
    if (!this.config.enabled) return { allowed: true, pair: "classifier disabled" };
    let technicalFailure = false;
    for (const [pairIndex, pair] of this.config.pairs.entries()) {
      if (signal?.aborted) {
        this.lastOutcome = "cancelled";
        return { allowed: false, reason: "Safety classification was cancelled" };
      }
      const resolved = await this.resolvePair(pair);
      const label = pairLabel(pair);
      this.pairStatus[pairIndex] = { label, available: !!resolved };
      if (!resolved) {
        technicalFailure = true;
        continue;
      }
      const base = {
        evidence,
        maxRetries: this.config.maxRetries,
        signal,
      };
      const stage1Input: StageInvocation = {
        ...base,
        stage: 1,
        resolved: resolved.stage1,
        timeoutMs: this.config.stage1TimeoutMs,
      };
      const stage1 = await this.invoker.invokeStage1(stage1Input);
      if (stage1.kind === "technical") {
        technicalFailure = true;
        continue;
      }
      if (stage1.kind !== "decision" || stage1.decision.decision !== "allow") {
        this.lastOutcome = `${label}: ${blockedOutcome(1, stage1)}`;
        return { allowed: false, reason: reviewReason(1, stage1) };
      }

      const stage2Input: StageInvocation = {
        ...base,
        stage: 2,
        resolved: resolved.stage2,
        timeoutMs: this.config.stage2TimeoutMs,
      };
      const stage2 = await this.invoker.invokeStage2(stage2Input);
      if (stage2.kind === "technical") {
        technicalFailure = true;
        continue;
      }
      if (stage2.kind !== "decision" || stage2.decision.decision !== "allow") {
        this.lastOutcome = `${label}: ${blockedOutcome(2, stage2)}`;
        return { allowed: false, reason: reviewReason(2, stage2) };
      }

      this.lastOutcome = `${label}: allow`;
      return { allowed: true, pair: label };
    }
    this.lastOutcome = technicalFailure ? "all configured pairs unavailable" : "no configured pair";
    return {
      allowed: false,
      reason: "No complete classifier pair is available through Pi. Configure both classifier stages in the global sandbox configuration.",
    };
  }
}
