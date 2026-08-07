import {
  addApprovedGrant,
  emptyApprovedGrants,
  validateDirectWrite,
  validateOneShotGrantRequest,
  validatePersistentGrant,
  validatePersistentGrantRequest,
  type GrantContext,
} from "../grants.ts";
import type { PathResolver } from "../policy.ts";
import type { CompiledFilesystemPolicy, PathKind } from "../types.ts";
import { assert, test } from "./harness.ts";

const compiled = (rules: Record<string, "none" | "read" | "write">) =>
  rules as unknown as CompiledFilesystemPolicy;

function context(
  rules: Record<string, "none" | "read" | "write"> = {},
  inspect: (path: string) => PathKind = () => "directory",
): GrantContext {
  return {
    cwd: "/work",
    home: "/home/tester",
    policy: compiled(rules),
    protectedPaths: {
      bwrapExecutable: "/usr/bin/bwrap",
      hostTempParent: "/tmp",
      resourceRoot: "/tmp/pi-bwrap-resources",
      sshClientConfigDestination: "/etc/ssh/ssh_config",
    },
    inspect,
  };
}

const existing: PathResolver = { lstat: () => "directory", readlink: () => { throw new Error("unexpected"); } };
const missingTarget: PathResolver = {
  lstat(path) { return path === "/work" ? "directory" : undefined; },
  readlink() { throw new Error("unexpected"); },
};

test("persistent grants are canonical, immutable, and widen effective writes", () => {
  const original = emptyApprovedGrants();
  const next = addApprovedGrant(original, "./output", context(), existing);
  assert.deepEqual(original.paths, []);
  assert.notEqual(next, original);
  assert.deepEqual(next.paths, ["/work/output"]);
  assert.equal(validatePersistentGrant("/work/output/file", context(), next, existing).alreadyWritable, true);
});

test("single-use direct writes allow a missing target without creating a bind grant", () => {
  const grants = emptyApprovedGrants();
  const admission = validateDirectWrite("new-file", context({}, () => "missing"), grants, missingTarget);
  assert.equal(admission.path, "/work/new-file");
  assert.equal(admission.alreadyWritable, false);
  assert.deepEqual(grants.paths, []);
});

test("hard none rejects persistent and direct write admission", () => {
  const denied = context({ "/work/secret": "none" });
  assert.throws(() => validatePersistentGrant("/work/secret", denied, emptyApprovedGrants(), existing), /permanently denies/);
  assert.throws(() => validateDirectWrite("/work/secret", denied, emptyApprovedGrants(), existing), /permanently denies/);
});

test("protected runtime paths reject persistent grants and single-use direct writes", () => {
  const grants = emptyApprovedGrants();
  assert.throws(() => validatePersistentGrant("/usr", context(), grants, existing), /Bubblewrap executable/);
  assert.throws(() => validatePersistentGrant("/tmp", context(), grants, existing), /temporary directory/);
  assert.throws(() => validateDirectWrite("/usr/bin/bwrap", context(), grants, existing), /Bubblewrap executable/);
  assert.throws(() => validateDirectWrite("/proc/new", context(), grants, missingTarget), /fresh \/dev or \/proc/);
  assert.throws(
    () => validatePersistentGrant("/tmp/pi-bwrap-resources", context(), grants, existing),
    /trusted runtime resources/,
  );
  assert.throws(
    () => validatePersistentGrant("/etc/ssh", context(), grants, existing),
    /fixed SSH client configuration/,
  );
});

test("parent scope grants the existing parent of a missing target", () => {
  const admission = validatePersistentGrantRequest(
    "new-file",
    "parent",
    context(),
    emptyApprovedGrants(),
    missingTarget,
  );
  assert.deepEqual(admission, { path: "/work", alreadyWritable: false });
  assert.throws(
    () => validatePersistentGrantRequest(
      "new-file",
      "exact",
      context({}, () => "missing"),
      emptyApprovedGrants(),
      missingTarget,
    ),
    /existing mount source/,
  );
});

test("parent scope remains subject to none and protected-path rules", () => {
  assert.throws(
    () => validatePersistentGrantRequest(
      "/work/secret/new-file",
      "parent",
      context({ "/work/secret": "none" }),
      emptyApprovedGrants(),
      existing,
    ),
    /permanently denies/,
  );
  assert.throws(
    () => validatePersistentGrantRequest(
      "/usr/bin/bwrap",
      "parent",
      context(),
      emptyApprovedGrants(),
      existing,
    ),
    /Bubblewrap executable/,
  );
});

test("persistent grants reject missing Bubblewrap bind sources", () => {
  assert.throws(
    () => validatePersistentGrant("new-file", context({}, () => "missing"), emptyApprovedGrants(), missingTarget),
    /existing mount source/,
  );
});

test("one-shot exact and parent paths use persistent grant validation", () => {
  const grants = emptyApprovedGrants();
  assert.deepEqual(
    validateOneShotGrantRequest("/work/.git", "exact", context(), grants, existing),
    { path: "/work/.git", alreadyWritable: false },
  );
  assert.deepEqual(
    validateOneShotGrantRequest("/work/new-file", "parent", context(), grants, missingTarget),
    { path: "/work", alreadyWritable: false },
  );
  assert.deepEqual(
    validateOneShotGrantRequest(
      "/scratch/cache/new-entry",
      "parent",
      context({ "/scratch/cache": "write" }),
      grants,
      existing,
    ),
    { path: "/scratch/cache", alreadyWritable: true },
  );
  assert.throws(
    () => validateOneShotGrantRequest(
      "/work/new-file",
      "exact",
      context({ "/work": "write" }, () => "missing"),
      grants,
      missingTarget,
    ),
    /existing mount source/,
  );
  assert.throws(
    () => validateOneShotGrantRequest(
      "/work/secret",
      "exact",
      context({ "/work/secret": "none" }),
      grants,
      existing,
    ),
    /permanently denies/,
  );
});
