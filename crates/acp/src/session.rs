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
mod list;
use crate::{Error, configuration, history, projection::Projection, transport::Peer};
use agent_client_protocol::schema::v2 as acp;
use maka_client::Client;
use maka_protocol::{
    subscription::{SubscriptionOpenInput, TranscriptPolicy},
    turn::TurnState,
};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;
#[derive(Default)]
pub(crate) struct Registry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    creation: AsyncMutex<()>,
}
pub(crate) struct Session {
    pub id: String,
    pub gate: Arc<AsyncMutex<()>>,
    active: Mutex<Option<CancellationToken>>,
    closed: AtomicBool,
}
pub(crate) struct Active {
    session: Arc<Session>,
    pub cancel: CancellationToken,
    _guard: OwnedMutexGuard<()>,
}
impl Session {
    fn new(id: String) -> Arc<Self> {
        Arc::new(Self {
            id,
            gate: Arc::default(),
            active: Mutex::default(),
            closed: AtomicBool::new(false),
        })
    }
    pub fn enter(self: &Arc<Self>, parent: &CancellationToken) -> Result<Active, Error> {
        let guard = self
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| "ACP session is busy")?;
        let mut active = self.active.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) || parent.is_cancelled() {
            return Err("ACP session is closed".into());
        }
        let cancel = parent.child_token();
        *active = Some(cancel.clone());
        Ok(Active {
            session: self.clone(),
            cancel,
            _guard: guard,
        })
    }
    pub fn cancel(&self) {
        if let Some(cancel) = self.active.lock().unwrap().as_ref() {
            cancel.cancel();
        }
    }
}
impl Drop for Active {
    fn drop(&mut self) {
        self.session.active.lock().unwrap().take();
    }
}
impl Registry {
    pub fn cancel_all(&self) {
        for session in self.sessions.lock().unwrap().values() {
            session.cancel();
        }
    }
    /// The caller supplies the shutdown deadline; retain every gate until drained.
    pub async fn drained(&self) {
        let _creation = self.creation.lock().await;
        let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        let mut guards = Vec::with_capacity(sessions.len());
        for session in sessions {
            guards.push(session.gate.clone().lock_owned().await);
        }
    }
    pub fn get(&self, id: &str) -> Result<Arc<Session>, Error> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .filter(|session| !session.closed.load(Ordering::SeqCst))
            .cloned()
            .ok_or_else(|| "ACP session is not open on this connection".into())
    }
    fn capacity(&self) -> Result<(), Error> {
        if self.sessions.lock().unwrap().len() >= 8 {
            return Err("ACP connection session limit reached".into());
        }
        Ok(())
    }
    pub async fn create(
        &self,
        client: &Client,
        peer: &Peer,
        request: acp::NewSessionRequest,
    ) -> Result<acp::NewSessionResponse, Error> {
        unsupported_roots(&request.additional_directories, &request.mcp_servers)?;
        let cwd = list::directory(request.cwd.as_ref()).await?;
        let _creation = self.creation.lock().await;
        if peer.stop.is_cancelled() {
            return Err("ACP transport closed".into());
        }
        self.capacity()?;
        let id = uuid::Uuid::new_v4().to_string();
        let session = configuration::create(client, &id, &cwd).await?;
        let options = configuration::options(client, &session).await?;
        if peer.stop.is_cancelled() {
            return Err("ACP transport closed".into());
        }
        self.sessions
            .lock()
            .unwrap()
            .insert(id.clone(), Session::new(id.clone()));
        Ok(acp::NewSessionResponse::new(id).config_options(options))
    }
    pub async fn resume(
        &self,
        client: &Client,
        peer: &Peer,
        request: acp::ResumeSessionRequest,
    ) -> Result<acp::ResumeSessionResponse, Error> {
        unsupported_roots(&request.additional_directories, &request.mcp_servers)?;
        if request
            .replay_from
            .as_ref()
            .is_some_and(|replay| !matches!(replay, acp::ReplayFrom::Start(_)))
        {
            return Err("Unsupported replay cursor".into());
        }
        let cwd = list::directory(request.cwd.as_ref()).await?;
        let _creation = self.creation.lock().await;
        let id = request.session_id.to_string();
        let existing = self.sessions.lock().unwrap().get(&id).cloned();
        if existing.is_none() {
            self.capacity()?;
        }
        let local = existing.unwrap_or_else(|| Session::new(id.clone()));
        let active = local.enter(&peer.stop)?;
        let session = client
            .session(&id)
            .await?
            .ok_or("Host session does not exist")?;
        list::ensure_idle(&session)?;
        if list::directory(Path::new(&session.workspace.host_cwd)).await? != cwd {
            return Err("Resume cwd differs from Host session workspace".into());
        }
        let options = configuration::options(client, &session).await?;
        if request.replay_from.is_some() {
            replay(client, peer, &id, &active.cancel).await?;
        }
        if peer.stop.is_cancelled() {
            return Err("ACP transport closed".into());
        }
        self.sessions.lock().unwrap().insert(id, local.clone());
        Ok(acp::ResumeSessionResponse::new().config_options(options))
    }
    pub async fn list(
        &self,
        client: &Client,
        request: acp::ListSessionsRequest,
    ) -> Result<acp::ListSessionsResponse, Error> {
        list::read(client, request).await
    }
    pub async fn close(
        &self,
        request: acp::CloseSessionRequest,
    ) -> Result<acp::CloseSessionResponse, Error> {
        let _creation = self.creation.lock().await;
        let id = request.session_id.to_string();
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or("ACP session is not open on this connection")?;
        session.closed.store(true, Ordering::SeqCst);
        session.cancel();
        let _guard =
            tokio::time::timeout(Duration::from_secs(20), session.gate.clone().lock_owned())
                .await
                .map_err(|_| "ACP session cancellation has not settled")?;
        self.sessions.lock().unwrap().remove(&id);
        Ok(acp::CloseSessionResponse::new())
    }
    pub async fn set_config(
        &self,
        client: &Client,
        peer: &Peer,
        request: acp::SetSessionConfigOptionRequest,
    ) -> Result<acp::SetSessionConfigOptionResponse, Error> {
        let local = self.get(&request.session_id.to_string())?;
        let _active = local.enter(&peer.stop)?;
        let session = client
            .session(&local.id)
            .await?
            .ok_or("Host session does not exist")?;
        list::ensure_idle(&session)?;
        let updated = configuration::set(client, &session, request).await?;
        let options = configuration::options(client, &updated).await?;
        peer.update(
            &local.id,
            acp::SessionUpdate::ConfigOptionUpdate(acp::ConfigOptionUpdate::new(options.clone())),
        )
        .await?;
        Ok(acp::SetSessionConfigOptionResponse::new(options))
    }
}
fn unsupported_roots(
    directories: &[acp::AbsolutePath],
    servers: &[acp::McpServer],
) -> Result<(), Error> {
    if !directories.is_empty() || !servers.is_empty() {
        return Err("Additional directories and client MCP servers are unsupported".into());
    }
    Ok(())
}
async fn replay(
    client: &Client,
    peer: &Peer,
    id: &str,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    let opened = client
        .open_subscription(SubscriptionOpenInput {
            session_id: id.into(),
            transcript: TranscriptPolicy::Tail { max_bytes: 16_384 },
        })
        .await?;
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("ACP replay cancelled".into()),
        result = async {
        if opened.snapshot.root_turn.as_ref().is_some_and(|turn| {
            matches!(
                turn.state,
                TurnState::Admitted(_)
                    | TurnState::Created(_)
                    | TurnState::Running(_)
                    | TurnState::WaitingForUser(_)
            )
        }) {
            return Err("Host session started active work before replay".into());
        }
        let through = opened
            .transcript
            .as_ref()
            .ok_or("Host omitted transcript bootstrap")?
            .durable
            .through_sequence;
        let rows = history::read(client, &opened.subscription_id, through, None).await?;
        let mut projection = Projection::default();
        for row in rows {
            for update in projection.row(&row.value)? {
                peer.update(id, update).await?;
            }
        }
        Ok::<_, Error>(())
        } => result,
    };
    let closed = client.close_subscription(&opened.subscription_id).await;
    result?;
    closed?;
    Ok(())
}
