import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type {
  CompiledFilesystemPolicy,
  FileAccess,
  PathKind,
  RawFilesystemRules,
} from "./types.ts";

export interface PathContext {
  readonly cwd: string;
  readonly home?: string;
}

export type PathEntryKind = "directory" | "file" | "symlink";

export interface PathResolver {
  lstat(path: string): PathEntryKind | undefined;
  readlink(path: string): string;
}

const nodePathResolver: PathResolver = {
  lstat(path) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return "symlink";
      return stat.isDirectory() ? "directory" : "file";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  readlink: readlinkSync,
};

export interface PathInspectionStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export type PathInspector = (path: string) => PathInspectionStat;

/** Inspect a mount source without weakening errors into a missing-path result. */
export function inspectPathKind(path: string, inspect: PathInspector = lstatSync): PathKind {
  try {
    const stat = inspect(path);
    if (stat.isSymbolicLink()) throw new Error(`Sandbox mount source changed to a symlink: ${path}`);
    return stat.isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function expandPath(input: string, context: PathContext, allowProject: boolean): string {
  const home = context.home ?? homedir();
  if (allowProject && input === ":project") return context.cwd;
  if (allowProject && input.startsWith(":project/")) return resolve(context.cwd, input.slice(9));
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

/** Lexically normalize a requested path without consulting the filesystem. */
export function normalizePath(input: string, context: PathContext): string {
  const withoutAt = input.startsWith("@") ? input.slice(1) : input;
  if (!withoutAt) throw new Error("Sandbox path must not be empty");
  const expanded = expandPath(withoutAt, context, false);
  return normalize(isAbsolute(expanded) ? expanded : resolve(context.cwd, expanded));
}

/** Lexically normalize a configured path, including :project aliases. */
export function normalizeConfiguredPath(input: string, context: PathContext): string {
  if (!input) throw new Error("Sandbox policy paths must not be empty");
  const expanded = expandPath(input, context, true);
  return normalize(isAbsolute(expanded) ? expanded : resolve(context.cwd, expanded));
}

function components(path: string): string[] {
  return path.split(sep).filter(Boolean);
}

/**
 * Resolve every symlink component, including dangling final and intermediate
 * links, then retain a missing suffix below the deepest existing target.
 * Inspection errors, loops, and non-directory intermediates fail closed.
 */
export function resolveExistingPath(
  input: string,
  context: PathContext,
  resolver: PathResolver = nodePathResolver,
): string {
  const original = normalizePath(input, context);
  let pending = components(original);
  let resolved = "/";
  let followed = 0;

  while (pending.length > 0) {
    const component = pending.shift()!;
    const candidate = join(resolved, component);
    const kind = resolver.lstat(candidate);

    if (!kind) return normalize(join(candidate, ...pending));
    if (kind === "symlink") {
      followed += 1;
      if (followed > 40) throw new Error(`Sandbox path contains a symlink loop: ${original}`);
      const target = resolver.readlink(candidate);
      const targetPath = isAbsolute(target) ? target : resolve(dirname(candidate), target);
      pending = components(normalize(join(targetPath, ...pending)));
      resolved = "/";
      continue;
    }
    if (kind !== "directory" && pending.length > 0) {
      throw new Error(`Sandbox path has a non-directory intermediate component: ${candidate}`);
    }
    resolved = candidate;
  }

  return normalize(resolved);
}

export function resolveConfiguredPath(
  input: string,
  context: PathContext,
  resolver: PathResolver = nodePathResolver,
): string {
  return resolveExistingPath(normalizeConfiguredPath(input, context), context, resolver);
}

export function resolveOptionalConfiguredDirectory(
  input: string,
  context: PathContext,
  resolver: PathResolver = nodePathResolver,
): { path: string; state: "active" | "missing" } {
  const path = resolveConfiguredPath(input, context, resolver);
  const kind = resolver.lstat(path);
  if (kind === undefined) return { path, state: "missing" };
  if (kind !== "directory") throw new Error(`Configured sandbox directory is not a directory: ${path}`);
  return { path, state: "active" };
}

export function compilePolicy(
  filesystem: RawFilesystemRules,
  context: PathContext,
  resolver: PathResolver = nodePathResolver,
): CompiledFilesystemPolicy {
  const compiled: Record<string, FileAccess> = {};
  const sources = new Map<string, string>();

  for (const [source, access] of Object.entries(filesystem)) {
    const path = resolveConfiguredPath(source, context, resolver);
    const previous = sources.get(path);
    if (previous && previous !== source) {
      throw new Error(
        `Sandbox policy paths ${JSON.stringify(previous)} and ${JSON.stringify(source)} resolve to the same path: ${path}`,
      );
    }
    compiled[path] = access;
    sources.set(path, source);
  }

  return Object.fromEntries(
    Object.entries(compiled).sort(([left], [right]) => left.localeCompare(right)),
  ) as CompiledFilesystemPolicy;
}

export function isPathWithin(target: string, base: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathDepth(path: string): number {
  return normalize(path).split(sep).filter(Boolean).length;
}

/** Return the most-specific configured rule. */
export function configuredAccess(
  target: string,
  policy: CompiledFilesystemPolicy,
): FileAccess | undefined {
  let selected: { depth: number; access: FileAccess } | undefined;
  for (const [base, access] of Object.entries(policy)) {
    if (!isPathWithin(target, base)) continue;
    const depth = pathDepth(base);
    if (!selected || depth > selected.depth) selected = { depth, access };
  }
  return selected?.access;
}

/**
 * Unmatched host paths default to read. Configured `none` is resolved before
 * writable overlays and is therefore absolute.
 */
export function effectiveAccess(
  target: string,
  policy: CompiledFilesystemPolicy,
  writablePaths: readonly string[] = [],
): FileAccess {
  const configured = configuredAccess(target, policy);
  if (configured === "none") return "none";
  if (configured === "write" || writablePaths.some((base) => isPathWithin(target, base))) return "write";
  return "read";
}
