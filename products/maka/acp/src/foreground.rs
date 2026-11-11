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
use crate::{
    interaction::Capabilities,
    presentation::{Completion, State},
};
use maka_agent_api::contract::*;
use maka_agent_facts::{
    durable::{ModelAttemptId, StepId},
    interaction::InteractionRecord,
};
use maka_capabilities::call::Attachments;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
mod admission;
pub(crate) struct Prompt {
    pub content: Vec<crate::content::Input>,
}
pub(crate) struct Foreground {
    client: Client,
    peer: Peer,
    session: Arc<Session>,
    active: Active,
    target: WorkTarget,
    work: WorkObservation,
    projection: Projection,
    capabilities: Capabilities,
    after: u64,
    history_through: u64,
    parts: HashMap<(StepId, ModelAttemptId, String), (String, ContentKind)>,
    message_starts: HashMap<String, u64>,
    user: Vec<HistoryChunk>,
}

#[expect(
    clippy::large_enum_variant,
    reason = "one observation slot per foreground run, replaced on refresh; inline execution avoids allocating on each delivery"
)]
enum WorkObservation {
    Pending,
    Delivered { execution: Execution, shared: bool },
    Cancelled,
}

impl WorkObservation {
    fn execution(&self) -> Option<&Execution> {
        match self {
            Self::Delivered { execution, .. } => Some(execution),
            Self::Pending | Self::Cancelled => None,
        }
    }

    fn settled(&self) -> bool {
        match self {
            Self::Pending => false,
            Self::Delivered { execution, .. } => terminal(&execution.state),
            Self::Cancelled => true,
        }
    }
}

