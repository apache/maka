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

use crate::{Command, command::Argument};
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, path::PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Plan {
    pub executable: PathBuf,
    pub args: Vec<Argument>,
    pub cwd: PathBuf,
    pub environment: Vec<(OsString, OsString)>,
}
impl Plan {
    pub fn command(self) -> Command {
        let mut command = Command::new(self.executable, self.cwd);
        command.args = self.args;
        command.environment = self.environment.into_iter().collect();
        command
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Start {
    pub plan: Plan,
    pub capabilities: Vec<uuid::Uuid>,
    pub io: Transport,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Transport {
    Pipe {
        stdio: [usize; 3],
    },
    Terminal {
        input: usize,
        output: usize,
        size: maka_plugin_core::terminal::TerminalSize,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Control {
    Resize {
        size: maka_plugin_core::terminal::TerminalSize,
    },
    Close,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Controlled {
    Done,
    Failed { message: String },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Started {
    Running { process: usize, pid: u32 },
    Failed { message: String },
}
