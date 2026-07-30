# Pi Extensions

Extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## Install the complete setup

Install this extension package and the Catppuccin theme package over SSH:

```bash
pi install git:git@github.com:gotenksIN/pi-extensions.git
pi install git:git@github.com:otahontas/pi-coding-agent-catppuccin.git
```

Pi runs `npm install` for Git packages containing `package.json`. The
standalone Pi binary does not include a JavaScript package manager. If `node`
and `npm` are unavailable, temporarily install the smaller Bun runtime without
requiring Node.js:

```bash
(
  set -e

  work="$HOME/sandbox/bun-install"
  rm -rf "$work"
  mkdir -p "$work" "$HOME/.local/bin"
  cd "$work"

  gh release download \
    --repo oven-sh/bun \
    --pattern 'bun-linux-x64.zip' \
    --pattern 'SHASUMS256.txt'

  sha256sum --check --ignore-missing SHASUMS256.txt
  7z x bun-linux-x64.zip

  # Use the absolute path because some Zsh setups alias `install` to Nala.
  /usr/bin/install -Dm755 \
    "$work/bun-linux-x64/bun" \
    "$HOME/.local/bin/bun"

  "$HOME/.local/bin/bun" --version
  rm -rf "$work"
)
```

If installing `pi-subagents` failed before Bun was available, install its
production dependencies directly, then remove Bun because Pi's standalone
runtime can load the installed modules without keeping the package manager:

```bash
cd ~/.pi/agent/git/github.com/tintinweb/pi-subagents
~/.local/bin/bun install --production --ignore-scripts --no-save
rm -f ~/.local/bin/bun
```

Copy the tracked [`settings.json`](settings.json) into Pi's agent directory to
reproduce this setup exactly:

```bash
cp settings.json ~/.pi/agent/settings.json
```

This replaces the destination settings and intentionally configures only the
shared packages and theme. The theme pair uses Catppuccin Latte for light
terminal backgrounds and Frappé for dark terminal backgrounds. Pi follows
terminal color-scheme changes automatically.

Restart Pi or run:

```text
/reload
```

Update both packages later with:

```bash
pi update --extensions
```

Pi packages execute code with your user permissions. Review third-party package
sources before installing them.

## bwrap-sandbox

A Linux-only Bubblewrap integrity sandbox for Pi Bash, with an application-level
permission gate for Pi filesystem tools.

### Architecture and guarantees

Every Bash call starts from a read-only host root with fresh `/dev` and `/proc`.
Canonical, most-specific `none`/`read`/`write` policy and human-approved session
write grants produce one deterministic mount plan. Grants never override
`none`. Each session also gets a mode-0700 private writable temp capability;
`TMPDIR`, `TMP`, and `TEMP` all identify it.

SSH agent compatibility is enabled by default. Only the exact canonical socket
in inherited `SSH_AUTH_SOCK` is mounted, read-only, and it may cross an inherited
denied parent without exposing siblings. An exact `none` rule on the socket
vetoes startup. If globally disabled, the variable is removed and an otherwise
visible inherited socket is exactly masked. Agent access lets sandboxed commands
request authentication or signatures with available keys even though private
key files remain hidden; security-focused users may disable it globally.

The runtime keeps trusted mask and SSH-configuration source files outside the
writable private `TMPDIR` and hides their parent behind a synthetic mount. A
minimal mode-0600 OpenSSH system configuration is mounted read-only at the
standard path, avoiding user-namespace ownership rejection while preserving
permitted user SSH configuration. This supports ordinary SSH and Git-over-SSH
without command parsing or Git-specific environment patches.

This is an integrity and write-boundary sandbox. It is not a confidentiality
boundary. Unmatched host files and inherited environment values are readable.
Network access is available when network isolation is off. Direct Pi filesystem
tools use an application-level authorization gate. They do not use OS
containment.

