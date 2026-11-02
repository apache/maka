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

use super::diagnostics;
use maka_agent_ports::provider::Connection;
use maka_agent_ports::provider::Context;
use maka_agent_ports::provider::Identity;
use maka_config::oauth::ProviderCredential;
use maka_model::ModelError;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::Instrument;

struct RefreshProvider {
    identity: Identity,
    definition: Arc<maka_agent_ports::provider::Definition>,
}
impl RefreshProvider {
    fn identity(&self) -> &Identity {
        &self.identity
    }
    fn prepare_refresh(
        &self,
        connection: Connection,
        credential: maka_agent_facts::provider::Credential,
    ) -> Result<maka_agent_ports::provider::RefreshCall, maka_agent_ports::provider::Error> {
        self.definition.prepare_refresh(connection, credential)
    }
}

mod settlement;
use settlement::State;

/// A root owns refresh coordination. Callers own waiters, not spent grants.
pub struct Authority {
    entries: Mutex<HashMap<String, Arc<Generation>>>,
    workers: TaskTracker,
    shutdown: CancellationToken,
}

#[derive(Clone)]
pub struct Credential {
    generation: Arc<Generation>,
    snapshot: ProviderCredential,
}

struct Generation {
    provider: Identity,
    identity: String,
    state: Arc<AsyncMutex<State>>,
    flight: Arc<Mutex<Option<RefreshWaiter>>>,
    workers: TaskTracker,
    shutdown: CancellationToken,
    superseded: CancellationToken,
}

type RefreshWaiter = watch::Receiver<Option<Result<ProviderCredential, ModelError>>>;

impl Authority {
    pub fn new(workers: TaskTracker, shutdown: CancellationToken) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            workers,
            shutdown,
        }
    }

    /// No network I/O and no waiting for an in-flight refresh.
    pub fn bind(&self, snapshot: ProviderCredential) -> Result<Credential, ModelError> {
        let mut entries = self.entries.lock().unwrap();
        let id = &snapshot.target().connection_id;
        if let Some(existing) = entries.get(id) {
            if existing.identity == snapshot.basis().credential_id
                && existing.provider == snapshot.target().provider
            {
                match existing.state.try_lock() {
                    Err(_) => {
                        return Ok(Credential {
                            generation: existing.clone(),
                            snapshot,
                        });
                    }
                    Ok(state) if state.credential.basis() == snapshot.basis() => {
                        return Ok(Credential {
                            generation: existing.clone(),
                            snapshot,
                        });
                    }
                    Ok(state) if state.credential.basis().revision > snapshot.basis().revision => {
                        return Err(failure("Provider credential observation is outdated"));
                    }
                    Ok(_) => {}
                }
            }
            existing.superseded.cancel();
        }
        let generation = Arc::new(Generation {
            provider: snapshot.target().provider.clone(),
            identity: snapshot.basis().credential_id.clone(),
            state: Arc::new(AsyncMutex::new(State {
                credential: snapshot.clone(),
                outcome: settlement::Outcome::Ready,
            })),
            flight: Arc::new(Mutex::new(None)),
            workers: self.workers.clone(),
            shutdown: self.shutdown.clone(),
            superseded: CancellationToken::new(),
        });
        entries.insert(id.clone(), generation.clone());
        Ok(Credential {
            generation,
            snapshot,
        })
    }
}

impl Credential {
    /// Use the same durable refresh owner for compiled native provider policy.
    pub async fn resolve_native(
        &self,
        identity: Identity,
        definition: Arc<maka_agent_ports::provider::Definition>,
        context: Context,
    ) -> Result<ProviderCredential, ModelError> {
        self.resolve_provider(
            RefreshProvider {
                identity,
                definition,
            },
            context,
        )
        .await
    }

    async fn resolve_provider(
        &self,
        provider: RefreshProvider,
        context: Context,
    ) -> Result<ProviderCredential, ModelError> {
        if provider.identity() != &self.snapshot.target().provider {
            return Err(failure("Provider does not match credential recipient"));
        }
        let connection = Connection {
            id: self.snapshot.target().connection_id.clone(),
            revision: self.snapshot.target().revision,
            configuration: self.snapshot.target().configuration.clone(),
        };
        let resolved = self
            .generation
            .resolve(provider, connection, context)
            .await?;
        // Re-observe through this request's store-bound handle: metadata and
        // routing are per request, while only the login generation is shared.
        let current = self
            .snapshot
            .current_generation()
            .await
            .map_err(|error| {
                diagnostics::configuration(
                    "credential_generation_observation",
                    &error,
                    Some(&self.snapshot.target().connection_id),
                );
                failure(error)
            })?
            .ok_or_else(|| failure("Provider credential was superseded"))?;
        if current.basis() != resolved.basis()
            || current.credential() != resolved.credential()
            || current.basis().revision < self.snapshot.basis().revision
        {
            return Err(failure("Provider credential changed during resolution"));
        }
        Ok(current)
    }
}

