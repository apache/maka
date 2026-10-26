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

use crate::settings::{Repository, Secrets, Settings};
use maka_agent_ports::preferences::Preferences;
use maka_capabilities::call;
use maka_capabilities::http;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

mod answer;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "JevEvaluation")]
pub struct Evaluation {
    pub state: Value,
    pub questions: BTreeMap<String, Question>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "JevQuestion")]
pub enum Question {
    Noul {
        instructions: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        criteria: Option<BTreeMap<String, Value>>,
    },
    Choice {
        instructions: Value,
        criteria: BTreeMap<String, Value>,
    },
    Score {
        instructions: Value,
        criteria: Vec<Value>,
    },
}
fn structured(v: &Value) -> bool {
    v.is_string() || v.is_object() || v.is_array()
}
impl Evaluation {
    pub fn validate(&self) -> Result<(), Error> {
        if !structured(&self.state) || self.questions.is_empty() {
            return Err(Error::Input);
        }
        for (id, question) in &self.questions {
            if id.is_empty() {
                return Err(Error::Input);
            }
            let valid = match question {
                Question::Noul {
                    instructions,
                    criteria,
                } => {
                    structured(instructions)
                        && criteria.as_ref().is_none_or(|c| {
                            c.iter().all(|(k, v)| {
                                matches!(k.as_str(), "true" | "false") && structured(v)
                            })
                        })
                }
                Question::Choice {
                    instructions,
                    criteria,
                } => {
                    structured(instructions)
                        && !criteria.is_empty()
                        && criteria
                            .iter()
                            .all(|(k, v)| !k.is_empty() && (v.is_null() || structured(v)))
                }
                Question::Score {
                    instructions,
                    criteria,
                } => {
                    structured(instructions)
                        && criteria.len() >= 2
                        && criteria.iter().all(structured)
                }
            };
            if !valid {
                return Err(Error::Input);
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "JevEvaluationResult")]
pub struct EvaluationResult {
    pub model: String,
    pub answers: BTreeMap<String, Answer>,
    pub usage: Usage,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "JevUsage")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "JevAnswer")]
