import { assert, test } from "./harness.ts";
import {
  DEFAULT_CONFIG,
  defaultPolicyForProjectGitEntry,
  mergeConfig,
  parseConfigObject,
} from "../config.ts";

test("valid structured configuration is parsed", () => {
  assert.deepEqual(
    parseConfigObject({
      enabled: true,
      isolateNetwork: true,
      sshAgent: false,
      filesystem: { "/data": "read", "/data/out": "write", "/data/key": "none" },
    }),
    {
      enabled: true,
      isolateNetwork: true,
      sshAgent: false,
      filesystem: { "/data": "read", "/data/out": "write", "/data/key": "none" },
    },
  );
});

test("unsupported historical fields fail through the strict unknown-field rule", () => {
  for (const key of ["extraWritePaths", "autoApproveCommands", "allowNetwork"]) {
    assert.throws(() => parseConfigObject({ [key]: [] }, "test.json"), /unsupported field/);
  }
});

test("unknown and malformed security fields fail closed", () => {
  assert.throws(() => parseConfigObject({ filesystem: [] }), /filesystem must be an object/);
  assert.throws(() => parseConfigObject({ filesystem: { "/data": "allow" } }), /none, read, or write/);
  assert.throws(() => parseConfigObject({ isolateNetwork: "yes" }), /must be boolean/);
  assert.throws(() => parseConfigObject({ blockUnknown: true }), /unsupported field/);
});

test("project configuration cannot set or re-enable the global SSH capability", () => {
  for (const value of [true, false]) {
    assert.throws(
      () => parseConfigObject({ sshAgent: value }, "project.json", "project"),
      /global-only credential capability/,
    );
  }
  assert.deepEqual(
    parseConfigObject({ enabled: false, isolateNetwork: true, filesystem: { "/project": "read" } }, "project.json", "project"),
    { enabled: false, isolateNetwork: true, filesystem: { "/project": "read" } },
  );
});

test("configuration layers merge filesystem entries and scalar overrides", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    isolateNetwork: true,
    filesystem: { ":project": "read", "/srv/output": "write" },
  });
  assert.equal(merged.isolateNetwork, true);
  assert.equal(merged.filesystem[":project"], "read");
  assert.equal(merged.filesystem["/srv/output"], "write");
  assert.equal(merged.filesystem["/tmp"], "read");
});

test("project defaults protect only an existing git entry without descendant assumptions", () => {
  const withGitFile = defaultPolicyForProjectGitEntry(true);
  assert.equal(withGitFile.filesystem[":project"], "write");
  assert.equal(withGitFile.filesystem[":project/.git"], "read");
  assert.deepEqual(
    Object.keys(withGitFile.filesystem).filter((path) => path.startsWith(":project/.git/")),
    [],
  );
  assert.equal(defaultPolicyForProjectGitEntry(false).filesystem[":project/.git"], undefined);
});

test("compatibility defaults keep host tmp read-only and SSH agent enabled", () => {
  assert.equal(DEFAULT_CONFIG.filesystem["/tmp"], "read");
  assert.equal(DEFAULT_CONFIG.sshAgent, true);
  assert.equal(DEFAULT_CONFIG.isolateNetwork, false);
});
