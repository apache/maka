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

//! Permission policy and interaction settlement using native-issued Run capabilities.
pub mod computer;
pub mod executor;
pub mod interaction_wait;
pub mod permissions;
pub mod publication;
pub mod setup;
use std::time::{SystemTime, UNIX_EPOCH};
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as u64
}

/// Data selection only; service grants remain independent of this prefix.
pub fn session_namespace(
    domain: &str,
    deployment: uuid::Uuid,
    instance: &maka_plugin_core::composition::InstanceId,
) -> String {
    maka_host_runtime::storage::instance_prefix(domain, deployment, instance)
}
