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
use futures_util::future::BoxFuture;
use maka_client_capability::{Registration, broker::ServiceCall};
use maka_config::oauth::enrollment::{LoginCompletion, PreparedLogin};
use maka_plugins::provider::{
    AuthenticationCall, Binding, Connection, Context, Discovery, Error,
    authentication::{Credential, Interaction},
};
use serde_json::json;
use std::{sync::atomic::Ordering, time::Duration};

pub(super) async fn run(
    host: &Host,
    attempt: &Attempt,
    mut ticket: PreparedLogin,
    call: AuthenticationCall,
    discovery: Option<(Binding, Context)>,
) -> Phase {
    let exchange = call.run();
    tokio::pin!(exchange);
    let result = tokio::select! {
        result = &mut exchange => result,
        _ = tokio::time::sleep(Duration::from_secs(15 * 60)) => {
            attempt.cancellation.cancel();
            tokio::time::timeout(Duration::from_secs(35), exchange).await
                .unwrap_or(Err(Error::OutcomeUnknown))
        }
    };
    if let (Ok(credential), Some((provider, context))) = (&result, discovery) {
        tokio::select! {
            biased;
            _ = attempt.cancellation.cancelled() => {}
            _ = host.draining.cancelled() => {}
            _ = discover(&mut ticket, credential, provider, context) => {}
        }
    }
    settle(host, attempt, ticket, result).await
}

async fn discover(
    ticket: &mut PreparedLogin,
    credential: &Credential,
    provider: Binding,
    mut context: Context,
) {
    context.cancellation = context.cancellation.child_token();
    let _cancel = context.cancellation.clone().drop_guard();
    let row = ticket.connection();
    let request = Discovery {
        connection: Connection {
            id: row.connection_id.clone(),
            revision: row.revision,
            configuration: row.configuration.clone(),
        },
        credential: Some(credential.clone()),
        request_headers: Default::default(),
    };
    // Optional enrichment never discards a grant that already succeeded.
    let Ok(Ok(models)) =
        tokio::time::timeout(Duration::from_secs(15), provider.discover(request, context)).await
    else {
        return;
    };
    if let Ok(now) = super::super::configuration::now() {
        let _ = ticket.discovered_models(models, now);
    }
}

