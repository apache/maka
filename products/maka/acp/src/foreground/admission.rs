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
pub(crate) struct Admission {
    pub client: Client,
    pub peer: Peer,
    pub session: Arc<Session>,
    pub active: Active,
    pub capabilities: Capabilities,
}
impl Admission {
    async fn input(
        &self,
        content: Vec<content::Input>,
        idle_only: bool,
    ) -> Result<(serde_json::Value, u64), Error> {
        let Self {
            client,
            session,
            active,
            ..
        } = self;
        let preferences = session.preferences.lock().await.clone();
        let model = configuration::resolve(client, &preferences).await?;
        let observation: Observation = client
            .query("agent", "observe", json!({"sessionId":session.id}))
            .await?;
        if idle_only
            && (observation.session.archived
                || !matches!(observation.session.activity, SessionActivity::Idle))
        {
            return Err("Host session already has active work or is archived".into());
        }
        let content = content::prepare(client, &session.id, content, &active.cancel).await?;
        if active.cancel.is_cancelled() {
            return Err("Prompt cancelled before admission".into());
        }
        let input = json!({
            "sessionId":session.id, "message":content.text, "attachments":content.attachments,
            "backend":{"kind":"model","connectionId":model.connection_id,
                "modelId":model.model_id,"thinkingLevel":preferences.thinking}
        });
        Ok((input, observation.through))
    }
    pub async fn v2(
        self,
        content: Vec<content::Input>,
        key: Option<agent_client_protocol::v2::schema::IdempotencyKey>,
    ) -> Result<(String, Option<Foreground>), Error> {
        let (mut input, after) = self.input(content, false).await.map_err(|error| {
            if self.active.cancel.is_cancelled() {
                agent_client_protocol::Error::request_cancelled().into()
            } else {
                error
            }
        })?;
        input["idempotencyKey"] = json!(key);
        let receipt = self
            .client
            .mutate("agent", "submitMessage", input, Attachments::new())
            .await?;
        let (message_id, duplicate) = match receipt {
            MessageSubmissionResult::Queued { message_id } => (message_id, false),
            MessageSubmissionResult::Duplicate { message_id } => (message_id, true),
        };
        let run = Foreground::wait_inserted(
            &self.client,
            &self.session.id,
            &message_id,
            Some(after),
            &self.active.cancel,
        )
        .await?;
        if duplicate {
            return Ok((message_id, None));
        }
        let foreground = self.foreground(after, Some(run), message_id.clone());
        Ok((message_id, Some(foreground)))
    }
    pub async fn v1(self, content: Vec<content::Input>) -> Result<Foreground, Error> {
        let (mut input, after) = self.input(content, true).await?;
        input["delivery"] = "steer".into();
        let (started, message_id) = match self
            .client
            .mutate("agent", "send", input, Attachments::new())
            .await?
        {
            SendResult::Started {
                run_id, message_id, ..
            } => (Some(run_id), message_id),
            SendResult::Queued { message_id, .. } => (None, message_id),
            SendResult::Rejected { .. } | SendResult::NotYourWorker { .. } => {
                return Err("Host rejected Agent input".into());
            }
            SendResult::Posted { .. } => {
                return Err("ACP prompts require an Agent session".into());
            }
        };
        Ok(self.foreground(after, started, message_id))
    }
    fn foreground(self, after: u64, started: Option<RunId>, message_id: String) -> Foreground {
        let Self {
            client,
            peer,
            session,
            active,
            capabilities,
        } = self;
        Foreground {
            client,
            peer,
            session,
            active,
            message_id,
            work: WorkObservation::Pending,
            projection: Projection::default(),
            capabilities,
            after,
            history_through: after,
            parts: HashMap::new(),
            message_starts: HashMap::new(),
            started,
        }
    }
}

impl Foreground {
    pub async fn wait_inserted(
        client: &Client,
        session: &str,
        message: &str,
        after: Option<u64>,
        cancel: &CancellationToken,
    ) -> Result<RunId, Error> {
        let target = json!({"sessionId":session,"target":{"kind":"message","messageId":message}});
        let resolved = || async {
            match client.query("agent", "work", target.clone()).await? {
                Work::Delivered { execution, .. } => Ok::<_, Error>(Some(execution.run_id)),
                Work::Cancelled => Err(agent_client_protocol::Error::request_cancelled().into()),
                Work::Pending => Ok(None),
                Work::Missing | Work::Changed => Err("Submitted Agent input disappeared".into()),
            }
        };
        if let Some(run) = resolved().await? {
            return Ok(run);
        }
        let after = match after {
            Some(cursor) => cursor,
            None => {
                client
                    .query::<Observation>("agent", "observe", json!({"sessionId":session}))
                    .await?
                    .through
            }
        };
        let mut watch = client
            .subscribe("agent", "watch", json!({"sessionId":session,"after":after}))
            .await?;
        // watch emits an initial queue cut, then only changed revisions. A row
        // disappearing is not proof of delivery: retract and consume race here.
        let result = async {
            let delivered = async {
                loop {
                    if let DeliveryPage::Queue { queue } = watch.next().await?
                        && !queue
                            .entries
                            .iter()
                            .any(|entry| entry.message_id == message)
                        && let Some(run) = resolved().await?
                    {
                        return Ok(run);
                    }
                }
            };
            tokio::pin!(delivered);
            tokio::select! {
                result = &mut delivered => result,
                _ = cancel.cancelled() => {
                    let _: WithdrawalResult = client.mutate("agent","withdrawSubmission",
                        json!({"sessionId":session,"messageId":message}),Attachments::new()).await?;
                    // Drain the same pull; the durable queue cut resolves both possible winners.
                    delivered.await
                }
            }
        }
        .await;
        // Insertion/retraction is already settled; a stream cleanup error
        // cannot change the prompt result.
        if let Err(error) = watch.close().await {
            eprintln!("ACP admission watch cleanup: {error}");
        }
        result
    }
}
