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
fn required<'a>(raw: Option<&'a RawValue>) -> Result<&'a RawValue, StoreError> {
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
    fn projection(&mut self, raw: &RawValue) -> Result<(), StoreError> {
        let [kind, string, value, parts] = fields(raw, ["kind", "text", "value", "parts"])?;
        let kind = required(kind)?;
        let start = self.begin();
        if equals(kind, "text")? {
            self.string(required(string)?)?;
        } else if equals(kind, "json")? {
            self.json(required(value)?, start)?;
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
pub(in crate::recall) fn returned(bytes: &[u8], message: &mut Message) -> Result<(), StoreError> {
    let raw: &RawValue = serde_json::from_slice(bytes)?;
    let [kind, projection, diagnostic] = fields(raw, ["kind", "projection", "diagnostic"])?;
    let kind = required(kind)?;
    let mut body = Body::default();
    if equals(kind, "output")? {
        body.projection(required(projection)?)?;
    } else if equals(kind, "failure")? {
        let start = body.begin();
        body.string(required(diagnostic)?)?;
        body.end(Field::Result, start);
    } else {
        return Err(invalid("unsupported original External return"));
    }
    body.finish(message)
}
