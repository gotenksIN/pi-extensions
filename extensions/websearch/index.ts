/**
 * Web Search with Citations Extension for Pi
 *
 * Registers a `websearch_cited` tool that performs LLM-grounded web search
 * with inline citations and a Sources list of URLs.
 *
 * Backends supported: Google Gemini, OpenAI
 *
 * Config: .pi/websearch.json (project-local) or ~/.pi/agent/extensions/websearch.json (global)
 * Inherits auth/base URLs/headers from Pi's configured providers — no separate env vars needed.
 *
 * Default fallback order:
 *   google/gemini-3.6-flash -> openai/gpt-5.5
 *
 * Example config:
 * {
 *   "models": [
 *     { "provider": "google", "model": "gemini-3.6-flash" },
 *     { "provider": "openai", "model": "gpt-5.5" }
 *   ]
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

type WebsearchProvider = "google" | "openai";

interface WebsearchModelConfig {
  provider: WebsearchProvider;
  model: string;
}

interface WebsearchConfig {
  /** Legacy single-backend config. Used when `models` is omitted. */
  provider?: WebsearchProvider;
  model?: string;
  /** Ordered fallback list. First successful backend wins. */
  models?: WebsearchModelConfig[];
  /** OpenAI-specific request-shaping options only. Auth and base URL come from Pi's model registry. */
  openai?: {
    reasoningEffort?: string;
    reasoningSummary?: string;
    textVerbosity?: string;
  };
}

interface ModelAuth {
  apiKey?: string;
  headers: Record<string, string>;
  env: Record<string, string>;
  baseUrl?: string;
}

interface ResolvedModelAuth {
  id: string;
  provider: string;
  auth: ModelAuth;
}

type ToolContext = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

const DEFAULT_MODELS: WebsearchModelConfig[] = [
  { provider: "google", model: "gemini-3.6-flash" },
  { provider: "openai", model: "gpt-5.5" },
];

const DEFAULT_CONFIG: WebsearchConfig = {
  provider: DEFAULT_MODELS[0].provider,
  model: DEFAULT_MODELS[0].model,
};

// ─── Config loading ──────────────────────────────────────────────────────────

function loadConfig(cwd: string): WebsearchConfig {
  const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "websearch.json");
  const globalConfigPath = join(getAgentDir(), "extensions", "websearch.json");

  let config: WebsearchConfig = { ...DEFAULT_CONFIG } as WebsearchConfig;

  for (const configPath of [globalConfigPath, projectConfigPath]) {
    if (existsSync(configPath)) {
      try {
        const data = JSON.parse(readFileSync(configPath, "utf-8"));
        config = { ...config, ...data };
        if (data.openai) config.openai = { ...config.openai, ...data.openai };
      } catch (e) {
        // ignore parse errors
      }
    }
  }

  return config;
}

function isWebsearchProvider(value: unknown): value is WebsearchProvider {
  return value === "google" || value === "openai";
}

function parseModelEntry(value: unknown): WebsearchModelConfig | undefined {
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    if (slash <= 0) return undefined;
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1).trim();
    return isWebsearchProvider(provider) && model ? { provider, model } : undefined;
  }

  if (!value || typeof value !== "object") return undefined;
  const record = value as { provider?: unknown; model?: unknown };
  if (!isWebsearchProvider(record.provider) || typeof record.model !== "string" || !record.model.trim()) {
    return undefined;
  }
  return { provider: record.provider, model: record.model.trim() };
}

function inferProviderForModel(model: string): WebsearchProvider | undefined {
  const lower = model.toLowerCase();
  if (lower.startsWith("gemini-")) return "google";
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) return "openai";
  return undefined;
}

function defaultModelForProvider(provider: WebsearchProvider): string {
  return DEFAULT_MODELS.find((entry) => entry.provider === provider)?.model ?? DEFAULT_MODELS[0].model;
}

