# Bubblewrap sandbox architecture

## Purpose

This extension protects the host from commands that Pi runs on Linux.
Bubblewrap is the primary security boundary.
It gives each Bash process a restricted mount namespace.

The extension also checks Pi file tools in the host process.
It asks the user before it adds a session write grant.
It can use a two-stage model classifier before model-generated Bash and direct content-access calls.
The classifier is an additional check.
It does not replace Bubblewrap or user approval.

## Security goals

The extension has these goals:

- Start each Bash process with a read-only view of the host root.
- Apply a strict filesystem policy to selected paths.
- Hide paths that have `none` access.
- Make only approved paths writable.
- Give each session a private writable temporary directory.
- Optionally isolate the network.
- Support one exact inherited SSH agent socket when the user enables it.
- Check direct Pi file tools before they access the host.
- Check model-generated Bash, read, grep, write, and edit calls with two independent classifier stages.
- Fail closed when a required security check cannot finish.

The extension is not a confidentiality boundary.
Unmatched host files are readable.
Child processes inherit environment values.
Network access is available when network isolation is off.
An enabled SSH agent can sign or authenticate with its loaded keys.

## Trust model

The extension trusts these components:

- The Pi host process.
- This extension code.
- Trusted global configuration.
- Trusted project filesystem configuration.
- The root-owned Bubblewrap executable.
- The user who answers an approval request.
- Providers, models, and authentication that Pi registers.

The extension does not trust these inputs:

- Sandboxed commands and their child processes.
- Assistant text and reasoning.
- Model-generated tool arguments.
- Repository files, comments, and scripts.
- Prior model actions.
- Tool output.
- Classifier output until local validation succeeds.

Only user-role messages can supply authorization evidence to the classifier.
Pi cannot always prove that a human typed a user-role message.
This is a provenance limit of the Pi extension API.

## Authorization order

A model-generated Bash call passes through these controls:

1. Classifier Stage 1 must return a valid `allow` decision.
2. Classifier Stage 2 must return a valid `allow` decision.
3. If automatic approval stops, the human can create a single-use approval for the exact call.
4. Bubblewrap builds the mount plan and starts the Bash process.

Direct `read`, `grep`, `write`, and `edit` calls use deterministic path policy first.
They then use privacy-safe project-secret classification.
Direct `find` and `ls` calls use only deterministic path policy.
A direct write also uses the existing write approval flow when required.
A `sandbox_access` request uses deterministic grant validation and user approval.

Each control is independent.
Automatic execution of a classified call requires two classifier `allow` decisions.
A human review approval is single-use and applies to one exact tool call.
A classifier decision or human review approval cannot create a mount, grant, or runtime capability.
It cannot bypass a Bubblewrap error.
A user grant cannot override `none` or a protected runtime path.

User `!` and `!!` Bash commands do not come from a model tool call.
They do not use the classifier.
They still run through Bubblewrap.
The `/sandbox-test` command also bypasses classifier inference.
This prevents paid calls during tests.

Starting Pi with `--no-sandbox` disables this extension for the parent session and all subagent sessions in the same Pi process.
Subagents do not receive a separate active sandbox when the parent explicitly selected this CLI opt-out.
The process-wide marker is monotonic and clears only when the Pi process exits.

## Filesystem policy

The extension starts with a read-only bind of host `/`.
It then applies the configured filesystem rules.
Each rule has one access value:

- `none` hides the path.
- `read` exposes the path as read-only.
- `write` exposes the path as writable.

The most specific matching path wins.
The policy compiler resolves paths to canonical absolute paths.
Invalid paths and ambiguous paths fail closed.

A session write grant applies to one canonical existing mount source.
The user must approve the grant.
A grant stays active for the current session only.
A grant does not override an effective `none` rule.
A grant does not apply to protected runtime resources.

### Grant scope

The `sandbox_access` tool has an `exact` scope and a `parent` scope.
The default scope is `exact`.
Use `exact` to change the content of an existing file or directory.
The exact path becomes a Bubblewrap bind mount.

