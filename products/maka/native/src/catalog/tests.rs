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
use futures_util::future::BoxFuture;
use maka_agent_ports::model::{Connect, Error, Socket};
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Mutex};
use tokio::sync::Semaphore;

struct Reply {
    status: u16,
    body: Value,
    etag: &'static str,
}
struct Script {
    replies: Mutex<BTreeMap<String, VecDeque<Reply>>>,
    requests: Mutex<Vec<http::BufferedRequest>>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Transport for Script {
    fn identity(&self) -> u64 {
        1
    }
    fn request(
        &self,
        request: http::Request,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, Error>> {
        Box::pin(async move {
            let http::Request {
                url,
                method,
                headers,
                body,
            } = request;
            let mut upload = body.into_stream();
            let mut body = Vec::new();
            while let Some(chunk) = futures_util::StreamExt::next(&mut upload).await {
                body.extend_from_slice(&chunk.unwrap());
            }
            let request = http::BufferedRequest {
                url,
                method,
                headers,
                body,
            };
            let reply = self
                .replies
                .lock()
                .unwrap()
                .get_mut(&request.url)
                .unwrap()
                .pop_front()
                .expect("unexpected extra public refresh");
            self.requests.lock().unwrap().push(request);
            self.entered.add_permits(1);
            self.release.acquire().await.unwrap().forget();
            Ok(http::Response {
                head: http::Head {
                    status: reply.status,
                    url: String::new(),
                    headers: vec![("ETag".into(), reply.etag.as_bytes().to_vec())],
                },
                body: Arc::new(Bytes(Mutex::new(Some(
                    serde_json::to_vec(&reply.body).unwrap(),
                )))),
            })
        })
    }
    fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, Error>> {
        Box::pin(async { Err(Error::Adapter("catalogs do not use WebSockets".into())) })
    }
}
struct Bytes(Mutex<Option<Vec<u8>>>);
impl http::Body for Bytes {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async { Ok(self.0.lock().unwrap().take()) })
    }
    fn cancel(&self) {}
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async {
            self.0.lock().unwrap().take();
            Ok(())
        })
    }
}
fn record(body: Value, etag: &str) -> PublicCatalogRecord {
    PublicCatalogRecord {
        body: PublicCatalogBody::from_json(body.to_string()).unwrap(),
        etag: Some(etag.into()),
        last_modified: Some("Wed, 21 Oct 2026 08:00:00 GMT".into()),
        checked_at: 1,
    }
}
fn root(directory: &tempfile::TempDir) -> Arc<RootOwner> {
    maka_event_log::root::private_directory(directory.path()).unwrap();
    Arc::new(
        RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn conditional_refresh_is_single_flight_and_keeps_last_good_after_invalid_responses() {
    let directory = tempfile::tempdir().unwrap();
    let root = root(&directory);
    let audit = ConfigurationStore::for_root(root.clone()).await.unwrap();
    audit
        .put_public_catalog(
            PublicCatalogSource::ModelsDev,
            record(json!({}), "models-old"),
        )
        .await
        .unwrap();
    let before = audit
        .put_public_catalog(
            PublicCatalogSource::OpenRouter,
            record(
                json!({"data":[{"id":"runtime-test/model","name":"Old public name"}]}),
                "router-old",
            ),
        )
        .await
        .unwrap();
    let updated = json!({"data":[{"id":"runtime-test/model","name":"New public name"}]});
    let transport = Arc::new(Script {
        replies: Mutex::new(BTreeMap::from([
            (
                SOURCES[0].1.into(),
                VecDeque::from([
                    Reply {
                        status: 304,
                        body: Value::Null,
                        etag: "models-new",
                    },
                    Reply {
                        status: 200,
                        body: json!([]),
                        etag: "invalid",
                    },
                    Reply {
                        status: 304,
                        body: Value::Null,
                        etag: "models-new",
                    },
                ]),
            ),
            (
                SOURCES[1].1.into(),
                VecDeque::from([
                    Reply {
                        status: 200,
                        body: updated.clone(),
                        etag: "router-new",
                    },
                    Reply {
                        status: 200,
                        body: json!({"data":[{"id":"broken","name":false}]}),
                        etag: "invalid",
                    },
                    Reply {
                        status: 200,
                        body: json!({"data":[]}),
                        etag: "router-empty",
                    },
                ]),
            ),
        ])),
        requests: Mutex::new(Vec::new()),
        entered: Arc::new(Semaphore::new(0)),
        release: Arc::new(Semaphore::new(0)),
    });
    let mut runtime = RuntimeCatalog::with_transport(
        ConfigurationStore::for_root(root.clone()).await.unwrap(),
        transport.clone(),
    )
    .await
    .unwrap();
    let catalog = runtime.catalog();
    assert_eq!(
        catalog
            .snapshot
            .read()
            .await
            .as_ref()
            .unwrap()
            .get("openrouter", "runtime-test/model")
            .unwrap()
            .display_name
            .as_deref(),
        Some("Old public name")
    );
    runtime.start(std::future::pending());
    let release = async {
        transport.entered.acquire_many(2).await.unwrap().forget();
        transport.release.add_permits(2);
    };
    let (first, second, ()) = tokio::join!(
        catalog.request_refresh().unwrap(),
        runtime.refresh(),
        release
    );
    first.unwrap().unwrap();
    second.unwrap();
    assert_eq!(
        transport.requests.lock().unwrap().len(),
        2,
        "concurrent intents must share the startup refresh"
    );
    let current = audit.public_catalog().await.unwrap();
    assert_eq!(
        current.catalog_revision,
        before + 1,
        "304 freshness must not advance the catalog"
    );
    assert_eq!(
        serde_json::from_str::<Value>(
            current.sources[&PublicCatalogSource::ModelsDev]
                .body
                .as_raw()
                .get()
        )
        .unwrap(),
        json!({})
    );
    assert_eq!(
        current.sources[&PublicCatalogSource::ModelsDev]
            .etag
            .as_deref(),
        Some("models-new")
    );
    assert!(current.sources[&PublicCatalogSource::ModelsDev].checked_at > 1);
    assert_eq!(
        serde_json::from_str::<Value>(
            current.sources[&PublicCatalogSource::OpenRouter]
                .body
                .as_raw()
                .get()
        )
        .unwrap(),
        updated
    );
    assert_eq!(
        catalog
            .snapshot
            .read()
            .await
            .as_ref()
            .unwrap()
            .get("openrouter", "runtime-test/model")
            .unwrap()
            .display_name
            .as_deref(),
        Some("New public name")
    );
    for request in transport.requests.lock().unwrap().iter() {
        assert!(
            request
                .headers
                .iter()
                .any(|(name, _)| name == "if-none-match")
        );
        assert!(
            request
                .headers
                .iter()
                .any(|(name, _)| name == "if-modified-since")
        );
        assert!(
            request
                .headers
                .iter()
                .all(|(name, _)| !name.eq_ignore_ascii_case("authorization")
                    && !name.eq_ignore_ascii_case("proxy-authorization"))
        );
        assert!(request.body.is_empty());
    }
    transport.release.add_permits(2);
    assert!(catalog.request_refresh().unwrap().await.unwrap().is_err());
    let retained = audit.public_catalog().await.unwrap();
    let why = "invalid sources must preserve both durable last-good records";
    assert_eq!(retained.catalog_revision, current.catalog_revision, "{why}");
    assert_eq!(retained.sources.len(), current.sources.len(), "{why}");
    assert_eq!(
        retained.sources.keys().collect::<Vec<_>>(),
        current.sources.keys().collect::<Vec<_>>(),
        "{why}"
    );
    for (source, original) in &current.sources {
        assert!(
            retained.sources[source].same_content(original).unwrap(),
            "{why}"
        );
    }
    assert_eq!(
        catalog
            .snapshot
            .read()
            .await
            .as_ref()
            .unwrap()
            .get("openrouter", "runtime-test/model")
            .unwrap()
            .display_name
            .as_deref(),
        Some("New public name")
    );
    transport.release.add_permits(2);
    catalog.request_refresh().unwrap().await.unwrap().unwrap();
    assert!(
        catalog
            .snapshot
            .read()
            .await
            .as_ref()
            .unwrap()
            .get("openrouter", "runtime-test/model")
            .is_none(),
        "a successful empty source must remove its old public-only model"
    );
    assert_eq!(
        audit.public_catalog().await.unwrap().catalog_revision,
        before + 2
    );
    runtime.shutdown().await.unwrap();
    assert!(
        catalog.request_refresh().is_err(),
        "a retired owner cannot admit another refresh"
    );
    audit.close().await.unwrap();
    drop(root);
}

#[tokio::test]
async fn failed_publication_reconciles_durable_state_or_fails_the_reader_closed() {
    use sqlx::Connection;
    let directory = tempfile::tempdir().unwrap();
    let root = root(&directory);
    let audit = ConfigurationStore::for_root(root.clone()).await.unwrap();
    audit
        .put_public_catalog(
            PublicCatalogSource::ModelsDev,
            record(json!({}), "models-old"),
        )
        .await
        .unwrap();
    let original = record(
        json!({"data":[{"id":"runtime-test/model","name":"Durable original"}]}),
        "router-old",
    );
    let revision = audit
        .put_public_catalog(PublicCatalogSource::OpenRouter, original.clone())
        .await
        .unwrap();
    let transport = Arc::new(Script {
        replies: Mutex::new(BTreeMap::from([
            (
                SOURCES[0].1.into(),
                VecDeque::from([
                    Reply {
                        status: 304,
                        body: Value::Null,
                        etag: "models-new",
                    },
                    Reply {
                        status: 304,
                        body: Value::Null,
                        etag: "models-new",
                    },
                ]),
            ),
            (
                SOURCES[1].1.into(),
                VecDeque::from([
                    Reply {
                        status: 200,
                        body: json!({"data":[]}),
                        etag: "router-new",
                    },
                    Reply {
                        status: 200,
                        body: json!({"data":[]}),
                        etag: "router-new",
                    },
                ]),
            ),
        ])),
        requests: Mutex::new(Vec::new()),
        entered: Arc::new(Semaphore::new(0)),
        release: Arc::new(Semaphore::new(0)),
    });
    let mut runtime = RuntimeCatalog::with_transport(
        ConfigurationStore::for_root(root.clone()).await.unwrap(),
        transport.clone(),
    )
    .await
    .unwrap();
    let catalog = runtime.catalog();
    let mut fault = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.canonical_path().join("configuration-rust.sqlite")),
    )
    .await
    .unwrap();
    // Use a real failed transaction, not a fabricated commit receipt. Recovery
    // must read the durable body while publication remains fenced.
    sqlx::query("CREATE TRIGGER reject_public_catalog BEFORE INSERT ON public_catalog WHEN NEW.source='openrouter' BEGIN SELECT RAISE(ABORT,'injected write failure'); END").execute(&mut fault).await.unwrap();
    runtime.start(std::future::pending());
    let release = async {
        transport.entered.acquire_many(2).await.unwrap().forget();
        transport.release.add_permits(2);
    };
    let (receipt, ()) = tokio::join!(runtime.refresh(), release);
    assert!(receipt.is_err());
    let durable = audit.public_catalog().await.unwrap();
    assert_eq!(durable.catalog_revision, revision);
    assert!(
        durable.sources[&PublicCatalogSource::OpenRouter]
            .same_content(&original)
            .unwrap()
    );
    assert_eq!(
        catalog
            .snapshot
            .read()
            .await
            .as_ref()
            .unwrap()
            .get("openrouter", "runtime-test/model")
            .unwrap()
            .display_name
            .as_deref(),
        Some("Durable original")
    );
    sqlx::query("DROP TRIGGER reject_public_catalog")
        .execute(&mut fault)
        .await
        .unwrap();
    let invalidate = async {
        // The refresh has already captured the prior cache, but neither source
        // has returned. Losing durable state must retire the readable snapshot.
        transport.entered.acquire_many(2).await.unwrap().forget();
        sqlx::query("DROP TABLE public_catalog")
            .execute(&mut fault)
            .await
            .unwrap();
        transport.release.add_permits(2);
    };
    let (receipt, ()) = tokio::join!(runtime.refresh(), invalidate);
    assert!(receipt.is_err());
    assert!(
        catalog.snapshot.read().await.is_err(),
        "unreconciled SQL state must never expose the old metadata reader"
    );
    runtime.shutdown().await.unwrap();
    fault.close().await.unwrap();
    audit.close().await.unwrap();
}

