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

//! Request-local derived bytes; normal allocation admission never chooses spill.

use maka_agent_facts::model::prompt_source::source::ChargedBuffer;
use maka_capabilities::model_preparation::DirectoryLease;
use maka_event_log::context::semantic::{
    CapturedLocalResource, CapturedSource, close_request_file, create_request_file,
};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    ops::Range,
    sync::Arc,
};

/// The request capture owner retains this writer across jobs. Every file
/// operation runs on its original source worker; errors/cancellation await abort.
pub(crate) struct RequestBackingBuilder {
    storage: Option<Building>,
    length: u64,
    sealed: u64,
}
struct ResidentCharge {
    lease: DirectoryLease,
    _source: CapturedSource,
}
enum Building {
    Resident {
        bytes: Vec<u8>,
        owner: Arc<ResidentCharge>,
    },
    File {
        file: File,
        resource: CapturedLocalResource,
        source: CapturedSource,
    },
}

impl RequestBackingBuilder {
    /// Shared resident charge state, beyond the builder stored inline in its arena.
    pub(crate) const fn metadata_bytes() -> usize {
        arc_allocation_bytes::<ResidentCharge>()
    }

    /// The caller has reserved the complete known resident capacity atomically.
    pub(crate) fn resident(source: CapturedSource, lease: DirectoryLease) -> io::Result<Self> {
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(lease.capacity())
            .map_err(io::Error::other)?;
        if bytes.capacity() > lease.capacity() {
            return Err(io::Error::other(
                "backing allocator exceeds resident reservation",
            ));
        }
        Ok(Self {
            storage: Some(Building::Resident {
                bytes,
                owner: Arc::new(ResidentCharge {
                    lease,
                    _source: source,
                }),
            }),
            length: 0,
            sealed: 0,
        })
    }

    /// Only an individually oversized backing uses this branch. Reserve the
    /// resource before entering the callback; this method performs no admission.
    pub(crate) fn file(
        source: CapturedSource,
        resource: CapturedLocalResource,
    ) -> io::Result<Self> {
        match create_request_file() {
            Ok(file) => Ok(Self {
                storage: Some(Building::File {
                    file,
                    resource,
                    source,
                }),
                length: 0,
                sealed: 0,
            }),
            Err(error) => {
                resource.finish(Ok(()));
                Err(error)
            }
        }
    }

    pub(super) fn abort_in_worker(mut self) -> io::Result<()> {
        match self.storage.take().expect("unfinished backing") {
            Building::Resident { .. } => Ok(()),
            Building::File { file, resource, .. } => {
                let result = close_request_file(file);
                resource.finish(result.as_ref().map(|_| ()).map_err(ToString::to_string));
                result
            }
        }
    }

    /// Flush and freeze the current prefix without consuming its append owner.
    pub(crate) fn seal_prefix(&mut self) -> io::Result<u64> {
        self.flush()?;
        self.sealed = self.length;
        Ok(self.sealed)
    }

    /// Only intrinsic request size selects conversion; global congestion never does.
    /// The old resident allocation remains untouched until the file is complete.
    pub(crate) fn promote_to_file(&mut self, resource: CapturedLocalResource) -> io::Result<()> {
        let Building::Resident { owner, .. } = self.storage.as_ref().expect("unfinished backing")
        else {
            resource.finish(Ok(()));
            return Ok(());
        };
        let candidate = Self::file(owner._source.clone(), resource)?;
        self.copy_to_file(candidate)
    }

    fn copy_to_file(&mut self, mut candidate: Self) -> io::Result<()> {
        let Building::Resident { bytes, .. } = self.storage.as_ref().expect("resident conversion")
        else {
            unreachable!("only resident backing is converted");
        };
        let result = candidate.write_all(bytes).and_then(|()| candidate.flush());
        if let Err(write) = result {
            return match candidate.abort_in_worker() {
                Ok(()) => Err(write),
                Err(close) => Err(io::Error::other(WriteAndCloseError { write, close })),
            };
        }
        self.storage = candidate.storage.take();
        Ok(())
    }

    /// The caller's output retains the resident reservation through conversion.
    pub(crate) fn read_buffer_at(
        &mut self,
        offset: u64,
        mut buffer: ChargedBuffer,
        size: usize,
        read_owner: impl Send + Sync + 'static,
    ) -> io::Result<ChargedBuffer> {
        self.read_exact_at(offset, &mut buffer.as_mut()[..size])?;
        Ok(match self.storage.as_ref().expect("unfinished backing") {
            Building::Resident { owner, .. } => buffer.retain_owner((owner.clone(), read_owner)),
            Building::File { source, .. } => buffer.retain_owner((source.clone(), read_owner)),
        })
    }

    pub(crate) fn position(&self) -> u64 {
        self.length
    }

