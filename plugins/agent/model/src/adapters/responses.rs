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

//! Responses execution, canonical projection, and disposable connection state.
mod adapter;
mod body;
mod budget;
mod decode;
mod lane;
pub(super) mod request;
mod stream;
mod transport;

pub(super) use adapter::Adapter;
use lane::Lane;
use stream::stream;

pub(super) type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error("Responses resource cleanup is unconfirmed")]
    CleanupUnconfirmed,
    #[error("Responses stream ended without completion")]
    Truncated {
        replay_safe: bool,
        retained_output_safe: bool,
    },
    #[error("Responses provider failed: {error:?}")]
    Provider {
        error: Box<maka_provider_protocol::output::ProviderError>,
        observed_output: bool,
        replay_safe: bool,
        retained_output_safe: bool,
    },
    #[error("{0}")]
    Invalid(String),
    /// Network interruption; replay safety belongs to the protocol decoder.
    #[error("{0}")]
    Interrupted(String),
    #[error("{0}")]
    Transport(String),
}

impl From<maka_provider_protocol::responses::Error> for Error {
    fn from(error: maka_provider_protocol::responses::Error) -> Self {
        use maka_provider_protocol::responses::Error as ProtocolError;
        match error {
            ProtocolError::Invalid(message) => Self::Invalid(message),
            ProtocolError::Truncated {
                replay_safe,
                retained_output_safe,
            } => Self::Truncated {
                replay_safe,
                retained_output_safe,
            },
            ProtocolError::Provider {
                error,
                observed_output,
                replay_safe,
                retained_output_safe,
            } => Self::Provider {
                error,
                observed_output,
                replay_safe,
                retained_output_safe,
            },
        }
    }
}
