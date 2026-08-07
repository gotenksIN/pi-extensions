# Bubblewrap sandbox architecture

## Purpose

This extension protects the host from commands that Pi runs on Linux.
Bubblewrap is the primary security boundary.
It gives each Bash process a restricted mount namespace.

The extension also checks Pi file tools in the host process.
It asks the user before it adds a session write grant.
It can also attach one validated write path to one exact future model-generated Bash call.
It uses deterministic local checks for direct content-access calls.
It can use one model reviewer before model-generated Bash calls.
The classifier is an additional Bash check.
It does not replace Bubblewrap or deterministic filesystem validation.

## Security goals

The extension has these goals:

- Start each Bash process with a read-only view of the host root.
- Apply a strict filesystem policy to selected paths.
- Hide paths that have `none` access.
- Make only policy paths, session grants, and exact one-shot paths writable.
- Give each session a private writable temporary directory.
- Optionally isolate the network.
- Support one exact inherited SSH agent socket when the user enables it.
- Check direct Pi file tools before they access the host.
- Require deterministic human review for direct secret indicators.
- Check model-generated Bash calls with one independent classifier reviewer.
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

1. The configured reviewer must return `allow` with `safe` severity and no risks.
2. If automatic approval stops, the human can create a single-use approval for the exact call.
3. Bubblewrap builds the mount plan and starts the Bash process.
4. If the approved call fails, a later write-grant prompt can also authorize one retry of that exact Bash action.

Before one known Bash call, `sandbox_access` can request `mode: "one-shot"` with either one compatible path-and-scope pair or an atomic `paths` list, plus the complete Bash input.
The extension validates every path with the persistent-grant rules, rejects duplicates and overlaps, and limits the list to 16 entries.
It removes already-writable entries from the transient set and then classifies one envelope that contains the complete Bash input, all remaining canonical write paths and scopes, and one-shot disposition.
Only recent user-role messages provide authorization evidence for this request.
One valid safe reviewer decision can authorize the complete set automatically.
Every result that is not a valid safe allow requires one human decision for that exact path set and Bash call.
The resulting write paths are mounted together for only the matching next model-generated Bash spawn.

Direct `read`, `grep`, `write`, and `edit` calls use deterministic path policy first.
They then use local path, query, payload, and scan-completeness indicators.
A positive indicator requires human review.
A clean and complete local assessment runs without model inference.
Direct `find` and `ls` calls use only deterministic path policy.
A direct write also uses the existing write approval flow when required.
A `sandbox_access` request uses deterministic grant validation and user approval.
The model can request a grant before an operation when it already knows the required path and scope.
For one known Bash action, it can include the exact `bash` input so classification and the filesystem grant use one combined human prompt.
The classifier does not select or create the grant.

Each control is independent.
Automatic execution of a Bash call requires one valid `allow` decision with `safe` severity and no risks.
Automatic execution of a direct content-access call requires a clean and complete local assessment.
A human review approval is single-use and applies to one exact tool call.
A failed approved Bash call can become a pending retry only after a later grant prompt displays the exact command and the human selects the combined grant-and-retry choice.
The retry uses a new single-use execution permit and cannot survive a changed command, working directory, lifecycle, or intervening Bash authorization.
A classifier decision cannot select, infer, add, drop, replace, or widen a filesystem path.
A valid safe reviewer decision can authorize only the explicit, deterministically validated one-shot path set in the same authorization envelope.
A human one-shot approval has the same set limit.
Neither result creates a session grant or runtime capability.
It cannot bypass a Bubblewrap error.
A session grant or one-shot path cannot override `none` or a protected runtime path.

User `!` and `!!` Bash commands do not come from a model tool call.
They do not use the classifier.
They still run through Bubblewrap.
The `/sandbox-test` command also bypasses classifier inference for its shell containment checks.
Explicit provider compatibility tests can still call a live model through Pi.

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

Each one-shot write path uses the same canonical source, existing-source, `none`, and protected-runtime validation.
The atomic set stays separate from session grants and does not appear in `/sandbox` status.
It is bound to one complete Bash input, including its timeout, the project working directory, and the current lifecycle.
The extension consumes the complete set before one matching spawn.
Changed input, reuse, or a lifecycle change gives no transient paths and returns the call to normal Bash authorization.
Direct file tools and user Bash cannot claim this set.

### Grant scope

