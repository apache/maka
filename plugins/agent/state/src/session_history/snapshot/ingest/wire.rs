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
use super::*;
use maka_agent_facts::history_snapshot::ARCHIVE_MAGIC;
use std::io::{self, BufReader, Read, Seek, SeekFrom};

struct ArchiveReader<R> {
    input: R,
    hash: Sha256,
    bytes: u64,
    expected: u64,
}
impl<R: Read> Read for ArchiveReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let remaining = self
            .expected
            .checked_sub(self.bytes)
            .ok_or_else(|| io::Error::other("snapshot archive byte count overflow"))?;
        let size = usize::try_from(remaining.min(bytes.len() as u64)).map_err(io::Error::other)?;
        let count = self.input.read(&mut bytes[..size])?;
        self.bytes = self
            .bytes
            .checked_add(count as u64)
            .ok_or_else(|| io::Error::other("snapshot archive byte count overflow"))?;
        self.hash.update(&bytes[..count]);
        Ok(count)
    }
}
impl<R: Read> ArchiveReader<R> {
    fn number(&mut self) -> Result<u64, StoreError> {
        let mut bytes = [0u8; 8];
        self.read_exact(&mut bytes)?;
        Ok(u64::from_be_bytes(bytes))
    }
}
struct FrameReader<R> {
    input: R,
    hash: Sha256,
    bytes: u64,
}
impl<R: Read> Read for FrameReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.input.read(bytes)?;
        self.bytes = self
            .bytes
            .checked_add(count as u64)
            .ok_or_else(|| io::Error::other("snapshot frame byte count overflow"))?;
        self.hash.update(&bytes[..count]);
        Ok(count)
    }
}

pub(super) fn copy(
    c: &Connection,
    ingest: &str,
    expected: &maka_event_log::checkpoints::HistorySnapshot,
    file: &File,
) -> Result<ArchiveInventory, StoreError> {
    ContentRef {
        digest: format!("sha256:{}", expected.object.digest),
        bytes: expected.object.bytes,
    }
    .validate()
    .map_err(invalid)?;
    let inventory: ArchiveInventory = serde_json::from_slice(&expected.inventory)?;
    inventory.manifest.validate().map_err(invalid)?;
    if inventory.version != SNAPSHOT_VERSION || inventory.objects == 0 {
        return Err(invalid("invalid snapshot archive inventory"));
    }
    let mut file = file;
    file.seek(SeekFrom::Start(0))?;
    let mut input = ArchiveReader {
        input: BufReader::new(file),
        hash: Sha256::new(),
        bytes: 0,
        expected: expected.object.bytes,
    };
    let mut magic = [0u8; ARCHIVE_MAGIC.len()];
    input.read_exact(&mut magic)?;
    if magic != ARCHIVE_MAGIC {
        return Err(invalid("unsupported snapshot archive framing"));
    }
    let length = input.number()?;
    if length != expected.inventory.len() as u64 {
        return Err(invalid(
            "snapshot archive inventory differs from its original descriptor",
        ));
    }
    let mut buffer = [0u8; 64 * 1024];
    for expected in expected.inventory.chunks(buffer.len()) {
        input.read_exact(&mut buffer[..expected.len()])?;
        if &buffer[..expected.len()] != expected {
            return Err(invalid("snapshot archive inventory bytes changed"));
        }
    }
    if inventory
        .objects
        .checked_mul(8)
        .is_none_or(|minimum| minimum > input.expected - input.bytes)
    {
        return Err(invalid(
            "snapshot object count exceeds its declared archive bytes",
        ));
    }
    // Compact v1 ContentRef JSON has a structural maximum: fixed SHA-256 text
    // plus the largest valid byte-count integer, not a payload-size policy.
    let reference_limit = serde_json::to_vec(&ContentRef {
        digest: format!("sha256:{}", "f".repeat(64)),
        bytes: i64::MAX as u64,
    })?
    .len() as u64;
    for ordinal in 0..inventory.objects {
        let length = input.number()?;
        if length > reference_limit || length > input.expected - input.bytes {
            return Err(invalid("invalid version 1 snapshot reference framing"));
        }
        let mut encoded = vec![
            0u8;
            usize::try_from(length)
                .map_err(|_| invalid("snapshot reference length overflow"))?
        ];
        input.read_exact(&mut encoded)?;
        let reference: ContentRef = serde_json::from_slice(&encoded)?;
        reference.validate().map_err(invalid)?;
        if serde_json::to_vec(&reference)? != encoded
            || reference.bytes > input.expected - input.bytes
        {
            return Err(invalid(
                "snapshot frame differs from its declared canonical reference",
            ));
        }
        let mut frame = FrameReader {
            input: input.by_ref().take(reference.bytes),
            hash: Sha256::new(),
            bytes: 0,
        };
        let content =
            maka_event_log::content::put_stream(c, &reference.digest, reference.bytes, &mut frame)?;
        // The existing-digest path returns without consuming its reader.
        loop {
            if frame.read(&mut buffer)? == 0 {
                break;
            }
        }
        if frame.bytes != reference.bytes
            || format!("sha256:{}", hex::encode(frame.hash.finalize())) != reference.digest
        {
            return Err(invalid(
                "snapshot frame payload does not match its original reference",
            ));
        }
        let duplicate: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_ingest_frames WHERE ingest=? AND content_id=?)", params![ingest, content], |row| row.get(0))?;
        if duplicate {
            return Err(invalid(
                "snapshot archive repeats an immutable object frame",
            ));
        }
        c.execute(
            "INSERT INTO agent_history_snapshot_ingest_frames VALUES(?,?,?)",
            params![ingest, bind_u64(ordinal)?, content],
        )?;
    }
    if input.bytes != input.expected || input.input.read(&mut [0u8; 1])? != 0 {
        return Err(invalid(
            "snapshot archive is truncated or has trailing bytes",
        ));
    }
    if hex::encode(input.hash.finalize()) != expected.object.digest {
        return Err(invalid(
            "snapshot archive does not match its original object digest",
        ));
    }
    Ok(inventory)
}