impl Generation {
    async fn resolve(
        &self,
        provider: RefreshProvider,
        connection: Connection,
        mut context: Context,
    ) -> Result<ProviderCredential, ModelError> {
        if self.shutdown.is_cancelled() || self.superseded.is_cancelled() {
            return Err(ModelError::Cancelled);
        }
        let mut receiver = {
            let mut flight = self.flight.lock().unwrap();
            if let Some(receiver) = &*flight {
                receiver.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                *flight = Some(receiver.clone());
                let state = self.state.clone();
                let shutdown = self.shutdown.clone();
                let superseded = self.superseded.clone();
                let flight = self.flight.clone();
                // A cancelled request waiter cannot cancel an accepted exchange.
                context.cancellation = shutdown.child_token();
                let span = tracing::warn_span!("agent_credential_refresh", connection_id = %connection.id,
                    provider = %provider.identity().name);
                self.workers.spawn(
                    async move {
                        let mut state = state.lock().await;
                        let result = if superseded.is_cancelled() {
                            Err(failure("Provider credential was superseded"))
                        } else {
                            state
                                .resolve(provider, connection, context, &shutdown, &superseded)
                                .await
                        };
                        sender.send_replace(Some(result));
                        *flight.lock().unwrap() = None;
                    }
                    .instrument(span),
                );
                receiver
            }
        };
        let result = receiver
            .wait_for(Option::is_some)
            .await
            .map_err(|_| {
                if !self.shutdown.is_cancelled() && !self.superseded.is_cancelled() {
                    tracing::warn!(
                        stage = "credential_refresh_wait",
                        cause = "credential_owner_stopped",
                        "Model preparation failed"
                    );
                }
                failure("Credential owner stopped before settlement")
            })?
            .as_ref()
            .expect("settled result")
            .clone();
        if self.superseded.is_cancelled() {
            return Err(failure("Provider credential was superseded"));
        }
        result
    }
}

