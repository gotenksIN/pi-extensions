import { createRuntimeCapabilities, type CapabilityFilesystem } from "../capabilities.ts";
import { buildMountNamespaceArgs, createMountPlan as compileMountPlan } from "../mount-plan.ts";
import type {
  ApprovedWriteGrants,
  CompiledFilesystemPolicy,
  CompiledSandboxConfig,
  MountOperation,
  PathKind,
} from "../types.ts";
import { assert, test } from "./harness.ts";

const ROOT = "/private/pi-runtime";
const TEMP = `${ROOT}/tmp`;
const DENIED = `${ROOT}/denied-file`;
const SSH_CONFIG = `${ROOT}/ssh_config`;
const SSH_CONFIG_DESTINATION = "/etc/ssh/ssh_config";
const SOCKET = "/home/user/.ssh/agent/socket";

const capabilityFilesystem: CapabilityFilesystem = {
  realpath: (path) => path,
  lstat: (path) => ({
    isDirectory: () => path === ROOT || path === TEMP,
    isFile: () => path === DENIED || path === SSH_CONFIG,
    isSocket: () => path === SOCKET,
  }),
};

function capabilities(
  policy: CompiledFilesystemPolicy,
  sshAgent = true,
  inheritedSocket = false,
) {
  const config: CompiledSandboxConfig = { enabled: true, isolateNetwork: false, sshAgent, filesystem: policy };
  return createRuntimeCapabilities({
    resourceRootPath: ROOT,
    privateTempPath: TEMP,
    deniedFilePath: DENIED,
    sshClientConfigPath: SSH_CONFIG,
    config,
    inheritedEnvironment: inheritedSocket ? { SSH_AUTH_SOCK: SOCKET } : {},
    filesystem: capabilityFilesystem,
  });
}

const createMountPlan = (
  rules: Record<string, "none" | "read" | "write">,
  grants: Record<string, "write">,
  inspectPath: (path: string) => PathKind,
  sshAgent = true,
  inheritedSocket = false,
  transientWritePaths: readonly string[] = [],
) => {
  const policy = rules as unknown as CompiledFilesystemPolicy;
  return compileMountPlan({
    policy,
    grants: { paths: Object.keys(grants) } as unknown as ApprovedWriteGrants,
    capabilities: capabilities(policy, sshAgent, inheritedSocket),
    transientWritePaths,
  }, inspectPath);
};

const inspect = (kinds: Record<string, PathKind>) => (path: string): PathKind => kinds[path] ?? "directory";
const operationPath = (operation: MountOperation): string =>
  operation.kind === "bind" ? operation.destination : operation.path;
const indexOf = (plan: MountOperation[], kind: MountOperation["kind"], path: string) =>
  plan.findIndex((operation) => operation.kind === kind && operationPath(operation) === path);
const withoutRuntimeResources = (plan: MountOperation[]) =>
  plan.filter((operation) => ![ROOT, TEMP, SSH_CONFIG_DESTINATION].includes(operationPath(operation)));

test("trusted root is hidden while private temp is exposed exactly writable", () => {
  const plan = createMountPlan({}, {}, inspect({}));
  assert.deepEqual(
    plan.find((operation) => operation.kind === "mask-directory" && operation.path === ROOT),
    { kind: "mask-directory", path: ROOT, inaccessible: false },
  );
  assert.deepEqual(plan.find((operation) => operation.kind === "bind" && operation.destination === TEMP), {
    kind: "bind",
    source: TEMP,
    destination: TEMP,
    sourceType: "directory",
    writable: true,
  });
  assert.ok(indexOf(plan, "mask-directory", ROOT) < indexOf(plan, "bind", TEMP));
  assert.ok(indexOf(plan, "bind", TEMP) < indexOf(plan, "remount-readonly", ROOT));
});

test("generated SSH client config is an exact read-only runtime bind", () => {
  const plan = createMountPlan({}, {}, inspect({}));
  assert.deepEqual(
    plan.find((operation) => operation.kind === "bind" && operation.destination === SSH_CONFIG_DESTINATION),
    {
      kind: "bind",
      source: SSH_CONFIG,
      destination: SSH_CONFIG_DESTINATION,
      sourceType: "file",
      writable: false,
    },
  );
});

test("explicit policy none vetoes the generated SSH client config", () => {
  const plan = createMountPlan({ [SSH_CONFIG_DESTINATION]: "none" }, {}, inspect({}));
  assert.deepEqual(
    plan.find((operation) => operation.kind === "mask-file" && operation.path === SSH_CONFIG_DESTINATION),
    { kind: "mask-file", path: SSH_CONFIG_DESTINATION, source: DENIED },
  );
});

