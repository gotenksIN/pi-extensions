# Web Search with Citations

## Purpose

This extension adds the `websearch_cited` tool to Pi.
The tool uses provider-native web search and returns a concise answer with inline citations and a `Sources` list.

The default order is:

1. OpenAI: `openai/gpt-5.6-luna`
2. Google Gemini: `google/gemini-3.6-flash`

The first successful backend returns the result.

## Features

- Uses Google Gemini grounding through `googleSearch`.
- Uses the OpenAI Responses API through `web_search`.
- Adds citation markers such as `[1]` and `[2]` to the answer when source metadata is available.
- Adds a final `Sources:` section with source titles and URLs.
- Tries configured models in order.
- Lets a tool call try one provider or model before the configured fallback list.
- Uses Pi's model registry for model lookup, authentication, headers, environment values, and base URLs.
- Does not require separate API key or OAuth settings.
- Stops promptly when Pi cancels the request.

## Installation

The complete `pi-extensions` package includes this extension.

To install only this extension, copy the file to Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions/websearch
cp extensions/websearch/index.ts ~/.pi/agent/extensions/websearch/index.ts
```

Restart Pi or run:

```text
/reload
```

## Configuration

Global configuration:

```text
~/.pi/agent/extensions/websearch.json
```

Project configuration:

```text
.pi/websearch.json
```

Project values merge over global values.
The extension accepts an ordered `models` list:

```json
{
  "models": [
    { "provider": "openai", "model": "gpt-5.6-luna" },
    { "provider": "google", "model": "gemini-3.6-flash" }
  ]
}
```

The compact string form is also valid:

```json
{
  "models": [
    "openai/gpt-5.6-luna",
    "google/gemini-3.6-flash"
  ]
}
```

A legacy single-model form remains supported:

```json
{
  "provider": "google",
  "model": "gemini-3.6-flash"
}
```

The extension also accepts OpenAI request options:

```json
{
  "openai": {
    "reasoningEffort": "low",
    "reasoningSummary": "auto",
    "textVerbosity": "medium"
  }
}
```

Supported providers are `google` and `openai`.
Invalid model entries are ignored.
If no valid custom model entry remains, the default list is used.
The selected models must exist in Pi's model registry and must have valid Pi authentication.

## Tool parameters

The required parameter is `query`:

```json
{
  "query": "What changed in the latest Pi release?"
}
```

Use `provider` and `model` to try a preferred backend first:

```json
{
  "query": "Current Linux Bubblewrap user namespace requirements",
  "provider": "google",
  "model": "gemini-3.6-flash"
}
```

The requested target is followed by the configured fallback list.
Duplicate targets are removed while their first position is kept.

## Provider behavior

### Google Gemini

The extension calls the Gemini `generateContent` endpoint with the `googleSearch` tool.
It reads answer text and grounding metadata.
It maps grounding support positions to source indexes and inserts citation markers.

### OpenAI

The extension calls the Responses API with the `web_search` tool.
It supports both JSON and server-sent event responses.
It reads output text, source annotations, and web-search source lists.

## Errors and fallback

The extension tries each target in order.
A missing model, missing authentication, provider error, or response parse error moves to the next target.
An abort stops the request and does not continue fallback.
If every target fails, the tool returns an error result with the attempted backend messages.

Provider errors may contain provider response text in the returned tool error.
Do not place credentials, authorization headers, or raw authentication values in queries or configuration files.
