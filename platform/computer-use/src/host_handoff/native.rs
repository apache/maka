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

use super::{RESTORE, STARTUP, failed};
use cua_driver_core::browser::host_handoff::{
    ConfiguredHandoff,
    transport::{Connection, Message},
};
use maka_agent_facts::tools::ToolError;
use std::process::Stdio;

/// A selected native adapter cannot outlive its admitting supervisor generation.
pub(super) fn admit(config: &ConfiguredHandoff) -> Result<bool, ToolError> {
    let config = config.clone();
    let (admitted, result) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("browser-host-guardian".into())
        .spawn(move || {
            let run = || -> Result<(), ToolError> {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(failed)?;
                runtime.block_on(async {
                    let handshake = async {
                        let mut connection = Connection::connect(&config.recovery_directory())
                            .await
                            .map_err(failed)?;
                        connection
                            .send(&Message::Native {
                                pid: std::process::id(),
                            })
                            .await
                            .map_err(failed)?;
                        match connection.receive().await.map_err(failed)? {
                            Some(Message::NativeReady) => Ok(connection),
                            _ => Err(failed("native host admission was not acknowledged")),
                        }
                    };
                    let mut connection = match tokio::time::timeout(STARTUP, handshake).await {
                        Ok(Ok(connection)) => connection,
                        _ => {
                            let _ = admitted.send(false);
                            return Ok(());
                        }
                    };
                    if admitted.send(true).is_err() {
                        return Ok(());
                    }
                    match connection.receive().await {
                        Ok(Some(Message::StopNative)) => {}
                        _ => {
                            // Recovery is independent of both the crashed guardian and
                            // this native port. It never reacquires a browser user.
                            let mut command = std::process::Command::new(config.executable());
                            command
                                .arg(RESTORE)
                                .arg(config.browser().as_str())
                                .stdin(Stdio::null())
                                .stdout(Stdio::null())
                                .stderr(Stdio::inherit());
                            #[cfg(unix)]
                            {
                                use std::os::unix::process::CommandExt;
                                command.process_group(0);
                            }
                            #[cfg(windows)]
                            {
                                use std::os::windows::process::CommandExt;
                                command.creation_flags(0x01000000 | 0x08000000 | 0x00000200);
                            }
                            if let Err(error) = command.spawn() {
                                eprintln!("Maka browser host recovery: {error}");
                            }
                        }
                    }
                    std::process::exit(0);
                })
            };
            if let Err(error) = run() {
                eprintln!("Maka browser host guardian: {error}");
            }
        })
        .map_err(failed)?;
    result.recv().map_err(failed)
}
