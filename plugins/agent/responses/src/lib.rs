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

//! Native Responses protocol and disposable connection state.
mod body;
mod budget;
mod replay;
mod stream;
pub use stream::stream;
mod lane;
pub use lane::Lane;
mod adapter;
pub mod decode;
pub use adapter::Adapter;
pub mod request;
pub mod sse;
pub mod transport;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Responses resource cleanup is unconfirmed")]
    CleanupUnconfirmed,
    #[error("Responses stream ended without completion")]
    Truncated {
        replay_safe: bool,
        retained_output_safe: bool,
    },
    #[error("Responses provider failed: {message}")]
    Provider {
        code: Option<String>,
        message: String,
        observed_output: bool,
        replay_safe: bool,
        retained_output_safe: bool,
    },
    #[error("{0}")]
    Invalid(String),
    /// Network interruption; replay safety belongs to the shared decoder.
    #[error("{0}")]
    Interrupted(String),
    #[error("{0}")]
    Transport(String),
}