Use `parent` to create, delete, rename, or move a directory entry.
The extension derives the parent from the requested target path.
It resolves and validates that parent as the mount source.
The target can be missing when the scope is `parent`.

Linux cannot delete or rename an active mount point.
If an exact file grant exists, delete or rename can fail with `EBUSY`.
A later parent grant does not remove the exact mount.
Reload the session to clear that exact grant.
Then request only the parent scope.

Parent scope is wider than exact scope.
The extension never selects it automatically.
The request must state the scope, and the human prompt shows the resolved grant path.
Both scopes remain subject to `none` rules and protected runtime paths.

Example for file content changes:

```json
{
  "path": "/work/config.json",
  "scope": "exact"
}
```

Example for create, delete, rename, or move:

```json
{
  "path": "/work/output/new-name.txt",
  "scope": "parent"
}
```

## Mount order

The mount plan uses this order:

1. Bind the host root as read-only.
2. Create fresh `/dev` and `/proc` mounts.
3. Install trusted runtime resource masks.
4. Apply filesystem policy mounts.
5. Apply approved session write grants.
6. Apply the private temporary directory and SSH agent capability.
7. Remount required parent paths as read-only.

The planner emits broad paths before narrow paths.
It remounts parents from the deepest path to the shallowest path.
This order keeps narrow decisions effective.

When a denied directory has an allowed child, the planner does not bind the host parent directory.
It creates an empty directory structure and binds only the allowed child.
This prevents exposure of sibling paths.

## Runtime resources

The runtime creates one mode-0700 resource directory for each session.
The directory contains:

- A private writable `tmp` directory.
- A source file that masks denied files.
- A generated OpenSSH system configuration file.

The runtime hides the resource root inside the sandbox.
Only the private `tmp` child is writable and visible.
The child environment uses the same path for `TMPDIR`, `TMP`, and `TEMP`.

The runtime validates trusted resources before each process starts.
A resource type change causes that process start to fail closed.
The runtime removes the complete resource tree during shutdown.

## SSH agent capability

The global `sshAgent` setting is `true` by default.
Project configuration cannot set this value.

When SSH agent access is enabled, the extension checks `SSH_AUTH_SOCK`.
It accepts only one existing absolute socket.
It resolves the socket to one canonical path.
It exposes only that exact socket.
It does not scan socket directories.

An exact `none` rule on the socket stops sandbox startup.
An inherited `none` rule on a parent can stay in effect.
The mount planner creates only the directory structure for the exact socket.
It does not expose socket siblings.

When SSH agent access is disabled, the extension removes `SSH_AUTH_SOCK` from the child environment.
It also masks an inherited socket that policy would otherwise expose.

An SSH agent is an IPC capability.
A process can ask the agent to authenticate or sign.
The process does not need access to private key files.
Set `sshAgent` to `false` when this capability is not acceptable.

Bubblewrap user namespaces can make host system SSH files appear to have an unmapped owner.
OpenSSH can reject those files.
The extension therefore mounts a small generated system configuration at `/etc/ssh/ssh_config`.
The mount is read-only.
User SSH configuration and known-host files remain subject to filesystem policy.

## Direct Pi file tools

Pi runs `read`, `write`, `edit`, `grep`, `find`, and `ls` in the host process.
Bubblewrap cannot contain these operations.
The extension checks their structured path arguments before execution.

The direct-tool check is application-level permission logic.
It is not OS containment.
A check-to-use race is possible.
Runtime capabilities do not widen direct-tool access.

Model-generated `read`, `grep`, `write`, and `edit` calls also use the safety classifier.
A `read` of a recognized image, audio, or video file skips classifier inference after deterministic path policy allows the resolved regular file.
The extension reads at most 4 KiB locally and checks known media signatures.
It does not trust the filename extension or send the header to a provider.
SVG, unknown, ambiguous, and unreadable files continue to use classification.
The extension creates the same exact single-use execution permit before the built-in tool runs.
The classifier receives sanitized path and operation metadata.
It never receives file content, a grep pattern, edit text, or a write payload.
High-confidence local path and payload indicators become privacy-safe classifier evidence.
The classifier decides whether they require review.
An ordinary directory `grep` is not automatically treated as sensitive.

