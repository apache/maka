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

use super::*;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct TestAuthority {
    workers: Mutex<Vec<tokio::task::JoinHandle<Result<(), String>>>>,
    cleanup_failure: bool,
}
impl Authority for TestAuthority {
    fn admit(&self, _: &Scope) -> Result<Box<dyn Send>, Error> {
        Ok(Box::new(()))
    }
    fn policy<'a>(
        &'a self,
        _: &'a Scope,
        _: &'a maka_sandbox::Destination,
        _: String,
    ) -> BoxFuture<'a, Result<maka_network::Policy, Error>> {
        Box::pin(async { Ok(maka_network::Policy::default()) })
    }
    fn check<'a>(
        &'a self,
        _: &'a Scope,
        _: &'a maka_sandbox::Destination,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async { Ok(()) })
    }
    fn record(
        &self,
        _: Scope,
        _: maka_event_log::effects::Operation,
        _: maka_sandbox::Destination,
        effect: BoxFuture<'static, Result<serde_json::Value, ToolError>>,
    ) -> BoxFuture<'static, Result<serde_json::Value, ToolError>> {
        let fail = self.cleanup_failure;
        Box::pin(async move {
            let result = effect.await;
            if fail {
                Err(ToolError::CleanupUnconfirmed(
                    "fixture custody failure".into(),
                ))
            } else {
                result
            }
        })
    }
    fn spawn(&self, worker: Worker) -> Result<(), Error> {
        self.workers
            .lock()
            .unwrap()
            .push(tokio::spawn(worker(CancellationToken::new())));
        Ok(())
    }
}
async fn completed_response(cleanup_failure: bool) -> Response {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nend")
            .await
            .unwrap();
        socket.shutdown().await.unwrap();
    });
    let authority = Arc::new(TestAuthority {
        workers: Mutex::new(Vec::new()),
        cleanup_failure,
    });
    let http = Http::new(authority.clone());
    let scope = maka_capabilities::call::Issuer::default()
        .issue(
            maka_capabilities::call::Identity::Remote {
                request_id: uuid::Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap();
    let response = http
        .request(
            scope,
            Request {
                url,
                method: Method::Post,
                headers: vec![],
                body: Default::default(),
            },
        )
        .await
        .unwrap();
    let workers = std::mem::take(&mut *authority.workers.lock().unwrap());
    for worker in workers {
        let result = tokio::time::timeout(Duration::from_secs(10), worker)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.is_err(), cleanup_failure);
    }
    server.await.unwrap();
    response
}
#[tokio::test]
async fn normal_completion_keeps_final_queued_chunk_and_eof_readable() {
    let response = completed_response(false).await;
    assert_eq!(response.body.next().await.unwrap(), Some(b"end".to_vec()));
    assert_eq!(response.body.next().await.unwrap(), None);
    response.body.close().await.unwrap();
}
#[tokio::test]
async fn close_rejects_an_already_completed_custody_failure() {
    let response = completed_response(true).await;
    assert!(matches!(
        response.body.close().await,
        Err(Error::CleanupUnconfirmed)
    ));
}
