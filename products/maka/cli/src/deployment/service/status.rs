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

use super::{Deployment, HostError, platform};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Observation {
    OnDemand,
    Missing,
    Present {
        state: State,
        enabled: Option<bool>,
        pid: Option<NonZeroU32>,
        #[serde(rename = "lastResult")]
        last_result: Option<i64>,
    },
    Unavailable {
        message: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum State {
    Stopped,
    #[cfg(any(target_os = "linux", windows))]
    Starting,
    Running,
    #[cfg(target_os = "linux")]
    Stopping,
    #[cfg(unix)]
    Failed,
}

pub(crate) async fn observe(deployment: Deployment) -> Observation {
    if deployment.mode == super::super::Mode::OnDemand {
        return Observation::OnDemand;
    }
    let result = tokio::task::spawn_blocking(move || {
        platform::Service::new(&deployment, super::Role::Host)?.observe()
    })
    .await
    .map_err(HostError::from)
    .and_then(|result| result);
    match result {
        Ok(observed) => observed,
        Err(error) => Observation::Unavailable {
            message: error.to_string().chars().take(2048).collect(),
        },
    }
}
