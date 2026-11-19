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

//! Agent-family wire declarations and persisted selection facts, independent of execution.
pub mod acp;
pub mod contract;
pub mod executor;
pub mod external;
pub mod preset;
pub mod session;
pub use contract::{Configuration, ModelSelection, configuration_schema, contract};
pub const IMPLEMENTATION: &str = "maka.agent.api";
pub const EXPORT: &str = "agent";

/// Maximum bytes in one image stream frame.
pub const IMAGE_CHUNK_BYTES: usize = 32 * 1024;

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        configuration_schema(),
        [(EXPORT, contract())],
    )
}
