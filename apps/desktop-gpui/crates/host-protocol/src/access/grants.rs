/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! What a remote owner may do on a Runtime Host.
//!
//! Source: `REMOTE_OWNER_OPERATION_GRANTS` and `operationAllowsRemoteOwner`
//! in `packages/runtime-host/src/protocol/operations.ts`, and
//! `authorizeRuntimeHostOperation` in `server/connection-authority.ts`. A
//! connection authenticated with a remote owner's credential (the one a
//! connection code or Desktop's desktop-client preset issues,
//! `REMOTE_DESKTOP_OWNER_ACCESS_POLICY` in `client/owner-connection-code.ts`)
//! may call only these operations, and never with a Host path: the Host
//! answers anything else with `unauthorized`. The list is fail-closed there
//! too: an operation added to the protocol is refused until it is added
//! here.
//!
//! "Host paths" are the inputs `defineHostPathOperation` marks in
//! `protocol/*.ts` (`operationUsesHostPaths`): a folder by its path on the
//! Host, as in `project.catalog.mutate` `register` and `relink`, the
//! `project.catalog.query` `locations` view, or a `session.create` into a
//! `host_path` workspace. A remote owner's credential has
//! `canUseHostPaths: false`, so the client offers another way or none.

/// `REMOTE_OWNER_OPERATION_GRANTS`, in the TypeScript's order.
pub const REMOTE_OWNER_OPERATION_GRANTS: &[&str] = &[
    "access.credential.finalize",
    "agent.graph.epochs.query",
    "agent.graph.operator.query",
    "agent.graph.query",
    "agent.graph.stop",
    "artifact.delete",
    "artifact.ingest",
    "artifact.query",
    "client.capability.replace",
    "client.capability.unregister",
    "configuration.credentials.export",
    "collaboration.access.query",
    "collaboration.grant.revoke",
    "collaboration.invitation.prepare",
    "collaboration.principal.revoke",
    "collaboration.principal.rename",
    "collaboration.turn-request.decide",
    "collaboration.turn-request.query",
    "connection.catalog.create",
    "connection.catalog.query",
    "connection.catalog.remove",
    "connection.catalog.set-default-target",
    "connection.catalog.update",
    "connection.models.fetch",
    "connection.onboarding.save",
    "connection.onboarding.verify",
    "connection.request-headers.query",
    "connection.request-headers.replace",
    "connection.test.run",
    "context.compact",
    "context.diagnostics.query",
    "credential.vault.delete",
    "credential.vault.query",
    "credential.vault.set",
    "daily-review.mutate",
    "daily-review.query",
    "execution.inspect.query",
    "external-session.catalog.query",
    "external-session.import",
    "external-session.source.query",
    "goal.arm",
    "goal.control",
    "goal.query",
    "host.diagnostics.query",
    "host.resources.query",
    "host.status",
    "interaction.answer",
    "interaction.query",
    "memory.mutate",
    "memory.query",
    "network-proxy.test",
    "oauth.enrollment.query",
    "oauth.login.cancel",
    "oauth.login.query",
    "oauth.login.start",
    "plan.control",
    "plan.query",
    "plan.turn.start",
    "plugin.client.query",
    "plugin.client.remote.call",
    "plugin.client.remote.stream.close",
    "plugin.client.remote.stream.next",
    "plugin.client.remote.stream.open",
    "pricing.mutate",
    "pricing.query",
    "project.catalog.mutate",
    "project.catalog.query",
    "queue.entries.reorder",
    "queue.entry.promote",
    "queue.entry.retract",
    "queue.entry.update",
    "queue.retract",
    "runtime.policy.mutate",
    "runtime.policy.network-proxy.update",
    "runtime.policy.query",
    "recall.query",
    "runtime.resource.controller.acquire",
    "runtime.resource.controller.control",
    "runtime.resource.controller.release",
    "runtime.resource.query",
    "runtime.resource.start",
    "runtime.resource.stop",
    "scheduled-task.mutate",
    "scheduled-task.query",
    "session.branch.create",
    "session.catalog.query",
    "session.configuration.update",
    "session.create",
    "session.execution_boundary.query",
    "session.lifecycle.set",
    "session.shared.query",
    "session.metadata.update",
    "session.prompt-suggestion.generate",
    "session.read_marker.set",
    "session.recap.generate",
    "session.remove",
    "session.remove.preview",
    "session.revision.abandon",
    "session.revision.create",
    "session.transcript.page",
    "session.turn_landmarks.query",
    "session.turns.query",
    "session.workspace.relocate",
    "skill.catalog.invocable.query",
    "skill.catalog.mutate",
    "skill.catalog.preview-update",
    "skill.catalog.query",
    "subscription.close",
    "subscription.open",
    "subscription.pty_interest.set",
    "subscription.ready",
    "session.todo.query",
    "turn.interrupt",
    "turn.message.execution.query",
    "turn.message.query",
    "turn.message.submit",
    "turn.query",
    "turn.resume.query",
    "turn.resume.start",
    "turn.start",
    "turn.stop",
    "usage.query",
    "web-search.execute",
    "workhub.coordination.answer",
    "workhub.coordination.actFromTurn",
    "workhub.coordination.selectAndDelegate",
    "workhub.coordination.candidates",
    "workhub.coordination.configureModel",
    "workhub.coordination.query",
    "workhub.coordination.resolve",
];