struct Closing {
    entered: Arc<Semaphore>,
    closing: Arc<Semaphore>,
    acknowledgement: Arc<Semaphore>,
    acknowledged: Arc<Semaphore>,
    unconfirmed: bool,
}
impl Transport for Closing {
    fn identity(&self) -> u64 {
        2
    }
    fn request(
        &self,
        request: http::Request,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, Error>> {
        Box::pin(async move {
            let mut upload = request.body.into_stream();
            while let Some(chunk) = futures_util::StreamExt::next(&mut upload).await {
                assert!(chunk.unwrap().is_empty());
            }
            Ok(http::Response {
                head: http::Head {
                    status: 200,
                    url: String::new(),
                    headers: vec![],
                },
                body: Arc::new(PendingBody {
                    entered: self.entered.clone(),
                    closing: self.closing.clone(),
                    acknowledgement: self.acknowledgement.clone(),
                    acknowledged: self.acknowledged.clone(),
                    unconfirmed: self.unconfirmed,
                }),
            })
        })
    }
    fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, Error>> {
        Box::pin(async { Err(Error::Adapter("catalogs do not use WebSockets".into())) })
    }
}
struct PendingBody {
    entered: Arc<Semaphore>,
    closing: Arc<Semaphore>,
    acknowledgement: Arc<Semaphore>,
    acknowledged: Arc<Semaphore>,
    unconfirmed: bool,
}
impl http::Body for PendingBody {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async {
            self.entered.add_permits(1);
            std::future::pending().await
        })
    }
    fn cancel(&self) {}
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async {
            self.closing.add_permits(1);
            self.acknowledgement.acquire().await.unwrap().forget();
            self.acknowledged.add_permits(1);
            if self.unconfirmed {
                Err(http::Error::CleanupUnconfirmed)
            } else {
                Ok(())
            }
        })
    }
}
#[tokio::test]
async fn shutdown_joins_both_bodies_and_preserves_unconfirmed_cleanup() {
    for unconfirmed in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let root = root(&directory);
        let transport = Arc::new(Closing {
            entered: Arc::new(Semaphore::new(0)),
            closing: Arc::new(Semaphore::new(0)),
            acknowledgement: Arc::new(Semaphore::new(0)),
            acknowledged: Arc::new(Semaphore::new(0)),
            unconfirmed,
        });
        let mut runtime = RuntimeCatalog::with_transport(
            ConfigurationStore::for_root(root.clone()).await.unwrap(),
            transport.clone(),
        )
        .await
        .unwrap();
        runtime.start(std::future::pending());
        transport.entered.acquire_many(2).await.unwrap().forget();
        let shutdown = tokio::spawn(async move { runtime.shutdown().await });
        transport.closing.acquire_many(2).await.unwrap().forget();
        assert!(
            !shutdown.is_finished(),
            "cancel is not a cleanup acknowledgement"
        );
        transport.acknowledgement.add_permits(1);
        transport.acknowledged.acquire().await.unwrap().forget();
        assert!(
            !shutdown.is_finished(),
            "one response acknowledgement cannot close the other response"
        );
        transport.acknowledgement.add_permits(1);
        assert_eq!(shutdown.await.unwrap().is_err(), unconfirmed);
        drop(root);
    }
}

