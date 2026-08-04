import { REVIEWER_UNAVAILABLE_REASON, SafetyClassifier, type ClassifierStatus } from "./classifier.ts";
import { PiClassifierInvoker, type ClassifierModelRegistry } from "./classifier-provider.ts";
import { buildSafetyEvidence, actionDigest, type SafetyAction } from "./safety-evidence.ts";
import type { ClassifierConfig } from "./types.ts";

const CLASSIFIED_TOOLS = new Set(["bash"]);

export function requiresSafetyClassification(toolName: string): boolean {
  return CLASSIFIED_TOOLS.has(toolName);
}

interface ExecutionPermit {
  readonly toolName: string;
  readonly cwd: string;
  readonly digest: string;
  readonly generation: number;
}

interface BashRetryRecord {
  readonly cwd: string;
  readonly digest: string;
  readonly command: string;
  readonly generation: number;
}

export interface PendingBashRetry {
  readonly digest: string;
  readonly command: string;
}

export interface SafetyAuthorizationRequest {
  readonly branch: readonly unknown[];
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly evidenceInput?: unknown;
  readonly omitPriorActions?: boolean;
  readonly requireClassifierReady?: boolean;
}

export interface SafetyAuthorizationResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export class SafetyGate {
  private readonly classifier: SafetyClassifier;
  private readonly permits = new Map<string, ExecutionPermit>();
  private pendingBashRetry: BashRetryRecord | undefined;
  private futureBashTicket: BashRetryRecord | undefined;
  private generation = 0;

  constructor(
    config: ClassifierConfig,
    registry: ClassifierModelRegistry,
    private readonly activeSandboxDirectory?: string,
  ) {
    this.classifier = new SafetyClassifier(config, new PiClassifierInvoker(registry));
  }

  async start(): Promise<ClassifierStatus> {
    this.generation += 1;
    this.permits.clear();
    this.pendingBashRetry = undefined;
    this.futureBashTicket = undefined;
    return this.classifier.inspectAvailability();
  }

  stop(): void {
    this.generation += 1;
    this.permits.clear();
    this.pendingBashRetry = undefined;
    this.futureBashTicket = undefined;
  }

  status(): ClassifierStatus {
    return this.classifier.status();
  }

  private addPermit(toolCallId: string, toolName: string, input: unknown, cwd: string): void {
    const action: SafetyAction = { tool: toolName, input, cwd };
    this.permits.set(toolCallId, {
      toolName,
      cwd,
      digest: actionDigest(action),
      generation: this.generation,
    });
  }

  claimFutureBashTicket(toolCallId: string, input: unknown, cwd: string): boolean {
    const ticket = this.futureBashTicket;
    this.futureBashTicket = undefined;
    if (!ticket) return false;
    let digest: string;
    try {
      digest = actionDigest({ tool: "bash", input, cwd });
    } catch {
      return false;
    }
    if (ticket.generation !== this.generation || ticket.cwd !== cwd || ticket.digest !== digest) return false;
    this.addPermit(toolCallId, "bash", input, cwd);
    return true;
  }

  recordBashResult(input: unknown, cwd: string, exitCode: number | null): void {
    this.pendingBashRetry = undefined;
    if (exitCode === 0 || exitCode === null) return;
    const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
    if (typeof data.command !== "string" || Buffer.byteLength(data.command, "utf8") > 32 * 1024) return;
    try {
      this.pendingBashRetry = {
        cwd,
        digest: actionDigest({ tool: "bash", input, cwd }),
        command: data.command,
        generation: this.generation,
      };
    } catch {
      // Inputs that cannot bind an execution permit cannot create retry state.
    }
  }

  getPendingBashRetry(): PendingBashRetry | undefined {
    const retry = this.pendingBashRetry;
    if (!retry || retry.generation !== this.generation) return undefined;
    return { digest: retry.digest, command: retry.command };
  }

  approvePendingBashRetry(digest: string): boolean {
    const retry = this.pendingBashRetry;
    this.pendingBashRetry = undefined;
    if (!retry || retry.generation !== this.generation || retry.digest !== digest) return false;
    this.futureBashTicket = retry;
    return true;
  }

  createFutureBashTicket(input: unknown, cwd: string): void {
    const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
    if (typeof data.command !== "string" || Buffer.byteLength(data.command, "utf8") > 32 * 1024) {
      throw new Error("The proactive Bash input is too large for an exact future approval");
    }
    this.futureBashTicket = {
      cwd,
      digest: actionDigest({ tool: "bash", input, cwd }),
      command: data.command,
      generation: this.generation,
    };
  }

  discardPendingBashRetry(digest: string): void {
    if (this.pendingBashRetry?.digest === digest) this.pendingBashRetry = undefined;
  }

  async classify(request: SafetyAuthorizationRequest): Promise<SafetyAuthorizationResult> {
    if (!requiresSafetyClassification(request.toolName)) return { allowed: true };
    const status = this.classifier.status();
    if (request.requireClassifierReady && status.state !== "ready") {
      return {
        allowed: false,
        reason: status.state === "disabled"
          ? "Safety classification is disabled"
          : REVIEWER_UNAVAILABLE_REASON,
      };
    }
    if (!status.enabled) return { allowed: true };
    let built: ReturnType<typeof buildSafetyEvidence>;
    try {
      built = buildSafetyEvidence({
        branch: request.branch,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        input: request.evidenceInput ?? request.input,
        cwd: request.cwd,
        activeSandboxDirectory: this.activeSandboxDirectory,
        omitPriorActions: request.omitPriorActions,
      });
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : "Safety evidence is invalid",
      };
    }
    return this.classifier.evaluate(built.serialized, request.signal);
  }

  async authorize(request: SafetyAuthorizationRequest): Promise<SafetyAuthorizationResult> {
    if (!requiresSafetyClassification(request.toolName)) return { allowed: true };
    const result = await this.classify(request);
    if (!result.allowed) return result;
    try {
      this.addPermit(request.toolCallId, request.toolName, request.input, request.cwd);
    } catch {
      return { allowed: false, reason: "The final tool input cannot be serialized safely" };
    }
    return { allowed: true };
  }

  approveOnce(toolCallId: string, toolName: string, input: unknown, cwd: string): void {
    const action: SafetyAction = { tool: toolName, input, cwd };
    let digest: string;
    try {
      digest = actionDigest(action);
    } catch {
      throw new Error(`The ${toolName} input cannot be serialized for single-use approval`);
    }
    this.permits.set(toolCallId, {
      toolName,
      cwd,
      digest,
      generation: this.generation,
    });
  }

  approveBashOnce(toolCallId: string, input: unknown, cwd: string): void {
    this.approveOnce(toolCallId, "bash", input, cwd);
  }

  consumePermit(toolCallId: string, toolName: string, input: unknown, cwd: string): void {
    const permit = this.permits.get(toolCallId);
    this.permits.delete(toolCallId);
    if (!permit) throw new Error(`Safety approval is missing for ${toolName}`);
    const action: SafetyAction = { tool: toolName, input, cwd };
    let digest: string;
    try {
      digest = actionDigest(action);
    } catch {
      throw new Error(`Safety approval does not match the final ${toolName} input`);
    }
    if (
      permit.generation !== this.generation
      || permit.toolName !== toolName
      || permit.cwd !== cwd
      || permit.digest !== digest
    ) {
      throw new Error(`Safety approval does not match the final ${toolName} input`);
    }
  }
}
