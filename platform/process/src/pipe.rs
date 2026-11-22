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

//! Owned bidirectional pipes for trusted protocol processes, not a sandbox.
//! Native wait closes the owned process group/Job, including descendants.
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
pub(crate) use unix::spawn_prepared;
#[cfg(unix)]
pub use unix::{Child, spawn};
#[cfg(windows)]
pub(crate) use windows::spawn_prepared;
#[cfg(windows)]
pub use windows::{Child, spawn};

#[cfg(unix)]
pub type Input = tokio::process::ChildStdin;
#[cfg(unix)]
pub type Output = tokio::process::ChildStdout;
#[cfg(unix)]
pub type ErrorOutput = tokio::process::ChildStderr;
#[cfg(windows)]
pub type Input = tokio::net::windows::named_pipe::NamedPipeServer;
#[cfg(windows)]
pub type Output = tokio::net::windows::named_pipe::NamedPipeServer;
#[cfg(windows)]
pub type ErrorOutput = tokio::net::windows::named_pipe::NamedPipeServer;

pub struct Spawned {
    pub child: Child,
    pub stdin: Input,
    pub stdout: Output,
    pub stderr: ErrorOutput,
}
