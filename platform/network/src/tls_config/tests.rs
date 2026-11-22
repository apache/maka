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
use crate::{ConnectionTasks, Policy};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

#[test]
fn failed_initial_build_does_not_poison_tls_cache() {
    let cache = TlsConfigCache::default();
    assert!(
        cache
            .build(reqwest::Client::builder().user_agent("invalid\nheader"))
            .is_err()
    );
    assert!(cache.0.lock().unwrap().is_none());
    cache.build(Policy::default().client_builder()).unwrap();
    assert!(cache.0.lock().unwrap().is_some());
}

#[tokio::test]
async fn cached_tls_clients_have_independent_connection_custody() {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (release, wait) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut wait = Some(wait);
            let mut workers = Vec::new();
            for index in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let wait = if index == 1 { wait.take() } else { None };
                workers.push(tokio::spawn(async move {
                    let mut headers = Vec::new();
                    while !headers.ends_with(b"\r\n\r\n") {
                        headers.push(stream.read_u8().await.unwrap());
                    }
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\na")
                        .await
                        .unwrap();
                    if let Some(wait) = wait {
                        wait.await.unwrap();
                        stream.write_all(b"b").await.unwrap();
                    } else {
                        // The first owner's close must physically close its socket.
                        assert_eq!(stream.read(&mut [0]).await.unwrap(), 0);
                    }
                }));
            }
            for worker in workers {
                worker.await.unwrap();
            }
        });
        let cache = TlsConfigCache::default();
        let first = ConnectionTasks::default();
        let second = ConnectionTasks::default();
        let first_client = cache
            .build(first.client_builder(Policy::default().client_builder()))
            .unwrap();
        assert!(cache.0.lock().unwrap().is_some());
        let second_client = cache
            .build(second.client_builder(Policy::default().client_builder()))
            .unwrap();
        let mut a = first_client.get(&url).send().await.unwrap();
        assert_eq!(a.chunk().await.unwrap().unwrap().as_ref(), b"a");
        let mut b = second_client.get(&url).send().await.unwrap();
        assert_eq!(b.chunk().await.unwrap().unwrap().as_ref(), b"a");
        first.close().await;
        assert!(a.chunk().await.is_err());
        release.send(()).unwrap();
        assert_eq!(b.chunk().await.unwrap().unwrap().as_ref(), b"b");
        assert!(b.chunk().await.unwrap().is_none());
        second.close().await;
        server.await.unwrap();
        // The cache is configuration only: a closed group cannot poison later clients.
        cache.build(Policy::default().client_builder()).unwrap();
    })
    .await
    .unwrap();
}
