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

use super::{AttachmentRef, Client, Prepared, active, artifact};
use artifact::{ArtifactIngestInput as Input, ArtifactIngestResult as Output};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(super) fn begin(session: &str, id: &str, reference: &AttachmentRef, bytes: &[u8]) -> Input {
    Input::Begin {
        session_id: session.into(),
        upload_id: id.into(),
        name: reference.name.clone(),
        mime_type: reference.mime_type.clone(),
        total_bytes: bytes.len() as u64,
        content_sha256: artifact::content_digest(bytes),
    }
}

async fn request(
    client: &Client,
    input: Input,
    cancel: &CancellationToken,
) -> Result<Output, crate::Error> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Prompt cancelled".into()),
        result = tokio::time::timeout(Duration::from_secs(30), client.ingest_artifact(input)) => Ok(result.map_err(|_| "Artifact upload timed out")??),
    }
}

pub(super) async fn publish(
    client: &Client,
    session: &str,
    item: Prepared,
    cancel: &CancellationToken,
) -> Result<(), crate::Error> {
    active(cancel)?;
    let result = async {
        match request(
            client,
            begin(session, &item.id, &item.reference, &item.bytes),
            cancel,
        )
        .await?
        {
            Output::Committed { attachment, .. } if attachment == item.reference => return Ok(()),
            Output::UploadOpened { next_offset: 0, .. } => {}
            _ => return Err("Unexpected artifact begin result".into()),
        }
        let mut offset = 0;
        for chunk in item.bytes.chunks(artifact::MAX_INGEST_CHUNK_BYTES) {
            match request(
                client,
                Input::Chunk {
                    session_id: session.into(),
                    upload_id: item.id.clone(),
                    offset,
                    chunk_base64: STANDARD.encode(chunk),
                },
                cancel,
            )
            .await?
            {
                Output::ChunkAccepted { next_offset, .. }
                    if next_offset == offset + chunk.len() as u64 =>
                {
                    offset = next_offset
                }
                _ => return Err("Unexpected artifact chunk result".into()),
            }
        }
        match request(
            client,
            Input::Commit {
                session_id: session.into(),
                upload_id: item.id.clone(),
            },
            cancel,
        )
        .await?
        {
            Output::Committed { attachment, .. } if attachment == item.reference => Ok(()),
            _ => Err("Unexpected artifact commit result".into()),
        }
    }
    .await;
    if result.is_err() {
        // Even an unacknowledged begin may have opened an upload. Cleanup is bounded
        // and independent of the cancelled prompt; committed artifacts are retained.
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            client.ingest_artifact(Input::Abort {
                session_id: session.into(),
                upload_id: item.id,
            }),
        )
        .await;
    }
    result
}
