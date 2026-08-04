import {
  buildDirectAccessAssessment,
  isKnownSecretPath,
  isSecretCheckedTool,
} from "../direct-secret-evidence.ts";
import { assert, test } from "./harness.ts";

const file = () => "file" as const;
const directory = () => "directory" as const;

test("secret checks cover content-reading and content-writing direct tools", () => {
  for (const tool of ["read", "grep", "write", "edit"]) assert.equal(isSecretCheckedTool(tool), true);
  for (const tool of ["find", "ls", "bash", "sandbox_access"]) assert.equal(isSecretCheckedTool(tool), false);
});

test("secret path rules identify credentials and exempt explicit templates", () => {
  for (const path of [
    "/work/.env",
    "/work/.env.production.local",
    "/work/.envrc",
    "/work/id_ed25519",
    "/work/deploy-private.pem",
    "/work/.npmrc",
    "/work/.git-credentials",
    "/work/.cargo/credentials.toml",
    "/work/.config/gh/hosts.yml",
    "/work/.config/rclone/rclone.conf",
    "/work/.aws/credentials",
    "/work/.kube/config",
    "/work/prod.kubeconfig",
    "/work/.azure/accessTokens.json",
    "/work/.config/gcloud/credentials.db",
    "/work/terraform.tfstate",
    "/work/prod.auto.tfvars.json",
    "/work/deploy-secret.yaml",
    "/work/secrets.toml",
  ]) assert.equal(isKnownSecretPath(path), true);
  for (const path of [
    "/work/.env.example",
    "/work/.env.template",
    "/work/config.json",
    "/work/cert.pem",
    "/work/src/index.ts",
  ]) assert.equal(isKnownSecretPath(path), false);
});

test("ordinary source reads pass deterministic direct safety checks", () => {
  for (const path of [
    "/work/src/index.ts",
    "/work/app/migrations/alembic/versions/c1e39e7504e1.py",
  ]) {
    const assessment = buildDirectAccessAssessment("read", { path }, path, "/work", file);
    assert.deepEqual(assessment.reviewReasons, []);
    assert.equal(assessment.metadata.target.knownSecretPath, false);
  }
});

test("direct safety checks require review for secret paths, queries, and payloads", () => {
  const secretRead = buildDirectAccessAssessment("read", { path: "/work/.env" }, "/work/.env", "/work", file);
  assert.equal(secretRead.metadata.target.knownSecretPath, true);
  assert.ok(secretRead.reviewReasons.length > 0);

  for (const pattern of ["password", "credentials", "API keys", "private keys"]) {
    const grep = buildDirectAccessAssessment(
      "grep",
      { path: "/work", pattern },
      "/work",
      "/work",
      directory,
    );
    assert.equal(grep.metadata.request.secretSeekingQuery, true);
    assert.ok(grep.reviewReasons.length > 0);
  }

  const write = buildDirectAccessAssessment(
    "write",
    { path: "/work/config.ts", content: "github_pat_abcdefghijklmnopqrstuvwxyz123456" },
    "/work/config.ts",
    "/work",
    file,
  );
  assert.equal(write.metadata.request.potentialSecretPayload, true);
  assert.ok(write.reviewReasons.length > 0);
});

test("direct metadata omits grep queries and write content", () => {
  const grep = buildDirectAccessAssessment(
    "grep",
    { path: "/work", pattern: "password" },
    "/work",
    "/work",
    directory,
  );
  const grepJson = JSON.stringify(grep.metadata);
  assert.ok(!grepJson.includes("password"));
  assert.equal(grep.metadata.request.secretSeekingQuery, true);

  const secret = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
  const write = buildDirectAccessAssessment(
    "write",
    { path: "/work/src/config.ts", content: secret },
    "/work/src/config.ts",
    "/work",
    file,
  );
  const writeJson = JSON.stringify(write.metadata);
  assert.ok(!writeJson.includes(secret));
  assert.ok(!writeJson.includes("content"));
  assert.equal(write.metadata.request.payloadBytes, Buffer.byteLength(secret));
  assert.equal(write.metadata.request.payloadScanComplete, true);
  assert.equal(write.metadata.request.potentialSecretPayload, true);
});

test("edit checks scan every payload shape without exposing replacement text", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const inputs = [
    { edits: [{ oldText: "before", newText: secret }] },
    { edits: [{ oldText: "first", newText: "clean" }, { oldText: "later", newText: secret }] },
    { oldText: "before", newText: secret },
  ];

  for (const input of inputs) {
    const assessment = buildDirectAccessAssessment(
      "edit",
      { path: "/work/src/a.ts", ...input },
      "/work/src/a.ts",
      "/work",
      file,
    );
    assert.equal(assessment.metadata.request.potentialSecretPayload, true);
    assert.ok(assessment.reviewReasons.length > 0);
    assert.ok(!JSON.stringify(assessment.metadata).includes(secret));
  }

  const clean = buildDirectAccessAssessment(
    "edit",
    { path: "/work/src/a.ts", edits: [{ oldText: "before", newText: "after" }] },
    "/work/src/a.ts",
    "/work",
    file,
  );
  assert.equal(clean.metadata.request.potentialSecretPayload, false);
  assert.deepEqual(clean.reviewReasons, []);
});

test("large direct writes require review after an incomplete bounded scan", () => {
  const marker = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
  const content = `${marker}${"x".repeat(70 * 1024)}${marker}`;
  const assessment = buildDirectAccessAssessment(
    "write",
    { path: "/work/a.txt", content },
    "/work/a.txt",
    "/work",
    file,
  );
  const serialized = JSON.stringify(assessment.metadata);
  assert.equal(assessment.metadata.request.payloadScanComplete, false);
  assert.equal(assessment.metadata.request.potentialSecretPayload, true);
  assert.equal(assessment.reviewReasons.length, 2);
  assert.ok(!serialized.includes(marker));
  assert.ok(!serialized.includes(content));
});

test("direct metadata keeps useful ranges without exposing host paths", () => {
  const inside = buildDirectAccessAssessment(
    "read",
    { path: "/work/src/a.ts", offset: 2, limit: 5 },
    "/work/src/a.ts",
    "/work",
    file,
  );
  assert.equal(inside.metadata.target.scope, "project");
  assert.equal(inside.metadata.target.path, "src/a.ts");
  assert.equal(inside.metadata.request.offset, 2);
  assert.equal(inside.metadata.request.limit, 5);

  const outside = buildDirectAccessAssessment(
    "read",
    { path: "/home/tester/private.txt" },
    "/home/tester/private.txt",
    "/work",
    file,
  );
  assert.equal(outside.metadata.target.scope, "outside-project");
  assert.equal(outside.metadata.target.path, undefined);
  assert.ok(!JSON.stringify(outside.metadata).includes("/home/tester"));
});