async fn settle(
    host: &Host,
    attempt: &Attempt,
    ticket: PreparedLogin,
    result: Result<Credential, Error>,
) -> Phase {
    let credential = match result {
        Ok(credential) => credential,
        Err(error) => {
            let phase = if matches!(error, Error::Cancelled) {
                Phase::Cancelled
            } else {
                Phase::Failed {
                    failure: provider_failure(error),
                }
            };
            if phase
                == (Phase::Failed {
                    failure: Failure::OutcomeUnknown,
                })
            {
                return phase;
            }
            return ticket.finish_failure(phase).await.unwrap_or(Phase::Failed {
                failure: Failure::PersistenceFailed,
            });
        }
    };
    // Successful grant receipt wins cancellation. Retry only persistence, with
    // the same immutable ticket and replacement, never the remote exchange.
    *attempt.phase.lock().unwrap_or_else(|e| e.into_inner()) = Phase::Committing;
    let Ok(now) = super::super::configuration::now() else {
        return Phase::Failed {
            failure: Failure::PersistenceFailed,
        };
    };
    let mut backoff = Duration::from_millis(100);
    loop {
        let result = {
            let _admission = host.executions.lock_admission().await;
            ticket.complete(credential.clone(), now).await
        };
        match result {
            Ok(LoginCompletion::Committed(_)) => {
                let revision = host.change_revision.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = host
                    .changes
                    .send(json!({"kind":"configuration.changed","revision":revision}));
                return Phase::Authenticated;
            }
            Ok(LoginCompletion::ConnectionChanged) => {
                return Phase::Failed {
                    failure: Failure::ConnectionChanged,
                };
            }
            Ok(LoginCompletion::CredentialChanged) => {
                return Phase::Failed {
                    failure: Failure::CredentialChanged,
                };
            }
            Ok(LoginCompletion::AttemptConflict) => {
                return Phase::Failed {
                    failure: Failure::CredentialChanged,
                };
            }
            Ok(LoginCompletion::SlugTaken) => {
                return Phase::Failed {
                    failure: Failure::SlugTaken,
                };
            }
            Err(_) => {
                // Keep the only replacement in this existing root-owned worker.
                // UI cancellation cannot discard it; root shutdown remains bounded.
                tokio::select! {
                    _ = host.draining.cancelled() => {
                        return Phase::Failed { failure: Failure::OutcomeUnknown };
                    }
                    _ = tokio::time::sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

pub(super) fn interaction(
    host: Arc<Host>,
    attempt: Arc<Attempt>,
    registration: Arc<Registration>,
) -> Arc<dyn Interaction> {
    Arc::new(Presentation {
        host,
        attempt,
        registration,
    })
}

struct Presentation {
    host: Arc<Host>,
    attempt: Arc<Attempt>,
    registration: Arc<Registration>,
}

impl Interaction for Presentation {
    fn open_external(
        &self,
        url: String,
        user_code: Option<String>,
    ) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            if self.attempt.cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let mut input = json!({"url":url});
            if let Some(user_code) = user_code {
                input["stateHint"] = json!(user_code);
            }
            oauth::decode_presentation("open_external", &input)
                .map_err(|_| Error::Invalid("invalid login presentation".into()))?;
            let call = self
                .host
                .capabilities
                .broker
                .prepare_service(
                    self.registration.clone(),
                    ServiceCall {
                        service_id: oauth::PRESENTATION_SERVICE_ID.into(),
                        version: oauth::PRESENTATION_SERVICE_VERSION.into(),
                        method: "open_external".into(),
                        input: input.as_object().expect("presentation object").clone(),
                    },
                    Duration::from_secs(150),
                    self.attempt.cancellation.clone(),
                )
                .map_err(|_| Error::Unavailable)?;
            let result = call
                .accepted()
                .await
                .map_err(|_| Error::Unavailable)?
                .admit()
                .await
                .map_err(|_| Error::Unavailable)?;
            if !result.content.is_empty() {
                return Err(Error::Invalid("invalid presentation response".into()));
            }
            oauth::decode_presentation_result(
                "open_external",
                result
                    .structured_content
                    .as_ref()
                    .ok_or(Error::Unavailable)?,
            )
            .map_err(|_| Error::Invalid("invalid presentation response".into()))?;
            if self.attempt.cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            *self.attempt.phase.lock().unwrap_or_else(|e| e.into_inner()) = Phase::Exchanging;
            Ok(())
        })
    }
}

fn provider_failure(error: Error) -> Failure {
    match error {
        Error::AuthenticationRequired | Error::Rejected(_) => Failure::ProviderRejected,
        Error::Unavailable
        | Error::OutcomeUnknown
        | Error::Invalid(_)
        | Error::Transport(_)
        | Error::Http(_) => Failure::OutcomeUnknown,
        Error::Cancelled => Failure::AuthorizationFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_config::oauth::enrollment::LoginPreparation;
    use maka_event_log::root::{RootNamespaces, RootOwner};
    use maka_runtime::{
        provider::{AuthenticationInput, Identity},
        scope::Scope,
    };

    #[tokio::test]
    async fn cancel_racing_admission_never_publishes_terminal_before_spent_grant_commit() {
        let temp = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: temp.path().join("owners"),
            control: temp.path().join("control"),
        };
        let host = Host::open(RootOwner::create(&temp.path().join("root"), &namespaces).unwrap())
            .await
            .unwrap();
        let input = LoginStart {
            attempt_id: "cancel-race".into(),
            target: oauth::Target::Create {
                provider: Identity {
                    package_id: "example.account".into(),
                    entry_id: "example.account".into(),
                    scope: Scope::Profile,
                    name: "model".into(),
                },
                configuration: json!({}),
                slug: "example".into(),
                name: "Example".into(),
            },
            authentication: AuthenticationInput {
                method: "login".into(),
                input: json!({}),
            },
        };
        let LoginPreparation::Ready(ticket) = host
            .configuration
            .prepare_oauth_login(input.clone())
            .await
            .unwrap()
        else {
            panic!("expected unpublished ticket");
        };
        let attempt = Attempt {
            input,
            connection: ticket.identity().clone(),
            phase: Mutex::new(Phase::Exchanging),
            cancellation: host.draining.child_token(),
        };
        // Deterministically place cancellation between the transport's check
        // and its admission callback, an actual multi-thread interleaving.
        attempt.cancel();
        assert_eq!(attempt.projection().phase, Phase::Exchanging);
        host.draining.cancel();
        let mut changes = host.changes.subscribe();
        let phase = settle(
            &host,
            &attempt,
            *ticket,
            Ok(Credential {
                secret: "synthetic-spent-grant".into(),
                refresh_at: Some(9_000_000_000_000),
            }),
        )
        .await;
        assert_eq!(phase, Phase::Authenticated);
        let receipt = host
            .configuration
            .oauth_login_receipt("cancel-race".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(receipt.connection, attempt.connection);
        assert_eq!(
            host.configuration
                .catalog()
                .await
                .unwrap()
                .connections
                .len(),
            1
        );
        let mut configured = Vec::new();
        loop {
            match changes.try_recv() {
                Ok(change) if change["kind"] == "configuration.changed" => configured.push(change),
                Ok(_) => {} // Provider publication is independent of OAuth settlement.
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                Err(error) => panic!("configuration notification lost: {error}"),
            }
        }
        assert_eq!(
            configured,
            [json!({"kind":"configuration.changed","revision":1})]
        );
        host.log.shutdown().await.unwrap();
        host.configuration.shutdown().await.unwrap();
    }
}
