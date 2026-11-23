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

use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::Value;

const MAX_STATE_BYTES: usize = 65_536;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptPayload {
    #[serde(
        default,
        deserialize_with = "summary",
        skip_serializing_if = "Option::is_none"
    )]
    pub summary: Option<String>,
    #[serde(
        default,
        deserialize_with = "data",
        skip_serializing_if = "Option::is_none"
    )]
    pub data: Option<Value>,
    #[serde(
        default,
        deserialize_with = "dedupe_key",
        skip_serializing_if = "Option::is_none"
    )]
    pub dedupe_key: Option<String>,
}

fn summary<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let text =
        String::deserialize(d).map_err(|e| de::Error::custom(format!("invalid summary ({e})")))?;
    let text = text.trim();
    if text.len() > 4096 {
        return Err(de::Error::custom("summary exceeds 4096 UTF-8 bytes"));
    }
    Ok((!text.is_empty()).then(|| text.to_owned()))
}

fn data<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    let mut value = Value::deserialize(d)?;
    if value.to_string().len() > 16_384 {
        return Err(de::Error::custom("data exceeds 16384 JSON bytes"));
    }
    value.sort_all_objects();
    Ok(Some(value))
}

fn checked_key<E: de::Error>(key: String) -> Result<String, E> {
    let key = key.trim();
    if key.is_empty() || key.len() > 256 {
        return Err(de::Error::custom(
            "dedupeKey must contain 1 to 256 UTF-8 bytes",
        ));
    }
    Ok(key.to_owned())
}

fn dedupe_key<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let key = String::deserialize(d)
        .map_err(|e| de::Error::custom(format!("invalid dedupeKey ({e})")))?;
    checked_key(key).map(Some)
}

pub(super) fn stored_key<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)?
        .map(checked_key)
        .transpose()
}

pub fn compact_script_state(value: &Value) -> Result<String, &'static str> {
    let json = value.to_string();
    if json.len() > MAX_STATE_BYTES {
        return Err("state exceeds 65536 JSON bytes");
    }
    Ok(json)
}

pub(super) fn stored_state<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let Some(state) = Option::<String>::deserialize(d)? else {
        return Ok(None);
    };
    if state.len() > MAX_STATE_BYTES {
        return Err(de::Error::custom("state exceeds 65536 JSON bytes"));
    }
    serde_json::from_str::<&serde_json::value::RawValue>(&state).map_err(de::Error::custom)?;
    Ok(Some(state))
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum StateUpdate {
    #[default]
    Unchanged,
    Set(String),
    Clear,
}

impl<'de> Deserialize<'de> for StateUpdate {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match Option::<Value>::deserialize(d)? {
            None => Ok(Self::Clear),
            Some(value) => compact_script_state(&value)
                .map(Self::Set)
                .map_err(de::Error::custom),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScriptOutcome {
    pub triggered: bool,
    pub dedupe_key: Option<String>,
    pub payload: Option<ScriptPayload>,
    pub state_update: StateUpdate,
}

impl From<bool> for ScriptOutcome {
    fn from(triggered: bool) -> Self {
        Self {
            triggered,
            ..Self::default()
        }
    }
}

impl<'de> Deserialize<'de> for ScriptOutcome {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Output {
            trigger: bool,
            #[serde(default, deserialize_with = "dedupe_key")]
            dedupe_key: Option<String>,
            #[serde(default, deserialize_with = "summary")]
            summary: Option<String>,
            #[serde(default, deserialize_with = "data")]
            data: Option<Value>,
            #[serde(default)]
            state: StateUpdate,
        }

        let output = Output::deserialize(d)?;
        let payload = ScriptPayload {
            summary: output.summary,
            data: output.data,
            dedupe_key: output.dedupe_key.clone(),
        };
        Ok(Self {
            triggered: output.trigger,
            dedupe_key: output.dedupe_key,
            payload: (payload != ScriptPayload::default()).then_some(payload),
            state_update: output.state,
        })
    }
}
