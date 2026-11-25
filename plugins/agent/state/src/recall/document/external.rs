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

//! Borrowed canonical External fields rendered into the existing live document.
use crate::{
    recall::{Field, FieldSpan, Message},
    store::invalid,
};
use maka_agent_facts::{
    durable::{RunId, SCHEMA_VERSION},
    external_effects::ExternalEffectKey,
};
use maka_event_log::StoreError;
use maka_provider_protocol::json_stream::pull::{JsonStringDecoder, Transform};
use serde::{
    Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::value::RawValue;
use std::fmt;

// Both values and object keys remain borrowed raw tokens. serde's string
// visitor would allocate an entire escaped token before handing it to us.
fn text(raw: &RawValue, mut emit: impl FnMut(&[u8])) -> Result<(), StoreError> {
    let mut decoder = JsonStringDecoder::new();
    let mut input = raw.get().as_bytes();
    let mut buffer = [0u8; 32 * 1024];
    loop {
        let progress = decoder.transform(input, true, &mut buffer)?;
        emit(&buffer[..progress.written]);
        input = &input[progress.consumed..];
        if progress.finished {
            return Ok(());
        }
    }
}
fn equals(raw: &RawValue, expected: &str) -> Result<bool, StoreError> {
    let mut offset = 0usize;
    let mut same = true;
    text(raw, |bytes| {
        same &= expected
            .as_bytes()
            .get(offset..offset.saturating_add(bytes.len()))
            == Some(bytes);
        offset = offset.saturating_add(bytes.len());
    })?;
    Ok(same && offset == expected.len())
}
fn required(raw: Option<&RawValue>) -> Result<&RawValue, StoreError> {
    raw.ok_or_else(|| invalid("canonical External document field is missing"))
}
fn fields<'de, const N: usize>(
    raw: &'de RawValue,
    names: [&str; N],
) -> Result<[Option<&'de RawValue>; N], StoreError> {
    struct Named<'n, const N: usize>([&'n str; N]);
    impl<'de, const N: usize> Visitor<'de> for Named<'_, N> {
        type Value = [Option<&'de RawValue>; N];
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an original JSON object")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut out = [None; N];
            while let Some(key) = map.next_key::<&'de RawValue>()? {
                let value = map.next_value::<&'de RawValue>()?;
                for (index, name) in self.0.iter().enumerate() {
                    if equals(key, name).map_err(de::Error::custom)? {
                        if out[index].replace(value).is_some() {
                            return Err(de::Error::custom("duplicate canonical External field"));
                        }
                        break;
                    }
                }
            }
            Ok(out)
        }
    }
    Ok(serde_json::Deserializer::from_str(raw.get()).deserialize_map(Named(names))?)
}
fn values<'de>(
    raw: &'de RawValue,
    mut consume: impl FnMut(&'de RawValue) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    struct Values<'a, F>(&'a mut F);
    impl<'de, F: FnMut(&'de RawValue) -> Result<(), StoreError>> Visitor<'de> for Values<'_, F> {
        type Value = ();
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an original JSON array")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
            while let Some(value) = seq.next_element::<&'de RawValue>()? {
                (self.0)(value).map_err(de::Error::custom)?;
            }
            Ok(())
        }
    }
    Ok(serde_json::Deserializer::from_str(raw.get()).deserialize_seq(Values(&mut consume))?)
}
#[derive(Default)]
struct Body {
    bytes: Vec<u8>,
    fields: Vec<FieldSpan>,
}
impl Body {
    fn begin(&mut self) -> usize {
        if !self.bytes.is_empty() {
            self.bytes.push(b'\n');
        }
        self.bytes.len()
    }
    fn end(&mut self, field: Field, start: usize) {
        self.fields.push(FieldSpan {
            field,
            start,
            end: self.bytes.len(),
            internal: false,
        });
    }
    fn string(&mut self, raw: &RawValue) -> Result<(), StoreError> {
        text(raw, |bytes| self.bytes.extend_from_slice(bytes))
    }
    fn separator(&mut self, start: usize) {
        if self.bytes.len() > start {
            self.bytes.push(b'\n');
        }
    }
    fn json(&mut self, raw: &RawValue, start: usize) -> Result<(), StoreError> {
        match raw.get().as_bytes()[0] {
            b'[' => values(raw, |value| self.json(value, start)),
            b'{' => {
                struct Object<'a> {
                    body: &'a mut Body,
                    start: usize,
                }
                impl<'de> Visitor<'de> for Object<'_> {
                    type Value = ();
                    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                        f.write_str("an original JSON object")
                    }
                    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
                        while let Some(key) = map.next_key::<&'de RawValue>()? {
                            self.body.separator(self.start);
                            self.body.string(key).map_err(de::Error::custom)?;
                            let value = map.next_value::<&'de RawValue>()?;
                            self.body
                                .json(value, self.start)
                                .map_err(de::Error::custom)?;
                        }
                        Ok(())
                    }
                }
                Ok(serde_json::Deserializer::from_str(raw.get())
                    .deserialize_map(Object { body: self, start })?)
            }
            b'n' => Ok(()),
            b'"' => {
                self.separator(start);
                self.string(raw)
            }
            b't' | b'f' => {
                self.separator(start);
                self.bytes.extend_from_slice(raw.get().as_bytes());
                Ok(())
            }
            _ => {
                let number: serde_json::Number = serde_json::from_str(raw.get())?;
                self.separator(start);
                self.bytes.extend_from_slice(number.to_string().as_bytes());
                Ok(())
            }
        }
    }
    fn projection(
        &mut self,
        raw: &RawValue,
        output: Option<&RawValue>,
        resolve_content: &mut dyn FnMut(
            &maka_agent_facts::durable::ContentRef,
        ) -> Result<Vec<u8>, StoreError>,
    ) -> Result<(), StoreError> {
        let [kind, string, value, parts] = fields(raw, ["kind", "text", "value", "parts"])?;
        let kind = required(kind)?;
        let start = self.begin();
        if equals(kind, "text")? {
            self.string(required(string)?)?;
        } else if equals(kind, "json")? {
            self.json(required(value)?, start)?;
        } else if equals(kind, "from_output")? {
            let [format, value] = fields(required(output)?, ["format", "value"])?;
            let format = required(format)?;
            let value = required(value)?;
            if equals(format, "json")? {
                self.json(value, start)?;
            } else if equals(format, "text")? {
                self.string(value)?;
            } else if equals(format, "cell")? {
                let [observation, state] = fields(value, ["observation", "state"])?;
                let obs: maka_agent_facts::cells::CellObservation = match observation {
                    Some(obs_raw) if obs_raw.get() != "null" => {
                        serde_json::from_str(obs_raw.get())?
                    }
                    _ => {
                        let [state_kind, result] = fields(required(state)?, ["kind", "result"])?;
                        if !equals(required(state_kind)?, "completed")? {
                            return Err(invalid(
                                "shared cell projection requires a completed cell",
                            ));
                        }
                        let reference: maka_agent_facts::durable::ContentRef =
                            serde_json::from_str(required(result)?.get())?;
                        let bytes = resolve_content(&reference)?;
                        serde_json::from_slice(&bytes)?
                    }
                };
                let text = maka_agent_facts::tool_output::completed_cell_text_projection(&obs)
                    .ok_or_else(|| {
                        invalid("shared cell projection requires a text-only completed cell")
                    })?;
                self.bytes.extend_from_slice(text.as_bytes());
            } else if equals(format, "operation")? {
                let [receipt] = fields(value, ["receipt"])?;
                let [outcome] = fields(required(receipt)?, ["outcome"])?;
                let [result] = fields(required(outcome)?, ["result"])?;
                let [inner] = fields(required(result)?, ["value"])?;
                self.json(required(inner)?, start)?;
            } else {
                return Err(invalid(
                    "shared projection requires a returned JSON, text, or cell value",
                ));
            }
        } else if equals(kind, "content")? {
            let mut first = true;
            values(required(parts)?, |part| {
                let [kind, string] = fields(part, ["kind", "text"])?;
                let kind = required(kind)?;
                if equals(kind, "text")? {
                    if !first {
                        self.bytes.push(b'\n');
                    }
                    first = false;
                    self.string(required(string)?)?;
                } else if !equals(kind, "artifact")? && !equals(kind, "audio")? {
                    return Err(invalid("unsupported original projection part"));
                }
                Ok(())
            })?;
        } else if equals(kind, "failure")? {
            self.bytes.extend_from_slice(
                maka_agent_facts::tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE.as_bytes(),
            );
        } else {
            return Err(invalid("unsupported original projection kind"));
        }
        self.end(Field::Result, start);
        Ok(())
    }
    fn finish(self, message: &mut Message) -> Result<(), StoreError> {
        message.body = String::from_utf8(self.bytes)
            .map_err(|e| invalid(format!("original document is not UTF-8: {e}")))?;
        message.fields = self.fields;
        Ok(())
    }
}
pub(in crate::recall) fn prepared(
    bytes: &[u8],
    run: RunId,
    key: &ExternalEffectKey,
    message: &mut Message,
) -> Result<(), StoreError> {
    let raw: &RawValue = serde_json::from_slice(bytes)?;
    let [version, execution, original_key, name, input] =
        fields(raw, ["schemaVersion", "execution", "key", "name", "input"])?;
    let [original_run] = fields(required(execution)?, ["runId"])?;
    if serde_json::from_str::<u32>(required(version)?.get())? != SCHEMA_VERSION
        || serde_json::from_str::<RunId>(required(original_run)?.get())? != run
        || serde_json::from_str::<ExternalEffectKey>(required(original_key)?.get())? != *key
    {
        return Err(invalid(
            "original External descriptor identity/schema mismatch",
        ));
    }
    let mut body = Body::default();
    let start = body.begin();
    body.string(required(name)?)?;
    body.end(Field::ToolName, start);
    let start = body.begin();
    body.bytes
        .extend_from_slice(required(input)?.get().as_bytes());
    body.end(Field::Arguments, start);
    body.finish(message)
}
pub(in crate::recall) fn returned(
    bytes: &[u8],
    message: &mut Message,
    resolve_content: &mut dyn FnMut(
        &maka_agent_facts::durable::ContentRef,
    ) -> Result<Vec<u8>, StoreError>,
) -> Result<
    Option<(
        maka_agent_facts::cells::CellId,
        maka_agent_facts::durable::ContentRef,
    )>,
    StoreError,
