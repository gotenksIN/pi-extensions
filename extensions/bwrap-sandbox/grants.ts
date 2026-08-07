import { dirname } from "node:path";
import { inspectPathKind, resolveExistingPath, configuredAccess, effectiveAccess, isPathWithin } from "./policy.ts";
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

export const MAX_ONE_SHOT_WRITE_PATHS = 16;

export interface OneShotGrantRequest {
  readonly path: string;
  readonly scope: GrantScope;
}

export interface WriteAdmission {
  readonly path: string;
  readonly alreadyWritable: boolean;
}

export interface OneShotWriteAdmission extends WriteAdmission {
  readonly requestedPath: string;
  readonly scope: GrantScope;
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

/** Validate an atomic set of transient exact or parent bind sources. */
export function validateOneShotGrantRequests(
  requests: readonly OneShotGrantRequest[],
  context: GrantContext,
  grants: ApprovedWriteGrants,
  resolver?: PathResolver,
): readonly OneShotWriteAdmission[] {
  if (requests.length === 0) throw new Error("One-shot sandbox access requires at least one path");
  if (requests.length > MAX_ONE_SHOT_WRITE_PATHS) {
    throw new Error(`One-shot sandbox access supports at most ${MAX_ONE_SHOT_WRITE_PATHS} paths`);
  }

  const admissions = requests.map((request, index) => {
    const requestedPath = request?.path;
    const scope = request?.scope;
    if (typeof requestedPath !== "string" || !requestedPath.trim()) {
      throw new Error(`One-shot sandbox access path ${index + 1} must be a non-empty string`);
    }
    if (scope !== "exact" && scope !== "parent") {
      throw new Error(`One-shot sandbox access path ${index + 1} has an invalid scope`);
    }
    const admission = validatePersistentGrantRequest(requestedPath, scope, context, grants, resolver);
    if ((context.inspect ?? inspectPathKind)(admission.path) === "missing") {
      throw new Error(`One-shot sandbox access requires an existing mount source: ${admission.path}`);
    }
    return { requestedPath, scope, ...admission };
  });

  for (let index = 0; index < admissions.length; index += 1) {
    for (let prior = 0; prior < index; prior += 1) {
      const left = admissions[prior].path;
      const right = admissions[index].path;
      if (left === right) throw new Error(`One-shot sandbox access contains a duplicate path: ${right}`);
      if (isPathWithin(left, right) || isPathWithin(right, left)) {
        throw new Error(`One-shot sandbox access contains overlapping paths: ${left} and ${right}`);
      }
    }
  }
  return admissions;
}

/** Validate one transient exact or parent bind source with persistent-grant rules. */
export function validateOneShotGrantRequest(
  rawPath: string,
  scope: GrantScope,
  context: GrantContext,
  grants: ApprovedWriteGrants,
  resolver?: PathResolver,
): WriteAdmission {
  const [admission] = validateOneShotGrantRequests(
    [{ path: rawPath, scope }],
    context,
    grants,
    resolver,
  );
  return { path: admission.path, alreadyWritable: admission.alreadyWritable };
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
