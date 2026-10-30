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
use maka_capabilities::call::ResourceEncoding;
use maka_host_runtime::application::{
    Binding, Client, RESOURCE_CHUNK_LIMIT, ResourceCapture, ResourceDescriptor,
};

fn descriptors(
    length: u64,
    metadata: Value,
    encoding: ResourceEncoding,
) -> BTreeMap<String, ResourceDescriptor> {
    BTreeMap::from([(
        "text".into(),
        ResourceDescriptor {
            resource: ResourceType {
                name: "example.Bytes".into(),
                version: 1,
            },
            length,
            metadata,
            encoding,
        },
    )])
}
struct Probe {
    calls: Arc<AtomicUsize>,
    started: Arc<Semaphore>,
    release: Arc<Semaphore>,
    stream: bool,
}
impl Handler for Probe {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let calls = self.calls.clone();
        let started = self.started.clone();
        let release = self.release.clone();
        let stream = self.stream;
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let resource = &context.attachments()["text"];
            if input == "soft-hold" {
                let mut verified = 0;
                for offset in (0..resource.bytes()).step_by(RESOURCE_CHUNK_LIMIT) {
                    let end = (offset + RESOURCE_CHUNK_LIMIT).min(resource.bytes());
                    let chunk = resource.read(offset..end)?;
                    if chunk.len() != end - offset
                        || chunk
                            .iter()
                            .enumerate()
                            .any(|(index, byte)| *byte != ((offset + index) % 251) as u8)
                    {
                        return Err("original large resource bytes changed".into());
                    }
                    verified += chunk.len();
                }
                let snapshot = json!({"verified":verified,"metadata":resource.metadata()});
                started.add_permits(1);
                permit(&release).await;
                return Ok(json!(serde_json::to_string(&snapshot).unwrap()));
            }
            if input == "whole" {
                let empty_valid = resource.read(0..0)?.is_empty();
                let split_rejected = resource.read(1..2).is_err();
                let empty_split_rejected = resource.read(1..1).is_err();
                let outside_rejected = resource.read(0..resource.bytes() + 1).is_err();
                let text = String::from_utf8(resource.read(0..resource.bytes())?)
                    .map_err(|error| error.to_string())?;
                return Ok(json!(serde_json::to_string(&json!({
                    "metadata":resource.metadata(), "length":resource.bytes(),
                    "encoding":resource.encoding(), "identity":context.scope().identity,
                    "emptyValid":empty_valid, "splitRejected":split_rejected,
                    "emptySplitRejected":empty_split_rejected, "outsideRejected":outside_rejected,
                    "text":text,
                })).unwrap()));
            }
            if let Some(text) = input
                .as_str()
                .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte == b'i'))
            {
                return Ok(json!(serde_json::to_string(&json!({
                    "metadata":resource.metadata(), "length":resource.bytes(), "inputBytes":text.len(),
                })).unwrap()));
            }
            let snapshot = json!({"metadata":resource.metadata(), "length":resource.bytes(), "encoding":resource.encoding(),
                "first":resource.read(0..resource.bytes().min(8))?, "splitRejected":resource.read(1..2).is_err(),
                "emptySplitRejected":resource.read(1..1).is_err()});
            if input == "hold" || input == "fail" {
                started.add_permits(1);
                permit(&release).await;
            }
            if input == "fail" {
                let mut ticket = context.scope().resources.reserve().unwrap();
                ticket.start();
                ticket.complete(Err("captured physical cleanup failed".into()));
            }
            let reply = json!(serde_json::to_string(&snapshot).unwrap());
            if stream {
                context.emit(reply.clone()).await?;
            }
            Ok(reply)
        })
    }
}
struct Fixture {
    app: Application,
    client: Client,
    binding: Binding,
    issuer: Issuer,
    calls: Arc<AtomicUsize>,
    started: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Fixture {
    async fn new(mode: MethodMode) -> Self {
        let mut declared = attached_contract();
        let Interface::Service { methods } = &mut declared.interface else {
            unreachable!()
        };
        methods.get_mut("echo").unwrap().mode = mode;
        let mut provider_entry = attached_entry(
            true,
            Implementation::Native {
                implementation: "native.echo".into(),
            },
        );
        provider_entry.exports.get_mut("echo").unwrap().contract = declared.clone();
        let provider = package("ingress.provider", provider_entry, None);
        let consumer = observer(
            "ingress.consumer",
            BTreeMap::from([(
                "echo".into(),
                Import {
                    contract: declared.clone(),
                    cardinality: Cardinality::One,
                },
            )]),
        );
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let app = Application::start(
            input(&provider, &consumer),
            vec![provider, consumer],
            registry_contract(
                Arc::new(Probe {
                    calls: calls.clone(),
                    started: started.clone(),
                    release: release.clone(),
                    stream: mode == MethodMode::Subscription,
                }),
                declared,
            ),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        Self {
            app,
            client,
            binding,
            issuer,
            calls,
            started,
            release,
        }
    }
    fn capture(
        &self,
        length: u64,
        metadata: Value,
        encoding: ResourceEncoding,
    ) -> (Scope, ResourceCapture) {
        let scope = scope(&self.issuer, true);
        let capture = self
            .client
            .capture_resources(scope.clone(), descriptors(length, metadata, encoding))
            .unwrap();
        (scope, capture)
    }
}
fn observation(value: Value) -> Value {
    serde_json::from_str(value.as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn soft_packed_large_resource_keeps_exact_bytes_busy_release_and_foreign_capture() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        let other = Fixture::new(MethodMode::Query).await;
        let length = 64 * 1024 * 1024 + 73;
        let metadata = json!({"owner":"original large resource","revision":117});
        let (source, mut capture) =
            f.capture(length as u64, metadata.clone(), ResourceEncoding::Bytes);
        for offset in (0..length).step_by(RESOURCE_CHUNK_LIMIT) {
            let end = (offset + RESOURCE_CHUNK_LIMIT).min(length);
            let chunk: Vec<u8> = (offset..end).map(|index| (index % 251) as u8).collect();
            capture.write("text", offset as u64, &chunk).unwrap();
        }
        let accepted = f
            .client
            .start(
                f.binding.clone(),
                "echo".into(),
                json!("soft-hold"),
                source.clone(),
                capture.finish().unwrap(),
            )
            .await
            .unwrap();
        permit(&f.started).await;
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        let denied = scope(&f.issuer, true);
        assert!(
            f.client
                .capture_resources(
                    denied.clone(),
                    descriptors(1, json!(null), ResourceEncoding::Bytes),
                )
                .err()
                .unwrap()
                .contains("attachment budget")
        );
        denied.finish().await.unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        f.release.add_permits(1);
        let completion = accepted.completion().await;
        completion.cleanup.unwrap();
        let value = observation(completion.result.unwrap());
        assert_eq!(value, json!({"verified":length,"metadata":metadata}));
        source.finish().await.unwrap();

        let (source, mut capture) = f.capture(1, json!(null), ResourceEncoding::Bytes);
        capture.write("text", 0, b"x").unwrap();
        let completion = f
            .client
            .start(
                f.binding.clone(),
                "echo".into(),
                json!("inspect"),
                source.clone(),
                capture.finish().unwrap(),
            )
            .await
            .unwrap()
            .completion()
            .await;
        completion.cleanup.unwrap();
        assert_eq!(
            observation(completion.result.unwrap())["first"],
            json!([120])
        );
        source.finish().await.unwrap();

        let (source, mut capture) = f.capture(1, json!(null), ResourceEncoding::Bytes);
        capture.write("text", 0, b"x").unwrap();
        let error = other
            .client
            .start(
                other.binding.clone(),
                "echo".into(),
                json!("inspect"),
                source.clone(),
                capture.finish().unwrap(),
            )
            .await
            .err()
            .unwrap();
        assert!(error.contains("another Application"));
        source.finish().await.unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
        assert_eq!(other.calls.load(Ordering::SeqCst), 0);
        f.app.shutdown().await.unwrap();
        other.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn soft_packed_descriptors_and_json_share_one_combined_input_charge() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        for (metadata_bytes, input_bytes) in [
            (1024 * 1024 + 37, 32 * 1024 * 1024 + 19),
            (32 * 1024 * 1024 + 37, 7),
        ] {
            let metadata = json!("m".repeat(metadata_bytes));
            let (source, capture) = f.capture(0, metadata.clone(), ResourceEncoding::Bytes);
            let completion = f
                .client
                .start(
                    f.binding.clone(),
                    "echo".into(),
                    json!("i".repeat(input_bytes)),
                    source.clone(),
                    capture.finish().unwrap(),
                )
                .await
                .unwrap()
                .completion()
                .await;
            completion.cleanup.unwrap();
            let value = observation(completion.result.unwrap());
            assert!(
                value["metadata"] == metadata,
                "original complete metadata changed"
            );
            assert_eq!(value["length"], 0);
            assert_eq!(value["inputBytes"], input_bytes);
            source.finish().await.unwrap();
            let (probe, capture) = f.capture(0, json!(null), ResourceEncoding::Bytes);
            drop(capture);
            probe.finish().await.unwrap();
        }
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn frozen_utf8_whole_read_retains_admitted_bytes_and_original_scope() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        let text = format!("{}\nK115 original final marker", "中🦀a".repeat(150_000));
        let metadata = json!({"owner":"original K115 editor","revision":73,"bytes":text.len()});
        let (source, mut capture) =
            f.capture(text.len() as u64, metadata.clone(), ResourceEncoding::Utf8);
        let identity = serde_json::to_value(&source.identity).unwrap();
        // Ingress still uses its real bounded contiguous transfer frames. A
        // complete immutable resource can then service one whole local read.
        for (index, chunk) in text.as_bytes().chunks(RESOURCE_CHUNK_LIMIT).enumerate() {
            capture
                .write("text", (index * RESOURCE_CHUNK_LIMIT) as u64, chunk)
                .unwrap();
        }
        let completion = f
            .client
            .start(
                f.binding.clone(),
                "echo".into(),
                json!("whole"),
                source.clone(),
                capture.finish().unwrap(),
            )
            .await
            .unwrap()
            .completion()
            .await;
        let settled = source.finish().await;
        f.app.shutdown().await.unwrap();

        completion.cleanup.unwrap();
        settled.unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        assert!(text.len() > 1024 * 1024);
        let result = completion
            .result
            .unwrap_or_else(|error| panic!("whole admitted UTF-8 read failed: {error}"));
        let value = observation(result);
        assert_eq!(value["metadata"], metadata);
        assert_eq!(value["identity"], identity);
        assert_eq!(value["length"], text.len());
        assert_eq!(value["encoding"], "utf8");
        for flag in [
            "emptyValid",
            "splitRejected",
            "emptySplitRejected",
            "outsideRejected",
        ] {
            assert_eq!(value[flag], true, "original UTF-8 range invariant: {flag}");
        }
        assert!(
            value["text"].as_str() == Some(text.as_str()),
            "whole local read changed original multibyte bytes"
        );
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn many_empty_resource_receptions_keep_scope_ownership_through_execution() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        let mut pending = Vec::new();
        for _ in 0..320 {
            pending.push(f.capture(0, json!(null), ResourceEncoding::Bytes));
        }
        let (scope, capture) = pending.pop().unwrap();
        let accepted = f
            .client
            .start(
                f.binding.clone(),
                "echo".into(),
                json!("hold"),
                scope.clone(),
                capture.finish().unwrap(),
            )
            .await
            .unwrap();
        permit(&f.started).await;
        let (extra, capture) = f.capture(0, json!(null), ResourceEncoding::Bytes);
        drop(capture);
        extra.finish().await.unwrap();
        drop(accepted);
        f.release.add_permits(1);
        scope.finish().await.unwrap();
        let (fresh, capture) = f.capture(0, json!(null), ResourceEncoding::Bytes);
        drop(capture);
        fresh.finish().await.unwrap();
        for (scope, capture) in pending {
            drop(capture);
            scope.finish().await.unwrap();
        }
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn partial_reception_shares_native_payload_capacity_until_actual_drop() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        let (original, mut capture) = f.capture(
            64 * 1024 * 1024,
            json!({"owner":"original"}),
            ResourceEncoding::Bytes,
        );
        capture.write("text", 0, b"xxxxx").unwrap();
        let (raw, weak) = bytes(5);
        let denied = scope(&f.issuer, true);
        assert!(
            f.client
                .start(
                    f.binding.clone(),
                    "echo".into(),
                    json!("x"),
                    denied.clone(),
                    raw.into()
                )
                .await
                .err()
                .unwrap()
                .contains("attachment budget")
        );
        assert!(weak.upgrade().is_none());
        denied.finish().await.unwrap();
        let finish = original.finish();
        tokio::pin!(finish);
        assert!(
            futures_util::poll!(&mut finish).is_pending(),
            "Scope closure cannot acknowledge a retained partial buffer"
        );
        assert!(capture.write("text", 5, b"x").is_err());
        let denied = scope(&f.issuer, true);
        assert!(
            f.client
                .capture_resources(
                    denied.clone(),
                    descriptors(1, json!(null), ResourceEncoding::Bytes)
                )
                .err()
                .unwrap()
                .contains("attachment budget")
        );
        denied.finish().await.unwrap();
        drop(capture);
        finish.await.unwrap();
        let (scope, capture) = f.capture(1, json!(null), ResourceEncoding::Bytes);
        drop(capture);
        scope.finish().await.unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn retained_zero_payload_metadata_uses_the_original_aggregate_json_budget() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        let mut pending = Vec::new();
        let metadata = json!("m".repeat(400_000));
        let failure = loop {
            let source = scope(&f.issuer, true);
            match f.client.capture_resources(
                source.clone(),
                descriptors(0, metadata.clone(), ResourceEncoding::Bytes),
            ) {
                Ok(capture) => pending.push((source, capture)),
                Err(error) => {
                    source.finish().await.unwrap();
                    break error;
                }
            }
            assert!(
                pending.len() < 128,
                "metadata must exhaust JSON capacity before call slots"
            );
        };
        assert!(failure.contains("descriptor budget"));
        assert!(pending.len() > 1);
        let (scope, capture) = pending.pop().unwrap();
        drop(capture);
        scope.finish().await.unwrap();
        let (scope, capture) = f.capture(0, metadata, ResourceEncoding::Bytes);
        drop(capture);
        scope.finish().await.unwrap();
        for (scope, capture) in pending {
            drop(capture);
            scope.finish().await.unwrap();
        }
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn malformed_descriptors_chunks_and_incomplete_snapshots_never_dispatch_effects() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        let mut invalid = Vec::new();
        invalid.push(descriptors(u64::MAX, json!(null), ResourceEncoding::Bytes));
        let mut wrong = descriptors(0, json!(null), ResourceEncoding::Bytes);
        wrong.get_mut("text").unwrap().resource.version = 0;
        invalid.push(wrong);
        let wrong = descriptors(0, json!(null), ResourceEncoding::Bytes)
            .pop_first()
            .unwrap()
            .1;
        invalid.push(BTreeMap::from([("".into(), wrong)]));
        for descriptor in invalid {
            let source = scope(&f.issuer, true);
            assert!(
                f.client
                    .capture_resources(source.clone(), descriptor)
                    .is_err()
            );
            source.finish().await.unwrap();
        }
        let (scope, mut capture) = f.capture(5, json!(null), ResourceEncoding::Bytes);
        assert!(capture.write("missing", 0, b"x").is_err());
        assert!(capture.write("text", 0, b"").is_err());
        assert!(
            capture
                .write("text", 0, &vec![b'x'; RESOURCE_CHUNK_LIMIT + 1])
                .is_err()
        );
        assert!(capture.write("text", u64::MAX, b"x").is_err());
        assert!(capture.write("text", 1, b"x").is_err());
        capture.write("text", 0, b"xx").unwrap();
        assert!(capture.write("text", 0, b"x").is_err());
        assert!(capture.write("text", 2, b"xxxx").is_err());
        assert!(capture.finish().is_err());
        scope.finish().await.unwrap();
        let (source, mut capture) = f.capture(1, json!(null), ResourceEncoding::Utf8);
        capture.write("text", 0, &[0xff]).unwrap();
        assert!(capture.finish().err().unwrap().contains("not UTF-8"));
        source.finish().await.unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn frozen_inputs_preserve_metadata_text_boundaries_and_original_application_scope() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        let other = Fixture::new(MethodMode::Query).await;
        for foreign_application in [false, true] {
            let (original, mut capture) = f.capture(1, json!(null), ResourceEncoding::Bytes);
            capture.write("text", 0, b"x").unwrap();
            let target = if foreign_application { &other } else { &f };
            let incoming = if foreign_application {
                original.clone()
            } else {
                scope(&f.issuer, true)
            };
            let error = target
                .client
                .start(
                    target.binding.clone(),
                    "echo".into(),
                    json!("x"),
                    incoming.clone(),
                    capture.finish().unwrap(),
                )
                .await
                .err()
                .unwrap();
            assert!(error.contains(if foreign_application {
                "another Application"
            } else {
                "another request Scope"
            }));
            original.finish().await.unwrap();
            incoming.finish().await.unwrap();
        }
        let data = "中🦀a".as_bytes();
        let metadata = json!({"owner":"original editor","revision":42,"bytes":data.len()});
        let (source, mut capture) =
            f.capture(data.len() as u64, metadata.clone(), ResourceEncoding::Utf8);
        capture.write("text", 0, &data[..2]).unwrap();
        capture.write("text", 2, &data[2..]).unwrap();
        let completion = f
            .client
            .start(
                f.binding.clone(),
                "echo".into(),
                json!("inspect"),
                source.clone(),
                capture.finish().unwrap(),
            )
            .await
            .unwrap()
            .completion()
            .await;
        completion.cleanup.unwrap();
        let value = observation(completion.result.unwrap());
        assert_eq!(value["metadata"], metadata);
        assert_eq!(value["first"], json!(data));
        assert_eq!(value["encoding"], "utf8");
        assert_eq!(value["splitRejected"], true);
        assert_eq!(value["emptySplitRejected"], true);
        source.finish().await.unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        assert_eq!(other.calls.load(Ordering::SeqCst), 0);
        f.app.shutdown().await.unwrap();
        other.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn captured_stream_parent_ticket_tracks_real_child_cleanup() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Subscription).await;
        let (source, mut capture) =
            f.capture(5, json!({"owner":"stream"}), ResourceEncoding::Bytes);
        capture.write("text", 0, b"xxxxx").unwrap();
        let mut stream = f
            .client
            .subscribe(
                f.binding.clone(),
                "echo".into(),
                json!("hold"),
                source.clone(),
                capture.finish().unwrap(),
            )
            .await
            .unwrap();
        permit(&f.started).await;
        f.release.add_permits(1);
        let item = stream.recv().await.unwrap();
        assert_eq!(observation(item)["metadata"]["owner"], "stream");
        assert_eq!(stream.recv().await, None);
        let completion = stream.completion().await;
        completion.result.unwrap();
        completion.cleanup.unwrap();
        source.finish().await.unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn failed_captured_cleanup_retains_all_payload_capacity_without_a_completion_waiter() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        let (source, mut capture) =
            f.capture(64 * 1024 * 1024, json!(null), ResourceEncoding::Bytes);
        let chunk = vec![b'x'; RESOURCE_CHUNK_LIMIT];
        for offset in (0..64 * 1024 * 1024).step_by(RESOURCE_CHUNK_LIMIT) {
            capture.write("text", offset as u64, &chunk).unwrap();
        }
        let accepted = f
            .client
            .start(
                f.binding.clone(),
                "echo".into(),
                json!("fail"),
                source.clone(),
                capture.finish().unwrap(),
            )
            .await
            .unwrap();
        permit(&f.started).await;
        drop(accepted);
        f.release.add_permits(1);
        assert!(source.finish().await.is_err());
        let next = scope(&f.issuer, true);
        assert!(
            f.client
                .capture_resources(
                    next.clone(),
                    descriptors(1, json!(null), ResourceEncoding::Bytes)
                )
                .err()
                .unwrap()
                .contains("attachment budget")
        );
        next.finish().await.unwrap();
        assert!(f.app.shutdown().await.is_err());
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn application_close_does_not_acknowledge_an_external_partial_receiver() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        let (source, mut capture) = f.capture(5, json!(null), ResourceEncoding::Bytes);
        capture.write("text", 0, b"x").unwrap();
        f.app.shutdown().await.unwrap();
        assert!(capture.write("text", 1, b"x").is_err());
        let finish = source.finish();
        tokio::pin!(finish);
        assert!(futures_util::poll!(&mut finish).is_pending());
        drop(capture);
        finish.await.unwrap();
        assert!(
            f.client
                .capture_resources(scope(&f.issuer, true), BTreeMap::new())
                .is_err()
        );
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    })
    .await
    .unwrap();
}