pub enum Answer {
    Noul {
        noul: f64,
    },
    Choice {
        choice: String,
        confidence: f64,
        probabilities: BTreeMap<String, f64>,
    },
    Score {
        score: f64,
        confidence: f64,
        probabilities: BTreeMap<String, f64>,
        legend: BTreeMap<String, String>,
    },
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Jev request is outside the evaluation contract")]
    Input,
    #[error("Jev is disabled or its endpoint credential is not configured")]
    Unavailable,
    #[error("Jev network access is not authorized")]
    Denied,
    #[error("Jev request cancelled")]
    Cancelled,
    #[error("Jev request timed out; the provider may have processed it")]
    Timeout,
    #[error("Jev network request failed; the provider may have processed it")]
    Network,
    #[error("Jev returned HTTP {0}")]
    Status(u16),
    #[error("Jev returned an invalid response")]
    Response,
    #[error("Jev resource settlement is unconfirmed")]
    Settlement,
}
impl Error {
    pub fn outcome_unknown(&self) -> bool {
        matches!(
            self,
            Self::Network | Self::Timeout | Self::Cancelled | Self::Settlement
        )
    }
}
#[derive(Clone)]
pub struct Jev {
    pub settings: Repository,
    pub http: Arc<dyn http::Client>,
    pub preferences: Arc<dyn Preferences>,
}
impl Jev {
    pub async fn evaluate(
        &self,
        parent: &call::Scope,
        input: Evaluation,
    ) -> Result<EvaluationResult, Error> {
        input.validate()?;
        let (_, settings) = self
            .settings
            .settings()
            .await
            .map_err(|_| Error::Unavailable)?;
        self.configured(parent, input, settings).await
    }
    pub async fn configured(
        &self,
        parent: &call::Scope,
        input: Evaluation,
        settings: Settings,
    ) -> Result<EvaluationResult, Error> {
        input.validate()?;
        settings.validate().map_err(|_| Error::Input)?;
        if !settings.enabled
            || self
                .preferences
                .read()
                .await
                .map_err(|_| Error::Unavailable)?
                .privacy
                .incognito_active
        {
            return Err(Error::Unavailable);
        }
        let key = self
            .settings
            .credentials
            .read(settings.credential_key())
            .await
            .map_err(|_| Error::Unavailable)?
            .and_then(|r| r.secret)
            .filter(|s| !s.is_empty())
            .ok_or(Error::Unavailable)?;
        let secrets: Secrets = serde_json::from_str(&key).map_err(|_| Error::Unavailable)?;
        secrets.validate().map_err(|_| Error::Unavailable)?;
        let owned = call::Owned::new(parent.child().map_err(|_| Error::Denied)?);
        let scope = owned.scope();
        let result = tokio::select! {
            biased;
            _ = scope.cancellation.cancelled() => Err(Error::Cancelled),
            result = tokio::time::timeout(Duration::from_millis(settings.timeout_ms), self.request(&scope, &settings, &secrets, &input)) => result.unwrap_or(Err(Error::Timeout)),
        };
        scope.cancellation.cancel();
        owned.finish().await.map_err(|_| Error::Settlement)?;
        result
    }
    async fn request(
        &self,
        scope: &call::Scope,
        settings: &Settings,
        secrets: &Secrets,
        input: &Evaluation,
    ) -> Result<EvaluationResult, Error> {
        let response = self
            .http
            .request(
                scope.clone(),
                http::Request {
                    url: settings.url.clone(),
                    method: http::Method::Post,
                    headers: secrets.request_headers().map_err(|_| Error::Input)?,
                    body: serde_json::to_vec(&json!({"model": settings.model, "state":input.state,
                "questions":input.questions}))
                    .map_err(|_| Error::Input)?
                    .into(),
                },
            )
            .await
            .map_err(network)?;
        let result = async {
            if !(200..300).contains(&response.head.status) {
                return Err(Error::Status(response.head.status));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.body.next().await.map_err(network)? {
                bytes.extend_from_slice(&chunk);
            }
            decode(&bytes, input)
        }
        .await;
        // A redirect is a response, never permission to forward this endpoint's key.
        response.body.close().await.map_err(network)?;
        result
    }
}
fn network(e: http::Error) -> Error {
    match e {
        http::Error::Denied => Error::Denied,
        http::Error::CleanupUnconfirmed => Error::Settlement,
        _ => Error::Network,
    }
}
fn decode(bytes: &[u8], input: &Evaluation) -> Result<EvaluationResult, Error> {
    let result: EvaluationResult = serde_json::from_slice(bytes).map_err(|_| Error::Response)?;
    if result.model.is_empty()
        || result.answers.len() != input.questions.len()
        || result.usage.input_tokens >= (1 << 53)
        || result.usage.output_tokens >= (1 << 53)
    {
        return Err(Error::Response);
    }
    for (id, question) in &input.questions {
        let valid = match (question, result.answers.get(id)) {
            (Question::Noul { .. }, Some(Answer::Noul { noul })) => probability(*noul),
            (
                Question::Choice { criteria, .. },
                Some(Answer::Choice {
                    choice,
                    confidence,
                    probabilities,
                }),
            ) => {
                criteria.contains_key(choice)
                    && probability(*confidence)
                    && distribution(probabilities, criteria.keys().map(String::as_str))
            }
            (
                Question::Score { criteria, .. },
                Some(Answer::Score {
                    score,
                    confidence,
                    probabilities,
                    legend,
                }),
            ) => {
                let keys: Vec<_> = (0..criteria.len()).map(|i| i.to_string()).collect();
                let weighted: f64 = keys
                    .iter()
                    .enumerate()
                    .map(|(i, k)| i as f64 * probabilities.get(k).copied().unwrap_or(0.0))
                    .sum();
                score.is_finite()
                    && *score >= 0.0
                    && *score <= (criteria.len() - 1) as f64
                    && probability(*confidence)
                    && legend.len() == keys.len()
                    && keys.iter().all(|k| legend.contains_key(k))
                    && distribution(probabilities, keys.iter().map(String::as_str))
                    && (weighted - score).abs() <= 0.02
            }
            _ => false,
        };
        if !valid {
            return Err(Error::Response);
        }
    }
    Ok(result)
}
fn distribution<'a>(p: &BTreeMap<String, f64>, keys: impl Iterator<Item = &'a str>) -> bool {
    let keys: Vec<_> = keys.collect();
    p.len() == keys.len()
        && keys
            .iter()
            .all(|k| p.get(*k).is_some_and(|v| probability(*v)))
        && (p.values().sum::<f64>() - 1.0).abs() <= 0.01
}
fn probability(n: f64) -> bool {
    n.is_finite() && (0.0..=1.0).contains(&n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Repository, Settings};
    use futures_util::future::BoxFuture;
    use maka_agent_ports::preferences;
    use maka_capabilities::call;
    use maka_capabilities::credentials;
    use maka_capabilities::http;
    use maka_capabilities::storage;
    use serde_json::{Value, json};
    use std::{
        collections::VecDeque,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };
    use tokio_util::sync::CancellationToken;

    struct Config(Settings);
    impl storage::Store for Config {
        fn read(
            &self,
            _: String,
        ) -> BoxFuture<'_, Result<Option<storage::Record>, storage::StoreError>> {
            Box::pin(async {
                Ok(Some(storage::Record {
                    revision: 1,
                    data: storage::Data::Present(serde_json::to_value(&self.0).unwrap()),
                }))
            })
        }
        fn scan(
            &self,
            _: storage::Scan,
        ) -> BoxFuture<'_, Result<storage::Page, storage::StoreError>> {
            Box::pin(async { unreachable!() })
        }
        fn batch(
            &self,
            _: Vec<storage::Mutation>,
        ) -> BoxFuture<'_, Result<Vec<storage::Record>, storage::StoreError>> {
            Box::pin(async { unreachable!() })
        }
    }
    struct Keys {
        endpoint: String,
    }
    impl credentials::Credentials for Keys {
        fn read(
            &self,
            key: String,
        ) -> BoxFuture<'_, Result<Option<credentials::Record>, storage::StoreError>> {
            Box::pin(async move {
                Ok((key == self.endpoint).then(|| credentials::Record {
                    revision: 1,
                    secret: Some(
                        json!({"apiKey":"private-key","headers":{"X-Tenant":"tenant"}}).to_string(),
                    ),
                }))
            })
        }
        fn write(
            &self,
            _: credentials::Write,
        ) -> BoxFuture<'_, Result<credentials::WriteResult, storage::StoreError>> {
            Box::pin(async { unreachable!() })
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
        calls: Mutex<Vec<(call::Scope, http::BufferedRequest)>>,
        started: tokio::sync::Notify,
    }
    impl http::Client for Transport {
        fn request(
            &self,
            scope: call::Scope,
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
                self.calls.lock().unwrap().push((scope, request));
                self.started.notify_one();
                let reply = self.replies.lock().unwrap().pop_front();
                match reply {
                    Some(r) => Ok(r),
                    None => std::future::pending().await,
                }
            })
        }
    }
    struct Body {
        bytes: Mutex<Option<Vec<u8>>>,
        closes: AtomicUsize,
    }
    impl http::Body for Body {
        fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
            Box::pin(async { Ok(self.bytes.lock().unwrap().take()) })
        }
        fn cancel(&self) {}
        fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
            Box::pin(async {
                self.closes.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }
    fn reply(t: &Transport, status: u16, bytes: Vec<u8>) -> Arc<Body> {
        let body = Arc::new(Body {
            bytes: Mutex::new(Some(bytes)),
            closes: AtomicUsize::new(0),
        });
        t.replies.lock().unwrap().push_back(http::Response {
            head: http::Head {
                status,
                url: "https://custom.example/jev".into(),
                headers: vec![],
            },
            body: body.clone(),
        });
        body
    }
    fn input() -> Evaluation {
        serde_json::from_value(json!({"state":{"complete":true},"questions":{"done":{"type":"noul","instructions":"Is complete true?"}}})).unwrap()
    }
    fn answer() -> Vec<u8> {
        serde_json::to_vec(&json!({"model":"custom","answers":{"done":{"type":"noul","noul":0.8}},"usage":{"input_tokens":15,"output_tokens":2}})).unwrap()
    }
    fn scope() -> call::Scope {
        call::Issuer::default()
            .issue(
                call::Identity::Remote {
                    request_id: uuid::Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .unwrap()
    }
    fn backend() -> (Jev, Arc<Transport>, Arc<Privacy>) {
        let settings = Settings {
            enabled: true,
            url: "https://custom.example/jev".into(),
            model: "custom".into(),
            timeout_ms: 100,
        };
        let transport = Arc::new(Transport::default());
        let privacy = Arc::new(Privacy::default());
        (
            Jev {
                settings: Repository {
                    credentials: Arc::new(Keys {
                        endpoint: settings.credential_key(),
                    }),
                    store: Arc::new(Config(settings)),
                },
                http: transport.clone(),
                preferences: privacy.clone(),
            },
            transport,
            privacy,
        )
    }
    #[tokio::test]
    async fn evaluation_preserves_headers_usage_and_child_scope_cleanup() {
        let (jev, t, _) = backend();
        let parent = scope();
        let body = reply(&t, 200, answer());
        let output = jev.evaluate(&parent, input()).await.unwrap();
        assert_eq!(output.usage.input_tokens, 15);
        assert_eq!(body.closes.load(Ordering::SeqCst), 1);
        reply(&t, 200, answer());
        let wire = serde_json::to_value(jev.evaluate(&parent, input()).await.unwrap()).unwrap();
        assert_eq!(wire["answers"]["done"]["noul"], 0.8);
        {
            let calls = t.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            assert_eq!(calls[0].1.url, "https://custom.example/jev");
            assert!(
                calls[0]
                    .1
                    .headers
                    .contains(&("Authorization".into(), "Bearer private-key".into()))
            );
            assert!(
                calls[0]
                    .1
                    .headers
                    .contains(&("X-Tenant".into(), "tenant".into()))
            );
            assert_eq!(
                serde_json::from_slice::<Value>(&calls[0].1.body).unwrap()["model"],
                "custom"
            );
            assert!(calls[0].0.cancellation.is_cancelled());
        }
        assert!(!parent.cancellation.is_cancelled());
        parent.finish().await.unwrap();
    }
    #[tokio::test]
    async fn network_is_bounded_cancelled_and_never_redirected_or_retried() {
        let (jev, t, privacy) = backend();
        let parent = scope();
        privacy.0.store(true, Ordering::SeqCst);
        assert!(matches!(
            jev.evaluate(&parent, input()).await,
            Err(Error::Unavailable)
        ));
        assert!(t.calls.lock().unwrap().is_empty());
        privacy.0.store(false, Ordering::SeqCst);
        for (status, bytes) in [(302, vec![]), (429, vec![]), (200, vec![b'a'; 65537])] {
            let body = reply(&t, status, bytes);
            assert!(jev.evaluate(&parent, input()).await.is_err());
            assert_eq!(body.closes.load(Ordering::SeqCst), 1);
        }
        assert_eq!(t.calls.lock().unwrap().len(), 3);
        assert!(matches!(
            jev.evaluate(&parent, input()).await,
            Err(Error::Timeout)
        ));
        assert_eq!(t.calls.lock().unwrap().len(), 4);
        assert!(
            t.calls
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .0
                .cancellation
                .is_cancelled()
        );
        parent.cancellation.cancel();
        assert!(matches!(
            jev.evaluate(&parent, input()).await,
            Err(Error::Cancelled) | Err(Error::Denied)
        ));
        assert_eq!(t.calls.lock().unwrap().len(), 4);
        parent.finish().await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_and_timeout_preserve_uncertain_post_outcomes() {
        let (jev, transport, _) = backend();
        let parent = scope();
        let request = jev.evaluate(&parent, input());
        let cancellation = async {
            transport.started.notified().await;
            parent.cancellation.cancel();
        };
        let (result, ()) = tokio::join!(request, cancellation);
        assert!(result.unwrap_err().outcome_unknown());
        assert!(
            transport.calls.lock().unwrap()[0]
                .0
                .cancellation
                .is_cancelled()
        );
        parent.finish().await.unwrap();
        let parent = scope();
        assert!(
            jev.evaluate(&parent, input())
                .await
                .unwrap_err()
                .outcome_unknown()
        );
        parent.finish().await.unwrap();
    }

    #[test]
    fn all_question_types_preserve_uncertainty_and_usage() {
        let input: Evaluation = serde_json::from_value(json!({"state":{"test":true},"questions":{
            "binary":{"type":"noul","instructions":["yes?"]},
            "choice":{"type":"choice","instructions":"pick","criteria":{"yes":null,"no":{"description":"no"}}},
            "score":{"type":"score","instructions":"rate","criteria":["low","high"]}
        }})).unwrap();
        input.validate().unwrap();
        let mut wire = json!({"model":"jev-latest","usage":{"input_tokens":10,"output_tokens":5},"answers":{
            "binary":{"type":"noul","noul":0.7},
            "choice":{"type":"choice","choice":"yes","confidence":0.51,"probabilities":{"yes":0.51,"no":0.49}},
            "score":{"type":"score","score":0.8,"confidence":0.6,"probabilities":{"0":0.2,"1":0.8},"legend":{"0":"low","1":"high"}}
        }});
        assert_eq!(
            decode(&serde_json::to_vec(&wire).unwrap(), &input)
                .unwrap()
                .usage
                .input_tokens,
            10
        );
        wire["answers"]["choice"]["choice"] = json!("foreign");
        assert!(decode(&serde_json::to_vec(&wire).unwrap(), &input).is_err());
        wire["answers"]["choice"]["choice"] = json!("yes");
        wire["answers"]["score"]["score"] = json!(0.1);
        assert!(decode(&serde_json::to_vec(&wire).unwrap(), &input).is_err());
    }
}
