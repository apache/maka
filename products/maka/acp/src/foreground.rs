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

use crate::{
    Error,
    client::{Client, Subscription},
    history, interaction,
    projection::Projection,
    session::{Active, Session},
    transport::Peer,
};
use agent_client_protocol::schema::v2 as acp;
use maka_agent_api::contract::*;
use maka_agent_facts::interaction::InteractionRecord;
use maka_capabilities::call::Attachments;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::task::JoinSet;
mod admission;
pub(crate) struct Prompt {
    pub content: Vec<acp::ContentBlock>,
}
pub(crate) struct Foreground {
    client: Client,
    peer: Peer,
    session: Arc<Session>,
    active: Active,
    target: WorkTarget,
    execution: Option<Execution>,
    shared: bool,
    cancelled: bool,
    projection: Projection,
    capabilities: acp::ClientCapabilities,
    after: u64,
    history_through: u64,
    parts: HashMap<(String, String), (String, ContentKind)>,
    user: Vec<HistoryChunk>,
}
impl Foreground {
    pub async fn run(mut self) {
        let result = self.observe().await;
        let reason = match result {
            Ok(reason) => reason,
            Err(error) => {
                eprintln!("ACP session {}: {error}", self.session.id);
                if let Err(cleanup) = self.stop().await {
                    eprintln!("ACP original work cleanup unresolved: {cleanup}");
                    self.peer.stop.cancel();
                    return;
                }
                acp::StopReason::Other(acp::OtherStopReason::new(
                    "_maka_failed",
                    Default::default(),
                ))
            }
        };
        drop(self.active);
        let _ = self
            .peer
            .update(
                &self.session.id,
                acp::SessionUpdate::StateUpdate(acp::StateUpdate::Idle(
                    acp::IdleStateUpdate::new().stop_reason(reason),
                )),
            )
            .await;
    }
    async fn refresh(&mut self) -> Result<(), Error> {
        let work: Work = self
            .client
            .query(
                "agent",
                "work",
                json!({"sessionId":self.session.id,"target":self.target,"cursor":null}),
            )
            .await?;
        match work {
            Work::Delivered {
                shared, execution, ..
            } => {
                self.shared = shared;
                self.execution = Some(execution);
            }
            Work::Pending => {}
            Work::Cancelled => {
                self.cancelled = true;
            }
            Work::Missing | Work::Changed => {
                return Err("Original accepted Agent work is unavailable or changed".into());
            }
        }
        Ok(())
    }
    async fn observe(&mut self) -> Result<acp::StopReason, Error> {
        let mut subscription = self
            .client
            .subscribe(
                "agent",
                "watch",
                json!({"sessionId":self.session.id,"after":self.after}),
            )
            .await?;
        let result = self.observe_stream(&mut subscription).await;
        subscription.close().await?;
        result
    }
    async fn observe_stream(
        &mut self,
        subscription: &mut Subscription,
    ) -> Result<acp::StopReason, Error> {
        for chunk in std::mem::take(&mut self.user) {
            let updates = self.projection.chunk(&chunk)?;
            self.publish(updates).await?;
        }
        self.state(acp::StateUpdate::Running(acp::RunningStateUpdate::new()))
            .await?;
        self.refresh().await?;
        let mut callbacks = JoinSet::<Result<(), Error>>::new();
        let mut seen = HashSet::new();
        let mut pending = Vec::<InteractionSummary>::new();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            if self.cancelled
                || self
                    .execution
                    .as_ref()
                    .is_some_and(|execution| terminal(&execution.state))
            {
                callbacks.abort_all();
                while callbacks.join_next().await.is_some() {}
                return self.finish().await;
            }
            for summary in std::mem::take(&mut pending) {
                if seen.contains(&summary.request_id) {
                    continue;
                }
                let record: InteractionRecord = self
                    .client
                    .query(
                        "agent",
                        "interaction",
                        json!({"sessionId":self.session.id,"requestId":summary.request_id}),
                    )
                    .await?;
                if record.outcome.is_some()
                    || self
                        .execution
                        .as_ref()
                        .is_none_or(|execution| record.turn_id != execution.turn_id)
                {
                    continue;
                }
                if seen.len() >= 1024 || callbacks.len() >= 16 {
                    return Err("ACP interaction limit exceeded".into());
                }
                seen.insert(record.request_id.clone());
                let callback = interaction::request(&record, &self.capabilities)?;
                let client = self.client.clone();
                let peer = self.peer.clone();
                let cancel = self.active.cancel.clone();
                callbacks.spawn(async move {
                    let response = peer.request(callback, &cancel).await?;
                    let current: InteractionRecord = client.query("agent", "interaction", json!({"sessionId":record.session_id,"requestId":record.request_id})).await?;
                    if current.outcome.is_some() { return Ok(()); }
                    let answer = interaction::answer(&current, response)?;
                    let result: InteractionResult = client.mutate("agent", "respond", json!({"sessionId":current.session_id,"requestId":current.request_id,"answer":answer}), Attachments::new()).await?;
                    match result { InteractionResult::Recorded { record } if record.outcome.is_some() => Ok(()), _ => Err("Host rejected interaction response".into()) }
                });
                self.state(acp::StateUpdate::RequiresAction(
                    acp::RequiresActionStateUpdate::new(),
                ))
                .await?;
            }
            // Pull writes once; retain this future across callbacks and heartbeats.
            let next = subscription.next::<DeliveryPage>();
            tokio::pin!(next);
            let page = loop {
                tokio::select! {
                    biased;
                    _ = self.active.cancel.cancelled() => {
                        callbacks.abort_all();
                        while callbacks.join_next().await.is_some() {}
                        self.stop().await?;
                        break None;
                    },
                    result = &mut next => break Some(result?),
                    callback = callbacks.join_next(), if !callbacks.is_empty() => {
                        callback.ok_or("ACP callback task missing")???;
                        if callbacks.is_empty() { self.state(acp::StateUpdate::Running(acp::RunningStateUpdate::new())).await?; }
                    },
                    _ = heartbeat.tick() => {
                        self.refresh().await?;
                        if self.cancelled || self.execution.as_ref().is_some_and(|execution| terminal(&execution.state)) { break None; }
                    },
                }
            };
            let Some(page) = page else {
                continue;
            };
            match page {
                DeliveryPage::Interactions { pending: update } => pending = update.entries,
                page => self.frame(page).await?,
            }
        }
    }
    async fn frame(&mut self, page: DeliveryPage) -> Result<(), Error> {
        if let DeliveryPage::Preview { page } = &page {
            if self.execution.is_none() {
                self.refresh().await?;
            }
            let current = match page {
                PreviewPage::Empty { .. } => true,
                PreviewPage::Cut { invocation_id, .. } => self
                    .execution
                    .as_ref()
                    .is_some_and(|execution| &execution.invocation_id == invocation_id),
            };
            if current {
                let updates = self.projection.preview(page)?;
                self.publish(updates).await?;
            }
            return Ok(());
        }
        if let DeliveryPage::Events {
            events, next_after, ..
        } = page
        {
            // Resolve queued work before deciding which execution's events belong here.
            if self.execution.is_none() {
                self.refresh().await?;
            }
            let mut catchup = false;
            let mut refresh_tools = HashSet::new();
            let mut ended_steps = HashSet::new();
            for event in events {
                if self
                    .execution
                    .as_ref()
                    .is_none_or(|execution| execution.invocation_id != event.invocation_id)
                {
                    continue;
                }
                match event.fact {
                    DeliveryFact::ExecutorStarted { message_id } => {
                        self.parts.insert(
                            (event.invocation_id.clone(), "text".into()),
                            (message_id.clone(), ContentKind::Text),
                        );
                        self.parts.insert(
                            (event.invocation_id, "thinking".into()),
                            (message_id, ContentKind::Thinking),
                        );
                    }
                    DeliveryFact::Delta {
                        step_id,
                        part_id,
                        text,
                    } => {
                        let (message, kind) = self
                            .parts
                            .get(&(step_id, part_id))
                            .ok_or("Agent stream delta has no original part")?;
                        let updates = self.projection.append(&event.turn_id, message, kind, &text);
                        self.publish(updates).await?;
                    }
                    DeliveryFact::PartCommitted {
                        step_id,
                        message_id,
                        ..
                    } => {
                        self.projection.commit_preview(
                            &event.invocation_id,
                            &step_id,
                            Some(&message_id),
                        );
                        catchup = true;
                    }
                    DeliveryFact::StepEnded { step_id, .. } => {
                        self.projection
                            .commit_preview(&event.invocation_id, &step_id, None);
                        ended_steps.insert(step_id);
                        catchup = true;
                    }
                    DeliveryFact::ToolDispatched { tool_use_id, .. } => {
                        if let Some(position) = self.projection.tool_position(&tool_use_id) {
                            refresh_tools.insert(position);
                        }
                        catchup = true;
                    }
                    DeliveryFact::TranscriptChanged
                    | DeliveryFact::ToolInputReady { .. }
                    | DeliveryFact::ToolRejected { .. }
                    | DeliveryFact::ToolSettled { .. }
                    | DeliveryFact::ProviderToolResult { .. }
                    | DeliveryFact::ExecutorToolStart { .. }
                    | DeliveryFact::ExecutorToolResult { .. }
                    | DeliveryFact::Ended { .. } => {
                        catchup = true;
                    }
                    _ => {}
                }
            }
            if catchup {
                self.catchup(next_after, refresh_tools, Some(&ended_steps))
                    .await?;
                self.refresh().await?;
            }
        } else {
            self.refresh().await?;
        }
        Ok(())
    }
    async fn catchup(
        &mut self,
        through: u64,
        refresh_tools: HashSet<maka_agent_ports::session::history::RowPosition>,
        ended_steps: Option<&HashSet<String>>,
    ) -> Result<(), Error> {
        let snapshot = history::since(
            &self.client,
            &self.session.id,
            through,
            self.history_through,
        )
        .await?;
        let mut chunks = snapshot.chunks;
        for position in refresh_tools {
            chunks.extend(history::row(&self.client, &self.session.id, through, position).await?);
        }
        for chunk in chunks {
            if self
                .execution
                .as_ref()
                .is_some_and(|execution| chunk.turn_id == execution.turn_id)
            {
                let updates = self.projection.chunk(&chunk)?;
                self.publish(updates).await?;
            }
        }
        for (position, field) in self.projection.pending_model_positions(ended_steps) {
            let metadata =
                history::model_metadata(&self.client, &self.session.id, through, position, field)
                    .await?;
            if let Some(update) = self.projection.prepare_model_metadata(&metadata)? {
                self.publish(vec![update.update.clone()]).await?;
                self.projection.commit_model_metadata(update);
            }
        }
        self.projection.acknowledge_models(ended_steps);
        self.history_through = snapshot.through;
        Ok(())
    }
    async fn finish(&mut self) -> Result<acp::StopReason, Error> {
        let observation: Observation = self
            .client
            .query("agent", "observe", json!({"sessionId":self.session.id}))
            .await?;
        let refresh_tools = self.projection.unsettled_tool_positions().collect();
        self.catchup(observation.through, refresh_tools, None)
            .await?;
        if self.cancelled {
            return Ok(acp::StopReason::Cancelled);
        }
        let execution = self
            .execution
            .as_ref()
            .ok_or("Agent work has not settled")?;
        let updates = self.projection.finish(
            &execution.turn_id,
            matches!(execution.state, ExecutionState::Completed),
        )?;
        self.publish(updates).await?;
        Ok(match execution.state {
            ExecutionState::Completed => acp::StopReason::EndTurn,
            ExecutionState::Cancelled => acp::StopReason::Cancelled,
            ExecutionState::Failed => acp::StopReason::Other(acp::OtherStopReason::new(
                "_maka_failed",
                Default::default(),
            )),
            ExecutionState::Paused => acp::StopReason::Other(acp::OtherStopReason::new(
                "_maka_paused",
                Default::default(),
            )),
            _ => return Err("Agent work is not physically settled".into()),
        })
    }
    async fn stop(&mut self) -> Result<(), Error> {
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut requested = false;
            loop {
                self.refresh().await?;
                if self.cancelled || self.execution.as_ref().is_some_and(|execution| terminal(&execution.state)) { return Ok::<_, Error>(()); }
                if let Some(execution) = &self.execution {
                    if self.shared { return Err("Accepted input shares another caller's execution; cannot stop that execution".into()); }
                    if !requested {
                        let _: Stopped = self.client.mutate("agent", "stop", json!({"sessionId":self.session.id,"invocationId":execution.invocation_id}), Attachments::new()).await?;
                        requested = true;
                    }
                } else if let WorkTarget::Message { message_id } = &self.target {
                    let queue: Queue = self.client.query("agent", "queue", json!({"sessionId":self.session.id})).await?;
                    if queue.entries.iter().any(|entry| &entry.message_id == message_id) {
                        let _: QueueMutationResult = self.client.mutate("agent", "editQueue", json!({"sessionId":self.session.id,"expectedRevision":queue.revision,"edit":{"kind":"retract","messageId":message_id}}), Attachments::new()).await?;
                    }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }).await.map_err(|_| "Agent cancellation has not physically settled")?
    }
    async fn state(&self, state: acp::StateUpdate) -> Result<(), Error> {
        self.peer
            .update(&self.session.id, acp::SessionUpdate::StateUpdate(state))
            .await
    }
    async fn publish(&self, updates: Vec<acp::SessionUpdate>) -> Result<(), Error> {
        for update in updates {
            self.peer.update(&self.session.id, update).await?;
        }
        Ok(())
    }
}
fn terminal(state: &ExecutionState) -> bool {
    matches!(
        state,
        ExecutionState::Completed
            | ExecutionState::Failed
            | ExecutionState::Cancelled
            | ExecutionState::Paused
    )
}
