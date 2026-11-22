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

use super::{Installation, Status};
use maka_process::bootstrap::{Caller, administrative};
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Setup,
    Remove,
}

/// The only administrative operations admitted by the one-shot helper.
/// Passwords and native identities are loaded from the caller's private intent,
/// never accepted as privileged instructions over the wire.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provision {
    pub root: PathBuf,
    pub operation: Operation,
}

impl Provision {
    /// Called only for an explicit user setup/removal action. Shell execution
    /// never prompts for elevation or changes the installation implicitly.
    pub async fn request(&self, executable: &Path) -> io::Result<()> {
        let response: Result<(), String> = administrative(executable, self).await?;
        response.map_err(io::Error::other)
    }

    /// The helper owns the exclusive lifecycle lease through durable completion.
    /// Private files keep the authenticated caller's ownership even when UAC
    /// was approved with a different administrator account.
    pub fn apply(&self, caller: &Caller) -> io::Result<()> {
        if !self.root.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "sandbox state root must be absolute",
            ));
        }
        let installation = Installation::new(&self.root);
        match self.operation {
            Operation::Setup => {
                // Resume an interrupted removal before recreating the installation.
                // The same explicit UAC consent covers repair; users need no
                // account/ACL knowledge or separate maintenance command.
                if caller.run(|| installation.status())? == Status::Removing {
                    remove(&installation, caller)?;
                }
                let setup = caller.run(|| installation.begin_setup())?;
                let configured = setup.request().apply()?;
                caller.run(|| setup.finish(configured))
            }
            Operation::Remove => remove(&installation, caller),
        }
    }
}

fn remove(installation: &Installation, caller: &Caller) -> io::Result<()> {
    let removal = caller.run(|| installation.begin_removal())?;
    let receipt = removal
        .request()
        .map(|request| request.apply())
        .transpose()?;
    caller.run(|| removal.finish(receipt))
}
