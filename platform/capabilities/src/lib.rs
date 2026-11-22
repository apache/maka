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

//! Scoped capability ownership and native resource ports.
pub mod authorization;
pub mod background;
pub mod call;
pub mod client_capability;
pub mod computer;
pub mod credentials;
pub mod filesystem;
pub mod http;
pub mod model_preparation;
pub mod permissions;
pub mod process;
pub mod revision;
pub mod storage;
pub mod terminal;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("capability scope is retired")]
    Retired,
    #[error("invalid capability or package data: {0}")]
    Invalid(String),
}

pub fn name(value: &str) -> Result<(), Error> {
    if value.is_empty() || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(Error::Invalid(format!("invalid identifier: {value:?}")));
    }
    Ok(())
}
