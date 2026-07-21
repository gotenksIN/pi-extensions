# Pi Extensions

Extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## bwrap-sandbox

A Linux `bubblewrap` sandbox extension for Pi bash and file tools.

### Features

- Runs bash commands under `bwrap`.
- Uses a structured filesystem policy:
  - `"none"`
  - `"read"`
  - `"write"`
- Keeps a sparse host-read model instead of binding the full host filesystem.
- Mounts protected project paths read-only by default, including `.git`, `.pi`, `.agents`, `.codex`, and `.env`.
- Keeps common tool config under `~/.config` read-only by default.
- Keeps Git user config under `~/.gitconfig` read-only by default.
- Supports SSH/Git pushes via a mounted SSH agent socket without mounting private keys.
- Keeps Pi config under `~/.pi` read-only by default.
- Supports memory-only session grants for one-off file/bash access.
- Network access is normal by default.
- Optional paranoid network isolation via `isolateNetwork: true`.

### Requirements

Install `bubblewrap` and ensure `bwrap` is on `PATH`:

```bash
sudo apt install bubblewrap
```

### Install

Copy the extension into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions/bwrap-sandbox
cp extensions/bwrap-sandbox/index.ts ~/.pi/agent/extensions/bwrap-sandbox/index.ts
```

Then restart Pi or run:

```text
/reload
```

### Configuration

Global config path:

```text
~/.pi/agent/extensions/sandbox.json
```

Project config path:

```text
.pi/sandbox.json
```

Example:

```json
{
  "isolateNetwork": false,
  "filesystem": {
    ":project": "write",
    ":project/.git": "read",
    ":project/.agents": "read",
    ":project/.codex": "read",
    ":project/.pi": "read",
    ":project/.env": "read",
    "~/sandbox": "write",
    "~/.config": "read",
    "~/.gitconfig": "read",
    "~/.ssh": "none",
    "~/.ssh/config": "read",
    "~/.ssh/known_hosts": "read",
    "~/.ssh/known_hosts2": "read",
    "~/.ssh/id_ed25519.pub": "read",
    "~/.ssh/id_ecdsa.pub": "read",
    "~/.ssh/id_ecdsa_sk.pub": "read",
    "~/.ssh/id_rsa.pub": "read",
    "~/.ssh/id_dsa.pub": "read",
    "~/.ssh/id_ed25519": "none",
    "~/.ssh/id_ecdsa": "none",
    "~/.ssh/id_ecdsa_sk": "none",
    "~/.ssh/id_rsa": "none",
    "~/.ssh/id_dsa": "none",
    "~/.pi": "read"
  }
}
```

Legacy compatibility:

```json
{
  "allowNetwork": false
}
```

is interpreted as:

```json
{
  "isolateNetwork": true
}
```


### SSH/Git pushes

The sandbox intentionally does **not** mount private SSH keys. Instead, when
`sshAgent` is enabled, it mounts a live `SSH_AUTH_SOCK` socket read/write and
sets `GIT_SSH_COMMAND` to use the agent plus `~/.ssh/config`. This lets
`git push` authenticate through your host SSH agent/keychain without exposing private
key files to sandboxed bash or file tools.

Default:

```json
{
  "sshAgent": true
}
```

For keychain-managed agents, the extension also checks:

```text
~/.keychain/<hostname>-sh
```

### Commands

Inside Pi:

```text
/sandbox
/sandbox-test
```

## websearch

A provider-native grounded web search extension that registers the real Pi tool
`websearch_cited`.

### Features

- Registers `websearch_cited` as a first-class Pi toolcall.
- Uses provider-native web search/grounding where available:
  - Google Gemini `googleSearch`
  - OpenAI Responses API `web_search`
  - OpenRouter Responses API `web` plugin
- Returns inline numeric citations like `[1]` plus a final `Sources:` list.
- Supports ordered model fallback. By default:
  1. `google/gemini-3.5-flash`
  2. `openai/gpt-5.5`
  3. `openrouter/google/gemini-3.5-flash`
- Allows per-call preferred backend via optional `provider` and `model` tool
  parameters; configured fallbacks are tried after the requested backend.
- Inherits auth, headers, and base URLs from Pi's model registry:
  - `ctx.modelRegistry.find(provider, model)`
  - `ctx.modelRegistry.getApiKeyAndHeaders(model)`
  - `model.baseUrl`
  - `auth.headers`
  - `auth.env`
- Does not duplicate API-key, OAuth, or base-URL configuration.

### Install

Copy the extension into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions/websearch
cp extensions/websearch/index.ts ~/.pi/agent/extensions/websearch/index.ts
```

Then restart Pi or run:

```text
/reload
```

### Configuration

Global config path:

```text
~/.pi/agent/extensions/websearch.json
```

Project config path:

```text
.pi/websearch.json
```

Example fallback config:

```json
{
  "models": [
    { "provider": "google", "model": "gemini-3.5-flash" },
    { "provider": "openai", "model": "gpt-5.5" },
    { "provider": "openrouter", "model": "google/gemini-3.5-flash" }
  ]
}
```

Compact string form is also supported:

```json
{
  "models": [
    "google/gemini-3.5-flash",
    "openai/gpt-5.5",
    "openrouter/google/gemini-3.5-flash"
  ]
}
```

### Tool parameters

```json
{
  "query": "current search query",
  "provider": "google",
  "model": "gemini-3.5-flash"
}
```

Only `query` is required. `provider` and `model` are optional and are tried
first when supplied.
