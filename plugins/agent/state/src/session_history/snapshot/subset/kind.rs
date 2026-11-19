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

use maka_event_log::StoreError;
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, Visitor};
use std::{
    fmt,
    io::{BufReader, Read},
};

// Only the tag is needed to trim trailing title diagnostics. Stop there rather
// than decoding the next (potentially large) model or tool observation body.
pub(super) fn read(reader: &mut dyn Read) -> Result<String, StoreError> {
    let mut found = None;
    let mut json = serde_json::Deserializer::from_reader(BufReader::new(reader));
    let result = Tag {
        found: &mut found,
        level: Level::Record,
    }
    .deserialize(&mut json);
    match found {
        Some(kind) => Ok(kind),
        None => {
            result?;
            Err(StoreError::InvalidTransition(
                "snapshot fact has no original kind metadata".into(),
            ))
        }
    }
}
enum Level {
    Record,
    Fact,
}
struct Tag<'a> {
    found: &'a mut Option<String>,
    level: Level,
}
impl<'de> DeserializeSeed<'de> for Tag<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, json: D) -> Result<(), D::Error> {
        json.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for Tag<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("original recorded fact kind metadata")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<(), M::Error> {
        while let Some(key) = map.next_key::<String>()? {
            match (&self.level, key.as_str()) {
                (Level::Record, "fact") => map.next_value_seed(Tag {
                    found: &mut *self.found,
                    level: Level::Fact,
                })?,
                (Level::Fact, "kind") => {
                    *self.found = Some(map.next_value()?);
                    return Err(serde::de::Error::custom("original fact kind selected"));
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Err(serde::de::Error::missing_field("fact.kind"))
    }
}
