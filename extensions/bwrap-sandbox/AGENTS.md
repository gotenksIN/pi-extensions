# Bubblewrap Sandbox Agent Guide

Read `README.md` completely before you modify this extension.
The README is the authoritative architecture and threat model.
Keep the implementation, README, root user documentation, status output, and
tests consistent.

## System purpose

This extension has four security layers:

1. A deterministic filesystem policy.
2. A Linux Bubblewrap mount and process boundary.
3. Human-approved session write grants.
4. A two-stage classifier for model-generated Bash calls.

Bubblewrap is the primary boundary.
The classifier is defense in depth.
No classifier result can change policy, mounts, capabilities, grants, or runtime
validation.

The extension also checks Pi file tools that run in the host process.
These checks are application-level permission logic.
They are not OS containment.

## Trust boundaries

Trust the Pi host process, extension code, trusted configuration, root-owned
Bubblewrap executable, and the user who answers approval requests.
Treat sandboxed commands and their children as untrusted.

For classifier work, also treat these values as untrusted:

- Assistant text and reasoning.
- Tool arguments.
- Repository files and scripts.
- Prior actions.
- Tool output.
- Environment values.
- Classifier output before local validation.

Only user-role text can be authorization evidence.
Pi does not prove that every user-role message came directly from a human.
Do not claim stronger provenance than the API provides.

## Security order

For a model-generated Bash call, preserve this order:

1. Require valid `allow` from classifier Stage 1.
2. Require valid `allow` from classifier Stage 2.
3. If automatic approval stops, ask the human about the exact call.
4. Execute an approved call through the existing Bubblewrap runtime.

For `read`, `grep`, `write`, and `edit`, apply deterministic path policy before
the classifier. Use only deterministic path policy for `find` and `ls`.
For a direct write, ask for user approval when policy requires it.
For `sandbox_access`, use deterministic grant validation and user approval.
A user approval does not skip Bubblewrap.

Trusted `user_bash` and `/sandbox-test` bypass classifier calls.
They still use Bubblewrap.

## Ownership and dependency direction

### Filesystem and runtime

- `types.ts` defines branded policy, grants, capabilities, operations, classifier
  configuration, and status types.
- `policy.ts` alone canonicalizes paths, compiles policy, and calculates effective
  access.
- `layout.ts` owns fixed trusted host paths and namespace destinations.
- `grants.ts` alone validates and constructs approved write grants.
- `capabilities.ts` alone validates runtime resources, private temporary storage,
  inherited SSH agent state, and capability-coupled environment values.
- `mount-plan.ts` consumes compiled policy, approved grants, and runtime
  capabilities. It emits deterministic mount operations.
- `runtime.ts` owns the private resource tree, Bubblewrap process creation,
  cancellation, timeout, reaping, and cleanup.

### Authorization and classifier

- `approval.ts` owns the shared parent and subagent approval broker.
- `direct-gate.ts` identifies direct Pi filesystem tools. Keep it deterministic.
- `safety-policy.ts` owns prompts, risk categories, structured decision
  contracts, fixed limits, and semantic decision validation.
- `safety-evidence.ts` alone reads the active branch and builds bounded evidence.
  It also owns canonical serialization and action digests.
- `classifier-provider.ts` alone resolves Pi models and authentication and invokes
  one classifier stage through Pi's provider implementation.
- `classifier.ts` owns pair availability, two-stage conjunction, and technical
  fallback.
- `safety-gate.ts` owns Bash authorization and single-use execution permits.
- `session.ts` composes configuration, runtime, grants, approval, classifier,
  and lifecycle state. Do not put provider-specific policy in this file.
- `commands.ts` formats status and starts the native test command.
- `index.ts` only registers Pi surfaces and delegates to owners.

Dependencies flow from lifecycle and registration modules to narrow owners.
Do not import classifier modules from `policy.ts`, `layout.ts`, `grants.ts`,
`capabilities.ts`, `mount-plan.ts`, or `runtime.ts`.
Do not move feature logic into `index.ts`.

## Filesystem invariants

The mount plan starts with a read-only host root.
It uses fresh `/dev` and `/proc`.
The most specific filesystem rule wins.
Mount operations run broad-to-narrow.
Required parent remounts run deepest-first.

A `none` rule is final.
A grant cannot override it.
A runtime capability cannot override an exact veto unless the documented closed
capability construction explicitly defines that behavior.

For denied parents with allowed children, use an empty scaffold and exact child
binds.
Never bind a broad host parent to expose one child.
Never use a writable parent overlay to bypass policy.

Validate trusted resources and enabled sockets immediately before each spawn.
A changed type must fail that spawn.
Keep child environment values coupled to the capability used by the mount plan.

## Grant invariants

