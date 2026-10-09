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

//! Small serde helpers for wire shapes that plain derives cannot express.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// Deserializes a field that is present on the wire, keeping an explicit
/// `null` as `Some(Value::Null)`. Pair it with `#[serde(default)]` so an
/// absent field stays `None`, and with `skip_serializing_if = "Option::is_none"`
/// so encoding reproduces exactly what was read.
pub(crate) fn present<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// `skip_serializing_if` predicate for `?: true` flags modeled as `bool`.
pub(crate) fn is_false(value: &bool) -> bool {
    !*value
}

/// A field that is absent, explicitly `null`, or a value: TypeScript's
/// `field?: T | null`, for example `thinkingLevel` in `SessionCreateInput`.
///
/// Use with `#[serde(default, skip_serializing_if = "Nullable::is_absent")]`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Nullable<T> {
    /// The field is not sent.
    #[default]
    Absent,
    /// The field is sent as `null`.
    Null,
    /// The field is sent with a value.
    Value(T),
}

impl<T> Nullable<T> {
    /// Whether the field is omitted from the wire.
    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }

    /// The value, if one is set.
    pub fn as_value(&self) -> Option<&T> {
        match self {
            Self::Value(value) => Some(value),
            Self::Absent | Self::Null => None,
        }
    }
}

impl<T: Serialize> Serialize for Nullable<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            // `skip_serializing_if` normally removes this case.
            Self::Absent | Self::Null => serializer.serialize_none(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Nullable<T> {
    /// Only called when the field is present; `#[serde(default)]` supplies
    /// [`Nullable::Absent`] otherwise.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Sample {
        #[serde(default, skip_serializing_if = "Nullable::is_absent")]
        level: Nullable<u32>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        args: Option<Value>,
    }

    #[test]
    fn nullable_distinguishes_absent_null_and_value() {
        for (wire, level) in [
            (json!({}), Nullable::Absent),
            (json!({"level": null}), Nullable::Null),
            (json!({"level": 3}), Nullable::Value(3)),
        ] {
            let decoded: Sample = serde_json::from_value(wire.clone()).expect("decode");
            assert_eq!(decoded.level, level);
            assert_eq!(serde_json::to_value(&decoded).expect("encode"), wire);
        }
    }

    #[test]
    fn present_keeps_an_explicit_null() {
        let decoded: Sample = serde_json::from_value(json!({"args": null})).expect("decode");
        assert_eq!(decoded.args, Some(Value::Null));
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), json!({"args": null}));
        let absent: Sample = serde_json::from_value(json!({})).expect("decode");
        assert_eq!(absent.args, None);
    }
}
