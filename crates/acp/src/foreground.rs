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
    Error, history, interaction,
    observation::Subscription,
    projection::Projection,
    session::{Active, Session},
    transport::Peer,
};
use agent_client_protocol::schema::v2 as acp;
use maka_client::Client;
use maka_protocol::{subscription::*, turn::*};
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::task::JoinSet;

mod admission;

pub(crate) struct Prompt {
    pub turn_id: String,
    pub content: Vec<acp::ContentBlock>,
}

pub(crate) struct Foreground {
    client: Client,
    peer: Peer,
    session: Arc<Session>,
    active: Active,
    subscription: Subscription,
    turn: TurnSnapshot,
    projection: Projection,
    capabilities: acp::ClientCapabilities,
    after: Option<u64>,
    user: Option<serde_json::Value>,
}

impl Foreground {
    pub async fn run(mut self) {
        let result = self.observe().await;
        let (reason, failure) = match result {
            Ok(reason) => (
                reason,
                match &self.turn.state {
                    TurnState::Failed {
                        failure_class,
                        failure_message,
                        ..
                    } => Some(format!(
                        "{failure_class}: {}",
                        failure_message.as_deref().unwrap_or("")
                    )),
                    _ => None,
                },
            ),
            Err(error) => {
                let settlement = self.stop().await;
                eprintln!(
                    "ACP turn {}: {error}; cleanup: {settlement:?}",
                    self.turn.turn_id
                );
                (
                    acp::StopReason::Other("_maka_failed".into()),
                    Some(error.to_string()),
                )
            }
        };
        if let Err(error) = self.subscription.close().await {
            eprintln!("ACP subscription cleanup: {error}");
        }
        // Idle means another prompt can enter immediately, not after cleanup.
        drop(self.active);
        let mut idle = acp::IdleStateUpdate::new().stop_reason(reason);
        if let Some(failure) = failure {
            idle = idle.meta(serde_json::json!({"maka":{"error":failure.chars().take(4096).collect::<String>(),"turnId":self.turn.turn_id}}).as_object().cloned());
        }
        // No session updates may follow this transition from this foreground.
        let _ = self
            .peer
            .update(
                &self.session.id,
                acp::SessionUpdate::StateUpdate(acp::StateUpdate::Idle(idle)),
            )
            .await;
    }

    async fn observe(&mut self) -> Result<acp::StopReason, Error> {
        if let Some(user) = self.user.take() {
            let updates = self.projection.row(&user)?;
            self.publish(updates).await?;
        }
        self.state(acp::StateUpdate::Running(acp::RunningStateUpdate::new()))
            .await?;
        let mut callbacks = JoinSet::<Result<(), Error>>::new();
        let mut seen = HashSet::new();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            if terminal(&self.turn.state) {
                callbacks.abort_all();
                while callbacks.join_next().await.is_some() {}
                return self.finish().await;
            }
            for request in self.subscription.snapshot.interactions.pending() {
                if request.turn_id() != self.turn.turn_id
                    || !seen.insert(request.interaction_id().to_owned())
                {
                    continue;
                }
                if seen.len() > 1024 || callbacks.len() >= 16 {
                    return Err("ACP interaction limit exceeded".into());
                }
                let callback = interaction::request(request, &self.capabilities)?;
                let request = request.clone();
                let peer = self.peer.clone();
                let client = self.client.clone();
                let cancel = self.active.cancel.clone();
                callbacks.spawn(async move {
                    let response = peer.request(callback, &cancel).await?;
                    let current = client.interaction(&request).await?;
                    if current.is_pending() {
                        client
                            .answer_interaction(&current, interaction::answer(&current, response)?)
                            .await?;
                    }
                    Ok(())
                });
                self.state(acp::StateUpdate::RequiresAction(
                    acp::RequiresActionStateUpdate::new(),
                ))
                .await?;
            }
            tokio::select! {
                biased;
                _ = self.active.cancel.cancelled() => {
                    callbacks.abort_all();
                    while callbacks.join_next().await.is_some() {}
                    self.turn = self.stop().await?;
                }
                completed = callbacks.join_next(), if !callbacks.is_empty() => {
                    completed.ok_or("ACP callback task missing")???;
                    if callbacks.is_empty() {
                        self.state(acp::StateUpdate::Running(acp::RunningStateUpdate::new())).await?;
                    }
                }
                frame = self.subscription.receiver.recv() => {
                    let frame = frame.ok_or("Host observation ended")?;
                    self.frame(frame).await?;
                }
                _ = heartbeat.tick() => {
                    self.turn = self.client.query_turn(TurnQueryInput { session_id: self.session.id.clone(), turn_id: self.turn.turn_id.clone() }).await?;
                }
            }
        }
    }

    async fn frame(&mut self, frame: ObservationFrame) -> Result<(), Error> {
        if frame.is_closed() {
            return Err("Host closed ACP observation".into());
        }
        self.subscription.observe(&frame);
        let updates = match frame {
            ObservationFrame::Assistant(AssistantObservationFrame::SessionDelta {
                delta, ..
            }) if delta.turn_id == self.turn.turn_id => self.projection.delta(&delta)?,
            ObservationFrame::Tool(ToolObservationFrame::SessionEvent {
                event, run_id, ..
            }) if run_id == self.turn.run_id => self.projection.tool(&event)?,
            ObservationFrame::Projection(_) => {
                if let Some(turn) = &self.subscription.snapshot.root_turn
                    && turn.turn_id == self.turn.turn_id
                {
                    self.turn = turn.clone();
                }
                vec![]
            }
            _ => vec![],
        };
        self.publish(updates).await
    }

    async fn finish(&mut self) -> Result<acp::StopReason, Error> {
        for row in history::snapshot(&self.client, &self.session.id, self.after).await? {
            if row.value["turnId"] == self.turn.turn_id {
                let updates = self.projection.row(&row.value)?;
                self.publish(updates).await?;
            }
        }
        let completed = matches!(self.turn.state, TurnState::Completed { .. });
        let updates = self.projection.finish(&self.turn.turn_id, completed)?;
        self.publish(updates).await?;
        Ok(match &self.turn.state {
            TurnState::Completed { .. } => acp::StopReason::EndTurn,
            TurnState::Cancelled { .. } => acp::StopReason::Cancelled,
            TurnState::Failed {
                failure_class,
                failure_message,
                ..
            } => {
                eprintln!(
                    "ACP turn failed ({failure_class}): {}",
                    failure_message.as_deref().unwrap_or("")
                );
                acp::StopReason::Other("_maka_failed".into())
            }
            _ => return Err("Turn settlement is not terminal".into()),
        })
    }
    async fn stop(&self) -> Result<TurnSnapshot, Error> {
        let mut turn = self
            .client
            .stop_turn(TurnStopInput {
                session_id: self.session.id.clone(),
                turn_id: self.turn.turn_id.clone(),
                run_id: self.turn.run_id.clone(),
            })
            .await?;
        tokio::time::timeout(Duration::from_secs(15), async {
            while !terminal(&turn.state) {
                tokio::time::sleep(Duration::from_millis(100)).await;
                turn = self
                    .client
                    .query_turn(TurnQueryInput {
                        session_id: self.session.id.clone(),
                        turn_id: self.turn.turn_id.clone(),
                    })
                    .await?;
            }
            Ok::<_, Error>(turn)
        })
        .await?
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
fn terminal(state: &TurnState) -> bool {
    matches!(
        state,
        TurnState::Completed { .. } | TurnState::Cancelled { .. } | TurnState::Failed { .. }
    )
}
