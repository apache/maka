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

use super::{Result, ShellError};
use maka_plugin_core::terminal::TerminalSize;
use std::{
    fs::File,
    io,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

const DATA_BYTES: usize = 16 * 1024;
const INDEX_BYTES: u64 = 16;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

/// Original native order, retained by this live resource and its existing readers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PtyStreamEvent {
    Data {
        sequence: u64,
        initial_size: TerminalSize,
        size: TerminalSize,
        bytes: Arc<[u8]>,
    },
    Resize {
        sequence: u64,
        initial_size: TerminalSize,
        size: TerminalSize,
    },
    Pending {
        after: u64,
        initial_size: TerminalSize,
        size: TerminalSize,
    },
    /// Byte-source closure, not process success or confirmed native cleanup.
    Closed {
        after: u64,
        initial_size: TerminalSize,
        size: TerminalSize,
    },
}
struct State {
    sequence: u64,
    size: TerminalSize,
    closed: bool,
    failure: Option<Arc<io::Error>>,
}
impl State {
    fn capacity(&self, count: u64) -> Result<()> {
        if let Some(error) = &self.failure {
            return Err(ShellError::Replay(error.clone()));
        }
        if self.closed || count > MAX_SEQUENCE - self.sequence {
            return Err(ShellError::Rejected(
                "PTY output sequence exhausted or closed",
            ));
        }
        Ok(())
    }
}
struct Files {
    payload: File,
    index: File,
}
#[derive(Clone)]
pub(super) struct Output(Arc<Shared>);
struct Shared {
    files: Files,
    // Only the private PTY worker appends. Observers never acquire this lock.
    writer: Mutex<u64>,
    state: Mutex<State>,
    initial_size: TerminalSize,
    changed: Notify,
}
/// A read-only cursor; retaining bytes never retains the native process.
pub struct PtyStream {
    output: Output,
    after: u64,
}
impl Output {
    pub fn new(size: TerminalSize) -> Result<Self> {
        Ok(Self(Arc::new(Shared {
            files: Files {
                payload: tempfile::tempfile()?,
                index: tempfile::tempfile()?,
            },
            writer: Mutex::new(0),
            state: Mutex::new(State {
                sequence: 0,
                size,
                closed: false,
                failure: None,
            }),
            initial_size: size,
            changed: Notify::new(),
        })))
    }
    pub fn stream(&self, after: u64) -> Result<PtyStream> {
        if after > self.0.state.lock().unwrap().sequence {
            return Err(ShellError::Rejected("PTY output cursor is in the future"));
        }
        Ok(PtyStream {
            output: self.clone(),
            after,
        })
    }
    /// Synchronous only on the original dedicated PTY worker, before decoding.
    pub fn publish(&self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let count = u64::try_from(bytes.len().div_ceil(DATA_BYTES))
            .map_err(|_| ShellError::Rejected("PTY output sequence exhausted"))?;
        let mut end = self.0.writer.lock().unwrap();
        self.0.state.lock().unwrap().capacity(count)?;
        for bytes in bytes.chunks(DATA_BYTES) {
            let size = self.0.state.lock().unwrap().size;
            self.append(&mut end, bytes, size)?;
        }
        Ok(())
    }
    fn append(&self, end: &mut u64, bytes: &[u8], size: TerminalSize) -> Result<()> {
        let sequence = self.0.state.lock().unwrap().sequence + 1;
        let written = (|| -> io::Result<u64> {
            let next = end
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| io::Error::other("PTY replay offset exhausted"))?;
            let mut index = [0; INDEX_BYTES as usize];
            index[..8].copy_from_slice(&end.to_le_bytes());
            index[8..12].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
            index[12..14].copy_from_slice(&size.cols().to_le_bytes());
            index[14..].copy_from_slice(&size.rows().to_le_bytes());
            write_all_at(&self.0.files.payload, bytes, *end)?;
            write_all_at(&self.0.files.index, &index, (sequence - 1) * INDEX_BYTES)?;
            Ok(next)
        })();
        match written {
            Ok(next) => {
                *end = next;
                let mut state = self.0.state.lock().unwrap();
                state.sequence = sequence;
                state.size = size;
                drop(state);
                self.0.changed.notify_waiters();
                Ok(())
            }
            Err(error) => {
                let error = Arc::new(error);
                self.0.state.lock().unwrap().failure = Some(error.clone());
                self.0.changed.notify_waiters();
                Err(ShellError::Replay(error))
            }
        }
    }
    pub fn check_resize(&self, size: TerminalSize) -> Result<()> {
        let state = self.0.state.lock().unwrap();
        state.capacity(u64::from(size != state.size))
    }
    pub fn resize(&self, size: TerminalSize) -> Result<()> {
        let mut end = self.0.writer.lock().unwrap();
        let state = self.0.state.lock().unwrap();
        state.capacity(u64::from(size != state.size))?;
        if size == state.size {
            return Ok(());
        }
        drop(state);
        self.append(&mut end, &[], size)
    }
    pub fn close(&self) {
        self.0.state.lock().unwrap().closed = true;
        self.0.changed.notify_waiters();
    }
}
impl PtyStream {
    /// Waits only on metadata, so cancellation never abandons filesystem work.
    pub async fn ready(&self) {
        loop {
            let changed = self.output.0.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let ready = {
                let state = self.output.0.state.lock().unwrap();
                self.after < state.sequence || state.closed || state.failure.is_some()
            };
            if ready {
                return;
            }
            changed.await;
        }
    }
    /// Once started, callers await this read before settling their original call.
    /// Coalesce adjacent Data up to the caller's byte budget. The sequence is
    /// the last original record consumed; every Resize remains a separate event.
    /// Only a successfully read Data/Resize advances the cursor.
    pub async fn read(&mut self, max_bytes: usize) -> Result<PtyStreamEvent> {
        if max_bytes < DATA_BYTES {
            return Err(ShellError::Rejected(
                "PTY replay budget is smaller than a native chunk",
            ));
        }
        let initial_size = self.output.0.initial_size;
        let through = {
            let state = self.output.0.state.lock().unwrap();
            if self.after == state.sequence {
                if let Some(error) = &state.failure {
                    return Err(ShellError::Replay(error.clone()));
                }
                return Ok(if state.closed {
                    PtyStreamEvent::Closed {
                        after: self.after,
                        initial_size,
                        size: state.size,
                    }
                } else {
                    PtyStreamEvent::Pending {
                        after: self.after,
                        initial_size,
                        size: state.size,
                    }
                });
            }
            state.sequence
        };
        let after = self.after;
        let output = self.output.clone();
        let (sequence, event) = tokio::task::spawn_blocking(move || -> Result<_> {
            // Reuse the native I/O granularity for index reads. No per-record
            // tasks or syscalls, and no reads beyond the committed high-water.
            let mut index = [0; DATA_BYTES];
            let mut sequence = after;
            let mut start = None;
            let mut length = 0;
            'records: while sequence < through && length < max_bytes {
                let count = (through - sequence).min((DATA_BYTES as u64) / INDEX_BYTES);
                let block = &mut index[..(count * INDEX_BYTES) as usize];
                read_exact_at(&output.0.files.index, block, sequence * INDEX_BYTES)?;
                for entry in block.as_chunks::<{ INDEX_BYTES as usize }>().0 {
                    let offset = u64::from_le_bytes(entry[..8].try_into().unwrap());
                    let bytes = u32::from_le_bytes(entry[8..12].try_into().unwrap()) as usize;
                    let size = TerminalSize::new(
                        u16::from_le_bytes(entry[12..14].try_into().unwrap()),
                        u16::from_le_bytes(entry[14..].try_into().unwrap()),
                    )
                    .map_err(|_| io::Error::other("invalid PTY replay size"))?;
                    if bytes > DATA_BYTES {
                        return Err(io::Error::other("invalid PTY replay length").into());
                    }
                    if bytes == 0 {
                        if sequence == after {
                            return Ok((
                                sequence + 1,
                                PtyStreamEvent::Resize {
                                    sequence: sequence + 1,
                                    initial_size,
                                    size,
                                },
                            ));
                        }
                        break 'records;
                    }
                    if bytes > max_bytes - length {
                        break 'records;
                    }
                    let (first_offset, first_size) = *start.get_or_insert((offset, size));
                    if size != first_size || first_offset.checked_add(length as u64) != Some(offset)
                    {
                        return Err(io::Error::other("invalid PTY replay continuation").into());
                    }
                    sequence += 1;
                    length += bytes;
                    if length == max_bytes {
                        break 'records;
                    }
                }
            }
            let (offset, size) = start.expect("nonempty committed data fits the delivery budget");
            let mut bytes = vec![0; length];
            read_exact_at(&output.0.files.payload, &mut bytes, offset)?;
            Ok((
                sequence,
                PtyStreamEvent::Data {
                    sequence,
                    initial_size,
                    size,
                    bytes: bytes.into(),
                },
            ))
        })
        .await
        .map_err(|_| ShellError::Rejected("PTY replay reader failed"))??;
        self.after = sequence;
        Ok(event)
    }
}
// Windows seek_read/seek_write change the shared file cursor. Every operation
// supplies an explicit offset; no observer or writer relies on that cursor.
fn read_exact_at(file: &File, mut bytes: &mut [u8], mut offset: u64) -> io::Result<()> {
    while !bytes.is_empty() {
        #[cfg(unix)]
        let result = std::os::unix::fs::FileExt::read_at(file, bytes, offset);
        #[cfg(windows)]
        let result = std::os::windows::fs::FileExt::seek_read(file, bytes, offset);
        match result {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => {
                offset = offset
                    .checked_add(n as u64)
                    .ok_or_else(|| io::Error::other("PTY replay offset exhausted"))?;
                bytes = &mut bytes[n..];
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
fn write_all_at(file: &File, mut bytes: &[u8], mut offset: u64) -> io::Result<()> {
    while !bytes.is_empty() {
        #[cfg(unix)]
        let result = std::os::unix::fs::FileExt::write_at(file, bytes, offset);
        #[cfg(windows)]
        let result = std::os::windows::fs::FileExt::seek_write(file, bytes, offset);
        match result {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(n) => {
                offset = offset
                    .checked_add(n as u64)
                    .ok_or_else(|| io::Error::other("PTY replay offset exhausted"))?;
                bytes = &bytes[n..];
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
