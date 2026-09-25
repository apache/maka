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
use maka_plugins::{remote::Target, terminal_ui::transcript as wire};
use maka_protocol::plugin::RemoteKind;
use std::collections::HashSet;
use uuid::Uuid;

/// Check the SDK's actual Host wire payload against the public Rust contract
/// before mounting it. Always close the document, including on decode failure.
pub(super) async fn preflight(client: &maka_client::Client) {
    let RemoteResult::Document { document } = exchange(client, RemoteRequest::OpenDocument)
        .await
        .expect("Transcript preflight OpenDocument")
    else {
        panic!("Transcript preflight did not allocate a document")
    };
    let result = tokio::time::timeout(Duration::from_secs(5), bootstrap(client, document))
        .await
        .unwrap_or_else(|_| Err("Transcript bootstrap did not settle".into()));
    let close = exchange(client, RemoteRequest::CloseDocument { document }).await;
    assert!(
        matches!(close, Ok(RemoteResult::Closed)),
        "Transcript preflight close: {close:?}"
    );
    result.expect("Transcript SDK to Rust preflight");
}

async fn bootstrap(client: &maka_client::Client, document: Uuid) -> Result<(), String> {
    let (read, read_target) = bind(client, "board-activity.read", RemoteKind::Method).await?;
    let (stream, stream_target) = bind(client, "board-activity.stream", RemoteKind::Stream).await?;
    if (
        read_target.entry_id.as_str(),
        read_target.activation.as_str(),
    ) != (
        stream_target.entry_id.as_str(),
        stream_target.activation.as_str(),
    ) {
        return Err("resource endpoints belong to different activations".into());
    }
    let opened = exchange(
        client,
        RemoteRequest::Open {
            binding: stream,
            target: stream_target,
            document,
            input: serde_json::to_value(wire::Open {
                resource: "board-activity".into(),
                route: Value::Null,
                locale: "en".into(),
            })
            .unwrap(),
        },
    )
    .await?;
    let RemoteResult::Opened { stream } = opened else {
        return Err(format!("Open returned {opened:?}"));
    };
    let item = loop {
        match exchange(client, RemoteRequest::Next { document, stream }).await? {
            RemoteResult::Pending => continue,
            RemoteResult::Item { item } => break item,
            other => return Err(format!("initial Next returned {other:?}")),
        }
    };
    let event: wire::Event = serde_json::from_value(item.clone())
        .map_err(|error| format!("Ready decode: {error}; item={item}"))?;
    event
        .validate()
        .map_err(|error| format!("Ready validation: {error:?}"))?;
    let wire::Event::Ready { fence } = event else {
        return Err(format!("initial event is not Ready: {event:?}"));
    };
    let mut request = wire::Read {
        resource: "board-activity".into(),
        fence,
        direction: wire::Direction::Tail,
        cursor: None,
    };
    let mut cursors = HashSet::new();
    let mut blocks = Vec::new();
    let mut fragment: Option<(wire::Key, String, usize, String)> = None;
    for index in 0..64 {
        let response = exchange(
            client,
            RemoteRequest::Call {
                binding: read.clone(),
                target: read_target.clone(),
                document,
                input: serde_json::to_value(&request).unwrap(),
            },
        )
        .await?;
        let RemoteResult::Value { value } = response else {
            return Err(format!("page {index}: expected Value, got {response:?}"));
        };
        let received = serde_json::to_vec(&value).unwrap().len();
        if received > 64 * 1024 {
            return Err(format!("page {index}: wire size {received}"));
        }
        let page: wire::Page = serde_json::from_value(value)
            .map_err(|error| format!("page {index} decode ({received} bytes): {error}"))?;
        let encoded = serde_json::to_vec(&page).unwrap().len();
        page.validate().map_err(|error| format!(
            "page {index} validation: {error:?}; received={received}, reencoded={encoded}, records={}, continuation={:?}",
            page.records.len(), page.continuation,
        ))?;
        if page.fence != fence {
            return Err(format!("page {index}: changed fence"));
        }
        for record in page.records {
            match record {
                wire::Record::Block { block } => {
                    if fragment.is_some() {
                        return Err(format!("page {index}: interrupted fragment"));
                    }
                    blocks.push(block);
                }
                wire::Record::Fragment {
                    key,
                    revision,
                    offset,
                    total,
                    json,
                } => {
                    let pending = fragment.get_or_insert_with(|| {
                        (key.clone(), revision.clone(), total, String::new())
                    });
                    if (&pending.0, &pending.1, pending.2, pending.3.len())
                        != (&key, &revision, total, offset)
                    {
                        return Err(format!(
                            "page {index}: fragment identity or offset mismatch for {}",
                            key.message
                        ));
                    }
                    pending.3.push_str(&json);
                    if pending.3.len() == total {
                        let block: wire::Block =
                            serde_json::from_str(&pending.3).map_err(|error| {
                                format!("page {index}: assembled block decode: {error}")
                            })?;
                        block.validate().map_err(|error| {
                            format!("page {index}: assembled block validation: {error:?}")
                        })?;
                        if block.key != key || block.revision != revision {
                            return Err(format!("page {index}: assembled block identity mismatch"));
                        }
                        blocks.push(block);
                        fragment = None;
                    }
                }
            }
        }
        match page.continuation {
            Some(cursor) => {
                if !cursors.insert(cursor.clone()) {
                    return Err(format!("page {index}: repeated cursor"));
                }
                request.direction = wire::Direction::Continue;
                request.cursor = Some(cursor);
            }
            None => {
                if fragment.is_some() {
                    return Err("last page leaves an incomplete block".into());
                }
                let report = blocks
                    .iter()
                    .find(|block| block.key.message == "report")
                    .ok_or("initial tail omitted the report")?;
                if report.content.text.len() <= 64 * 1024
                    || !report
                        .content
                        .text
                        .ends_with("Board report end — 完整记录。")
                    || blocks.last().map(|block| block.content.text.as_str())
                        != Some("Live activity — ready.\n")
                {
                    return Err("initial tail truncated the report or live record".into());
                }
                return Ok(());
            }
        }
    }
    Err("fixture exceeded 64 continuation pages".into())
}

async fn bind(
    client: &maka_client::Client,
    method: &str,
    kind: RemoteKind,
) -> Result<(RemoteBinding, Target), String> {
    let binding = RemoteBinding::Package {
        package_id: "example.board".into(),
        method: method.into(),
        session_id: None,
    };
    let result = exchange(
        client,
        RemoteRequest::Bind {
            binding: binding.clone(),
        },
    )
    .await?;
    match result {
        RemoteResult::Bound { target, handler }
            if matches!(
                (handler, kind),
                (RemoteKind::Method, RemoteKind::Method) | (RemoteKind::Stream, RemoteKind::Stream)
            ) =>
        {
            Ok((binding, target))
        }
        other => Err(format!("Bind {method}: {other:?}")),
    }
}

async fn exchange(
    client: &maka_client::Client,
    request: RemoteRequest,
) -> Result<RemoteResult, String> {
    client
        .plugin_remote(request.clone())
        .await
        .map_err(|error| format!("{request:?}: {error:?}"))
}
