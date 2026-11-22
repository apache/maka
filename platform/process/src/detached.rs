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

//! Independent background processes with a single launcher-owned stdin pipe.
//! Closing stdin, including on drop, lets the application's protocol request drain.

#[cfg(windows)]
mod windows;
#[cfg(unix)]
pub use tokio::process::Child;
#[cfg(windows)]
pub use windows::{Child, spawn};

#[cfg(unix)]
pub async fn spawn(
    executable: &std::path::Path,
    args: &[&str],
    stderr: Option<std::fs::File>,
) -> std::io::Result<Child> {
    use std::process::Stdio;
    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(stderr.map(Stdio::from).unwrap_or_else(Stdio::null));
    // SAFETY: setsid is async-signal-safe and touches no Rust state.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn()
}