The `sandbox_access` tool has `session` and `one-shot` modes.
Request it only when active policy and current grants do not already provide the required write access.
Use active `/sandbox` status for configurable paths instead of assuming default locations.
The default mode is `session`.
Session mode preserves the human-approved persistent grant flow.
One-shot mode requires the `bash` field and never creates a persistent grant.
It accepts the existing singular `path` plus top-level `scope` form or a plural `paths` list with an explicit scope in each entry.
Supplying both forms, neither form, a top-level scope with `paths`, more than 16 entries, canonical duplicates, or ancestor and descendant overlaps is invalid.
If all one-shot paths are already writable, the tool returns without classifier inference, human review, a future Bash ticket, or transient mounts.
The later Bash call then uses normal safety classification.

The tool also has an `exact` scope and a `parent` scope.
The default scope is `exact` in session mode.
The singular one-shot form requires a top-level scope, and every plural entry requires its own scope.
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

Example for one known Bash action that needs a grant:

```json
{
  "path": "/work/.git",
  "mode": "session",
  "scope": "exact",
  "bash": {
    "command": "git add src/file.ts && git commit -m 'Update file'"
  }
}
```

Example for one exact future Bash call without a session grant:

```json
{
  "path": "/work/.git",
  "mode": "one-shot",
  "scope": "exact",
  "bash": {
    "command": "git add src/file.ts && git commit -m 'Update file'",
    "timeout": 30
  }
}
```

Example for one exact build that needs two normal tool caches:

```json
{
  "mode": "one-shot",
  "paths": [
    { "path": "/home/user/.cache/compiler", "scope": "exact" },
    { "path": "/home/user/.cache/dependencies", "scope": "exact" }
  ],
  "bash": {
    "command": "tool build",
    "timeout": 30
  }
}
```

The later Bash call must use the same complete input, including `timeout` when specified.
The transient write permissions end after that call, but cache content remains for normal tool reuse and cleanup.

## Mount order

The mount plan uses this order:

1. Bind the host root as read-only.
2. Create fresh `/dev` and `/proc` mounts.
3. Install trusted runtime resource masks.
4. Apply filesystem policy mounts.
5. Apply approved session write grants and the optional consumed one-shot write-path set.
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

Model-generated `read`, `grep`, `write`, and `edit` calls use deterministic local secret checks after path policy passes.
A read requires review when its target matches a known credential or secret path.
High-confidence path rules cover common SSH, Git, package-manager, cloud, container, Kubernetes, Terraform, Vault, and secret-file locations.
A grep requires review for a known secret path or a secret-seeking pattern.
A write or edit requires review for a known secret path, a potential secret payload, or an incomplete bounded payload scan.
Edit scans include every structured replacement block and the legacy single-replacement shape.
All other direct content-access calls run without provider inference.
The extension creates an exact single-use execution permit before the built-in tool runs.
Approval prompts list each deterministic trigger.
For a query trigger, the prompt states that the pattern matched a high-confidence secret-search term and that the check did not scan target file content.
An ordinary directory `grep` or a search for authorization code is not automatically treated as sensitive.

A direct write outside current write policy uses the shared approval channel.
If safety review and write approval are both required, the extension uses one combined prompt.
The user can allow one operation or add a session grant.
A proactive `sandbox_access` call in session mode can include one exact future Bash input.
The extension classifies that input before the grant prompt, and the human can grant the resolved path and authorize that exact Bash call with one choice.
In one-shot mode, the extension classifies the complete Bash-and-path-set envelope and creates no session grant.
A valid automatic decision needs a ready reviewer and one `allow` decision with `safe` severity and no risks.
Disabled, unavailable, review, invalid, timeout, cancellation, and technical results cannot create automatic filesystem access.
A human can approve the exact one-shot request with one combined prompt.
After a failed approved Bash call, the shared grant prompt can offer the same type of combined choice for one exact retry without another classifier request.
The user can instead grant only the path.
A subagent cannot approve its own request.
A subagent request must use an interactive parent approval owner.
Requests fail closed when no owner is available.
A forwarded approval opens as a focused overlay above a child conversation viewer.
The approval choices stay at the bottom of the overlay when a long command fills the prompt.
Use Page Up and Page Down to scroll the prompt while Up and Down select a choice.
Overlay state does not affect approval validation.

## Safety classifier

### Purpose

