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

use super::{
    Channel, Runner,
    protocol::{Control, Controlled},
};
use maka_plugin_core::terminal::TerminalSize;
use std::{io, time::Duration};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

/// One owner serializes complete request/reply exchanges. Cancelling a resize
/// waiter cannot leave a half-written frame for the next control operation.
pub(crate) struct Remote {
    commands: mpsc::Sender<Request>,
    task: JoinHandle<io::Result<()>>,
}
enum Request {
    Resize(TerminalSize, oneshot::Sender<io::Result<()>>),
    Close { terminated: bool },
}
impl Remote {
    pub fn new(mut runner: Runner, mut channel: Channel) -> Self {
        let (commands, mut receiver) = mpsc::channel(4);
        let task = tokio::spawn(async move {
            while let Some(request) = receiver.recv().await {
                match request {
                    Request::Resize(size, reply) => {
                        match exchange(&mut channel, &Control::Resize { size }).await {
                            Ok(result) => {
                                let _ = reply.send(result);
                            }
                            Err(error) => {
                                let _ = reply
                                    .send(Err(io::Error::new(error.kind(), error.to_string())));
                                return Err(error);
                            }
                        }
                    }
                    Request::Close { terminated } => {
                        if !terminated {
                            exchange(&mut channel, &Control::Close).await??;
                        }
                        let status = tokio::time::timeout(Duration::from_secs(15), runner.wait())
                            .await
                            .map_err(|_| {
                                io::Error::new(
                                    io::ErrorKind::TimedOut,
                                    "console runner did not exit",
                                )
                            })??;
                        if !terminated && !status.success() {
                            return Err(io::Error::other("console runner failed during close"));
                        }
                        runner.finish().await?;
                        return Ok(());
                    }
                }
            }
            Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "console owner dropped before settlement",
            ))
        });
        Self { commands, task }
    }
    pub async fn resize(&self, size: TerminalSize) -> io::Result<()> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Request::Resize(size, reply))
            .await
            .map_err(|_| closed())?;
        result.await.map_err(|_| closed())?
    }
    pub async fn close(self, terminated: bool) -> io::Result<()> {
        let Self { commands, task } = self;
        let _ = commands.send(Request::Close { terminated }).await;
        drop(commands);
        task.await.map_err(io::Error::other)?
    }
}
async fn exchange(channel: &mut Channel, control: &Control) -> io::Result<io::Result<()>> {
    tokio::time::timeout(Duration::from_secs(15), async {
        channel.send(control).await?;
        Ok(match channel.receive().await? {
            Controlled::Done => Ok(()),
            Controlled::Failed { message } => Err(io::Error::other(message)),
        })
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "console control outcome unknown"))?
}
fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "console control closed")
}
