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

use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

const TAIL_BYTES: usize = 65_536;
pub(crate) const DRAIN: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(crate) struct Tail {
    bytes: Vec<u8>,
    pub truncated: bool,
}

impl Tail {
    fn push(&mut self, bytes: &[u8]) {
        let overflow = (self.bytes.len() + bytes.len()).saturating_sub(TAIL_BYTES);
        if overflow > 0 {
            self.truncated = true;
            if overflow >= self.bytes.len() {
                self.bytes.clear();
                self.bytes
                    .extend_from_slice(&bytes[bytes.len().saturating_sub(TAIL_BYTES)..]);
                return;
            }
            self.bytes.drain(..overflow);
        }
        self.bytes.extend_from_slice(bytes);
    }

    pub fn text(&mut self) -> String {
        let mut start = 0;
        // A byte tail can begin inside a valid UTF-8 code point.
        if self.truncated {
            while start < self.bytes.len() && self.bytes[start] & 0xc0 == 0x80 {
                start += 1;
            }
        }
        let text = String::from_utf8_lossy(&self.bytes[start..]);
        // Invalid source bytes can expand to replacement characters.
        let mut start = text.len().saturating_sub(TAIL_BYTES);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        self.truncated |= start > 0;
        text[start..].to_owned()
    }
}

pub(crate) async fn capture(
    mut pipe: impl AsyncRead + Unpin,
    exited: CancellationToken,
    observer: Option<(
        tokio::sync::mpsc::Sender<crate::PipeEvent>,
        maka_plugin_core::shell_run::PipeStream,
    )>,
) -> Tail {
    let mut tail = Tail::default();
    let deadline = async {
        exited.cancelled().await;
        tokio::time::sleep(DRAIN).await
    };
    tokio::pin!(deadline);
    let mut buffer = [0; 8192];
    loop {
        tokio::select! {
            biased;
            _ = &mut deadline => { tail.truncated = true; break; }
            read = pipe.read(&mut buffer) => match read {
                Ok(0) => break,
                Ok(n) => {
                    tail.push(&buffer[..n]);
                    if let Some((observer, stream)) = &observer {
                        // The bounded observer may apply backpressure, but root
                        // exit still bounds drain even if its consumer stops.
                        let event = crate::PipeEvent::Output { stream: *stream, bytes: buffer[..n].to_vec() };
                        tokio::select! {
                            biased;
                            _ = &mut deadline => { tail.truncated = true; break; }
                            _ = observer.send(event) => {}
                        }
                    }
                },
                Err(_) => { tail.truncated = true; break; }
            }
        }
    }
    tail
}
