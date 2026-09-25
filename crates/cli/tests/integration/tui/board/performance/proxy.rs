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

mod fence;

use super::*;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::unix::{OwnedReadHalf, OwnedWriteHalf},
};
use tokio_util::sync::CancellationToken;

pub(in crate::tui) struct DelayProxy {
    registration: PathBuf,
    original: Vec<u8>,
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
    records: Arc<Mutex<Vec<Value>>>,
}

impl DelayProxy {
    /// Only the freshly created CandidateFixture's discovery is replaced.
    /// Identity, epoch and every wire byte retain their original meaning.
    pub async fn start(
        host: &CandidateFixture,
        directory: &std::path::Path,
        one_way: Duration,
        origin: Instant,
    ) -> Self {
        let discovery = maka_client::local::read_discovery(&host.root).unwrap();
        assert_eq!(discovery.root_id, host.root_id);
        let original = std::fs::read(&host.registration).unwrap();
        let socket = directory.join("performance.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let records = Arc::new(Mutex::new(Vec::new()));
        let captured = records.clone();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            let mut connection = 0_u64;
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    finished = connections.join_next(), if !connections.is_empty() => {
                        if let Err(error) = finished.unwrap() {
                            captured.lock().unwrap().push(json!({"kind":"proxy_error", "error":error.to_string()}));
                        }
                    },
                    accepted = listener.accept() => {
                        let (client, _) = accepted.unwrap();
                        connection += 1;
                        let endpoint = discovery.endpoint.clone();
                        let records = captured.clone();
                        let stop = stop.clone();
                        connections.spawn(async move {
                            let host = tokio::net::UnixStream::connect(endpoint).await.unwrap();
                            let (client_read, client_write) = client.into_split();
                            let (host_read, host_write) = host.into_split();
                            let up = direction(client_read, host_write, one_way, origin, connection, "client_to_host", records.clone());
                            let down = direction(host_read, client_write, one_way, origin, connection, "host_to_client", records.clone());
                            let result = tokio::select! {
                                result = up => result,
                                result = down => result,
                                _ = stop.cancelled() => Ok(()),
                            };
                            if let Err(error) = result {
                                let kind = if matches!(error.kind(), std::io::ErrorKind::BrokenPipe
                                    | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted) {
                                    "proxy_disconnect"
                                } else { "proxy_error" };
                                records.lock().unwrap().push(json!({"kind":kind, "connection":connection, "error":error.to_string()}));
                            }
                        });
                    }
                }
            }
            // Cancellation drops both directional futures; all connection tasks
            // are joined before this case returns, including their queue timers.
            while let Some(result) = connections.join_next().await {
                result.expect("delay proxy connection task");
            }
        });
        let mut record: Value = serde_json::from_slice(&original).unwrap();
        record["endpoint"] = json!(socket);
        std::fs::write(&host.registration, serde_json::to_vec(&record).unwrap()).unwrap();
        Self {
            registration: host.registration.clone(),
            original,
            cancel,
            task: Some(task),
            records,
        }
    }

    pub async fn stop(mut self) -> Vec<Value> {
        std::fs::write(&self.registration, &self.original).unwrap();
        self.cancel.cancel();
        self.task.take().unwrap().await.expect("delay proxy task");
        self.records.lock().unwrap().clone()
    }

    pub fn fence(&self) -> Value {
        fence::snapshot(&self.records.lock().unwrap())
    }

    pub fn records(&self) -> Vec<Value> {
        self.records.lock().unwrap().clone()
    }
}

impl Drop for DelayProxy {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            task.abort(); // Panic fallback only; the successful path always joins.
            let _ = std::fs::write(&self.registration, &self.original);
        }
    }
}

async fn direction(
    reader: OwnedReadHalf,
    mut writer: OwnedWriteHalf,
    delay: Duration,
    origin: Instant,
    connection: u64,
    direction: &'static str,
    records: Arc<Mutex<Vec<Value>>>,
) -> std::io::Result<()> {
    // The reader keeps receiving while the writer waits for absolute due times.
    // Delays therefore overlap instead of adding 100 ms per queued wire frame.
    let (send, mut receive) = tokio::sync::mpsc::channel::<(Vec<u8>, Instant, usize)>(32);
    let captured = records.clone();
    let ingest = async move {
        let mut reader = BufReader::new(reader);
        loop {
            let mut bytes = Vec::new();
            if reader.read_until(b'\n', &mut bytes).await? == 0 {
                break;
            }
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(std::io::Error::other(
                    "proxy NDJSON frame exceeds fixture budget",
                ));
            }
            let received = Instant::now();
            let value: Value = serde_json::from_slice(&bytes).map_err(std::io::Error::other)?;
            let index = {
                let mut records = captured.lock().unwrap();
                if records.len() >= 100_000 {
                    return Err(std::io::Error::other("proxy evidence budget exhausted"));
                }
                let index = records.len();
                records.push(json!({"kind":"wire_received", "direction":direction, "connection":connection,
                    "received_ns":received.duration_since(origin).as_nanos() as u64,"forwarded_ns":null,
                    "wire_bytes":bytes.len(),"request_id":value["requestId"],"operation":value["operation"],
                    "remote_kind":value["input"]["kind"],"method":value["input"]["binding"]["method"],
                    "remote_input_kind":value["input"]["input"]["kind"],"document":value["input"]["document"],
                    "result_kind":value["result"]["kind"],"result_document":value["result"]["document"]}));
                index
            };
            if send.send((bytes, received, index)).await.is_err() {
                break;
            }
        }
        Ok::<_, std::io::Error>(())
    };
    let forward = async move {
        while let Some((bytes, received, index)) = receive.recv().await {
            tokio::time::sleep_until(tokio::time::Instant::from_std(received + delay)).await;
            writer.write_all(&bytes).await?;
            let forwarded = Instant::now();
            let mut records = records.lock().unwrap();
            records[index]["kind"] = json!("wire");
            records[index]["forwarded_ns"] =
                json!(forwarded.duration_since(origin).as_nanos() as u64);
        }
        writer.shutdown().await
    };
    tokio::try_join!(ingest, forward).map(|_| ())
}

pub(in crate::tui) async fn connect(
    root: &std::path::Path,
) -> (maka_client::Client, tokio::task::JoinHandle<()>) {
    let discovery = maka_client::local::read_discovery(root).unwrap();
    let (client, mut notices) = maka_client::Client::connect(
        maka_client::local::open_stream(&discovery.endpoint)
            .await
            .unwrap(),
        &discovery.root_id,
        &discovery.host_epoch,
        maka_client::Operations,
    )
    .await
    .unwrap();
    let task = tokio::spawn(async move { while notices.recv().await.is_some() {} });
    (client, task)
}
