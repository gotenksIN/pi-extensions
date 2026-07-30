import { createHash } from "node:crypto";
import { EVIDENCE_LIMITS } from "./safety-policy.ts";

export interface SafetyAction {
  readonly tool: string;
  readonly input: unknown;
  readonly cwd: string;
}

export interface SafetyEvidence {
  readonly version: 2;
  readonly userMessages: readonly string[];
  readonly omittedUserMessageCount: number;
  readonly completedPriorActions: readonly SafetyAction[];
  readonly omittedPriorActionCount: number;
  readonly proposedAction: SafetyAction;
}

export interface EvidenceSource {
  readonly branch: readonly unknown[];
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly cwd: string;
  readonly omitPriorActions?: boolean;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value: string, limit: number): string {
  if (byteLength(value) <= limit) return value;
  const marker = "\n[older content omitted]\n";
  const budget = Math.max(0, limit - byteLength(marker));
  const headBudget = Math.floor(budget / 2);
  const tailBudget = budget - headBudget;
  const source = Buffer.from(value, "utf8");
  let head = source.subarray(0, headBudget).toString("utf8");
  let tail = source.subarray(source.length - tailBudget).toString("utf8");
  while (byteLength(head + marker + tail) > limit && tail.length > 0) tail = tail.slice(1);
  while (byteLength(head + marker + tail) > limit && head.length > 0) head = head.slice(0, -1);
  return head + marker + tail;
}

function stableValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Safety evidence contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new Error("Safety evidence contains a non-JSON value");
  if (seen.has(value)) throw new Error("Safety evidence contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = stableValue((value as Record<string, unknown>)[key], seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value, new Set()));
}

export function actionDigest(action: SafetyAction): string {
  return createHash("sha256").update(canonicalJson(action), "utf8").digest("hex");
}

function entryMessage(entry: unknown): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const item = entry as Record<string, unknown>;
  if (item.type !== "message" || !item.message || typeof item.message !== "object") return undefined;
  return item.message as Record<string, unknown>;
}

function userText(message: Record<string, unknown>): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const parts = message.content
    .filter((part): part is { type: "text"; text: string } => (
      !!part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
      && typeof (part as Record<string, unknown>).text === "string"
    ))
    .map((part) => part.text);
  return parts.length ? parts.join("\n") : undefined;
}

function toolCalls(message: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((part): part is Record<string, unknown> => (
    !!part && typeof part === "object" && (part as Record<string, unknown>).type === "toolCall"
  ));
}

function collectUserMessages(branch: readonly unknown[]): { messages: string[]; omitted: number } {
  const all = branch
    .map(entryMessage)
    .filter((message): message is Record<string, unknown> => !!message)
    .map(userText)
    .filter((text): text is string => typeof text === "string" && text.length > 0);
  const selected: string[] = [];
  let totalBytes = 0;
  for (let index = all.length - 1; index >= 0 && selected.length < EVIDENCE_LIMITS.userMessages; index -= 1) {
    const text = boundedText(all[index], EVIDENCE_LIMITS.userMessageBytes);
    const available = EVIDENCE_LIMITS.userMessagesBytes - totalBytes;
    if (available <= 0) break;
    const retained = boundedText(text, available);
    selected.unshift(retained);
    totalBytes += byteLength(retained);
  }
  return { messages: selected, omitted: all.length - selected.length };
}

function collectPriorActions(source: EvidenceSource): { actions: SafetyAction[]; omitted: number } {
  const all: SafetyAction[] = [];
  let total = 0;
  for (const entry of source.branch) {
    const message = entryMessage(entry);
    if (!message) continue;
    for (const call of toolCalls(message)) {
      if (call.id === source.toolCallId) continue;
      if (typeof call.name !== "string" || !call.name) continue;
      total += 1;
      const action: SafetyAction = { tool: call.name, input: call.arguments, cwd: source.cwd };
      const serialized = canonicalJson(action);
      if (byteLength(serialized) <= EVIDENCE_LIMITS.priorActionBytes) all.push(action);
    }
  }
  const actions = all.slice(-EVIDENCE_LIMITS.priorActions);
  return { actions, omitted: total - actions.length };
}

export function buildSafetyEvidence(source: EvidenceSource): { evidence: SafetyEvidence; serialized: string; digest: string } {
  if (!source.toolName.trim()) throw new Error("Safety evidence requires a tool name");
  const action: SafetyAction = { tool: source.toolName, input: source.input, cwd: source.cwd };
  const actionJson = canonicalJson(action);
  if (byteLength(actionJson) > EVIDENCE_LIMITS.currentActionBytes) {
    throw new Error("The proposed action is too large for complete safety review");
  }
  const users = collectUserMessages(source.branch);
  const prior = source.omitPriorActions
    ? { actions: [], omitted: source.branch.reduce((count, entry) => {
      const message = entryMessage(entry);
      return count + (message ? toolCalls(message).filter((call) => call.id !== source.toolCallId).length : 0);
    }, 0) }
    : collectPriorActions(source);
  const evidence: SafetyEvidence = {
    version: 2,
    userMessages: users.messages,
    omittedUserMessageCount: users.omitted,
    completedPriorActions: prior.actions,
    omittedPriorActionCount: prior.omitted,
    proposedAction: action,
  };
  const serialized = canonicalJson(evidence);
  if (byteLength(serialized) > EVIDENCE_LIMITS.totalBytes) {
    throw new Error("The safety evidence is too large for review");
  }
  return { evidence, serialized, digest: actionDigest(action) };
}
