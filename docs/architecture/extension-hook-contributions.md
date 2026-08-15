# Extension Hook Contributions

Status: implemented on `feat/extension-hook-contributions`.

## Outcome

MAKA Extensions have three peer contribution types:

- Tool contributes a capability the model can call.
- UI contributes a product surface the host can compose.
- Hook contributes typed middleware at a curated Runtime lifecycle seam.

Hook is not a second event bus, scheduler, or agent-to-agent transport. It is an adapter over the existing Runtime and existing Extension lifecycle. ScheduledTask remains the sole time-based scheduling authority, RuntimeEvent remains the durable execution ledger, and agent communication remains owned by the agent/subagent protocols.

One package may carry `maka.tool.json`, `maka.ui.json`, `maka.hook.json`, and `maka.extension.json`. Every typed manifest in that package must have the same product identity, version, and content-derived immutable Revision.

## Public event contract

| Event | Mode | Runtime boundary | Result contract |
| --- | --- | --- | --- |
| `UserPromptSubmit` | transform | before the first provider request of a Turn | may replace fields in the prompt envelope |
| `RunStart` | observe | immediately before Runtime execution begins | no decision or replacement payload |
| `PreToolUse` | gate | after admission checks but before durable Tool dispatch T1 and implementation side effects | may explicitly allow or deny |
| `PostToolUse` | transform | after Tool implementation settlement but before result coercion and durable outcome T2 | may replace fields in the result envelope |
| `RunEnd` | observe | during Turn finalization, before the per-Turn Hook snapshot is released | no decision or replacement payload |

Dispatch is deliberately typed instead of exposing DSH/Cordis's entire internal event namespace. The five modes cover its practical agent/tool middleware effect while preserving MAKA's authority boundaries.

Transform handlers form a serial waterfall ordered by priority and stable identity. Object replacements are shallow-merged into the current envelope so identity fields such as `toolName` survive for later matchers. Gate handlers run serially until the first explicit denial. Observe handlers run serially and cannot change settlement. Handler failure is contained and audited; it does not implicitly deny or replace Runtime behavior. Turn abort always wins and terminates the one-shot worker.

## Package contract

`maka.hook.json` has this shape:

```json
{
  "schemaVersion": 1,
  "id": "dev.example.policy",
  "version": "1.0.0",
  "entry": "dist/index.mjs",
  "hooks": [
    {
      "id": "protect-push",
      "event": "PreToolUse",
      "mode": "gate",
      "handler": "protectPush",
      "matcher": "Bash|exec",
      "priority": 100,
      "timeoutMs": 3000
    }
  ],
  "permissions": {
    "workspace": "read",
    "network": false
  }
}
```

The mode is determined by the event and is validated rather than trusted. Hook packages cannot request workspace writes. The entry is an ESM default handler object. A handler receives a bounded JSON payload and the same bounded worker context used by Tool packages, including Extension configuration and abort state.

Handler results are:

```ts
type HookResult = {
  decision?: 'allow' | 'deny'; // gate only
  reason?: string;             // gate only
  payload?: unknown;           // transform only
};
```

Observe handlers return nothing. Returning a decision from a transform Hook, a payload from a gate Hook, or any output from an observe Hook is a contained Hook failure.

## Composition and lifecycle

The Extension lifecycle kernel remains the only owner of installation and activation:

1. The unified loader materializes a directory or `.maka-extension` Bundle.
2. Tool, UI, and Hook stores independently validate their typed manifests while calculating the same whole-package content Revision.
3. Metadata identity/version/dependencies/configuration are checked across every manifest.
4. Candidate preparation creates isolated Tool and Hook activations and validates every declared handler.
5. Activation registers contributions through lifecycle-owned `ownEffect` disposers.
6. The Binding commits atomically. Failed preparation or health checking leaves the current last-good generation active and records the candidate diagnostic.
7. Disable, remove, dependency failure, shutdown, and update retire contributions through the same disposer/drain path.
8. The existing persisted Binding state restores the last-good Revision after Runtime Host restart.

The Hook registry is scope-aware. A Session execution composes profile Hooks with Session Hooks, then captures an immutable snapshot when the Turn's `ToolRuntime` is created. Enabling, disabling, or updating a package affects the next Turn, never half of an in-flight Turn.

Existing user/project command Hooks remain supported. `PreToolUse` first evaluates the existing trusted command snapshot and then the Extension Hook snapshot. Either lane can explicitly deny before T1. Command definition-hash trust is unchanged; installed Extension packages rely on the Extension installation, permission, and lifecycle authority instead of duplicating the command trust store.

## Isolation and permissions

Hook handlers never run in Electron main, the renderer, or the model loop process. They reuse the Tool package worker protocol:

- one fresh process per invocation;
- authenticated dedicated protocol file descriptors;
- bounded input, result, diagnostic, and reason sizes;
- hard timeout and AbortSignal termination;
- required OS sandbox transformation;
- default-denied network;
- workspace `none` or `read` only;
- no Electron/preload objects or ambient Extension secrets;
- lease draining during Revision replacement.

Configuration is resolved for the exact Binding and supplied through the worker context. The handler cannot select another Binding or Revision.

## Audit and recovery

Every attempted Extension Hook appends a hidden `hookCompleted` RuntimeEvent with:

- event name;
- Extension-qualified handler identity;
- a stable definition hash derived from Extension id, Revision, event, declaration id, and handler;
- source `extension`;
- tool correlation when available;
- allowed, denied, or failed status;
- bounded duration and diagnostic.

An audit write failure is surfaced to Runtime trace but fails open; a policy Hook's explicit denial remains authoritative even if its secondary audit write fails. Hook execution never replays independently during crash recovery. Tool T1/T2 and Turn recovery remain authoritative, preventing a `PostToolUse` transform from inventing a second Tool settlement.

## Product and Agent surfaces

The unified Extension catalog and Desktop manager expose Hook contribution counts and contracts beside Tool and UI. Import/export includes `maka.hook.json` and its entry without a special bundle format.

Agents receive four Host-owned management Tools:

- `inspect_hooks`: event/mode catalog, active resolved Hooks, packages, and Bindings;
- `define_hook`: validate, seal, and install an ESM Hook package;
- `test_hook`: invoke one installed handler once in the real sandbox without activation;
- `manage_hook`: activate, atomically update, stop, or delete a Session Binding.

These are lifecycle control tools. They cannot synthesize Runtime lifecycle events or bypass the event's fixed dispatch mode.

## Deliberate non-goals

- No arbitrary internal callback export. `AgentRunHooks`, compaction projections, UI overlay callbacks, and private coordinator events remain implementation details.
- No plugin-defined event names or event emission.
- No new timer. Scheduled execution uses ScheduledTask.
- No detached background service or long-lived plugin process.
- No Hook-driven direct Session wake, agent-to-agent message, or unrestricted Host RPC.
- No silent gate fail-closed behavior. Only an explicit, successfully decoded denial blocks execution.

New public events require a typed payload, an authority owner, an exact before/after boundary, a dispatch mode, bounded failure semantics, an audit projection, and end-to-end recovery tests before being added.

## DSH relationship

DSH Cordis exposes a broad dynamic event/service surface with emit, serial, bail, waterfall, and parallel dispatch. MAKA now provides the equivalent useful plugin pattern at the agent/tool lifecycle—observe, gate, and waterfall transform—through five stable public events. MAKA intentionally does not expose Cordis's unrestricted internal namespace or in-memory dynamic service graph. In exchange, Hook contributions gain immutable package Revisions, persisted Bindings, atomic update/rollback, restart recovery, dependency handling, a product catalog, and an OS sandbox.
