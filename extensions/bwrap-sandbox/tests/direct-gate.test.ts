import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authorizeDirectTool, isDirectFilesystemTool, type DirectAuthorizationSession } from "../direct-gate.ts";
import { isSecretClassifiedTool } from "../direct-secret-evidence.ts";
import { assert, test } from "./harness.ts";

test("direct gate routes structured read and write access classes", async () => {
  const calls: unknown[] = [];
  const session: DirectAuthorizationSession = {
    async authorizeDirectRead(toolCallId, toolName, rawPath, input, ctx) {
      calls.push(["read", toolCallId, toolName, rawPath, input, ctx]);
    },
    async authorizeDirectWrite(toolCallId, toolName, rawPath, input, ctx) {
      calls.push(["write", toolCallId, toolName, rawPath, input, ctx]);
    },
  };
  const ctx = {} as ExtensionContext;
  const input = { path: "a" };
  await authorizeDirectTool("id-read", "read", "a", input, session, ctx);
  await authorizeDirectTool("id-grep", "grep", "a", input, session, ctx);
  await authorizeDirectTool("id-write", "write", "a", input, session, ctx);
  await authorizeDirectTool("id-edit", "edit", "a", input, session, ctx);
  assert.deepEqual(calls, [
    ["read", "id-read", "read", "a", input, ctx],
    ["read", "id-grep", "grep", "a", input, ctx],
    ["write", "id-write", "write", "a", input, ctx],
    ["write", "id-edit", "edit", "a", input, ctx],
  ]);
});

test("direct gate keeps find and ls deterministic and recognizes only filesystem tools", async () => {
  let calls = 0;
  const session: DirectAuthorizationSession = {
    async authorizeDirectRead() { calls += 1; },
    async authorizeDirectWrite() { calls += 1; },
  };
  const ctx = {} as ExtensionContext;
  await authorizeDirectTool("id-find", "find", ".", {}, session, ctx);
  await authorizeDirectTool("id-ls", "ls", ".", {}, session, ctx);
  assert.equal(calls, 2);
  for (const tool of ["read", "grep", "write", "edit", "find", "ls"]) {
    assert.equal(isDirectFilesystemTool(tool), true);
  }
  assert.equal(isDirectFilesystemTool("Agent"), false);
  assert.equal(isSecretClassifiedTool("find"), false);
  assert.equal(isSecretClassifiedTool("ls"), false);
});
