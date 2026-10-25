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

//! Durable UI requests. The foreground owns deployment edits and their receipts.
pub mod contract;
use contract::*;
use futures_util::future::BoxFuture;
use maka_capabilities::{
    call::Scope,
    storage::{Data, Mutation, Namespace},
};
use maka_event_log::RootStore;
use maka_host_runtime::application::{
    Context, Handler, NativeActivation, NativeContext, NativeOwner, NativeRegistry,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::{Mutex, Notify};

#[derive(Clone)]
struct Requests {
    store: Arc<RootStore>,
    prefix: String,
    writes: Arc<Mutex<()>>,
    changed: Arc<Notify>,
}
#[derive(Serialize, Deserialize)]
struct Record {
    session: String,
    request: Request,
    state: State,
}
fn namespace() -> Namespace {
    Namespace::new(IMPLEMENTATION, maka_plugin_core::scope::Scope::Profile).unwrap()
}
fn encode<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}
pub fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    registry.insert(
        IMPLEMENTATION.into(),
        Arc::new(|context, _| Box::pin(activate(context))),
    )
}
async fn activate(context: NativeContext) -> NativeActivation {
    let Some(persistence) = context.persistence() else {
        return NativeActivation {
            exports: Err("UI authoring requires persistence".into()),
            owner: Arc::new(()),
        };
    };
    let owner = Arc::new(Requests {
        store: persistence.store().clone(),
        prefix: maka_host_runtime::storage::instance_prefix(
            &persistence.source().state_domain,
            persistence.source().deployment,
            context.activation().instance(),
        ),
        writes: Arc::new(Mutex::new(())),
        changed: Arc::new(Notify::new()),
    });
    NativeActivation {
        exports: Ok(BTreeMap::from([(
            EXPORT.into(),
            maka_plugin_core::runtime::Published {
                contract: contract(),
                value: owner.clone() as Arc<dyn Handler>,
            },
        )])),
        owner,
    }
}
impl Requests {
    fn key(&self, id: &str) -> Result<String, String> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid UI request identity".into());
        }
        Ok(format!("{}request/{id}", self.prefix))
    }
    async fn record(&self, id: &str) -> Result<(u64, Record), String> {
        let record = self
            .store
            .plugin_data(&namespace(), &self.key(id)?)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("UI request unavailable")?;
        let value = record
            .data
            .value()
            .cloned()
            .ok_or("UI request unavailable")?;
        Ok((record.revision, decode(value)?))
    }
    async fn queue(&self) -> Result<(Option<u64>, Vec<String>), String> {
        let record = self
            .store
            .plugin_data(&namespace(), &format!("{}queue", self.prefix))
            .await
            .map_err(|e| e.to_string())?;
        match record {
            Some(record) => Ok((
                Some(record.revision),
                decode(record.data.value().cloned().ok_or("invalid UI queue")?)?,
            )),
            None => Ok((None, vec![])),
        }
    }
    async fn write(&self, changes: Vec<Mutation>) -> Result<(), String> {
        self.store
            .plugin_data_batch(&namespace(), changes)
            .await
            .map_err(|e| e.to_string())?;
        self.changed.notify_waiters();
        Ok(())
    }
    async fn submit(&self, session: String, id: String, command: Command) -> Result<Value, String> {
        let _write = self.writes.lock().await;
        if self
            .store
            .plugin_data(&namespace(), &self.key(&id)?)
            .await
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return encode(RequestId { id });
        }
        let (revision, mut queue) = self.queue().await?;
        if queue.len() >= 16 {
            return Err("UI request queue is full; wait for the foreground".into());
        }
        queue.push(id.clone());
        let record = Record {
            session,
            request: Request {
                id: id.clone(),
                command,
            },
            state: State::Queued,
        };
        self.write(vec![
            Mutation {
                key: self.key(&id)?,
                expected_revision: None,
                data: Data::Present(encode(record)?),
            },
            Mutation {
                key: format!("{}queue", self.prefix),
                expected_revision: revision,
                data: Data::Present(encode(queue)?),
            },
        ])
        .await?;
        encode(RequestId { id })
    }
    async fn claim(&self) -> Result<Value, String> {
        let _write = self.writes.lock().await;
        let (revision, mut queue) = self.queue().await?;
        if queue.is_empty() {
            return encode(Claim { request: None });
        }
        let id = queue.remove(0);
        let (record_revision, mut record) = self.record(&id).await?;
        if !matches!(record.state, State::Queued) {
            return Err("UI queue contains an already claimed request".into());
        }
        record.state = State::Claimed;
        let request = record.request.clone();
        self.write(vec![
            Mutation {
                key: self.key(&id)?,
                expected_revision: Some(record_revision),
                data: Data::Present(encode(record)?),
            },
            Mutation {
                key: format!("{}queue", self.prefix),
                expected_revision: revision,
                data: Data::Present(encode(queue)?),
            },
        ])
        .await?;
        encode(Claim {
            request: Some(request),
        })
    }
    async fn complete(&self, input: Completion) -> Result<Value, String> {
        let _write = self.writes.lock().await;
        let (revision, mut record) = self.record(&input.id).await?;
        match &record.state {
            State::Queued => return Err("UI request has not been claimed".into()),
            State::Completed { outcome } => return encode(outcome == &input.outcome),
            State::Claimed => {}
        }
        record.state = State::Completed {
            outcome: input.outcome,
        };
        self.write(vec![Mutation {
            key: self.key(&input.id)?,
            expected_revision: Some(revision),
            data: Data::Present(encode(record)?),
        }])
        .await?;
        encode(true)
    }
    async fn result(&self, session: Option<&str>, id: &str) -> Result<State, String> {
        let (_, record) = self.record(id).await?;
        if session != Some(record.session.as_str()) {
            return Err("UI request belongs to another Session".into());
        }
        Ok(record.state)
    }
    async fn wait_result(
        &self,
        scope: &Scope,
        session: Option<&str>,
        id: &str,
    ) -> Result<Value, String> {
        let deadline = tokio::time::sleep(std::time::Duration::from_secs(5));
        tokio::pin!(deadline);
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let state = self.result(session, id).await?;
            if matches!(state, State::Completed { .. }) {
                return encode(state);
            }
            tokio::select! {
                _=changed=>{},
                _=&mut deadline=>return encode(self.result(session,id).await?),
                _=scope.cancellation.cancelled()=>return Err("UI result observation cancelled".into()),
            }
        }
    }
    // SQL custody outlives a dropped observer. Its original call retains the ticket.
    async fn run(
        self,
        scope: Scope,
        method: String,
        input: Value,
        id: Option<String>,
        session: Option<String>,
    ) -> Result<Value, String> {
        let mut ticket = scope.resources.reserve().map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            ticket.start();
            let result = async {
                if scope.cancellation.is_cancelled() {
                    return Err("UI authoring call cancelled".into());
                }
                match method.as_str() {
                    "submit" => {
                        self.submit(
                            session.ok_or("UI requests require an Agent invocation")?,
                            id.ok_or("UI request requires a mutation")?,
                            decode(input)?,
                        )
                        .await
                    }
                    "claim" => {
                        decode::<Empty>(input)?;
                        self.claim().await
                    }
                    "complete" => self.complete(decode(input)?).await,
                    "result" => {
                        let request: RequestId = decode(input)?;
                        self.wait_result(&scope, session.as_deref(), &request.id)
                            .await
                    }
                    _ => Err("UI authoring method unavailable".into()),
                }
            }
            .await;
            ticket.complete(Ok(()));
            result
        })
        .await
        .map_err(|_| "UI authoring work did not settle".to_owned())?
    }
}
impl Handler for Requests {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let own = self.clone();
        Box::pin(async move {
            if method == "watch" {
                decode::<Empty>(input)?;
                let mut last = None;
                loop {
                    let changed = own.changed.notified();
                    tokio::pin!(changed);
                    changed.as_mut().enable();
                    let (revision, queue) = own.queue().await?;
                    if last != Some(revision) {
                        context.emit(json!({"pending":queue.len()})).await?;
                        last = Some(revision)
                    }
                    tokio::select! { _=changed=>{},_=context.scope().cancellation.cancelled()=>return Ok(Value::Null) }
                }
            }
            let id = context.operation().map(|operation| {
                hex::encode(Sha256::digest(serde_json::to_vec(operation).unwrap()))
            });
            let session = context
                .scope()
                .identity
                .agent()
                .map(|invocation| invocation.session_id.clone());
            own.run(context.scope().clone(), method, input, id, session)
                .await
        })
    }
}
impl NativeOwner for Requests {
    fn execution_basis(&self) -> Option<Value> {
        let root = self.store.owned_root().ok()?;
        let namespace = namespace();
        serde_json::to_value((
            root.root_id(),
            namespace.package(),
            namespace.scope(),
            &self.prefix,
        ))
        .ok()
    }
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_event_log::root::{RootNamespaces, RootOwner};
    fn requests(store: Arc<RootStore>) -> Requests {
        Requests {
            store,
            prefix: "ui-test/".into(),
            writes: Arc::new(Mutex::new(())),
            changed: Arc::new(Notify::new()),
        }
    }
    #[tokio::test]
    async fn claimed_requests_survive_reactivation_without_replay_and_keep_session_authority() {
        let dir = tempfile::tempdir().unwrap();
        let owner = Arc::new(
            RootOwner::create(
                &dir.path().join("root"),
                &RootNamespaces {
                    ownership: dir.path().join("owners"),
                    control: dir.path().join("control"),
                },
            )
            .unwrap(),
        );
        let store = Arc::new(RootStore::open(owner).await.unwrap());
        let first = requests(store.clone());
        let basis = first.execution_basis().unwrap();
        let mut other = requests(store.clone());
        other.prefix = "other/".into();
        assert_ne!(other.execution_basis().unwrap(), basis);
        let id = "a".repeat(64);
        let command: Command =
            serde_json::from_value(json!({"method":"instances","input":{"kind":"start"}})).unwrap();
        first
            .submit("session-a".into(), id.clone(), command.clone())
            .await
            .unwrap();
        first
            .submit("session-a".into(), id.clone(), command)
            .await
            .unwrap();
        assert_eq!(first.queue().await.unwrap().1.len(), 1);
        assert!(
            first
                .complete(Completion {
                    id: id.clone(),
                    outcome: json!({})
                })
                .await
                .is_err()
        );
        assert!(first.result(Some("session-b"), &id).await.is_err());
        let (one, two) = tokio::join!(first.claim(), first.claim());
        let claims = [one.unwrap(), two.unwrap()];
        assert_eq!(claims.iter().filter(|v| !v["request"].is_null()).count(), 1);
        drop(first);
        let resumed = requests(store);
        assert_eq!(resumed.execution_basis().unwrap(), basis);
        assert!(resumed.claim().await.unwrap()["request"].is_null());
        assert!(matches!(
            resumed.result(Some("session-a"), &id).await.unwrap(),
            State::Claimed
        ));
        let original = json!({"status":"operation","reply":{"receipt":{"kind":"unknown"}}});
        assert_eq!(
            resumed
                .complete(Completion {
                    id: id.clone(),
                    outcome: original.clone()
                })
                .await
                .unwrap(),
            true
        );
        assert_eq!(
            resumed
                .complete(Completion {
                    id: id.clone(),
                    outcome: original.clone()
                })
                .await
                .unwrap(),
            true
        );
        assert_eq!(
            resumed
                .complete(Completion {
                    id: id.clone(),
                    outcome: json!({"status":"succeeded"})
                })
                .await
                .unwrap(),
            false
        );
        match resumed.result(Some("session-a"), &id).await.unwrap() {
            State::Completed { outcome } => assert_eq!(outcome, original),
            _ => panic!("original outcome was lost"),
        }
    }
}
