import { dirname } from "node:path";
import { inspectPathKind, resolveExistingPath, configuredAccess, effectiveAccess } from "./policy.ts";
import { validateWritableRuntimePath, type ProtectedRuntimePaths } from "./layout.ts";
import type { PathResolver } from "./policy.ts";
import type { ApprovedWriteGrants, CompiledFilesystemPolicy, PathKind } from "./types.ts";

export interface GrantContext {
  readonly cwd: string;
  readonly home: string;
  readonly policy: CompiledFilesystemPolicy;
  readonly protectedPaths: ProtectedRuntimePaths;
  readonly inspect?: (path: string) => PathKind;
}

export type GrantScope = "exact" | "parent";

export interface WriteAdmission {
  readonly path: string;
  readonly alreadyWritable: boolean;
}

export function emptyApprovedGrants(): ApprovedWriteGrants {
  return { paths: [] } as unknown as ApprovedWriteGrants;
}

export function approvedGrantPaths(grants: ApprovedWriteGrants): readonly string[] {
  return grants.paths;
}

function validateWrite(
  rawPath: string,
  context: GrantContext,
  grants: ApprovedWriteGrants,
  persistent: boolean,
  resolver?: PathResolver,
): WriteAdmission {
  const path = resolveExistingPath(rawPath, context, resolver);
  if (configuredAccess(path, context.policy) === "none") {
    throw new Error(`Sandbox policy permanently denies access to ${path}`);
  }
  validateWritableRuntimePath(path, context.protectedPaths, persistent ? "subtree" : "exact");
  const alreadyWritable = effectiveAccess(path, context.policy, grants.paths) === "write";
  if (persistent && !alreadyWritable && (context.inspect ?? inspectPathKind)(path) === "missing") {
    throw new Error(
      `Sandbox write grants require an existing mount source; request an existing parent directory: ${path}`,
    );
  }
  return { path, alreadyWritable };
}

/** Validate a persistent grant that will become a Bubblewrap bind source. */
export function validatePersistentGrant(
  rawPath: string,
  context: GrantContext,
  grants: ApprovedWriteGrants,
  resolver?: PathResolver,
): WriteAdmission {
  return validateWrite(rawPath, context, grants, true, resolver);
}

/** Select and validate an exact path or its parent as the persistent bind source. */
export function validatePersistentGrantRequest(
  rawPath: string,
  scope: GrantScope,
  context: GrantContext,
  grants: ApprovedWriteGrants,
  resolver?: PathResolver,
): WriteAdmission {
  const grantPath = scope === "parent" ? dirname(rawPath) : rawPath;
  return validatePersistentGrant(grantPath, context, grants, resolver);
}

/** Validate one direct write without requiring its target to exist. */
export function validateDirectWrite(
  rawPath: string,
  context: GrantContext,
  grants: ApprovedWriteGrants,
  resolver?: PathResolver,
): WriteAdmission {
  return validateWrite(rawPath, context, grants, false, resolver);
}

/** Revalidate and immutably add a human-approved persistent grant. */
export function addApprovedGrant(
  grants: ApprovedWriteGrants,
  rawPath: string,
  context: GrantContext,
  resolver?: PathResolver,
): ApprovedWriteGrants {
  const admission = validatePersistentGrant(rawPath, context, grants, resolver);
  if (admission.alreadyWritable || grants.paths.includes(admission.path)) return grants;
  return { paths: [...grants.paths, admission.path].sort() } as unknown as ApprovedWriteGrants;
}
