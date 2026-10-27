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

#[path = "../../build/ui.rs"]
mod bundle;

use std::path::PathBuf;

use clap::Args;
use maka_host_runtime::HostError;

#[derive(Args)]
pub(crate) struct BuildUi {
    /// The plugin's NSH TSX or TypeScript entry module.
    #[arg(long, value_name = "FILE")]
    entry: PathBuf,
    /// Directory for the compiled module, assets and manifest.json.
    #[arg(long, value_name = "DIRECTORY")]
    output: PathBuf,
}

impl BuildUi {
    pub(super) async fn run(self) -> Result<(), HostError> {
        let manifest =
            tokio::task::spawn_blocking(move || bundle::compile(&self.entry, &self.output))
                .await??;
        println!("{}", serde_json::to_string_pretty(&manifest)?);
        Ok(())
    }
}