    pub(crate) fn append_bytes(&mut self, bytes: &[u8]) -> io::Result<Range<u64>> {
        let start = self.length;
        self.write_all(bytes)?;
        Ok(start..self.length)
    }

    /// Reserve a new zero-filled table in this backing; file regions stay sparse.
    pub(crate) fn reserve_zeroed(&mut self, bytes: u64) -> io::Result<Range<u64>> {
        let start = self.length;
        let end = start
            .checked_add(bytes)
            .ok_or_else(|| invalid("request backing offset overflows"))?;
        match self.storage.as_mut().expect("unfinished backing") {
            Building::Resident { bytes, owner } => {
                if end > owner.lease.capacity() as u64 {
                    return Err(io::Error::new(
                        io::ErrorKind::OutOfMemory,
                        "request backing exceeds its prepaid resident capacity",
                    ));
                }
                bytes.resize(usize::try_from(end).map_err(io::Error::other)?, 0);
            }
            Building::File { file, .. } => file.set_len(end)?,
        }
        self.length = end;
        Ok(start..end)
    }

    /// Scratch/fixed-record regions share the same file. This never extends a
    /// region, allocates a directory, or changes the append position.
    pub(crate) fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
        let range = checked_range(offset, bytes.len(), self.length)?;
        if offset < self.sealed && !bytes.is_empty() {
            return Err(invalid("cannot overwrite a published request prefix"));
        }
        match self.storage.as_mut().expect("unfinished backing") {
            Building::Resident { bytes: target, .. } => {
                target[range.start as usize..range.end as usize].copy_from_slice(bytes);
                Ok(())
            }
            Building::File { file, .. } => {
                file.seek(SeekFrom::Start(offset))?;
                file.write_all(bytes)
            }
        }
    }

    pub(crate) fn read_exact_at(&mut self, offset: u64, target: &mut [u8]) -> io::Result<()> {
        let range = checked_range(offset, target.len(), self.length)?;
        match self.storage.as_mut().expect("unfinished backing") {
            Building::Resident { bytes, .. } => {
                target.copy_from_slice(&bytes[range.start as usize..range.end as usize]);
                Ok(())
            }
            Building::File { file, .. } => {
                file.seek(SeekFrom::Start(offset))?;
                file.read_exact(target)
            }
        }
    }
}

impl Write for RequestBackingBuilder {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let end = self
            .length
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| invalid("request backing offset overflows"))?;
        let written = match self.storage.as_mut().expect("unfinished backing") {
            Building::Resident {
                bytes: target,
                owner,
                ..
            } => {
                if end > owner.lease.capacity() as u64 {
                    return Err(io::Error::new(
                        io::ErrorKind::OutOfMemory,
                        "request backing exceeds its prepaid resident capacity",
                    ));
                }
                target.extend_from_slice(bytes);
                bytes.len()
            }
            Building::File { file, .. } => {
                file.seek(SeekFrom::Start(self.length))?;
                file.write(bytes)?
            }
        };
        self.length += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        match self.storage.as_mut().expect("unfinished backing") {
            Building::Resident { .. } => Ok(()),
            Building::File { file, .. } => file.flush(),
        }
    }
}
impl Drop for RequestBackingBuilder {
    fn drop(&mut self) {
        if let Some(Building::File { file, resource, .. }) = self.storage.take() {
            resource.retain_original_material(
                file,
                "request backing builder lost its explicit cleanup owner".into(),
            );
        }
    }
}

#[derive(Debug)]
struct WriteAndCloseError {
    write: io::Error,
    close: io::Error,
}
impl std::fmt::Display for WriteAndCloseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}; closing request backing also failed: {}",
            self.write, self.close
        )
    }
}
impl std::error::Error for WriteAndCloseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.write)
    }
}

const fn arc_allocation_bytes<T>() -> usize {
    let data_alignment = std::mem::align_of::<T>();
    let header_alignment = std::mem::align_of::<usize>();
    let alignment = if data_alignment > header_alignment {
        data_alignment
    } else {
        header_alignment
    };
    let data_offset = (2 * std::mem::size_of::<usize>()).next_multiple_of(data_alignment);
    (data_offset + std::mem::size_of::<T>()).next_multiple_of(alignment)
}

fn checked_range(offset: u64, bytes: usize, length: u64) -> io::Result<Range<u64>> {
    let end = offset
        .checked_add(bytes as u64)
        .ok_or_else(|| invalid("request backing range overflows"))?;
    let range = offset..end;
    validate_range(&range, length)?;
    Ok(range)
}
fn validate_range(range: &Range<u64>, length: u64) -> io::Result<()> {
    if range.start > range.end || range.end > length {
        return Err(invalid("request backing range is outside published bytes"));
    }
    Ok(())
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests;
