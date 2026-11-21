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

//! Resumable byte-window peer stream across physical carrier switchovers.
//!
//! Maintains a bounded unacknowledged outbound replay window (`MAX_WINDOW_BYTES`)
//! and allows replacing a broken or degraded physical carrier within a single
//! recovery deadline (`RECOVERY_TIMEOUT`) without dropping or corrupting the
//! upper WebSocket / Host RPC session.

use std::{
    collections::VecDeque,
    io,
    pin::Pin,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io::{
        AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf, ReadHalf,
        WriteHalf,
    },
    sync::{Notify, mpsc},
    time::Instant,
};
use uuid::Uuid;

pub const FRAME_HEADER_BYTES: usize = 13;
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_WINDOW_BYTES: usize = 2 * 1024 * 1024;
pub const RECOVERY_TIMEOUT: Duration = Duration::from_secs(30);

const FRAME_HELLO: u8 = 1;
const FRAME_DATA: u8 = 2;
const FRAME_ACK: u8 = 3;
const FRAME_FIN: u8 = 4;
const FRAME_REJECT: u8 = 5;

pub trait CarrierIo: AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static> CarrierIo for T {}

pub type BoxedCarrier = Box<dyn CarrierIo>;

type TerminalErrorSlot = Arc<OnceLock<(io::ErrorKind, String)>>;

#[derive(Debug, Error)]
pub enum ResumableStreamError {
    #[error("resumable stream control channel is closed")]
    Closed,
    #[error("resumable stream protocol violation: {0}")]
    Protocol(String),
    #[error("carrier I/O error: {0}")]
    Io(#[from] io::Error),
}

/// Handle used by the transport supervisor or dialer to attach a new physical
/// carrier when a peer switches network paths (e.g., Wi-Fi -> Hotspot or
/// Direct `A -> B` -> Relay `A -> C -> B`).
#[derive(Clone)]
pub struct ResumableStreamControl {
    stream_id: Uuid,
    tx: mpsc::Sender<BoxedCarrier>,
}

impl ResumableStreamControl {
    pub fn stream_id(&self) -> Uuid {
        self.stream_id
    }

    pub async fn replace_carrier(&self, carrier: BoxedCarrier) -> Result<(), ResumableStreamError> {
        self.tx
            .send(carrier)
            .await
            .map_err(|_| ResumableStreamError::Closed)
    }
}

/// Application-facing stream implementing `AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static`.
pub struct ResumablePeerStream {
    stream_id: Uuid,
    app_io: DuplexStream,
    terminal_error: TerminalErrorSlot,
    app_dropped: Arc<AtomicBool>,
    app_dropped_notify: Arc<Notify>,
}

impl ResumablePeerStream {
    pub fn new(stream_id: Uuid, initial_carrier: BoxedCarrier) -> (Self, ResumableStreamControl) {
        Self::with_recovery_timeout(stream_id, initial_carrier, RECOVERY_TIMEOUT)
    }

    pub fn with_recovery_timeout(
        stream_id: Uuid,
        initial_carrier: BoxedCarrier,
        recovery_timeout: Duration,
    ) -> (Self, ResumableStreamControl) {
        let (app_io, worker_io) = tokio::io::duplex(MAX_CHUNK_BYTES * 2);
        let (tx, rx) = mpsc::channel(4);
        let terminal_error = Arc::new(OnceLock::new());
        let app_dropped = Arc::new(AtomicBool::new(false));
        let app_dropped_notify = Arc::new(Notify::new());
        tokio::spawn(run_worker(
            stream_id,
            worker_io,
            initial_carrier,
            rx,
            recovery_timeout,
            terminal_error.clone(),
            app_dropped.clone(),
            app_dropped_notify.clone(),
        ));
        (
            Self {
                stream_id,
                app_io,
                terminal_error,
                app_dropped,
                app_dropped_notify,
            },
            ResumableStreamControl { stream_id, tx },
        )
    }

    pub fn stream_id(&self) -> Uuid {
        self.stream_id
    }

    fn terminal_io_error(&self) -> Option<io::Error> {
        self.terminal_error
            .get()
            .map(|(kind, msg)| io::Error::new(*kind, msg.clone()))
    }
}

impl Drop for ResumablePeerStream {
    fn drop(&mut self) {
        self.app_dropped.store(true, Ordering::Release);
        self.app_dropped_notify.notify_waiters();
    }
}

impl AsyncRead for ResumablePeerStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        match Pin::new(&mut self.app_io).poll_read(cx, buf) {
            Poll::Ready(Ok(())) if buf.filled().len() == before => {
                if let Some(err) = self.terminal_io_error() {
                    Poll::Ready(Err(err))
                } else {
                    Poll::Ready(Ok(()))
                }
            }
            Poll::Ready(Err(err)) => {
                Poll::Ready(Err(self.terminal_io_error().unwrap_or(err)))
            }
            other => other,
        }
    }
}

