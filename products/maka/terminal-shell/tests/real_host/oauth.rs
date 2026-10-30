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
use maka_host_runtime::application::{Context, Handler};
use maka_plugin_core::operation::{OperationCleanup, RecoveryRef};
use nsh_platform_tui::{HostServices, ServiceCancellation};
use std::{future::Future, pin::Pin, sync::Mutex};

const URL: &str = "https://auth.openai.com/codex/device";
const CODE: &str = "TEST-CODE-1234";

// This one composition slot controls only public prompts and cancellation.
// Actual provider authentication, credential saving and business CAS remain
// covered by settings/native/src/credential/tests.rs, without a real account.
#[derive(Default)]
struct Authentication {
    calls: Mutex<Vec<(Value, RecoveryRef)>>,
}

impl Handler for Authentication {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'static>> {
        let result = match method.as_str() {
            "provider" => {
                let identity = serde_json::from_value(input)
                    .map_err(|_| "invalid provider identity".to_owned());
                identity.and_then(|identity| {
                    let descriptor = maka_providers::definition(
                        &identity,
                        std::sync::Arc::new(maka_providers::catalog::Snapshot::bundled()?),
                    )?
                    .descriptor()
                    .clone();
                    serde_json::to_value(maka_settings_native::contract::Provider {
                        identity,
                        descriptor,
                    })
                    .map_err(|_| "provider descriptor is not serializable".into())
                })
            }
            "loginCredential" => {
                if context.attachments().is_empty()
                    && serde_json::from_value::<maka_settings_native::contract::LoginCredential>(
                        input.clone(),
                    )
                    .is_ok()
                    && let Some(reference) = context.operation()
                {
                    self.calls.lock().unwrap().push((input, reference.clone()));
                    return Box::pin(async move {
                        context.emit(json!({"url":URL,"userCode":CODE})).await?;
                        context.scope().cancellation.cancelled().await;
                        Ok(
                            json!({"kind":"failed","reason":"cancelled","message":"Sign-in cancelled."}),
                        )
                    });
                }
                Err("login requires the original operation and no secret resource".into())
            }
            _ => Err("unexpected authentication method".into()),
        };
        Box::pin(async move { result })
    }
}

