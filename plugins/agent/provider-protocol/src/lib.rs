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

//! Provider wire protocols, independent of networking and the execution host.
//!
//! Native adapters and the upstream conformance harness call this same code.
//! The harness supplies JavaScript representation and HTTP capabilities only.

mod field;
pub mod input;
pub use field::Field;
pub mod anthropic;
pub mod chat_completions;
pub mod output;
pub mod responses;
pub mod sse;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Error {
    InvalidConfiguration { argument: String, message: String },
    InvalidResponse { message: String, data: Value },
    Unsupported { functionality: String },
    JsonParse { text: String, message: String },
    MissingReference { provider: String, reference: Value },
    InvalidArgument { field: String, value: Value },
}

impl Error {
    pub fn invalid(message: impl Into<String>, data: Value) -> Self {
        Self::InvalidResponse {
            message: message.into(),
            data,
        }
    }

    pub fn unsupported(functionality: impl Into<String>) -> Self {
        Self::Unsupported {
            functionality: functionality.into(),
        }
    }

    pub fn json(text: &str, error: serde_json::Error) -> Self {
        Self::JsonParse {
            text: text.into(),
            message: error.to_string(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration { message, .. }
            | Self::InvalidResponse { message, .. }
            | Self::JsonParse { message, .. } => f.write_str(message),
            Self::Unsupported { functionality } => {
                write!(f, "Unsupported functionality: {functionality}")
            }
            Self::MissingReference { provider, .. } => {
                write!(f, "No reference for provider {provider}")
            }
            Self::InvalidArgument { field, .. } => write!(f, "Invalid provider argument: {field}"),
        }
    }
}
impl std::error::Error for Error {}

pub mod json_stream;