impl AsyncWrite for ResumablePeerStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if let Some(err) = self.terminal_io_error() {
            return Poll::Ready(Err(err));
        }
        match Pin::new(&mut self.app_io).poll_write(cx, buf) {
            Poll::Ready(Err(err)) => {
                Poll::Ready(Err(self.terminal_io_error().unwrap_or(err)))
            }
            other => other,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Some(err) = self.terminal_io_error() {
            return Poll::Ready(Err(err));
        }
        match Pin::new(&mut self.app_io).poll_flush(cx) {
            Poll::Ready(Err(err)) => {
                Poll::Ready(Err(self.terminal_io_error().unwrap_or(err)))
            }
            other => other,
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Some(err) = self.terminal_io_error() {
            return Poll::Ready(Err(err));
        }
        match Pin::new(&mut self.app_io).poll_shutdown(cx) {
            Poll::Ready(Err(err)) => {
                Poll::Ready(Err(self.terminal_io_error().unwrap_or(err)))
            }
            other => other,
        }
    }
}

struct OutboundChunk {
    offset: u64,
    bytes: Vec<u8>,
}

struct WorkerState {
    stream_id: Uuid,
    outbound_next_offset: u64,
    peer_acked_offset: u64,
    unacked: VecDeque<OutboundChunk>,
    unacked_bytes: usize,
    inbound_received_offset: u64,
    pending_app_out: VecDeque<u8>,
    local_fin_sent: bool,
    remote_fin_received: bool,
    worker_writer_shutdown: bool,
}

impl WorkerState {
    fn new(stream_id: Uuid) -> Self {
        Self {
            stream_id,
            outbound_next_offset: 0,
            peer_acked_offset: 0,
            unacked: VecDeque::new(),
            unacked_bytes: 0,
            inbound_received_offset: 0,
            pending_app_out: VecDeque::new(),
            local_fin_sent: false,
            remote_fin_received: false,
            worker_writer_shutdown: false,
        }
    }

    fn is_complete(&self) -> bool {
        self.local_fin_sent
            && self.remote_fin_received
            && self.peer_acked_offset == self.outbound_next_offset
            && self.pending_app_out.is_empty()
            && self.worker_writer_shutdown
    }

    fn record_outbound(&mut self, bytes: Vec<u8>) -> u64 {
        let offset = self.outbound_next_offset;
        let len = bytes.len();
        self.outbound_next_offset += len as u64;
        self.unacked_bytes += len;
        self.unacked.push_back(OutboundChunk { offset, bytes });
        offset
    }

    /// Advances `peer_acked_offset` and returns how many full chunks were
    /// popped from the front of `self.unacked`.
    fn apply_ack(&mut self, ack_offset: u64) -> Result<usize, ResumableStreamError> {
        if ack_offset > self.outbound_next_offset {
            return Err(ResumableStreamError::Protocol(format!(
                "peer acked offset {ack_offset} beyond outbound offset {}",
                self.outbound_next_offset
            )));
        }
        if ack_offset <= self.peer_acked_offset {
            return Ok(0);
        }
        self.peer_acked_offset = ack_offset;
        let mut popped = 0usize;
        while let Some(front) = self.unacked.front() {
            let front_end = front.offset + front.bytes.len() as u64;
            if front_end <= ack_offset {
                let removed = self.unacked.pop_front().expect("front checked");
                self.unacked_bytes = self.unacked_bytes.saturating_sub(removed.bytes.len());
                popped += 1;
            } else if front.offset < ack_offset {
                let trim = (ack_offset - front.offset) as usize;
                let front_mut = self.unacked.front_mut().expect("front checked");
                front_mut.bytes.drain(..trim);
                front_mut.offset = ack_offset;
                self.unacked_bytes = self.unacked_bytes.saturating_sub(trim);
                break;
            } else {
                break;
            }
        }
        Ok(popped)
    }
}

#[derive(Default)]
struct FrameDecoder {
    buf: Vec<u8>,
    pos: usize,
}

