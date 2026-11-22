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

//! Append-only model text with immutable snapshots and plain-string serialization.

use ropey::{Rope, RopeSlice};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use std::{borrow::Cow, fmt, ops::Range};

/// Immutable text whose clones share storage without copying the complete body.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextBody(Rope);

impl TextBody {
    /// The logical UTF-8 length, independent of storage chunk boundaries.
    pub fn len_bytes(&self) -> usize {
        self.0.len_bytes()
    }

    /// Whether the logical body contains no text.
    pub fn is_empty(&self) -> bool {
        self.0.len_bytes() == 0
    }

    /// Borrow UTF-8 chunks without flattening the body.
    pub fn chunks(&self) -> impl Iterator<Item = &str> {
        self.0.chunks()
    }

    /// Insert text into a new snapshot at an exact UTF-8 boundary.
    pub fn inserted(&self, byte: usize, text: &str) -> Option<Self> {
        self.0.get_byte_slice(byte..byte)?;
        let mut body = self.0.clone();
        body.insert(body.byte_to_char(byte), text);
        Some(Self(body))
    }

    /// Return a borrowed byte range, or None for invalid UTF-8 boundaries or bounds.
    pub fn slice(&self, bytes: Range<usize>) -> Option<TextSlice<'_>> {
        self.0.get_byte_slice(bytes).map(TextSlice)
    }
}

impl From<&str> for TextBody {
    fn from(text: &str) -> Self {
        Self(Rope::from_str(text))
    }
}

impl From<String> for TextBody {
    fn from(text: String) -> Self {
        Self::from(text.as_str())
    }
}

impl fmt::Display for TextBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, formatter)
    }
}

impl Serialize for TextBody {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // serde_json streams Display fragments into one escaped JSON string.
        serializer.collect_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for TextBody {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TextVisitor;
        impl<'de> de::Visitor<'de> for TextVisitor {
            type Value = TextBody;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a string")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<TextBody, E> {
                Ok(TextBody(Rope::from_str(value)))
            }
        }
        deserializer.deserialize_str(TextVisitor)
    }
}

impl schemars::JsonSchema for TextBody {
    fn inline_schema() -> bool {
        <String as schemars::JsonSchema>::inline_schema()
    }

    fn schema_name() -> Cow<'static, str> {
        <String as schemars::JsonSchema>::schema_name()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        <String as schemars::JsonSchema>::json_schema(generator)
    }
}

/// A borrowed UTF-8 slice of an immutable model body.
#[derive(Clone, Copy, Debug)]
pub struct TextSlice<'a>(RopeSlice<'a>);

impl TextSlice<'_> {
    /// The logical UTF-8 length of this selected range.
    pub fn len_bytes(&self) -> usize {
        self.0.len_bytes()
    }

    /// Whether the selected range contains no text.
    pub fn is_empty(&self) -> bool {
        self.0.len_bytes() == 0
    }

    /// Borrow UTF-8 chunks clipped to this slice's boundaries.
    pub fn chunks(&self) -> impl Iterator<Item = &str> {
        self.0.chunks()
    }
}

impl fmt::Display for TextSlice<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, formatter)
    }
}

/// The assembly owns mutation; readers only receive immutable body snapshots.
#[derive(Debug, Default)]
pub(crate) struct TextBuilder(Rope);

impl TextBuilder {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn push(&mut self, text: &str) {
        self.0.insert(self.0.len_chars(), text);
    }

    /// Capture the current text in O(1), independently of subsequent appends.
    pub(crate) fn snapshot(&self) -> TextBody {
        TextBody(self.0.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_snapshots_survive_appends_and_round_trip_as_json_strings() {
        let original = "中🙂\"\\\n\0".repeat(600);
        let mut writer = TextBuilder::new();
        writer.push(&original);
        let snapshot = writer.snapshot();
        writer.push("尾🦀\r\t");
        let appended = writer.snapshot();
        assert_eq!(snapshot.chunks().collect::<String>(), original);
        assert_eq!(appended.to_string(), format!("{original}尾🦀\r\t"));
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert_eq!(serde_json::from_str::<String>(&encoded).unwrap(), original);
        let restored: TextBody = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored, snapshot);
        assert_eq!(serde_json::to_string(&restored).unwrap(), encoded);
        let leading = snapshot.slice(0.."中🙂".len()).unwrap();
        assert_eq!(leading.chunks().collect::<String>(), "中🙂");
        assert_eq!(leading.len_bytes(), "中🙂".len());
        assert!(snapshot.slice(0..1).is_none());
        assert!(snapshot.slice(0..snapshot.len_bytes() + 1).is_none());
    }
}
