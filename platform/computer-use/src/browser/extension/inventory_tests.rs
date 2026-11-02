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
        Self::open_adapter("org.apache.maka.inventory_fixture", lifecycle).await
    }

    async fn open_adapter(adapter: &str, lifecycle: &str) -> Self {
        Self::open_preparation(adapter, lifecycle, "unknown").await
    }

    async fn open_preparation(adapter: &str, lifecycle: &str, preparation: &str) -> Self {
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
        let identity = json!({
            "adapter":adapter,
            "extensionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "instanceId":"main-inventory-fixture",
            "generation":generation,
            "hostPid":std::process::id(),
            "capabilities":{
                "attachmentPreparation":"metadata_only",
                "sessionPreparation":preparation,
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

    async fn connect_again(&self) -> (ExtensionBrowserProvider, UnixStream) {
        let private = std::fs::canonicalize(self._directory.path()).unwrap();
        let generation = &self.extension.identity().generation;
        let descriptor = private.join(format!("{generation}.json"));
        let value: Value = serde_json::from_slice(&std::fs::read(&descriptor).unwrap()).unwrap();
        let socket = private.join(format!("{generation}.sock"));
        std::fs::remove_file(&socket).unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, Permissions::from_mode(0o600)).unwrap();
        let endpoint =
            ValidatedExtensionEndpoint::load(&descriptor, &self.extension.identity().adapter)
                .unwrap();
        let accept = async {
            let (mut server, _) = listener.accept().await.unwrap();
            let hello = read_frame(&mut server).await;
            assert_eq!(hello["kind"], "hello");
            write_frame(&mut server, json!({
                "kind":"welcome","protocol":1,"generation":generation,"identity":value["identity"]
            })).await;
            server
        };
        let (provider, server) =
            bounded(async { tokio::join!(ExtensionBrowserProvider::connect(endpoint), accept) })
                .await;
        (provider.unwrap(), server)
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
    let drain =
        host.lock()
            .await
            .seal_extension_controls(owner, Some("inventory-turn"), None, None);
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
    let drain =
        host.lock()
            .await
            .seal_extension_controls(owner, Some("inventory-turn"), None, None);
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
        // Logical metadata candidates survive without a physical acquisition;
        // the retained insertion order does not mint an operation or epoch.
        ledger
            .tabs
            .get_mut(&identity)
            .unwrap()
            .extension
            .as_mut()
            .unwrap()
            .creation_operation = None;
        assert!(ledger.acquisition(owner, &identity).is_none());
        assert_eq!(
            ledger.metadata_candidates(owner, &browser, &[]).unwrap(),
            vec![8123]
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

#[tokio::test]
async fn parked_page_rebinds_through_a_fresh_connection_without_changing_its_origin() {
    let mut fixture = Fixture::open().await;
    let previous = fixture.provider();
    let current = fixture.provider();
    assert!(
        previous != current,
        "separate connection wrappers must differ"
    );
    assert_eq!(browser(&previous), browser(&current));
    let owner = uuid::Uuid::new_v4();
    let identity = browser(&current).tab("17");
    let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
    register(&host, owner, &current).await.unwrap();
    {
        let mut ledger = host.lock().await;
        ledger
            .extension_reserve(
                owner,
                &previous,
                "previous-turn",
                "17",
                Origin::AgentCreated,
            )
            .unwrap();
        let lease = ledger.tabs.get_mut(&identity).unwrap();
        lease.disposition = Disposition::Parked;
        lease.retention = Retention::Handoff;
        lease.extension = Some(ClaimState {
            revoked: true,
            released: true,
            ..Default::default()
        });
        let operation = context_operation("resume-turn");
        let epoch = crate::desktop::NativeEpochId::new();
        let call = ledger
            .extension_context(
                owner,
                &current,
                operation.clone(),
                epoch,
                CallTarget::Tab {
                    origin: Origin::UserClaimed,
                    tab: Some("17".into()),
                },
                true,
            )
            .unwrap();
        assert!(
            ledger
                .begin_handoff_transfer(owner, &current, &operation, epoch, "17")
                .unwrap()
        );
        assert!(
            ledger.tabs[&identity].creator.provider == previous,
            "reservation alone must not transfer custody"
        );
        let request = crate::BrowserSessionPreparation {
            native_owner: owner,
            native_epoch: epoch.to_string(),
            browser_id: current.id().into(),
            generation: current.extension().unwrap().identity().generation.clone(),
            turn_id: operation.turn_id.clone(),
            operation_id: operation.operation_id.clone(),
            target: crate::BrowserPreparationTarget::ReservedTab {
                tab_id: "17".into(),
            },
        };
        ledger
            .extension_preparation_current(&call, &request)
            .unwrap();
        // Exercise Main's literal provider result boundary, without claiming
        // that this peer performed Chrome effects or granted page authority.
        ledger
            .apply_user_preparation(
                owner,
                &current,
                &identity.browser,
                Some("17".into()),
                PreparedOperation::Acquired { operation, epoch },
                serde_json::from_value(json!({"id":17})).unwrap(),
            )
            .unwrap();
        let lease = &ledger.tabs[&identity];
        assert!(lease.creator.provider == current);
        assert!(matches!(lease.origin, Origin::AgentCreated));
        assert!(matches!(lease.retention, Retention::Unmarked));
        assert!(matches!(lease.disposition, Disposition::Live));
        assert!(lease.handoff_transfer.is_none());
        ledger.extension.clear();
    }
    fixture.assert_no_frame_and_close().await;
}

#[tokio::test]
async fn retained_chatgpt_page_keeps_origin_when_a_new_native_generation_claims_it() {
    for same_page in [true, false] {
        let mut previous = Fixture::open_adapter("com.openai.codexextension", "provider").await;
        let mut current = Fixture::open_adapter("com.openai.codexextension", "provider").await;
        let old_provider = previous.provider();
        let provider = current.provider();
        let owner = uuid::Uuid::new_v4();
        let old_identity = browser(&old_provider).tab("17");
        let identity = browser(&provider).tab("17");
        assert_ne!(old_identity.browser, identity.browser);
        let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
        register(&host, owner, &old_provider).await.unwrap();
        let call = host
            .lock()
            .await
            .extension_context(
                owner,
                &old_provider,
                context_operation("create-turn"),
                crate::desktop::NativeEpochId::new(),
                CallTarget::Tab {
                    origin: Origin::AgentCreated,
                    tab: None,
                },
                true,
            )
            .unwrap();
        let source = async {
            let frame = read_frame(&mut previous.server).await;
            assert_eq!(frame["request"]["method"], "createTab");
            result(&mut previous.server, frame["request"]["id"].as_u64().unwrap(),
            json!({"creation":"actual-peer-creation","tab":{"id":17,"providerTabId":"[\"chrome-session\",\"17\"]"}})).await;
        };
        let (created, ()) =
            bounded(async { tokio::join!(call.dispatch(call.control.create_tab(None)), source) })
                .await;
        assert_eq!(created.unwrap().tab.id, 17);
        {
            let mut ledger = host.lock().await;
            ledger
                .reconcile_provider(owner, &old_provider)
                .await
                .unwrap();
            let lease = ledger.tabs.get_mut(&old_identity).unwrap();
            assert_eq!(
                lease.provider_tab_id.as_deref(),
                Some("[\"chrome-session\",\"17\"]"),
                "actual Created ACK must capture the source page identity"
            );
            lease.disposition = Disposition::Parked;
            lease.retention = Retention::Handoff;
            lease.extension = Some(ClaimState {
                revoked: true,
                released: true,
                ..Default::default()
            });
            ledger.extension.clear();
        }
        register(&host, owner, &provider).await.unwrap();
        {
            let mut ledger = host.lock().await;
            ledger
                .extension_reserve(owner, &provider, "resume-turn", "17", Origin::UserClaimed)
                .unwrap();
            let operation = context_operation("resume-turn");
            let epoch = crate::desktop::NativeEpochId::new();
            ledger
                .extension_context(
                    owner,
                    &provider,
                    operation.clone(),
                    epoch,
                    CallTarget::Tab {
                        origin: Origin::UserClaimed,
                        tab: Some("17".into()),
                    },
                    true,
                )
                .unwrap();
            ledger
            .apply_user_preparation(
                owner,
                &provider,
                &identity.browser,
                Some("17".into()),
                PreparedOperation::Acquired { operation, epoch },
                serde_json::from_value(
                    json!({"id":17,"providerTabId": if same_page { "[\"chrome-session\",\"17\"]" } else { "[\"different-browser-session\",\"17\"]" }}),
                )
                .unwrap(),
            )
            .unwrap();
            if same_page {
                assert!(
                    matches!(ledger.tabs[&identity].origin, Origin::AgentCreated),
                    "actual stable page identity preserves the original creator"
                );
                assert!(!ledger.tabs.contains_key(&old_identity));
                assert_eq!(ledger.tabs.len(), 1);
            } else {
                assert!(
                    matches!(ledger.tabs[&identity].origin, Origin::UserClaimed),
                    "reused raw tab ID from another browser session must not inherit origin"
                );
                assert!(ledger.tabs.contains_key(&old_identity));
                assert_eq!(ledger.tabs.len(), 2);
            }
            assert!(matches!(
                ledger.tabs[&identity].retention,
                Retention::Unmarked
            ));
            ledger.extension.clear();
        }
        previous.assert_no_frame_and_close().await;
        current.assert_no_frame_and_close().await;
    }
}

#[tokio::test]
async fn revoked_tab_retires_its_old_claim_and_can_be_explicitly_claimed_again() {
    let mut fixture = Fixture::open().await;
    let provider = fixture.provider();
    let owner = uuid::Uuid::new_v4();
    let identity = browser(&provider).tab("17");
    let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
    register(&host, owner, &provider).await.unwrap();
    let epoch = crate::desktop::NativeEpochId::new();
    let operation = context_operation("recover-turn");
    let call = {
        let mut ledger = host.lock().await;
        ledger
            .extension_reserve(owner, &provider, "recover-turn", "17", Origin::AgentCreated)
            .unwrap();
        ledger
            .extension_context(
                owner,
                &provider,
                operation.clone(),
                epoch,
                CallTarget::Tab {
                    origin: Origin::UserClaimed,
                    tab: Some("17".into()),
                },
                true,
            )
            .unwrap()
    };
    let attach = async {
        let frame = read_frame(&mut fixture.server).await;
        assert_eq!(frame["request"]["method"], "attach");
        result(
            &mut fixture.server,
            frame["request"]["id"].as_u64().unwrap(),
            json!({"claim":"original-claim","tabId":17,"targetId":"target-17"}),
        )
        .await;
    };
    let (attached, ()) =
        bounded(async { tokio::join!(call.dispatch(call.control.attach_tab(17)), attach) }).await;
    attached.unwrap();
    host.lock()
        .await
        .reconcile_provider(owner, &provider)
        .await
        .unwrap();
    write_frame(&mut fixture.server, json!({"kind":"controlEvent","event":{"kind":"claimUnavailable","data":{"claim":"original-claim","reason":"fixture route revoked"}}})).await;
    bounded(async {
        loop {
            if host.lock().await.tabs[&identity]
                .extension
                .as_ref()
                .unwrap()
                .revoked
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    {
        let mut ledger = host.lock().await;
        assert!(
            matches!(ledger.extension_reserve(owner, &provider, "recover-turn", "17", Origin::UserClaimed),
            Err(ToolError::Failed(message)) if message.contains("explicitly claim"))
        );
        let state = ledger.tabs[&identity].extension.as_ref().unwrap();
        assert!(
            state.unknown.is_none(),
            "route loss must not invent an unknown Chrome effect"
        );
        assert_eq!(
            state.cleanup_revocation.as_deref(),
            Some("fixture route revoked")
        );
    }
    let retirement = host
        .lock()
        .await
        .extension_context(
            owner,
            &provider,
            context_operation("recover-turn"),
            epoch,
            CallTarget::Retirement,
            false,
        )
        .unwrap();
    let retire = async {
        drain_extension_cleanup(&host, owner, None, None, Some(&identity)).await?;
        host.lock()
            .await
            .park_extension_tab(owner, &provider, &identity, &retirement)
            .await
    };
    let peer = async {
        let fence = read_frame(&mut fixture.server).await;
        assert_eq!(fence["request"]["method"], "fenceCdp");
        host.lock()
            .await
            .extension_reserve(owner, &provider, "recover-turn", "18", Origin::UserClaimed)
            .expect("another page remains usable while the original drain waits");
        result(&mut fixture.server, fence["request"]["id"].as_u64().unwrap(),
            json!({"claim":"original-claim","generation":fixture.extension.identity().generation,"fenced":true,"pending":[]})).await;
        let detach = read_frame(&mut fixture.server).await;
        assert_eq!(detach["request"]["method"], "detach");
        assert_eq!(detach["request"]["claim"], "original-claim");
        result(
            &mut fixture.server,
            detach["request"]["id"].as_u64().unwrap(),
            json!({"detached":true,"proof":"detach_ack"}),
        )
        .await;
        let retired = read_frame(&mut fixture.server).await;
        assert_eq!(retired["request"]["method"], "retireClaim");
        result(
            &mut fixture.server,
            retired["request"]["id"].as_u64().unwrap(),
            json!({"retired":true,"claim":"original-claim"}),
        )
        .await;
        Ok::<(), ToolError>(())
    };
    bounded(async { tokio::try_join!(retire, peer) })
        .await
        .unwrap();
    let operation = context_operation("recover-turn");
    let replacement = {
        let mut ledger = host.lock().await;
        assert!(!ledger.extension[&(owner, identity.browser.clone())].owner_parked);
        assert!(
            ledger
                .begin_handoff_transfer(owner, &provider, &operation, epoch, "17")
                .unwrap()
        );
        ledger
            .extension_context(
                owner,
                &provider,
                operation.clone(),
                epoch,
                CallTarget::Tab {
                    origin: Origin::UserClaimed,
                    tab: Some("17".into()),
                },
                true,
            )
            .unwrap()
    };
    let attach = async {
        let frame = read_frame(&mut fixture.server).await;
        assert_eq!(frame["request"]["method"], "attach");
        result(
            &mut fixture.server,
            frame["request"]["id"].as_u64().unwrap(),
            json!({"claim":"replacement-claim","tabId":17,"targetId":"target-17"}),
        )
        .await;
    };
    let (attached, ()) = bounded(async {
        tokio::join!(
            replacement.dispatch(replacement.control.attach_tab(17)),
            attach
        )
    })
    .await;
    attached.unwrap();
    {
        let mut ledger = host.lock().await;
        ledger.reconcile_provider(owner, &provider).await.unwrap();
        ledger
            .apply_user_preparation(
                owner,
                &provider,
                &identity.browser,
                Some("17".into()),
                PreparedOperation::Acquired { operation, epoch },
                serde_json::from_value(json!({"id":17})).unwrap(),
            )
            .unwrap();
        assert!(matches!(
            ledger.tabs[&identity].disposition,
            Disposition::Live
        ));
        assert!(matches!(
            ledger.tabs[&identity].origin,
            Origin::AgentCreated
        ));
        assert_eq!(
            ledger.tabs[&identity]
                .extension
                .as_ref()
                .unwrap()
                .claim
                .as_ref()
                .unwrap()
                .claim_id(),
            "replacement-claim"
        );
        assert!(matches!(
            ledger.tabs[&identity.browser.tab("18")].disposition,
            Disposition::Live
        ));
        ledger.reconcile_provider(owner, &provider).await.unwrap();
        ledger.extension.clear();
    }
    fixture.assert_no_frame_and_close().await;
}

#[tokio::test]
async fn reconnect_to_the_same_native_host_recovers_inventory_and_claim_without_losing_old_custody()
{
    let mut fixture =
        Fixture::open_preparation("com.openai.codexextension", "provider", "provider_session")
            .await;
    let previous = fixture.provider();
    let owner = uuid::Uuid::new_v4();
    let old_identity = browser(&previous).tab("17");
    let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
    register(&host, owner, &previous).await.unwrap();
    let old_call = {
        let mut ledger = host.lock().await;
        ledger
            .extension_reserve(
                owner,
                &previous,
                "inventory-turn",
                "17",
                Origin::UserClaimed,
            )
            .unwrap();
        let call = scope(&mut ledger, owner, &previous);
        ledger
            .tabs
            .get_mut(&old_identity)
            .unwrap()
            .extension
            .as_mut()
            .unwrap()
            .user_preparation = UserPreparation::Pending(call.context.clone());
        call
    };
    let disconnect = async {
        let frame = read_frame(&mut fixture.server).await;
        assert_eq!(frame["request"]["method"], "prepareUserTab");
        assert_eq!(frame["request"]["takeover"], true);
        fixture.server.shutdown().await.unwrap();
    };
    let (failed, ()) = bounded(async {
        tokio::join!(
            async {
                let result = old_call.dispatch(old_call.control.take_over_session_tab(17)).await;
                assert!(matches!(&result, Err(error) if matches!(**error, ExtensionProviderError::OutcomeUnknown { .. })), "expected a dispatched transport failure: {result:?}");
                result
            },
            disconnect
        )
    })
    .await;
    let error = failed.unwrap_err();
    assert!(matches!(
        *error,
        ExtensionProviderError::OutcomeUnknown { .. }
    ));
    host.lock()
        .await
        .extension_preparation_failed(&old_identity, &old_call.context, false, &error);
    assert!(fixture.extension.is_closed());
    let (extension, mut server) = fixture.connect_again().await;
    let current = Provider::Extension {
        id: previous.id().into(),
        connection: Arc::new(extension.clone()),
    };
    let identity = browser(&current).tab("17");
    assert_ne!(identity, old_identity);
    assert_eq!(extension.identity(), fixture.extension.identity());
    register(&host, owner, &current).await.unwrap();
    let call = scope(&mut *host.lock().await, owner, &current);
    let respond = async {
        let frame = read_frame(&mut server).await;
        assert_eq!(frame["request"]["method"], "inventory");
        result(
            &mut server,
            frame["request"]["id"].as_u64().unwrap(),
            json!({"tabs":[{"id":17,"title":"Inbox"}],"sessionOnly":true}),
        )
        .await;
    };
    let (inventory, ()) = bounded(async {
        tokio::join!(
            call.dispatch(call.control.list_session_tabs(&[17])),
            respond
        )
    })
    .await;
    assert_eq!(inventory.unwrap()[0].id, 17);
    {
        let mut ledger = host.lock().await;
        ledger.reconcile_provider(owner, &current).await.unwrap();
        assert!(ledger.visible(&identity, owner));
        ledger
            .extension_reserve(owner, &current, "inventory-turn", "17", Origin::UserClaimed)
            .unwrap();
        assert!(matches!(
            ledger.tabs[&old_identity]
                .extension
                .as_ref()
                .unwrap()
                .user_preparation,
            UserPreparation::Unknown(_)
        ));
        assert!(matches!(
            ledger.tabs[&identity]
                .extension
                .as_ref()
                .unwrap()
                .user_preparation,
            UserPreparation::NotAttempted
        ));
        ledger.extension_preparation_failed(&old_identity, &old_call.context, false, &error);
        assert!(
            matches!(
                ledger.tabs[&identity]
                    .extension
                    .as_ref()
                    .unwrap()
                    .user_preparation,
                UserPreparation::NotAttempted
            ),
            "late old failure must not poison the new claim"
        );
    }
    let claim = {
        let mut ledger = host.lock().await;
        ledger
            .extension_context(
                owner,
                &current,
                context_operation("inventory-turn"),
                crate::desktop::NativeEpochId::new(),
                CallTarget::Tab {
                    origin: Origin::UserClaimed,
                    tab: Some("17".into()),
                },
                true,
            )
            .unwrap()
    };
    let respond = async {
        let frame = read_frame(&mut server).await;
        assert_eq!(frame["request"]["method"], "prepareUserTab");
        assert_eq!(frame["request"]["takeover"], true);
        result(
            &mut server,
            frame["request"]["id"].as_u64().unwrap(),
            json!({"sessionOnly":true,"tab":{"id":17,"title":"Inbox"}}),
        )
        .await;
    };
    let (prepared, ()) = bounded(async {
        tokio::join!(
            claim.dispatch(claim.control.take_over_session_tab(17)),
            respond
        )
    })
    .await;
    assert_eq!(prepared.unwrap().tab.id, 17);
    let mut ledger = host.lock().await;
    ledger.reconcile_provider(owner, &current).await.unwrap();
    assert!(ledger.acquisition(owner, &identity).is_some());
    assert!(matches!(
        ledger.tabs[&old_identity]
            .extension
            .as_ref()
            .unwrap()
            .user_preparation,
        UserPreparation::Unknown(_)
    ));
    ledger.extension.clear();
    drop(ledger);
    extension.close().await;
}

#[tokio::test]
async fn separate_live_connections_cannot_bypass_physical_tab_ownership() {
    let mut fixture = Fixture::open().await;
    let previous = fixture.provider();
    let (extension, _server) = fixture.connect_again().await;
    let current = Provider::Extension {
        id: previous.id().into(),
        connection: Arc::new(extension.clone()),
    };
    let owner = uuid::Uuid::new_v4();
    let foreign = uuid::Uuid::new_v4();
    let identity = browser(&current).tab("17");
    let mut ledger = Host::default();
    ledger
        .extension_reserve(owner, &previous, "old", "17", Origin::UserClaimed)
        .unwrap();
    assert!(!ledger.visible(&identity, foreign));
    assert!(
        matches!(ledger.extension_reserve(foreign, &current, "new", "17", Origin::UserClaimed), Err(ToolError::Failed(reason)) if reason == "tab_owned_by_another_session")
    );
    extension.close().await;
    fixture.assert_no_frame_and_close().await;
}
