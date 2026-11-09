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

#![allow(dead_code)]
use maka_agent_facts::{
    durable::ContentRef,
    history_snapshot::{Entry, OriginalRecordsPage, OriginalSource, SNAPSHOT_VERSION},
};
use maka_agent_state::{
    ContentBlob,
    session_history::{
        SessionHistory,
        snapshot::{IMPORT_TAPE_MAGIC, ImportedCaptureRequest, Snapshot},
    },
};
use std::{
    fs::File,
    io::{Seek, SeekFrom, Write},
};
use tokio_util::sync::CancellationToken;

pub(crate) struct Tape {
    file: File,
}
impl Tape {
    pub(crate) fn new() -> Self {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(IMPORT_TAPE_MAGIC).unwrap();
        Self { file }
    }
    pub(crate) fn push_blob(&mut self, bytes: &[u8]) -> ContentRef {
        let reference = ContentBlob::new(bytes.to_vec()).reference().clone();
        self.file.write_all(&[0]).unwrap();
        self.file
            .write_all(&hex::decode(reference.digest.strip_prefix("sha256:").unwrap()).unwrap())
            .unwrap();
        self.file.write_all(&reference.bytes.to_be_bytes()).unwrap();
        self.file.write_all(bytes).unwrap();
        reference
    }
    pub(crate) fn push_json<T: serde::Serialize>(&mut self, value: &T) -> ContentRef {
        self.push_blob(&serde_json::to_vec(value).unwrap())
    }
    pub(crate) fn push_entry(&mut self, entry: &Entry) {
        let bytes = serde_json::to_vec(entry).unwrap();
        self.file.write_all(&[1]).unwrap();
        self.file
            .write_all(&(bytes.len() as u64).to_be_bytes())
            .unwrap();
        self.file.write_all(&bytes).unwrap();
    }
    pub(crate) fn original_source(
        &mut self,
        records: Vec<ContentRef>,
        fingerprint: String,
    ) -> ContentRef {
        let records = self.push_json(&OriginalRecordsPage {
            previous: None,
            records,
        });
        self.push_json(&OriginalSource {
            version: SNAPSHOT_VERSION,
            fingerprint,
            records: Some(records),
        })
    }
    pub(crate) fn into_file(mut self) -> File {
        self.file.flush().unwrap();
        self.file.seek(SeekFrom::Start(0)).unwrap();
        self.file
    }
    pub(crate) async fn capture(
        self,
        history: &SessionHistory,
        request: ImportedCaptureRequest,
        stop: CancellationToken,
    ) -> Snapshot {
        history
            .capture_imported(request, self.into_file(), stop)
            .await
            .unwrap()
    }
}