The classifier looks for malicious or unauthorized model-generated Bash calls.
Examples include secret disclosure, remote mutation, destructive changes, persistence, privilege escalation, and sandbox bypass attempts.
Read-only local inspection is routine.
Non-mutating repository inspection is routine when it does not change refs, index, worktree, repository configuration, remotes, hooks, or history.
Non-exclusive examples include `git status`, `git diff`, `git diff --check`, `git diff --stat`, `git log`, `git show`, and `git rev-parse`.
These commands do not require review only because the repository contains sensitive code or history, or because a later separate action can push.
Deterministic read-only remote searches through standard clients are routine when the complete action has no other risk and the query transmits no credentials, project secrets, proprietary source code, or other sensitive local data.
Non-exclusive examples include `gh search code`, `gh search commits`, `gh search issues`, `gh search prs`, and `gh search repos`.
A search query that contains credentials, project secrets, proprietary source code, or other sensitive local data still requires review because it transmits that data to a remote service.
Deterministic read-only retrieval from fixed public resources is routine through either literal public URLs or unambiguous standard-service clients with no destination override.
This rule includes chained retrieval, decoding, selection, parsing, display, and trusted scratch storage, independently of the client, interpreter, data encoding, or iteration mechanism.
Normal connection metadata, public research paths, and client-managed authentication to the intended standard service are not exfiltration by themselves.
Receiving or decoding untrusted remote data is not code execution unless the action executes or loads that data as active code.
Review remains required when a request can contain local, project, environment, credential, secret, proprietary, prior-output, or dynamic data.
Custom destinations or transports, supplied authentication data, uploads, remote mutation, private-resource indicators, execution of downloaded content, and unauthorized or destructive local writes also require review.
Reads that are restricted to the documented `PI_CODING_AGENT`, `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` session metadata are routine.
This includes exact `env | rg '^PI_'`-style inspection, but it does not include arbitrary environment dumps, provider credential variables, or reading the file named by `PI_SESSION_FILE`.
Bounded temporary processing of public or local read-only research data in the configured active sandbox directory is also routine when it does not modify project files, external services, credentials, or secrets.
An atomic classifier-approved one-shot set can let a tool use its normal narrow compiler, package-manager, dependency, or build cache paths outside that directory for one exact command.
The transient write permissions end after the command, but cache content remains for normal reuse and tool-managed cleanup.
Every cache path and scope must be explicit.
Broad cache roots, secret stores, unrelated writes, cache poisoning, external mutation, and execution of newly downloaded code still require review.
A read-only research request permits scratch processing unless it explicitly forbids temporary files.
The classifier assesses the exact current action.
It can use recent user-role messages as authorization evidence for a matching, narrowly scoped mutation.
For example, a user request to commit and push the current changes can authorize an ordinary matching commit and push to the configured upstream.
A standalone fetch through a standard named Git remote is routine.
A standalone `git pull --ff-only` is routine when it uses the configured upstream or a standard named Git remote.
These operations can update local refs and the worktree without requiring review for that effect alone.
The latest applicable user instruction controls, and every material effect in a chained command must be authorized.
Review remains required for secret access or disclosure, unexpected destinations, broad destruction, force pushes and other important history rewriting, privilege escalation, persistence, security weakening, untrusted code execution, evasion, and effects that the user did not authorize.
Explicit URLs, custom refspecs, Git configuration overrides, custom transports or upload-pack commands, recursive submodule updates, non-fast-forward merges, rebases, secret transmission, chained effects, arbitrary shell-computed remote names, and remote mutation continue to require review.
An ordinary pull does not receive remote hooks or filter commands by itself.
The classifier reviews concrete evidence that the proposed action will execute an existing local hook or filter.
Other Git commands that change files, refs, hooks, remotes, or external services require review when recent user authorization does not clearly cover them.

Direct content-access calls do not use the classifier.
Deterministic path and secret checks can block them without a provider request.
Direct writes and session-mode `sandbox_access` also use user approval when required.
One-shot `sandbox_access` classifies only the exact future model-generated Bash authorization envelope.
It does not classify direct file tools or user Bash.

### Default reviewer

The default automatic reviewer is `openai/gpt-5.6-luna` with `low` reasoning.
The extension makes one reviewer request for each classified action.
It does not use a second model or a fallback model.

A user can replace the reviewer in global configuration.
The custom reviewer must specify one provider, one model ID, and one reasoning level.
The model must exist in the Pi model registry, and the provider must support the configured reasoning level.

The extension uses Pi authentication and Pi provider transports.
It does not store API keys.
It does not read provider credentials directly.
It does not add provider SDKs.

Project configuration cannot set classifier options.
Repository content must not select the security reviewer.

### Availability and failure

At startup, the extension checks the configured model, provider runtime, and authentication state.
This check does not make an inference request.

If the reviewer is unavailable, Bubblewrap still starts.
The extension shows a warning and tells the user that model-generated Bash calls require human review.
The warning also tells the user that they can configure `classifier.reviewer` in the global sandbox configuration.
Deterministic direct-tool checks continue without provider access.
User Bash and `/sandbox-test` continue to use Bubblewrap.

