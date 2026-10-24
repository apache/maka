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

//! Reconcile abandoned execution facts before any Root workers or activations.

use crate::HostError;
use maka_event_log::root_store::RootStore;

/// Requires the original exclusive Root owner and no live execution workers.
/// This settles abandoned facts without replaying model, tool or shell effects.
/// Call once at Root startup, never from a plugin activation or live repair.
/// On failure, wait for the original SQL owner to close before returning Err.
pub async fn recover(log: &RootStore) -> Result<(), HostError> {
    let result = async {
        log.recover_invocations().await?;
        let recovered_at = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis(),
        )?;
        log.recover_shell_runs(recovered_at).await?;
        log.recover_host_effects().await?;
        log.recover_auxiliary_models().await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        log.drain().await;
    }
    result
}
