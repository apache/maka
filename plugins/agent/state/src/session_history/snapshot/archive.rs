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
use maka_agent_facts::history_snapshot::{ARCHIVE_MAGIC, ArchiveInventory};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
};

/// Owned prepared backing; it is not a caller-selected filesystem path.
pub struct ExportedSnapshot {
    pub history: maka_event_log::checkpoints::HistorySnapshot,
    pub file: File,
}
impl Snapshot {
    pub async fn export(&self, file: File) -> Result<ExportedSnapshot, StoreError> {
        let (mut sink, inventory, cut) = self.data.query(Start(self.clone(), file)).await?;
        let mut after = 0;
        loop {
            let result = self.data.query(Batch(self.clone(), sink, after)).await?;
            sink = result.sink;
            match result.next {
                Some(next) => after = next,
                None => break,
            }
        }
        let bytes = sink.bytes;
        let digest = hex::encode(sink.hash.finalize());
        let mut file = sink.file;
        // Flush/rewind an already owned private backing on the blocking lane.
        file = self.data.query(Finish(file)).await?;
        Ok(ExportedSnapshot {
            history: maka_event_log::checkpoints::HistorySnapshot {
                object: maka_event_log::checkpoints::ObjectRef { digest, bytes },
                inventory,
                cut,
            },
            file,
        })
    }
}
struct Sink {
    file: File,
    hash: Sha256,
    bytes: u64,
}
impl Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let written = self.file.write(bytes)?;
        self.hash.update(&bytes[..written]);
        self.bytes = self
            .bytes
            .checked_add(written as u64)
            .ok_or_else(|| std::io::Error::other("snapshot archive byte count overflow"))?;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}
struct Start(Snapshot, File);
impl Query for Start {
    type Output = (Sink, Vec<u8>, Vec<u8>);
    fn execute(mut self, c: &Connection) -> Result<Self::Output, StoreError> {
        let manifest = read::Header(self.0.clone()).execute(c)?;
        let count: u64 = c.query_row(
            "SELECT count(*) FROM agent_history_snapshot_pins WHERE snapshot=?",
            [self.0.id.to_string()],
            |r| read_u64(r, 0),
        )?;
        if manifest.objects != count {
            return Err(invalid("snapshot immutable object inventory incomplete"));
        }
        let inventory = serde_json::to_vec(&ArchiveInventory {
            version: SNAPSHOT_VERSION,
            manifest: self.0.manifest.clone(),
            objects: count,
        })?;
        let cut = serde_json::to_vec(&manifest.origin)?;
        self.1.set_len(0)?;
        self.1.seek(SeekFrom::Start(0))?;
        let mut sink = Sink {
            file: self.1,
            hash: Sha256::new(),
            bytes: 0,
        };
        sink.write_all(&ARCHIVE_MAGIC)?;
        sink.write_all(&(inventory.len() as u64).to_be_bytes())?;
        sink.write_all(&inventory)?;
        Ok((sink, inventory, cut))
    }
}
struct Batch(Snapshot, Sink, u64);
struct Written {
    sink: Sink,
    next: Option<u64>,
}
impl Query for Batch {
    type Output = Written;
    fn execute(mut self, c: &Connection) -> Result<Written, StoreError> {
        read::authorize(c, &self.0)?;
        let mut rows:Vec<(i64,String,u64)>=c.prepare_cached("SELECT b.id,b.content_sha256,length(b.payload) FROM agent_history_snapshot_pins p JOIN contents b ON b.id=p.content_id WHERE p.snapshot=? AND b.id>? ORDER BY b.id LIMIT 129")?.query_map(params![self.0.id.to_string(),bind_u64(self.2)?],|r|Ok((r.get(0)?,r.get(1)?,read_u64(r,2)?)))?.collect::<Result<_,_>>()?;
        let more = rows.len() > 128;
        rows.truncate(128);
        let next = if more {
            rows.last()
                .map(|row| {
                    u64::try_from(row.0).map_err(|_| invalid("negative immutable content identity"))
                })
                .transpose()?
        } else {
            None
        };
        for (row, digest, bytes) in rows {
            let reference = ContentRef { digest, bytes };
            let encoded = serde_json::to_vec(&reference)?;
            self.1.write_all(&(encoded.len() as u64).to_be_bytes())?;
            self.1.write_all(&encoded)?;
            super::super::sql::read_blob(c, row, &reference, |blob| {
                let mut hash = Sha256::new();
                let mut total = 0u64;
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    let read = blob.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    hash.update(&buffer[..read]);
                    self.1.write_all(&buffer[..read])?;
                    total = total
                        .checked_add(read as u64)
                        .ok_or_else(|| invalid("snapshot payload byte count overflow"))?;
                }
                if total != reference.bytes
                    || format!("sha256:{}", hex::encode(hash.finalize())) != reference.digest
                {
                    return Err(invalid(
                        "snapshot original payload does not match its canonical reference",
                    ));
                }
                Ok(())
            })?;
        }
        Ok(Written { sink: self.1, next })
    }
}
struct Finish(File);
impl Query for Finish {
    type Output = File;
    fn execute(mut self, _: &Connection) -> Result<File, StoreError> {
        self.0.flush()?;
        self.0.sync_all()?;
        self.0.seek(SeekFrom::Start(0))?;
        Ok(self.0)
    }
}