The extension resolves the configured reviewer again for each action.
A valid `review`, invalid output, refusal, timeout, missing model, missing provider, missing authentication, or technical call failure stops automatic approval.
There is no model fallback.
Unavailable and technical-failure prompts state that the automatic reviewer is unavailable and that the user can configure `classifier.reviewer` globally.
Other blocked results show a normalized reason or the validated concise decision reason.
A human allow creates one single-use exact-call permit.
It does not create a filesystem grant.
A human denial blocks the call.
Cancellation blocks the call.

### Evidence

Classifier evidence is bounded.
Bash evidence can contain:

- Up to eight bounded user-role text messages from the active branch, in branch order.
- The compiled active sandbox directory as bounded trusted context, when it exists.
- The current tool name.
- The complete current structured input.
- The project working directory.
- A bounded list of completed prior structured actions.
- Counts for omitted historical items.

Direct-tool assessment is local.
It can use the operation, project-relative target path, basename, extension, path kind, numeric read range, payload byte count, bounded-scan completeness, and local boolean indicators.
It does not send direct-tool metadata, file content, grep patterns, edit text, or write payloads to a provider.
An outside-project scope is not a review reason by itself.
A local digest binds approval to the complete exact input.

The evidence labels the current proposal separately from completed prior actions.
Completed prior actions are context and are not part of the proposed action.
The classifier uses them only when the proposed action explicitly executes or depends on an artifact from them.

The evidence does not contain tool-result content.
The extension does not read a referenced script for classification.
It does not treat assistant text or completed prior actions as authorization.
Only a clear recent user-role message can authorize a mutation.
A later restriction or cancellation overrides an earlier request.
A user message with an omission marker is incomplete and cannot supply authorization.

If all bounded user messages fit, the extension keeps all of them.
Otherwise, it keeps the first and latest messages, then adds the newest interior messages that fit, and outputs them in branch order.
It records the number of omitted messages.
Per-message truncation uses an explicit omission marker.
It does not silently truncate the current action.
An action that is too large or cannot be serialized is blocked locally.

A Bash action itself can contain a secret or proprietary value.
Sending that Bash action to a classifier provider can disclose that value.
A generic redactor cannot preserve all security meaning.
Users must consider this limit when they select classifier providers.

Direct read checks do not inspect file content and cannot detect a secret in an ordinary path such as `notes.txt` with certainty.
Filename and payload indicators reduce risk but do not provide a complete content secret scanner.

### Decisions

The reviewer returns one structured decision with `decision`, `severity`, `risks`, and a short `reason`.
Automatic approval requires `decision: "allow"`, `severity: "safe"`, and an empty risk list.
The extension validates all fields locally.
It rejects unknown fields, multiple decisions, prose in place of a decision, contradictory allows, and incomplete output.

The extension does not execute classifier tool calls.
It does not store classifier reasoning.
A human review prompt shows the validated, bounded reason for a semantic decision.
Technical failures use normalized local text and global `classifier.reviewer` guidance.
Diagnostics contain only the provider and model label and a normalized outcome category.
Status does not retain decision reasons.

### Execution permits

