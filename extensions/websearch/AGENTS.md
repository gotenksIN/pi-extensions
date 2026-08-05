# Web Search Agent Guide

Read `README.md` before you modify this extension.
Keep implementation, user documentation, and Pi tool behavior consistent.
Use ASD-STE100 Simplified Technical English in documentation, prompts, errors, and comments.

## Purpose and boundary

This extension registers one Pi tool, `websearch_cited`.
It performs provider-native grounded search with Google Gemini and OpenAI.
It does not provide a general HTTP client or a custom authentication store.
It must use Pi's model registry for provider configuration.

The extension handles network requests in the Pi host process.
Treat query text, provider responses, source URLs, and model registry values as untrusted input.
Do not claim that search results are true only because a provider returned them.

## Module ownership

`index.ts` owns all current behavior:

- Declares provider and configuration types.
- Loads global and project configuration.
- Parses and de-duplicates model targets.
- Infers a provider for known model name prefixes.
- Resolves models and authentication through `ctx.modelRegistry`.
- Builds Google and OpenAI requests.
- Parses provider responses.
- Formats citations and the `Sources` list.
- Runs ordered fallback.
- Registers the `session_start` notification and `websearch_cited` tool.

Do not move security-sensitive authentication logic into configuration parsing.
Do not add provider SDK credentials or a second model registry.
If this file becomes large enough to split, keep these ownership boundaries explicit:

- Configuration loading and validation.
- Pi model and authentication resolution.
- Provider request and response parsing.
- Citation formatting.
- Fallback planning.
- Pi registration.

## Configuration invariants

- Global configuration is loaded from `~/.pi/agent/extensions/websearch.json`.
- Project configuration is loaded from `.pi/websearch.json`.
- Project values merge over global values.
- Supported providers are only `google` and `openai`.
- `models` is an ordered fallback list.
- A model entry must contain a non-empty provider and model ID.
- String entries use the `provider/model` form.
- Duplicate targets are removed without changing the first occurrence.
- A valid explicit `models` list replaces the default list.
- Legacy `provider` and `model` values remain supported when `models` is absent or empty.
- OpenAI request options affect request shaping only.
- Configuration errors must not expose credentials.

Do not let project repository content select a provider outside the supported list.
Do not read API keys from ad hoc environment variables when Pi can provide the values.

## Model and authentication invariants

Resolve every target with:

1. `ctx.modelRegistry.find(provider, model)`.
2. `ctx.modelRegistry.getApiKeyAndHeaders(model)`.
3. The model's registered `baseUrl`.

Accept Pi authentication from an API key, authorization header, or Google API-key header.
Normalize headers and environment values before use.
Do not log or return API keys, OAuth tokens, authorization headers, or secret environment values.
Do not persist resolved authentication.

Use the registered model ID in provider requests after resolution.
A missing model or authentication result is a technical target failure and may use fallback.

## Fallback invariants

The default ordered targets are:

1. `openai/gpt-5.6-luna`.
2. `google/gemini-3.6-flash`.

Build the search plan as:

1. An explicit tool-call target, when supplied.
2. The configured ordered targets.
3. De-duplication by provider and model.

A provider target succeeds only when its request completes and its response parses.
A technical target failure continues to the next target.
An aborted request is final and must not start another target.
If every target fails, return an error result with provider and model labels only when safe.
Do not mix credentials or request state between targets.

## Google behavior

Use Gemini `generateContent` with:

- `contents` containing the user query.
- `tools: [{ googleSearch: {} }]`.

Read answer text from non-thought parts.
Read grounding chunks and grounding supports from the response.
Map source indexes to display indexes.
Use UTF-8 byte positions when applying grounding markers.
Skip missing or invalid source URLs.
Do not invent citations when grounding metadata is absent.

## OpenAI behavior

Use the Responses API with:

- `tools: [{ type: "web_search" }]`.
- `include: ["web_search_call.action.sources"]`.
- `store: false`.
- Streaming enabled by the current implementation.

Support a complete JSON response and a server-sent event response.
For server-sent events, use the completed response event.
Read output text, action sources, and output annotations.
De-duplicate sources by URL.
Do not treat arbitrary response fields as trusted source metadata.

## Output invariants

Return answer text in `content`.
Return provider, model, fallback plan, and failed backend labels in `details`.
Do not put credentials or raw auth headers in content or details.
Use citation markers only for sources that the provider returned.
End with a `Sources:` section when at least one source exists.
Keep source URLs as returned by the provider, after checking that they are non-empty strings.

Tool errors must set `isError: true`.
An empty or whitespace-only query must fail before a provider request.
Cancellation must propagate through `AbortSignal`.

## Change checklist

Before a change, verify:

- Does the change preserve Pi model registry and authentication reuse?
- Does it keep OpenAI first in the default plan?
- Does it preserve ordered fallback and abort behavior?
- Can provider output inject credentials, control text, or false citation data?
- Are source URLs and error messages bounded and safe to return?
- Does the change require JSON and server-sent event coverage?
- Are legacy configuration forms still supported?
- Are README.md and root README.md consistent?
- Are tests or a provider-mock harness needed?

Do not add raw provider response logging, direct credential configuration, shell execution, repository-file ingestion, or parallel fallback calls without a separate security review.
