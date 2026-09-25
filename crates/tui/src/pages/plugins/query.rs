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

use super::Snapshot;
use maka_client::{Client, ClientError, RequestFailure};
use maka_protocol::plugin::{Query, QueryResult, Status, View};

fn invalid(message: &str) -> RequestFailure {
    RequestFailure::NotDispatched(ClientError::Protocol(message.into()))
}
async fn query(
    client: &Client,
    view: View,
    cursor: Option<String>,
) -> Result<QueryResult, RequestFailure> {
    client
        .plugin_query(Query {
            view,
            root_id: None,
            cursor,
            limit: (view != View::Status).then_some(64),
        })
        .await
}
async fn status(client: &Client) -> Result<Status, RequestFailure> {
    match query(client, View::Status, None).await? {
        QueryResult::Status(status) => Ok(status),
        _ => Err(invalid("Expected plugin status")),
    }
}
pub(super) async fn snapshot(client: &Client) -> Result<Snapshot, RequestFailure> {
    // A page cursor or a composition generation can change while we read. Only
    // this read is restarted, at most three times; no write is retried here.
    'snapshot: for _ in 0..3 {
        let before = status(client).await?;
        let mut packages = vec![];
        let mut entries = vec![];
        for view in [View::Packages, View::Entries] {
            let mut cursor = None;
            for page_index in 0..16 {
                let result = match query(client, view, cursor.clone()).await {
                    Err(RequestFailure::Rejected(ClientError::Rejected(error)))
                        if error.code == maka_protocol::OperationErrorCode::StaleCursor =>
                    {
                        continue 'snapshot;
                    }
                    result => result?,
                };
                let next = match result {
                    QueryResult::Packages(page) => {
                        packages.extend(page.items);
                        page.next_cursor
                    }
                    QueryResult::Entries(page) => {
                        entries.extend(page.items);
                        page.next_cursor
                    }
                    _ => return Err(invalid("Unexpected plugin page")),
                };
                if next.is_none() {
                    break;
                }
                if next == cursor || page_index == 15 {
                    return Err(invalid(
                        "Plugin directory exceeds the management page limit",
                    ));
                }
                cursor = next;
            }
        }
        let after = status(client).await?;
        let mut flat = vec![];
        while let Some(mut entry) = entries.pop() {
            entries.append(&mut entry.children);
            flat.push(entry);
            if flat.len() + entries.len() > 1024 {
                return Err(invalid(
                    "Plugin instance directory exceeds the management page limit",
                ));
            }
        }
        if before.authority_epoch == after.authority_epoch
            && packages
                .iter()
                .all(|p| p.base_generation == after.authority_epoch)
            && flat
                .iter()
                .all(|e| e.base_generation == after.authority_epoch)
        {
            if serde_json::to_vec(&(&packages, &flat))
                .map_err(|_| invalid("Invalid plugin snapshot"))?
                .len()
                > 8 * 1024 * 1024
            {
                return Err(invalid(
                    "Plugin directory exceeds the management memory limit",
                ));
            }
            flat.sort_by(|a, b| (&a.root_id, &a.id).cmp(&(&b.root_id, &b.id)));
            return Ok(Snapshot {
                status: after,
                packages,
                entries: flat,
            });
        }
    }
    Err(invalid(
        "Plugin composition changed during refresh; refresh again",
    ))
}
