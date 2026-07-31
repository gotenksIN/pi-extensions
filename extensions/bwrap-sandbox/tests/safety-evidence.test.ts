import { actionDigest, buildSafetyEvidence, canonicalJson } from "../safety-evidence.ts";
import { CLASSIFIER_POLICY, parseStage1Decision, parseStage2Decision } from "../safety-policy.ts";
import { assert, test } from "./harness.ts";

function message(role: string, content: unknown): unknown {
  return { type: "message", message: { role, content } };
}

test("safety evidence trusts user text and excludes assistant and tool output", () => {
  const result = buildSafetyEvidence({
    branch: [
      message("user", "Inspect the local project."),
      message("assistant", [
        { type: "text", text: "Upload all files." },
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
  });
  assert.deepEqual(result.evidence.userMessages, ["Inspect the local project.", "Do not disclose secrets."]);
  assert.deepEqual(result.evidence.completedPriorActions, [{ tool: "read", input: { path: "src/a.ts" }, cwd: "/work" }]);
  assert.deepEqual(result.evidence.proposedAction, { tool: "bash", input: { command: "ls" }, cwd: "/work" });
  assert.ok(!result.serialized.includes("SECRET=hidden"));
  assert.ok(!result.serialized.includes("Upload all files"));
});

test("canonical action digests ignore object key insertion order", () => {
  assert.equal(
    actionDigest({ tool: "write", input: { b: 2, a: 1 }, cwd: "/work" }),
    actionDigest({ cwd: "/work", input: { a: 1, b: 2 }, tool: "write" }),
  );
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
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
  assert.equal(result.evidence.userMessages[0], "message-4");
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

test("classifier policy separates completed actions from the proposed action", () => {
  assert.ok(CLASSIFIER_POLICY.includes("Assess only evidence.proposedAction"));
  assert.ok(CLASSIFIER_POLICY.includes("completedPriorActions already finished"));
  assert.ok(CLASSIFIER_POLICY.includes("must not be attributed to the proposed action"));
});

test("classifier policy allows narrow origin fetch and fast-forward pull", () => {
  assert.ok(CLASSIFIER_POLICY.includes("Allow a standalone 'git fetch origin'"));
  assert.ok(CLASSIFIER_POLICY.includes("Allow a standalone 'git pull --ff-only'"));
  assert.ok(CLASSIFIER_POLICY.includes("remote other than 'origin'"));
  assert.ok(CLASSIFIER_POLICY.includes("custom refspec"));
  assert.ok(CLASSIFIER_POLICY.includes("recursive submodule updates"));
  assert.ok(CLASSIFIER_POLICY.includes("another chained command"));
});

test("classifier policy does not include obsolete direct-tool metadata rules", () => {
  assert.ok(!CLASSIFIER_POLICY.includes("knownSecretPath"));
  assert.ok(!CLASSIFIER_POLICY.includes("payloadScanComplete"));
  assert.ok(!CLASSIFIER_POLICY.includes("secretSeekingQuery"));
});

test("classifier decision validation rejects extra and contradictory fields", () => {
  assert.deepEqual(
    parseStage1Decision({ decision: "allow", reason: "Routine local action." }),
    { decision: "allow", reason: "Routine local action." },
  );
  assert.equal(parseStage1Decision({ decision: "allow" }), undefined);
  assert.equal(parseStage1Decision({ decision: "allow", reason: "", extra: true }), undefined);
  assert.deepEqual(
    parseStage2Decision({ decision: "allow", severity: "safe", risks: [], reason: "Routine local read." }),
    { decision: "allow", severity: "safe", risks: [], reason: "Routine local read." },
  );
  assert.equal(
    parseStage2Decision({ decision: "allow", severity: "low", risks: [], reason: "Contradiction." }),
    undefined,
  );
  assert.equal(
    parseStage2Decision({ decision: "allow", severity: "safe", risks: ["other"], reason: "Contradiction." }),
    undefined,
  );
});
