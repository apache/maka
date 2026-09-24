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

use super::{Chunk, Exit, State, message};
use maka_plugins::process::Stream;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, watch},
};
use tokio_util::sync::CancellationToken;

pub(super) struct Stops {
    pub launch: CancellationToken,
    pub explicit: CancellationToken,
    pub retiring: CancellationToken,
    pub invocation: CancellationToken,
}
impl Stops {
    fn is_cancelled(&self) -> bool {
        self.explicit.is_cancelled()
            || self.retiring.is_cancelled()
            || self.invocation.is_cancelled()
    }

    async fn cancelled(&self) {
        tokio::select! { _ = self.explicit.cancelled() => {}, _ = self.retiring.cancelled() => {}, _ = self.invocation.cancelled() => {} }
    }
}
pub(super) async fn run(
    command: maka_process::Command,
    mut input: mpsc::Receiver<Option<Vec<u8>>>,
    output: mpsc::Sender<Chunk>,
    state: watch::Sender<State>,
    stops: Stops,
    admission: tokio::sync::OwnedMutexGuard<()>,
) -> Result<(), String> {
    if stops.is_cancelled() || stops.launch.is_cancelled() {
        state.send_replace(State::Ended(Ok(Exit {
            code: None,
            success: false,
            stopped: true,
            error: None,
        })));
        return Ok(());
    }
    // An accepted startup owns preparation and native handles. Cancellation
    // during startup is settled by the lifecycle below, never by dropping spawn.
    let spawned = maka_process::pipe::spawn(command).await;
    drop(admission);
    let mut process = match spawned {
        Ok(process) => process,
        Err(error) => {
            state.send_replace(State::Ended(Err(message(error))));
            return Ok(());
        }
    };
    // Cancellation while startup was in progress still belongs to the launch,
    // even when a successfully returned handle would have Instance lifetime.
    if stops.launch.is_cancelled() {
        stops.explicit.cancel();
    }
    state.send_replace(State::Running);
    let finished = CancellationToken::new();
    let fault = CancellationToken::new();
    let failure = Arc::new(Mutex::new(None));
    let lifecycle = async {
        let result = tokio::select! {
            biased;
            _ = stops.cancelled() => None,
            _ = fault.cancelled() => None,
            result = process.child.wait() => Some(result),
        };
        let stopped = result.is_none();
        let result = match result {
            Some(result) => result.map_err(message),
            None => match process.child.terminate() {
                Err(error) => Err(message(error)),
                Ok(()) => tokio::time::timeout(Duration::from_secs(4), process.child.wait())
                    .await
                    .map_err(|_| "native process cleanup timed out".to_owned())
                    .and_then(|result| result.map_err(message)),
            },
        };
        finished.cancel();
        result.map(|status| (status, stopped))
    };
    let writer = async {
        loop {
            let bytes = tokio::select! {
                biased;
                _ = finished.cancelled() => return Ok(()),
                bytes = input.recv() => bytes.flatten(),
            };
            let Some(bytes) = bytes else {
                return process.stdin.shutdown().await.map_err(message);
            };
            tokio::select! {
                biased;
                _ = finished.cancelled() => return Ok(()),
                result = process.stdin.write_all(&bytes) => result.map_err(message)?,
            }
        }
    };
    let (result, (), (), ()) = tokio::join!(
        lifecycle,
        report(writer, &failure, &fault),
        report(
            read(process.stdout, Stream::Stdout, output.clone(), &finished),
            &failure,
            &fault
        ),
        report(
            read(process.stderr, Stream::Stderr, output, &finished),
            &failure,
            &fault
        ),
    );
    let failure = failure.lock().unwrap().clone();
    let outcome = result
        .as_ref()
        .map(|(status, stopped)| Exit {
            code: status.code(),
            success: status.success() && !stopped && failure.is_none(),
            stopped: *stopped,
            error: failure,
        })
        .map_err(Clone::clone);
    state.send_replace(State::Ended(outcome));
    result.map(|_| ())
}
async fn report(
    future: impl std::future::Future<Output = Result<(), String>>,
    failure: &Mutex<Option<String>>,
    fault: &CancellationToken,
) {
    if let Err(error) = future.await {
        failure.lock().unwrap().get_or_insert(error);
        fault.cancel();
    }
}
async fn read(
    mut source: impl AsyncRead + Unpin,
    stream: Stream,
    output: mpsc::Sender<Chunk>,
    finished: &CancellationToken,
) -> Result<(), String> {
    let drain = async {
        finished.cancelled().await;
        tokio::time::sleep(Duration::from_secs(1)).await;
    };
    tokio::pin!(drain);
    let mut buffer = vec![0; 16 * 1024];
    loop {
        let count = tokio::select! {
            count = source.read(&mut buffer) => count.map_err(message)?,
            _ = &mut drain => return Err("process output drain timed out".into()),
        };
        if count == 0 {
            return Ok(());
        }
        tokio::select! {
            result = output.send(Chunk {
                stream,
                bytes: buffer[..count].to_vec(),
            }) => result.map_err(|_| "process output consumer closed".to_owned())?,
            _ = &mut drain => return Err("process output drain timed out".into()),
        }
    }
}
