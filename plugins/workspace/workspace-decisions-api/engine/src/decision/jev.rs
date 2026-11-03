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
    ChoiceProbability, ChoiceValue, Error, Evaluation, EvaluationResult, Question, ScoreProbability,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
mod answer;

#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Answer {
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
        legend: BTreeMap<String, Value>,
    },
}
#[derive(Deserialize)]
struct Response {
    model: String,
    answers: BTreeMap<String, Answer>,
    usage: Usage,
}
#[derive(Deserialize)]
struct Usage {
    input_tokens: u64,
    output_tokens: u64,
}

pub(super) fn encode(model: &str, input: &Evaluation) -> Result<Value, Error> {
    let mut questions = BTreeMap::new();
    for (id, q) in &input.questions {
        let value = match q {
            Question::Predicate {
                instructions,
                criteria,
            } => {
                let mut value = json!({"type":"noul","instructions":instructions});
                if let Some(c) = criteria {
                    value["criteria"] = json!(c);
                }
                value
            }
            Question::Choice {
                instructions,
                choices,
            } => {
                if choices.len() > 255 {
                    return Err(Error::Unsupported("JEV supports at most 255 choices"));
                }
                let mut criteria = BTreeMap::new();
                for c in choices {
                    let ChoiceValue::Text(name) = &c.value else {
                        return Err(Error::Unsupported("JEV requires string choice values"));
                    };
                    if name.is_empty() {
                        return Err(Error::Unsupported("JEV requires nonempty choice names"));
                    }
                    criteria.insert(name, c.description.clone().unwrap_or(Value::Null));
                }
                json!({"type":"choice","instructions":instructions,"criteria":criteria})
            }
            Question::Score {
                instructions,
                levels,
            } => {
                if levels.len() > 10 {
                    return Err(Error::Unsupported("JEV supports at most 10 score levels"));
                }
                json!({"type":"score","instructions":instructions,"criteria":levels.iter().map(|l| match &l.description {
                    Some(description) => json!({"label": l.label, "description": description}),
                    None => Value::String(l.label.clone()),
                }).collect::<Vec<_>>()})
            }
        };
        questions.insert(id, value);
    }
    Ok(json!({"model":model,"state":input.input,"questions":questions}))
}
pub(super) fn decode(bytes: &[u8], input: &Evaluation) -> Result<EvaluationResult, Error> {
    let wire: Response = serde_json::from_slice(bytes).map_err(|_| Error::Response)?;
    let mut answers = BTreeMap::new();
    for (id, a) in wire.answers {
        let answer = match a {
            Answer::Noul { noul } => super::Answer::Predicate { probability: noul },
            Answer::Choice {
                choice,
                confidence,
                probabilities,
            } => super::Answer::Choice {
                choice: ChoiceValue::Text(choice),
                confidence,
                probabilities: probabilities
                    .into_iter()
                    .map(|(value, probability)| ChoiceProbability {
                        value: ChoiceValue::Text(value),
                        probability,
                    })
                    .collect(),
            },
            Answer::Score {
                score,
                confidence,
                probabilities,
                legend,
            } => {
                let Some(Question::Score { levels, .. }) = input.questions.get(&id) else {
                    return Err(Error::Response);
                };
                let mut values = Vec::new();
                for (key, probability) in probabilities {
                    let value: usize = key.parse().map_err(|_| Error::Response)?;
                    let label = levels.get(value).ok_or(Error::Response)?.label.clone();
                    if key != value.to_string() {
                        return Err(Error::Response);
                    }
                    values.push(ScoreProbability {
                        value,
                        label,
                        probability,
                    });
                }
                values.sort_by_key(|p| p.value);
                super::Answer::Score {
                    score,
                    confidence,
                    probabilities: values,
                    legend,
                }
            }
        };
        answers.insert(id, answer);
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
