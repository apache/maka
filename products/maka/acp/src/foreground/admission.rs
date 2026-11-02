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
use crate::{configuration, content};
impl Foreground {
    pub async fn prepare(
        client: Client,
        peer: Peer,
        session: Arc<Session>,
        active: Active,
        capabilities: acp::ClientCapabilities,
        prompt: Prompt,
    ) -> Result<(String, Self), Error> {
        let preferences = session.preferences.lock().await.clone();
        let model = configuration::resolve(&client, &preferences).await?;
        let observation: Observation = client
            .query("agent", "observe", json!({"sessionId":session.id}))
            .await?;
        if observation.session.archived
            || !matches!(observation.session.activity, SessionActivity::Idle)
        {
            return Err("Host session already has active work or is archived".into());
        }
        let content =
            content::prepare(&client, &session.id, prompt.content, &active.cancel).await?;
        if active.cancel.is_cancelled() {
            return Err("Prompt cancelled before admission".into());
        }
        let result: SendResult = client.mutate("agent", "send", json!({"sessionId":session.id,"message":content.text,"attachments":content.attachments,"model":model,"thinkingLevel":preferences.thinking}), Attachments::new()).await?;
        let (target, message) = match result {
            SendResult::Started { invocation_id, .. } => {
                (WorkTarget::Invocation { invocation_id }, None)
            }
            SendResult::Queued { message_id, .. } => (
                WorkTarget::Message {
                    message_id: message_id.clone(),
                },
                Some(message_id),
            ),
            SendResult::Rejected { .. } | SendResult::NotYourWorker { .. } => {
                return Err("Host rejected Agent input".into());
            }
        };
        let mut foreground = Self {
            client,
            peer,
            session,
            active,
            target,
            execution: None,
            shared: false,
            cancelled: false,
            projection: Projection::default(),
            capabilities,
            after: observation.through,
            history_through: observation.through,
            parts: HashMap::new(),
            user: Vec::new(),
        };
        let result = async {
            foreground.refresh().await?;
            if let Some(message) = message {
                return Ok(message);
            }
            let execution = foreground
                .execution
                .as_ref()
                .ok_or("Accepted invocation has no execution receipt")?;
            foreground.user = history::read(
                &foreground.client,
                &foreground.session.id,
                None,
                Some(foreground.after),
            )
            .await?
            .into_iter()
            .filter(|chunk| {
                chunk.role == maka_agent_ports::session::history::Role::User
                    && chunk.turn_id == execution.turn_id
            })
            .collect();
            foreground
                .user
                .first()
                .map(|chunk| chunk.message_id.clone())
                .ok_or_else(|| "Accepted invocation has no durable user message".into())
        }
        .await;
        match result {
            Ok(message) => Ok((message, foreground)),
            Err(error) => {
                if let Err(cleanup) = foreground.stop().await {
                    foreground.peer.stop.cancel();
                    return Err(format!("{error}; original work cleanup: {cleanup}").into());
                }
                Err(error)
            }
        }
    }
}