/// `operationAllowsRemoteOwner`: whether a remote owner may call the
/// operation named `operation` at all (a Host path in its input is refused
/// separately).
pub fn operation_allows_remote_owner(operation: &str) -> bool {
    REMOTE_OWNER_OPERATION_GRANTS.contains(&operation)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `REMOTE_OWNER_OPERATION_GRANTS` as the pin's build prints it (Node
    /// 24.18, `JSON.stringify` of the export of
    /// `packages/runtime-host/dist/protocol/index.js` at de4fc5ff9).
    const TYPESCRIPT: &str = r#"["access.credential.finalize","agent.graph.epochs.query","agent.graph.operator.query","agent.graph.query","agent.graph.stop","artifact.delete","artifact.ingest","artifact.query","client.capability.replace","client.capability.unregister","configuration.credentials.export","collaboration.access.query","collaboration.grant.revoke","collaboration.invitation.prepare","collaboration.principal.revoke","collaboration.principal.rename","collaboration.turn-request.decide","collaboration.turn-request.query","connection.catalog.create","connection.catalog.query","connection.catalog.remove","connection.catalog.set-default-target","connection.catalog.update","connection.models.fetch","connection.onboarding.save","connection.onboarding.verify","connection.request-headers.query","connection.request-headers.replace","connection.test.run","context.compact","context.diagnostics.query","credential.vault.delete","credential.vault.query","credential.vault.set","daily-review.mutate","daily-review.query","execution.inspect.query","external-session.catalog.query","external-session.import","external-session.source.query","goal.arm","goal.control","goal.query","host.diagnostics.query","host.resources.query","host.status","interaction.answer","interaction.query","memory.mutate","memory.query","network-proxy.test","oauth.enrollment.query","oauth.login.cancel","oauth.login.query","oauth.login.start","plan.control","plan.query","plan.turn.start","plugin.client.query","plugin.client.remote.call","plugin.client.remote.stream.close","plugin.client.remote.stream.next","plugin.client.remote.stream.open","pricing.mutate","pricing.query","project.catalog.mutate","project.catalog.query","queue.entries.reorder","queue.entry.promote","queue.entry.retract","queue.entry.update","queue.retract","runtime.policy.mutate","runtime.policy.network-proxy.update","runtime.policy.query","recall.query","runtime.resource.controller.acquire","runtime.resource.controller.control","runtime.resource.controller.release","runtime.resource.query","runtime.resource.start","runtime.resource.stop","scheduled-task.mutate","scheduled-task.query","session.branch.create","session.catalog.query","session.configuration.update","session.create","session.execution_boundary.query","session.lifecycle.set","session.shared.query","session.metadata.update","session.prompt-suggestion.generate","session.read_marker.set","session.recap.generate","session.remove","session.remove.preview","session.revision.abandon","session.revision.create","session.transcript.page","session.turn_landmarks.query","session.turns.query","session.workspace.relocate","skill.catalog.invocable.query","skill.catalog.mutate","skill.catalog.preview-update","skill.catalog.query","subscription.close","subscription.open","subscription.pty_interest.set","subscription.ready","session.todo.query","turn.interrupt","turn.message.execution.query","turn.message.query","turn.message.submit","turn.query","turn.resume.query","turn.resume.start","turn.start","turn.stop","usage.query","web-search.execute","workhub.coordination.answer","workhub.coordination.actFromTurn","workhub.coordination.selectAndDelegate","workhub.coordination.candidates","workhub.coordination.configureModel","workhub.coordination.query","workhub.coordination.resolve"]"#;

    #[test]
    fn the_grants_are_the_typescripts() {
        let recorded: Vec<String> = serde_json::from_str(TYPESCRIPT).expect("json");
        assert_eq!(REMOTE_OWNER_OPERATION_GRANTS, recorded.as_slice());
    }

    #[test]
    fn a_remote_owner_is_refused_what_is_not_granted() {
        use crate::Operation as _;
        for granted in [
            crate::SessionCatalogQuery::NAME,
            crate::ProjectCatalogQuery::NAME,
            crate::ProjectCatalogMutate::NAME,
            crate::ArtifactIngest::NAME,
            crate::AccessCredentialFinalize::NAME,
            crate::HostStatus::NAME,
        ] {
            assert!(operation_allows_remote_owner(granted), "{granted}");
        }
        for refused in [
            crate::AccessCredentialPrepare::NAME,
            "session-bundle.export",
            "session-bundle.import",
            "access.principal.revoke",
            "access.credential.rotation.prepare",
        ] {
            assert!(!operation_allows_remote_owner(refused), "{refused}");
        }
    }
}
