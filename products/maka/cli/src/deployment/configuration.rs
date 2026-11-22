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

use clap::Args;
use maka_host_runtime::{DirectoryRootSpec, HostError};

#[derive(Args)]
pub(super) struct Directories {
    /// Publish an absolute project directory as {"label":"Projects","path":"/..."}.
    #[arg(long = "project-root-json", value_parser = parse_root, conflicts_with_all = ["no_project_roots", "default_project_roots"])]
    roots: Vec<DirectoryRootSpec>,
    /// Publish no project directories.
    #[arg(long, conflicts_with = "default_project_roots")]
    no_project_roots: bool,
    /// Restore the account's default project directory.
    #[arg(long)]
    default_project_roots: bool,
}

impl Directories {
    pub(super) fn is_specified(&self) -> bool {
        self.default_project_roots || self.no_project_roots || !self.roots.is_empty()
    }

    pub async fn resolve(
        self,
        current: Option<Vec<DirectoryRootSpec>>,
    ) -> Result<Option<Vec<DirectoryRootSpec>>, HostError> {
        let selected = if self.default_project_roots {
            None
        } else if self.no_project_roots || !self.roots.is_empty() {
            Some(self.roots)
        } else {
            current
        };
        // Reuse the Host's label, duplicate and containment rules. Existing
        // deployment reads deliberately do not require old paths to exist:
        // this command must be able to replace an unavailable directory.
        tokio::task::spawn_blocking(move || selected.map(DirectoryRootSpec::normalize).transpose())
            .await?
    }
}

fn parse_root(value: &str) -> Result<DirectoryRootSpec, String> {
    if value.len() > 8192 {
        return Err("project directory declaration exceeds 8192 bytes".into());
    }
    serde_json::from_str(value).map_err(|error| error.to_string())
}
