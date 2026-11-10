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

use crate::{ContentBlob, sql::with_owned_content, store::invalid};
use maka_agent_facts::{
    durable::RunId,
    operation::{RecordedOperationReply, RecordedOperationResult, resolve_reply, result_reference},
};
use maka_event_log::StoreError;
use maka_plugin_core::operation::{OperationReply, OperationResult};
use rusqlite::Connection;

pub fn record_reply(
    reply: OperationReply,
) -> Result<(RecordedOperationReply, Option<ContentBlob>), StoreError> {
    let mut material = None;
    let reply = reply.try_map_result(|result| -> Result<_, StoreError> {
        let blob = ContentBlob::json(&result)?;
        let content = blob.reference().clone();
        material = Some(blob);
        Ok(RecordedOperationResult::Referenced {
            content,
            is_error: matches!(result, OperationResult::Failure { .. }),
        })
    })?;
    Ok((reply, material))
}

pub async fn prepare_reply(
    reply: OperationReply,
) -> Result<(RecordedOperationReply, Option<ContentBlob>), StoreError> {
    tokio::task::spawn_blocking(move || record_reply(reply))
        .await
        .map_err(|error| invalid(format!("operation receipt preparation failed: {error}")))?
}

pub(crate) fn read_reply(
    c: &Connection,
    run: RunId,
    reply: &RecordedOperationReply,
) -> Result<OperationReply, StoreError> {
    let result = result_reference(reply)
        .map(|reference| {
            with_owned_content(c, run, reference, |bytes| {
                Ok(serde_json::from_slice::<OperationResult>(bytes)?)
            })
        })
        .transpose()?;
    resolve_reply(reply.clone(), result).map_err(invalid)
}
