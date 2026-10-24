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

use std::{
    io::{self, Write},
    sync::mpsc,
    thread,
    time::Instant,
};

enum Request {
    Frame(Vec<Vec<u8>>, mpsc::SyncSender<io::Result<Instant>>),
    Close(Vec<u8>, mpsc::SyncSender<io::Result<()>>),
}

/// The only stdout owner. A receipt covers the original bytes and flush;
/// abandoning observation never replaces a partially written ANSI frame.
/// Frame receipts wake the creating driver thread; moving Output does not
/// change that wake target.
pub(super) struct Output {
    send: mpsc::SyncSender<Request>,
    pending: Option<mpsc::Receiver<io::Result<Instant>>>,
    flushed: Option<Instant>,
}

impl Output {
    pub fn new(mut writer: impl Write + Send + 'static) -> io::Result<Self> {
        // One frame plus one final cleanup, including before the worker has
        // picked up that frame. submit itself enforces a single frame.
        let (send, receive) = mpsc::sync_channel(2);
        let driver = thread::current();
        thread::Builder::new()
            .name("maka-nsh-output".into())
            .spawn(move || {
                while let Ok(request) = receive.recv() {
                    match request {
                        Request::Frame(parts, receipt) => {
                            let result = parts
                                .iter()
                                .try_for_each(|bytes| writer.write_all(bytes))
                                .and_then(|()| writer.flush());
                            let failed = result.is_err();
                            let result = result.map(|()| Instant::now());
                            let _ = receipt.send(result);
                            driver.unpark();
                            if failed {
                                break;
                            }
                        }
                        Request::Close(bytes, receipt) => {
                            let _ =
                                receipt.send(writer.write_all(&bytes).and_then(|_| writer.flush()));
                            break;
                        }
                    }
                }
            })?;
        Ok(Self {
            send,
            pending: None,
            flushed: None,
        })
    }

    /// All owned parts share one write-and-flush receipt. A final cursor
    /// sequence can follow an encoded image without reallocating its payload.
    pub fn submit(&mut self, parts: impl IntoIterator<Item = Vec<u8>>) -> Result<(), String> {
        if self.pending.is_some() {
            return Err("terminal frame still in flight".into());
        }
        let (send, receive) = mpsc::sync_channel(1);
        self.send
            .try_send(Request::Frame(parts.into_iter().collect(), send))
            .map_err(|error| error.to_string())?;
        self.pending = Some(receive);
        Ok(())
    }

    pub fn poll(&mut self) -> Result<bool, String> {
        let Some(receive) = &self.pending else {
            return Ok(true);
        };
        match receive.try_recv() {
            Ok(result) => {
                self.pending = None;
                result
                    .map(|flushed| {
                        self.flushed = Some(flushed);
                        true
                    })
                    .map_err(|error| error.to_string())
            }
            Err(mpsc::TryRecvError::Empty) => Ok(false),
            Err(mpsc::TryRecvError::Disconnected) => {
                Err("terminal output worker stopped before flush".into())
            }
        }
    }

    /// Actual writer flush time, rather than the time the driver polled its receipt.
    pub fn take_flushed(&mut self) -> Option<Instant> {
        self.flushed.take()
    }

    /// Queue restoration behind the current frame, without joining a writer
    /// that the terminal may have blocked indefinitely.
    pub fn close(self, cleanup: Vec<u8>) -> Result<mpsc::Receiver<io::Result<()>>, String> {
        let (send, receive) = mpsc::sync_channel(1);
        self.send
            .try_send(Request::Close(cleanup, send))
            .map_err(|error| error.to_string())?;
        Ok(receive)
    }
}

#[derive(Default)]
pub(super) struct FrameWriter(pub Vec<u8>);

