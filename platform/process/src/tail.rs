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

use std::{collections::VecDeque, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

pub(crate) const TAIL_BYTES: usize = 65_536;
pub(crate) const DRAIN: Duration = Duration::from_secs(2);

pub(crate) struct Tail {
    bytes: VecDeque<u8>,
    limit: usize,
    pub prefix_dropped: bool,
    pub reached_eof: bool,
}

impl Tail {
    fn push(&mut self, bytes: &[u8]) {
        let overflow = (self.bytes.len() + bytes.len()).saturating_sub(self.limit);
        if overflow > 0 {
            self.prefix_dropped = true;
            self.bytes.drain(..overflow.min(self.bytes.len()));
        }
        self.bytes
            .extend(&bytes[bytes.len().saturating_sub(self.limit)..]);
    }

    pub fn truncated(&self) -> bool {
        self.prefix_dropped || !self.reached_eof
    }

    pub fn text(&mut self) -> String {
        let mut start = 0;
        // A byte tail can begin inside a valid UTF-8 code point.
        if self.prefix_dropped {
            while start < self.bytes.len() && self.bytes[start] & 0xc0 == 0x80 {
                start += 1;
            }
        }
        let text = String::from_utf8_lossy(&self.bytes.make_contiguous()[start..]);
        // Invalid source bytes can expand to replacement characters.
        let mut start = text.len().saturating_sub(self.limit);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        self.prefix_dropped |= start > 0;
        text[start..].to_owned()
    }
}

pub(crate) async fn capture(
    mut pipe: impl AsyncRead + Unpin,
    exited: CancellationToken,
    limit: usize,
    observer: Option<(
        tokio::sync::mpsc::Sender<crate::PipeEvent>,
        maka_plugin_core::shell_run::PipeStream,
    )>,
) -> Tail {
    let mut tail = Tail {
        bytes: VecDeque::new(),
        limit,
        prefix_dropped: false,
        reached_eof: false,
    };
    let deadline = async {
        exited.cancelled().await;
        tokio::time::sleep(DRAIN).await
    };
    tokio::pin!(deadline);
    let mut buffer = [0; 8192];
    loop {
        tokio::select! {
            biased;
            _ = &mut deadline => break,
            read = pipe.read(&mut buffer) => match read {
                Ok(0) => {
                    tail.reached_eof = true;
                    break;
                }
                Ok(n) => {
                    tail.push(&buffer[..n]);
                    if let Some((observer, stream)) = &observer {
                        // The bounded observer may apply backpressure, but root
                        // exit still bounds drain even if its consumer stops.
                        let event = crate::PipeEvent::Output { stream: *stream, bytes: buffer[..n].to_vec() };
                        tokio::select! {
                            biased;
                            _ = &mut deadline => break,
                            _ = observer.send(event) => {}
                        }
                    }
                },
                Err(_) => break,
            }
        }
    }
    tail
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io,
        pin::Pin,
        task::{Context, Poll},
    };

    struct FailAfter {
        chunk: Option<&'static [u8]>,
    }

    impl AsyncRead for FailAfter {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if let Some(bytes) = self.chunk.take() {
                buf.put_slice(bytes);
                Poll::Ready(Ok(()))
            } else {
                Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "pipe failed",
                )))
            }
        }
    }

    #[tokio::test]
    async fn capture_distinguishes_prefix_overflow_from_incomplete_reads() {
        let mut overflow = capture(
            io::Cursor::new(b"dropped-line\n{\"trigger\":true}\n"),
            CancellationToken::new(),
            20,
            None,
        )
        .await;
        assert_eq!(overflow.text(), "ne\n{\"trigger\":true}\n");
        assert!(overflow.prefix_dropped);
        assert!(overflow.reached_eof);
        assert!(overflow.truncated());

        let mut failed = capture(
            FailAfter {
                chunk: Some(b"checking\ntrue\n"),
            },
            CancellationToken::new(),
            64,
            None,
        )
        .await;
        assert_eq!(failed.text(), "checking\ntrue\n");
        assert!(!failed.prefix_dropped);
        assert!(!failed.reached_eof);
        assert!(failed.truncated());
    }
}
