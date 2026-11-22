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

//! One-shot reads of an explicitly authorized, trusted Host pathname. This is
//! not a captured ReadDirectory and does not resist malicious same-user path races.
pub mod query;

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Read {
    pub path: String,
    pub queries: Vec<Query>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub sql: String,
    #[serde(default)]
    pub parameters: Vec<Cell>,
}
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Cell {
    Null,
    Integer(#[serde(with = "integer")] i64),
    Real(f64),
    Text(String),
    Blob(#[serde(with = "blob")] Vec<u8>),
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database read authority is unavailable")]
    Denied,
    #[error("database read cancelled")]
    Cancelled,
    #[error("database read capacity is busy")]
    Busy,
    #[error("database was not found")]
    NotFound,
    #[error("invalid database read: {0}")]
    Invalid(String),
    #[error("database read failed: {0}")]
    Unavailable(String),
}
impl Read {
    pub fn validate(&self) -> Result<(), Error> {
        if self.path.is_empty()
            || self.path.contains('\0')
            || !std::path::Path::new(&self.path).is_absolute()
            || self.queries.is_empty()
            || self.queries.iter().any(|query| {
                query.sql.trim().is_empty()
                    || query.sql.contains('\0')
                    || query
                        .parameters
                        .iter()
                        .any(|value| matches!(value, Cell::Real(number) if !number.is_finite()))
            })
        {
            return Err(Error::Invalid("invalid path or queries".into()));
        }
        Ok(())
    }
}
mod integer {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}
mod blob {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(value))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        STANDARD
            .decode(String::deserialize(deserializer)?)
            .map_err(serde::de::Error::custom)
    }
}
