import { basename, extname, relative, sep } from "node:path";
import { inspectPathKind } from "./policy.ts";
import type { PathKind } from "./types.ts";

export type SecretCheckedTool = "read" | "grep" | "write" | "edit";

export interface DirectAccessMetadata {
  readonly evidenceType: "direct-file-access";
  readonly pathPolicyPassed: true;
  readonly tool: SecretCheckedTool;
  readonly operation: "read" | "write";
  readonly target: {
    readonly scope: "project" | "outside-project";
    readonly path?: string;
    readonly basename: string;
    readonly extension: string;
    readonly kind: PathKind;
    readonly knownSecretPath: boolean;
  };
  readonly request: {
    readonly offset?: number;
    readonly limit?: number;
    readonly payloadBytes?: number;
    readonly payloadScanComplete?: boolean;
    readonly potentialSecretPayload?: boolean;
    readonly secretSeekingQuery?: boolean;
  };
}

export interface DirectAccessAssessment {
  readonly metadata: DirectAccessMetadata;
  readonly reviewReasons: readonly string[];
}

const SECRET_CHECKED_TOOLS = new Set<SecretCheckedTool>(["read", "grep", "write", "edit"]);
const TEMPLATE_SUFFIX = /(?:^|[._-])(example|sample|template|defaults?|dist)$/i;
const SECRET_PATHS: readonly RegExp[] = [
  /(^|\/)\.env(?:\.[^/]+)?$/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(key|p12|pfx|jks|keystore|pkcs12|pkcs8|kdbx))$/i,
  /(^|\/)(private[-_][^/]*|[^/]+[-_]private)\.pem$/i,
  /(^|\/)(\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i,
  /(^|\/)\.gem\/credentials$/i,
  /(^|\/)\.cargo\/credentials(?:\.toml)?$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.config\/(?:gh|hub)\/hosts\.ya?ml$/i,
  /(^|\/)\.config\/(?:composer|containers)\/auth\.json$/i,
  /(^|\/)\.config\/rclone\/rclone\.conf$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.oci\/config$/i,
  /(^|\/)\.kube\/config$/i,
  /(^|\/)(?:kubeconfig|[^/]+\.kubeconfig)$/i,
  /(^|\/)\.azure\/(?:accessTokens|azureProfile)\.json$/i,
  /(^|\/)\.config\/gcloud\/(?:application_default_credentials\.json|credentials\.db|access_tokens\.db)$/i,
  /(^|\/)(service[-_]?account|gcp[-_]?key)[^/]*\.json$/i,
  /(^|\/)\.git\/config$/i,
  /(^|\/)[^/]+\.tfstate(?:\.backup)?$/i,
  /(^|\/)(terraform\.tfvars(?:\.json)?|[^/]+\.auto\.tfvars(?:\.json)?)$/i,
  /(^|\/)(secrets?|[^/]+[-_]secret)\.(yaml|yml|json|toml)$/i,
  /(^|\/)(vault[-_]?password|\.vault)$/i,
];
const SECRET_TEXT = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?(?!example|sample|placeholder|changeme|test)[^\s"']{8,}/i,
] as const;
const SECRET_QUERY = /(^|[^a-z])(secrets?|passwords?|passwds?|tokens?|api[_ -]?keys?|credentials?|private[_ -]?keys?)([^a-z]|$)/i;
const PAYLOAD_SCAN_CHARACTERS = 64 * 1024;

function projectRelative(path: string, projectCwd: string): string | undefined {
  const value = relative(projectCwd, path);
  if (value === "") return ".";
  if (value === ".." || value.startsWith(`..${sep}`)) return undefined;
  return value.split(sep).join("/");
}

export function isSecretCheckedTool(toolName: string): toolName is SecretCheckedTool {
  return SECRET_CHECKED_TOOLS.has(toolName as SecretCheckedTool);
}

export function isKnownSecretPath(path: string): boolean {
  const normalized = path.split(sep).join("/");
  if (TEMPLATE_SUFFIX.test(basename(normalized))) return false;
  return SECRET_PATHS.some((pattern) => pattern.test(normalized));
}

function stringField(input: unknown, name: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function numberField(input: unknown, name: string): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function editPayload(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const legacy = [stringField(input, "oldText"), stringField(input, "newText")];
  const edits = Array.isArray(record.edits)
    ? record.edits.flatMap((edit) => [stringField(edit, "oldText"), stringField(edit, "newText")])
    : [];
  return [...legacy, ...edits].filter((value): value is string => value !== undefined).join("\n");
}

function payload(toolName: SecretCheckedTool, input: unknown): string {
  if (toolName === "write") return stringField(input, "content") ?? "";
  if (toolName === "edit") return editPayload(input);
  return "";
}

export function buildDirectAccessAssessment(
  toolName: SecretCheckedTool,
  input: unknown,
  resolvedPath: string,
  projectCwd: string,
  inspect: (path: string) => PathKind = inspectPathKind,
): DirectAccessAssessment {
  const relativePath = projectRelative(resolvedPath, projectCwd);
  const knownSecretPath = isKnownSecretPath(relativePath ?? resolvedPath);
  const text = payload(toolName, input);
  const payloadBytes = Buffer.byteLength(text, "utf8");
  const payloadScanComplete = text.length <= PAYLOAD_SCAN_CHARACTERS;
  const scanText = payloadScanComplete
    ? text
    : `${text.slice(0, PAYLOAD_SCAN_CHARACTERS / 2)}\n[unscanned payload content]\n${text.slice(-PAYLOAD_SCAN_CHARACTERS / 2)}`;
  const potentialSecretPayload = scanText.length > 0 && SECRET_TEXT.some((pattern) => pattern.test(scanText));
  const query = toolName === "grep" ? stringField(input, "pattern") ?? stringField(input, "query") ?? "" : "";
  const secretSeekingQuery = query.length > 0 && SECRET_QUERY.test(query);
  const kind = inspect(resolvedPath);
  const request = {
    ...(toolName === "read" && numberField(input, "offset") !== undefined
      ? { offset: numberField(input, "offset") }
      : {}),
    ...(toolName === "read" && numberField(input, "limit") !== undefined
      ? { limit: numberField(input, "limit") }
      : {}),
    ...(toolName === "write" || toolName === "edit"
      ? { payloadBytes, payloadScanComplete, potentialSecretPayload }
      : {}),
    ...(toolName === "grep" ? { secretSeekingQuery } : {}),
  };
  const metadata: DirectAccessMetadata = {
    evidenceType: "direct-file-access",
    pathPolicyPassed: true,
    tool: toolName,
    operation: toolName === "read" || toolName === "grep" ? "read" : "write",
    target: {
      scope: relativePath === undefined ? "outside-project" : "project",
      ...(relativePath === undefined ? {} : { path: relativePath }),
      basename: basename(resolvedPath),
      extension: extname(resolvedPath),
      kind,
      knownSecretPath,
    },
    request,
  };
  const reviewReasons = [
    ...(knownSecretPath ? ["The target matches a known credential or secret path."] : []),
    ...(secretSeekingQuery
      ? ["The grep pattern, not the target files, contains a high-confidence secret-search term such as password, token, credential, API key, or private key. This check did not scan file content."]
      : []),
    ...(potentialSecretPayload ? ["The write payload contains a potential credential or secret."] : []),
    ...(toolName === "write" || toolName === "edit") && !payloadScanComplete
      ? ["The write payload is too large for a complete local secret scan."]
      : [],
  ];
  return { metadata, reviewReasons };
}
