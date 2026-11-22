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

use crate::{args::Root, host_client::HostClient};
use clap::{Args, Subcommand};
use maka_host_runtime::HostError;
pub(super) use maka_host_runtime::application::host::Pairing;

#[derive(Subcommand)]
pub(super) enum Access {
    /// Print short-lived remote application pairing JSON, including its secret credential.
    Prepare(Prepare),
    /// Revoke a credential and disconnect its remote clients.
    Revoke(Revoke),
}

#[derive(Args)]
pub(super) struct Prepare {
    #[command(flatten)]
    root: Root,
    #[arg(long)]
    principal: String,
}

#[derive(Args)]
pub(super) struct Revoke {
    #[command(flatten)]
    root: Root,
    #[arg(long)]
    credential_id: String,
}

impl Access {
    pub async fn run(self) -> Result<(), HostError> {
        match self {
            Self::Prepare(args) => args.run().await,
            Self::Revoke(args) => args.run().await,
        }
    }
}
impl Prepare {
    async fn run(self) -> Result<(), HostError> {
        let principal = pairing_input(self.principal)?;
        let mut client = HostClient::connect(&self.root.root, None).await?;
        println!(
            "{}",
            serde_json::to_string(&prepare(&mut client, principal).await?)?
        );
        Ok(())
    }
}
pub(super) fn pairing_input(principal: String) -> Result<String, HostError> {
    if principal.is_empty()
        || principal.len() > 128
        || !principal
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
    {
        return Err("principal must contain 1–128 ASCII letters, digits, or _ . : -".into());
    }
    Ok(principal)
}
pub(super) async fn prepare(
    client: &mut HostClient,
    principal: String,
) -> Result<Pairing, HostError> {
    client.prepare_access(principal).await
}
impl Revoke {
    async fn run(self) -> Result<(), HostError> {
        let client = HostClient::connect(&self.root.root, None).await?;
        println!(
            "{}",
            serde_json::json!({"revoked": client.revoke_access(self.credential_id).await?})
        );
        Ok(())
    }
}
