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

use super::BuildUi;
use maka_host_runtime::HostError;

impl BuildUi {
    #[cfg(not(target_os = "macos"))]
    pub(super) async fn run(self) -> Result<(), HostError> {
        let manifest = tokio::task::spawn_blocking(move || {
            maka_ui_build::compile(&self.entry, &self.output, self.asset_root.as_deref())
        })
        .await??;
        println!("{}", serde_json::to_string_pretty(&manifest)?);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub(super) async fn run(self) -> Result<(), HostError> {
        crate::desktop::exec_shell(
            "__maka-build-ui",
            &[
                ("--entry", Some(self.entry.as_os_str())),
                ("--output", Some(self.output.as_os_str())),
                (
                    "--asset-root",
                    self.asset_root.as_ref().map(|root| root.as_os_str()),
                ),
            ],
            &[],
        )
    }
}
