# Bubblewrap Sandbox Agent Guide

Read `README.md` completely before you modify this extension.
The README is the authoritative architecture and threat model.
Keep the implementation, README, root user documentation, status output, and tests consistent.

## System purpose

This extension has four security layers:

1. A deterministic filesystem policy.
2. A Linux Bubblewrap mount and process boundary.
3. Human-approved session write grants and exact one-shot write paths.
4. One classifier reviewer for model-generated Bash calls.

Bubblewrap is the primary boundary.
The classifier is defense in depth.
No classifier result can select or widen policy, capabilities, grants, or runtime validation.
A valid safe decision can authorize only the explicit prevalidated one-shot mount path in the same envelope.

The extension also checks Pi file tools that run in the host process.
These checks are application-level permission logic.
They are not OS containment.

## Trust boundaries

Trust the Pi host process, extension code, trusted configuration, root-owned Bubblewrap executable, and the user who answers approval requests.
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

1. Require one valid `allow` with `safe` severity and no risks from the configured reviewer.
2. If automatic approval stops, ask the human about the exact call.
3. Execute an approved call through the existing Bubblewrap runtime.

For `read`, `grep`, `write`, and `edit`, apply deterministic path policy before local secret checks.
Require human review when a known secret path, secret-seeking grep pattern, potential secret payload, or incomplete payload scan applies.
Keep secret-path rules limited to high-confidence credential stores and secret-specific filenames.
Scan every structured edit replacement and the legacy single-replacement shape.
Allow a clean and complete local assessment without provider inference.
Use only deterministic path policy for `find` and `ls`.
For a direct write, ask for user approval when policy requires it.
For `sandbox_access`, require an explicit path and scope and use deterministic grant validation.
Session mode defaults to the existing human-approved persistent grant flow.
One-shot mode requires complete Bash input.
Classify one envelope with that exact input, canonical write path, explicit scope, and one-shot disposition.
Use only recent user-role messages as authorization evidence and omit prior actions from this envelope.
Automatic one-shot access requires classifier state `ready` and one valid safe reviewer decision.
All non-allow outcomes use one human prompt for the exact call and path.
The classifier must not select, infer, or widen the path.
A user or classifier approval does not skip Bubblewrap.

Trusted `user_bash` and `/sandbox-test` bypass classifier calls.
They still use Bubblewrap.

Read-only local inspection is routine.
Do not make the classifier review `git status`, `git diff`, `git diff --check`, `git diff --stat`, `git log`, `git show`, or `git rev-parse` only because the repository contains sensitive code or history, or because a later separate action may push.
Treat read-only `gh search code`, `gh search commits`, `gh search issues`, `gh search prs`, and `gh search repos` as routine when the complete action has no other risk.
Keep review for a search query that transmits credentials, project secrets, or proprietary source code to GitHub.
Treat reads restricted to `PI_CODING_AGENT`, `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` as routine session-metadata inspection.
This includes exact `env | rg '^PI_'`-style reads.
Do not extend this rule to arbitrary environment dumps, provider credential variables, or reading the file named by `PI_SESSION_FILE`.
Allow bounded scratch writes under the compiled active sandbox directory when they only process public or local read-only research data and do not modify project files, external services, credentials, or secrets.
Treat read-only research as a restriction on project and external mutation, not on temporary scratch processing, unless the user explicitly forbids temporary files.
Classify the exact current command.
Treat standalone `git fetch origin` as routine.
Treat standalone `git pull --ff-only` as routine when it uses the configured upstream or literal `origin` remote.
Permit the classifier to allow a narrowly scoped mutation when a recent explicit user-role message clearly authorizes the exact action, effects, and destination.
For example, a request to commit and push the current changes can authorize an ordinary matching commit and push to the configured upstream.
The latest applicable user instruction controls, and all effects in a chained action must be authorized.
Keep review for secret access or disclosure, unexpected destinations, broad destruction, force pushes and other important history rewriting, privilege escalation, persistence, security weakening, untrusted code execution, and evasion.
Keep review for explicit URLs, custom refspecs, Git configuration overrides, custom transports, recursive submodule updates, non-fast-forward merges, rebases, and unauthorized effects.
Do not infer execution of a local hook or filter without concrete evidence from the proposed action or a completed action on which it depends.
Keep review for other Git commands that change files, refs, hooks, remotes, or external services when recent user authorization does not clearly cover them.

