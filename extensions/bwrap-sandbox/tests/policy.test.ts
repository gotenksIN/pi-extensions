import { assert, test } from "./harness.ts";
import {
  compilePolicy,
  configuredAccess,
  effectiveAccess,
  inspectPathKind,
  normalizeConfiguredPath,
  normalizePath,
  resolveExistingPath,
  type PathEntryKind,
  type PathResolver,
} from "../policy.ts";
import type { CompiledFilesystemPolicy } from "../types.ts";

const context = { cwd: "/work/project", home: "/home/tester" };
const policy = (rules: Record<string, "none" | "read" | "write">) =>
  rules as unknown as CompiledFilesystemPolicy;

function resolver(entries: Record<string, PathEntryKind | { target: string }>): PathResolver {
  return {
    lstat(path) {
      const entry = entries[path];
      if (!entry) return undefined;
      return typeof entry === "string" ? entry : "symlink";
    },
    readlink(path) {
      const entry = entries[path];
      if (!entry || typeof entry === "string") throw new Error(`not a link: ${path}`);
      return entry.target;
    },
  };
}

test("path normalization is deterministic", () => {
  assert.equal(normalizePath("../shared/./file", context), "/work/shared/file");
  assert.equal(normalizePath("~/notes", context), "/home/tester/notes");
  assert.equal(normalizePath("@./src/index.ts", context), "/work/project/src/index.ts");
  assert.equal(normalizeConfiguredPath(":project/.pi/../src", context), "/work/project/src");
});

test("mount-source inspection maps files, directories, and ENOENT only", () => {
  const stat = (directory: boolean) => ({
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  });
  assert.equal(inspectPathKind("/directory", () => stat(true)), "directory");
  assert.equal(inspectPathKind("/file", () => stat(false)), "file");
  assert.equal(inspectPathKind("/missing", () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }), "missing");
});

test("mount-source inspection propagates every non-ENOENT error", () => {
  for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
    const error = Object.assign(new Error(code), { code });
    assert.throws(
      () => inspectPathKind("/protected", () => { throw error; }),
      (caught) => caught === error,
    );
  }
});

test("resolution preserves a missing suffix below its existing target ancestor", () => {
  const paths = resolver({ "/alias": { target: "/real/target" }, "/real": "directory", "/real/target": "directory" });
  assert.equal(resolveExistingPath("/alias/new/file", context, paths), "/real/target/new/file");
});

test("dangling final symlinks resolve into denied targets", () => {
  const paths = resolver({
    "/work": "directory",
    "/work/project": "directory",
    "/work/project/link": { target: "/denied/missing" },
    "/denied": "directory",
  });
  const path = resolveExistingPath("link", context, paths);
  assert.equal(path, "/denied/missing");
  assert.equal(effectiveAccess(path, policy({ "/denied": "none" })), "none");
});

test("dangling intermediate symlinks resolve the remaining suffix into denied targets", () => {
  const paths = resolver({
    "/work": "directory",
    "/work/project": "directory",
    "/work/project/link": { target: "../denied/missing" },
    "/work/denied": "directory",
  });
  const path = resolveExistingPath("link/child/file", context, paths);
  assert.equal(path, "/work/denied/missing/child/file");
  assert.equal(effectiveAccess(path, policy({ "/work/denied": "none" })), "none");
});

test("symlink loops fail closed", () => {
  const paths = resolver({ "/a": { target: "/b" }, "/b": { target: "/a" } });
  assert.throws(() => resolveExistingPath("/a/file", context, paths), /symlink loop/);
});

test("compiled policy resolves aliases deterministically", () => {
  const paths: PathResolver = { lstat: () => "directory", readlink: () => { throw new Error("unexpected"); } };
  const result = compilePolicy({ "~/z": "read", ":project/a": "write" }, context, paths);
  assert.deepEqual(result, { "/home/tester/z": "read", "/work/project/a": "write" });
});

test("more-specific configured paths override broader paths", () => {
  const compiled = policy({
    "/work": "read",
    "/work/project": "write",
    "/work/project/.env": "none",
    "/work/project/.env.example": "read",
  });
  assert.equal(configuredAccess("/work/other", compiled), "read");
  assert.equal(configuredAccess("/work/project/src", compiled), "write");
  assert.equal(configuredAccess("/work/project/.env", compiled), "none");
  assert.equal(configuredAccess("/work/project/.env.example", compiled), "read");
});

test("none is checked before broad grants and cannot be widened", () => {
  const compiled = policy({ "/secrets": "none" });
  assert.equal(effectiveAccess("/secrets/key", compiled, ["/"]), "none");
});

test("write grants widen read/default access", () => {
  const compiled = policy({ "/readonly": "read" });
  assert.equal(effectiveAccess("/readonly/file", compiled, ["/readonly"]), "write");
  assert.equal(effectiveAccess("/other", compiled, ["/"]), "write");
});

test("write implies read", () => {
  assert.equal(effectiveAccess("/output", policy({ "/output": "write" })), "write");
  assert.equal(effectiveAccess("/input", policy({ "/input": "read" })), "read");
});
