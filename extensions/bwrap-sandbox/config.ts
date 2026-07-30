import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compilePolicy, type PathResolver } from "./policy.ts";
import type {
  ClassifierConfig,
  ClassifierPairConfig,
  ClassifierReasoning,
  FileAccess,
  RawFilesystemRules,
  RawSandboxConfig,
  CompiledSandboxConfig,
} from "./types.ts";

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  enabled: true,
  pairs: [
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
  ],
  stage1TimeoutMs: 20_000,
  stage2TimeoutMs: 30_000,
  maxRetries: 1,
};

export const DEFAULT_CONFIG: RawSandboxConfig = {
  enabled: true,
  isolateNetwork: false,
  sshAgent: true,
  classifier: DEFAULT_CLASSIFIER_CONFIG,
  filesystem: {
    ":project": "write",
    ":project/.git": "read",
    "~/.ssh": "none",
    "~/.ssh/config": "read",
    "~/.ssh/known_hosts": "read",
    "~/.ssh/known_hosts2": "read",
    "~/.ssh/id_ed25519.pub": "read",
    "~/.ssh/id_ecdsa.pub": "read",
    "~/.ssh/id_ecdsa_sk.pub": "read",
    "~/.ssh/id_rsa.pub": "read",
    "~/.ssh/id_dsa.pub": "read",
    "~/.pi": "read",
    "~/sandbox": "write",
    "/tmp": "read",
  },
};

export interface ConfigPaths {
  readonly global: string;
  readonly project: string;
}

export interface RawConfigOverride {
  readonly enabled?: boolean;
  readonly filesystem?: RawFilesystemRules;
  readonly isolateNetwork?: boolean;
  readonly sshAgent?: boolean;
  readonly classifier?: Partial<ClassifierConfig>;
}

/** Decide whether the default policy protects the project's existing .git node. */
export function defaultPolicyForProjectGitEntry(hasGitEntry: boolean): RawSandboxConfig {
  const filesystem: Record<string, FileAccess> = { ...DEFAULT_CONFIG.filesystem };
  if (!hasGitEntry) delete filesystem[":project/.git"];
  return { ...DEFAULT_CONFIG, filesystem };
}

