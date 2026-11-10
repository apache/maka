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

pub(super) struct Client {
    generation: ClientGeneration,
    state: State,
}
enum State {
    Opening,
    Ready(Arc<Servers>),
    Closing(Option<Arc<Servers>>),
}
pub(super) fn current(
    snapshots: &Snapshots,
    session: &str,
    base: Arc<Catalog>,
) -> Result<Arc<Catalog>, String> {
    let Some(client) = snapshots.clients.get(session) else {
        return Ok(base);
    };
    match &client.state {
        State::Ready(servers) => compose(base, client.generation, servers),
        State::Closing(_) | State::Opening => Ok(base),
    }
}
fn compose(
    base: Arc<Catalog>,
    generation: ClientGeneration,
    servers: &Servers,
) -> Result<Arc<Catalog>, String> {
    let revision = maka_agent_facts::artifact::content_digest(
        &serde_json::to_vec(&(&generation, &base.revision)).expect("MCP lease identity"),
    );
    let mut catalog = Catalog::with_layer(
        base,
        revision,
        &servers.names.keys().cloned().collect(),
        servers.live_bindings.clone(),
        None,
    )?;
    Arc::get_mut(&mut catalog)
        .expect("new client composition is uniquely owned")
        .client_mcp = Some(generation);
    Ok(catalog)
}
impl Projects {
    pub fn begin_client(&self, session: &str, generation: ClientGeneration) -> Result<(), String> {
        if let Some(error) = self
            .cleanup_failures
            .lock()
            .expect("MCP cleanup state")
            .first()
        {
            return Err(error.message().to_owned());
        }
        let mut snapshots = self.snapshots.write().expect("MCP snapshots");
        if snapshots.clients.contains_key(session) {
            return Err("agent_session_mcp_already_attached".into());
        }
        snapshots.clients.insert(
            session.into(),
            Client {
                generation,
                state: State::Opening,
            },
        );
        Ok(())
    }
    pub fn publish_client(
        &self,
        session: &str,
        generation: ClientGeneration,
        servers: Arc<Servers>,
    ) -> Result<(), String> {
        self.base
            .tools
            .clone()
            .with_additional(servers.registrations.clone())
            .map_err(|_| "agent_mcp_catalog_invalid")?;
        let mut snapshots = self.snapshots.write().expect("MCP snapshots");
        let client = snapshots
            .clients
            .get_mut(session)
            .filter(|client| {
                client.generation == generation && matches!(client.state, State::Opening)
            })
            .ok_or("agent_session_mcp_changed")?;
        client.state = State::Ready(servers);
        Ok(())
    }
    pub fn with_client(&self, session: &str, base: Arc<Catalog>) -> Result<Arc<Catalog>, String> {
        let (generation, servers) = {
            let snapshots = self.snapshots.read().expect("MCP snapshots");
            let Some(client) = snapshots.clients.get(session) else {
                return Ok(base);
            };
            let State::Ready(servers) = &client.state else {
                return Err("agent_session_mcp_unavailable".into());
            };
            (client.generation, servers.clone())
        };
        let revision = maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&(&generation, &base.revision)).expect("MCP lease identity"),
        );
        if let Ok(catalog) = self.catalog(Some(&revision)) {
            return Ok(catalog);
        }
        let catalog = compose(base, generation, &servers)?;
        let scope = format!("client:{session}");
        let mut snapshots = self.snapshots.write().expect("MCP snapshots");
        if !snapshots.clients.get(session).is_some_and(|client| {
            client.generation == generation && matches!(client.state, State::Ready(_))
        }) {
            return Err("agent_session_mcp_changed".into());
        }
        let snapshot = snapshots
            .revisions
            .entry(revision.clone())
            .or_insert_with(|| {
                Arc::new(Snapshot {
                    scope: scope.clone(),
                    acquired: AtomicU64::new(0),
                    catalog,
                    servers: None,
                    overrides: BTreeSet::new(),
                })
            })
            .clone();
        snapshots.current.insert(scope, revision);
        Ok(snapshot.catalog.clone())
    }
    pub fn withdraw_client(&self, session: &str, generation: ClientGeneration) {
        let mut snapshots = self.snapshots.write().expect("MCP snapshots");
        if let Some(client) = snapshots
            .clients
            .get_mut(session)
            .filter(|client| client.generation == generation)
        {
            let previous = std::mem::replace(&mut client.state, State::Closing(None));
            let servers = match previous {
                State::Ready(servers) => Some(servers),
                State::Closing(servers) => servers,
                State::Opening => None,
            };
            client.state = State::Closing(servers);
            let scope = format!("client:{session}");
            snapshots.current.remove(&scope);
        }
    }
    pub fn remove_client(&self, session: &str, generation: ClientGeneration) {
        let mut snapshots = self.snapshots.write().expect("MCP snapshots");
        if snapshots
            .clients
            .get(session)
            .is_some_and(|client| client.generation == generation)
        {
            snapshots.clients.remove(session);
            let scope = format!("client:{session}");
            snapshots.revisions.retain(|_, snapshot| {
                snapshot.scope != scope || Arc::strong_count(&snapshot.catalog) > 1
            });
        }
    }
    pub(super) async fn close_clients(&self) -> Result<(), String> {
        let servers: Vec<_> = self
            .snapshots
            .read()
            .expect("MCP snapshots")
            .clients
            .values()
            .filter_map(|client| match &client.state {
                State::Ready(servers) | State::Closing(Some(servers)) => Some(servers.clone()),
                _ => None,
            })
            .collect();
        let mut failure = None;
        for server in servers {
            if let Err(error) = server.close().await {
                failure.get_or_insert(error.message.clone());
                self.retain_transport_cleanup(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub fn has_client(&self, session: &str, generation: ClientGeneration) -> bool {
        self.snapshots
            .read()
            .expect("MCP snapshots")
            .clients
            .get(session)
            .is_some_and(|client| client.generation == generation)
    }
    pub fn has_any_client(&self, session: &str) -> bool {
        self.snapshots
            .read()
            .expect("MCP snapshots")
            .clients
            .contains_key(session)
    }
    pub fn client_cleanup_failed(&self, error: String) {
        self.cleanup_failures
            .lock()
            .expect("MCP cleanup state")
            .push(CleanupFailure::Work(error));
    }
}
