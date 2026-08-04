import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authorizeDirectTool, isDirectFilesystemTool, type DirectAuthorizationSession } from "../direct-gate.ts";
import { assert, test } from "./harness.ts";

test("direct gate forwards filesystem tools to the required authorization path", async () => {
  const routes: string[] = [];
  const ctx = {} as ExtensionContext;
  let expected: { id: string; tool: string; path: string; input: unknown };
  const record = (route: string, id: string, tool: string, path: string, input: unknown, actualCtx: ExtensionContext) => {
    assert.deepEqual({ id, tool, path, input }, expected);
    assert.equal(actualCtx, ctx);
    routes.push(`${tool}:${route}`);
  };
  const session: DirectAuthorizationSession = {
    async authorizeDirectRead(id, tool, path, input, actualCtx) {
      record("read", id, tool, path, input, actualCtx);
    },
    async authorizeDirectWrite(id, tool, path, input, actualCtx) {
      record("write", id, tool, path, input, actualCtx);
    },
  };

  for (const tool of ["read", "grep", "find", "ls", "write", "edit"]) {
    expected = { id: `id-${tool}`, tool, path: `${tool}.txt`, input: { path: `${tool}.txt` } };
    await authorizeDirectTool(expected.id, tool, expected.path, expected.input, session, ctx);
  }

  assert.deepEqual(routes, [
    "read:read",
    "grep:read",
    "find:read",
    "ls:read",
    "write:write",
    "edit:write",
  ]);
});

test("direct gate recognizes only filesystem tools", () => {
  for (const tool of ["read", "grep", "write", "edit", "find", "ls"]) {
    assert.equal(isDirectFilesystemTool(tool), true);
  }
  assert.equal(isDirectFilesystemTool("Agent"), false);
});
