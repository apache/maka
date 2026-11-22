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

use super::failed;
use cua_driver_core::browser::host_handoff::{
    HandoffError, PreparedHandoff, RegistrationTransaction,
};
use maka_agent_facts::tools::ToolError;
use std::{path::PathBuf, sync::mpsc};
use tokio::sync::oneshot;

enum Command {
    Restore(oneshot::Sender<Result<(), ToolError>>),
    Publish(PreparedHandoff, oneshot::Sender<Result<(), ToolError>>),
}

/// One blocking thread owns the OS registration lock and its durable journal.
/// Closing the channel releases custody, including when the async caller fails.
pub(super) struct Registration(mpsc::Sender<Command>);

impl Registration {
    pub(super) async fn open(directory: PathBuf) -> Result<Option<Self>, ToolError> {
        let (commands, incoming) = mpsc::channel();
        let (opened, ready) = oneshot::channel();
        std::thread::Builder::new()
            .name("browser-registration".into())
            .spawn(move || {
                let mut transaction = match RegistrationTransaction::open(&directory) {
                    Ok(transaction) => transaction,
                    Err(HandoffError::Io(error))
                        if error.kind() == std::io::ErrorKind::WouldBlock =>
                    {
                        let _ = opened.send(Ok(false));
                        return;
                    }
                    Err(error) => {
                        let _ = opened.send(Err(failed(error)));
                        return;
                    }
                };
                if opened.send(Ok(true)).is_err() {
                    return;
                }
                for command in incoming {
                    let (reply, result) = match command {
                        Command::Restore(reply) => (reply, transaction.restore()),
                        Command::Publish(plan, reply) => {
                            (reply, plan.publish(&mut transaction).map(|_| ()))
                        }
                    };
                    let _ = reply.send(result.map_err(failed));
                }
            })
            .map_err(failed)?;
        if ready.await.map_err(failed)?? {
            Ok(Some(Self(commands)))
        } else {
            Ok(None)
        }
    }

    pub(super) async fn restore(&self) -> Result<(), ToolError> {
        let (reply, completed) = oneshot::channel();
        self.0.send(Command::Restore(reply)).map_err(failed)?;
        completed.await.map_err(failed)?
    }

    pub(super) async fn publish(&self, plan: PreparedHandoff) -> Result<(), ToolError> {
        let (reply, completed) = oneshot::channel();
        self.0.send(Command::Publish(plan, reply)).map_err(failed)?;
        completed.await.map_err(failed)?
    }
}
