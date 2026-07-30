import { SafetyClassifier, type ClassifierStatus } from "./classifier.ts";
import { PiClassifierStageInvoker, type ClassifierModelRegistry } from "./classifier-provider.ts";
import { buildSafetyEvidence, actionDigest, type SafetyAction } from "./safety-evidence.ts";
import type { ClassifierConfig } from "./types.ts";

const PERMITTED_TOOL = "bash";

export function requiresSafetyClassification(toolName: string): boolean {
  return toolName === PERMITTED_TOOL;
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

  async authorize(request: SafetyAuthorizationRequest): Promise<SafetyAuthorizationResult> {
    if (!requiresSafetyClassification(request.toolName)) return { allowed: true };
    if (!this.classifier.status().enabled) {
      if (request.toolName === PERMITTED_TOOL) {
        const action: SafetyAction = { tool: request.toolName, input: request.input, cwd: request.cwd };
        try {
          this.permits.set(request.toolCallId, {
            toolName: request.toolName,
            cwd: request.cwd,
            digest: actionDigest(action),
            generation: this.generation,
          });
        } catch {
          return { allowed: false, reason: "The final tool input cannot be serialized safely" };
        }
      }
      return { allowed: true };
    }
    let built: ReturnType<typeof buildSafetyEvidence>;
    try {
      built = buildSafetyEvidence({
        branch: request.branch,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        input: request.input,
        cwd: request.cwd,
      });
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : "Safety evidence is invalid",
      };
    }
    const result = await this.classifier.evaluate(built.serialized, request.signal);
    if (!result.allowed) return result;
    if (request.toolName === PERMITTED_TOOL) {
      this.permits.set(request.toolCallId, {
        toolName: request.toolName,
        cwd: request.cwd,
        digest: built.digest,
        generation: this.generation,
      });
    }
    return { allowed: true };
  }

  approveBashOnce(toolCallId: string, input: unknown, cwd: string): void {
    const action: SafetyAction = { tool: PERMITTED_TOOL, input, cwd };
    let digest: string;
    try {
      digest = actionDigest(action);
    } catch {
      throw new Error("The Bash input cannot be serialized for single-use approval");
    }
    this.permits.set(toolCallId, {
      toolName: PERMITTED_TOOL,
      cwd,
      digest,
      generation: this.generation,
    });
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
