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

use super::{Connection, Duration, Error, Value, emit, mpsc, provider};
use crate::transport::Event;
use agent_client_protocol as sdk;
use serde_json::json;

pub(super) async fn initialize(
    connection: &mut Connection,
    send: &mpsc::Sender<Result<Value, Error>>,
    stderr: &mut Urls,
) -> Result<(), Error> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            tokio::select! {
                biased;
                event = connection.events.recv() => match event.ok_or_else(|| provider("ACP setup event stream ended"))? {
                    Event::Initialized(peer) => { connection.peer = Some(*peer); return Ok(()); }
                    event => observe(event, send, stderr).await?,
                },
                result = &mut connection.run => { result.map_err(provider)?; return Err(provider("ACP setup connection ended")); },
            }
        }
    }).await.map_err(|_| provider("External agent setup timed out"))?
}

pub(super) async fn rpc<R: sdk::JsonRpcRequest>(
    connection: &mut Connection,
    request: R,
    send: &mpsc::Sender<Result<Value, Error>>,
    stderr: &mut Urls,
) -> Result<R::Response, Error> {
    let response = connection.request(request).block_task();
    tokio::pin!(response);
    tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            tokio::select! {
                biased;
                event = connection.events.recv() => observe(event.ok_or_else(|| provider("ACP setup event stream ended"))?, send, stderr).await?,
                result = &mut response => return result.map_err(provider),
                result = &mut connection.run => { result.map_err(provider)?; return Err(provider("ACP setup connection ended")); },
            }
        }
    }).await.map_err(|_| provider("External agent setup timed out"))?
}

async fn observe(
    event: Event,
    send: &mpsc::Sender<Result<Value, Error>>,
    stderr: &mut Urls,
) -> Result<(), Error> {
    match event {
        Event::Stderr(bytes) => {
            for url in stderr.feed(&bytes)? {
                emit(send, json!({"kind":"authorization_url", "url":url})).await?;
            }
        }
        event => event.reject().map_err(provider)?,
    }
    Ok(())
}

#[derive(Default)]
pub(super) struct Urls {
    line: Vec<u8>,
    discard: bool,
}
impl Urls {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>, Error> {
        const PREFIX: &str = "Open the following link to authenticate the ACP server: ";
        let mut urls = vec![];
        for byte in bytes {
            if *byte == b'\n' {
                if !self.discard
                    && let Ok(line) = std::str::from_utf8(&self.line)
                    && let Some(value) = line.trim_end_matches('\r').strip_prefix(PREFIX)
                {
                    if value.len() > 8192 || value.chars().any(char::is_control) {
                        return Err(Error::Provider("Invalid authentication URL".into()));
                    }
                    let url = url::Url::parse(value)
                        .map_err(|_| Error::Provider("Invalid authentication URL".into()))?;
                    if url.scheme() != "https"
                        || url.host_str().is_none()
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || value.split_once("://").is_none_or(|(_, rest)| {
                            rest.split(['/', '?', '#'])
                                .next()
                                .is_some_and(|authority| authority.contains('@'))
                        })
                    {
                        return Err(Error::Provider("Invalid authentication URL".into()));
                    }
                    urls.push(value.to_owned());
                }
                self.line.clear();
                self.discard = false;
            } else if !self.discard {
                if self.line.len() == 32 * 1024 {
                    self.line.clear();
                    self.discard = true;
                } else {
                    self.line.push(*byte);
                }
            }
        }
        Ok(urls)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_exact_prefix_and_https_without_credentials() {
        let mut parser = Urls::default();
        assert!(parser.feed(b"unrelated https://example.org\nOpen the following link to authenticate the ACP server: https://exam").unwrap().is_empty());
        assert_eq!(
            parser.feed(b"ple.org/login?state=1\r\n").unwrap(),
            ["https://example.org/login?state=1"]
        );
        for url in [
            "http://example.org",
            "https://user:secret@example.org",
            "https://@example.org",
        ] {
            assert!(
                Urls::default()
                    .feed(
                        format!("Open the following link to authenticate the ACP server: {url}\n")
                            .as_bytes()
                    )
                    .is_err()
            );
        }
    }
}
