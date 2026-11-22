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

use futures_util::FutureExt;
use rmcp::{
    RoleClient,
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::Transport,
};
use std::{
    fmt,
    panic::AssertUnwindSafe,
    sync::{Arc, OnceLock},
};
use tokio::sync::watch;

#[derive(Clone, Debug)]
pub(crate) struct TransportError(Arc<dyn std::error::Error + Send + Sync>);
impl TransportError {
    fn new(error: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self(Arc::new(error))
    }
}
impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MCP transport cleanup failed")
    }
}
impl std::error::Error for TransportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref())
    }
}

/// The original close task owns T even after the SDK drops its observer.
#[derive(Clone)]
pub(crate) struct Custody(Arc<Cleanup>);
struct Cleanup {
    done: watch::Receiver<Option<Result<(), TransportError>>>,
    task: OnceLock<tokio::task::JoinHandle<()>>,
}
pub(crate) struct Owned<T: Transport<RoleClient> + 'static> {
    transport: Option<T>,
    done: watch::Sender<Option<Result<(), TransportError>>>,
    custody: Custody,
}
pub(crate) fn track<T: Transport<RoleClient> + 'static>(transport: T) -> (Owned<T>, Custody) {
    let (done, closed) = watch::channel(None);
    let custody = Custody(Arc::new(Cleanup {
        done: closed,
        task: OnceLock::new(),
    }));
    (
        Owned {
            transport: Some(transport),
            done,
            custody: custody.clone(),
        },
        custody,
    )
}
impl Custody {
    pub(crate) async fn closed(&self) -> Result<(), TransportError> {
        let mut done = self.0.done.clone();
        loop {
            if let Some(result) = done.borrow_and_update().clone() {
                return result;
            }
            done.changed().await.map_err(|_| {
                TransportError::new(std::io::Error::other(
                    "MCP transport cleanup owner disappeared",
                ))
            })?;
        }
    }
}
impl<T: Transport<RoleClient> + 'static> Owned<T> {
    fn start_close(&mut self) {
        if let Some(mut transport) = self.transport.take() {
            let done = self.done.clone();
            let task = tokio::spawn(async move {
                let result = match AssertUnwindSafe(transport.close()).catch_unwind().await {
                    Ok(result) => result.map_err(TransportError::new),
                    Err(_) => Err(TransportError::new(std::io::Error::other(
                        "MCP transport close panicked",
                    ))),
                };
                match result {
                    Ok(()) => {
                        drop(transport);
                        done.send_replace(Some(Ok(())));
                    }
                    Err(error) => {
                        done.send_replace(Some(Err(error)));
                        // A failed SDK close may have consumed its internal join.
                        // Keep the original T; never retry its now-empty handle.
                        std::future::pending::<()>().await;
                        drop(transport);
                    }
                }
            });
            self.custody
                .0
                .task
                .set(task)
                .expect("one original MCP transport close");
        }
    }
}
impl<T: Transport<RoleClient> + 'static> Transport<RoleClient> for Owned<T> {
    type Error = TransportError;
    fn send(
        &mut self,
        message: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let sent = self
            .transport
            .as_mut()
            .expect("open transport")
            .send(message);
        async move { sent.await.map_err(TransportError::new) }
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        self.transport.as_mut()?.receive().await
    }
    async fn close(&mut self) -> Result<(), Self::Error> {
        self.start_close();
        self.custody.closed().await
    }
}
impl<T: Transport<RoleClient> + 'static> Drop for Owned<T> {
    fn drop(&mut self) {
        self.start_close();
    }
}