#[derive(Default)]
struct Clipboard(Mutex<Vec<String>>);
impl HostServices for Clipboard {
    fn write_clipboard(&self, text: &str, _: &ServiceCancellation) -> Result<(), String> {
        self.0.lock().unwrap().push(text.into());
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provider_prompt_copy_and_cancel_settle_the_original_without_replacing_the_composer() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let authentication = std::sync::Arc::new(Authentication::default());
        let mut fixture = Fixture::configured(support::Options { login_handler: Some(authentication.clone()), ..Default::default() }).await;
        let client = fixture.client().await;
        let identity = json!({"packageId":"maka.codex","entryId":"maka.codex","scope":"profile","name":"chatgpt"});
        let provider = client.query("authentication", "provider", identity.clone()).await.unwrap();
        let descriptor = &provider["descriptor"];
        let method = descriptor["authentication"].as_array().unwrap().iter().find(|method| method["interactive"] == true).unwrap();
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        let clipboard = std::sync::Arc::new(Clipboard::default());
        view.set_host_services(Some(clipboard.clone())).unwrap();
        activate(&mut view, "Choose model and effort").await;
        activate(&mut view, "Use fixture-model · NSH fixture").await;
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model") && model_menu_closed(view)).await;
        tab_to_label(&mut view, "Message composer").await;
        editable(&mut view, "Message composer").await;
        let draft = "OAuth keeps this exact composer draft 你好";
        view.handle_event(Event::Paste(draft.into()));
        support::wait_draft(&client, &fixture.session, draft).await;
        let composer = view.surface().focused().unwrap();
        shortcut(&mut view, 'p');
        select_palette(&mut view, "Search commands…", "Connections & models", "Connections & models").await;
        activate(&mut view, "Add connection").await;
        activate(&mut view, &format!("Connect {}", descriptor["label"].as_str().unwrap())).await;
        fill(&mut view, "Connection name", "OAuth 界面连接").await;
        fill(&mut view, "Connection ID", "ui-chatgpt").await;
        activate(&mut view, "Save connection").await;
        wait_view(&mut view, |screen| screen.contains("Connection saved.")).await;
        let catalog = client.query("settings", "connections", json!({"kind":"start"})).await.unwrap();
        let row = catalog["connections"].as_array().unwrap().iter().find(|row| row["slug"] == "ui-chatgpt").unwrap();
        let detail = client.query("settings", "connection", json!({"connectionId":row["basis"]["connectionId"],"revision":row["basis"]["revision"],"includeEditingFacts":true})).await.unwrap();
        let credential_input = json!({"locator":{"scope":"connection","connectionId":detail["target"]["connectionId"],"kind":"provider"}});
        let credential = client.query("settings", "credentialStatus", credential_input.clone()).await.unwrap();
        assert_eq!(credential["status"]["configured"], false);
        activate(&mut view, method["label"].as_str().unwrap()).await;
        wait_view(&mut view, |screen| screen.contains(URL) && screen.contains(CODE)).await;
        let calls = authentication.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        let (input, reference) = &calls[0];
        assert_eq!(input, &json!({"expected":detail["target"],"expectedCredential":null,"method":method["id"]}));
        let pending = client.pending_settings().await.unwrap();
        assert_eq!(pending.len(), 1);
        let original = client.operation_for_settings(pending[0].id).await.unwrap();
        assert_eq!(original.endpoint, "authentication");
        assert_eq!(original.method, "loginCredential");
        assert_eq!(original.reference.as_ref(), Some(reference));
        let nodes = view.accessibility_snapshot();
        for label in ["Settings section General", "Settings section Connections & models", "Settings section Network", "Back from connection settings", "Close settings"] {
            let mut buttons = nodes.iter().filter(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == label);
            let button = buttons.next().unwrap_or_else(|| panic!("the live sign-in lost native button {label:?}"));
            assert!(buttons.next().is_none(), "ambiguous live sign-in button {label:?}");
            assert!(button.state.disabled, "sign-in must keep {label:?} disabled until its original settles");
        }
        for (label, text) in [("Copy sign-in URL", URL), ("Copy sign-in code", CODE)] {
            activate(&mut view, label).await;
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    view.poll().unwrap();
                    support::tick(&mut view);
                    if clipboard.0.lock().unwrap().last().is_some_and(|value| value == text) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }).await.expect("the real native clipboard callback did not receive the public prompt value");
        }
        assert_eq!(clipboard.0.lock().unwrap().as_slice(), &[URL.to_owned(), CODE.to_owned()]);
        activate(&mut view, "Cancel provider sign-in").await;
        wait_view(&mut view, |screen| screen.contains("Sign-in cancelled.")).await;
        let cancelled = json!({"kind":"failed","reason":"cancelled","message":"Sign-in cancelled."});
        let settled = client.operation_for_settings(original.id).await.unwrap();
        assert_eq!(settled.reference, original.reference);
        assert!(matches!(settled.receipt, Some(Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, cleanup: OperationCleanup::Confirmed }) if value == &cancelled));
        assert!(client.pending_settings().await.unwrap().is_empty());
        let recovered = client.recover(original.id).await.unwrap();
        assert_eq!(&recovered.reference, reference);
        assert!(matches!(recovered.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, cleanup: OperationCleanup::Confirmed } if value == &cancelled));
        assert_eq!(authentication.calls.lock().unwrap().len(), 1);
        assert_eq!(client.query("settings", "connections", json!({"kind":"start"})).await.unwrap(), catalog);
        assert_eq!(client.query("settings", "credentialStatus", credential_input).await.unwrap(), credential);
        activate(&mut view, "Back from connection settings").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Refresh connections") && !screen.contains("Connection name") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Close settings" && !node.state.disabled) && !view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Back from connection settings")).await;
        activate(&mut view, "Close settings").await;
        editable(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(draft));
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.discovery_count.load(Ordering::SeqCst), 0);
        support::wait_enabled_button(&mut view, "Send message").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        let mut request = fixture.next_request().await;
        assert_eq!(request.body["model"], "fixture-model");
        assert!(request.body["messages"].as_array().unwrap().iter().any(|message| message["role"] == "user" && message["content"].to_string().contains(draft)));
        request.delta("OAUTH_CANCEL_SINGLE_SEND_DONE").await;
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        wait_view(&mut view, |screen| screen.contains("OAUTH_CANCEL_SINGLE_SEND_DONE")).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.discovery_count.load(Ordering::SeqCst), 0);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("the public OAuth prompt and cancellation flow timed out");
}
