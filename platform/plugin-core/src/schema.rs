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

//! Shared schema data. Runtime inputs and configuration values remain owned JSON.
use std::{
    borrow::Cow,
    collections::{HashMap, hash_map::RandomState},
    hash::BuildHasher,
    sync::{Arc, Mutex, OnceLock, Weak},
};

use schemars::{JsonSchema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Immutable JSON schema storage shared by declarations, plans and live contracts.
/// Construction preserves JSON exactly; declaration admission still validates it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Schema(Arc<Value>);

impl From<Value> for Schema {
    fn from(value: Value) -> Self {
        static SCHEMAS: OnceLock<SchemaPool> = OnceLock::new();
        SCHEMAS.get_or_init(SchemaPool::default).intern(value)
    }
}
impl<'de> Deserialize<'de> for Schema {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Value::deserialize(deserializer).map(Self::from)
    }
}

// Independently loaded packages repeat schemas. The pool retains only bounded
// weak metadata; admission and actual value validation remain at their boundaries.
#[derive(Default)]
struct SchemaPool {
    hasher: RandomState,
    entries: Mutex<HashMap<u64, Weak<Value>>>,
}
const MAX_SHARED_SCHEMAS: usize = 4096;

impl SchemaPool {
    fn intern(&self, value: Value) -> Schema {
        let hash = self.hasher.hash_one(&value);
        self.intern_hashed(value, hash)
    }

    fn intern_hashed(&self, value: Value, hash: u64) -> Schema {
        let mut entries = self.entries.lock().expect("schema pool");
        let candidate = entries.get(&hash).and_then(Weak::upgrade);
        if let Some(candidate) = candidate
            .as_ref()
            .filter(|c| same_representation(c, &value))
        {
            let shared = candidate.clone();
            drop(entries);
            // The incoming duplicate tree is dropped after releasing the mutex.
            return Schema(shared);
        }
        if entries.len() >= MAX_SHARED_SCHEMAS && !entries.contains_key(&hash) {
            entries.retain(|_, value| value.strong_count() != 0);
            if entries.len() >= MAX_SHARED_SCHEMAS {
                entries.clear();
            }
        }
        let shared = Arc::new(value);
        // An unequal hash collision merely replaces a reuse opportunity.
        entries.insert(hash, Arc::downgrade(&shared));
        drop(entries);
        // An upgraded collision candidate can be its tree's last strong owner.
        drop(candidate);
        Schema(shared)
    }
}

// Depending on serde_json's features, Value equality can ignore object ordering
// or the sign of float zero. Sharing must also preserve serialized representation.
fn same_representation(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a == b && a.to_string() == b.to_string(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_representation(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|((ka, a), (kb, b))| ka == kb && same_representation(a, b))
        }
        _ => left == right,
    }
}
impl From<schemars::Schema> for Schema {
    fn from(value: schemars::Schema) -> Self {
        Self::from(Value::from(value))
    }
}
impl AsRef<Value> for Schema {
    fn as_ref(&self) -> &Value {
        &self.0
    }
}
impl std::borrow::Borrow<Value> for Schema {
    fn borrow(&self) -> &Value {
        self.as_ref()
    }
}
impl std::ops::Deref for Schema {
    type Target = Value;
    fn deref(&self) -> &Value {
        self.as_ref()
    }
}
impl JsonSchema for Schema {
    fn schema_name() -> Cow<'static, str> {
        Value::schema_name()
    }
    fn schema_id() -> Cow<'static, str> {
        Value::schema_id()
    }
    fn inline_schema() -> bool {
        Value::inline_schema()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> schemars::Schema {
        Value::json_schema(generator)
    }
}
