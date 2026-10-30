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
