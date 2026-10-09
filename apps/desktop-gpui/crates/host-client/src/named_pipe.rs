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

//! The Windows local IPC transport: a client end of the Host's named pipe.
//!
//! On Windows the Host listens with Node's `net.createServer` on
//! `\\.\pipe\maka-runtime-host-<first 16 characters of rootId>-<hostEpoch>`
//! and, before it accepts anyone, restricts the pipe to the current user and
//! SYSTEM (`prepareRuntimeHostEndpoint` and `secureWindowsNamedPipe` in
//! `packages/runtime-host/src/control/endpoint.ts`). The registration names
//! that path. Frames are the same newline-terminated JSON as on a Unix socket
//! (`frameLocalIpcProtocolMessage` in `transport/local-ipc-framing.ts`), so
//! everything above the byte stream is shared with Unix.
//!
//! Opening: the pipe is opened like a file, for reading and writing, with
//! `SECURITY_IDENTIFICATION` so the Host can identify this client but not
//! act as it. While every instance of the pipe is taken (`ERROR_PIPE_BUSY`),
//! the open is retried until the caller's deadline; the TS client waits the
//! same way through libuv (`WaitNamedPipeW`). A missing pipe is `NotFound`:
//! no Host is listening at that registration any more.
//!
//! Reading and writing at once: a handle opened for synchronous I/O
//! serializes every operation on it, so a read waiting for the Host would
//! hold back every write, and the client must always be able to write while
//! it waits for pushes. Overlapped I/O avoids that but needs `unsafe` calls
//! into the Win32 API, which this workspace forbids. The `interprocess`
//! crate reopens the handle for overlapped I/O and completes each read and
//! write on the thread that started it, so its receive half can wait in a
//! read on one thread while its send half writes on another. Each half runs
//! on the `blocking` thread pool through [`Unblock`].
//!
//! Closing: a named pipe has no half-close, and the handle closes only when
//! both halves are gone. The receive half's thread stays in its read until
//! the Host sends something, so after the pump ends the Host would keep the
//! connection open indefinitely. Dropping the send half therefore writes one
//! `host.status` request, whose answer ends that read; the handle then
//! closes and the Host sees the client leave. On a Unix socket the pump's
//! final `close` (a write shutdown) does the same job.

use std::io::{self, Write as _};
use std::os::windows::fs::OpenOptionsExt as _;
use std::os::windows::io::OwnedHandle;
use std::time::Duration;

use async_io::Timer;
use blocking::Unblock;
use host_protocol::{HostStatus, Operation as _, RequestFrame, encode_frame};
use interprocess::os::windows::named_pipe::{
    DuplexPipeStream, RecvPipeStream, SendPipeStream, pipe_mode,
};

/// `FILE_FLAG_OVERLAPPED` (`winbase.h`). `interprocess` reopens the handle
/// with it in any case; opening with it keeps the first handle compatible.
const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;

/// `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` (`winbase.h`): the
/// server may learn who the client is but may not impersonate it.
const SECURITY_IDENTIFICATION_ONLY: u32 = 0x0010_0000 | 0x0001_0000;

/// `ERROR_PIPE_BUSY` (`winerror.h`): every instance of the pipe is taken.
const ERROR_PIPE_BUSY: i32 = 231;

/// Wait between attempts while the pipe is busy.
const BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(20);

/// Bytes each half buffers between its thread and the pump.
const PIPE_BUFFER_BYTES: usize = 64 * 1024;

/// The receive half, read by the pump.
pub(crate) type PipeReader = Unblock<RecvPipeStream<pipe_mode::Bytes>>;

/// The send half, written by the pump.
pub(crate) type PipeWriter = Unblock<PipeSender>;

/// Opens the local named pipe at `path` and splits it into halves.
///
/// Retries while the pipe is busy, without a limit of its own: the caller
/// bounds it with its connect deadline.
pub(crate) async fn open(path: &str) -> io::Result<(PipeReader, PipeWriter)> {
    let stream = loop {
        let attempt = path.to_owned();
        match blocking::unblock(move || open_once(&attempt)).await {
            Ok(stream) => break stream,
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                Timer::after(BUSY_RETRY_INTERVAL).await;
            }
            Err(error) => return Err(error),
        }
    };
    let (receive, send) = stream.split();
    let sender = PipeSender { stream: Some(send), farewell: farewell_frame() };
    Ok((
        Unblock::with_capacity(PIPE_BUFFER_BYTES, receive),
        Unblock::with_capacity(PIPE_BUFFER_BYTES, sender),
    ))
}

/// One attempt to open the pipe. Blocks briefly; runs on the blocking pool.
fn open_once(path: &str) -> io::Result<DuplexPipeStream<pipe_mode::Bytes>> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_OVERLAPPED)
        .security_qos_flags(SECURITY_IDENTIFICATION_ONLY)
        .open(path)?;
    DuplexPipeStream::try_from(OwnedHandle::from(file)).map_err(io::Error::from)
}

/// A `host.status` request with a fresh id. On an accepted connection the
/// Host answers it; sent before the handshake completed it is a protocol
/// error and the Host closes the connection. Either ends the receive half's
/// read.
fn farewell_frame() -> Option<Vec<u8>> {
    let request = RequestFrame::new(
        uuid::Uuid::new_v4().to_string(),
        HostStatus::NAME,
        serde_json::Value::Object(serde_json::Map::new()),
    );
    encode_frame(&request).ok()
}

/// The send half of the pipe. Dropping it sends the farewell request (see
/// the module documentation).
pub(crate) struct PipeSender {
    /// Taken only by `drop`.
    stream: Option<SendPipeStream<pipe_mode::Bytes>>,
    farewell: Option<Vec<u8>>,
}

impl io::Write for PipeSender {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        match &mut self.stream {
            Some(stream) => stream.write(bytes),
            None => Err(io::ErrorKind::NotConnected.into()),
        }
    }

    /// Nothing to do: a completed write has handed the bytes to the pipe,
    /// where the Host reads them. `interprocess` would also wait until the
    /// Host has read them (`FlushFileBuffers`), which the framing does not
    /// need; it still does that once, on its own thread, when the handle
    /// closes.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for PipeSender {
    fn drop(&mut self) {
        let (Some(mut stream), Some(farewell)) = (self.stream.take(), self.farewell.take()) else {
            return;
        };
        // The write may wait for room in the pipe; never on the dropping
        // thread. It fails harmlessly when the Host has already gone.
        blocking::unblock(move || {
            if let Err(error) = stream.write_all(&farewell) {
                log::debug!("could not send the closing host.status request: {error}");
            }
        })
        .detach();
    }
}