impl FrameDecoder {
    fn push(&mut self, bytes: &[u8]) {
        if self.pos > 0 && (self.pos >= 4096 || self.pos * 2 >= self.buf.len()) {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    fn next_frame(&mut self) -> Result<Option<(u8, u64, Vec<u8>)>, ResumableStreamError> {
        let remaining = self.buf.len() - self.pos;
        if remaining < FRAME_HEADER_BYTES {
            return Ok(None);
        }
        let header = &self.buf[self.pos..self.pos + FRAME_HEADER_BYTES];
        let kind = header[0];
        if !matches!(kind, FRAME_HELLO | FRAME_DATA | FRAME_ACK | FRAME_FIN | FRAME_REJECT) {
            return Err(ResumableStreamError::Protocol(format!(
                "unknown resumable frame kind {kind}"
            )));
        }
        let seq_or_ack = u64::from_be_bytes(header[1..9].try_into().expect("8 bytes"));
        let len = u32::from_be_bytes(header[9..13].try_into().expect("4 bytes")) as usize;
        if len > MAX_CHUNK_BYTES {
            return Err(ResumableStreamError::Protocol(format!(
                "resumable frame payload {len} exceeds MAX_CHUNK_BYTES ({MAX_CHUNK_BYTES})"
            )));
        }
        if remaining < FRAME_HEADER_BYTES + len {
            return Ok(None);
        }
        let payload_start = self.pos + FRAME_HEADER_BYTES;
        let payload_end = payload_start + len;
        let payload = self.buf[payload_start..payload_end].to_vec();
        self.pos = payload_end;
        if self.pos == self.buf.len() {
            self.buf.clear();
            self.pos = 0;
        }
        Ok(Some((kind, seq_or_ack, payload)))
    }
}

fn enqueue_frame(out: &mut VecDeque<u8>, kind: u8, seq_or_ack: u64, payload: &[u8]) {
    debug_assert!(payload.len() <= MAX_CHUNK_BYTES);
    let mut header = [0u8; FRAME_HEADER_BYTES];
    header[0] = kind;
    header[1..9].copy_from_slice(&seq_or_ack.to_be_bytes());
    header[9..13].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend(header);
    out.extend(payload);
}

async fn send_reject_best_effort(carrier_writer: &mut WriteHalf<BoxedCarrier>, reason: &str) {
    let mut buf = VecDeque::new();
    let payload = &reason.as_bytes()[..reason.len().min(256)];
    enqueue_frame(&mut buf, FRAME_REJECT, 0, payload);
    let (front, back) = buf.as_slices();
    let _ = tokio::time::timeout(Duration::from_millis(50), async {
        let _ = carrier_writer.write_all(front).await;
        if !back.is_empty() {
            let _ = carrier_writer.write_all(back).await;
        }
        let _ = carrier_writer.flush().await;
    })
    .await;
}

enum CarrierExit {
    Completed,
    Replaced(BoxedCarrier),
    Disconnected,
    Fatal(io::ErrorKind, String),
}

#[allow(clippy::too_many_arguments)]
async fn run_worker(
    stream_id: Uuid,
    worker_io: DuplexStream,
    initial_carrier: BoxedCarrier,
    mut control_rx: mpsc::Receiver<BoxedCarrier>,
    recovery_timeout: Duration,
    terminal_error: TerminalErrorSlot,
    app_dropped: Arc<AtomicBool>,
    app_dropped_notify: Arc<Notify>,
) {
    let (mut worker_reader, mut worker_writer) = tokio::io::split(worker_io);
    let mut state = WorkerState::new(stream_id);
    let mut current_carrier = Some(initial_carrier);
    let mut control_open = true;
    let mut recovery_deadline: Option<Instant> = Some(Instant::now() + recovery_timeout);

    while !state.is_complete() {
        if app_dropped.load(Ordering::Acquire)
            && state.local_fin_sent
            && state.peer_acked_offset == state.outbound_next_offset
        {
            break;
        }
        let carrier = match current_carrier.take() {
            Some(carrier) => carrier,
            None => {
                if !control_open {
                    let _ = terminal_error.set((
                        io::ErrorKind::BrokenPipe,
                        "resumable peer stream disconnected with no control handle".into(),
                    ));
                    break;
                }
                let deadline = *recovery_deadline
                    .get_or_insert_with(|| Instant::now() + recovery_timeout);
                let next = wait_for_replacement_carrier(
                    &mut state,
                    &mut worker_writer,
                    &mut control_rx,
                    &mut control_open,
                    deadline,
                    &app_dropped,
                    &app_dropped_notify,
                )
                .await;
                match next {
                    Ok(Some(carrier)) => carrier,
                    Ok(None) => break,
                    Err((kind, msg)) => {
                        let _ = terminal_error.set((kind, msg));
                        break;
                    }
                }
            }
        };

        match drive_carrier(
            &mut state,
            &mut worker_reader,
            &mut worker_writer,
            carrier,
            &mut control_rx,
            &mut control_open,
            &mut recovery_deadline,
            recovery_timeout,
            &app_dropped,
            &app_dropped_notify,
        )
        .await
        {
            CarrierExit::Completed => break,
            CarrierExit::Replaced(next) => {
                recovery_deadline.get_or_insert_with(|| Instant::now() + recovery_timeout);
                current_carrier = Some(next);
            }
            CarrierExit::Disconnected => {
                recovery_deadline.get_or_insert_with(|| Instant::now() + recovery_timeout);
            }
            CarrierExit::Fatal(kind, msg) => {
                let _ = terminal_error.set((kind, msg));
                break;
            }
        }
    }
}

async fn wait_for_replacement_carrier(
    state: &mut WorkerState,
    worker_writer: &mut WriteHalf<DuplexStream>,
    control_rx: &mut mpsc::Receiver<BoxedCarrier>,
    control_open: &mut bool,
    deadline: Instant,
    app_dropped: &AtomicBool,
    app_dropped_notify: &Notify,
) -> Result<Option<BoxedCarrier>, (io::ErrorKind, String)> {
    loop {
        if app_dropped.load(Ordering::Acquire) {
            return Ok(None);
        }
        let has_app_out = !state.pending_app_out.is_empty();
        tokio::select! {
            _ = app_dropped_notify.notified() => {
                if app_dropped.load(Ordering::Acquire) {
                    return Ok(None);
                }
            }
            () = tokio::time::sleep_until(deadline) => {
                return Err((
                    io::ErrorKind::TimedOut,
                    "resumable peer stream recovery timeout expired".into(),
                ));
            }
            maybe_next = control_rx.recv(), if *control_open => {
                match maybe_next {
                    Some(carrier) => return Ok(Some(carrier)),
                    None => {
                        *control_open = false;
                        return Err((
                            io::ErrorKind::BrokenPipe,
                            "resumable peer stream control closed while disconnected".into(),
                        ));
                    }
                }
            }
            write_res = async {
                let (front, _) = state.pending_app_out.as_slices();
                worker_writer.write(front).await
            }, if has_app_out => {
                match write_res {
                    Ok(0) | Err(_) => {
                        state.pending_app_out.clear();
                        if app_dropped.load(Ordering::Acquire) {
                            return Ok(None);
                        }
                    }
                    Ok(n) => {
                        state.pending_app_out.drain(..n);
                        if state.remote_fin_received && state.pending_app_out.is_empty() && !state.worker_writer_shutdown {
                            let _ = worker_writer.shutdown().await;
                            state.worker_writer_shutdown = true;
                        }
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive_carrier(
    state: &mut WorkerState,
    worker_reader: &mut ReadHalf<DuplexStream>,
    worker_writer: &mut WriteHalf<DuplexStream>,
    carrier: BoxedCarrier,
    control_rx: &mut mpsc::Receiver<BoxedCarrier>,
    control_open: &mut bool,
    recovery_deadline: &mut Option<Instant>,
    recovery_timeout: Duration,
    app_dropped: &AtomicBool,
    app_dropped_notify: &Notify,
) -> CarrierExit {
    let (mut carrier_reader, mut carrier_writer) = tokio::io::split(carrier);
    let mut decoder = FrameDecoder::default();
    let mut carrier_out = VecDeque::new();
    enqueue_frame(
        &mut carrier_out,
        FRAME_HELLO,
        state.inbound_received_offset,
        state.stream_id.as_bytes(),
    );

    let mut handshake_received = false;
    let mut replay_cursor = 0usize;
    let mut fin_queued_on_carrier = false;
    let mut carrier_read_buf = vec![0u8; MAX_CHUNK_BYTES];
    let mut app_read_buf = vec![0u8; MAX_CHUNK_BYTES];

    loop {
        if app_dropped.load(Ordering::Acquire)
            && state.local_fin_sent
            && state.peer_acked_offset == state.outbound_next_offset
            && carrier_out.is_empty()
        {
            let _ = carrier_writer.flush().await;
            return CarrierExit::Completed;
        }
        if state.remote_fin_received
            && state.pending_app_out.is_empty()
            && !state.worker_writer_shutdown
        {
            let _ = worker_writer.shutdown().await;
            state.worker_writer_shutdown = true;
        }
        if handshake_received && carrier_out.len() < MAX_CHUNK_BYTES {
            while replay_cursor < state.unacked.len() && carrier_out.len() < MAX_CHUNK_BYTES {
                let chunk = &state.unacked[replay_cursor];
                enqueue_frame(&mut carrier_out, FRAME_DATA, chunk.offset, &chunk.bytes);
                replay_cursor += 1;
            }
            if replay_cursor >= state.unacked.len()
                && state.local_fin_sent
                && !fin_queued_on_carrier
            {
                enqueue_frame(&mut carrier_out, FRAME_FIN, state.outbound_next_offset, &[]);
                fin_queued_on_carrier = true;
            }
        }
        if state.is_complete() && carrier_out.is_empty() {
            let _ = carrier_writer.flush().await;
            return CarrierExit::Completed;
        }

        let handshake_deadline = if !handshake_received {
            Some(*recovery_deadline.get_or_insert_with(|| Instant::now() + recovery_timeout))
        } else {
            None
        };
        let has_carrier_out = !carrier_out.is_empty();
        let has_app_out = !state.pending_app_out.is_empty();
        let can_read_carrier = state.pending_app_out.len() < MAX_WINDOW_BYTES;
        let can_read_app = handshake_received
            && !state.local_fin_sent
            && replay_cursor >= state.unacked.len()
            && state.unacked_bytes < MAX_WINDOW_BYTES
            && carrier_out.len() < MAX_CHUNK_BYTES * 2;

        let can_exit_on_drop = state.local_fin_sent
            && state.peer_acked_offset == state.outbound_next_offset
            && carrier_out.is_empty();

        tokio::select! {
            _ = app_dropped_notify.notified(), if can_exit_on_drop => {
                if app_dropped.load(Ordering::Acquire) {
                    let _ = carrier_writer.flush().await;
                    return CarrierExit::Completed;
                }
            }
            () = async {
                if let Some(deadline) = handshake_deadline {
                    tokio::time::sleep_until(deadline).await;
                }
            }, if handshake_deadline.is_some() => {
                return CarrierExit::Fatal(
                    io::ErrorKind::TimedOut,
                    "resumable peer stream handshake timed out".into(),
                );
            }
            maybe_next = control_rx.recv(), if *control_open => {
                match maybe_next {
                    Some(next_carrier) => return CarrierExit::Replaced(next_carrier),
                    None => *control_open = false,
                }
            }
            write_res = async {
                let (front, _) = carrier_out.as_slices();
                carrier_writer.write(front).await
            }, if has_carrier_out => {
                match write_res {
                    Ok(0) | Err(_) => return CarrierExit::Disconnected,
                    Ok(n) => {
                        carrier_out.drain(..n);
                        if carrier_out.is_empty() && carrier_writer.flush().await.is_err() {
                            return CarrierExit::Disconnected;
                        }
                    }
                }
            }
            app_write_res = async {
                let (front, _) = state.pending_app_out.as_slices();
                worker_writer.write(front).await
            }, if has_app_out => {
                match app_write_res {
                    Ok(0) | Err(_) => {
                        state.pending_app_out.clear();
                        if app_dropped.load(Ordering::Acquire) {
                            return CarrierExit::Completed;
                        }
                    }
                    Ok(n) => {
                        state.pending_app_out.drain(..n);
                    }
                }
            }
            read_res = carrier_reader.read(&mut carrier_read_buf), if can_read_carrier => {
                let n = match read_res {
                    Ok(0) | Err(_) => return CarrierExit::Disconnected,
                    Ok(n) => n,
                };
                decoder.push(&carrier_read_buf[..n]);
                loop {
                    let frame = match decoder.next_frame() {
                        Ok(Some(frame)) => frame,
                        Ok(None) => break,
                        Err(err) => {
                            return CarrierExit::Fatal(io::ErrorKind::InvalidData, err.to_string());
                        }
                    };
                    let (kind, seq_or_ack, payload) = frame;
                    if kind == FRAME_REJECT {
                        let reason = String::from_utf8_lossy(&payload);
                        return CarrierExit::Fatal(
                            io::ErrorKind::InvalidData,
                            format!("peer rejected resumable stream: {reason}"),
                        );
                    }
                    if !handshake_received {
                        if kind != FRAME_HELLO || payload.len() != 16 {
                            let msg = "expected 16-byte FRAME_HELLO handshake".to_owned();
                            send_reject_best_effort(&mut carrier_writer, &msg).await;
                            return CarrierExit::Fatal(io::ErrorKind::InvalidData, msg);
                        }
                        let peer_stream_id = match Uuid::from_slice(&payload) {
                            Ok(id) => id,
                            Err(err) => {
                                let msg = err.to_string();
                                send_reject_best_effort(&mut carrier_writer, &msg).await;
                                return CarrierExit::Fatal(io::ErrorKind::InvalidData, msg);
                            }
                        };
                        if peer_stream_id != state.stream_id {
                            let msg = format!(
                                "stream_id mismatch: expected {}, got {peer_stream_id}",
                                state.stream_id
                            );
                            send_reject_best_effort(&mut carrier_writer, &msg).await;
                            return CarrierExit::Fatal(io::ErrorKind::InvalidData, msg);
                        }
                        if let Err(err) = state.apply_ack(seq_or_ack) {
                            let msg = err.to_string();
                            send_reject_best_effort(&mut carrier_writer, &msg).await;
                            return CarrierExit::Fatal(io::ErrorKind::InvalidData, msg);
                        }
                        handshake_received = true;
                        *recovery_deadline = None;
                        replay_cursor = 0;
                        fin_queued_on_carrier = false;
                        continue;
                    }
                    match kind {
                        FRAME_HELLO => {
                            let msg = "unexpected duplicate FRAME_HELLO".to_owned();
                            send_reject_best_effort(&mut carrier_writer, &msg).await;
                            return CarrierExit::Fatal(io::ErrorKind::InvalidData, msg);
                        }
                        FRAME_DATA => {
                            if payload.is_empty() {
                                return CarrierExit::Fatal(
                                    io::ErrorKind::InvalidData,
                                    "empty FRAME_DATA payload".into(),
                                );
                            }
                            if state.remote_fin_received {
                                return CarrierExit::Fatal(
                                    io::ErrorKind::InvalidData,
                                    "received FRAME_DATA after FRAME_FIN".into(),
                                );
                            }
                            if seq_or_ack > state.inbound_received_offset {
                                return CarrierExit::Fatal(
                                    io::ErrorKind::InvalidData,
                                    "out-of-order FRAME_DATA gap".into(),
                                );
                            }
                            let Some(end_offset) = seq_or_ack.checked_add(payload.len() as u64) else {
                                return CarrierExit::Fatal(
                                    io::ErrorKind::InvalidData,
                                    "FRAME_DATA offset overflow".into(),
                                );
                            };
                            if end_offset > state.inbound_received_offset {
                                let skip = (state.inbound_received_offset - seq_or_ack) as usize;
                                state.pending_app_out.extend(&payload[skip..]);
                                state.inbound_received_offset = end_offset;
                            }
                            enqueue_frame(
                                &mut carrier_out,
                                FRAME_ACK,
                                state.inbound_received_offset,
                                &[],
                            );
                        }
                        FRAME_ACK => match state.apply_ack(seq_or_ack) {
                            Ok(popped) => {
                                replay_cursor = replay_cursor.saturating_sub(popped);
                            }
                            Err(err) => {
                                return CarrierExit::Fatal(io::ErrorKind::InvalidData, err.to_string());
                            }
                        },
                        FRAME_FIN => {
                            if seq_or_ack != state.inbound_received_offset {
                                return CarrierExit::Fatal(
                                    io::ErrorKind::InvalidData,
                                    "FRAME_FIN offset does not match received stream offset".into(),
                                );
                            }
                            state.remote_fin_received = true;
                            enqueue_frame(
                                &mut carrier_out,
                                FRAME_ACK,
                                state.inbound_received_offset,
                                &[],
                            );
                        }
                        _ => unreachable!(),
                    }
                }
            }
            app_read_res = worker_reader.read(&mut app_read_buf), if can_read_app => {
                match app_read_res {
                    Ok(0) => {
                        state.local_fin_sent = true;
                        enqueue_frame(&mut carrier_out, FRAME_FIN, state.outbound_next_offset, &[]);
                        fin_queued_on_carrier = true;
                    }
                    Ok(n) => {
                        let slice = &app_read_buf[..n];
                        let offset = state.record_outbound(slice.to_vec());
                        replay_cursor = state.unacked.len();
                        enqueue_frame(&mut carrier_out, FRAME_DATA, offset, slice);
                    }
                    Err(_) => return CarrierExit::Completed,
                }
            }
        }
    }
}
