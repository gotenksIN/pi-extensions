import { SafetyClassifier, type ClassifierStatus } from "./classifier.ts";
import { PiClassifierStageInvoker, type ClassifierModelRegistry } from "./classifier-provider.ts";
import { buildSafetyEvidence, actionDigest, type SafetyAction } from "./safety-evidence.ts";
import type { ClassifierConfig } from "./types.ts";

const CLASSIFIED_TOOLS = new Set(["bash", "read", "grep", "write", "edit"]);

export function requiresSafetyClassification(toolName: string): boolean {
  return CLASSIFIED_TOOLS.has(toolName);
}

interface ExecutionPermit {
  readonly toolName: string;
  readonly cwd: string;
  readonly digest: string;
  readonly generation: number;
}

export interface SafetyAuthorizationRequest {
  readonly branch: readonly unknown[];
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly classifierInput?: unknown;
  readonly classifierCwd?: string;
  readonly omitPriorActions?: boolean;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface SafetyAuthorizationResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export class SafetyGate {
  private readonly classifier: SafetyClassifier;
  private readonly permits = new Map<string, ExecutionPermit>();
  private generation = 0;

  constructor(config: ClassifierConfig, registry: ClassifierModelRegistry) {
    this.classifier = new SafetyClassifier(config, new PiClassifierStageInvoker(registry));
  }

  async start(): Promise<ClassifierStatus> {
    this.generation += 1;
    this.permits.clear();
    return this.classifier.inspectAvailability();
  }

  stop(): void {
    this.generation += 1;
    this.permits.clear();
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

  async authorize(request: SafetyAuthorizationRequest): Promise<SafetyAuthorizationResult> {
    if (!requiresSafetyClassification(request.toolName)) return { allowed: true };
    if (!this.classifier.status().enabled) {
      try {
        this.addPermit(request.toolCallId, request.toolName, request.input, request.cwd);
      } catch {
        return { allowed: false, reason: "The final tool input cannot be serialized safely" };
      }
      return { allowed: true };
    }
    let built: ReturnType<typeof buildSafetyEvidence>;
    try {
      built = buildSafetyEvidence({
        branch: request.branch,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        input: request.classifierInput ?? request.input,
        cwd: request.classifierCwd ?? request.cwd,
        omitPriorActions: request.omitPriorActions,
      });
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : "Safety evidence is invalid",
      };
    }
    const result = await this.classifier.evaluate(built.serialized, request.signal);
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