> {
    let raw: &RawValue = serde_json::from_slice(bytes)?;
    let [kind, projection, diagnostic, output] =
        fields(raw, ["kind", "projection", "diagnostic", "output"])?;
    let kind = required(kind)?;
    let mut body = Body::default();
    let mut completed_cell = None;
    if equals(kind, "output")? {
        body.projection(required(projection)?, output, resolve_content)?;
        if let Some(output) = output {
            let [format, value] = fields(output, ["format", "value"])?;
            if let (Some(format), Some(value)) = (format, value)
                && equals(format, "cell")?
            {
                let [cell, state] = fields(value, ["cell", "state"])?;
                if let (Some(cell), Some(state)) = (cell, state) {
                    let [state_kind, result] = fields(state, ["kind", "result"])?;
                    if let (Some(state_kind), Some(result)) = (state_kind, result)
                        && equals(state_kind, "completed")?
                    {
                        completed_cell = Some((
                            serde_json::from_str(cell.get())?,
                            serde_json::from_str(result.get())?,
                        ));
                    }
                }
            }
        }
    } else if equals(kind, "failure")? {
        let start = body.begin();
        body.string(required(diagnostic)?)?;
        body.end(Field::Result, start);
    } else {
        return Err(invalid("unsupported original External return"));
    }
    body.finish(message)?;
    Ok(completed_cell)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recall::{Message, Role, RowPosition};
    use maka_agent_facts::durable::FactId;
    use maka_agent_facts::external_effects::ExternalReturn;
    use maka_agent_facts::tool_output::{DurableToolProjection, ToolOutput};
    use serde_json::json;

    fn empty_message() -> Message {
        Message {
            fact: FactId::new(),
            message_id: "m-1".into(),
            position: RowPosition {
                source_sequence: 1,
                item_index: 0,
            },
            run: RunId::new(),
            turn_id: "t-1".into(),
            timestamp: 0,
            role: Role::ToolResult,
            body: String::new(),
            attachments: vec![],
            references: vec![],
            fields: vec![],
            origin: None,
        }
    }

    fn field_spans(message: &Message) -> Vec<(Field, usize, usize, bool)> {
        message
            .fields
            .iter()
            .map(|span| (span.field, span.start, span.end, span.internal))
            .collect()
    }

    #[test]
    fn returned_indexes_from_output_json_and_operation_identically_to_inline() {
        let value = json!({"summary": "hello recall", "count": 42});

        let compact = serde_json::to_vec(&ExternalReturn::Output {
            is_error: false,
            projection: DurableToolProjection::Json {
                value: value.clone(),
            },
            output: ToolOutput::Json(value.clone()),
            artifacts: vec![],
            display_budget_chars: None,
        })
        .unwrap();
        let legacy = serde_json::to_vec(&json!({
            "kind": "output",
            "is_error": false,
            "projection": { "kind": "json", "value": value },
            "output": { "format": "json", "value": value }
        }))
        .unwrap();

        let mut no_lookup =
            |_: &maka_agent_facts::durable::ContentRef| -> Result<Vec<u8>, StoreError> {
                Err(invalid("unexpected content lookup"))
            };
        let mut msg_compact = empty_message();
        let mut msg_legacy = empty_message();
        returned(&compact, &mut msg_compact, &mut no_lookup).unwrap();
        returned(&legacy, &mut msg_legacy, &mut no_lookup).unwrap();
        assert_eq!(msg_compact.body, msg_legacy.body);
        assert_eq!(field_spans(&msg_compact), field_spans(&msg_legacy));
        assert!(msg_compact.body.contains("hello recall"));

        let digest = format!("sha256-{}", "a".repeat(64));
        let op_reply = maka_plugin_core::operation::OperationReply {
            reference: maka_plugin_core::operation::RecoveryRef {
                source: maka_plugin_core::deployment::DeploymentRef {
                    state_domain: "b".repeat(64),
                    deployment: uuid::Uuid::new_v4(),
                    revision: 1,
                },
                namespace: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::new_v4()]),
                export: "workspace".into(),
                method: "read".into(),
                operation: uuid::Uuid::new_v4(),
                fingerprint: digest.clone(),
                contract: maka_plugin_core::operation::RecoveryContract {
                    name: "maka.workspace.Read".into(),
                    version: 1,
                    transport: maka_plugin_core::contract::Transport::Remote,
                    digest,
                },
                recovery: maka_plugin_core::operation::RecoveryProtocol::JournalV1,
            },
            receipt: maka_plugin_core::operation::Receipt::Recorded {
                outcome: maka_plugin_core::operation::OperationOutcome::Returned {
                    result: maka_plugin_core::operation::OperationResult::Success {
                        value: value.clone(),
                    },
                },
                cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
            },
        };
        let op_compact = serde_json::to_vec(&ExternalReturn::Output {
            is_error: false,
            projection: DurableToolProjection::Json {
                value: value.clone(),
            },
            output: ToolOutput::Operation(Box::new(op_reply)),
            artifacts: vec![],
            display_budget_chars: None,
        })
        .unwrap();
        let op_wire: serde_json::Value = serde_json::from_slice(&op_compact).unwrap();
        assert_eq!(
            op_wire["projection"],
            json!({"kind": "from_output"}),
            "real ExternalReturn serializer must emit from_output for matching Operation reply"
        );
        let mut msg_op = empty_message();
        returned(&op_compact, &mut msg_op, &mut no_lookup).unwrap();
        assert_eq!(msg_op.body, msg_legacy.body);
        assert_eq!(field_spans(&msg_op), field_spans(&msg_legacy));

        // Text output with matching text projection emits from_output and indexes verbatim.
        let txt_compact = serde_json::to_vec(&ExternalReturn::Output {
            is_error: false,
            projection: DurableToolProjection::Text {
                text: "plain text needle".into(),
            },
            output: ToolOutput::Text("plain text needle".into()),
            artifacts: vec![],
            display_budget_chars: None,
        })
        .unwrap();
        let txt_wire: serde_json::Value = serde_json::from_slice(&txt_compact).unwrap();
        assert_eq!(txt_wire["projection"], json!({"kind": "from_output"}));
        let mut msg_txt = empty_message();
        returned(&txt_compact, &mut msg_txt, &mut no_lookup).unwrap();
        assert_eq!(msg_txt.body, "plain text needle");

        // Stripped Completed cell with from_output resolves via content lookup.
        let cell_id = maka_agent_facts::cells::CellId::new();
        let obs = maka_agent_facts::cells::CellObservation::Completed {
            cell_id,
            content: vec![maka_agent_facts::cells::CellOutput::Text {
                text: "cell output line".into(),
            }],
            result: json!({"ok": true}),
        };
        let obs_bytes = serde_json::to_vec(&obs).unwrap();
        let expected_cell_text =
            maka_agent_facts::tool_output::completed_cell_text_projection(&obs).unwrap();
        let obs_ref = maka_agent_facts::durable::ContentRef {
            digest: maka_agent_facts::artifact::content_digest(&obs_bytes),
            bytes: obs_bytes.len() as u64,
        };
        let cell_stored = maka_agent_facts::external_effects::StoredExternalReturn::from_output(
            &ToolOutput::Cell(Box::new(maka_agent_facts::cells::CellReply {
                cell: cell_id,
                state: maka_agent_facts::cells::CellReplyState::Completed {
                    result: obs_ref.clone(),
                },
                observation: serde_json::to_value(&obs).unwrap(),
            })),
            false,
            &DurableToolProjection::Text {
                text: expected_cell_text.clone(),
            },
            vec![],
            None,
        );
        let cell_wire_bytes = serde_json::to_vec(&cell_stored).unwrap();
        let cell_wire: serde_json::Value = serde_json::from_slice(&cell_wire_bytes).unwrap();
        assert_eq!(cell_wire["projection"], json!({"kind": "from_output"}));
        assert!(cell_wire["output"]["value"].get("observation").is_none());
        let mut msg_cell = empty_message();
        let resolved_cell = returned(&cell_wire_bytes, &mut msg_cell, &mut |r| {
            assert_eq!(r, &obs_ref);
            Ok(obs_bytes.clone())
        })
        .unwrap();
        assert_eq!(resolved_cell, Some((cell_id, obs_ref)));
        assert_eq!(msg_cell.body, expected_cell_text);
    }
}
