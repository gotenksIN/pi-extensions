# Delete Session Extension

## Purpose

This extension deletes the current session file and starts a fresh session.
It prevents accidental file deletion with a confirmation prompt.

## Features

- Registers the `/delete` command in Pi.
- Asks for user confirmation before file deletion.
- Waits for active agent tasks to complete before unlinking the file.
- Shows a notification for ephemeral sessions that have no file on disk.

## Installation

When you install the complete `pi-extensions` package, Pi loads this extension automatically.

To install this extension separately, copy the directory to Pi's global extension folder:

```bash
mkdir -p ~/.pi/agent/extensions/delete-session
cp extensions/delete-session/index.ts ~/.pi/agent/extensions/delete-session/index.ts
```

Then restart Pi or run:

```text
/reload
```

## Usage

Run the command in Pi:

```text
/delete
```

The extension shows a confirmation prompt with the current session file path:

```text
Delete this session?

  /path/to/session.json

This cannot be undone.
```

Select one of the choices:

- `No - keep it`: Cancel the operation and keep the current session.
- `Yes - delete and start new`: Wait for idle tasks, delete the file, and open a new session.