A direct write outside current write policy uses the shared approval channel.
If safety review and write approval are both required, the extension uses one combined prompt.
The user can allow one operation or add a session grant.
A subagent cannot approve its own request.
A subagent request must use an interactive parent approval owner.
Requests fail closed when no owner is available.
A forwarded approval opens as a focused overlay above a child conversation viewer.
The prompt remains readable without access to the other extension's private overlay lifecycle.
Overlay state does not affect approval validation.

## Safety classifier

### Purpose

The classifier looks for malicious or unauthorized model-generated Bash calls.
Examples include secret disclosure, remote mutation, destructive changes, persistence, privilege escalation, and sandbox bypass attempts.
Read-only local inspection is routine.
Commands such as `git status`, `git diff`, `git diff --check`, `git diff --stat`, `git log`, `git show`, and `git rev-parse` do not require review only because the repository contains sensitive code or history, or because a later separate action may push.
Read-only `gh search code`, `gh search commits`, `gh search issues`, `gh search prs`, and `gh search repos` commands are also routine when the complete action has no other risk.
A search query that contains credentials, project secrets, or proprietary source code still requires review because it transmits that data to GitHub.
The classifier assesses the exact current action.
Git commands that change files, refs, hooks, remotes, or external services remain subject to the normal review rules.

It also reviews model-generated `read`, `grep`, `write`, and `edit` calls for project-secret access.
Reads with a recognized binary media signature are exempt from classifier inference after deterministic path policy allows the resolved regular file.
Filename extensions do not control this exception.
Deterministic policy runs before classification and can block the call without a provider request.
Direct writes and `sandbox_access` also use user approval when required.
The classifier does not check `find`, `ls`, user Bash, or other extension tools.

### Default model pairs

The extension uses an ordered list of complete pairs.
Each pair uses one provider for both stages.

The first default pair is Google:

- Stage 1: `google/gemini-3.5-flash-lite` with `minimal` reasoning.
- Stage 2: `google/gemini-3.6-flash` with `low` reasoning.

The second default pair is OpenAI:

- Stage 1: `openai/gpt-5.4-nano` with `none` reasoning.
- Stage 2: `openai/gpt-5.4-mini` with `low` reasoning.

Google is the preferred default.
OpenAI is the default technical fallback.
The extension does not combine stages from different pairs.

### Custom model pairs

The default pairs are recommendations.
They are not an allowlist.
A user can replace them in global configuration.
Each custom pair must specify one provider, two model IDs, and two reasoning levels.
The models must exist in the Pi model registry.
The provider must support the configured reasoning levels.

The extension uses Pi authentication and Pi provider transports.
It does not store API keys.
It does not read provider credentials directly.
It does not add Google or OpenAI SDKs.

Project configuration cannot set classifier options.
Repository content must not select the security reviewer.

### Pair selection and fallback

At startup, the extension checks the model registry and authentication state.
This check does not make an inference request.
The first complete available pair becomes the preferred pair.

If no complete pair is available, Bubblewrap still starts.
The extension shows a warning.
The warning tells the user to configure a complete pair.
When the classifier is unavailable, model-generated Bash and classified direct tool calls require human review.
User Bash and `/sandbox-test` continue to use Bubblewrap.

The extension resolves availability again for each action.
It starts with the first available configured pair.

A pair succeeds only when both stages return valid `allow` decisions.
A valid `review` stops automatic approval.
Invalid output, refusal, timeout, or exhausted technical failure also stops automatic approval.
These results open the shared human review prompt for the exact classified call.
Cancellation blocks the call without a new prompt.

A technical provider or model failure can cause fallback to the next pair.
The next pair always starts at Stage 1.
The extension discards a partial approval from the failed pair.
If all pairs fail, the call requires human review.
A human allow creates one single-use exact-call permit.
It does not create a filesystem grant.
A human denial blocks the call.

### Evidence

