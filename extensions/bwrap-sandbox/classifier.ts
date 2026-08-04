import type { ClassifierConfig, ClassifierReviewerConfig } from "./types.ts";
import type { ClassifierInvoker, ClassifierOutcome } from "./classifier-provider.ts";

export const REVIEWER_UNAVAILABLE_REASON = "The automatic reviewer is unavailable. Configure classifier.reviewer in the global sandbox configuration.";

export interface ClassifierReviewerStatus {
  readonly label: string;
  readonly available: boolean;
}

export interface ClassifierStatus {
  readonly enabled: boolean;
  readonly state: "disabled" | "ready" | "unavailable";
  readonly reviewer: ClassifierReviewerStatus;
  readonly lastOutcome?: string;
}

export type ClassifierEvaluation =
  | { readonly allowed: true; readonly reviewer: string }
  | { readonly allowed: false; readonly reason: string };

function reviewerLabel(reviewer: ClassifierReviewerConfig): string {
  return `${reviewer.provider}/${reviewer.model} (${reviewer.reasoning})`;
}

function outcomeLabel(outcome: ClassifierOutcome): string {
  if (outcome.kind === "decision") return outcome.decision.decision;
  if (outcome.kind === "invalid") return outcome.category;
  return outcome.kind;
}

function reviewReason(outcome: Exclude<ClassifierOutcome, { kind: "technical" }>): string {
  if (outcome.kind === "decision") return `The automatic reviewer requires human review: ${outcome.decision.reason}`;
  if (outcome.kind === "invalid") return `The automatic reviewer returned invalid structured output (${outcome.category})`;
  if (outcome.kind === "timeout") return "The automatic reviewer timed out";
  return "The automatic review was cancelled";
}

export class SafetyClassifier {
  private reviewerStatus: ClassifierReviewerStatus;
  private lastOutcome: string | undefined;

  constructor(
    private readonly config: ClassifierConfig,
    private readonly invoker: ClassifierInvoker,
  ) {
    this.reviewerStatus = { label: reviewerLabel(config.reviewer), available: false };
  }

  async inspectAvailability(): Promise<ClassifierStatus> {
    if (!this.config.enabled) {
      this.reviewerStatus = { label: reviewerLabel(this.config.reviewer), available: false };
      return this.status();
    }
    this.reviewerStatus = {
      label: reviewerLabel(this.config.reviewer),
      available: !!(await this.invoker.resolve(this.config.reviewer)),
    };
    return this.status();
  }

  status(): ClassifierStatus {
    const state = !this.config.enabled
      ? "disabled"
      : this.reviewerStatus.available
        ? "ready"
        : "unavailable";
    return {
      enabled: this.config.enabled,
      state,
      reviewer: this.reviewerStatus,
      ...(this.lastOutcome ? { lastOutcome: this.lastOutcome } : {}),
    };
  }

  async evaluate(evidence: string, signal?: AbortSignal): Promise<ClassifierEvaluation> {
    if (!this.config.enabled) return { allowed: true, reviewer: "classifier disabled" };
    if (signal?.aborted) {
      this.lastOutcome = "cancelled";
      return { allowed: false, reason: "The automatic review was cancelled" };
    }

    const resolved = await this.invoker.resolve(this.config.reviewer);
    this.reviewerStatus = { label: reviewerLabel(this.config.reviewer), available: !!resolved };
    if (!resolved) {
      this.lastOutcome = "unavailable";
      return { allowed: false, reason: REVIEWER_UNAVAILABLE_REASON };
    }

    const outcome = await this.invoker.invoke({
      resolved,
      evidence,
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      signal,
    });
    if (outcome.kind === "technical") {
      this.reviewerStatus = { ...this.reviewerStatus, available: false };
      this.lastOutcome = "unavailable";
      return { allowed: false, reason: REVIEWER_UNAVAILABLE_REASON };
    }
    if (
      outcome.kind === "decision"
      && outcome.decision.decision === "allow"
      && outcome.decision.severity === "safe"
      && outcome.decision.risks.length === 0
    ) {
      this.lastOutcome = "allow";
      return { allowed: true, reviewer: this.reviewerStatus.label };
    }

    this.lastOutcome = outcomeLabel(outcome);
    return { allowed: false, reason: reviewReason(outcome) };
  }
}