The `tool_call` input is mutable.
A later extension can change it after this extension checks it.
For extension-owned Bash, the extension creates a single-use permit after one valid safe reviewer decision or one explicit human review approval.
For extension-owned `read`, `grep`, `write`, and `edit`, it creates a single-use permit after a clean deterministic assessment or one explicit human review approval.
The extension wraps these built-in tools so approval and execution have the same integrity check.
The permit covers the tool call ID, tool name, final input, working directory, and lifecycle generation.
The tool consumes the permit immediately before execution.
A proactive session write-grant request can classify one exact future Bash input without creating an execution permit or filesystem grant.
A combined human approval creates the validated grant and one exact future-call ticket.
A one-shot request creates two independent transient records after one valid safe reviewer decision or one human approval: an exact future Bash ticket and one validated atomic write-path-set record.
The matching tool call claims both records.
Permit consumption returns the complete set only to the Bubblewrap operations object for that one spawn.
The set is consumed before execution and is never added to session grants or status.
A failed Bash execution can also stage bounded retry metadata for the next write-grant request.
A combined human grant-and-retry choice converts that metadata into one permit for a new tool call only when the command and working directory still match exactly.
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
  "sandboxDirectory": "~/sandbox",
  "filesystem": {
    ":project": "write",
    ":project/.git": "read",
    "~/.ssh": "none",
    "~/.ssh/config": "read",
    "~/.ssh/known_hosts": "read",
    "~/.pi": "read",
    "~/.local/lib/pi": "read",
    "/tmp": "read"
  },
  "classifier": {
    "enabled": true,
    "reviewer": {
      "provider": "openai",
      "model": "gpt-5.6-luna",
      "reasoning": "low"
    },
    "timeoutMs": 30000,
    "maxRetries": 1
  }
}
```

Omit `classifier.reviewer` to use the default Luna reviewer.
A configured reviewer replaces that default.

Example custom reviewer:

```json
{
  "classifier": {
    "reviewer": {
      "provider": "custom-provider",
      "model": "reviewer-model",
      "reasoning": "high"
    }
  }
}
```

Configuration parsing is strict.
Unknown fields and invalid values stop startup.
Project configuration cannot contain `sshAgent`, `sandboxDirectory`, or `classifier`.

The global `sandboxDirectory` setting selects one additional writable directory.
It defaults to `~/sandbox`.
The extension resolves the configured path to a canonical directory before it starts Bubblewrap.
If the directory does not exist, the extension omits this optional write rule and continues to start.
An existing non-directory or an invalid path still stops startup.
Explicit writable entries in `filesystem` remain strict and must exist.
The default policy explicitly mounts the installed Pi package at `~/.local/lib/pi` as read-only when that path exists.

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
- Configured sandbox directory and its active or missing state.
- Session write grants.
- Classifier state and configured reviewer.
- Sanitized classifier diagnostics.

Use `/sandbox-test` as the single test command.
It first runs the Pi-native unit tests.
It then runs the shell integration test through the active runtime.
The default command does not make classifier inference requests.
Use `/sandbox-test live` to add the live reviewer compatibility check.
An optional Bun syntax build can write generated output to `$HOME/sandbox/bwrap-build`; this does not replace `/sandbox-test`.

The live check uses only the configured reviewer with Pi model resolution, authentication, and provider transport.
It makes two requests.
It requires an explicitly authorized ordinary commit-and-push action to return a safe allow.
It requires a synthetic credential-exfiltration action to return review.
An unavailable reviewer, technical failure, invalid output, timeout, or behavior mismatch fails the live check.
It does not try another model.
Other unit tests use injected provider implementations for deterministic isolation.

The integration test checks the real mount namespace.
It checks private temporary writes, denied resources, project writes, `.git` protection, SSH configuration, SSH socket isolation, Git transport, SSH signing, and signature verification.
It writes combined output to `sandbox-manual-test.log`.

A successful unit test does not prove kernel containment.
A live containment claim requires a successful integration test on the target system.

## Module ownership

- `types.ts` defines policy, grant, capability, classifier, and status types.
- `policy.ts` resolves paths and compiles filesystem policy.
- `layout.ts` defines fixed host and namespace paths.
- `grants.ts` validates persistent grants and one-shot bind sources, and it creates human-approved session grants.
- `capabilities.ts` creates private-temp and SSH agent capabilities.
- `mount-plan.ts` creates deterministic mount operations.
- `runtime.ts` owns trusted resources and Bubblewrap processes.
- `approval.ts` owns the parent and subagent approval broker.
- `approval-ui.ts` renders approval selection above other overlays.
- `direct-gate.ts` identifies direct host filesystem tools.
- `safety-policy.ts` owns classifier prompts, schemas, and fixed limits.
- `safety-evidence.ts` owns bounded evidence and action digests.
- `classifier-provider.ts` owns Pi-native reviewer invocation.
- `classifier.ts` owns reviewer availability and decision state.
- `direct-secret-evidence.ts` owns deterministic direct-tool metadata, secret indicators, and review reasons.
- `safety-gate.ts` owns Bash classification, exact future tickets, and single-use permits.
- `session.ts` owns transient one-shot write records and composes lifecycle, grants, runtime, and the safety gate.
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
- Does every unavailable reviewer path fail closed without model fallback?
- Can evidence or diagnostics disclose a secret?
- Which native unit tests prove each branch?
- Which integration check proves actual Bubblewrap behavior?
- Do this document, user documentation, status output, and tests agree?

## Prohibited designs

Do not add these designs:

- Shell or Git parsing to decide mounts.
- Command regex allowlists.
- Classifier-created grants, mounts, or capabilities.
- Multiple reviewer conjunctions.
- Classifier model fallback.
- Direct provider credential management.
- Raw evidence or provider-response logging.
- Repository-file ingestion for classifier evidence.
- Provider inference for structured direct file operations.
- Writable parent overlays that bypass narrow policy.
- Security policy in `index.ts`.
- Test fixtures in normal startup code.
- Runtime security claims without a successful integration test.