Classifier evidence is bounded.
Bash evidence can contain:

- Recent user-role text messages from the active branch.
- The current tool name.
- The complete current structured input.
- The project working directory.
- A bounded list of completed prior structured actions.
- Counts for omitted historical items.

Direct-tool evidence contains recent user-role text and sanitized action metadata.
It states that deterministic path policy passed.
It can contain the operation, project-relative target path, basename, extension, path kind, numeric read range, payload byte count, bounded-scan completeness, and local boolean indicators.
It omits prior action payloads.

Direct-tool evidence never contains file content, grep patterns, edit text, write payloads, absolute outside-project paths, or raw tool output.
An outside-project scope is not a review reason by itself.
A local digest binds approval to the complete exact input but is not sent to the provider.

The evidence labels the current proposal separately from completed prior actions.
Completed prior actions are context and are not part of the proposed action.
The classifier uses them only when the proposed action explicitly executes or depends on an artifact from them.

The evidence does not contain tool-result content.
The extension does not read a referenced script for classification.
It does not treat assistant text or completed prior actions as authorization.

The extension can omit old history with an explicit marker.
It does not silently truncate the current action.
An action that is too large or cannot be serialized is blocked locally.

A Bash action itself can contain a secret or proprietary value.
Sending that Bash action to a classifier provider can disclose that value.
A generic redactor cannot preserve all security meaning.
Users must consider this limit when they select classifier providers.

Direct-tool classification does not inspect file content and cannot detect a secret in an ordinary path such as `notes.txt` with certainty.
Filename and payload indicators reduce risk but do not provide a complete content secret scanner.

### Decisions

Stage 1 returns `allow` or `review` with a short reason.
Stage 2 returns the decision, severity, risk categories, and a short reason.
The extension validates all fields locally.
It rejects unknown fields, multiple decisions, prose in place of a decision, contradictory allows, and incomplete output.

The extension does not execute classifier tool calls.
It does not store classifier reasoning.
A human review prompt shows the validated, bounded reason for a semantic Stage 1 or Stage 2 decision.
Technical failures use normalized local text.
Diagnostics contain only provider and model labels, stage numbers, and normalized outcome categories.
Status does not retain decision reasons.

### Execution permits

The `tool_call` input is mutable.
A later extension can change it after this extension checks it.
For extension-owned `bash`, `read`, `grep`, `write`, and `edit`, the extension creates a single-use permit after two classifier allows or one explicit human review approval.
The extension wraps these built-in tools so approval and execution have the same integrity check.
The permit covers the tool call ID, tool name, final input, working directory, and lifecycle generation.
The tool consumes the permit immediately before execution.
A missing, changed, expired, or reused permit fails closed.

## Configuration

Global configuration path:

```text
~/.pi/agent/extensions/sandbox.json
```

Trusted project configuration path:

```text
.pi/sandbox.json
```

Example global configuration:

```json
{
  "enabled": true,
  "isolateNetwork": false,
  "sshAgent": true,
  "filesystem": {
    ":project": "write",
    ":project/.git": "read",
    "~/.ssh": "none",
    "~/.ssh/config": "read",
    "~/.ssh/known_hosts": "read",
    "~/.pi": "read",
    "~/sandbox": "write",
    "/tmp": "read"
  },
  "classifier": {
    "enabled": true,
    "stage1TimeoutMs": 20000,
    "stage2TimeoutMs": 30000,
    "maxRetries": 1
  }
}
```

Omit `classifier.pairs` to use the default pairs.
A configured list replaces the defaults.

Example custom pair:

```json
{
  "classifier": {
    "pairs": [
      {
        "provider": "custom-provider",
        "stage1": {
          "model": "fast-model",
          "reasoning": "minimal"
        },
        "stage2": {
          "model": "strong-model",
          "reasoning": "high"
        }
      }
    ]
  }
}
```

Configuration parsing is strict.
Unknown fields and invalid values stop startup.
Project configuration cannot contain `sshAgent` or `classifier`.

