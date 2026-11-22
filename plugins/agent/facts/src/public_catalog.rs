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

//! Validated opaque public-catalog input, not a wire model or publication authority.

use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, SeqAccess, Visitor},
};
use serde_json::{Value, value::RawValue};
use std::{collections::BTreeMap, fmt, sync::Arc};

/// Shared immutable JSON text with the same acceptance boundary as `Value`.
#[derive(Clone, Debug)]
pub struct PublicCatalogBody(Arc<RawValue>);

impl PublicCatalogBody {
    /// Validate every value, including unknown and overwritten object members.
    pub fn from_json(json: String) -> Result<Self, serde_json::Error> {
        validate_json(&json)?;
        Ok(Self(Arc::from(RawValue::from_string(json)?)))
    }

    /// Borrow the complete JSON value without constructing an expanded tree.
    pub fn as_raw(&self) -> &RawValue {
        &self.0
    }

    /// Compare all JSON content with `Value` semantics, including unknown fields.
    pub fn same_content(&self, other: &Self) -> Result<bool, serde_json::Error> {
        equal(self.as_raw(), other.as_raw())
    }
}

/// Visit every JSON occurrence without building a tree, including ignored or
/// overwritten members. Preserve the deserializer's numeric feature policy,
/// string validation, recursion budget and complete-input checks; this does not
/// reinterpret user objects as serde_json's private number representation.
pub fn validate_json(json: &str) -> Result<(), serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_str(json);
    Validated::deserialize(&mut deserializer)?;
    deserializer.end()
}

// RawValue/IgnoredAny alone skip numeric conversion, surrogate validation and
// the normal recursion budget. deserialize_any must visit every occurrence.
struct Validated;
impl<'de> Deserialize<'de> for Validated {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ValidationVisitor)
    }
}
struct ValidationVisitor;
impl<'de> Visitor<'de> for ValidationVisitor {
    type Value = Validated;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }
    fn visit_unit<E>(self) -> Result<Validated, E> {
        Ok(Validated)
    }
    fn visit_bool<E>(self, _: bool) -> Result<Validated, E> {
        Ok(Validated)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Validated, E> {
        Ok(Validated)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Validated, E> {
        Ok(Validated)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Validated, E> {
        Ok(Validated)
    }
    fn visit_str<E>(self, _: &str) -> Result<Validated, E> {
        Ok(Validated)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut values: A) -> Result<Validated, A::Error> {
        while values.next_element::<Validated>()?.is_some() {}
        Ok(Validated)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut values: A) -> Result<Validated, A::Error> {
        while values.next_key::<Validated>()?.is_some() {
            values.next_value::<Validated>()?;
        }
        Ok(Validated)
    }
}

fn equal(left: &RawValue, right: &RawValue) -> Result<bool, serde_json::Error> {
    if left.get() == right.get() {
        return Ok(true);
    }
    let kind = |raw: &RawValue| raw.get().trim_start().as_bytes().first().copied();
    match (kind(left), kind(right)) {
        (Some(b'{'), Some(b'{')) => {
            // Decoded keys replace earlier aliases before recursive comparison.
            let a: BTreeMap<String, &RawValue> = serde_json::from_str(left.get())?;
            let b: BTreeMap<String, &RawValue> = serde_json::from_str(right.get())?;
            if a.len() != b.len() {
                return Ok(false);
            }
            for (key, value) in a {
                let Some(other) = b.get(&key) else {
                    return Ok(false);
                };
                if !equal(value, other)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        (Some(b'['), Some(b'[')) => {
            let a: Vec<&RawValue> = serde_json::from_str(left.get())?;
            let b: Vec<&RawValue> = serde_json::from_str(right.get())?;
            if a.len() != b.len() {
                return Ok(false);
            }
            for (value, other) in a.into_iter().zip(b) {
                if !equal(value, other)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        (Some(b'{' | b'['), _) | (_, Some(b'{' | b'[')) => Ok(false),
        _ => Ok(serde_json::from_str::<Value>(left.get())?
            == serde_json::from_str::<Value>(right.get())?),
    }
}

#[cfg(test)]
mod tests;
