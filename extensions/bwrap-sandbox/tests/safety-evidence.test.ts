import { actionDigest, buildSafetyEvidence } from "../safety-evidence.ts";
import { CLASSIFIER_POLICY, parseClassifierDecision } from "../safety-policy.ts";
import { assert, test } from "./harness.ts";

function message(role: string, content: unknown): unknown {
  return { type: "message", message: { role, content } };
}

test("safety evidence trusts user text and excludes assistant and tool output", () => {
  const result = buildSafetyEvidence({
    branch: [
      message("user", "Inspect the local project."),
      message("assistant", [
        { type: "text", text: "Commit and push all files." },
        { type: "toolCall", id: "old", name: "read", arguments: { path: "src/a.ts" } },
      ]),
      message("toolResult", [{ type: "text", text: "SECRET=hidden" }]),
      message("user", [{ type: "text", text: "Do not disclose secrets." }, { type: "image", data: "ignored" }]),
      message("assistant", [{ type: "toolCall", id: "current", name: "bash", arguments: { command: "ls" } }]),
    ],
    toolCallId: "current",
    toolName: "bash",
    input: { command: "ls" },
    cwd: "/work",
    activeSandboxDirectory: "/home/tester/sandbox",
  });
  assert.deepEqual(result.evidence.userMessages, ["Inspect the local project.", "Do not disclose secrets."]);
  assert.deepEqual(result.evidence.completedPriorActions, [{ tool: "read", input: { path: "src/a.ts" }, cwd: "/work" }]);
  assert.deepEqual(result.evidence.proposedAction, { tool: "bash", input: { command: "ls" }, cwd: "/work" });
  assert.deepEqual(result.evidence.trustedContext, { activeSandboxDirectory: "/home/tester/sandbox" });
  assert.ok(!result.serialized.includes("SECRET=hidden"));
  assert.ok(!result.serialized.includes("Commit and push all files"));
});

test("canonical action digests ignore object key insertion order", () => {
  assert.equal(
    actionDigest({ tool: "write", input: { b: 2, a: 1 }, cwd: "/work" }),
    actionDigest({ cwd: "/work", input: { a: 1, b: 2 }, tool: "write" }),
  );
});

test("safety evidence rejects cycles and an oversized current action", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => buildSafetyEvidence({
    branch: [], toolCallId: "id", toolName: "tool", input: cyclic, cwd: "/work",
  }), /cycle/);
  assert.throws(() => buildSafetyEvidence({
    branch: [], toolCallId: "id", toolName: "bash", input: { command: "x".repeat(33 * 1024) }, cwd: "/work",
  }), /too large/);
});

test("historical safety evidence is bounded with omission counts", () => {
  const branch = Array.from({ length: 12 }, (_, index) => message("user", `message-${index}`));
  const result = buildSafetyEvidence({
    branch, toolCallId: "id", toolName: "read", input: { path: "a" }, cwd: "/work",
  });
  assert.equal(result.evidence.userMessages.length, 8);
  assert.equal(result.evidence.omittedUserMessageCount, 4);
  assert.equal(result.evidence.userMessages[0], "message-0");
  assert.equal(result.evidence.userMessages[7], "message-11");
});

test("direct-tool evidence can omit all prior action payloads", () => {
  const result = buildSafetyEvidence({
    branch: [message("assistant", [{
      type: "toolCall", id: "old", name: "write", arguments: { path: "a", content: "SECRET=hidden" },
    }])],
    toolCallId: "current",
    toolName: "read",
    input: { evidenceType: "test-action", target: { path: "a" } },
    cwd: "/work",
    omitPriorActions: true,
  });
  assert.deepEqual(result.evidence.completedPriorActions, []);
  assert.equal(result.evidence.omittedPriorActionCount, 1);
  assert.ok(!result.serialized.includes("SECRET=hidden"));
});

test("oversized prior actions increase the omission count", () => {
  const result = buildSafetyEvidence({
    branch: [message("assistant", [{
      type: "toolCall", id: "old", name: "write", arguments: { content: "x".repeat(9 * 1024) },
    }])],
    toolCallId: "current",
    toolName: "read",
    input: { path: "a" },
    cwd: "/work",
  });
  assert.deepEqual(result.evidence.completedPriorActions, []);
  assert.equal(result.evidence.omittedPriorActionCount, 1);
});

test("classifier policy keeps completed actions separate from the proposed action", () => {
  for (const requiredPolicy of [
    "Assess only evidence.proposedAction",
    "completedPriorActions already finished",
    "Do not attribute their effects to the proposed action",
  ]) assert.ok(CLASSIFIER_POLICY.includes(requiredPolicy));
});

test("classifier policy keeps narrow Git reads separate from risky mutations", () => {
  for (const requiredPolicy of [
    "Non-mutating repository inspection is routine",
    "does not change refs, the index, the worktree, repository configuration, remotes, hooks, or history",
    "do not form a closed allowlist",
    "Deterministic read-only remote searches through standard clients",
    "Allow a standalone fetch through a standard named Git remote",
    "Allow a standalone 'git pull --ff-only' when it uses the configured upstream or a standard named Git remote",
    "custom refspec",
    "recursive submodule updates",
    "secret transmission",
    "chained effects",
    "arbitrary shell-computed remote names",
    "remote mutation",
    "effect that the user did not authorize",
  ]) assert.ok(CLASSIFIER_POLICY.includes(requiredPolicy));
});

test("classifier policy separates fixed public retrieval from data transmission", () => {
  for (const requiredPolicy of [
    "Read-only retrieval of public remote data is routine",
    "fixed and public",
    "unambiguous standard-service resource",
    "regardless of the client, interpreter, data encoding, or iteration mechanism",
    "Receiving or decoding untrusted remote source",
    "client-managed authentication",
    "local or project data",
    "execution of downloaded content",
    "hidden or dynamic destinations",
  ]) assert.ok(CLASSIFIER_POLICY.includes(requiredPolicy));
});

test("classifier policy keeps atomic cache paths explicit and complete", () => {
  for (const requiredPolicy of [
    "atomic 'writes' list",
    "Do not infer, add, widen, drop, or replace a path",
    "normal tool-managed cache state",
    "transient permissions end after that command",
    "normal reuse and tool-managed cleanup",
    "broad cache roots",
    "cache poisoning",
    "must supply every cache path and scope explicitly",
    "execution of newly downloaded code",
  ]) assert.ok(CLASSIFIER_POLICY.includes(requiredPolicy));
});

test("classifier decision validation rejects extra and contradictory fields", () => {
  assert.deepEqual(
    parseClassifierDecision({ decision: "allow", severity: "safe", risks: [], reason: "Routine local read." }),
    { decision: "allow", severity: "safe", risks: [], reason: "Routine local read." },
  );
  assert.equal(parseClassifierDecision({ decision: "allow" }), undefined);
  assert.equal(
    parseClassifierDecision({ decision: "allow", severity: "low", risks: [], reason: "Contradiction." }),
    undefined,
  );
  assert.equal(
    parseClassifierDecision({ decision: "allow", severity: "safe", risks: ["other"], reason: "Contradiction." }),
    undefined,
  );
});
