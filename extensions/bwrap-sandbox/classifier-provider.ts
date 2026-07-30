import { randomUUID } from "node:crypto";
import type { ClassifierReasoning, ClassifierStageConfig } from "./types.ts";
import {
  CLASSIFIER_POLICY,
  parseStage1Decision,
  parseStage2Decision,
  STAGE1_TOOL,
  STAGE2_TOOL,
  type Stage1Decision,
  type Stage2Decision,
} from "./safety-policy.ts";

interface ModelLike {
  readonly id: string;
  readonly provider: string;
  readonly baseUrl?: string;
  readonly [key: string]: unknown;
}

interface AssistantLike {
  readonly stopReason?: string;
  readonly content?: readonly unknown[];
}

interface ProviderLike {
  streamSimple(
    model: ModelLike,
    context: Record<string, unknown>,
    options: Record<string, unknown>,
  ): { result(): Promise<AssistantLike> };
}

interface RequestAuth {
  readonly ok: boolean;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly error?: string;
}

interface ProviderAuth {
  readonly auth?: { readonly baseUrl?: string };
}

export interface ClassifierModelRegistry {
  find(provider: string, model: string): ModelLike | undefined;
  getProvider(provider: string): ProviderLike | undefined;
  getApiKeyAndHeaders(model: ModelLike): Promise<RequestAuth>;
  getProviderAuth?(provider: string): Promise<ProviderAuth | undefined>;
}

export interface ResolvedClassifierStage {
  readonly provider: string;
  readonly config: ClassifierStageConfig;
  readonly model: ModelLike;
  readonly runtime: ProviderLike;
  readonly auth: RequestAuth;
  readonly baseUrl?: string;
}

export type StageOutcome<T extends Stage1Decision | Stage2Decision> =
  | { readonly kind: "decision"; readonly decision: T }
  | { readonly kind: "technical"; readonly category: string }
  | { readonly kind: "invalid"; readonly category: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" };

export interface StageInvocation {
  readonly stage: 1 | 2;
  readonly resolved: ResolvedClassifierStage;
  readonly evidence: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly signal?: AbortSignal;
}

export interface ClassifierStageInvoker {
  resolve(provider: string, config: ClassifierStageConfig): Promise<ResolvedClassifierStage | undefined>;
  invokeStage1(input: StageInvocation): Promise<StageOutcome<Stage1Decision>>;
  invokeStage2(input: StageInvocation): Promise<StageOutcome<Stage2Decision>>;
}

function reasoningOption(reasoning: ClassifierReasoning): string | undefined {
  return reasoning === "none" || reasoning === "off" ? undefined : reasoning;
}

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error("Classifier stage timed out"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function toolCallArguments(message: AssistantLike, expectedName: string): unknown | undefined {
  if (message.stopReason !== "toolUse" || !Array.isArray(message.content)) return undefined;
  const calls = message.content.filter((block): block is Record<string, unknown> => (
    !!block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall"
  ));
  const text = message.content.filter((block): block is Record<string, unknown> => (
    !!block && typeof block === "object" && (block as Record<string, unknown>).type === "text"
  ));
  if (text.some((block) => typeof block.text === "string" && block.text.trim())) return undefined;
  if (calls.length !== 1 || calls[0].name !== expectedName) return undefined;
  return calls[0].arguments;
}

async function invoke<T extends Stage1Decision | Stage2Decision>(
  input: StageInvocation,
  parse: (value: unknown) => T | undefined,
): Promise<StageOutcome<T>> {
  const timer = combinedSignal(input.signal, input.timeoutMs);
  try {
    if (input.signal?.aborted) return { kind: "cancelled" };
    const stage1 = input.stage === 1;
    const tool = stage1 ? STAGE1_TOOL : STAGE2_TOOL;
    const userText = stage1
      ? `High-recall gate. Allow only when the action is clearly safe. Otherwise, review it.\nEvidence:\n${input.evidence}`
      : `Assess the exact action. Report severity and risk categories. Give one concise reason.\nEvidence:\n${input.evidence}`;
    const requestModel = input.resolved.baseUrl
      ? { ...input.resolved.model, baseUrl: input.resolved.baseUrl }
      : input.resolved.model;
    const reasoning = reasoningOption(input.resolved.config.reasoning);
    const response = await input.resolved.runtime.streamSimple(
      requestModel,
      {
        systemPrompt: CLASSIFIER_POLICY,
        messages: [{ role: "user", content: userText, timestamp: Date.now() }],
        tools: [tool],
      },
      {
        ...(input.resolved.auth.apiKey ? { apiKey: input.resolved.auth.apiKey } : {}),
        ...(input.resolved.auth.headers ? { headers: input.resolved.auth.headers } : {}),
        ...(input.resolved.auth.env ? { env: input.resolved.auth.env } : {}),
        ...(reasoning ? { reasoning } : {}),
        maxTokens: stage1 ? 128 : 512,
        maxRetries: input.maxRetries,
        timeoutMs: input.timeoutMs,
        cacheRetention: "none",
        sessionId: randomUUID(),
        signal: timer.signal,
      },
    ).result();
    if (timer.timedOut()) return { kind: "timeout" };
    if (input.signal?.aborted || response.stopReason === "aborted") return { kind: "cancelled" };
    if (response.stopReason === "error") return { kind: "technical", category: "provider-error" };
    const value = toolCallArguments(response, tool.name);
    const decision = parse(value);
    return decision
      ? { kind: "decision", decision }
      : { kind: "invalid", category: response.stopReason === "length" ? "output-limit" : "invalid-output" };
  } catch {
    if (timer.timedOut()) return { kind: "timeout" };
    if (input.signal?.aborted) return { kind: "cancelled" };
    return { kind: "technical", category: "provider-error" };
  } finally {
    timer.dispose();
  }
}

export class PiClassifierStageInvoker implements ClassifierStageInvoker {
  constructor(private readonly registry: ClassifierModelRegistry) {}

  async resolve(provider: string, config: ClassifierStageConfig): Promise<ResolvedClassifierStage | undefined> {
    const model = this.registry.find(provider, config.model);
    const runtime = this.registry.getProvider(provider);
    if (!model || !runtime) return undefined;
    let auth: RequestAuth;
    let providerAuth: ProviderAuth | undefined;
    try {
      [auth, providerAuth] = await Promise.all([
        this.registry.getApiKeyAndHeaders(model),
        this.registry.getProviderAuth?.(provider),
      ]);
    } catch {
      return undefined;
    }
    if (!auth.ok) return undefined;
    return {
      provider,
      config,
      model,
      runtime,
      auth,
      baseUrl: providerAuth?.auth?.baseUrl ?? model.baseUrl,
    };
  }

  invokeStage1(input: StageInvocation): Promise<StageOutcome<Stage1Decision>> {
    return invoke(input, parseStage1Decision);
  }

  invokeStage2(input: StageInvocation): Promise<StageOutcome<Stage2Decision>> {
    return invoke(input, parseStage2Decision);
  }
}
