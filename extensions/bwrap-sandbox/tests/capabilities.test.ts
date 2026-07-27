import {
  createRuntimeCapabilities,
  deriveCapabilityEnvironment,
  revalidateRuntimeCapabilities,
  sshCapabilityStatus,
  type CapabilityFilesystem,
} from "../capabilities.ts";
import type { CompiledFilesystemPolicy, CompiledSandboxConfig } from "../types.ts";
import { assert, test } from "./harness.ts";

const ROOT = "/private/pi-runtime";
const TEMP = `${ROOT}/tmp`;
const DENIED = `${ROOT}/denied-file`;
const SSH_CONFIG = `${ROOT}/ssh_config`;
const SOCKET = "/home/tester/.ssh/agent/socket";

function config(
  sshAgent: boolean,
  filesystem: Record<string, "none" | "read" | "write"> = {},
): CompiledSandboxConfig {
  return {
    enabled: true,
    isolateNetwork: false,
    sshAgent,
    filesystem: filesystem as unknown as CompiledFilesystemPolicy,
  };
}

function filesystem(
  options: { socket?: boolean; tempDirectory?: boolean; canonical?: string } = {},
): CapabilityFilesystem {
  return {
    realpath(path) {
      if ([ROOT, TEMP, DENIED, SSH_CONFIG].includes(path)) return path;
      if (path === SOCKET && options.socket !== false) return options.canonical ?? SOCKET;
      throw new Error(`missing: ${path}`);
    },
    lstat(path) {
      return {
        isDirectory: () => path === ROOT || (path === TEMP && options.tempDirectory !== false),
        isFile: () => path === DENIED || path === SSH_CONFIG,
        isSocket: () => path === (options.canonical ?? SOCKET) && options.socket !== false,
      };
    },
  };
}

function capabilities(
  sshAgent: boolean,
  rules: Record<string, "none" | "read" | "write"> = {},
  environment: NodeJS.ProcessEnv = { SSH_AUTH_SOCK: SOCKET },
  fs: CapabilityFilesystem = filesystem({ socket: true }),
) {
  return createRuntimeCapabilities({
    resourceRootPath: ROOT,
    privateTempPath: TEMP,
    deniedFilePath: DENIED,
    sshClientConfigPath: SSH_CONFIG,
    config: config(sshAgent, rules),
    inheritedEnvironment: environment,
    filesystem: fs,
  });
}

test("trusted resources and private temp form a closed validated bundle", () => {
  const result = capabilities(true);
  assert.deepEqual(result.resources, {
    kind: "trusted-runtime-resources",
    root: ROOT,
    deniedFile: DENIED,
    sshClientConfig: SSH_CONFIG,
    sshClientConfigDestination: "/etc/ssh/ssh_config",
  });
  assert.deepEqual(result.privateTemp, { kind: "private-temp", path: TEMP });
});

test("trusted resource paths must be absolute immediate distinct children", () => {
  assert.throws(
    () => createRuntimeCapabilities({
      resourceRootPath: "relative",
      privateTempPath: TEMP,
      deniedFilePath: DENIED,
      sshClientConfigPath: SSH_CONFIG,
      config: config(true),
      inheritedEnvironment: {},
      filesystem: filesystem(),
    }),
    /must be absolute/,
  );
  assert.throws(
    () => createRuntimeCapabilities({
      resourceRootPath: ROOT,
      privateTempPath: "/private/outside",
      deniedFilePath: DENIED,
      sshClientConfigPath: SSH_CONFIG,
      config: config(true),
      inheritedEnvironment: {},
      filesystem: {
        realpath: (path) => path,
        lstat: (path) => ({
          isDirectory: () => path === ROOT || path === "/private/outside",
          isFile: () => path === DENIED || path === SSH_CONFIG,
          isSocket: () => false,
        }),
      },
    }),
    /immediate child/,
  );
});

test("enabled SSH capability crosses an inherited denied parent", () => {
  const result = capabilities(true, { "/home/tester/.ssh": "none" });
  assert.deepEqual(result.sshAgent, { kind: "ssh-agent", disposition: "enabled", socket: SOCKET });
  assert.equal(sshCapabilityStatus(result).state, "enabled-mounted");
});