## Ownership and dependency direction

### Filesystem and runtime

- `types.ts` defines branded policy, grants, capabilities, operations, classifier configuration, and status types.
- `policy.ts` alone canonicalizes paths, compiles policy, and calculates effective access.
- `layout.ts` owns fixed trusted host paths and namespace destinations.
- `grants.ts` alone validates and constructs approved write grants.
- `capabilities.ts` alone validates runtime resources, private temporary storage, inherited SSH agent state, and capability-coupled environment values.
- `mount-plan.ts` consumes compiled policy, approved grants, optional transient write paths, and runtime capabilities. It emits deterministic mount operations.
- `runtime.ts` owns immediate transient-path revalidation, the private resource tree, Bubblewrap process creation, cancellation, timeout, reaping, and cleanup.

### Authorization and classifier

- `approval.ts` owns the shared parent and subagent approval broker.
- `direct-gate.ts` identifies direct Pi filesystem tools. Keep it deterministic.
- `direct-secret-evidence.ts` owns deterministic direct metadata, secret indicators, and review reasons.
- `safety-policy.ts` owns Bash classifier prompts, risk categories, structured decision contracts, fixed limits, and semantic decision validation.
- `safety-evidence.ts` alone reads the active branch and builds bounded evidence. It also owns canonical serialization and action digests.
- `classifier-provider.ts` alone resolves the configured Pi model and authentication and invokes the reviewer through Pi's provider implementation.
- `classifier.ts` owns reviewer availability and the single-decision state machine.
- `safety-gate.ts` owns Bash authorization, exact future Bash tickets, and single-use execution permits.
- `session.ts` owns transient future and claimed one-shot write records. It composes configuration, runtime, grants, approval, classifier, and lifecycle state. Do not put provider-specific policy in this file.
- `commands.ts` formats status and starts the native test command.
- `index.ts` only registers Pi surfaces and delegates to owners.

Dependencies flow from lifecycle and registration modules to narrow owners.
Do not import classifier modules from `policy.ts`, `layout.ts`, `grants.ts`, `capabilities.ts`, `mount-plan.ts`, or `runtime.ts`.
Do not move feature logic into `index.ts`.

## Filesystem invariants

The mount plan starts with a read-only host root.
It uses fresh `/dev` and `/proc`.
The most specific filesystem rule wins.
Mount operations run broad-to-narrow.
Required parent remounts run deepest-first.

A `none` rule is final.
A grant cannot override it.
A runtime capability cannot override an exact veto unless the documented closed capability construction explicitly defines that behavior.

For denied parents with allowed children, use an empty scaffold and exact child binds.
Never bind a broad host parent to expose one child.
Never use a writable parent overlay to bypass policy.

Validate trusted resources, enabled sockets, and a consumed transient write source immediately before each spawn.
Reapply canonical source, existing-source, `none`, and protected-runtime checks to each transient path.
A changed path or type must fail that spawn.
Keep child environment values coupled to the capability used by the mount plan.

## Grant invariants

A grant applies to one canonical existing source.
Only `grants.ts` can create `ApprovedWriteGrants`.
A grant stays subordinate to `none` and protected runtime paths.
A direct write can use single-use approval without creating a session grant.
A persistent grant requires explicit user approval.
A combined proactive approval can create one validated persistent grant and one exact future Bash ticket.
Keep the grant and ticket as separate authorization records with independent validation.
A one-shot request creates no persistent grant.
After automatic or human authorization, create two independent transient records: an exact future Bash ticket and one canonical write path.
Bind both records to the complete Bash input, including timeout, working directory, and lifecycle generation.
Only the exact next model-generated Bash call can claim them.
Consume the claimed path before execution and pass it only to the mount plan for that spawn.
Do not add it to `ApprovedWriteGrants` or session status.
A changed call, reuse, or lifecycle change must receive no transient path and must use normal Bash authorization.
Direct file tools and `user_bash` cannot claim one-shot access.

