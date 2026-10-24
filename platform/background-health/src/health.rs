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

use maka_agent_facts::shell_result::ShellOutput;
use maka_agent_facts::shell_result::ShellSnapshot;
use maka_agent_facts::shell_result::ShellStatus;
use maka_agent_facts::tools::ToolError;
use maka_agent_ports::preferences;
use maka_capabilities::call;
use maka_capabilities::filesystem;
use maka_capabilities::http;
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Instant};

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Input {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub include_logs: bool,
    pub url: Option<String>,
}
impl Input {
    pub fn validate(&self) -> Result<(), String> {
        self.reference
            .strip_prefix("maka://runtime/background-tasks/")
            .filter(|id| maka_agent_facts::interaction::entity_id(id).is_ok())
            .ok_or("Expected a background-task reference returned by Shell")?;
        if let Some(value) = &self.url {
            let url = url::Url::parse(value).map_err(|_| "Invalid health endpoint URL")?;
            if value.len() > 8192
                || !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err(
                    "Use an HTTP(S) health URL without user credentials or fragment".into(),
                );
            }
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub status: ShellStatus,
    pub tracked: bool,
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logs: Option<ShellOutput>,
}
#[derive(Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Endpoint {
    NotChecked,
    Unknown {
        target: String,
        error: String,
    },
    Checked {
        target: String,
        http_status: u16,
        elapsed_ms: u64,
        health: Readiness,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    Healthy,
    Unknown,
    Unhealthy,
}
#[derive(Serialize)]
pub struct Report {
    pub process: Process,
    pub endpoint: Endpoint,
}
#[derive(Clone)]
pub struct Health {
    pub files: Arc<dyn filesystem::Files>,
    pub http: Arc<dyn http::Client>,
    pub preferences: Arc<dyn preferences::Preferences>,
}
impl Health {
    pub async fn check(&self, parent: &call::Scope, input: Input) -> Result<Report, ToolError> {
        input.validate().map_err(failed)?;
        let snapshot = self
            .files
            .invoke(
                parent.clone(),
                filesystem::Operation::Read(maka_agent_facts::read::ReadInput {
                    path: input.reference.clone(),
                    offset: None,
                    limit: None,
                }),
            )
            .await?
            .into_json();
        let snapshot: ShellSnapshot = serde_json::from_value(snapshot)
            .map_err(|_| failed("Host returned an invalid background-task snapshot"))?;
        snapshot.validate().map_err(failed)?;
        if snapshot.resource_ref != input.reference {
            return Err(failed("Host returned a different background task"));
        }
        let process = Process {
            status: snapshot.status,
            tracked: true,
            started_at: snapshot.started_at,
            updated_at: snapshot.updated_at,
            completed_at: snapshot.completed_at,
            exit_code: snapshot.exit_code,
            failure_message: snapshot.failure_message,
            logs: input.include_logs.then_some(snapshot.output).flatten(),
        };
        let endpoint = match input.url {
            None => Endpoint::NotChecked,
            Some(url) => {
                let target = url::Url::parse(&url)
                    .map_err(|_| failed("Invalid health URL"))?
                    .to_string();
                if self
                    .preferences
                    .read()
                    .await
                    .map_err(failed)?
                    .privacy
                    .incognito_active
                {
                    Endpoint::Unknown {
                        target,
                        error: "Endpoint probing is disabled in incognito mode".into(),
                    }
                } else {
                    self.probe(parent, target).await?
                }
            }
        };
        Ok(Report { process, endpoint })
    }
    async fn probe(&self, parent: &call::Scope, target: String) -> Result<Endpoint, ToolError> {
        let owned = call::Owned::new(parent.child()?);
        let scope = owned.scope();
        let started = Instant::now();
        let result = tokio::select! {
            biased;
            _ = scope.cancellation.cancelled() => Err(http::Error::Failed("cancelled".into())),
            result = async {
                let status = self.request(&scope, &target, http::Method::Head).await?;
                if matches!(status, 405 | 501) {
                    self.request(&scope, &target, http::Method::Get).await
                } else {
                    Ok(status)
                }
            } => result,
        };
        scope.cancellation.cancel();
        owned.finish().await?;
        if parent.cancellation.is_cancelled() {
            return Err(failed("Background health check cancelled"));
        }
        match result {
            Ok(status) => Ok(Endpoint::Checked {
                target,
                http_status: status,
                elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                health: if (200..300).contains(&status) {
                    Readiness::Healthy
                } else if status < 400 {
                    Readiness::Unknown
                } else {
                    Readiness::Unhealthy
                },
            }),
            Err(http::Error::CleanupUnconfirmed) => Err(ToolError::CleanupUnconfirmed(
                "Health probe cleanup is unconfirmed".into(),
            )),
            Err(http::Error::Denied) => Ok(Endpoint::Unknown {
                target,
                error: "Endpoint access was not authorized".into(),
            }),
            Err(_) => Ok(Endpoint::Unknown {
                target,
                error: "Endpoint probe failed or timed out".into(),
            }),
        }
    }
    async fn request(
        &self,
        scope: &call::Scope,
        url: &str,
        method: http::Method,
    ) -> Result<u16, http::Error> {
        let response = self
            .http
            .request(
                scope.clone(),
                http::Request {
                    url: url.into(),
                    method,
                    headers: vec![],
                    body: Default::default(),
                },
            )
            .await?;
        let status = response.head.status;
        // Discard the body and never follow redirects, including on GET fallback.
        response.body.cancel();
        response.body.close().await?;
        Ok(status)
    }
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use maka_agent_facts::tools::ToolError;
    use maka_agent_ports::preferences;
    use maka_capabilities::call;
    use maka_capabilities::filesystem;
    use maka_capabilities::http;
    use serde_json::{Value, json};
    use std::{
        collections::VecDeque,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };
    use tokio_util::sync::CancellationToken;
    const REFERENCE: &str = "maka://runtime/background-tasks/task";
    struct Files {
        snapshot: Value,
        denied: AtomicBool,
        calls: AtomicUsize,
    }
    impl filesystem::Files for Files {
        fn invoke(
            &self,
            _: call::Scope,
            operation: filesystem::Operation,
        ) -> BoxFuture<'_, Result<filesystem::Output, ToolError>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                assert!(matches!(operation,filesystem::Operation::Read(ref r)if r.path==REFERENCE));
                if self.denied.load(Ordering::SeqCst) {
                    return Err(ToolError::Failed("Session access denied".into()));
                }
                Ok(filesystem::Output::Value(self.snapshot.clone()))
            })
        }
    }
    #[derive(Default)]
    struct Privacy(AtomicBool);
    impl preferences::Preferences for Privacy {
        fn read(&self) -> BoxFuture<'_, Result<preferences::Snapshot, maka_capabilities::Error>> {
            Box::pin(async {
                Ok(preferences::Snapshot {
                    revision: 1,
                    privacy: maka_agent_facts::configuration::policy::PrivacyPolicy {
                        incognito_active: self.0.load(Ordering::SeqCst),
                    },
                    personalization: maka_agent_facts::configuration::policy::Personalization {
                        display_name: String::new(),
                    },
                    workspace_instructions: false,
                })
            })
        }
    }
    #[derive(Default)]
    struct Transport {
        replies: Mutex<VecDeque<http::Response>>,
        calls: Mutex<Vec<http::BufferedRequest>>,
        started: tokio::sync::Notify,
    }
    impl http::Client for Transport {
        fn request(
            &self,
            _: call::Scope,
            request: http::Request,
        ) -> BoxFuture<'_, Result<http::Response, http::Error>> {
            Box::pin(async move {
                let http::Request {
                    url,
                    method,
                    headers,
                    body,
                } = request;
                let mut upload = body.into_stream();
                let mut body = Vec::new();
                while let Some(chunk) = futures_util::StreamExt::next(&mut upload).await {
                    body.extend_from_slice(&chunk.unwrap());
                }
                let request = http::BufferedRequest {
                    url,
                    method,
                    headers,
                    body,
                };
                self.calls.lock().unwrap().push(request);
                self.started.notify_one();
                let result = self.replies.lock().unwrap().pop_front();
                match result {
                    Some(r) => Ok(r),
                    None => std::future::pending().await,
                }
            })
        }
    }
    #[derive(Default)]
    struct Body {
        cancelled: AtomicBool,
        closed: AtomicUsize,
        uncertain: bool,
    }
    impl http::Body for Body {
        fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
            Box::pin(async { panic!("Health probes must never read response bodies") })
        }
        fn cancel(&self) {
            self.cancelled.store(true, Ordering::SeqCst)
        }
        fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
            Box::pin(async {
                self.closed.fetch_add(1, Ordering::SeqCst);
                assert!(self.cancelled.load(Ordering::SeqCst));
                if self.uncertain {
                    Err(http::Error::CleanupUnconfirmed)
                } else {
                    Ok(())
                }
            })
        }
    }
    fn reply(transport: &Transport, status: u16, uncertain: bool) -> Arc<Body> {
        let body = Arc::new(Body {
            uncertain,
            ..Default::default()
        });
        transport.replies.lock().unwrap().push_back(http::Response {
            head: http::Head {
                status,
                url: "https://example.test/health".into(),
                headers: vec![("Location".into(), b"https://other.test/".to_vec())],
            },
            body: body.clone(),
        });
        body
    }
    fn backend() -> (Health, Arc<Files>, Arc<Transport>, Arc<Privacy>) {
        let files = Arc::new(Files {
            denied: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
            snapshot: json!({"kind":"shell_run","ref":REFERENCE,"mode":"pipes","status":"failed","cwd":"/tmp","cmd":"test","startedAt":1,"updatedAt":2,"completedAt":2,"exitCode":3,"revision":2,"output":{"mode":"pipes","stdout":"private logs","stderr":"failed","stdoutTruncated":false,"stderrTruncated":false,"redacted":false}}),
        });
        let http = Arc::new(Transport::default());
        let privacy = Arc::new(Privacy::default());
        (
            Health {
                files: files.clone(),
                http: http.clone(),
                preferences: privacy.clone(),
            },
            files,
            http,
            privacy,
        )
    }
    async fn scope() -> call::Scope {
        call::Issuer::default()
            .admit(
                call::Identity::Remote {
                    request_id: uuid::Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap()
    }
    fn input(url: bool, logs: bool) -> Input {
        Input {
            reference: REFERENCE.into(),
            include_logs: logs,
            url: url.then(|| "https://example.test/health".into()),
        }
    }
    #[tokio::test]
    async fn process_and_endpoint_are_independent_logs_are_opt_in_and_bodies_are_discarded() {
        let (health, _, http, _) = backend();
        let scope = scope().await;
        let report =
            serde_json::to_value(health.check(&scope, input(false, false)).await.unwrap()).unwrap();
        assert_eq!(report["process"]["status"], "failed");
        assert_eq!(report["endpoint"]["state"], "not_checked");
        assert!(report["process"].get("logs").is_none());
        assert!(http.calls.lock().unwrap().is_empty());
        let head = reply(&http, 405, false);
        let get = reply(&http, 204, false);
        let report =
            serde_json::to_value(health.check(&scope, input(true, true)).await.unwrap()).unwrap();
        assert_eq!(report["process"]["status"], "failed");
        assert_eq!(report["process"]["exitCode"], 3);
        assert_eq!(report["process"]["logs"]["stdout"], "private logs");
        assert_eq!(report["endpoint"]["health"], "healthy");
        {
            let calls = http.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            assert!(matches!(calls[0].method, http::Method::Head));
            assert!(matches!(calls[1].method, http::Method::Get));
            assert!(calls.iter().all(|request| request.body.is_empty()));
        }
        assert_eq!(head.closed.load(Ordering::SeqCst), 1);
        assert_eq!(get.closed.load(Ordering::SeqCst), 1);
        scope.finish().await.unwrap();
    }
    #[tokio::test]
    async fn redirects_are_observations_and_failed_settlement_is_not_a_health_result() {
        let (health, _, http, _) = backend();
        let scope = scope().await;
        for (status, expected) in [(302, "unknown"), (503, "unhealthy")] {
            reply(&http, status, false);
            let report =
                serde_json::to_value(health.check(&scope, input(true, false)).await.unwrap())
                    .unwrap();
            assert_eq!(report["endpoint"]["health"], expected);
        }
        assert_eq!(http.calls.lock().unwrap().len(), 2);
        reply(&http, 200, true);
        assert!(matches!(
            health.check(&scope, input(true, false)).await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        scope.finish().await.unwrap();
    }
    #[tokio::test]
    async fn unauthorized_resource_invalid_reference_and_privacy_do_not_probe() {
        let (health, files, http, privacy) = backend();
        let scope = scope().await;
        files.denied.store(true, Ordering::SeqCst);
        assert!(health.check(&scope, input(true, false)).await.is_err());
        assert!(http.calls.lock().unwrap().is_empty());
        files.denied.store(false, Ordering::SeqCst);
        privacy.0.store(true, Ordering::SeqCst);
        let report =
            serde_json::to_value(health.check(&scope, input(true, false)).await.unwrap()).unwrap();
        assert_eq!(report["endpoint"]["state"], "unknown");
        assert!(http.calls.lock().unwrap().is_empty());
        let calls = files.calls.load(Ordering::SeqCst);
        for reference in [
            "/etc/passwd",
            "maka://runtime/background-tasks/%74ask",
            "maka://runtime/background-tasks/task?other=1",
        ] {
            let mut input = input(false, false);
            input.reference = reference.into();
            assert!(health.check(&scope, input).await.is_err());
        }
        assert_eq!(files.calls.load(Ordering::SeqCst), calls);
        scope.finish().await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_drains_probe_and_is_not_reported_as_unhealthy() {
        let (health, _, http, _) = backend();
        let parent = scope().await;
        let check = health.check(&parent, input(true, false));
        let cancel = async {
            http.started.notified().await;
            parent.cancellation.cancel();
        };
        let (result, ()) = tokio::join!(check, cancel);
        assert!(result.is_err());
        parent.finish().await.unwrap();
    }
}
