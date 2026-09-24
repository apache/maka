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

use super::*;
use crate::{content, observation::Routes};

impl Foreground {
    pub async fn prepare(
        client: Client,
        peer: Peer,
        routes: &Routes,
        session: Arc<Session>,
        active: Active,
        capabilities: acp::ClientCapabilities,
        prompt: Prompt,
    ) -> Result<(String, Self), Error> {
        let content =
            content::prepare(&client, &session.id, prompt.content, &active.cancel).await?;
        let subscription = Subscription::open(&client, routes, &session.id).await?;
        if active.cancel.is_cancelled() {
            return Err("Prompt cancelled before admission".into());
        }
        let turn_id = prompt.turn_id;
        // Never drop or replay an in-flight admission when cancel arrives.
        let receipt = client
            .start_turn_pending(TurnStartInput {
                session_id: session.id.clone(),
                turn_id: turn_id.clone(),
                content,
                input_selections: Default::default(),
                turn_orchestration: None,
                max_steps: None,
            })
            .await
            .map_err(|error| format!("Turn {turn_id} admission: {error}"))?;
        let admitted = receipt.settle().await.map_err(|error| {
            if matches!(error, maka_client::RequestFailure::Unknown(_)) {
                // A broken Host connection cannot prove rejection. End the
                // façade with the original identity, never announce cancellation.
                eprintln!(
                    "ACP session {} turn {turn_id} admission unresolved: {error}",
                    session.id
                );
                client.disconnect();
            }
            format!("Turn {turn_id} admission: {error}")
        })?;
        let turn = match admitted {
            TurnStartResult::Started { turn, .. } => turn,
            TurnStartResult::Blocked { message, .. } => return Err(message.into()),
        };
        let mut foreground = Self {
            after: subscription.through,
            client,
            peer,
            session,
            active,
            subscription,
            turn,
            projection: Projection::default(),
            capabilities,
            user: None,
        };
        if foreground.active.cancel.is_cancelled() {
            foreground.turn = foreground.stop().await?;
        }
        let message = foreground.accepted_message().await;
        match message {
            Ok(user) => {
                let id = user["id"]
                    .as_str()
                    .ok_or("User message identity is missing")?
                    .to_owned();
                foreground.user = Some(user);
                Ok((id, foreground))
            }
            Err(error) => {
                let settlement = foreground.stop().await;
                Err(format!("{error}; admission cleanup: {settlement:?}").into())
            }
        }
    }

    async fn accepted_message(&self) -> Result<serde_json::Value, Error> {
        history::snapshot(&self.client, &self.session.id, self.after)
            .await?
            .into_iter()
            .find(|row| row.value["type"] == "user" && row.value["turnId"] == self.turn.turn_id)
            .map(|row| row.value)
            .ok_or_else(|| "Admitted turn has no durable user message".into())
    }
}
