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

//! Actual public Unix provider transport against a task-owned IPC peer.
//! The peer supplies protocol results, not Chrome effects, Host grants, extension
//! ownership, document authority or T2 settlement. These tests exercise Main's
//! real reconciliation and the exact original CallScope across that boundary.

use super::*;
use cua_driver_core::browser::{ExtensionProviderError, ValidatedExtensionEndpoint};
use std::{fs::Permissions, future::Future, os::unix::fs::PermissionsExt};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
};

async fn bounded<F: Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("private extension fixture boundary must finish")
}

async fn read_frame(server: &mut UnixStream) -> Value {
    let mut header = [0_u8; 4];
    server.read_exact(&mut header).await.unwrap();
    let length = u32::from_ne_bytes(header) as usize;
    assert!((1..=65_536).contains(&length), "fixture frame byte budget");
    let mut payload = vec![0; length];
    server.read_exact(&mut payload).await.unwrap();
    serde_json::from_slice(&payload).unwrap()
}

async fn write_frame(server: &mut UnixStream, frame: Value) {
    let payload = serde_json::to_vec(&frame).unwrap();
    let length = u32::try_from(payload.len()).unwrap();
    server.write_all(&length.to_ne_bytes()).await.unwrap();
    server.write_all(&payload).await.unwrap();
    server.flush().await.unwrap();
}

async fn result(server: &mut UnixStream, id: u64, value: Value) {
    write_frame(
        server,
        json!({
            "kind":"controlEvent",
            "event":{"kind":"reply","data":{
                "id":id,"outcome":{"kind":"result","data":value}
            }}
        }),
    )
    .await;
}

struct Fixture {
    extension: ExtensionBrowserProvider,
    server: UnixStream,
    // Retain the actual private descriptor/socket directory through the call.
    _directory: tempfile::TempDir,
}

impl Fixture {
    async fn open() -> Self {
        Self::open_with_lifecycle("provider").await
    }

