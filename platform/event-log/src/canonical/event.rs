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

//! Decode the stored tool header and its original projection without joining bytes.
use crate::StoreError;
use maka_agent_facts::{
    artifact::ArtifactEvidence,
    event::{Fact, Invocation, RuntimeEvent, ToolOutcome},
    tool_output::{DurableToolProjection, RawToolResultRef},
};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::time::SystemTime;

#[derive(Deserialize)]
struct Header<'a> {
    id: String,
    recorded_at: SystemTime,
    invocation: Invocation,
    #[serde(borrow)]
    fact: HeaderFact<'a>,
}
#[derive(Deserialize)]
struct HeaderFact<'a> {
    kind: String,
    operation_id: String,
    #[serde(borrow)]
    outcome: HeaderOutcome<'a>,
}
#[derive(Deserialize)]
struct HeaderOutcome<'a> {
    kind: String,
    raw: RawToolResultRef,
    #[serde(borrow)]
    model_projection: &'a RawValue,
    #[serde(default)]
    artifacts: Vec<ArtifactEvidence>,
}

pub(crate) struct PreparedEvent(Prepared);

enum Prepared {
    Inline(String),
    Tool {
        header: Box<ToolHeader>,
        projection: String,
    },
}
struct ToolHeader {
    id: String,
    recorded_at: SystemTime,
    invocation: Invocation,
    operation_id: String,
    raw: RawToolResultRef,
    artifacts: Vec<ArtifactEvidence>,
}

impl PreparedEvent {
    pub(super) fn inline(json: &str) -> Self {
        Self(Prepared::Inline(json.to_owned()))
    }
    pub(crate) fn decode(self) -> Result<RuntimeEvent, StoreError> {
        match self.0 {
            Prepared::Inline(json) => Ok(serde_json::from_str(&json)?),
            Prepared::Tool { header, projection } => {
                let model_projection: DurableToolProjection = serde_json::from_str(&projection)?;
                let ToolHeader {
                    id,
                    recorded_at,
                    invocation,
                    operation_id,
                    raw,
                    artifacts,
                } = *header;
                Ok(RuntimeEvent {
                    id,
                    recorded_at,
                    invocation,
                    fact: Fact::ToolSettled {
                        operation_id,
                        outcome: ToolOutcome::Succeeded {
                            raw,
                            model_projection,
                            artifacts,
                        },
                    },
                })
            }
        }
    }
}

pub(super) fn prepare(
    header: &str,
    offset: usize,
    body: &[u8],
) -> Result<PreparedEvent, StoreError> {
    let Header {
        id,
        recorded_at,
        invocation,
        fact,
    } = serde_json::from_str::<Header<'_>>(header)?;
    let HeaderFact {
        kind,
        operation_id,
        outcome,
    } = fact;
    let HeaderOutcome {
        kind: outcome_kind,
        raw,
        model_projection,
        artifacts,
    } = outcome;
    let placeholder = model_projection.get();
    if kind != "tool_settled"
        || outcome_kind != "succeeded"
        || placeholder != "null"
        || (placeholder.as_ptr() as usize).checked_sub(header.as_ptr() as usize) != Some(offset)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "canonical slot does not identify a successful tool projection",
        )
        .into());
    }
    let body = std::str::from_utf8(body)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    Ok(PreparedEvent(Prepared::Tool {
        header: Box::new(ToolHeader {
            id,
            recorded_at,
            invocation,
            operation_id,
            raw,
            artifacts,
        }),
        projection: body.to_owned(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::recipe::{Recipe, Slot, projection};
    use maka_agent_facts::tool_output::ProjectionPart;
    use serde_json::json;

    fn original(value: DurableToolProjection) -> String {
        serde_json::to_string_pretty(&json!({
            "extra_null": null,
            "id":"settled", "recorded_at":{"secs_since_epoch":1,"nanos_since_epoch":2},
            "invocation":{"session_id":"s","turn_id":"t","run_id":"r","invocation_id":"i"},
            "fact":{"kind":"tool_settled","operation_id":"call","unknown":{"a":[1,true,null]},
                "outcome":{"kind":"succeeded","raw":{"bytes":0,"digest":"sha256:empty"},
                    "model_projection":value}}
        }))
        .unwrap()
    }

    #[test]
    fn split_events_match_original_typed_facts_and_preserve_the_raw_segments() {
        for value in [
            DurableToolProjection::Json {
                value: json!({"n":1.0,"text":"汉🦀\n\\\""}),
            },
            DurableToolProjection::Text {
                text: "text 汉\n\\".repeat(4000),
            },
            DurableToolProjection::Content {
                parts: vec![ProjectionPart::Text {
                    text: "part\n汉".into(),
                }],
            },
            DurableToolProjection::Failure,
        ] {
            let json = original(value)
                .replace("\"n\": 1.0", "\"n\": 1e+00")
                .replace("\"tool_settled\"", "\"tool_\\u0073ettled\"");
            let expected: RuntimeEvent = serde_json::from_str(&json).unwrap();
            let projection = projection("tool_settled", &json).unwrap().unwrap();
            let header = projection.header(&json).unwrap();
            let recipe = Recipe::new(
                &header,
                json.len() as u64,
                Some(Slot {
                    offset: projection.offset as u64,
                    bytes: projection.json.len() as u64,
                }),
            )
            .unwrap();
            let (prepared, parts) = recipe.prepare(Some(projection.json.as_bytes())).unwrap();
            let event = prepared.decode().unwrap();
            assert_eq!(event, expected);
            assert_eq!(parts.concat(), json.as_bytes());
        }
    }

    #[test]
    fn another_null_cannot_impersonate_the_projection_slot() {
        let json = original(DurableToolProjection::Text {
            text: "body".into(),
        });
        let projection = projection("tool_settled", &json).unwrap().unwrap();
        let header = projection.header(&json).unwrap();
        let wrong = header.find("null").unwrap();
        assert_ne!(wrong, projection.offset);
        let recipe = Recipe::new(
            &header,
            json.len() as u64,
            Some(Slot {
                offset: wrong as u64,
                bytes: projection.json.len() as u64,
            }),
        )
        .unwrap();
        assert!(recipe.prepare(Some(projection.json.as_bytes())).is_err());
    }

    #[test]
    fn known_header_fields_remain_required_and_typed() {
        let json = original(DurableToolProjection::Text {
            text: "body".into(),
        });
        let projection = projection("tool_settled", &json).unwrap().unwrap();
        let header = projection.header(&json).unwrap();
        for changed in [
            header.replace("\"succeeded\"", "\"failed\""),
            header.replace("\"tool_settled\"", "\"model_completed\""),
            header.replace("\"raw\": {", "\"artifacts\": null, \"raw\": {"),
            header.replace("\"id\": \"settled\"", "\"id\": null"),
            header.replace(
                "\"operation_id\": \"call\"",
                "\"operation_id\": \"a\", \"operation_id\": \"b\"",
            ),
        ] {
            let position = changed.find("\"model_projection\": null").unwrap()
                + "\"model_projection\": ".len();
            assert!(
                prepare(&changed, position, projection.json.as_bytes())
                    .and_then(PreparedEvent::decode)
                    .is_err()
            );
        }
    }
}
