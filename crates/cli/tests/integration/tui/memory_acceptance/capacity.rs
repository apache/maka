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
use uuid::Uuid;

pub(super) fn measure(
    runtime: &Runtime,
    root: &std::path::Path,
    sampler: &mut sampler::Sampler,
    log: &mut report::Report,
    phase: &'static str,
) {
    let (client, pump) = runtime.block_on(proxy::connect(root));
    let mut documents = Vec::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let target = runtime.block_on(case::target(&client, "memory"));
        for count in 1..=4 {
            sampler.mark(phase, count);
            let document = runtime.block_on(case::document(&client));
            documents.push(document);
            let result = runtime.block_on(read(&client, &target, document)).unwrap();
            assert!(matches!(result, RemoteResult::Value { ref value } if value["kind"] == "view"));
            let records = runtime.block_on(resource(&client, document));
            let stats = runtime.block_on(case::stats(&client));
            assert_eq!(stats["active"], count);
            assert_eq!(stats["activations"], 1);
            sampler.mark(phase, count);
            log.emit(
                json!({"kind":"page_capacity","phase":phase,"page_documents":count,
                "document":document,"loaded_resource_records":records,"stats":stats,
                "app_reply_payload_bytes":serde_json::to_vec(&result).unwrap().len()}),
            );
        }
        let fifth = runtime.block_on(case::document(&client));
        documents.push(fifth);
        let denied = runtime.block_on(read(&client, &target, fifth));
        log.emit(
            json!({"kind":"page_capacity_rejection","phase":phase,"page_documents":4,
            "attempted":5,"result":format!("{denied:?}")}),
        );
        assert!(
            matches!(denied,
            Err(maka_client::RequestFailure::Rejected(maka_client::ClientError::Rejected(ref error)))
                if error.code == maka_protocol::OperationErrorCode::OperationUnavailable
                    && error.message.contains("capacity")),
            "fifth page was not rejected for capacity: {denied:?}"
        );
    }));
    sampler.mark(
        if phase == "capacity_before" {
            "capacity_before_closing"
        } else {
            "capacity_after_closing"
        },
        4,
    );
    let mut cleanup_ok = true;
    for document in documents {
        let closed =
            runtime.block_on(client.plugin_remote(RemoteRequest::CloseDocument { document }));
        log.emit(json!({"kind":"page_capacity_close","phase":phase,"document":document,"result":format!("{closed:?}")}));
        cleanup_ok &= matches!(closed, Ok(RemoteResult::Closed));
    }
    let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert!(cleanup_ok, "one or more exact page documents did not close");
        let stats = runtime.block_on(case::closed(&client));
        sampler.mark(phase, 0);
        log.emit(json!({"kind":"page_capacity_released","phase":phase,"stats":stats}));
    }));
    // A new exact document must reuse a released page VM permit without a new
    // backend activation. This is admission evidence, not an RSS threshold.
    let reuse = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if result.is_ok() && cleanup.is_ok() {
            sampler.mark(
                if phase == "capacity_before" {
                    "capacity_before_reuse"
                } else {
                    "capacity_after_reuse"
                },
                1,
            );
            let target = runtime.block_on(case::target(&client, "memory"));
            let document = runtime.block_on(case::document(&client));
            let reopened = runtime.block_on(read(&client, &target, document));
            let close =
                runtime.block_on(client.plugin_remote(RemoteRequest::CloseDocument { document }));
            log.emit(json!({"kind":"page_capacity_reusable","phase":phase,"read":format!("{reopened:?}"),"close":format!("{close:?}")}));
            assert!(reopened.is_ok() && matches!(close, Ok(RemoteResult::Closed)));
            assert_eq!(runtime.block_on(case::stats(&client))["activations"], 1);
        }
    }));
    client.disconnect();
    runtime.block_on(async {
        client.closed().await;
        pump.await.unwrap();
    });
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
    if let Err(error) = cleanup {
        std::panic::resume_unwind(error);
    }
    if let Err(error) = reuse {
        std::panic::resume_unwind(error);
    }
}

async fn read(
    client: &Client,
    target: &Target,
    document: Uuid,
) -> Result<RemoteResult, maka_client::RequestFailure> {
    client
        .plugin_remote(RemoteRequest::Call {
            binding: case::binding("memory"),
            target: target.clone(),
            document,
            input: json!({"kind":"read","route":null,"locale":"en"}),
        })
        .await
}
async fn resource(client: &Client, document: Uuid) -> usize {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mount = Uuid::new_v4();
        let target = case::target(client, "memory-lines.stream").await;
        let result = client
            .plugin_remote(RemoteRequest::Open {
                binding: case::binding("memory-lines.stream"),
                target,
                document,
                input: serde_json::to_value(wire::Open {
                    mount,
                    resource: "memory-lines".into(),
                    route: Value::Null,
                    locale: "en".into(),
                })
                .unwrap(),
            })
            .await
            .unwrap();
        let RemoteResult::Opened { stream } = result else {
            panic!("expected resource stream: {result:?}")
        };
        let fence = loop {
            match client
                .plugin_remote(RemoteRequest::Next { document, stream })
                .await
                .unwrap()
            {
                RemoteResult::Pending => continue,
                RemoteResult::Item { item } => {
                    let event: wire::Event = serde_json::from_value(item).unwrap();
                    event.validate().unwrap();
                    let wire::Event::Ready { fence } = event else {
                        panic!("expected Ready")
                    };
                    break fence;
                }
                result => panic!("expected Ready item: {result:?}"),
            }
        };
        let target = case::target(client, "memory-lines.read").await;
        let mut request = wire::Read {
            mount,
            resource: "memory-lines".into(),
            fence,
            direction: wire::Direction::Tail,
            cursor: None,
        };
        let mut records = 0;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..64 {
            let result = client
                .plugin_remote(RemoteRequest::Call {
                    binding: case::binding("memory-lines.read"),
                    target: target.clone(),
                    document,
                    input: serde_json::to_value(&request).unwrap(),
                })
                .await
                .unwrap();
            let RemoteResult::Value { value } = result else {
                panic!("expected resource page")
            };
            let page: wire::Page = serde_json::from_value(value).unwrap();
            page.validate().unwrap();
            assert_eq!(page.fence, fence);
            for record in page.records {
                assert!(
                    matches!(record, wire::Record::Block { .. }),
                    "bounded memory fixture unexpectedly fragmented"
                );
                records += 1;
            }
            match page.continuation {
                None => {
                    assert_eq!(records, 256);
                    return records;
                }
                Some(cursor) => {
                    assert!(seen.insert(cursor.clone()));
                    request.direction = wire::Direction::Continue;
                    request.cursor = Some(cursor);
                }
            }
        }
        panic!("memory fixture exceeded its continuation bound");
    })
    .await
    .expect("page capacity resource bootstrap did not settle")
}
