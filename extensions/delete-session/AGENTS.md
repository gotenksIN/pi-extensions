# Delete Session Agent Guide

Read `README.md` before you modify this extension.
Keep code changes, `README.md`, and user prompts consistent.

## Purpose

This extension provides a command handler to delete the current session file and start a fresh session.
It protects session files from unintended removal.

## Code Responsibilities

`index.ts` is the single module for this extension:

- Registers the `/delete` command with Pi.
- Checks if the current session has a backing file.
- Renders the confirmation menu through `ctx.ui.select`.
- Waits for agent idle state with `ctx.waitForIdle()`.
- Unlinks the session file synchronously with `unlinkSync`.
- Starts a new session with `ctx.newSession({})`.

## Safety Invariants

Follow these rules when you maintain `index.ts`:

- Always check `ctx.sessionManager.getSessionFile()` first.
- Handle ephemeral sessions (`null` path) gracefully without errors or file operations.
- Require explicit user confirmation before file deletion.
- Await `ctx.waitForIdle()` before you remove the session file to avoid race conditions with running background tasks.
- Notify the user with `ctx.ui.notify` after successful file removal.
- Start the new session only after file unlinking succeeds.
