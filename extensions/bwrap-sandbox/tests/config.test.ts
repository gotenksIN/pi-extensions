import { assert, test } from "./harness.ts";
import {
  DEFAULT_CLASSIFIER_CONFIG,
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

test("classifier defaults use Google before the OpenAI pair", () => {
  assert.deepEqual(DEFAULT_CLASSIFIER_CONFIG.pairs, [
    {
      provider: "google",
      stage1: { model: "gemini-3.5-flash-lite", reasoning: "minimal" },
      stage2: { model: "gemini-3.6-flash", reasoning: "low" },
    },
    {
      provider: "openai",
      stage1: { model: "gpt-5.4-nano", reasoning: "none" },
      stage2: { model: "gpt-5.4-mini", reasoning: "low" },
    },
  ]);
});

test("global configuration accepts complete custom classifier pairs", () => {
  const parsed = parseConfigObject({
    classifier: {
      enabled: true,
      stage1TimeoutMs: 5_000,
      stage2TimeoutMs: 8_000,
      maxRetries: 0,
      pairs: [{
        provider: "local",
        stage1: { model: "fast", reasoning: "off" },
        stage2: { model: "strong", reasoning: "high" },
      }],
    },
  });
  assert.deepEqual(parsed.classifier, {
    enabled: true,
    stage1TimeoutMs: 5_000,
    stage2TimeoutMs: 8_000,
    maxRetries: 0,
    pairs: [{
      provider: "local",
      stage1: { model: "fast", reasoning: "off" },
      stage2: { model: "strong", reasoning: "high" },
    }],
  });
});

test("classifier configuration is strict and global-only", () => {
  assert.throws(
    () => parseConfigObject({ classifier: { enabled: true } }, "project.json", "project"),
    /global-only security setting/,
  );
  assert.throws(() => parseConfigObject({ classifier: { extra: true } }), /unsupported classifier field/);
  assert.throws(() => parseConfigObject({ classifier: { pairs: [] } }), /non-empty array/);
  assert.throws(
    () => parseConfigObject({ classifier: { pairs: [{ provider: "p", stage1: {}, stage2: {} }] } }),
    /stage1.model/,
  );
  assert.throws(() => parseConfigObject({ classifier: { stage1TimeoutMs: 999 } }), /1000 through 120000/);
  assert.throws(() => parseConfigObject({ classifier: { maxRetries: 3 } }), /integer from 0 through 2/);
});

test("configuration layers merge classifier scalar settings", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { classifier: { enabled: false, maxRetries: 0 } });
  assert.equal(merged.classifier.enabled, false);
  assert.equal(merged.classifier.maxRetries, 0);
  assert.equal(merged.classifier.stage1TimeoutMs, 20_000);
  assert.deepEqual(merged.classifier.pairs, DEFAULT_CLASSIFIER_CONFIG.pairs);
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

test("compatibility defaults keep the workspace writable, host tmp read-only, and SSH agent enabled", () => {
  assert.equal(DEFAULT_CONFIG.filesystem["~/sandbox"], "write");
  assert.equal(DEFAULT_CONFIG.filesystem["/tmp"], "read");
  assert.equal(DEFAULT_CONFIG.sshAgent, true);
  assert.equal(DEFAULT_CONFIG.isolateNetwork, false);
});
