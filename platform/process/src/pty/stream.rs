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

use maka_plugin_core::terminal::TerminalSize;
use rustix::fd::OwnedFd;
use std::{io, sync::Arc};
use tokio::io::unix::AsyncFd;

/// A single reader and a single serialized writer may run concurrently.
/// Native bytes are decoded incrementally by the resource worker, not per read.
pub struct PtyIo {
    pub(super) master: Arc<AsyncFd<OwnedFd>>,
}

impl PtyIo {
    /// Unix has no output peer to disconnect. The owner drops both master
    /// references after root wait; this hook only unblocks ConPTY close.
    pub fn discard_output(&self) -> io::Result<()> {
        Ok(())
    }

    pub async fn read(&self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            let mut ready = self.master.readable().await?;
            match ready.try_io(|inner| {
                match rustix::io::read(inner.get_ref(), &mut *buffer) {
                    Ok(count) => Ok(count),
                    // Linux PTYs report EIO once their final slave closes.
                    Err(rustix::io::Errno::IO) => Ok(0),
                    Err(error) => Err(io::Error::from(error)),
                }
            }) {
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => continue,
                Ok(result) => return result,
                Err(_) => continue,
            }
        }
    }

    /// Return the accepted prefix count, never hide partial writes. The resource
    /// worker journals partial/unknown effects if a control cut cannot finish.
    pub async fn write(&self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            let mut ready = self.master.writable().await?;
            match ready
                .try_io(|inner| rustix::io::write(inner.get_ref(), buffer).map_err(io::Error::from))
            {
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => continue,
                Ok(result) => return result,
                Err(_) => continue,
            }
        }
    }
}

pub(super) fn resize(master: &OwnedFd, size: TerminalSize) -> io::Result<()> {
    rustix::termios::tcsetwinsize(
        master,
        rustix::termios::Winsize {
            ws_col: size.cols(),
            ws_row: size.rows(),
            ws_xpixel: 0,
            ws_ypixel: 0,
        },
    )
    .map_err(Into::into)
}
