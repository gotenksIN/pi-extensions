interface ProcessSandboxState {
  disabledByCli: boolean;
}

export type SandboxDisableSource = "none" | "cli" | "parent-cli";

const STATE_KEY = Symbol.for("gotenksIN.pi-extensions.bwrap-sandbox.process-state.v1");

function state(): ProcessSandboxState {
  const globals = globalThis as typeof globalThis & { [STATE_KEY]?: ProcessSandboxState };
  globals[STATE_KEY] ??= { disabledByCli: false };
  return globals[STATE_KEY];
}

export function resolveSandboxDisableSource(
  explicitlyDisabled: boolean,
  processDisabled: boolean,
): SandboxDisableSource {
  return explicitlyDisabled ? "cli" : processDisabled ? "parent-cli" : "none";
}

/** Keep the parent CLI opt-out active for all sessions in this Pi process. */
export function sandboxDisableSource(explicitlyDisabled: boolean): SandboxDisableSource {
  const shared = state();
  if (explicitlyDisabled) shared.disabledByCli = true;
  return resolveSandboxDisableSource(explicitlyDisabled, shared.disabledByCli);
}