test("exact configured none vetoes enabled SSH capability construction", () => {
  assert.throws(
    () => capabilities(true, { "/home/tester/.ssh": "none", [SOCKET]: "none" }),
    /explicitly denied/,
  );
});

test("disabled SSH capability masks an otherwise exposed exact socket", () => {
  const result = capabilities(false, { "/home/tester": "read" });
  assert.deepEqual(result.sshAgent, { kind: "ssh-agent", disposition: "masked", socket: SOCKET });
  assert.equal(sshCapabilityStatus(result).state, "disabled-masked");
});

test("disabled SSH does not add a redundant mask beneath effective none", () => {
  const result = capabilities(false, { "/home/tester/.ssh": "none" });
  assert.equal(result.sshAgent.disposition, "unavailable");
  assert.equal(sshCapabilityStatus(result).state, "disabled");
});

test("relative, missing, and non-socket inherited SSH paths are unavailable", () => {
  const relative = capabilities(true, {}, { SSH_AUTH_SOCK: "agent.sock" });
  assert.equal(relative.sshAgent.disposition, "unavailable");

  const missing = capabilities(true, {}, { SSH_AUTH_SOCK: SOCKET }, filesystem({ socket: false }));
  assert.equal(missing.sshAgent.disposition, "unavailable");

  const base = filesystem();
  const notSocket = capabilities(true, {}, { SSH_AUTH_SOCK: SOCKET }, {
    realpath: (path) => path,
    lstat: (path) => {
      const stat = base.lstat(path);
      return { ...stat, isSocket: () => false };
    },
  });
  assert.equal(notSocket.sshAgent.disposition, "unavailable");
  assert.equal(sshCapabilityStatus(notSocket).state, "enabled-unavailable");
});

test("private temp capability requires an existing directory", () => {
  assert.throws(
    () => capabilities(true, {}, {}, filesystem({ tempDirectory: false })),
    /private temporary directory is unavailable/,
  );
});

test("trusted resource and enabled socket types are revalidated before spawn", () => {
  const result = capabilities(true);
  const base = filesystem();
  assert.throws(
    () => revalidateRuntimeCapabilities(result, {
      realpath: (path) => path,
      lstat: (path) => path === DENIED
        ? { isDirectory: () => true, isFile: () => false, isSocket: () => false }
        : base.lstat(path),
    }),
    /trusted runtime resource failed pre-spawn revalidation/,
  );
  assert.throws(
    () => revalidateRuntimeCapabilities(result, {
      realpath: (path) => path,
      lstat: (path) => {
        const stat = base.lstat(path);
        return path === SOCKET ? { ...stat, isSocket: () => false } : stat;
      },
    }),
    /enabled SSH agent socket failed pre-spawn revalidation/,
  );
});

test("capability-derived environment couples temp variables and enabled SSH", () => {
  const result = capabilities(true);
  const environment = deriveCapabilityEnvironment(
    result,
    { KEEP: "yes", TMPDIR: "/host", SSH_AUTH_SOCK: "/host/socket" },
    { TMP: "/caller", SSH_AUTH_SOCK: "/caller/socket" },
  );
  assert.equal(environment.KEEP, "yes");
  assert.equal(environment.TMPDIR, TEMP);
  assert.equal(environment.TMP, TEMP);
  assert.equal(environment.TEMP, TEMP);
  assert.equal(environment.SSH_AUTH_SOCK, SOCKET);
  assert.equal(environment.GIT_SSH_COMMAND, undefined);
});

test("capability-derived environment removes SSH when disabled or unavailable", () => {
  for (const result of [capabilities(false), capabilities(true, {}, {})]) {
    const environment = deriveCapabilityEnvironment(result, { SSH_AUTH_SOCK: SOCKET });
    assert.equal(environment.SSH_AUTH_SOCK, undefined);
    assert.equal(environment.TMPDIR, TEMP);
    assert.equal(environment.TMP, TEMP);
    assert.equal(environment.TEMP, TEMP);
  }
});