test("writable descendants are mounted before a read-only parent remount", () => {
  const policy = { "/workspace": "read", "/workspace/output": "write" } as const;
  const plan = createMountPlan(policy, {}, inspect({}));
  const parent = plan.find((operation) => operation.kind === "bind" && operation.destination === "/workspace");
  assert.deepEqual(parent, {
    kind: "bind",
    source: "/workspace",
    destination: "/workspace",
    sourceType: "directory",
    writable: true,
  });
  assert.ok(indexOf(plan, "bind", "/workspace/output") < indexOf(plan, "remount-readonly", "/workspace"));
});

test("a regular gitfile is protected without descendant mount rules", () => {
  const policy = { "/workspace": "write", "/workspace/.git": "read" } as const;
  const plan = withoutRuntimeResources(createMountPlan(policy, {}, inspect({ "/workspace/.git": "file" })));
  assert.deepEqual(plan, [
    {
      kind: "bind", source: "/workspace", destination: "/workspace",
      sourceType: "directory", writable: true,
    },
    {
      kind: "bind", source: "/workspace/.git", destination: "/workspace/.git",
      sourceType: "file", writable: false,
    },
  ]);
});

test("denied descendants are masked after writable parents", () => {
  const policy = { "/workspace": "write", "/workspace/.secrets": "none" } as const;
  const plan = createMountPlan(policy, {}, inspect({}));
  assert.ok(indexOf(plan, "bind", "/workspace") < indexOf(plan, "mask-directory", "/workspace/.secrets"));
  assert.deepEqual(
    plan.find((operation) => operation.kind === "mask-directory" && operation.path === "/workspace/.secrets"),
    { kind: "mask-directory", path: "/workspace/.secrets", inaccessible: true },
  );
});

test("readable descendants under denied parents remain mountable while siblings stay hidden", () => {
  const policy = { "/home/user/.ssh": "none", "/home/user/.ssh/config": "read" } as const;
  const plan = createMountPlan(policy, {}, inspect({ "/home/user/.ssh/config": "file" }));
  assert.deepEqual(
    plan.find((operation) => operation.kind === "mask-directory" && operation.path === "/home/user/.ssh"),
    { kind: "mask-directory", path: "/home/user/.ssh", inaccessible: false },
  );
  assert.ok(indexOf(plan, "mask-directory", "/home/user/.ssh") < indexOf(plan, "bind", "/home/user/.ssh/config"));
  assert.ok(indexOf(plan, "bind", "/home/user/.ssh/config") < indexOf(plan, "remount-readonly", "/home/user/.ssh"));
});

test("enabled SSH socket is a read-only exact source-to-destination capability bind", () => {
  const plan = createMountPlan({ "/home/user/.ssh": "none" }, {}, inspect({}), true, true);
  assert.deepEqual(plan.find((operation) => operation.kind === "bind" && operation.destination === SOCKET), {
    kind: "bind",
    source: SOCKET,
    destination: SOCKET,
    sourceType: "socket",
    writable: false,
  });
});

test("denied parent mounting orders mask, scaffold, socket, then deepest-first remounts", () => {
  const plan = createMountPlan(
    { "/home": "none", "/home/user/.ssh": "none" },
    {},
    inspect({}),
    true,
    true,
  );
  const homeMask = indexOf(plan, "mask-directory", "/home");
  const userScaffold = indexOf(plan, "ensure-directory", "/home/user");
  const sshMask = indexOf(plan, "mask-directory", "/home/user/.ssh");
  const agentScaffold = indexOf(plan, "ensure-directory", "/home/user/.ssh/agent");
  const socketBind = indexOf(plan, "bind", SOCKET);
  const sshRemount = indexOf(plan, "remount-readonly", "/home/user/.ssh");
  const homeRemount = indexOf(plan, "remount-readonly", "/home");
  assert.ok(homeMask < userScaffold && userScaffold < sshMask);
  assert.ok(sshMask < agentScaffold && agentScaffold < socketBind);
  assert.ok(socketBind < sshRemount && sshRemount < homeRemount);
});

test("disabled inherited socket receives an exact file mask", () => {
  const plan = createMountPlan({ "/home/user": "read" }, {}, inspect({}), false, true);
  assert.ok(indexOf(plan, "bind", "/home/user") < indexOf(plan, "mask-file", SOCKET));
  assert.deepEqual(
    plan.find((operation) => operation.kind === "mask-file" && operation.path === SOCKET),
    { kind: "mask-file", path: SOCKET, source: DENIED },
  );
});