`sandbox_access` session mode defaults to `exact` scope.
One-shot mode requires an explicit scope.
Use exact scope only for content changes to an existing path.
Use parent scope for create, delete, rename, or move operations.
Parent scope derives the parent from the requested target before canonical path validation.
The requested target can be missing, but the parent mount source must exist.
Never widen an exact request to its parent automatically.
The human prompt must show the requested target, selected scope, and resolved grant path.
An exact file bind is an active mount point.
Linux can return `EBUSY` when a command deletes or renames it.
A later parent grant cannot remove that exact mount during the session.

The approval broker serializes requests.
A child session cannot approve its own request.
A child request fails closed without an interactive parent owner.
Render forwarded approval as a focused overlay so it remains visible above a child conversation viewer.
Overlay state is a display control only.
It must not grant access or affect validation.
Lifecycle changes invalidate stale approval results.

An explicit parent `--no-sandbox` flag is process-wide.
Propagate it to subagent sessions through opaque `globalThis` state with a versioned `Symbol.for` key.
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

The default reviewer is exactly `openai/gpt-5.6-luna` with `low` reasoning.
Use one reviewer request and one structured decision.
Do not use a second reviewer or any model fallback.

Global trusted configuration can replace the reviewer with an arbitrary Pi-available provider, model, and reasoning level.
Project configuration cannot set classifier options.

Use Pi's model registry and Pi provider implementations.
Resolve request authentication through Pi for each request.
Forward Pi's API key, headers, environment, and base URL as required by the provider interface.
Do not add provider SDKs.
Do not add API-key configuration.
Do not read credentials directly from environment variables or auth files.
Do not implement provider HTTP payloads with `fetch`.

Startup availability checks must not make inference requests.
If the configured model, provider, or authentication is unavailable, keep Bubblewrap operational.
Warn the user and require human review for model-generated Bash calls.
Tell the user that the automatic reviewer is unavailable and that they can configure `classifier.reviewer` globally.
Recheck availability at request time.
A technical call failure uses the same unavailable reason and human review path.
A valid `review`, invalid structured output, refusal, timeout, or cancellation cannot use another model.
Send blocked non-cancellation results to the shared human approval channel.
A human allow creates a single-use approval for one exact Bash call.
It does not create a write grant or change Bubblewrap policy.

## Evidence invariants

Evidence construction belongs only in `safety-evidence.ts`.
Do not parse a shell command to find files or infer authorization.
Do not read a referenced script or repository file for classification.
Do not include tool-result content.
Do not treat assistant content or prior actions as authorization.

Use the active session branch.
Keep only bounded user-role text, bounded trusted classifier context, current action data, bounded prior action data, and omission counts.
If all bounded user messages fit, keep all of them in branch order.
Otherwise, retain the first and latest messages, then add the newest interior messages that fit, and output the selection in branch order.
Keep per-message truncation markers and omission counts.
Keep user messages in branch order so the classifier can apply the latest explicit authorization or restriction.
Never use assistant text, prior actions, repository content, or tool output as authorization.
Treat bounded prior structured actions as untrusted context.
Treat a bounded user message with an omission marker as incomplete and not sufficient for authorization.
Include the compiled active sandbox directory as bounded trusted classifier context when it exists.
Do not include this context in action digests.
Do not silently truncate the current action.
Block values that are too large, cyclic, non-JSON, or otherwise unsafe to serialize.
Use stable key ordering for the action digest.

Never log or persist these values:

- Raw evidence.
- Tool arguments.
- Credentials or auth headers.
- Raw provider responses.
- Classifier reasoning.
- Provider errors that can contain request data.

Diagnostics can contain the provider and model label and a normalized outcome category.
Keep semantic reasons out of persistent status and logs.

## Decision invariants

Automatic execution requires one `allow` decision with `safe` severity and no risks.
Any other non-cancellation result requires human review.
Cancellation blocks the action.

Require exactly one correctly named decision tool call or equivalent strict Pi structured result.
Require `decision`, `severity`, `risks`, and a bounded concise `reason`.
Reject prose answers, extra fields, multiple calls, unknown enums, incomplete output, oversized fields, and contradictory allows.
An explicitly authorized mutation can be safe only when its exact effects are covered and no unaddressed risk remains.
Never execute a classifier-generated tool call.
Never store its reasoning.
Show only the validated semantic decision reason in the human review prompt.

## Tool-call and permit invariants

Classify only model-generated Bash tool calls with the single model reviewer.
Use deterministic path policy and local secret checks for `read`, `grep`, `write`, and `edit`.
Use only deterministic path policy for `find` and `ls`.
Keep the existing user approval flow for direct writes and `sandbox_access`.
Preserve exact permit binding and consumption.
Combine deterministic secret review and direct write approval in one prompt when both apply.
For proactive session Bash access, classify the exact future Bash input before the prompt, validate the grant independently, and bind one future ticket to the exact input, working directory, and lifecycle.
For one-shot Bash access, keep the future Bash ticket and transient path independent and bind both to the same exact call.
A changed or reused future call must use normal classification.

Direct-tool assessment must stay local and deterministic.
Use project-relative path metadata, byte counts, scan completeness, and local boolean indicators.
Never send direct-tool metadata, file content, grep patterns, edit text, write payloads, or raw tool output to a provider.
Never treat outside-project scope as a review reason without a concrete local indicator.
Use a local exact-input digest only for permit integrity.
Document that path-only detection cannot find all secrets in ordinary files.

Pi tool-call input is mutable.
For extension-owned Bash, create a single-use permit after one valid safe reviewer decision or one explicit human review approval.
For extension-owned `read`, `grep`, `write`, and `edit`, create a single-use permit after a clean deterministic assessment or one explicit human review approval.
The permit must cover tool call ID, tool name, canonical final input, working directory, and lifecycle generation.
Wrap each protected built-in tool and consume the permit immediately before execution.
Reject a missing, changed, expired, or reused permit.
Clear all permits, future tickets, transient paths, and claimed one-shot records on session start and shutdown.

## Configuration invariants

Parse configuration strictly.
Reject unknown fields and invalid types.
Compile all filesystem paths before runtime use.
Project configuration can modify only permitted project-scoped settings.
Reject project `sshAgent`, `sandboxDirectory`, and `classifier` fields even for trusted projects.
The global `sandboxDirectory` defaults to `~/sandbox` and adds one optional writable directory when it exists.
Omit this generated rule when the directory is missing, but keep explicit writable filesystem rules strict.
Keep the installed Pi package path `~/.local/lib/pi` explicitly read-only by default when it exists.

An omitted `classifier.reviewer` uses the default Luna reviewer.
An explicit reviewer replaces the default.
Require a non-empty provider and model and a supported reasoning level.
Use explicit global `enabled: false` to disable classification.
Show a warning when classification is disabled.
Do not disable Bubblewrap when only classification is disabled or unavailable.

## Test rules

Use the native harness under `tests/`.
Import each test module from `tests/run.ts`.
Keep `/sandbox-test` as the single test command.
Run it directly as a Pi command in the current session.
Do not launch a nested `pi` process through the Bash tool and do not create a temporary test runner.
Use `/sandbox-test live` only when the task requires the explicit live reviewer check.
An optional Bun syntax build is also permitted after source changes:

```bash
rm -rf "$HOME/sandbox/bwrap-build" && bun build extensions/bwrap-sandbox/index.ts --target=node --packages=external --outdir "$HOME/sandbox/bwrap-build"
```

