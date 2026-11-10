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

use crate::{Error, Fingerprint};
use maka_capabilities::filesystem::{PinnedFile, PinnedReader, ReadRange};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{sync::mpsc, task::JoinHandle};

pub(crate) struct Row {
    pub number: u64,
    pub raw_record: Vec<u8>,
    pub value: Option<Value>,
}
pub(crate) struct Rows {
    receiver: mpsc::Receiver<Row>,
    task: JoinHandle<Result<Fingerprint, Error>>,
}
impl Rows {
    pub fn new(file: &PinnedFile) -> Self {
        let (sender, receiver) = mpsc::channel(2);
        let file = file.clone();
        let length = file.info().length;
        let task = tokio::spawn(async move {
            file.with_reader(move |reader| Ok(scan(reader, length, sender)))
                .await?
        });
        Self { receiver, task }
    }
    pub async fn next(&mut self) -> Option<Row> {
        self.receiver.recv().await
    }
    /// Called after draining the bounded stream, so the original read worker is settled.
    pub async fn finish(self) -> Result<Fingerprint, Error> {
        self.task.await?
    }
}
fn scan(
    reader: &mut PinnedReader<'_>,
    length: u64,
    sender: mpsc::Sender<Row>,
) -> Result<Fingerprint, Error> {
    let mut digest = Sha256::new();
    let mut pending = Vec::new();
    let mut offset = 0;
    let mut number = 0;
    loop {
        let page = reader.read(ReadRange {
            offset,
            limit: 64 * 1024,
        })?;
        digest.update(&page.bytes);
        for segment in page.bytes.split_inclusive(|byte| *byte == b'\n') {
            pending.extend_from_slice(segment);
            if segment.last() == Some(&b'\n') {
                number += 1;
                emit(std::mem::take(&mut pending), number, false, &sender)?;
            }
        }
        match page.next_offset {
            Some(next) => offset = next,
            None => break,
        }
    }
    let incomplete_tail = if pending.is_empty() {
        false
    } else {
        emit(pending, number + 1, true, &sender)?
    };
    Ok(Fingerprint {
        bytes: length,
        sha256: hex::encode(digest.finalize()),
        incomplete_tail,
    })
}
fn emit(
    bytes: Vec<u8>,
    number: u64,
    last: bool,
    sender: &mpsc::Sender<Row>,
) -> Result<bool, Error> {
    let json = if number == 1 {
        bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes)
    } else {
        &bytes
    };
    let mut incomplete = false;
    let value = if json.iter().all(u8::is_ascii_whitespace) {
        None
    } else {
        match serde_json::from_slice(json) {
            Ok(value) => Some(value),
            Err(error) if last && error.is_eof() => {
                incomplete = true;
                None
            }
            Err(source) => {
                return Err(Error::Decode {
                    line: number,
                    source,
                });
            }
        }
    };
    sender
        .blocking_send(Row {
            number,
            raw_record: bytes,
            value,
        })
        .map_err(|_| Error::Invalid("exact source consumer closed before the read completed"))?;
    Ok(incomplete)
}
pub(crate) fn unchanged(expected: &Fingerprint, observed: Fingerprint) -> Result<(), Error> {
    if expected == &observed {
        Ok(())
    } else {
        Err(Error::Invalid("source changed between exact read passes"))
    }
}