struct GrowingMetadata(AtomicUsize);
impl ReadResource for GrowingMetadata {
    fn resource_type(&self) -> ResourceType {
        ResourceType {
            name: "example.Bytes".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        1
    }
    fn metadata(&self) -> Value {
        if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
            json!(null)
        } else {
            json!("m".repeat(400_000))
        }
    }
    fn read(&self, _: std::ops::Range<usize>) -> Result<Vec<u8>> {
        panic!("changed descriptor cannot reach the effect")
    }
}
#[tokio::test]
async fn final_owner_rejects_metadata_growth_beyond_the_original_json_reservation() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new(MethodMode::Query).await;
        let resource = Arc::new(GrowingMetadata(AtomicUsize::new(0)));
        let weak = Arc::downgrade(&resource);
        let attachments = Attachments::from([("text".into(), resource as Arc<dyn ReadResource>)]);
        let source = scope(&f.issuer, true);
        assert!(
            f.client
                .start(
                    f.binding.clone(),
                    "echo".into(),
                    json!("x"),
                    source.clone(),
                    attachments.into()
                )
                .await
                .err()
                .unwrap()
                .contains("descriptor changed")
        );
        assert!(weak.upgrade().is_none());
        source.finish().await.unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        let (source, capture) = f.capture(0, json!(null), ResourceEncoding::Bytes);
        drop(capture);
        source.finish().await.unwrap();
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

