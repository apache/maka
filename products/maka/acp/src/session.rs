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
use crate::client::Client;
use crate::{Error, configuration, history, projection::Projection, transport::Peer};
use agent_client_protocol::schema::v2 as acp;
use maka_agent_api::contract::{Created, Observation};
use maka_capabilities::call::Attachments;
use serde_json::json;
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
    pub preferences: AsyncMutex<configuration::Preferences>,
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
            preferences: AsyncMutex::default(),
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
    pub async fn create(
        &self,
        client: &Client,
        peer: &Peer,
        request: acp::NewSessionRequest,
    ) -> Result<acp::NewSessionResponse, Error> {
        unsupported_roots(&request.additional_directories, &request.mcp_servers)?;
        let cwd = list::directory(request.cwd.as_ref())?;
        let _creation = self.creation.lock().await;
        if peer.stop.is_cancelled() {
            return Err("ACP transport closed".into());
        }
        let selection = list::select(client, &cwd).await?;
        let Created::Created { session } = client.mutate("agent", "create", json!({"title":"New session","labels":[],"workspace":{"kind":"directory","selection":selection}}), Attachments::new()).await? else {
            return Err("Host rejected session creation".into());
        };
        let id = session.id.clone();
        let options =
            configuration::options(client, &session, &configuration::Preferences::default())
                .await?;
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
        let cwd = list::directory(request.cwd.as_ref())?;
        let _creation = self.creation.lock().await;
        let id = request.session_id.to_string();
        let existing = self.sessions.lock().unwrap().get(&id).cloned();
        let local = existing.unwrap_or_else(|| Session::new(id.clone()));
        let active = local.enter(&peer.stop)?;
        let observation: Observation = client
            .query("agent", "observe", json!({"sessionId":id}))
            .await?;
        let session = observation.session;
        list::ensure_idle(&session)?;
        if list::directory(Path::new(&session.workspace.path))? != cwd {
            return Err("Resume cwd differs from Host session workspace".into());
        }
        let options =
            configuration::options(client, &session, &local.preferences.lock().await.clone())
                .await?;
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
        let observation: Observation = client
            .query("agent", "observe", json!({"sessionId":local.id}))
            .await?;
        list::ensure_idle(&observation.session)?;
        let mut preferences = local.preferences.lock().await;
        let options =
            configuration::set(client, &observation.session, &mut preferences, request).await?;
        drop(preferences);
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
    let observation: Observation = client
        .query("agent", "observe", json!({"sessionId":id}))
        .await?;
    list::ensure_idle(&observation.session)?;
    let chunks = history::read(client, id, Some(observation.through), None).await?;
    let mut projection = Projection::default();
    for chunk in chunks {
        if cancel.is_cancelled() {
            return Err("ACP replay cancelled".into());
        }
        for update in projection.chunk(&chunk)? {
            peer.update(id, update).await?;
        }
    }
    Ok(())
}