impl Write for FrameWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0
            .len()
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("terminal output length overflow"))?;
        self.0.try_reserve(bytes.len()).map_err(io::Error::other)?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    struct GatedWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
        gate: mpsc::Receiver<()>,
        entered: mpsc::SyncSender<()>,
    }
    impl Write for GatedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if !bytes.is_empty() {
                let _ = self.entered.try_send(());
                self.gate
                    .recv()
                    .map_err(|_| io::Error::other("test gate closed"))?;
                // Force write_all to resume the original partial frame.
                self.bytes.lock().unwrap().push(bytes[0]);
                Ok(1)
            } else {
                Ok(0)
            }
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn query_flush_receipt_uses_the_actual_writer_time() {
        struct FlushGate {
            entered: mpsc::SyncSender<()>,
            release: Option<mpsc::Receiver<()>>,
        }
        impl Write for FlushGate {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                if let Some(release) = self.release.take() {
                    self.entered.send(()).unwrap();
                    release.recv().unwrap();
                }
                Ok(())
            }
        }
        let (entered, observing) = mpsc::sync_channel(1);
        let (release, gate) = mpsc::channel();
        let mut output = Output::new(FlushGate {
            entered,
            release: Some(gate),
        })
        .unwrap();
        output
            .submit([super::super::graphics::QUERY.to_vec()])
            .unwrap();
        observing.recv_timeout(Duration::from_secs(1)).unwrap();
        let before_flush = Instant::now();
        assert!(!output.poll().unwrap());
        assert!(output.take_flushed().is_none());
        thread::park_timeout(Duration::ZERO);
        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            thread::park_timeout(deadline.saturating_duration_since(Instant::now()));
            assert!(
                Instant::now() < deadline,
                "the flush receipt must wake its driver"
            );
            if output.poll().unwrap() {
                break;
            }
        }
        assert!(output.take_flushed().unwrap() >= before_flush);
        assert!(output.take_flushed().is_none());
        output
            .close(Vec::new())
            .unwrap()
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
    }

    #[test]
    fn large_clipboard_frame_finishes_before_cleanup_through_the_same_writer() {
        use base64::Engine as _;
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct ChunkedWriter {
            bytes: Arc<Mutex<Vec<u8>>>,
            first: Option<mpsc::Receiver<()>>,
            entered: mpsc::SyncSender<()>,
            flushes: Arc<AtomicUsize>,
        }
        impl Write for ChunkedWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if let Some(gate) = self.first.take() {
                    self.entered.send(()).unwrap();
                    gate.recv().unwrap();
                }
                let length = bytes.len().min(64 * 1024);
                self.bytes
                    .lock()
                    .unwrap()
                    .extend_from_slice(&bytes[..length]);
                Ok(length)
            }
            fn flush(&mut self) -> io::Result<()> {
                self.flushes.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }
        let original = "中😀".repeat(1_200_000);
        assert!(original.len() > 8 * 1024 * 1024);
        let clipboard =
            nsh_platform_tui::ServiceOutput::Clipboard(original.clone()).terminal_sequence(false);
        let encoded = clipboard
            .strip_prefix("\x1b]52;c;")
            .and_then(|bytes| bytes.strip_suffix("\x1b\\"))
            .expect("the complete clipboard must retain its original OSC52 envelope");
        assert!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap()
                == original.as_bytes()
        );
        let mut frame = FrameWriter::default();
        frame.write_all(b"PREFIX").unwrap();
        frame.write_all(clipboard.as_bytes()).unwrap();
        frame.write_all(b"EPILOGUE").unwrap();
        let expected = frame.0.clone();
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let flushes = Arc::new(AtomicUsize::new(0));
        let (release, gate) = mpsc::channel();
        let (entered, observing) = mpsc::sync_channel(1);
        let mut output = Output::new(ChunkedWriter {
            bytes: bytes.clone(),
            first: Some(gate),
            entered,
            flushes: flushes.clone(),
        })
        .unwrap();
        output.submit([frame.0]).unwrap();
        observing.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(!output.poll().unwrap());
        assert!(output.submit([b"replacement".to_vec()]).is_err());
        let closed = output.close(b"RESTORE".to_vec()).unwrap();
        assert!(matches!(closed.try_recv(), Err(mpsc::TryRecvError::Empty)));
        release.send(()).unwrap();
        closed
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        let written = bytes.lock().unwrap();
        assert!(
            written[..expected.len()] == expected,
            "the complete original large frame must be delivered once"
        );
        assert_eq!(&written[expected.len()..], b"RESTORE");
        assert_eq!(flushes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn blocked_output_finishes_upload_and_retirement_before_cleanup() {
        // The writer is protocol agnostic. This complete Kitty-shaped payload
        // includes the retirement suffix that must never become a second job.
        let transaction = b"\x1b[H\x1b_Ga=T,i=41,p=1,q=1,m=0;AAAA\x1b\\\x1b[?2026h\x1b_Ga=d,d=I,i=73,q=2\x1b\\\x1b[?2026l";
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let (gate, receive) = mpsc::channel();
        let (entered, observing) = mpsc::sync_channel(1);
        let mut output = Output::new(GatedWriter {
            bytes: bytes.clone(),
            gate: receive,
            entered,
        })
        .unwrap();
        output
            .submit([transaction.to_vec(), b"\x1b[7;19H".to_vec()])
            .unwrap();
        observing.recv_timeout(Duration::from_secs(1)).unwrap();
        let partial = transaction.len() / 2;
        for _ in 0..partial {
            gate.send(()).unwrap();
            observing.recv_timeout(Duration::from_secs(1)).unwrap();
        }
        assert_eq!(*bytes.lock().unwrap(), transaction[..partial]);
        assert!(!output.poll().unwrap());
        assert!(output.submit([b"replacement".to_vec()]).is_err());
        let closed = output.close(b"!".to_vec()).unwrap();
        assert!(matches!(closed.try_recv(), Err(mpsc::TryRecvError::Empty)));
        for _ in 0..transaction.len() - partial + b"\x1b[7;19H".len() + 1 {
            gate.send(()).unwrap();
        }
        closed
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert_eq!(
            *bytes.lock().unwrap(),
            [transaction.as_slice(), b"\x1b[7;19H", b"!"].concat()
        );
    }

    #[test]
    fn flush_failure_never_produces_a_success_receipt() {
        struct Failed;
        impl Write for Failed {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::other("flush failed"))
            }
        }
        let mut output = Output::new(Failed).unwrap();
        output.submit([b"frame".to_vec()]).unwrap();
        loop {
            match output.poll() {
                Ok(false) => thread::yield_now(),
                Err(error) => {
                    assert_eq!(error, "flush failed");
                    break;
                }
                Ok(true) => panic!("failed frame admitted"),
            }
        }
    }
}
