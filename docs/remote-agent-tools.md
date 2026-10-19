# One assistant, multiple Maka Hosts

The Desktop publishes a `desktop_remote_hosts` Client Capability offer. A bound
Agent can discover other connected Owner Hosts, open a dedicated execution
context and call exported tools. Calls use the existing authenticated Host
connection; SSH, TLS and Peer transports need no separate tool transport.

## Agent flow

1. `HostList` lists hosts and availability. `HostList({hostId})` lists existing
   sessions that can serve as workspace/model/permission templates.
2. `RemoteHostOpen({hostId, templateSession})` creates or recovers a dedicated
   context for the origin conversation. It copies the selected template's cwd,
   model and execution boundary (native Maka Sessions only); it does not start a model or alter that session.
3. `RemoteToolSearch({hostId, contextId, query})` returns exported tool schemas.
4. `RemoteToolCall({hostId, contextId, callId, tool, arguments})` executes through
   the target ToolRuntime. Reusing a callId with identical input returns the
   durable receipt; changed input is rejected. A short call returns inline.
5. `running` is admission, not completion. Use `RemoteToolResult` for a pending
   receipt. The target also retains deferred results for the origin Bot Inbox.
   Ordinary sessions use result queries without an automatic model wake.

All paths, cursors, index IDs and task IDs belong to the returned host/context.
Keep that route when following an original reference or updating a task. Remote
cursors do not become local memory cursors. Memory reads retain the target's
source authorization and refresh/checkpoint semantics.

## Continuous work and feedback

Call the exported `MatterDelegate` on the chosen target. Task creation returns
an identity, not a completed outcome. `MatterTasks`, `MatterTaskMessage`,
`MatterReply`, `MatterTaskControl`, `MatterDelegationRecover` and
`MatterFeedbackRetry` operate in the same remote context.
The target runs its existing Matter scheduler and review loop.

Task progress/questions, index job feedback and discovery reports go into a durable target outbox instead of starting an extra
conversation Agent on the target. Desktop forwards it to the origin Bot Inbox,
then acknowledges it. A lost acknowledgement repeats the same Inbox identity.
The origin is normalized to the owner conversation so replacing the Bot worker
does not change the feedback destination. Disabled/offline assistants retain
undelivered feedback; ordinary sessions retain results for manual queries.

Network requests have a 15-second response deadline; it does not cancel target
execution. An uncertain call retains its call/context/Host identity for result
queries or retries with the same identity. Independent Host pairs relay in
parallel; a failed event does not block later events.

There is no whole-call ten-minute deadline. The one-second inline wait only
selects inline versus deferred delivery; it does not stop execution. Individual
tools retain their own native limits. `RemoteToolCancel` requests cancellation of
a pending call; it does not roll back effects or cancel a delegated Matter. A Host restart marks interrupted calls
`outcome_unknown` and does not replay effects. Known completed receipts survive
restart. The context permits one in-flight call at a time.

## Permissions and compatibility

Both ends need compatibility epoch 225. Existing credentials with explicit
operation lists need the new `remote.tools` grant (reissue/pair through normal
Host administration); no code silently expands an existing credential.
Guest and capability-provider credentials cannot invoke this operation.
The Desktop capability offer uses normal capability admission and the origin
session's existing boundary requirements. The destination ToolRuntime enforces
its execution context's boundary. A network connection is not permission to use
an arbitrary UI provider.

Exports include filesystem/shell and every Bot business tool (the shared
`BOT_DELEGATION_TOOLS` list): memory reads, index creation/grouping/maintenance,
Matter management/recovery and proactive-discovery configuration. Remote index
jobs use the target's ordinary scheduler; creation and checkpoints are unchanged.
Each remote context has its own durable discovery schedule and worker, without a
second Bot or changes to the target's existing local assistant schedule. Discovery
configuration is recovered after restart. Parameter defaults are applied before
executing the native tool. Loop-control tools (`SendUser`, `Sleep`, `MatterSettle`), arbitrary
plugins and recursive remote calls are not exported. Browser/Computer Use
provider selection is not implemented by this transport. Required approvals
that this standalone context cannot present fail through the normal runtime
boundary instead of silently granting access.

## Operation and current limits

The bridge needs Desktop running and both Owner connections available. Existing
remote tasks continue under their Host scheduler while the bridge is offline.
The bridge checks feedback every five seconds without model calls. HostList
reports observed bridge errors. Source data and indexes stay on their owner
Host, and index maintenance stays with that Host's existing shared scheduler.
There is no database replication, cross-host index builder, automatic primary
Bot election, worker migration, or native cross-host attachment rendering.
This adds other Hosts as tools to the current assistant; it does not merge
separately configured assistant conversations on different Hosts.

Persistent state is `<Host control directory>/remote-tools/remote-tools.sqlite`
(0600): context identities, call receipts, tool event traces and feedback outbox.
The bridge does not copy model connection credentials into its catalog or context metadata. Exported tools still have their normal ability to read files allowed by the target boundary.
