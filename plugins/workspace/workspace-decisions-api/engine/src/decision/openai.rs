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

use super::{
    Answer, ChoiceProbability, ChoiceValue, Error, Evaluation, EvaluationResult, Question,
    ScoreProbability,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn content(value: &Value) -> Value {
    if let Some(text) = value.as_str() {
        json!({"type":"input_text","text":text})
    } else {
        json!({"type":"input_json","data":value})
    }
}
fn description(value: &Option<Value>) -> Result<Option<&str>, Error> {
    value
        .as_ref()
        .map(|v| {
            v.as_str().ok_or(Error::Unsupported(
                "OpenAI requires text choice and score descriptions",
            ))
        })
        .transpose()
}
pub(super) fn encode(model: &str, input: &Evaluation) -> Result<Value, Error> {
    if input.questions.len() > 400 {
        return Err(Error::Unsupported("OpenAI supports at most 400 questions"));
    }
    let mut questions = Vec::new();
    for (name, q) in &input.questions {
        let mut value = match q {
            Question::Predicate {
                instructions,
                criteria,
            } => {
                let instructions = if let Some(criteria) = criteria {
                    json!({"instructions":instructions,"criteria":criteria})
                } else {
                    instructions.clone()
                };
                json!({"type":"predicate","instructions":[content(&instructions)]})
            }
            Question::Choice {
                instructions,
                choices,
            } => {
                if !(2..=255).contains(&choices.len()) {
                    return Err(Error::Unsupported("OpenAI requires 2 to 255 choices"));
                }
                let mut values = Vec::new();
                for c in choices {
                    let mut value = json!({"value":c.value});
                    if let Some(d) = description(&c.description)? {
                        value["description"] = json!(d);
                    }
                    values.push(value);
                }
                json!({"type":"choice","instructions":[content(instructions)],"choices":values})
            }
            Question::Score {
                instructions,
                levels,
            } => {
                if !(2..=10).contains(&levels.len()) {
                    return Err(Error::Unsupported("OpenAI requires 2 to 10 score levels"));
                }
                let mut values = Vec::new();
                for l in levels {
                    let mut value = json!({"label":l.label});
                    if let Some(d) = description(&l.description)? {
                        value["description"] = json!(d);
                    }
                    values.push(value);
                }
                json!({"type":"score","instructions":[content(instructions)],"levels":values})
            }
        };
        value["name"] = json!(name);
        questions.push(value);
    }
    let evidence = if input.input.is_string() {
        input.input.clone()
    } else {
        json!([{"role":"user","content":[content(&input.input)]}])
    };
    Ok(json!({"model":model,"input":evidence,"questions":questions}))
}
#[derive(Deserialize)]
struct Response {
    model: String,
    answers: Vec<WireAnswer>,
    usage: WireUsage,
}
#[derive(Deserialize)]
struct WireUsage {
    input_tokens: u64,
    output_tokens: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Predicate,
    Choice,
    Score,
    Refusal,
}
// Decode numbers directly, without internally tagged enum buffering under arbitrary_precision.
#[derive(Deserialize)]
struct WireAnswer {
    #[serde(rename = "type")]
    kind: Kind,
    name: String,
    #[serde(default, deserialize_with = "super::present")]
    probability: Option<f64>,
    #[serde(default, deserialize_with = "super::present")]
    choice: Option<ChoiceValue>,
    #[serde(default, deserialize_with = "super::present")]
    confidence: Option<f64>,
    #[serde(default, deserialize_with = "super::present")]
    score: Option<f64>,
    #[serde(default, deserialize_with = "super::present")]
    probabilities: Option<Vec<Probability>>,
}
#[derive(Deserialize)]
struct Probability {
    value: Value,
    probability: f64,
    label: Option<String>,
}
pub(super) fn decode(bytes: &[u8], input: &Evaluation) -> Result<EvaluationResult, Error> {
    let wire: Response = serde_json::from_slice(bytes).map_err(|_| Error::Response)?;
    let mut answers = BTreeMap::new();
    for a in wire.answers {
        let answer = match (
            a.kind,
            a.probability,
            a.choice,
            a.confidence,
            a.score,
            a.probabilities,
        ) {
            (Kind::Predicate, Some(probability), None, None, None, None) => {
                Answer::Predicate { probability }
            }
            (Kind::Choice, None, Some(choice), Some(confidence), None, Some(p)) => {
                let mut probabilities = Vec::new();
                for v in p {
                    let value = serde_json::from_value(v.value).map_err(|_| Error::Response)?;
                    if v.label.is_some() {
                        return Err(Error::Response);
                    }
                    probabilities.push(ChoiceProbability {
                        value,
                        probability: v.probability,
                    });
                }
                Answer::Choice {
                    choice,
                    confidence,
                    probabilities,
                }
            }
            (Kind::Score, None, None, Some(confidence), Some(score), Some(p)) => {
                let Some(Question::Score { levels, .. }) = input.questions.get(&a.name) else {
                    return Err(Error::Response);
                };
                let mut probabilities = Vec::new();
                for v in p {
                    let value = usize::try_from(v.value.as_u64().ok_or(Error::Response)?)
                        .map_err(|_| Error::Response)?;
                    probabilities.push(ScoreProbability {
                        value,
                        label: v.label.ok_or(Error::Response)?,
                        probability: v.probability,
                    });
                }
                let legend = levels
                    .iter()
                    .enumerate()
                    .map(|(i, l)| {
                        (
                            i.to_string(),
                            match &l.description {
                                Some(description) => {
                                    json!({"label": l.label, "description": description})
                                }
                                None => Value::String(l.label.clone()),
                            },
                        )
                    })
                    .collect();
                Answer::Score {
                    score,
                    confidence,
                    probabilities,
                    legend,
                }
            }
            (Kind::Refusal, None, None, None, None, None) => Answer::Refusal,
            _ => return Err(Error::Response),
        };
        if !input.questions.contains_key(&a.name) || answers.insert(a.name, answer).is_some() {
            return Err(Error::Response);
        }
    }
    Ok(EvaluationResult {
        model: wire.model,
        answers,
        usage: super::Usage {
            input_tokens: wire.usage.input_tokens,
            output_tokens: wire.usage.output_tokens,
        },
    })
}
