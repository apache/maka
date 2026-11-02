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

//! Physical failure and interrupted confirmations retain their original fences.
use crate::support;
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_host_runtime::application::{Application, NativeRegistry};
use maka_plugin_core::deployment::DeploymentRef;
use maka_transport::{
    transport::{Call, Endpoint, Grant, Peer, PeerPolicy, Reply, Server, Source},
    with_gateway,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf};
use uuid::Uuid;
struct Fixture {
    _directory: tempfile::TempDir,
    namespaces: RootNamespaces,
    root: std::path::PathBuf,
    caller_root: std::path::PathBuf,
    store: Arc<RootStore>,
    caller: Arc<RootStore>,
    source: DeploymentRef,
    app: Application,
    server: Arc<Server>,
    peer: Arc<maka_transport::transport::Peers>,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let root = directory.path().join("host");
        let caller_root = directory.path().join("caller");
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
        let store = Arc::new(support::setup(RootStore::open(owner)).await.unwrap());
        let owner = Arc::new(RootOwner::create(&caller_root, &namespaces).unwrap());
        let caller = Arc::new(support::setup(RootStore::open(owner)).await.unwrap());
        let (input, packages, observations) = support::caller();
        let source = caller
            .commit_application(Uuid::new_v4(), 0, input, observations, packages)
            .await
            .unwrap();
        let deployment = Uuid::new_v4();
        let (input, packages) = support::host();
        store
            .commit_application(deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let policy = Arc::new(PeerPolicy::default());
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            with_gateway(NativeRegistry::default()).unwrap(),
            policy.issuer(),
            policy.clone(),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let consumer = client.activation(&support::identity(13)).unwrap();
        let binding = client
            .bind(consumer, "business".into())
            .await
            .unwrap()
            .pop()
            .unwrap();
        let endpoint = Endpoint::new(
            binding,
            Grant {
                methods: BTreeSet::from(["read".into(), "write".into()]),
                recovery: false,
            },
        )
        .unwrap();
        let reader = client
            .bind(
                client.activation(&support::identity(13)).unwrap(),
                "receipts".into(),
            )
            .await
            .unwrap()
            .pop()
            .unwrap();
        let reader = Endpoint::new(
            reader,
            Grant {
                methods: BTreeSet::from(["read".into()]),
                recovery: true,
            },
        )
        .unwrap();
        let server = Server::new(
            client,
            policy,
            BTreeMap::from([("business".into(), endpoint), ("receipts".into(), reader)]),
        )
        .unwrap();
        let peer = maka_transport::transport::Peers::new(
            Peer::new(source.clone(), BTreeSet::from([support::identity(2)])).unwrap(),
        );
        Self {
            _directory: directory,
            namespaces,
            root,
            caller_root,
            store,
            caller,
            source,
            app,
            server,
            peer,
        }
    }
    async fn cleanup(self) {
        self.app.shutdown().await.unwrap();
        drop(self.server);
        drop(self.app);
        self.store.shutdown().await.unwrap();
        drop(self.store);
        self.caller.shutdown().await.unwrap();
        drop(self.caller);
        drop(RootOwner::open(&self.root, &self.namespaces).unwrap());
    }
}
struct PanicReader;
impl AsyncRead for PanicReader {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
impl Drop for PanicReader {
    fn drop(&mut self) {
        panic!("physical input cleanup failed");
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn physical_drop_panic_is_a_sticky_server_failure_before_root_shutdown() {
    let f = Fixture::new().await;
    let observer = f
        .server
        .serve(PanicReader, tokio::io::sink(), f.peer.clone())
        .unwrap();
    assert!(observer.await.is_err());
    assert!(f.server.close().await.unwrap_err().contains("panicked"));
    assert!(f.server.close().await.is_err());
    assert_eq!(
        RootOwner::open(&f.root, &f.namespaces)
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    // Explicit fixture teardown, never a claimed server cleanup receipt.
    f.cleanup().await;
}
struct PartialWriter {
    inner: DuplexStream,
    stage: Arc<AtomicUsize>,
    written: Arc<AtomicUsize>,
}
impl AsyncWrite for PartialWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let stage = self.stage.load(Ordering::SeqCst);
        if stage == 2 {
            return Poll::Pending;
        }
        let bytes = if stage == 1 {
            &bytes[..bytes.len().min(2)]
        } else {
            bytes
        };
        match Pin::new(&mut self.inner).poll_write(cx, bytes) {
            Poll::Ready(Ok(n)) => {
                self.written.fetch_add(n, Ordering::SeqCst);
                if stage == 1 {
                    self.stage.store(2, Ordering::SeqCst);
                }
                Poll::Ready(Ok(n))
            }
            other => other,
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_partial_commit_keeps_real_sql_token_and_cannot_append_cancel() {
    let f = Fixture::new().await;
    let (server_input, output) = tokio::io::duplex(64 * 1024);
    let (server_output, input) = tokio::io::duplex(64 * 1024);
    let observer = f
        .server
        .serve(server_input, server_output, f.peer.clone())
        .unwrap();
    let stage = Arc::new(AtomicUsize::new(0));
    let written = Arc::new(AtomicUsize::new(0));
    let source = Source {
        deployment: f.source.clone(),
        consumer: support::identity(2),
        mount: uuid::Uuid::new_v4(),
        request: Uuid::new_v4(),
    };
    let mut call = Call::new(
        input,
        PartialWriter {
            inner: output,
            stage: stage.clone(),
            written: written.clone(),
        },
        f.server.catalogue().select("business").unwrap(),
        source,
        "write".into(),
        serde_json::Value::Null,
        Default::default(),
    );
    call.start().await.unwrap();
    assert!(matches!(
        call.receive().await.unwrap(),
        Reply::Prepared { .. }
    ));
    let reference = call.reference().unwrap().clone();
    let recorded = f
        .caller
        .record_application_intent(
            f.source.clone(),
            support::identity(2),
            reference.clone(),
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    let before = written.load(Ordering::SeqCst);
    stage.store(1, Ordering::SeqCst);
    {
        let mut commit = Box::pin(call.commit(recorded));
        assert!(futures_util::poll!(&mut commit).is_pending());
    }
    assert_eq!(written.load(Ordering::SeqCst), before + 2);
    assert!(call.holds_caller_intent());
    assert!(!call.cleanup_confirmed());
    stage.store(3, Ordering::SeqCst);
    assert!(call.cancel().await.is_err());
    assert_eq!(written.load(Ordering::SeqCst), before + 2);
    call.disconnect();
    // Only the caller public API can close this half-written channel. Original
    // server work must settle from physical EOF without Server.close().
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), observer)
            .await
            .unwrap()
            .is_err()
    );
    assert!(call.holds_caller_intent());
    assert!(!call.cleanup_confirmed());
    assert_eq!(written.load(Ordering::SeqCst), before + 2);
    f.server.close().await.unwrap();
    assert!(
        f.store
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .is_none()
    );
    let Fixture {
        _directory,
        namespaces,
        caller_root,
        store,
        caller,
        app,
        server,
        ..
    } = f;
    app.shutdown().await.unwrap();
    drop(server);
    drop(app);
    store.shutdown().await.unwrap();
    drop(store);
    Arc::try_unwrap(caller).ok().unwrap().close().await.unwrap();
    assert_eq!(
        RootOwner::open(&caller_root, &namespaces)
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    // The trusted fixture has separately observed original server close. No
    // remote frame, historical receipt or cancelled future supplied that ack.
    drop(call);
    drop(RootOwner::open(&caller_root, &namespaces).unwrap());
}

#[tokio::test]
async fn private_peer_cannot_delegate_its_caller_intent_to_the_host() {
    let f = Fixture::new().await;
    let (channel, accepted) = tokio::io::duplex(64 * 1024);
    let (reader, writer) = tokio::io::split(accepted);
    let observer = f.server.serve(reader, writer, f.peer.clone()).unwrap();
    let (reader, writer) = tokio::io::split(channel);
    let operation = Uuid::new_v4();
    let mut call = Call::new(
        reader,
        writer,
        f.server.catalogue().select("business").unwrap(),
        Source {
            deployment: f.source.clone(),
            consumer: support::identity(2),
            mount: Uuid::new_v4(),
            request: operation,
        },
        "write".into(),
        serde_json::Value::Null,
        Default::default(),
    );
    call.start().await.unwrap();
    assert!(matches!(
        call.receive().await.unwrap(),
        Reply::Prepared { .. }
    ));
    assert!(matches!(
        call.confirm().await.unwrap(),
        Reply::Aborted {
            cleanup: Ok(()),
            ..
        }
    ));
    observer.await.unwrap();
    assert!(
        f.caller
            .application_intent(f.source.deployment, support::identity(2), operation)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        f.store
            .application_intent(
                f.app.source().unwrap().deployment,
                support::identity(13),
                operation
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(call.cleanup_confirmed());
    drop(call);
    f.server.close().await.unwrap();
    f.cleanup().await;
}
