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

//! Explicit updates retain the selected Host source, identities and grants.
use super::HostError;
use clap::Args;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Args)]
pub(crate) struct Update {
    /// Business Host Root (default: ~/.maka/application/host). Stop its Host first.
    #[arg(long)]
    root: Option<PathBuf>,
    /// Apply the previewed selected-package update.
    #[arg(long)]
    apply: bool,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Scope {
    #[default]
    SelectedPackages,
    Initialization,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Outcome {
    pub(super) scope: Scope,
    pub(super) changed: bool,
    pub(super) applied: bool,
    pub(super) changes: Vec<String>,
}
impl Update {
    pub(crate) async fn run(self) -> Result<(), HostError> {
        let root = super::root_path(self.root)?;
        let outcome = if self.apply {
            let store = super::super::open_store(root).await?;
            let result = super::headless::update::synchronize(&store, true).await;
            store.drain().await;
            result?
        } else {
            let store = super::super::open_application_inspection(root).await?;
            let result = super::headless::update::preview(&store).await;
            store.drain().await;
            result?
        };
        println!("{}", serde_json::to_string(&outcome)?);
        Ok(())
    }
}