    async fn open_with_lifecycle(lifecycle: &str) -> Self {
        // Canonical /tmp remains short on supported Unix hosts and avoids a
        // symlink component (notably /tmp -> /private/tmp on macOS).
        let directory = tempfile::Builder::new()
            .prefix("mcu-")
            .tempdir_in("/tmp")
            .unwrap();
        let private = std::fs::canonicalize(directory.path()).unwrap();
        std::fs::set_permissions(&private, Permissions::from_mode(0o700)).unwrap();
        let generation = uuid::Uuid::new_v4().to_string();
        let socket = private.join(format!("{generation}.sock"));
        let listener = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, Permissions::from_mode(0o600)).unwrap();
        let adapter = "org.apache.maka.inventory_fixture";
        let identity = json!({
            "adapter":adapter,
            "extensionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "instanceId":"main-inventory-fixture",
            "generation":generation,
            "hostPid":std::process::id(),
            "capabilities":{
                "attachmentPreparation":"metadata_only",
                "userTabsOrder":"provider",
                "headerScope":"session",
                "createdPresentationOwner":"provider",
                "cursorPresentationOwner":"provider",
                "cursorHideOwner":"unavailable",
                "turnLifecycleOwner":lifecycle,
                "sessionTabInventory":true
            }
        });
        let capability = "0".repeat(64);
        let descriptor = private.join(format!("{generation}.json"));
        std::fs::write(
            &descriptor,
            serde_json::to_vec(&json!({
                "protocol":1,"identity":identity,
                "endpoint":{"kind":"unix","address":socket},
                "capability":capability
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::set_permissions(&descriptor, Permissions::from_mode(0o600)).unwrap();
        let endpoint = ValidatedExtensionEndpoint::load(&descriptor, adapter).unwrap();
        let accept = async {
            let (mut server, _) = listener.accept().await.unwrap();
            let hello = read_frame(&mut server).await;
            assert_eq!(
                hello,
                json!({
                    "kind":"hello","protocol":1,
                    "generation":generation,"capability":capability
                })
            );
            write_frame(
                &mut server,
                json!({
                    "kind":"welcome","protocol":1,
                    "generation":generation,"identity":identity
                }),
            )
            .await;
            server
        };
        let (extension, server) =
            bounded(async { tokio::join!(ExtensionBrowserProvider::connect(endpoint), accept) })
                .await;
        Self {
            extension: extension.unwrap(),
            server,
            _directory: directory,
        }
    }

    fn provider(&self) -> Provider {
        Provider::Extension {
            id: "extension-inventory-fixture".into(),
            connection: Arc::new(self.extension.clone()),
        }
    }

    async fn assert_no_frame_and_close(&mut self) {
        // Reach the actual actor FIFO barrier, then close only this fixture's
        // public transport. EOF after draining the server proves that no extra
        // bytes were queued; a timed WouldBlock observation would not do so.
        assert!(
            bounded(self.extension.pending_operations())
                .await
                .unwrap()
                .is_empty()
        );
        bounded(self.extension.close()).await;
        let mut byte = [0_u8];
        assert_eq!(
            bounded(self.server.read(&mut byte)).await.unwrap(),
            0,
            "the fixture transport must close without another IPC frame"
        );
        // Transport EOF is deliberately not used as extension cleanup proof.
    }
}

fn browser(provider: &Provider) -> BrowserIdentity {
    BrowserIdentity::of(
        provider,
        &provider.extension().unwrap().identity().generation,
    )
    .unwrap()
}

fn scope(host: &mut Host, owner: uuid::Uuid, provider: &Provider) -> CallScope {
    host.extension_context(
        owner,
        provider,
        context_operation("inventory-turn"),
        crate::desktop::NativeEpochId::new(),
        CallTarget::SessionInventory,
        true,
    )
    .unwrap()
}

#[tokio::test]
async fn same_unpolled_scope_survives_real_reconcile_then_seal_rejects_without_inventory() {
    let mut fixture = Fixture::open().await;
    let provider = fixture.provider();
    let owner = uuid::Uuid::new_v4();
    let browser = browser(&provider);
    let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
    bounded(register(&host, owner, &provider)).await.unwrap();
    let call = {
        let mut ledger = host.lock().await;
        scope(&mut ledger, owner, &provider)
    };
    // Keep the SAME actual future/scope alive; do not poll it before reconcile.
    let unpolled = call.dispatch(call.control.list_session_tabs(&[]));
    {
        let mut ledger = host.lock().await;
        assert!(
            !bounded(ledger.reconcile_provider(owner, &provider))
                .await
                .unwrap()
        );
        let retained =
            &ledger.extension[&(owner, browser.clone())].calls[&call.context.operation_id];
        assert!(Arc::ptr_eq(&retained.issuing, &call.issuing));
        assert!(Arc::ptr_eq(&retained.controls, &call.controls));
        assert!(!retained.activation.load(Ordering::SeqCst));
        assert!(
            ledger.extension[&(owner, browser.clone())]
                .finish_phases
                .is_empty()
        );
    }
    let drain = host
        .lock()
        .await
        .seal_extension_controls(owner, Some("inventory-turn"), None);
    bounded(drain.wait()).await.unwrap();
    assert!(matches!(bounded(unpolled).await.map_err(|error| *error),
        Err(ExtensionProviderError::Refused { kind, .. }) if kind == "retiring_scope"));
    fixture.assert_no_frame_and_close().await;
    let ledger = host.lock().await;
    assert!(ledger.extension[&(owner, browser)].finish_phases.is_empty());
    assert!(
        ledger.tabs.is_empty(),
        "metadata intent is not an acquisition"
    );
}

#[tokio::test]
async fn empty_inventory_ack_creates_finish_obligation_until_actual_finish_ack() {
    let mut fixture = Fixture::open().await;
    let provider = fixture.provider();
    let owner = uuid::Uuid::new_v4();
    let browser = browser(&provider);
    let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
    bounded(register(&host, owner, &provider)).await.unwrap();
    let call = {
        let mut ledger = host.lock().await;
        scope(&mut ledger, owner, &provider)
    };
    let reply = async {
        let frame = read_frame(&mut fixture.server).await;
        assert_eq!(frame["kind"], "control");
        assert_eq!(frame["request"]["method"], "inventory");
        assert_eq!(frame["request"]["sessionOnly"], true);
        assert_eq!(frame["request"]["knownTabIds"], json!([]));
        assert_eq!(
            frame["wireContext"],
            json!({
                "hostSessionId":owner.to_string(),"hostTurnId":"inventory-turn"
            })
        );
        result(
            &mut fixture.server,
            frame["request"]["id"].as_u64().unwrap(),
            json!({"tabs":[],"sessionOnly":true}),
        )
        .await;
    };
    let (rows, ()) =
        bounded(async { tokio::join!(call.dispatch(call.control.list_session_tabs(&[])), reply) })
            .await;
    assert!(rows.unwrap().is_empty());
    {
        let mut ledger = host.lock().await;
        assert!(
            !bounded(ledger.reconcile_provider(owner, &provider))
                .await
                .unwrap()
        );
        assert!(matches!(
            ledger.extension[&(owner, browser.clone())]
                .finish_phases
                .get("inventory-turn"),
            Some(FinishPhase::Required)
        ));
        assert!(
            ledger.tabs.is_empty(),
            "inventory ACK must not become Acquired"
        );
    }
    let drain = host
        .lock()
        .await
        .seal_extension_controls(owner, Some("inventory-turn"), None);
    bounded(drain.wait()).await.unwrap();
    let finish = async {
        host.lock()
            .await
            .finish(owner, Some("inventory-turn"))
            .await
    };
    let reply = async {
        let frame = read_frame(&mut fixture.server).await;
        assert_eq!(frame["kind"], "control");
        assert_eq!(frame["request"]["method"], "finishTurn");
        assert_eq!(
            frame["wireContext"],
            json!({
                "hostSessionId":owner.to_string(),"hostTurnId":"inventory-turn"
            })
        );
        result(
            &mut fixture.server,
            frame["request"]["id"].as_u64().unwrap(),
            json!({}),
        )
        .await;
    };
    let (finished, ()) = bounded(async { tokio::join!(finish, reply) }).await;
    assert!(finished.unwrap().is_empty());
    {
        let ledger = host.lock().await;
        let state = &ledger.extension[&(owner, browser)];
        assert!(state.current_turn.is_none());
        assert!(state.retiring_turn.is_none());
        assert!(!call.activation.load(Ordering::SeqCst));
        assert!(
            ledger.tabs.is_empty(),
            "logical ACK supplies no physical claim"
        );
    }
    // Exactly one inventory and one Finish were consumed above; no replay or
    // global fallback may have queued another frame after the matched ACK.
    fixture.assert_no_frame_and_close().await;
}

#[tokio::test]
async fn created_ack_keeps_candidate_provenance_after_actual_call_context_gc() {
    // Host-owned lifecycle lets a completed call actually become collectible.
    // The first two keepers retain their provider-owned lifecycle unchanged.
    let mut fixture = Fixture::open_with_lifecycle("host").await;
    let provider = fixture.provider();
    let owner = uuid::Uuid::new_v4();
    let browser = browser(&provider);
    let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
    bounded(register(&host, owner, &provider)).await.unwrap();
    let epoch = crate::desktop::NativeEpochId::new();
    let call = {
        let mut ledger = host.lock().await;
        ledger
            .extension_context(
                owner,
                &provider,
                context_operation("created-turn"),
                epoch,
                CallTarget::Tab {
                    origin: Origin::AgentCreated,
                    tab: None,
                },
                true,
            )
            .unwrap()
    };
    let operation = call.context.clone();
    let reply = async {
        let frame = read_frame(&mut fixture.server).await;
        assert_eq!(frame["kind"], "control");
        assert_eq!(frame["request"]["method"], "createTab");
        assert_eq!(
            frame["wireContext"],
            json!({
                "hostSessionId":owner.to_string(),"hostTurnId":"created-turn"
            })
        );
        result(
            &mut fixture.server,
            frame["request"]["id"].as_u64().unwrap(),
            json!({"creation":"fixture-created-receipt",
                "tab":{"id":8123,"windowId":7,"url":"about:blank","active":false}}),
        )
        .await;
    };
    let (created, ()) =
        bounded(async { tokio::join!(call.dispatch(call.control.create_tab(None)), reply) }).await;
    let created = created.unwrap();
    assert_eq!(created.tab.id, 8123);
    assert_eq!(
        created.creation_receipt().creation_id(),
        "fixture-created-receipt"
    );
    let identity = browser.tab("8123");
    let sequence = {
        let mut ledger = host.lock().await;
        assert!(
            !bounded(ledger.reconcile_provider(owner, &provider))
                .await
                .unwrap()
        );
        let record = ledger
            .acquisition(owner, &identity)
            .expect("actual Created ACK provenance");
        assert_eq!(record.operation, operation);
        assert_eq!(record.epoch, epoch);
        assert!(matches!(
            ledger.tabs[&identity].disposition,
            Disposition::Live
        ));
        record.sequence
    };
    // Retain no wrapper or CallScope history. Only the actual acknowledged
    // creation's coupled record may preserve its original operation and epoch.
    drop(call);
    {
        let mut ledger = host.lock().await;
        assert!(
            !bounded(ledger.reconcile_provider(owner, &provider))
                .await
                .unwrap()
        );
        assert!(
            !ledger.extension[&(owner, browser.clone())]
                .calls
                .contains_key(&operation.operation_id),
            "the second real reconciliation must actually collect CallContext"
        );
        let record = ledger
            .acquisition(owner, &identity)
            .expect("creation survives call GC");
        assert_eq!(record.operation, operation);
        assert_eq!(record.epoch, epoch);
        assert_eq!(record.sequence, sequence);
        assert_eq!(
            ledger.metadata_candidates(owner, &browser, &[]).unwrap(),
            vec![8123]
        );
        assert_eq!(ledger.tabs[&identity].extension_sequence, Some(sequence));
        // Removing required provenance must fail closed, not reconstruct an
        // acquisition from a receipt token, metadata, or a guessed current epoch.
        ledger
            .tabs
            .get_mut(&identity)
            .unwrap()
            .extension
            .as_mut()
            .unwrap()
            .creation_operation = None;
        assert!(ledger.acquisition(owner, &identity).is_none());
        assert!(
            ledger
                .metadata_candidates(owner, &browser, &[])
                .unwrap()
                .is_empty()
        );
        assert_eq!(ledger.tabs[&identity].extension_sequence, Some(sequence));
    }
    fixture.assert_no_frame_and_close().await;
}

#[tokio::test]
async fn closed_transport_registers_before_zero_byte_failure_and_keeps_finish_debt() {
    let mut fixture = Fixture::open().await;
    let provider = fixture.provider();
    let owner = uuid::Uuid::new_v4();
    let browser = browser(&provider);
    let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
    bounded(register(&host, owner, &provider)).await.unwrap();
    let call = scope(&mut *host.lock().await, owner, &provider);
    fixture.assert_no_frame_and_close().await;
    assert!(
        matches!(bounded(call.dispatch(call.control.list_session_tabs(&[]))).await.map_err(|error| *error),
        Err(ExtensionProviderError::OutcomeUnknown {operation, reason, details: None})
            if operation == "inventory" && reason == "owner IPC connection is closed")
    );
    let mut ledger = host.lock().await;
    let state = ledger.extension.get_mut(&(owner, browser)).unwrap();
    state.fold_activation();
    assert_eq!(
        state.calls[&call.context.operation_id]
            .registration
            .as_ref()
            .unwrap()
            .registration
            .count(),
        1
    );
    assert!(
        matches!(
            state.finish_phases.get("inventory-turn"),
            Some(FinishPhase::Required)
        ),
        "zero physical bytes do not undo logical registration before transport failure"
    );
    assert!(ledger.tabs.is_empty());
    // No cleanup ACK exists. Neither EOF nor Required settles this obligation.
}