const CONFIG_FIELDS = new Set(["enabled", "filesystem", "isolateNetwork", "sshAgent", "classifier"]);
const CLASSIFIER_FIELDS = new Set(["enabled", "pairs", "stage1TimeoutMs", "stage2TimeoutMs", "maxRetries"]);
const PAIR_FIELDS = new Set(["provider", "stage1", "stage2"]);
const STAGE_FIELDS = new Set(["model", "reasoning"]);
const REASONING_LEVELS = new Set<ClassifierReasoning>([
  "none", "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);
export type ConfigScope = "global" | "project";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceError(source: string, message: string): Error {
  return new Error(`Invalid sandbox configuration in ${source}: ${message}`);
}

export function parseConfigObject(
  value: unknown,
  source = "configuration",
  scope: ConfigScope = "global",
): RawConfigOverride {
  if (!isRecord(value)) throw sourceError(source, "top-level value must be an object");
  for (const key of Object.keys(value)) {
    if (!CONFIG_FIELDS.has(key)) throw sourceError(source, `unsupported field ${JSON.stringify(key)}`);
  }
  if (scope === "project" && Object.prototype.hasOwnProperty.call(value, "sshAgent")) {
    throw sourceError(source, "sshAgent is a global-only credential capability and is not allowed in project configuration");
  }
  if (scope === "project" && Object.prototype.hasOwnProperty.call(value, "classifier")) {
    throw sourceError(source, "classifier is a global-only security setting and is not allowed in project configuration");
  }

  const result: {
    enabled?: boolean;
    filesystem?: RawFilesystemRules;
    isolateNetwork?: boolean;
    sshAgent?: boolean;
    classifier?: Partial<ClassifierConfig>;
  } = {};
  for (const key of ["enabled", "isolateNetwork", "sshAgent"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") throw sourceError(source, `${key} must be boolean`);
    result[key] = value[key];
  }

  if (value.filesystem !== undefined) {
    if (!isRecord(value.filesystem)) throw sourceError(source, "filesystem must be an object");
    const filesystem: Record<string, FileAccess> = {};
    for (const [path, access] of Object.entries(value.filesystem)) {
      if (!path) throw sourceError(source, "filesystem paths must not be empty");
      if (access !== "none" && access !== "read" && access !== "write") {
        throw sourceError(source, `filesystem access for ${JSON.stringify(path)} must be none, read, or write`);
      }
      filesystem[path] = access;
    }
    result.filesystem = filesystem;
  }

  if (value.classifier !== undefined) {
    if (!isRecord(value.classifier)) throw sourceError(source, "classifier must be an object");
    for (const key of Object.keys(value.classifier)) {
      if (!CLASSIFIER_FIELDS.has(key)) throw sourceError(source, `unsupported classifier field ${JSON.stringify(key)}`);
    }
    const classifier: {
      enabled?: boolean;
      pairs?: readonly ClassifierPairConfig[];
      stage1TimeoutMs?: number;
      stage2TimeoutMs?: number;
      maxRetries?: number;
    } = {};
    if (value.classifier.enabled !== undefined) {
      if (typeof value.classifier.enabled !== "boolean") throw sourceError(source, "classifier.enabled must be boolean");
      classifier.enabled = value.classifier.enabled;
    }
    for (const key of ["stage1TimeoutMs", "stage2TimeoutMs"] as const) {
      const setting = value.classifier[key];
      if (setting === undefined) continue;
      if (!Number.isInteger(setting) || (setting as number) < 1_000 || (setting as number) > 120_000) {
        throw sourceError(source, `classifier.${key} must be an integer from 1000 through 120000`);
      }
      classifier[key] = setting as number;
    }
    if (value.classifier.maxRetries !== undefined) {
      const retries = value.classifier.maxRetries;
      if (!Number.isInteger(retries) || (retries as number) < 0 || (retries as number) > 2) {
        throw sourceError(source, "classifier.maxRetries must be an integer from 0 through 2");
      }
      classifier.maxRetries = retries as number;
    }
    if (value.classifier.pairs !== undefined) {
      if (!Array.isArray(value.classifier.pairs) || value.classifier.pairs.length === 0) {
        throw sourceError(source, "classifier.pairs must be a non-empty array");
      }
      classifier.pairs = value.classifier.pairs.map((pair, pairIndex) => {
        if (!isRecord(pair)) throw sourceError(source, `classifier.pairs[${pairIndex}] must be an object`);
        for (const key of Object.keys(pair)) {
          if (!PAIR_FIELDS.has(key)) throw sourceError(source, `unsupported classifier pair field ${JSON.stringify(key)}`);
        }
        if (typeof pair.provider !== "string" || !pair.provider.trim()) {
          throw sourceError(source, `classifier.pairs[${pairIndex}].provider must be a non-empty string`);
        }
        const parseStage = (value: unknown, stage: "stage1" | "stage2") => {
          if (!isRecord(value)) throw sourceError(source, `classifier.pairs[${pairIndex}].${stage} must be an object`);
          for (const key of Object.keys(value)) {
            if (!STAGE_FIELDS.has(key)) throw sourceError(source, `unsupported classifier stage field ${JSON.stringify(key)}`);
          }
          if (typeof value.model !== "string" || !value.model.trim()) {
            throw sourceError(source, `classifier.pairs[${pairIndex}].${stage}.model must be a non-empty string`);
          }
          if (typeof value.reasoning !== "string" || !REASONING_LEVELS.has(value.reasoning as ClassifierReasoning)) {
            throw sourceError(source, `classifier.pairs[${pairIndex}].${stage}.reasoning is not supported`);
          }
          return { model: value.model.trim(), reasoning: value.reasoning as ClassifierReasoning };
        };
        return {
          provider: pair.provider.trim(),
          stage1: parseStage(pair.stage1, "stage1"),
          stage2: parseStage(pair.stage2, "stage2"),
        };
      });
    }
    result.classifier = classifier;
  }
  return result;
}

export function mergeConfig(base: RawSandboxConfig, override: RawConfigOverride): RawSandboxConfig {
  return {
    enabled: override.enabled ?? base.enabled,
    isolateNetwork: override.isolateNetwork ?? base.isolateNetwork,
    sshAgent: override.sshAgent ?? base.sshAgent,
    classifier: { ...base.classifier, ...override.classifier },
    filesystem: { ...base.filesystem, ...override.filesystem },
  };
}

function readConfigFile(path: string, scope: ConfigScope): RawConfigOverride {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw sourceError(path, `could not parse JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfigObject(value, path, scope);
}

/** Load trusted layers strictly. Parse, schema, and path errors fail closed. */
export function loadConfig(
  cwd: string,
  home: string,
  paths: ConfigPaths,
  includeProject: boolean,
  resolver?: PathResolver,
): CompiledSandboxConfig {
  let raw = mergeConfig(
    defaultPolicyForProjectGitEntry(existsSync(join(cwd, ".git"))),
    readConfigFile(paths.global, "global"),
  );
  if (includeProject) raw = mergeConfig(raw, readConfigFile(paths.project, "project"));
  return {
    ...raw,
    filesystem: compilePolicy(raw.filesystem, { cwd, home }, resolver),
  };
}