The extension also has a two-stage classifier for model-generated Bash calls
and direct `read`, `grep`, `write`, and `edit` calls. Direct-tool classification
uses only sanitized project-path and operation metadata. It does not send file
content, grep patterns, edit text, or write payloads to the provider.
The classifier is an additional check. Bubblewrap remains the primary security
boundary. Automatic execution requires `allow` from both classifier stages.
A review, invalid result, refusal, timeout, or exhausted technical failure opens
the shared human review prompt. A semantic review shows the classifier's
validated bounded reason. A human can create a single-use approval for the exact
classified call.
Cancellation blocks the call without a new prompt. A technical provider failure
triggers fallback to the next complete model pair. A valid review cannot cause
provider fallback.

The default pair order is Google and then OpenAI. Google uses
`gemini-3.5-flash-lite` and `gemini-3.6-flash`. OpenAI uses `gpt-5.4-nano` and
`gpt-5.4-mini`. The extension uses models, providers, and authentication from
Pi. It does not store provider credentials. Global configuration can replace
the defaults with complete custom pairs.

See the authoritative
[`extensions/bwrap-sandbox/README.md`](extensions/bwrap-sandbox/README.md) for
the threat model, precedence, module ownership, mount invariants, lifecycle
limitations, testing strategy, and mandatory change checklist.

### Requirements and installation

Linux and a working, root-owned `bubblewrap` installation are required. The
extension probes Bubblewrap at session start and fails closed if it is missing,
untrusted, or unusable.

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install bubblewrap

# Fedora / RHEL
sudo dnf install bubblewrap

# Arch / Manjaro
sudo pacman -S bubblewrap
```

Copy the complete module directory, then restart Pi or run `/reload`:

```bash
mkdir -p ~/.pi/agent/extensions/bwrap-sandbox
cp -a extensions/bwrap-sandbox/. ~/.pi/agent/extensions/bwrap-sandbox/
```

### Configuration

Global config: `~/.pi/agent/extensions/sandbox.json`

Trusted project config: `.pi/sandbox.json`

Global example (`sshAgent` must be omitted from project config):

```json
{
  "enabled": true,
  "isolateNetwork": false,
  "sshAgent": true,
  "classifier": {
    "enabled": true,
    "stage1TimeoutMs": 20000,
    "stage2TimeoutMs": 30000,
    "maxRetries": 1
  },
  "filesystem": {
    ":project": "write",
    ":project/.git": "read",
    "~/.ssh": "none",
    "~/.ssh/config": "read",
    "~/.ssh/known_hosts": "read",
    "~/.pi": "read",
    "/tmp": "read"
  }
}
```

Configuration is strict. Paths compile to canonical absolute policy. The
`sshAgent` and `classifier` settings are global-only. Project configuration
fails closed if either field is present. Other permitted project settings can
override global settings.

Omit `classifier.pairs` to use the default Google and OpenAI pairs. A configured
list replaces the defaults. Each pair has one provider and two stages. Each
stage specifies a model and a Pi reasoning level. This lets users select models
that their Pi setup can use. If no complete pair is available, Bubblewrap still
starts. The extension shows a warning and requires human review for
model-generated Bash, read, grep, write, and edit calls.
See the extension architecture document for the custom pair schema and privacy
limits.

`sandbox_access` uses `scope: "exact"` by default. Use exact scope for content
changes. Use `scope: "parent"` for create, delete, rename, or move operations.
An exact file grant creates a mount point, so Linux can return `EBUSY` if a later
command tries to delete or rename that file. Do not grant the exact file first
for a directory-entry change. Parent scope remains subject to human approval,
`none` rules, and protected runtime paths.

The default-policy decision protects `:project/.git` as read-only only when a
`.git` entry exists at session start. This supports both directories and regular
linked-worktree gitfiles. If it is absent, the rule is omitted and a writable
project can create it; the next session then protects the new entry. Metadata
writes require an explicit grant. The policy remains static and does not infer
external Git metadata from file contents or commands.

`isolateNetwork: true` adds `--unshare-net`. Fresh `/dev` and `/proc` satisfy
read rules without host rebinds. Writable paths intersecting them, and readable
overrides beneath a denied virtual path, are rejected.

### Status and one-command tests

`/sandbox` shows lifecycle state, canonical policy, network settings, private
`TMPDIR`, grants, SSH capability state, classifier availability, configured
pairs, and the last sanitized classifier outcome. Direct `read`, `grep`,
`write`, and `edit` calls use deterministic path policy before privacy-safe
secret classification. `find` and `ls` continue to use only deterministic path
policy. Direct writes retain user approval when required.

`/sandbox-test` is the single test command. Its lazy test bridge loads the
Pi-native unit suite first and then runs the shell integration script through
the active session runtime. Repeated command runs reuse module registration and
do not duplicate unit cases. If runtime initialization is unavailable, unit
cases still run and integration is clearly reported as skipped.

```text
/sandbox-test
```

The command reports the unit total and integration PASS/FAIL/SKIP summary and
writes combined output to `sandbox-manual-test.log`. Integration keeps the PNG
fixture and runtime checks, and also creates a throwaway repository under
private `TMPDIR`, verifies trusted source resources remain hidden, parses
ordinary OpenSSH configuration, authenticates to an SSH Git origin, makes a real
commit using inherited global SSH-signing config, checks its SSH `gpgsig`,
constructs a temporary allowed-signers file, and runs `git verify-commit`. All
fixtures are removed.

## websearch

A provider-native grounded web search extension that registers the real Pi tool
`websearch_cited`.

### Features

- Registers `websearch_cited` as a first-class Pi toolcall.
- Uses provider-native web search/grounding where available:
  - Google Gemini `googleSearch`
  - OpenAI Responses API `web_search`
- Returns inline numeric citations like `[1]` plus a final `Sources:` list.
- Supports ordered model fallback. By default:
  1. `google/gemini-3.6-flash`
  2. `openai/gpt-5.5`
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
    { "provider": "google", "model": "gemini-3.6-flash" },
    { "provider": "openai", "model": "gpt-5.5" }
  ]
}
```

