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

use maka_event_log::{
    EventLog,
    transcript::{TranscriptDirection, TranscriptRead},
};
use serde_json::Value;

#[allow(dead_code)]
pub async fn transcript(log: &EventLog, session: &str) -> Vec<Value> {
    let through = log.prefix(100, 1024 * 1024).await.unwrap().high_water;
    let headers = log
        .transcript_headers(
            session,
            &TranscriptRead {
                through,
                position: None,
                direction: TranscriptDirection::Newer,
                limit: 100,
            },
        )
        .await
        .unwrap();
    let mut rows = Vec::new();
    for header in headers {
        rows.push(
            serde_json::from_slice(
                &log.transcript_fragment(session, header.position, 0, header.total_bytes)
                    .await
                    .unwrap(),
            )
            .unwrap(),
        );
    }
    rows
}

/// Deliberately hydrate every row for full-cache/digest/replay test oracles only.
/// Window, source, image and navigation tests must call their API without this prewarm.
#[allow(dead_code)]
pub async fn materialize_all_rows(
    log: &EventLog,
    session: &str,
    through: u64,
) -> Result<(), maka_event_log::StoreError> {
    use maka_agent_facts::history::RowPosition;
    let mut position = None;
    loop {
        let headers = log
            .transcript_headers(
                session,
                &TranscriptRead {
                    through,
                    position,
                    direction: TranscriptDirection::Newer,
                    limit: 256,
                },
            )
            .await?;
        let Some(last) = headers.last() else {
            return Ok(());
        };
        position = Some(RowPosition {
            source_sequence: last.position.source_sequence,
            item_index: last.position.item_index + 1,
        });
    }
}