A grant applies to one canonical existing source.
Only `grants.ts` can create `ApprovedWriteGrants`.
A grant stays subordinate to `none` and protected runtime paths.
A direct write can use single-use approval without creating a session grant.
A persistent grant requires explicit user approval.

`sandbox_access` defaults to `exact` scope.
Use exact scope only for content changes to an existing path.
Use parent scope for create, delete, rename, or move operations.
Parent scope derives the parent from the requested target before canonical path
validation.
The requested target can be missing, but the parent mount source must exist.
Never widen an exact request to its parent automatically.
The human prompt must show the requested target, selected scope, and resolved
grant path.
An exact file bind is an active mount point.
Linux can return `EBUSY` when a command deletes or renames it.
A later parent grant cannot remove that exact mount during the session.

The approval broker serializes requests.
A child session cannot approve its own request.
A child request fails closed without an interactive parent owner.
Render forwarded approval as a focused overlay so it remains visible above a
child conversation viewer. Overlay state is a display control only. It must not
grant access or affect validation.
Lifecycle changes invalidate stale approval results.

An explicit parent `--no-sandbox` flag is process-wide.
Propagate it to subagent sessions through opaque `globalThis` state with a
versioned `Symbol.for` key.
Do not let a child session re-enable the sandbox after the parent CLI opt-out.
Keep this marker monotonic until process exit.

## SSH capability invariants

`sshAgent` is global-only and defaults to `true`.
Project configuration must reject this field.

When enabled, accept only the exact canonical inherited socket.
Do not scan directories.
An exact policy `none` on the socket is a startup veto.
An inherited denied parent can use scaffold directories for the exact socket.
Do not expose sibling paths.

When disabled, remove `SSH_AUTH_SOCK` and mask an inherited visible socket.
The socket is read-only as a mount but permits IPC operations.
Document that child processes can request authentication and signatures.

Keep the generated `/etc/ssh/ssh_config` read-only.
Keep its source inode hidden inside the trusted resource root.
Do not copy or interpret the host system SSH include graph.

## Classifier model invariants

The default ordered pairs are:

1. `google/gemini-3.5-flash-lite` with `minimal`, then
   `google/gemini-3.6-flash` with `low`.
2. `openai/gpt-5.4-nano` with `none`, then
   `openai/gpt-5.4-mini` with `low`.

The arrow is stage order.
It is not fallback between individual models.
Each pair has one provider and two stages.
Both valid approvals must come from one complete pair.

Defaults are not a model allowlist.
Global trusted configuration can replace the list with arbitrary Pi-available
same-provider pairs and reasoning levels.
A configured list replaces all defaults.
Project configuration cannot set classifier options.

Use Pi's model registry and Pi provider implementations.
Resolve request authentication through Pi for each request.
Forward Pi's API key, headers, environment, and base URL as required by the
provider interface.
Do not add provider SDKs.
Do not add API-key configuration.
Do not read credentials directly from environment variables or auth files.
Do not implement provider HTTP payloads with `fetch`.

Startup availability checks must not make inference requests.
If no complete pair is available, keep Bubblewrap operational.
Warn the user and require human review for model-generated Bash calls.
Recheck availability at request time.

Fallback is for technical failure only.
Examples include a missing model, unavailable authentication, or provider
transport failure.
A fallback pair starts again at Stage 1.
Discard partial approval from a failed pair.
Never fall back after a valid `review`, invalid structured output, refusal,
timeout, or cancellation.
Send all non-cancellation blocked results to the shared human approval channel.
A human allow creates a single-use approval for one exact Bash call.
It does not create a write grant or change Bubblewrap policy.

## Evidence invariants

Evidence construction belongs only in `safety-evidence.ts`.
Do not parse a shell command to find files or infer authorization.
Do not read a referenced script or repository file for classification.
Do not include tool-result content.
Do not treat assistant content or prior actions as authorization.

Use the active session branch.
Keep only bounded user-role text, current action data, bounded prior action data,
and omission counts.
Do not silently truncate the current action.
Block values that are too large, cyclic, non-JSON, or otherwise unsafe to
serialize.
Use stable key ordering for the action digest.

Never log or persist these values:

- Raw evidence.
- Tool arguments.
- Credentials or auth headers.
- Raw provider responses.
- Classifier reasoning.
- Provider errors that can contain request data.

Diagnostics can contain provider and model labels, stage number, and a normalized
outcome category. Keep semantic reasons out of persistent status and logs.

## Decision invariants

Automatic execution requires Stage 1 `allow` and Stage 2 `allow`.
Any other non-cancellation result requires human review.
Cancellation blocks the action.

Require exactly one correctly named decision tool call or equivalent strict Pi
structured result.
Reject prose answers, extra fields, multiple calls, unknown enums, incomplete
output, and oversized fields.
Require a bounded concise reason from both classifier stages.
Reject Stage 2 `allow` when severity or risks contradict the decision.
Never execute a classifier-generated tool call.
Never store its reasoning.
Show only the validated semantic decision reason in the human review prompt.

