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

pub use maka_agent_facts::model::assembly::StepBuilder;

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::ModelEvent;
    use maka_agent_facts::model::ModelFinishReason;
    use maka_agent_facts::model::ModelPart;
    use maka_agent_facts::model::ModelUsage;
    use maka_agent_facts::model::TextKind;
    use serde_json::json;

    #[test]
    fn interleaved_parts_preserve_metadata_and_require_complete_streams() {
        let events = [
            ModelEvent::PartStarted {
                id: "r".into(),
                text_kind: TextKind::Thinking,
                provider_options: Some(json!({"anthropic":{"signature":"initial","other":1}})),
            },
            ModelEvent::PartStarted {
                id: "t".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            },
            ModelEvent::PartDelta {
                id: "r".into(),
                text: "think".into(),
                provider_options: None,
            },
            ModelEvent::PartDelta {
                id: "t".into(),
                text: "answer".into(),
                provider_options: None,
            },
            ModelEvent::PartFinished {
                id: "r".into(),
                provider_options: Some(json!({"anthropic":{"signature":"signed"}})),
            },
            ModelEvent::PartFinished {
                id: "t".into(),
                provider_options: Some(json!({"openai":{"itemId":"item"}})),
            },
            ModelEvent::Finished {
                reason: ModelFinishReason::Stop,
                usage: ModelUsage {
                    input_tokens: Some(3),
                    output_tokens: Some(4),
                    reasoning_tokens: Some(2),
                    ..Default::default()
                },
                provider_options: None,
            },
        ];
        for length in [4, 6, 7] {
            let mut builder = StepBuilder::default();
            for event in &events[..length] {
                builder.push(event.clone()).unwrap();
            }
            let result = builder.finish();
            assert_eq!(result.is_ok(), length == 7);
            if let Ok(step) = result {
                assert_eq!(
                    step.parts,
                    vec![
                        ModelPart::Text {
                            text_kind: TextKind::Thinking,
                            text: "think".into(),
                            provider_options: Some(
                                json!({"anthropic":{"signature":"signed","other":1}})
                            )
                        },
                        ModelPart::Text {
                            text_kind: TextKind::Text,
                            text: "answer".into(),
                            provider_options: Some(json!({"openai":{"itemId":"item"}}))
                        },
                    ]
                );
                assert_eq!(step.finish_reason, ModelFinishReason::Stop);
                assert_eq!(step.usage.output_tokens, Some(4));
                assert_eq!(step.usage.reasoning_tokens, Some(2));
            }
        }
    }

    #[test]
    fn failed_or_finished_builders_cannot_accept_more_events() {
        for already_finished in [false, true] {
            let mut builder = StepBuilder::default();
            let finish = ModelEvent::Finished {
                reason: ModelFinishReason::Stop,
                usage: ModelUsage::default(),
                provider_options: None,
            };
            if already_finished {
                builder.push(finish.clone()).unwrap();
            }
            assert!(
                builder
                    .push(ModelEvent::PartFinished {
                        id: "unknown".into(),
                        provider_options: None,
                    })
                    .is_err()
            );
            assert!(builder.push(finish).is_err());
            assert!(builder.finish().is_err());
        }
    }
}
