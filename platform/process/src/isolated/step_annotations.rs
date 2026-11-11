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

use serde::{Deserialize, Serialize};
use std::{io, path::Path, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::{mpsc, oneshot},
};

pub(super) const SOCKET: &str = "maka-steps.sock";
const MAX_BYTES: u64 = 4096;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepAnnotation {
    pub session: String,
    pub step: u64,
    pub title: Option<String>,
}

pub(super) struct Row {
    pub bytes: Vec<u8>,
    pub recorded: oneshot::Sender<()>,
}

impl StepAnnotation {
    /// Called by a short-lived hook process. The acknowledgement follows the
    /// original stdout journal write, before the CLI starts the command.
    pub fn record(&self, directory: &Path) -> io::Result<()> {
        use std::io::Read;
        std::env::set_current_dir(directory)?;
        let mut stream = std::os::unix::net::UnixStream::connect(SOCKET)?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        serde_json::to_writer(&mut stream, self)?;
        stream.shutdown(std::net::Shutdown::Write)?;
        let mut ack = [0];
        stream.read_exact(&mut ack)?;
        if ack == [1] {
            Ok(())
        } else {
            Err(io::Error::other("native step annotation was not recorded"))
        }
    }
}

pub(super) fn start(
    resource: &Path,
) -> io::Result<(mpsc::Receiver<Row>, tokio::task::JoinHandle<()>)> {
    // Both ends use paths relative to their private working directory. Darwin
    // socket paths can be shorter than the absolute task resource path.
    let listener = UnixListener::bind(Path::new("../tmp").join(SOCKET))?;
    let socket = resource.join("tmp").join(SOCKET);
    let (send, receive) = mpsc::channel(8);
    let task = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = send.closed() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _)) = accepted else {
                eprintln!(
                    "Original step annotation listener: {}",
                    accepted.unwrap_err()
                );
                break;
            };
            let result = tokio::time::timeout(Duration::from_secs(3), capture(stream, &send)).await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("Original step annotation: {error}"),
                Err(error) => eprintln!("Original step annotation: {error}"),
            }
        }
        if let Err(error) = tokio::fs::remove_file(socket).await {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!("Original step annotation socket cleanup: {error}");
            }
        }
    });
    Ok((receive, task))
}

async fn capture(mut stream: UnixStream, send: &mpsc::Sender<Row>) -> io::Result<()> {
    let mut bytes = Vec::new();
    (&mut stream)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(io::Error::other("native step annotation exceeds limit"));
    }
    let annotation: StepAnnotation = serde_json::from_slice(&bytes)?;
    let mut row = serde_json::to_vec(&serde_json::json!({
        "event": "maka_step_annotation",
        "annotation": annotation,
    }))?;
    row.push(b'\n');
    let (recorded, ack) = oneshot::channel();
    send.send(Row {
        bytes: row,
        recorded,
    })
    .await
    .map_err(io::Error::other)?;
    ack.await.map_err(io::Error::other)?;
    stream.write_all(&[1]).await
}