struct RawResponse(Arc<RawBody>);
struct RawBody {
    bytes: Mutex<Option<Vec<u8>>>,
    cancelled: std::sync::atomic::AtomicBool,
    closed: std::sync::atomic::AtomicBool,
}
impl Transport for RawResponse {
    fn identity(&self) -> u64 {
        3
    }
    fn request(
        &self,
        request: http::Request,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, Error>> {
        Box::pin(async move {
            let mut upload = request.body.into_stream();
            while let Some(chunk) = futures_util::StreamExt::next(&mut upload).await {
                assert!(chunk.unwrap().is_empty());
            }
            Ok(http::Response {
                head: http::Head {
                    status: 200,
                    url: String::new(),
                    headers: vec![],
                },
                body: self.0.clone(),
            })
        })
    }
    fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, Error>> {
        Box::pin(async { Err(Error::Adapter("catalogs do not use WebSockets".into())) })
    }
}
impl http::Body for RawBody {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async { Ok(self.bytes.lock().unwrap().take()) })
    }
    fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async {
            self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
    }
}
#[tokio::test]
async fn invalid_utf8_and_hidden_invalid_json_still_close_the_http_body() {
    for bytes in [
        b"{\"unknown\":\"\xff\"}".to_vec(),
        br#"{"data":[],"unknown":1e,"unknown":null}"#.to_vec(),
        br#"{"data":[],"unknown":"\ud800","unknown":null}"#.to_vec(),
    ] {
        let body = Arc::new(RawBody {
            bytes: Mutex::new(Some(bytes)),
            cancelled: false.into(),
            closed: false.into(),
        });
        assert!(
            fetch(
                Arc::new(RawResponse(body.clone())),
                SOURCES[1].1,
                None,
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        assert!(body.cancelled.load(std::sync::atomic::Ordering::SeqCst));
        assert!(body.closed.load(std::sync::atomic::Ordering::SeqCst));
    }
}

#[tokio::test]
async fn numeric_overflow_follows_value_acceptance_and_closes_the_http_body() {
    for input in [
        r#"{"data":[],"unknown":1e400,"unknown":null}"#,
        r#"{"data":[],"unknown":1e400}"#,
    ] {
        let expected = serde_json::from_str::<Value>(input);
        let body = Arc::new(RawBody {
            bytes: Mutex::new(Some(input.as_bytes().to_vec())),
            cancelled: false.into(),
            closed: false.into(),
        });
        let result = fetch(
            Arc::new(RawResponse(body.clone())),
            SOURCES[1].1,
            None,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(result.is_ok(), expected.is_ok());
        if let Ok(record) = result {
            assert_eq!(record.body.as_raw().get(), input);
            assert_eq!(
                serde_json::from_str::<Value>(record.body.as_raw().get()).unwrap(),
                expected.unwrap()
            );
        }
        assert!(body.cancelled.load(std::sync::atomic::Ordering::SeqCst));
        assert!(body.closed.load(std::sync::atomic::Ordering::SeqCst));
    }
}
