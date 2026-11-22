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

use super::{RootId, directory, store};
use clap::Args;
use maka_host_runtime::HostError;

#[derive(Args)]
pub(crate) struct ServiceRun {
    #[arg(long)]
    root_id: RootId,
}

impl ServiceRun {
    pub async fn run(self) -> Result<(), HostError> {
        let source = maka_host_runtime::logs::Source::for_root(
            &self.root_id.0,
            &maka_event_log::root::RootNamespaces::for_current_account()?,
        )?;
        crate::logging::capture(source.open_capture()?)?;
        let directory = directory(&self.root_id.0)?;
        #[cfg(windows)]
        {
            crate::windows::own_process_tree()?;
        }
        let store::Installation::Installed(deployment) = store::read(&directory).await? else {
            return Err("service deployment is absent or incomplete".into());
        };
        if deployment.root_id != self.root_id.0 {
            return Err("service deployment root identity differs".into());
        }
        // This read only locates Root. Admission is repeated after acquiring the
        // actual writer lease, so a waiting process cannot reuse an old grant.
        crate::serve::run(&deployment.root_path, None, Some(&self.root_id.0)).await
    }
}
