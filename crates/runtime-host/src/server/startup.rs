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

use super::{Host, LifecycleMode, retirement::Phase};
use std::sync::atomic::Ordering;

impl Host {
    /// Abandon an ephemeral launcher that lost its owner before admitting a client.
    /// Handshake admission and this decision share a gate; a published or still
    /// flushing acceptance transfers lifetime to normal Host residency rules.
    pub fn abandon_unaccepted_startup(&self) {
        if self.options.lifecycle_mode != LifecycleMode::Ephemeral {
            return;
        }
        let mut phase = self
            .retirement
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *phase != Phase::Ready || self.draining.is_cancelled() {
            return;
        }
        let accepted = self.accepted_connections.lock().unwrap();
        // Hold the set while reading the sticky revision: a flushed acceptance
        // must not disappear between observing the counter and the live set.
        if !accepted.is_empty() || self.accepted_connection_revision.load(Ordering::SeqCst) != 0 {
            drop(accepted);
            drop(phase);
            self.record_diagnostic("Startup launcher gone; accepted clients retain Host lifetime");
            return;
        }
        *phase = Phase::Retiring;
        self.draining.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_event_log::root::{RootNamespaces, RootOwner};
    use maka_protocol::handshake::{ClientHello, HostHandshake};
    use maka_transport::{MessageReader, MessageWriter, TransportError};
    use serde_json::{Value, json};
    use std::{path::PathBuf, sync::Arc, time::Duration};
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    struct Fixture {
        host: Arc<Host>,
        root: PathBuf,
        namespaces: RootNamespaces,
        directory: tempfile::TempDir,
    }
    impl Fixture {
        async fn new(mode: LifecycleMode) -> Self {
            let directory = tempfile::tempdir().unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                    .unwrap();
            }
            let namespaces = RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            };
            let root = directory.path().join("root");
            let owner = RootOwner::create(&root, &namespaces).unwrap();
            let host = Host::open_with_options(
                owner,
                None,
                super::super::HostOptions {
                    lifecycle_mode: mode,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            Self {
                host,
                root,
                namespaces,
                directory,
            }
        }
        async fn finish(self) {
            #[cfg(unix)]
            let endpoint = self.directory.path().join("host.sock");
            #[cfg(windows)]
            let endpoint =
                PathBuf::from(format!(r"\\.\pipe\maka-startup-{}", uuid::Uuid::new_v4()));
            let listener = super::super::local::LocalListener::bind(&endpoint).unwrap();
            let stop = CancellationToken::new();
            stop.cancel();
            listener.serve(self.host.clone(), stop).await.unwrap();
            drop(self.host);
            drop(RootOwner::open(&self.root, &self.namespaces).unwrap());
        }
    }
    fn hello() -> ClientHello {
        maka_protocol::handshake::decode_hello(&json!({
            "kind":"hello", "clientInstanceId":"startup-owner-test",
            "protocolMin":0,"protocolMax":0,
            "compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH,
            "compositionId":"maka.interactive"
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn abandoned_unaccepted_startup_seals_later_handshake_admission() {
        let fixture = Fixture::new(LifecycleMode::Ephemeral).await;
        fixture.host.abandon_unaccepted_startup();
        assert!(fixture.host.draining.is_cancelled());
        let (reply, accepted, _) = fixture
            .host
            .admit_handshake(
                &hello(),
                &super::super::authority::Authority::LocalOwner,
                uuid::Uuid::new_v4(),
            )
            .unwrap();
        assert!(matches!(reply, HostHandshake::Draining { .. }));
        assert!(accepted.is_none());
        drop(accepted);
        fixture.finish().await;
    }

    struct Reader(mpsc::UnboundedReceiver<Value>);
    impl MessageReader for Reader {
        async fn read(&mut self) -> Result<Option<Value>, TransportError> {
            Ok(self.0.recv().await)
        }
    }
    struct GatedWriter {
        entered: CancellationToken,
        release: CancellationToken,
    }
    impl MessageWriter for GatedWriter {
        async fn write(&mut self, value: &Value) -> Result<(), TransportError> {
            if value["kind"] == "accepted" {
                self.entered.cancel();
                self.release.cancelled().await;
            }
            Ok(())
        }
        async fn close_after_flush(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn accepted_and_published_clients_outlive_startup_owner_loss() {
        let fixture = Fixture::new(LifecycleMode::Ephemeral).await;
        let (sender, receiver) = mpsc::unbounded_channel();
        let entered = CancellationToken::new();
        let release = CancellationToken::new();
        let connection = tokio::spawn(fixture.host.clone().local_owner_connection(
            Reader(receiver),
            GatedWriter {
                entered: entered.clone(),
                release: release.clone(),
            },
        ));
        sender.send(serde_json::to_value(hello()).unwrap()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), entered.cancelled())
            .await
            .unwrap();
        assert_eq!(
            fixture
                .host
                .accepted_connection_revision
                .load(Ordering::SeqCst),
            0
        );
        fixture.host.abandon_unaccepted_startup();
        assert!(
            !fixture.host.draining.is_cancelled(),
            "admitted handshake is still flushing"
        );
        release.cancel();
        drop(sender);
        tokio::time::timeout(Duration::from_secs(5), connection)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(fixture.host.accepted_connections.lock().unwrap().is_empty());
        assert_eq!(
            fixture
                .host
                .accepted_connection_revision
                .load(Ordering::SeqCst),
            1
        );
        fixture.host.abandon_unaccepted_startup();
        assert!(
            !fixture.host.draining.is_cancelled(),
            "published acceptance retains ordinary idle lifetime"
        );
        fixture.finish().await;
    }

    #[tokio::test]
    async fn startup_abandonment_does_not_retire_a_service_host() {
        let fixture = Fixture::new(LifecycleMode::Service).await;
        fixture.host.abandon_unaccepted_startup();
        assert!(!fixture.host.draining.is_cancelled());
        fixture.finish().await;
    }
}
