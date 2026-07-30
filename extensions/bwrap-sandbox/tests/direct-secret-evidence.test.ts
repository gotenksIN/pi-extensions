import {
  buildDirectSecretAssessment,
  isKnownSecretPath,
  isSecretClassifiedTool,
} from "../direct-secret-evidence.ts";
import { assert, test } from "./harness.ts";

const file = () => "file" as const;
const directory = () => "directory" as const;

test("secret classification covers content-reading and content-writing direct tools", () => {
  for (const tool of ["read", "grep", "write", "edit"]) assert.equal(isSecretClassifiedTool(tool), true);
  for (const tool of ["find", "ls", "bash", "sandbox_access"]) assert.equal(isSecretClassifiedTool(tool), false);
});

test("secret path rules identify credentials and exempt explicit templates", () => {
  for (const path of [
    "/work/.env",
    "/work/.env.production.local",
    "/work/id_ed25519",
    "/work/.npmrc",
    "/work/.aws/credentials",
    "/work/terraform.tfstate",
    "/work/prod.auto.tfvars.json",
    "/work/deploy-secret.yaml",
  ]) assert.equal(isKnownSecretPath(path), true);
  for (const path of [
    "/work/.env.example",
    "/work/.env.template",
    "/work/config.json",
    "/work/cert.pem",
    "/work/src/index.ts",
  ]) assert.equal(isKnownSecretPath(path), false);
});

test("direct evidence omits read queries and write or edit content", () => {
  const grep = buildDirectSecretAssessment(
    "grep",
    { path: "/work", pattern: "password" },
    "/work",
    "/work",
    directory,
  );
  const grepJson = JSON.stringify(grep.evidence);
  assert.ok(!grepJson.includes("password"));
  assert.equal(grep.evidence.request.secretSeekingQuery, true);

  const secret = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
  const write = buildDirectSecretAssessment(
    "write",
    { path: "/work/src/config.ts", content: secret },
    "/work/src/config.ts",
    "/work",
    file,
  );
  const writeJson = JSON.stringify(write.evidence);
  assert.ok(!writeJson.includes(secret));
  assert.ok(!writeJson.includes("content"));
  assert.equal(write.evidence.request.payloadBytes, Buffer.byteLength(secret));
  assert.equal(write.evidence.request.payloadScanComplete, true);
  assert.equal(write.evidence.request.potentialSecretPayload, true);

  const oldText = "PRIVATE=old-value";
  const newText = "PRIVATE=new-value";
  const edit = buildDirectSecretAssessment(
    "edit",
    { path: "/work/src/a.ts", oldText, newText },
    "/work/src/a.ts",
    "/work",
    file,
  );
  const editJson = JSON.stringify(edit.evidence);
  assert.ok(!editJson.includes(oldText));
  assert.ok(!editJson.includes(newText));
});

test("large direct write evidence reports an incomplete bounded local scan", () => {
  const marker = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
  const content = `${marker}${"x".repeat(70 * 1024)}${marker}`;
  const assessment = buildDirectSecretAssessment(
    "write",
    { path: "/work/a.txt", content },
    "/work/a.txt",
    "/work",
    file,
  );
  const serialized = JSON.stringify(assessment.evidence);
  assert.equal(assessment.evidence.request.payloadScanComplete, false);
  assert.equal(assessment.evidence.request.potentialSecretPayload, true);
  assert.ok(!serialized.includes(marker));
  assert.ok(!serialized.includes(content));
});

test("direct evidence sends only project-relative paths", () => {
  const inside = buildDirectSecretAssessment(
    "read",
    { path: "/work/src/a.ts", offset: 2, limit: 5 },
    "/work/src/a.ts",
    "/work",
    file,
  );
  assert.deepEqual(inside.evidence.target, {
    scope: "project",
    path: "src/a.ts",
    basename: "a.ts",
    extension: ".ts",
    kind: "file",
    knownSecretPath: false,
  });
  assert.deepEqual(inside.evidence.request, { offset: 2, limit: 5 });

  const outside = buildDirectSecretAssessment(
    "read",
    { path: "/home/tester/private.txt" },
    "/home/tester/private.txt",
    "/work",
    file,
  );
  assert.equal(outside.evidence.target.scope, "outside-project");
  assert.equal(outside.evidence.target.path, undefined);
  assert.ok(!JSON.stringify(outside.evidence).includes("/home/tester"));
});
