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

use crate::settings::{Protocol, Repository, Secrets, Settings};
use maka_capabilities::{call, http};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc, time::Duration};

mod jev;
mod openai;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "DecisionsEvaluation")]
pub struct Evaluation {
    pub input: Value,
    pub questions: BTreeMap<String, Question>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "DecisionsQuestion")]
pub enum Question {
    Predicate {
        instructions: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        criteria: Option<BTreeMap<String, Value>>,
    },
    Choice {
        instructions: Value,
        choices: Vec<Choice>,
    },
    Score {
        instructions: Value,
        levels: Vec<Level>,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(rename = "DecisionsChoiceValue")]
pub enum ChoiceValue {
    Text(String),
    Boolean(bool),
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "DecisionsChoice")]
pub struct Choice {
    pub value: ChoiceValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "DecisionsLevel")]
pub struct Level {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<Value>,
}
fn structured(v: &Value) -> bool {
    v.is_string() || v.is_object() || v.is_array()
}
impl Evaluation {
    pub fn validate(&self) -> Result<(), Error> {
        if !structured(&self.input) || self.questions.is_empty() {
            return Err(Error::Input);
        }
        for (id, question) in &self.questions {
            let valid = match question {
                Question::Predicate {
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
                    choices,
                } => {
                    structured(instructions)
                        && !choices.is_empty()
                        && choices
                            .iter()
                            .all(|c| c.description.as_ref().is_none_or(structured))
                        && choices
                            .iter()
                            .map(|c| &c.value)
                            .collect::<std::collections::BTreeSet<_>>()
                            .len()
                            == choices.len()
                }
                Question::Score {
                    instructions,
                    levels,
                } => {
                    structured(instructions)
                        && levels.len() >= 2
                        && levels
                            .iter()
                            .all(|l| l.description.as_ref().is_none_or(structured))
                }
            };
            if id.is_empty() || !valid {
                return Err(Error::Input);
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "DecisionsEvaluationResult")]
pub struct EvaluationResult {
    pub model: String,
    pub answers: BTreeMap<String, Answer>,
    pub usage: Usage,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "DecisionsUsage")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "DecisionsAnswer")]
pub enum Answer {
    Predicate {
        probability: f64,
    },
    Choice {
        choice: ChoiceValue,
        confidence: f64,
        probabilities: Vec<ChoiceProbability>,
    },
    Score {
        score: f64,
        confidence: f64,
        probabilities: Vec<ScoreProbability>,
        legend: BTreeMap<String, Value>,
    },
    Refusal,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "DecisionsChoiceProbability")]
pub struct ChoiceProbability {
    pub value: ChoiceValue,
    pub probability: f64,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "DecisionsScoreProbability")]
pub struct ScoreProbability {
    pub value: usize,
    pub label: String,
    pub probability: f64,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Decision request is outside the evaluation contract")]
    Input,
    #[error("Decision request is not supported by the selected protocol: {0}")]
    Unsupported(&'static str),
    #[error("Decisions API is disabled or its endpoint credential is not configured")]
    Unavailable,
    #[error("Decisions API network access is not authorized")]
    Denied,
    #[error("Decision request cancelled")]
    Cancelled,
    #[error("Decision request timed out; the provider may have processed it")]
    Timeout,
    #[error("Decision network request failed; the provider may have processed it")]
    Network,
    #[error("Decisions API returned HTTP {0}")]
    Status(u16),
    #[error("Decisions API returned an invalid response")]
    Response,
    #[error("Decision resource settlement is unconfirmed")]
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
fn encode(protocol: Protocol, model: &str, input: &Evaluation) -> Result<Vec<u8>, Error> {
    let value = match protocol {
        Protocol::Jev => jev::encode(model, input)?,
        Protocol::OpenAiDecisions => openai::encode(model, input)?,
    };
    serde_json::to_vec(&value).map_err(|_| Error::Input)
}
fn decode(protocol: Protocol, bytes: &[u8], input: &Evaluation) -> Result<EvaluationResult, Error> {
    let result = match protocol {
        Protocol::Jev => jev::decode(bytes, input)?,
        Protocol::OpenAiDecisions => openai::decode(bytes, input)?,
    };
    validate_result(&result, input)?;
    Ok(result)
}
fn validate_result(result: &EvaluationResult, input: &Evaluation) -> Result<(), Error> {
    if result.model.is_empty()
        || result.answers.len() != input.questions.len()
        || result.usage.input_tokens >= (1 << 53)
        || result.usage.output_tokens >= (1 << 53)
    {
        return Err(Error::Response);
    }
    for (id, q) in &input.questions {
        let valid = match (q, result.answers.get(id)) {
            (_, Some(Answer::Refusal)) => true,
            (Question::Predicate { .. }, Some(Answer::Predicate { probability: p })) => {
                probability(*p)
            }
            (
                Question::Choice { choices, .. },
                Some(Answer::Choice {
                    choice,
                    confidence,
                    probabilities,
                }),
            ) => {
                let expected: std::collections::BTreeSet<_> =
                    choices.iter().map(|c| &c.value).collect();
                let actual: std::collections::BTreeSet<_> =
                    probabilities.iter().map(|p| &p.value).collect();
                expected.contains(choice)
                    && probability(*confidence)
                    && expected == actual
                    && actual.len() == probabilities.len()
                    && distribution(probabilities.iter().map(|p| p.probability))
            }
            (
                Question::Score { levels, .. },
                Some(Answer::Score {
                    score,
                    confidence,
                    probabilities,
                    legend,
                }),
            ) => {
                let actual: std::collections::BTreeSet<_> =
                    probabilities.iter().map(|p| p.value).collect();
                let weighted: f64 = probabilities
                    .iter()
                    .map(|p| p.value as f64 * p.probability)
                    .sum();
                score.is_finite()
                    && *score >= 0.0
                    && *score <= (levels.len() - 1) as f64
                    && probability(*confidence)
                    && actual.len() == levels.len()
                    && probabilities.len() == levels.len()
                    && probabilities
                        .iter()
                        .all(|p| levels.get(p.value).is_some_and(|l| l.label == p.label))
                    && distribution(probabilities.iter().map(|p| p.probability))
                    && (weighted - score).abs() <= 0.02
                    && legend.len() == levels.len()
                    && (0..levels.len()).all(|i| legend.get(&i.to_string()).is_some_and(structured))
            }
            _ => false,
        };
        if !valid {
            return Err(Error::Response);
        }
    }
    Ok(())
}
fn probability(n: f64) -> bool {
    n.is_finite() && (0.0..=1.0).contains(&n)
}
fn distribution(p: impl Iterator<Item = f64>) -> bool {
    let mut sum = 0.0;
    for v in p {
        if !probability(v) {
            return false;
        }
        sum += v;
    }
    (sum - 1.0).abs() <= 0.01
}
#[derive(Clone)]
pub struct DecisionsApi {
    pub settings: Repository,
    pub http: Arc<dyn http::Client>,
}
impl DecisionsApi {
    pub async fn evaluate(
        &self,
        parent: &call::Scope,
        input: Evaluation,
    ) -> Result<EvaluationResult, Error> {
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
        if !settings.enabled {
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
                    method: maka_plugin_core::http::Method::Post,
                    headers: secrets.request_headers().map_err(|_| Error::Input)?,
                    body: encode(settings.protocol, &settings.model, input)?.into(),
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
            decode(settings.protocol, &bytes, input)
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

// Absent fields select the variant; explicit null is never a valid field value.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
