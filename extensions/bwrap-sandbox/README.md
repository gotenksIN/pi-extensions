# Bubblewrap sandbox architecture

## Goals and non-goals

This extension gives every Pi Bash invocation a Linux Bubblewrap integrity and
write-boundary sandbox. Its goals are deterministic filesystem policy,
human-approved session writes, a private writable temporary directory, optional
network isolation, and explicit support for Git SSH signing through the exact
inherited agent socket. It also applies an application-level authorization gate
to Pi's direct filesystem tools.

It is not a confidentiality boundary, a shell-command analyzer, a container
manager, or a general capability/plugin framework. Unmatched host paths are
readable, environment variables are inherited, and networking remains available
unless configured otherwise. It does not interpret Git configuration or shell
syntax when deciding mounts.

## Threat model

Sandboxed commands and their descendants are untrusted. The design protects
host integrity by starting from a read-only host root, exposing only compiled
writes, dropping capabilities, isolating user and PID namespaces, and optionally
isolating networking. Explicit `none` rules hide selected host paths. Filesystem
inspection errors, path ambiguity, missing writable bind sources, and runtime
resource type changes fail closed.

The host process, Pi extension code, trusted global and trusted-project
configuration, the root-owned Bubblewrap executable, and the human answering an
approval prompt are trusted. Host reads, inherited environment values, agent
requests, network exfiltration when networking is enabled, and check-to-use
races in the direct-tool gate remain in scope as limitations.

## Trust domains and precedence

The effective namespace is assembled in this order:

1. A read-only bind of host `/`, followed by fresh `/dev` and fresh `/proc`.
2. Closed trusted runtime resources: a hidden source root, denied-file source,
   and deterministic OpenSSH system configuration.
3. Closed runtime capabilities: one exact private temporary directory and the
   disposition of one exact canonical inherited SSH agent socket.
4. Canonical compiled filesystem policy, where the most-specific configured
   path wins.
5. Canonical human-approved session write grants.

Mount operations are emitted broad-to-narrow so narrow decisions realize that
precedence. A grant never overrides effective `none`. Grants cannot manufacture
runtime capabilities. Runtime capabilities do not authorize direct-tool access.

An enabled SSH capability is a deliberate narrow exception to an inherited
parent `none`: generated directory scaffolding makes only the exact socket
reachable. An exact configured `none` on that socket is an explicit veto and
fails capability construction. With SSH disabled, an inherited canonical socket
that ordinary policy would expose receives an exact mask. A capability does not
turn unrelated parent siblings into readable paths. The fixed fresh `/dev`,
`/proc`, trusted-resource mask, and read-only SSH client configuration cannot be
made writable by policy, grants, or capabilities. An explicit policy `none` on
the SSH client configuration destination still hides that file.

## Ownership and dependency map

- `types.ts` defines branded compiled policy, branded approved grants, the
  closed branded runtime-capability union, and typed mount operations.
- `policy.ts` alone canonicalizes paths, compiles filesystem rules, and computes
  most-specific policy access. It contains no SSH behavior.
- `layout.ts` owns fresh `/dev` and `/proc`, trusted executable, host temporary
  parent, trusted resource root, and fixed SSH configuration destination
  invariants.
- `grants.ts` is the only user-write admission authority. It validates and
  constructs `ApprovedWriteGrants`; it neither accepts nor creates runtime
  capabilities.
- `capabilities.ts` alone validates the closed resource tree, discovers and
  canonicalizes inherited `SSH_AUTH_SOCK`, validates socket and private-temp
  types, applies the exact socket veto, constructs and reports capability state,
  revalidates before spawn, and derives capability-coupled child environment
  variables.
- `mount-plan.ts` consumes one input containing compiled policy, approved grants,
  and runtime capabilities. It produces deterministic namespace operations with
  distinct bind source and destination.
- `runtime.ts` creates the host-only resource root and its private-temp,
  denied-file, and deterministic OpenSSH children, constructs capabilities,
  compiles plans, spawns and reaps Bubblewrap children, and removes the complete
  resource tree.
- `session.ts` composes configuration, lifecycle, approval broker, grants, and
  runtime. `commands.ts` presents status and the one-command test surface.
- `direct-gate.ts` applies application-level policy to Pi filesystem tools.
  `index.ts` registers Pi surfaces and delegates; it has no feature logic.

Dependencies flow from lifecycle and UI modules toward these narrow owners;
policy, layout, grants, and capabilities do not depend on session or command
registration.

## Compilation and runtime flow

The security pipeline is:

1. Strictly parse global config, then trusted project config. Project config may
   override existing project-scoped settings but may not contain `sshAgent`.
2. Resolve raw filesystem paths and aliases into a branded canonical compiled
   policy.
3. Create a mode-0700 host-only resource root with immediate `tmp/`,
   `denied-file`, and generated `ssh_config` children.
4. Construct a single branded capability bundle from that closed resource tree,
   compiled policy, global/default SSH setting, and inherited environment.
5. Combine compiled policy, branded grants, resources, and capabilities into one
   mount plan.
6. Immediately before every spawn, revalidate every trusted source and an
   enabled socket, then derive `TMPDIR`, `TMP`, `TEMP`, and `SSH_AUTH_SOCK` from
   the same bundle used by the mount plan.
7. Spawn Bubblewrap, preserve cancellation and timeout behavior, kill the child
   process group when required, reap it, and remove private resources at
   shutdown.

Capability construction reports enabled-but-unavailable SSH state rather than
claiming signing support. An explicit exact socket veto and invariant violations
fail startup. A socket that changes type after startup fails the affected spawn.

## Filesystem access, grants, and IPC capabilities