struct GrowingPayload(AtomicUsize);
impl ReadResource for GrowingPayload {
    fn resource_type(&self) -> ResourceType {
        ResourceType {
            name: "example.Bytes".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        64 * 1024 * 1024 + 1 + self.0.fetch_add(1, Ordering::SeqCst)
    }
    fn metadata(&self) -> Value {
        Value::Null
    }
    fn read(&self, _: std::ops::Range<usize>) -> Result<Vec<u8>> {
        panic!("changed payload must not reach the effect")
    }
}
#[tokio::test]
async fn soft_packed_owner_rejects_actual_payload_growth_even_when_charge_is_unchanged() {
    let f = Fixture::new(MethodMode::Query).await;
    let source = scope(&f.issuer, true);
    let resource: Arc<dyn ReadResource> = Arc::new(GrowingPayload(AtomicUsize::new(0)));
    let error = f
        .client
        .start(
            f.binding.clone(),
            "echo".into(),
            json!("inspect"),
            source.clone(),
            Attachments::from([("text".into(), resource)]).into(),
        )
        .await
        .err()
        .unwrap();
    assert!(error.contains("descriptor changed"));
    source.finish().await.unwrap();
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    let (probe, capture) = f.capture(1, json!(null), ResourceEncoding::Bytes);
    drop(capture);
    probe.finish().await.unwrap();
    f.app.shutdown().await.unwrap();
}
