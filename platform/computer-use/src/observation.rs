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

use maka_agent_facts::tools::ToolError;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

// A bounded observation window, not a promise that application work is done.
// Browser rendering and native application message loops have different
// measured settling budgets. Continuous animation cannot extend either wait.
pub(crate) const BROWSER_SETTLE: Duration = Duration::from_millis(200);
pub(crate) const NATIVE_SETTLE: Duration = Duration::from_millis(400);

pub(crate) async fn settle(
    budget: Duration,
    cancellation: &CancellationToken,
) -> Result<(), ToolError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(ToolError::Failed("Computer Use observation cancelled".into())),
        _ = tokio::time::sleep(budget) => Ok(()),
    }
}