fn failure(message: impl ToString) -> ModelError {
    ModelError::Adapter(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{
        future::{BoxFuture, join_all},
        poll,
    };
    use maka_agent_facts::configuration::*;
    use maka_agent_facts::provider::Credential as Envelope;
    use maka_agent_ports::model::Connect;
    use maka_agent_ports::model::Credentials;
    use maka_agent_ports::model::Socket;
    use maka_agent_ports::model::Transport;
    use maka_agent_ports::provider::Descriptor;
    use maka_agent_ports::provider::Error;
    use maka_agent_ports::provider::Model;
    use maka_agent_ports::provider::Provider;
    use maka_agent_ports::provider::Resolve;
    use maka_agent_ports::provider::{Definition, Policy};
    use maka_capabilities::http;
    use maka_config::{
        ConfigurationStore,
        oauth::enrollment::{LoginCompletion, LoginPreparation},
    };
    use maka_event_log::root::{RootNamespaces, RootOwner};
    use serde_json::json;
    use tokio::sync::oneshot;

    struct RefreshProvider;
    impl Provider for RefreshProvider {
        fn resolve(&self, _: Resolve) -> BoxFuture<'_, Result<Model, Error>> {
            Box::pin(async { Err(Error::Unavailable) })
        }
        fn authorize(
            &self,
            _: Connection,
            _: Option<Envelope>,
            _: String,
        ) -> BoxFuture<'_, Result<Credentials, Error>> {
            Box::pin(async { Err(Error::Unavailable) })
        }
        fn refresh(
            &self,
            _: Connection,
            credential: Envelope,
            context: Context,
        ) -> BoxFuture<'_, Result<Envelope, Error>> {
            Box::pin(async move {
                if context.cancellation.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                // This fixture models a consumed refresh grant: once sent, the
                // Host-owned settlement survives waiter cancellation and drain.
                let grant_settlement = CancellationToken::new();
                let response = context
                    .transport
                    .request(
                        http::Request {
                            url: "https://provider.invalid/refresh".into(),
                            method: http::Method::Post,
                            headers: vec![],
                            body: credential.secret.into_bytes().into(),
                        },
                        grant_settlement,
                    )
                    .await
                    .map_err(|_| Error::OutcomeUnknown)?;
                let bytes = response.body.next().await.unwrap().unwrap();
                assert!(response.body.next().await.unwrap().is_none());
                response.body.close().await.unwrap();
                if response.head.status != 200 {
                    return Err(Error::Http(response.head.status));
                }
                Ok(serde_json::from_slice(&bytes).unwrap())
            })
        }
    }
    struct Body(Mutex<Option<Vec<u8>>>);
    impl http::Body for Body {
        fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
            Box::pin(async { Ok(self.0.lock().unwrap().take()) })
        }
        fn cancel(&self) {}
        fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
            Box::pin(async { Ok(()) })
        }
    }
    struct Exchange {
        request: oneshot::Sender<Vec<u8>>,
        reply: oneshot::Receiver<Envelope>,
    }
    struct Remote(Mutex<Option<Exchange>>, u16);
    impl Transport for Remote {
        fn identity(&self) -> u64 {
            self as *const Self as usize as u64
        }
        fn request(
            &self,
            request: http::Request,
            cancellation: tokio_util::sync::CancellationToken,
        ) -> BoxFuture<'_, Result<http::Response, maka_agent_ports::model::Error>> {
            Box::pin(async move {
                let exchange = self
                    .0
                    .lock()
                    .unwrap()
                    .take()
                    .expect("grant exchanged twice");
                let mut upload = request.body.into_stream();
                let mut body = Vec::new();
                while let Some(chunk) = futures_util::StreamExt::next(&mut upload).await {
                    body.extend_from_slice(&chunk.unwrap());
                }
                exchange.request.send(body).unwrap();
                let replacement = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(maka_agent_ports::model::Error::Cancelled),
                    replacement = exchange.reply => replacement.unwrap(),
                };
                Ok(http::Response {
                    head: http::Head {
                        status: self.1,
                        url: request.url,
                        headers: vec![],
                    },
                    body: Arc::new(Body(Mutex::new(Some(
                        serde_json::to_vec(&replacement).unwrap(),
                    )))),
                })
            })
        }
        fn connect(
            &self,
            _: Connect,
        ) -> BoxFuture<'_, Result<Arc<dyn Socket>, maka_agent_ports::model::Error>> {
            Box::pin(async { panic!("unexpected socket") })
        }
    }
    fn exchange() -> (
        Context,
        oneshot::Receiver<Vec<u8>>,
        oneshot::Sender<Envelope>,
    ) {
        exchange_with_status(200)
    }
    fn exchange_with_status(
        status: u16,
    ) -> (
        Context,
        oneshot::Receiver<Vec<u8>>,
        oneshot::Sender<Envelope>,
    ) {
        let (request, received) = oneshot::channel();
        let (reply, replacement) = oneshot::channel();
        (
            Context {
                transport: Arc::new(Remote(
                    Mutex::new(Some(Exchange {
                        request,
                        reply: replacement,
                    })),
                    status,
                )),
                cancellation: CancellationToken::new(),
                interaction: None,
            },
            received,
            reply,
        )
    }
    fn envelope(secret: &str, refresh_at: Option<u64>) -> Envelope {
        Envelope {
            secret: secret.into(),
            refresh_at,
        }
    }

    struct Fixture {
        temp: tempfile::TempDir,
        store: Arc<ConfigurationStore>,
        snapshot: ProviderCredential,
        identity: Identity,
        definition: Arc<Definition>,
    }
    impl Fixture {
        async fn resolve(
            &self,
            credential: &Credential,
            context: Context,
        ) -> Result<ProviderCredential, ModelError> {
            credential
                .resolve_native(self.identity.clone(), self.definition.clone(), context)
                .await
        }
        async fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = RootOwner::create(
                &temp.path().join("root"),
                &RootNamespaces {
                    ownership: temp.path().join("owners"),
                    control: temp.path().join("control"),
                },
            )
            .unwrap();
            let store = Arc::new(ConfigurationStore::for_root(Arc::new(root)).await.unwrap());
            let identity = Identity {
                package_id: "external.account".into(),
                entry_id: "entry".into(),
                scope: maka_plugin_core::scope::Scope::Profile,
                name: "account".into(),
            };
            let definition = Arc::new(Definition::new(
                Arc::new(
                    Policy::new(Descriptor {
                        label: "External account".into(),
                        custom_endpoint: false,
                        configuration_schema: json!({"type":"object"}),
                        configuration_defaults: json!({}),
                        authentication: vec![],
                        anonymous: false,
                        discovery: false,
                    })
                    .unwrap(),
                ),
                Arc::new(RefreshProvider),
            ));
            let LoginPreparation::Ready(login) = store.prepare_oauth_login(
                serde_json::from_value(json!({
                    "attemptId":"fixture-login",
                    "target":{"kind":"create","provider":identity,"configuration":{},"slug":"account","name":"Account"},
                    "expectedCredential":null,"authentication":{"method":"fixture","input":{}}
                })).unwrap()
            ).await.unwrap() else { panic!("fixture login") };
            assert!(login.claim().await.unwrap());
            assert!(matches!(
                login.complete(envelope("old", Some(0)), 1).await.unwrap(),
                LoginCompletion::Committed(_)
            ));
            let row = login.connection();
            let snapshot = store
                .provider_credential(ConnectionCredentialTarget {
                    connection_id: row.connection_id.clone(),
                    revision: row.revision,
                    slug: row.slug.clone(),
                    provider: row.provider.clone(),
                    configuration: row.configuration.clone(),
                })
                .await
                .unwrap()
                .unwrap();
            Self {
                temp,
                store,
                snapshot,
                identity,
                definition,
            }
        }
        async fn sql(&self) -> sqlx::SqliteConnection {
            use sqlx::Connection;
            sqlx::SqliteConnection::connect_with(
                &sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(self.temp.path().join("root/configuration-rust.sqlite")),
            )
            .await
            .unwrap()
        }
    }

    #[tokio::test]
    async fn refresh_is_single_flight_across_cancelled_waiters_and_retains_spent_grants_during_drain()
     {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            {
                let fixture = Fixture::new().await;
                let workers = TaskTracker::new();
                let stop = CancellationToken::new();
                let authority = Authority::new(workers.clone(), stop.clone());
                let binding = authority.bind(fixture.snapshot.clone()).unwrap();
                let (context, admitted, reply) = exchange();
                let mut abandoned = Box::pin(fixture.resolve(&binding, context.clone()));
                assert!(poll!(abandoned.as_mut()).is_pending());
                assert_eq!(admitted.await.unwrap(), b"old");
                let mut waiters = (0..16)
                    .map(|_| Box::pin(fixture.resolve(&binding, context.clone())))
                    .collect::<Vec<_>>();
                for waiter in &mut waiters {
                    assert!(poll!(waiter.as_mut()).is_pending());
                }
                drop(abandoned);
                context.cancellation.cancel();
                assert!(reply.send(envelope("next", Some(0))).is_ok());
                for result in join_all(waiters).await {
                    assert_eq!(result.unwrap().credential().secret, "next");
                }
                let current = fixture
                    .snapshot
                    .current_generation()
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    current.basis().revision,
                    fixture.snapshot.basis().revision + 1
                );
                assert!(authority.bind(fixture.snapshot.clone()).is_err());
                let next = authority.bind(current).unwrap();
                let (context, admitted, reply) = exchange();
                let mut resolving = Box::pin(fixture.resolve(&next, context));
                assert!(poll!(resolving.as_mut()).is_pending());
                assert_eq!(
                    admitted.await.unwrap(),
                    b"next",
                    "new request supplies its own transport"
                );
                stop.cancel();
                assert!(reply.send(envelope("final", None)).is_ok());
                assert_eq!(resolving.await.unwrap().credential().secret, "final");
                workers.close();
                workers.wait().await;
                let current = fixture
                    .snapshot
                    .current_generation()
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    current.basis().revision,
                    fixture.snapshot.basis().revision + 2
                );
                assert!(current.credential() == &envelope("final", None));
                fixture.store.shutdown().await.unwrap();
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn refresh_http_failure_logs_original_safe_cause_once_without_reusing_claim() {
        const SECRET: &str = "SECRET_REFRESH_ERROR_BODY_MUST_NOT_BE_LOGGED";
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let capture = tempfile::NamedTempFile::new().unwrap();
            let subscriber = tracing_subscriber::fmt()
                .with_ansi(false)
                .without_time()
                .with_writer(capture.reopen().unwrap())
                .finish();
            let _subscriber = tracing::subscriber::set_default(subscriber);
            let fixture = Fixture::new().await;
            let workers = TaskTracker::new();
            let authority = Authority::new(workers.clone(), CancellationToken::new());
            let binding = authority.bind(fixture.snapshot.clone()).unwrap();
            let (context, admitted, reply) = exchange_with_status(403);
            let mut resolving = Box::pin(fixture.resolve(&binding, context.clone()));
            assert!(poll!(resolving.as_mut()).is_pending());
            assert_eq!(admitted.await.unwrap(), b"old");
            assert!(reply.send(envelope(SECRET, None)).is_ok());
            let first = resolving.await.err().unwrap();
            let replay = fixture.resolve(&binding, context).await.err().unwrap();
            let current = fixture.snapshot.current_generation().await.unwrap().unwrap();
            let claimed_again = fixture.snapshot.claim_refresh().await.unwrap();
            workers.close();
            workers.wait().await;
            fixture.store.shutdown().await.unwrap();
            let log = std::fs::read_to_string(capture.path()).unwrap();

            for error in [first, replay] {
                assert!(matches!(error, ModelError::Adapter(message) if message == "provider HTTP request failed with status 403"));
            }
            assert_eq!(current.basis(), fixture.snapshot.basis());
            assert!(current.credential() == fixture.snapshot.credential());
            assert!(!claimed_again, "the failed exchange's original claim must remain spent");
            let originals = log.lines().filter(|line| line.contains("credential_refresh_exchange")).collect::<Vec<_>>();
            assert_eq!(originals.len(), 1, "exactly one original typed failure must survive Adapter conversion: {log}");
            let original = originals[0];
            assert!(original.contains("WARN"), "{original}");
            assert!(original.contains("cause=\"provider_http\""), "{original}");
            assert!(original.contains("status=403"), "{original}");
            assert!(original.contains(&fixture.snapshot.target().connection_id), "{original}");
            assert!(!log.contains(SECRET));
            assert!(!log.contains("provider.invalid"));
        }).await.unwrap();
    }

    #[tokio::test]
    async fn failed_and_unknown_sql_commits_retry_only_the_retained_envelope_and_logout_revokes_it()
    {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            for unknown in [false, true] {
                let capture = tempfile::NamedTempFile::new().unwrap();
                let subscriber = tracing_subscriber::fmt()
                    .with_ansi(false)
                    .without_time()
                    .with_writer(capture.reopen().unwrap())
                    .finish();
                let _subscriber = tracing::subscriber::set_default(subscriber);
                let fixture = Fixture::new().await;
                let mut sql = fixture.sql().await;
                if unknown {
                    sqlx::query("CREATE TABLE deferred_failure (parent INTEGER REFERENCES credential_vault(singleton) DEFERRABLE INITIALLY DEFERRED)")
                        .execute(&mut sql).await.unwrap();
                    sqlx::query("CREATE TRIGGER fail_rotation AFTER UPDATE ON credential_vault BEGIN INSERT INTO deferred_failure VALUES(2); END")
                        .execute(&mut sql).await.unwrap();
                } else {
                    sqlx::query("CREATE TRIGGER fail_rotation BEFORE UPDATE ON credential_vault BEGIN SELECT RAISE(ABORT, 'injected rotation failure'); END")
                        .execute(&mut sql).await.unwrap();
                }
                let workers = TaskTracker::new();
                let authority = Authority::new(workers.clone(), CancellationToken::new());
                let binding = authority.bind(fixture.snapshot.clone()).unwrap();
                let (context, admitted, reply) = exchange();
                let mut resolving = Box::pin(fixture.resolve(&binding, context.clone()));
                assert!(poll!(resolving.as_mut()).is_pending());
                assert_eq!(admitted.await.unwrap(), b"old");
                assert!(reply.send(envelope("rotated", None)).is_ok());
                assert!(resolving.await.is_err());
                assert_eq!(fixture.snapshot.current_generation().await.unwrap().unwrap().basis(), fixture.snapshot.basis());
                sqlx::query("DROP TRIGGER fail_rotation").execute(&mut sql).await.unwrap();
                let current = fixture.resolve(&binding, context.clone()).await.unwrap();
                assert!(current.credential() == &envelope("rotated", None));
                fixture.store.delete_credential(DeleteCredentialInput { expected_connection: Some(current.target().clone()), expected: current.basis().clone() }).await.unwrap();
                assert!(fixture.resolve(&binding, context).await.is_err());
                assert!(fixture.snapshot.current_generation().await.unwrap().is_none());
                workers.close();
                workers.wait().await;
                use sqlx::Connection;
                sql.close().await.unwrap();
                fixture.store.shutdown().await.unwrap();
                let log = std::fs::read_to_string(capture.path()).unwrap();
                let failures = log.lines().filter(|line| line.contains("credential_refresh_commit")).collect::<Vec<_>>();
                assert_eq!(failures.len(), 1, "original SQL failure must survive Adapter conversion: {log}");
                let cause = if unknown { "cause=\"config_commit_unknown\"" } else { "cause=\"config_sqlx\"" };
                assert!(failures[0].contains(cause), "{log}");
                assert!(failures[0].contains(&fixture.snapshot.target().connection_id), "{log}");
                assert!(!log.contains("injected rotation failure"));
                assert!(!log.contains("rotated"));
            }
        }).await.unwrap();
    }
}
