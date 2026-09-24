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
use crate::transport::{Frame, RpcError};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;

pub(super) async fn rpc<T: DeserializeOwned>(
    connection: &mut Connection,
    method: &str,
    params: &impl Serialize,
    timeout: Duration,
    send: &mpsc::Sender<Result<Value, Error>>,
    stderr: &mut Urls,
) -> Result<T, Error> {
    tokio::time::timeout(timeout, async {
        let expected = connection.request(method, params).await.map_err(provider)?;
        loop {
            match connection.next().await.map_err(provider)? {
                Frame::Response { id, result } if id == expected => {
                    let value = result.map_err(|error| {
                        Error::Provider(format!("ACP request failed ({})", error.code))
                    })?;
                    return serde_json::from_value(value).map_err(provider);
                }
                Frame::Response { .. } => {
                    return Err(Error::Provider("Unexpected ACP response identity".into()));
                }
                Frame::Request { id, .. } => connection
                    .respond(
                        id,
                        Err(RpcError {
                            code: -32601,
                            message: "Client callback unavailable during setup".into(),
                            data: None,
                        }),
                    )
                    .await
                    .map_err(provider)?,
                Frame::Notification { .. } => {}
                Frame::Stderr { bytes } => {
                    for url in stderr.feed(&bytes)? {
                        emit(send, json!({"kind":"authorization_url", "url":url})).await?;
                    }
                }
            }
        }
    })
    .await
    .map_err(|_| Error::Provider("External agent setup timed out".into()))?
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
