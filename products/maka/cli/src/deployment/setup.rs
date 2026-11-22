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

use super::{Deployment, ExistingDeployment, Install, activation};
use crate::{access, host_client::LiveHost};
use clap::Args;
use maka_host_runtime::HostError;
use serde::Serialize;

#[derive(Args)]
pub(crate) struct Setup {
    #[command(flatten)]
    installation: Install,
    /// Prepare a short-lived credential for this remote Desktop principal.
    #[arg(long)]
    principal: Option<String>,
    /// Reserve the result line so an interactive launcher can hide pairing secrets.
    #[arg(long)]
    framed: bool,
}

// Contains a secret when pairing; never log or derive Debug.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    deployment: Deployment,
    host: LiveHost,
    #[serde(skip_serializing_if = "Option::is_none")]
    pairing: Option<access::Pairing>,
}

impl Setup {
    pub async fn run(self) -> Result<(), HostError> {
        let pairing_input = self.principal.map(access::pairing_input).transpose()?;
        let (deployment, lease) = self.installation.install(ExistingDeployment::Reuse).await?;
        // Keep the same executor lease through activation and credential delivery.
        // A failed response does not undo an installation or grant reinstall rights.
        let (mut client, host) = activation::connect_or_launch(&deployment, lease.clone()).await?;
        let pairing = match pairing_input {
            Some(input) => Some(access::prepare(&mut client, input).await?),
            None => None,
        };
        lease.validate()?;
        let receipt = serde_json::to_string(&Receipt {
            deployment,
            host,
            pairing,
        })?;
        let prefix = if self.framed {
            "__MAKA_NATIVE_HOST_SETUP__"
        } else {
            ""
        };
        println!("{prefix}{receipt}");
        drop(client);
        Ok(())
    }
}