function uniqueModels(models: WebsearchModelConfig[]): WebsearchModelConfig[] {
  const seen = new Set<string>();
  const result: WebsearchModelConfig[] = [];
  for (const entry of models) {
    const key = `${entry.provider}/${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function configuredModels(config: WebsearchConfig): WebsearchModelConfig[] {
  const explicitModels = Array.isArray(config.models)
    ? (config.models as unknown[]).map(parseModelEntry).filter((entry): entry is WebsearchModelConfig => !!entry)
    : [];
  if (explicitModels.length > 0) return uniqueModels(explicitModels);

  const legacy = isWebsearchProvider(config.provider) && typeof config.model === "string" && config.model.trim()
    ? [{ provider: config.provider, model: config.model.trim() }]
    : [];
  return uniqueModels([...legacy, ...DEFAULT_MODELS]);
}

function requestedModel(params: { provider?: unknown; model?: unknown }, config: WebsearchConfig): WebsearchModelConfig | undefined {
  const configured = configuredModels(config);
  const provider = isWebsearchProvider(params.provider) ? params.provider : undefined;
  const model = typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined;

  if (provider && model) return { provider, model };
  if (model) return { provider: provider ?? inferProviderForModel(model) ?? configured[0].provider, model };
  if (provider) return configured.find((entry) => entry.provider === provider) ?? { provider, model: defaultModelForProvider(provider) };
  return undefined;
}

function searchPlan(params: { provider?: unknown; model?: unknown }, config: WebsearchConfig): WebsearchModelConfig[] {
  const configured = configuredModels(config);
  const requested = requestedModel(params, config);
  return uniqueModels(requested ? [requested, ...configured] : configured);
}

function modelLabel(model: WebsearchModelConfig): string {
  return `${model.provider}/${model.model}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

async function resolveModelAuth(
  provider: string,
  modelId: string,
  ctx: ToolContext,
): Promise<ResolvedModelAuth> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Model not found in Pi: ${provider}/${modelId}. Add it via /model or models.json.`);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok) {
    throw new Error(auth?.error || `Auth failed for ${provider}/${modelId}.`);
  }

  const headers = normalizeHeaders(auth.headers);
  const apiKey = typeof auth.apiKey === "string" && auth.apiKey.trim() ? auth.apiKey.trim() : undefined;
  if (!apiKey && !hasHeader(headers, "authorization") && !hasHeader(headers, "x-goog-api-key")) {
    throw new Error(`No auth for ${provider}/${modelId}. Authenticate via /login or configure the provider in models.json.`);
  }

  return {
    id: model.id,
    provider: model.provider,
    auth: {
      apiKey,
      headers,
      env: normalizeEnv(auth.env),
      baseUrl: typeof model.baseUrl === "string" && model.baseUrl.trim() ? model.baseUrl.trim() : undefined,
    },
  };
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function normalizeEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function requestHeaders(
  auth: ModelAuth,
  defaults: Record<string, string>,
  tokenHeader?: "authorization" | "x-goog-api-key",
): Record<string, string> {
  const headers: Record<string, string> = { ...defaults, ...auth.headers };
  if (auth.apiKey && tokenHeader === "authorization" && !hasHeader(headers, "authorization")) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  if (auth.apiKey && tokenHeader === "x-goog-api-key" && !hasHeader(headers, "x-goog-api-key")) {
    headers["x-goog-api-key"] = auth.apiKey;
  }
  return headers;
}

function googleTokenHeader(auth: ModelAuth): "authorization" | "x-goog-api-key" {
  const baseUrl = auth.baseUrl?.toLowerCase() ?? "";
  return baseUrl && !baseUrl.includes("generativelanguage.googleapis.com") ? "authorization" : "x-goog-api-key";
}

function buildWebSearchUserPrompt(query: string): string {
  const normalized = query.trim();
  return `perform web search on "${normalized}". Return results with inline citations (only source index like [1], no URL in the answer) and end with a Sources list of URLs.`;
}

// ─── Google Gemini Web Search ────────────────────────────────────────────────

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function buildGeminiUrl(model: string, baseUrl?: string): string {
  const normalizedModel = model.replace(/^models\//, "");
  const encoded = encodeURIComponent(normalizedModel);
  const base = baseUrl?.trim().replace(/\/+$/, "") || GEMINI_API_BASE;
  return `${base}/models/${encoded}:generateContent`;
}

interface GeminiChunk {
  web?: { title?: string; uri?: string };
}

interface GeminiMetadata {
  groundingChunks?: GeminiChunk[];
  groundingSupports?: Array<{
    segment?: { partIndex?: number; endIndex?: number };
    groundingChunkIndices?: number[];
  }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: unknown }> };
    groundingMetadata?: GeminiMetadata;
  }>;
}

async function googleSearch(
  query: string,
  model: string,
  auth: ModelAuth,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(buildGeminiUrl(model, auth.baseUrl), {
    method: "POST",
    headers: requestHeaders(auth, { "Content-Type": "application/json" }, googleTokenHeader(auth)),
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ googleSearch: {} }],
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Google API error ${response.status}: ${text}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  return formatGeminiResponse(payload, query);
}

function formatGeminiResponse(response: GeminiResponse, query: string): string {
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts?.length) {
    return `No search results found for query: "${query}"`;
  }

  // Extract text, skipping thought parts
  let combined = "";
  const partStartByteByIndex = new Map<number, number>();
  const encoder = new TextEncoder();
  let byteOffset = 0;

  for (const [idx, part] of parts.entries()) {
    if (part.thought) continue;
    if (typeof part.text === "string") {
      partStartByteByIndex.set(idx, byteOffset);
      combined += part.text;
      byteOffset += encoder.encode(part.text).length;
    }
  }

  if (!combined.trim()) {
    return `No search results found for query: "${query}"`;
  }

  const metadata = response.candidates?.[0]?.groundingMetadata;
  const sources = metadata?.groundingChunks ?? [];
  const supports = metadata?.groundingSupports ?? [];

  // Build referenced source index set
  const referenced = new Set<number>();
  for (const support of supports) {
    for (const idx of support.groundingChunkIndices ?? []) {
      if (Number.isInteger(idx) && idx >= 0) referenced.add(idx);
    }
  }

  // Build source list & display index mapping
  const displayBySourceIdx = new Map<number, number>();
  const sourceLines: string[] = [];
  for (const [idx, source] of sources.entries()) {
    if (referenced.size > 0 && !referenced.has(idx)) continue;
    const uri = source.web?.uri?.trim();
    if (!uri) continue;
    const displayIdx = sourceLines.length + 1;
    displayBySourceIdx.set(idx, displayIdx);
    sourceLines.push(`[${displayIdx}] ${source.web?.title?.trim() || "Untitled"} (${uri})`);
  }

  let modifiedText = combined;

  // Insert citation markers at grounding positions
  if (sourceLines.length > 0 && metadata) {
    const insertions = buildGeminiCitationInsertions(metadata, partStartByteByIndex, displayBySourceIdx);
    if (insertions.length > 0) {
      modifiedText = insertMarkersByUtf8Index(modifiedText, insertions);
    }
  }

  if (sourceLines.length > 0) {
    modifiedText += `\n\nSources:\n${sourceLines.join("\n")}`;
  }

  return modifiedText;
}

interface CitationInsertion {
  index: number;
  marker: string;
}

function buildGeminiCitationInsertions(
  metadata: GeminiMetadata,
  partStartByteByIndex: Map<number, number>,
  displayByOriginalIdx: Map<number, number>,
): CitationInsertion[] {
  const markersByIndex = new Map<number, Set<number>>();

  for (const support of metadata.groundingSupports ?? []) {
    const endIndex = support.segment?.endIndex;
    const indices = support.groundingChunkIndices;
    if (typeof endIndex !== "number" || endIndex < 0 || !indices?.length) continue;

    const partIndex = typeof support.segment?.partIndex === "number" ? support.segment.partIndex : 0;
    const partStartByte = partStartByteByIndex.get(partIndex);
    if (partStartByte == null) continue;

    const displayIndices = indices
      .map((i) => displayByOriginalIdx.get(i))
      .filter((i): i is number => i != null);
    if (!displayIndices.length) continue;

    const insertionIdx = partStartByte + endIndex;
    let markerSet = markersByIndex.get(insertionIdx);
    if (!markerSet) {
      markerSet = new Set<number>();
      markersByIndex.set(insertionIdx, markerSet);
    }
    for (const di of displayIndices) markerSet.add(di);
  }

  return Array.from(markersByIndex.entries())
    .map(([idx, markerSet]) => ({
      index: idx,
      marker: Array.from(markerSet)
        .sort((a, b) => a - b)
        .map((i) => `[${i}]`)
        .join(""),
    }))
    .sort((a, b) => b.index - a.index);
}

function insertMarkersByUtf8Index(text: string, insertions: CitationInsertion[]): string {
  let result = text;
  const encoder = new TextEncoder();

  for (const ins of insertions) {
    // Convert UTF-8 byte index to string index
    let byteIdx = 0;
    let charIdx = 0;
    for (const char of result) {
      if (byteIdx === ins.index) break;
      byteIdx += encoder.encode(char).length;
      charIdx += char.length;
    }
    if (byteIdx === ins.index) {
      result = result.slice(0, charIdx) + ins.marker + result.slice(charIdx);
    }
  }

  return result;
}

// ─── OpenAI Web Search ───────────────────────────────────────────────────────

interface OpenAISource {
  title?: string;
  url: string;
}

async function openaiSearch(
  query: string,
  model: string,
  auth: ModelAuth,
  config: WebsearchConfig["openai"],
  signal: AbortSignal,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    instructions: "You are an AI assistant answering a single web search query for the user.",
    input: [{ role: "user", content: [{ type: "input_text", text: buildWebSearchUserPrompt(query) }] }],
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"],
    store: false,
    stream: true,
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  if (config?.reasoningEffort) body.reasoning = { ...(body.reasoning as object || {}), effort: config.reasoningEffort };
  if (config?.reasoningSummary) body.reasoning = { ...(body.reasoning as object || {}), summary: config.reasoningSummary };
  if (config?.textVerbosity) body.text = { verbosity: config.textVerbosity };

  const url = (auth.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "") + "/responses";
  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders(auth, {
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=experimental",
    }, "authorization"),
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const payload = await parseOpenAIResponse(response);
  return formatOpenAIResponse(payload, query);
}

async function parseOpenAIResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  // SSE parsing
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed.type === "response.done" || parsed.type === "response.completed") {
        return parsed.response;
      }
    } catch {}
  }

  throw new Error("Failed to parse OpenAI SSE response");
}

function formatOpenAIResponse(payload: unknown, query: string): string {
  if (!payload || typeof payload !== "object") {
    return `Web search completed for "${query}", but no results were returned.`;
  }

  const root = payload as { output?: unknown[] };
  const output = root.output;
  if (!Array.isArray(output) || output.length === 0) {
    return `Web search completed for "${query}", but no results were returned.`;
  }

  let combined = "";
  const sources: OpenAISource[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;

    // Collect sources from action
    const action = (item as { action?: { sources?: unknown[] } }).action;
    if (action?.sources) {
      for (const src of action.sources) {
        addOpenAISource(sources, src);
      }
    }

    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const kind = (part as { type?: string }).type;
      if (kind !== "output_text") continue;

      const textField = (part as { text?: unknown }).text;
      if (typeof textField === "string") combined += textField;
      else if (textField && typeof textField === "object") {
        const val = (textField as { value?: string }).value;
        if (typeof val === "string") combined += val;
      }

      const annotations = (part as { annotations?: unknown[] }).annotations;
      if (Array.isArray(annotations)) {
        for (const ann of annotations) addOpenAISource(sources, ann);
      }
    }
  }

  if (!combined.trim()) {
    return `Web search completed for "${query}", but no results were returned.`;
  }

  if (sources.length > 0 && !/(^|\n)Sources:/i.test(combined)) {
    const lines = sources.map((s, i) => `[${i + 1}] ${s.title ?? "Untitled"} (${s.url})`);
    combined += `\n\nSources:\n${lines.join("\n")}`;
  }

  return combined;
}

function addOpenAISource(sources: OpenAISource[], value: unknown): void {
  if (!value || typeof value !== "object") return;
  const record = value as { title?: string; url?: string };
  if (typeof record.url !== "string" || !record.url.trim()) return;
  if (sources.some((s) => s.url === record.url)) return;
  sources.push({
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : undefined,
    url: record.url.trim(),
  });
}

async function runSearchTarget(
  query: string,
  target: WebsearchModelConfig,
  config: WebsearchConfig,
  ctx: ToolContext,
  signal: AbortSignal,
): Promise<{ text: string; provider: string; model: string }> {
  switch (target.provider) {
    case "google": {
      const resolved = await resolveModelAuth("google", target.model, ctx);
      return { text: await googleSearch(query, resolved.id, resolved.auth, signal), provider: resolved.provider, model: resolved.id };
    }
    case "openai": {
      const resolved = await resolveModelAuth("openai", target.model, ctx);
      return { text: await openaiSearch(query, resolved.id, resolved.auth, config.openai, signal), provider: resolved.provider, model: resolved.id };
    }
  }
}

async function runSearchWithFallbacks(
  query: string,
  plan: WebsearchModelConfig[],
  config: WebsearchConfig,
  ctx: ToolContext,
  signal: AbortSignal,
): Promise<{ text: string; provider: string; model: string; failures: string[] }> {
  const failures: string[] = [];

  for (const target of plan) {
    try {
      const result = await runSearchTarget(query, target, config, ctx, signal);
      return { ...result, failures };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      failures.push(`${modelLabel(target)}: ${errorMessage(error)}`);
    }
  }

  throw new Error(`All websearch backends failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config: WebsearchConfig | undefined;

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    const plan = configuredModels(config);
    const available = plan.filter((entry) => !!ctx.modelRegistry.find(entry.provider, entry.model));
    const planText = plan.map(modelLabel).join(" -> ");

    ctx.ui.notify(
      `Websearch fallback: ${planText}${available.length > 0 ? "" : " (no configured models found in Pi catalog)"}`,
      available.length > 0 ? "info" : "warning",
    );
  });

  pi.registerTool({
    name: "websearch_cited",
    label: "Web Search (Cited)",
    description:
      "Performs provider-native grounded web search with ordered fallback: Google, then OpenAI by default. " +
      "Returns a concise digest with inline citations and a Sources list of URLs. " +
      "Use optional provider/model parameters to try a specific backend first. " +
      "Returns results with citation markers like [1][2] and a Sources section at the end. " +
      "NOTE: for LLM rate limits, DO NOT parallel this tool > 5",
    promptSnippet: "Search the web with inline citations and a Sources list",
    promptGuidelines: [
      "Use websearch_cited when the user asks for current information, news, facts you're unsure about, or anything requiring web lookup.",
      "Call websearch_cited with a natural language query describing what you want to find.",
      "If the user asks for a specific search model, pass model and optionally provider; the extension will try that first, then configured fallbacks.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The natural language web search query" }),
      provider: Type.Optional(Type.Union([
        Type.Literal("google"),
        Type.Literal("openai"),
      ], { description: "Optional provider to try first: google or openai" })),
      model: Type.Optional(Type.String({ description: "Optional model id to try first, e.g. gemini-3.6-flash or gpt-5.5" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const query = params.query?.trim();
      if (!query) throw new Error("The 'query' parameter cannot be empty.");

      try {
        const activeConfig = config ?? loadConfig(ctx.cwd);
        const plan = searchPlan(params, activeConfig);
        const result = await runSearchWithFallbacks(query, plan, activeConfig, ctx, signal);
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            provider: result.provider,
            model: result.model,
            fallbackPlan: plan.map(modelLabel),
            failedBackends: result.failures,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Web search failed: ${message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