The default policy makes the existing `~/sandbox` directory writable.
Create this directory before Pi starts because writable mount sources must exist.

The default policy protects `:project/.git` only when that entry exists at session start.
The entry can be a directory or a linked-worktree file.
If the entry does not exist, the default rule is absent for that session.
The next session protects a newly created entry.

Set `isolateNetwork` to `true` to add `--unshare-net`.
Writable rules under fresh `/dev` or `/proc` are invalid.
Readable exceptions below a denied virtual path are also invalid.

## Status and tests

Use `/sandbox` to show:

- Bubblewrap lifecycle state.
- Canonical filesystem policy.
- Network isolation state.
- SSH agent capability state.
- Private temporary directory.
- Session write grants.
- Classifier state and selected pair.
- Sanitized classifier diagnostics.

Use `/sandbox-test` as the single test command.
It first runs the Pi-native unit tests.
It then runs the shell integration test through the active runtime.
The unit tests do not contact model providers.

The integration test checks the real mount namespace.
It checks private temporary writes, denied resources, project writes, `.git` protection, SSH configuration, SSH socket isolation, Git transport, SSH signing, and signature verification.
It writes combined output to `sandbox-manual-test.log`.

A successful unit test does not prove kernel containment.
A live containment claim requires a successful integration test on the target system.

## Module ownership

- `types.ts` defines policy, grant, capability, classifier, and status types.
- `policy.ts` resolves paths and compiles filesystem policy.
- `layout.ts` defines fixed host and namespace paths.
- `grants.ts` validates and creates human-approved write grants.
- `capabilities.ts` creates private-temp and SSH agent capabilities.
- `mount-plan.ts` creates deterministic mount operations.
- `runtime.ts` owns trusted resources and Bubblewrap processes.
- `approval.ts` owns the parent and subagent approval broker.
- `approval-ui.ts` renders approval selection above other overlays.
- `direct-gate.ts` identifies direct host filesystem tools.
- `safety-policy.ts` owns classifier prompts, schemas, and fixed limits.
- `safety-evidence.ts` owns bounded evidence and action digests.
- `classifier-provider.ts` owns Pi-native stage invocation.
- `classifier.ts` owns pair selection and the fallback state machine.
- `direct-secret-evidence.ts` owns privacy-safe direct-tool metadata and local secret indicators.
- `media-type.ts` owns bounded local binary-media signature detection.
- `safety-gate.ts` owns classified-call approval and single-use permits.
- `session.ts` composes lifecycle, grants, runtime, and the safety gate.
- `commands.ts` presents status and the native test command.
- `index.ts` registers Pi surfaces and delegates work.

Dependencies flow from `index.ts` and `session.ts` toward narrow owners.
Filesystem and runtime modules do not depend on classifier modules.

## Change checklist

Before a security change, answer these questions:

- Which module owns the decision or resource?
- Is the change policy, a user grant, a runtime capability, or classifier logic?
- Can the change make any host path writable or visible?
- How do exact and inherited `none` rules apply?
- What is the mount source, destination, type, access, and order?
- Which environment values depend on the same runtime capability?
- Which configuration scope can set the option?
- What happens when configuration or runtime state is invalid?
- Can a classifier fallback change a valid review decision?
- Can evidence or diagnostics disclose a secret?
- Which native unit tests prove each branch?
- Which integration check proves actual Bubblewrap behavior?
- Do this document, user documentation, status output, and tests agree?

## Prohibited designs

Do not add these designs:

- Shell or Git parsing to decide mounts.
- Command regex allowlists.
- Classifier-created grants, mounts, or capabilities.
- Mixed-provider approvals inside one pair.
- Provider fallback after a valid `review`.
- Direct provider credential management.
- Raw evidence or provider-response logging.
- Repository-file ingestion for classifier evidence.
- Raw read content, grep patterns, edit text, or write payloads in direct-tool classifier evidence.
- Writable parent overlays that bypass narrow policy.
- Security policy in `index.ts`.
- Test fixtures in normal startup code.
- Live provider calls in unit tests.
- Runtime security claims without a successful integration test.