impl Foreground {
    /// Retain session admission until the caller publishes protocol completion.
    pub async fn run(&mut self) -> Result<Completion, Error> {
        let result = self.observe().await;
        if let Err(error) = &result
            && let Err(cleanup) = self.stop().await
        {
            self.peer.stop.cancel();
            return Err(format!("{}; original work cleanup: {cleanup}", error).into());
        }
        result
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
        self.work = match work {
            Work::Delivered {
                shared, execution, ..
            } => WorkObservation::Delivered { execution, shared },
            Work::Pending => WorkObservation::Pending,
            Work::Cancelled => WorkObservation::Cancelled,
            Work::Missing | Work::Changed => {
                return Err("Original accepted Agent work is unavailable or changed".into());
            }
        };
        Ok(())
    }
    async fn observe(&mut self) -> Result<Completion, Error> {
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
    ) -> Result<Completion, Error> {
        for chunk in std::mem::take(&mut self.user) {
            let updates = self.projection.chunk(&chunk)?;
            self.publish(updates).await?;
        }
        self.refresh().await?;
        self.state(State::Running).await?;
        let mut callbacks = JoinSet::<Result<String, Error>>::new();
        let mut seen = HashSet::new();
        // Cancel only the client prompt wait; never abort an in-flight Host call.
        let mut live = HashMap::<String, CancellationToken>::new();
        let mut pending = Vec::<InteractionSummary>::new();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            if self.work.settled() {
                for cancel in live.values() {
                    cancel.cancel();
                }
                while let Some(callback) = callbacks.join_next().await {
                    let request_id = callback.map_err(Error::from)??;
                    live.remove(&request_id);
                }
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
                        .work
                        .execution()
                        .is_none_or(|execution| record.execution.run_id != execution.run_id)
                {
                    continue;
                }
                seen.insert(record.request_id.clone());
                let callback = interaction::request(&record, &self.capabilities)?;
                let client = self.client.clone();
                let peer = self.peer.clone();
                let cancel = self.active.cancel.child_token();
                let request_cancel = cancel.clone();
                let request_id = record.request_id.clone();
                callbacks.spawn(async move {
                    let response = match peer.request(callback, &request_cancel).await {
                        Ok(response) => response,
                        Err(_) if request_cancel.is_cancelled() && !peer.stop.is_cancelled() => {
                            return Ok(record.request_id);
                        }
                        Err(error) => return Err(error),
                    };
                    if request_cancel.is_cancelled() {
                        return Ok(record.request_id);
                    }
                    let current: InteractionRecord = client
                        .query(
                            "agent",
                            "interaction",
                            json!({"sessionId":record.execution.session_id,"requestId":record.request_id}),
                        )
                        .await?;
                    if current.outcome.is_some() || request_cancel.is_cancelled() {
                        return Ok(record.request_id);
                    }
                    let answer = interaction::answer(&current, response)?;
                    let result: InteractionResult = client
                        .mutate(
                            "agent",
                            "respond",
                            json!({"sessionId":current.execution.session_id,"requestId":current.request_id,"answer":answer}),
                            Attachments::new(),
                        )
                        .await?;
                    match result {
                        InteractionResult::Recorded { record: committed }
                            if committed.outcome.is_some() =>
                        {
                            Ok(record.request_id)
                        }
                        _ if request_cancel.is_cancelled() => Ok(record.request_id),
                        _ => Err("Host rejected interaction response".into()),
                    }
                });
                live.insert(request_id, cancel);
                self.state(State::RequiresAction).await?;
            }
            // Pull writes once; retain this future across callbacks and heartbeats.
            let next = subscription.next::<DeliveryPage>();
            tokio::pin!(next);
            let page = loop {
                tokio::select! {
                    biased;
                    _ = self.active.cancel.cancelled() => {
                        while let Some(callback) = callbacks.join_next().await {
                            let request_id = callback.map_err(Error::from)??;
                            live.remove(&request_id);
                        }
                        self.stop().await?;
                        break None;
                    },
                    result = &mut next => break Some(result?),
                    callback = callbacks.join_next(), if !callbacks.is_empty() => {
                        let request_id = callback.ok_or("ACP callback task missing")???;
                        live.remove(&request_id);
                        if callbacks.is_empty() {
                            self.state(State::Running).await?;
                        }
                    },
                    _ = heartbeat.tick() => {
                        self.refresh().await?;
                        if self.work.settled() { break None; }
                    },
                }
            };
            let Some(page) = page else {
                continue;
            };
            match page {
                DeliveryPage::Interactions { pending: update } => {
                    // An interaction settled without this client, such as one
                    // its producer resolved, no longer waits for its answer.
                    live.retain(|request_id, cancel| {
                        let waiting = update
                            .entries
                            .iter()
                            .any(|entry| &entry.request_id == request_id);
                        if !waiting {
                            cancel.cancel();
                        }
                        waiting
                    });
                    pending = update.entries;
                }
                page => self.frame(page).await?,
            }
        }
    }
    async fn frame(&mut self, page: DeliveryPage) -> Result<(), Error> {
        if let DeliveryPage::Preview { page } = &page {
            if self.work.execution().is_none() {
                self.refresh().await?;
            }
            let current = match page {
                PreviewPage::Empty { .. } => true,
                PreviewPage::Cut { run_id, .. } => self
                    .work
                    .execution()
                    .is_some_and(|execution| &execution.run_id == run_id),
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
            if self.work.execution().is_none() {
                self.refresh().await?;
            }
            let mut catchup = false;
            let mut catchup_from = self.history_through;
            let mut refresh_tools = HashSet::new();
            let mut ended_steps = HashSet::new();
            for event in events {
                if self
                    .work
                    .execution()
                    .is_none_or(|execution| execution.run_id != event.run_id)
                {
                    continue;
                }
                match event.fact {
                    DeliveryFact::ExecutorMessageStarted {
                        message_id,
                        step_id,
                        attempt_id,
                    } => {
                        self.parts.insert(
                            (step_id, attempt_id, "text".into()),
                            (message_id.clone(), ContentKind::Text),
                        );
                        self.parts.insert(
                            (step_id, attempt_id, "thinking".into()),
                            (message_id.clone(), ContentKind::Thinking),
                        );
                        self.message_starts
                            .entry(message_id)
                            .or_insert(event.sequence);
                    }
                    DeliveryFact::Delta {
                        step_id,
                        attempt_id,
                        part_id,
                        text,
                    } => {
                        let (message, kind) = self
                            .parts
                            .get(&(step_id, attempt_id, part_id))
                            .ok_or("Agent stream delta has no original part")?;
                        let updates = self.projection.append(&event.turn_id, message, kind, &text);
                        self.publish(updates).await?;
                    }
                    DeliveryFact::PartCommitted {
                        step_id,
                        attempt_id,
                        message_id,
                        ..
                    } => {
                        self.projection.commit_preview(
                            event.run_id,
                            step_id,
                            attempt_id,
                            Some(&message_id),
                        );
                        if let Some(start) = self.message_starts.remove(&message_id) {
                            catchup_from = catchup_from.min(start.saturating_sub(1));
                        }
                        catchup = true;
                    }
                    DeliveryFact::StepEnded {
                        step_id,
                        attempt_id,
                        ..
                    } => {
                        self.projection
                            .commit_preview(event.run_id, step_id, attempt_id, None);
                        ended_steps.insert((step_id, attempt_id));
                        catchup = true;
                    }
                    DeliveryFact::ToolDispatched { tool_use_id, .. } => {
                        if let Some(position) = self.projection.tool_position(&tool_use_id) {
                            refresh_tools.insert(position);
                        }
                        catchup = true;
                    }
                    DeliveryFact::Ended { .. } => {
                        for (_, start) in self.message_starts.drain() {
                            catchup_from = catchup_from.min(start.saturating_sub(1));
                        }
                        catchup = true;
                    }
                    DeliveryFact::TranscriptChanged
                    | DeliveryFact::ToolInputReady { .. }
                    | DeliveryFact::ToolRejected { .. }
                    | DeliveryFact::ToolSettled { .. }
                    | DeliveryFact::ProviderToolResult { .. }
                    | DeliveryFact::ExecutorToolStart { .. }
                    | DeliveryFact::ExecutorToolResult { .. } => {
                        catchup = true;
                    }
                    _ => {}
                }
            }
            if catchup {
                self.catchup(next_after, catchup_from, refresh_tools, Some(&ended_steps))
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
        after: u64,
        refresh_tools: HashSet<maka_agent_ports::session::history::RowPosition>,
        ended_steps: Option<&HashSet<(StepId, ModelAttemptId)>>,
    ) -> Result<(), Error> {
        let snapshot = history::since(&self.client, &self.session.id, through, after).await?;
        let mut chunks = snapshot.chunks;
        for position in refresh_tools {
            chunks.extend(history::row(&self.client, &self.session.id, through, position).await?);
        }
        for chunk in chunks {
            if self
                .work
                .execution()
                .is_some_and(|execution| chunk.run_id == Some(execution.run_id))
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
        self.history_through = self.history_through.max(snapshot.through);
        Ok(())
    }
    async fn finish(&mut self) -> Result<Completion, Error> {
        let observation: Observation = self
            .client
            .query("agent", "observe", json!({"sessionId":self.session.id}))
            .await?;
        let mut catchup_from = self.history_through;
        for (_, start) in self.message_starts.drain() {
            catchup_from = catchup_from.min(start.saturating_sub(1));
        }
        let refresh_tools = self.projection.unsettled_tool_positions().collect();
        self.catchup(observation.through, catchup_from, refresh_tools, None)
            .await?;
        if matches!(self.work, WorkObservation::Cancelled) {
            return Ok(Completion::Cancelled);
        }
        let execution = self.work.execution().ok_or("Agent work has not settled")?;
        let updates = self.projection.finish(
            &execution.turn_id,
            matches!(execution.state, ExecutionState::Completed),
        )?;
        self.publish(updates).await?;
        Ok(match execution.state {
            ExecutionState::Completed => Completion::Completed,
            ExecutionState::Cancelled => Completion::Cancelled,
            ExecutionState::Failed { .. } => Completion::Failed,
            ExecutionState::Admitted | ExecutionState::Running | ExecutionState::Waiting { .. } => {
                return Err("Agent work is not physically settled".into());
            }
        })
    }
    async fn stop(&mut self) -> Result<(), Error> {
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut requested = false;
            loop {
                self.refresh().await?;
                if self.work.settled() { return Ok::<_, Error>(()); }
                if let WorkObservation::Delivered { execution, shared } = &self.work {
                    if *shared { return Err("Accepted input shares another caller's execution; cannot stop that execution".into()); }
                    if !requested {
                        let _: Stopped = self.client.mutate("agent", "stop", json!({"sessionId":self.session.id,"runId":execution.run_id}), Attachments::new()).await?;
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
    async fn state(&self, state: State) -> Result<(), Error> {
        self.peer.state(&self.session.id, state).await
    }
    async fn publish(&self, updates: Vec<crate::presentation::Update>) -> Result<(), Error> {
        for update in updates {
            self.peer.update(&self.session.id, update).await?;
        }
        Ok(())
    }
}
fn terminal(state: &ExecutionState) -> bool {
    match state {
        ExecutionState::Completed | ExecutionState::Failed { .. } | ExecutionState::Cancelled => {
            true
        }
        ExecutionState::Admitted | ExecutionState::Running | ExecutionState::Waiting { .. } => {
            false
        }
    }
}
