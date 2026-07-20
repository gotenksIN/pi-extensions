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

### Commands

Inside Pi:

```text
/sandbox
/sandbox-test
```