## Tool-call and permit invariants

Classify model-generated `bash`, `read`, `grep`, `write`, and `edit` tool calls.
Use deterministic path policy before direct-tool classification.
Use only deterministic path policy for `find` and `ls`.
Keep the existing user approval flow for direct writes and `sandbox_access`.
Combine secret review and direct write approval in one prompt when both apply.

Direct-tool classifier evidence must never contain file content, grep patterns,
edit text, write payloads, raw tool output, or absolute outside-project paths.
Use project-relative path metadata, byte counts, and local boolean indicators.
Omit prior action payloads from direct-tool evidence.
Use a local exact-input digest only for permit integrity.
Never send that digest as a substitute for secret semantics.
Document that path-only detection cannot find all secrets in ordinary files.

Pi tool-call input is mutable.
For extension-owned `bash`, `read`, `grep`, `write`, and `edit`, create a
single-use permit after two classifier allows or one explicit human review
approval.
The permit must cover tool call ID, tool name, canonical final input, working
directory, and lifecycle generation.
Wrap each classified built-in tool and consume the permit immediately before
execution.
Reject a missing, changed, expired, or reused permit.
Clear all permits on session start and shutdown.

## Configuration invariants

Parse configuration strictly.
Reject unknown fields and invalid types.
Compile all filesystem paths before runtime use.
Project configuration can modify only permitted project-scoped settings.
Reject project `sshAgent` and `classifier` fields even for trusted projects.

An omitted classifier pair list uses defaults.
An explicit list replaces defaults.
Reject an empty list.
Use explicit global `enabled: false` to disable classification.
Show a warning when classification is disabled.
Do not disable Bubblewrap when only classification is disabled or unavailable.

## Test rules

Use the native harness under `tests/`.
Import each test module from `tests/run.ts`.
Keep `/sandbox-test` as the single test command.
Do not add a separate regression suite or runner.

Use injected filesystem inspectors, model registries, provider calls, clocks, and
approval channels.
Unit tests must not require Bubblewrap.
Unit tests must never contact a live model provider.

Add unit tests for every new branch.
Classifier tests must cover:

- Strict configuration and scope.
- Default and custom pair selection.
- Missing and partial pairs.
- Pi authentication resolution.
- Two valid allows.
- Stage 1 and Stage 2 review.
- Invalid output, refusal, timeout, and cancellation.
- Technical fallback from either stage.
- Restart of fallback at Stage 1.
- No fallback after semantic failure.
- Evidence trust boundaries and byte limits.
- Stable digests and unsupported values.
- `find` and `ls` bypassing classifier invocation.
- Direct secret evidence omitting content, queries, edit text, and payloads.
- Deterministic direct-path denial before classifier invocation.
- Classified read, grep, write, and edit automatic allows and human review.
- Combined direct write and secret review without duplicate prompts.
- Exact and parent grant scope selection.
- Missing targets with existing parents.
- Parent scope under `none` and protected runtime paths.
- Bash permit integrity and classifier ordering.
- Permit consumption, mutation, reuse, and lifecycle invalidation.
- Unavailable startup warning and human review behavior.
- Single-use human review permits and human denial.
- User Bash and native test bypass.

Keep the shell integration test focused on real Bubblewrap behavior.
Do not add provider calls to it.
A live containment claim requires a successful integration run on the target
system.

## Required review checklist

Before you finish a security change, answer these questions:

- Which module owns the decision or resource?
- Is it policy, a grant, a runtime capability, or classifier logic?
- What is the configuration scope and default?
- How do exact and inherited `none` rules apply?
- What are the mount source, destination, source type, access mode, and order?
- Which child environment values depend on the capability?
- What happens when state is missing, invalid, changed, or unavailable?
- Can the classifier disclose action data to a provider?
- Can fallback reinterpret a valid review?
- Which native unit tests prove each branch?
- Which integration check proves actual runtime behavior?
- Do all documentation and status surfaces agree?

## Prohibited patterns

Do not add:

- Shell or Git parsing to decide mounts.
- Command regex allowlists or bypass lists.
- Classifier-created policy, grants, mounts, or capabilities.
- Mixed-provider approvals inside one pair.
- Semantic fallback after `review`.
- Direct provider credential management.
- Provider-specific HTTP request construction.
- Raw evidence or provider-response logging.
- Repository-file ingestion into classifier evidence.
- Raw direct read, grep, write, or edit content in classifier evidence.
- Duplicated protected-path or capability checks.
- Writable parent overlays.
- Automatic widening from exact grant scope to parent scope.
- Test fixtures in startup code.
- Paid startup probes or paid tests.
- Feature policy in `index.ts`.
- Runtime security claims without an integration result.