Keep generated build output under this dedicated child of the configured sandbox directory.
Do not use the syntax build as a replacement for `/sandbox-test`.
The command invokes the native suite and shell containment check through the trusted test path, so the test harness does not enter the model-generated Bash classifier.
Live classifier scenarios still make their intentional provider calls.
Do not add a separate regression suite or runner.
Do not add one-off regression tests for implementation details or isolated edge cases.
Keep tests focused on basic security behavior, and extend an existing focused test when that behavior must change.

Use injected filesystem inspectors, model registries, provider calls, clocks, and approval channels when isolation is useful.
Unit tests must not require Bubblewrap.
Unit tests can contact live model providers when they test provider compatibility or classifier behavior.
Use Pi model resolution, authentication, and provider implementations for live tests.
Never add separate provider credentials or direct provider HTTP code for tests.
Keep live tests explicit, lean, and separate from shell containment checks.
Call only the configured reviewer.
Use one explicitly authorized ordinary commit-and-push scenario that must return a safe allow.
Use one synthetic credential-exfiltration scenario that must return review.
Do not call another model after any result.
Treat an unavailable reviewer, technical failure, semantic mismatch, invalid structured output, timeout, and cancellation as test failures.

Add focused unit coverage for new basic security behavior.
Classifier tests must cover:

- Strict configuration and scope.
- Default and custom reviewer selection.
- Missing model, provider, and authentication behavior.
- One valid safe allow and semantic review.
- Invalid output, refusal, timeout, cancellation, and technical failure.
- No model fallback.
- Evidence trust boundaries and byte limits.
- Stable digests and unsupported values.
- `find` and `ls` bypassing classifier invocation.
- Direct metadata omitting content, queries, edit text, and payloads.
- Common high-confidence credential paths and explicit template exemptions.
- Every structured edit replacement and the legacy edit shape.
- Deterministic direct-path denial before secret assessment.
- Deterministic read, grep, write, and edit automatic allows and human review.
- Direct tools making no classifier provider calls.
- Combined direct write and secret review without duplicate prompts.
- Exact and parent grant scope selection.
- Session mode default and one-shot mode Bash requirement.
- One-shot envelope, ready-reviewer requirement, human fallback, and no persistent grant.
- One-shot ticket and path claim, consumption, mutation, reuse, lifecycle, and direct-tool isolation.
- Missing targets with existing parents.
- Parent scope under `none` and protected runtime paths.
- Bash permit integrity and classifier ordering.
- Narrow automatic approval for origin fetches and fast-forward pulls.
- Review boundaries for remote, refspec, configuration, transport, submodule, merge, rebase, and chained variants.
- Permit consumption, mutation, reuse, and lifecycle invalidation.
- Unavailable startup warning and human review behavior.
- Single-use human review permits and human denial.
- User Bash and native test bypass.

Keep the shell integration test focused on real Bubblewrap behavior.
Do not add provider calls to it.
A live containment claim requires a successful integration run on the target system.

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
- Does every unavailable reviewer path fail closed without model fallback?
- Which native unit tests prove each branch?
- Which integration check proves actual runtime behavior?
- Do all documentation and status surfaces agree?

## Prohibited patterns

Do not add:

- Shell or Git parsing to decide mounts.
- Command regex allowlists or bypass lists.
- Classifier-selected paths or classifier-created policy, persistent grants, or capabilities.
- Multiple reviewer conjunctions.
- Classifier model fallback.
- Direct provider credential management.
- Provider-specific HTTP request construction.
- Raw evidence or provider-response logging.
- Repository-file ingestion into classifier evidence.
- Provider inference for structured direct file operations.
- Duplicated protected-path or capability checks.
- Writable parent overlays.
- Automatic widening from exact grant scope to parent scope.
- Test fixtures in startup code.
- Paid startup probes.
- Feature policy in `index.ts`.
- Runtime security claims without an integration result.