Filesystem policy describes ordinary `none`, `read`, and `write` access. An
approved grant is a human decision to widen one canonical existing filesystem
source to `write` for the session; it remains subordinate to `none` and protected
runtime paths.

Trusted resources and runtime capabilities are different from policy and
approval grants. The source root is replaced by a synthetic directory inside
Bubblewrap, so untrusted commands can reach only its exact writable `tmp/`
child. The denied-file and generated SSH configuration source inodes remain
unreachable. The SSH socket bind is read-only as a filesystem mount, but
connecting to it can request agent operations. None of these resources is
represented as a user grant or consulted by direct-tool authorization.

## SSH signing capability and abuse scope

`sshAgent` defaults to `true` globally because SSH-signed Git commits are a
compatibility requirement. If inherited `SSH_AUTH_SOCK` names an existing
absolute socket, only its canonical exact path is exposed. No socket directories
are scanned. Parent masks and read-only remounts keep unrelated siblings hidden,
and private key files remain hidden by policy.

This capability has a real security cost: any sandboxed command can ask the
inherited agent to authenticate or sign with keys the agent makes available.
Hiding private key files does not prevent that abuse. Security-focused users can
set `sshAgent: false` in global configuration; the variable is removed and an
otherwise visible inherited socket is exactly masked. Project configuration is
never allowed to set or re-enable this credential capability.

Bubblewrap's user namespace represents host-root-owned files as an unmapped UID,
which causes OpenSSH to reject some system configuration includes before agent
use. The fixed runtime topology therefore read-only-binds a generated mode-0600
minimal configuration over `/etc/ssh/ssh_config`. OpenSSH still reads permitted
user configuration and known-host files. Host system SSH defaults and include
graphs are intentionally not copied: doing so would add parser, symlink, and race
complexity. Environments requiring system proxy directives must place equivalent
settings in readable user configuration. The fix is namespace-level and applies
to ordinary `ssh` and Git SSH transport without command-specific environment.

## Mount phases and denied-parent invariant

The plan is deterministic and inspectable:

1. Read-only host root, fresh `/dev`, and fresh `/proc`.
2. Broad-to-narrow trusted-resource, policy, grant, and capability operations.
3. For a denied directory with permitted descendants: a tmpfs mask, only the
   required scaffold directories, then exact child binds.
4. Deepest-first read-only remounts of parents that had to remain writable while
   narrower mounts were installed.

The trusted source root follows the same invariant: root mask → exact writable
`tmp/` bind → root remount, while the denied-file and SSH-configuration source
inodes remain hidden. For an inherited denied SSH parent, ordering is parent
mask → scaffold → exact read-only socket bind → deepest-first parent remount.
Bind and file-mask operations record their exact source and destination.
Scaffolding contains no host siblings and never substitutes a broad host-parent
bind.

## Direct-tool and lifecycle limitations

Pi `read`, `write`, `edit`, `grep`, `find`, and `ls` execute in Pi's host process,
not inside Bubblewrap. Their structured paths pass through an application-level
gate, which is permission logic rather than OS containment and has an unavoidable
check-to-use race. Runtime capabilities intentionally do not widen this gate.

Parent and subagent prompts share a compatibility approval broker. Requests are
serialized and owner-checked; a child cannot approve itself and fails closed
without an interactive parent. Pi cannot cancel a select dialog already shown,
so a stale dialog can hold the queue until a human dismisses it. Generation and
owner checks reject its eventual result but cannot remove the displayed prompt.

## Testing strategy

Pi-native unit tests cover config scope/defaults, canonical policy, grant
admission, capability construction and environment coupling, mount operation
type/source/destination/order, lifecycle approval behavior, and repeat-safe lazy
registration. They use injected filesystem inspectors and do not require
Bubblewrap.

`/sandbox-test` is the only integration command. It runs the registered unit
suite and then the shell script through the active runtime, writing combined
output to `sandbox-manual-test.log`. Integration proves private temporary writes,
hidden trusted source inodes, read-only generated SSH configuration, ordinary
OpenSSH parsing, project and child writes, host `/tmp` and `.git` protection,
hidden SSH key and socket siblings, broad host reads, and the PNG fixture. For
an SSH origin it performs authenticated `git ls-remote`. It also creates a
throwaway repository under private `TMPDIR`, performs a real globally configured
SSH-signed commit through the inherited agent, checks the commit's SSH `gpgsig`,
builds a temporary allowed-signers file from the configured email and public
signing key, and runs `git verify-commit`. Unsupported key configuration fails
with diagnostics; signing is never bypassed. Claims about live Bubblewrap
behavior require a successful `/sandbox-test` run in the target environment.

## Mandatory change checklist

Every security-sensitive change must answer all of these before merge:

- Which module owns the decision or resource?
- Is it filesystem access, a user grant, or a runtime capability, and what is
  its abuse scope?
- What is its default and which config scope is allowed to set it?
- How do exact `none` and inherited parent `none` apply?
- What are the mount source, destination, source type, access mode, and order?
- Which child environment values must remain coupled to the mount?
- Does invalid, missing, changed, or unavailable state fail startup, fail spawn,
  become an explicit unavailable status, or receive a mask?
- Which unit tests prove each branch?
- Which `/sandbox-test` integration proof demonstrates actual behavior?
- Do this document, root user documentation, status text, and tests agree?

## Prohibited patterns

Do not introduce:

- shell or Git command parsing to decide mounts;
- feature checks or security policy in `index.ts`;
- capability creation from human grants;
- duplicated protected-path or capability checks across modules;
- test fixtures in normal startup code;
- generalized capability/plugin registration for the closed runtime resources;
- writable parent overlays used to bypass policy; or
- runtime-security claims not backed by `/sandbox-test` in the target environment.