test("denied files use an inaccessible file mask", () => {
  const policy = { "/workspace/secret.txt": "none" } as const;
  const plan = withoutRuntimeResources(createMountPlan(policy, {}, inspect({ "/workspace/secret.txt": "file" })));
  assert.deepEqual(plan, [{ kind: "mask-file", path: "/workspace/secret.txt", source: DENIED }]);
});

test("missing writable grant sources fail closed", () => {
  assert.throws(
    () => createMountPlan({ "/workspace": "read" }, { "/workspace/new": "write" }, inspect({ "/workspace/new": "missing" })),
    /does not exist/,
  );
});

test("missing protected nodes beneath writable ancestors fail closed without synthesis", () => {
  for (const access of ["read", "none"] as const) {
    assert.throws(
      () => createMountPlan(
        { "/workspace": "write", "/workspace/protected": access },
        {},
        inspect({ "/workspace/protected": "missing" }),
      ),
      /Missing protected sandbox path.*beneath writable path/,
    );
  }
  assert.throws(
    () => createMountPlan(
      { "/workspace/protected": "read" },
      { "/workspace": "write" },
      inspect({ "/workspace/protected": "missing" }),
    ),
    /Missing protected sandbox path.*beneath writable path/,
  );
});

test("missing protected nodes beneath read-only ancestors are safely omitted", () => {
  const plan = withoutRuntimeResources(createMountPlan(
    { "/workspace": "read", "/workspace/optional": "none" },
    {},
    inspect({ "/workspace/optional": "missing" }),
  ));
  assert.deepEqual(plan, [{
    kind: "bind", source: "/workspace", destination: "/workspace",
    sourceType: "directory", writable: false,
  }]);
});

test("fresh dev and proc mounts precede hard policy masks", () => {
  const plan = createMountPlan({ "/dev": "none", "/proc": "none" }, {}, inspect({}));
  const args = buildMountNamespaceArgs(plan);
  const freshDev = args.indexOf("--dev");
  const freshProc = args.indexOf("--proc");
  const firstPolicyMask = args.indexOf("--tmpfs");
  assert.ok(freshDev >= 0 && freshProc > freshDev);
  assert.ok(firstPolicyMask > freshProc);
  assert.ok(args.lastIndexOf("/dev") > freshProc);
  assert.ok(args.lastIndexOf("/proc") > freshProc);
});

test("fresh runtime mounts satisfy read rules without host rebinds", () => {
  assert.deepEqual(
    withoutRuntimeResources(createMountPlan({ "/dev": "read", "/proc/sys": "read" }, {}, inspect({}))),
    [],
  );
  assert.throws(
    () => createMountPlan({ "/proc": "none", "/proc/self": "read" }, {}, inspect({})),
    /Readable overrides.*unsupported/,
  );
});

test("writes intersecting fresh dev or proc mounts are rejected", () => {
  assert.throws(() => createMountPlan({ "/dev/shm": "write" }, {}, inspect({})), /conflicts with fresh/);
  assert.throws(() => createMountPlan({}, { "/proc": "write" }, inspect({})), /conflicts with fresh/);
});

test("a broad grant cannot override a denied descendant or create a socket capability", () => {
  const policy = { "/workspace": "read", "/workspace/secret": "none" } as const;
  const plan = createMountPlan(policy, { "/workspace": "write" }, inspect({}));
  assert.ok(indexOf(plan, "bind", "/workspace") < indexOf(plan, "mask-directory", "/workspace/secret"));
  assert.equal(plan.some((operation) => operation.kind === "bind" && operation.sourceType === "socket"), false);
});

test("one transient path is writable for one mount plan while none remains final", () => {
  const policy = { "/workspace": "read", "/workspace/secret": "none" } as const;
  const plan = createMountPlan(
    policy,
    {},
    inspect({}),
    true,
    false,
    ["/workspace/.git", "/workspace/secret"],
  );
  assert.deepEqual(
    plan.find((operation) => operation.kind === "bind" && operation.destination === "/workspace/.git"),
    {
      kind: "bind",
      source: "/workspace/.git",
      destination: "/workspace/.git",
      sourceType: "directory",
      writable: true,
    },
  );
  assert.equal(
    plan.some((operation) => operation.kind === "bind" && operation.destination === "/workspace/secret"),
    false,
  );
  assert.ok(indexOf(plan, "bind", "/workspace/.git") < indexOf(plan, "remount-readonly", "/workspace"));
});