Compact string form is also supported:

```json
{
  "models": [
    "google/gemini-3.6-flash",
    "openai/gpt-5.5"
  ]
}
```

### Tool parameters

```json
{
  "query": "current search query",
  "provider": "google",
  "model": "gemini-3.6-flash"
}
```

Only `query` is required. `provider` and `model` are optional and are tried
first when supplied.

## delete-session

A small session-management extension that registers `/delete`.

### Features

- Deletes the current session file after an explicit confirmation prompt.
- Waits for Pi to become idle before deleting.
- Starts a fresh session after deleting the old session file.
- Safely no-ops for ephemeral sessions with no backing session file.

### Install

Copy the extension into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions/delete-session
cp extensions/delete-session/index.ts ~/.pi/agent/extensions/delete-session/index.ts
```

Then restart Pi or run:

```text
/reload
```

### Command

Inside Pi:

```text
/delete
```

The command prompts before deletion:

```text
No - keep it
Yes - delete and start new
```

## keybinding-shortcuts

An editor shortcut extension that adds OpenCode-style command-menu and word
deletion keybindings.

### Features

- Makes `ctrl+p` insert `/` in the chat editor.
- Reuses Pi's built-in slash-command autocomplete/menu instead of replacing it.
- Maps `ctrl+backspace` to backward word deletion.
- Maps `ctrl+delete` to forward word deletion.

### Install

Copy the extension into Pi's global extension directory:

```bash
cp extensions/keybinding-shortcuts/index.ts ~/.pi/agent/extensions/keybinding-shortcuts.ts
```

Then unbind Pi's default `ctrl+p` built-in actions in
`~/.pi/agent/keybindings.json` so they do not compete with the extension or
emit shortcut-conflict warnings:

```json
{
  "app.model.cycleForward": [],
  "app.session.togglePath": [],
  "app.models.toggleProvider": []
}
```

These are the complete exact `ctrl+p` default bindings Pi currently documents:

- `app.model.cycleForward` - main app model cycling
- `app.session.togglePath` - session picker path display toggle
- `app.models.toggleProvider` - `/scoped-models` provider toggle

`app.model.cycleBackward` uses `shift+ctrl+p`, not exact `ctrl+p`, so it does
not conflict with this extension.

If you already have a keybindings file, merge those entries with your existing
settings.

Then restart Pi or run:

```text
/reload
```

### Shortcut

Inside Pi's chat editor:

```text
ctrl+p
```
