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
use maka_plugin_core::{contract::ResourceType, operation::RecoveryRef};
struct Text(String);
impl maka_capabilities::call::ReadResource for Text {
    fn resource_type(&self) -> ResourceType {
        ResourceType {
            name: "maka.text.utf8".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        json!({"private":"private-resource-metadata-marker"})
    }
    fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>, String> {
        Ok(self.0.get(range).ok_or("range")?.as_bytes().to_vec())
    }
}
async fn binding(fixture: &Fixture) -> Binding {
    let client = fixture.app.client();
    client
        .bind(client.activation(&id(2)).unwrap(), "settings".into())
        .await
        .unwrap()
        .remove(0)
}
async fn query(fixture: &Fixture, method: &str, input: Value) -> Value {
    fixture
        .app
        .client()
        .start(
            binding(fixture).await,
            method.into(),
            input,
            scope(&fixture.issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .result()
        .await
        .unwrap()
}
async fn mutate(
    fixture: &Fixture,
    method: &str,
    input: Value,
    secret: Option<&str>,
) -> (Value, RecoveryRef) {
    let reply = mutate_reply(fixture, method, input, secret).await;
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = reply.receipt
    else {
        panic!("unexpected operation receipt")
    };
    (value, reply.reference)
}
async fn mutate_reply(
    fixture: &Fixture,
    method: &str,
    input: Value,
    secret: Option<&str>,
) -> maka_plugin_core::operation::OperationReply {
    let attachments = secret
        .map(|value| {
            BTreeMap::from([(
                "secret".into(),
                Arc::new(Text(value.into())) as Arc<dyn maka_capabilities::call::ReadResource>,
            )])
        })
        .unwrap_or_default();
    let client = fixture.app.client();
    let prepared = client
        .prepare_mutation(
            binding(fixture).await,
            method.into(),
            input,
            scope(&fixture.issuer, true),
            Uuid::new_v4(),
            attachments.into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let recorded = fixture
        .store
        .record_application_intent(
            reference.source.clone(),
            prepared.consumer().instance().clone(),
            reference.clone(),
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    client
        .mutate(prepared, recorded)
        .await
        .unwrap()
        .result()
        .await
}

#[tokio::test]
async fn assistant_preferences_and_capability_guidance_freeze_at_message_acceptance() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, None,
            |settings| settings.assistant = Some(AssistantConfiguration {
                home: Some(settings.workspace_roots[0].path.parent().unwrap().to_str().unwrap().into()),
            }),
        ).await;
        let global = fixture._dir.path().join(".maka");
        std::fs::create_dir(&global).unwrap();
        std::fs::write(global.join("AGENTS.md"), "GLOBAL FIRST").unwrap();
        std::fs::write(fixture.workspace.join("AGENTS.md"), "PROJECT FIRST").unwrap();
        // A guidance filename is not authority to escape the selected directory.
        #[cfg(unix)] {
            let outside = fixture._dir.path().join("outside-guidance");
            std::fs::write(&outside, "OUTSIDE SECRET").unwrap();
            std::os::unix::fs::symlink(&outside, fixture.workspace.join("CLAUDE.md")).unwrap();
            std::os::unix::fs::symlink(&outside, global.join("CLAUDE.md")).unwrap();
        }
        let initial = query(&fixture, "assistantPreferences", json!({})).await;
        let (saved, reference) = mutate(&fixture, "updateAssistantPreferences", json!({
            "expectedRevision":initial["revision"],
            "mutation":{"kind":"personalization","displayName":"M4n5ter"}
        }), None).await;
        assert_eq!(saved["kind"], "committed");
        let observation = fixture.store.operation(&reference).unwrap().operation_observation().await.unwrap().unwrap();
        assert_eq!(observation.outcome, OperationOutcome::Returned { value: saved.clone() });
        let (stale, _) = mutate(&fixture, "updateAssistantPreferences", json!({
            "expectedRevision":initial["revision"],
            "mutation":{"kind":"workspace_instructions","enabled":false}
        }), None).await;
        assert_eq!(stale["kind"], "revision_conflict");
        let session = fixture.create("Assistant policy").await;
        assert_eq!(fixture.send(&session).await.unwrap()["kind"], "started");
        let (mut first, _) = listener.accept().await.unwrap();
        let system = |sent: &Value| sent["messages"].as_array().unwrap().iter()
            .filter(|message| message["role"] == "system")
            .map(|message| message["content"].as_str().unwrap()).collect::<Vec<_>>().join("\n");
        let original = system(&request(&mut first).await);
        assert!(original.starts_with("You are [Maka](https://github.com/apache/maka), an AI agent.\n\n<global_instruction>\nGLOBAL FIRST\n</global_instruction>"));
        for value in ["M4n5ter", "GLOBAL FIRST", "PROJECT FIRST"] {
            assert!(original.contains(value), "missing {value}: {original}");
        }
        assert!(!original.contains("OUTSIDE SECRET"));
        assert!(!original.contains("FIRST TONE"));
        assert_eq!(fixture.send(&session).await.unwrap()["kind"], "queued");
        std::fs::write(global.join("AGENTS.md"), "GLOBAL REPLACED").unwrap();
        std::fs::write(fixture.workspace.join("AGENTS.md"), "PROJECT REPLACED").unwrap();
        let (disabled, _) = mutate(&fixture, "updateAssistantPreferences", json!({
            "expectedRevision":saved["revision"],
            "mutation":{"kind":"workspace_instructions","enabled":false}
        }), None).await;
        assert_eq!(disabled["kind"], "committed");
        response(&mut first).await;
        let (mut second, _) = listener.accept().await.unwrap();
        assert_eq!(system(&request(&mut second).await), original, "queued work uses its persisted acceptance basis");
        response(&mut second).await;
        fixture.drained().await;
        assert_eq!(fixture.send(&session).await.unwrap()["kind"], "started");
        let (mut third, _) = listener.accept().await.unwrap();
        let current = system(&request(&mut third).await);
        assert!(!current.contains("FIRST TONE"));
        assert!(!current.contains("GLOBAL") && !current.contains("PROJECT"));
        response(&mut third).await;
        fixture.drained().await;
        let current = query(&fixture, "assistantPreferences", json!({})).await;
        assert_eq!(current["incognitoActive"], false);
        let (privacy, reference) = mutate(&fixture, "updateAssistantPreferences", json!({
            "expectedRevision":current["revision"],
            "mutation":{"kind":"privacy","incognitoActive":true}
        }), None).await;
        assert_eq!(privacy["kind"], "committed");
        assert_eq!(query(&fixture, "assistantPreferences", json!({})).await["incognitoActive"], true);
        assert!(fixture.config.runtime_policy().await.unwrap().policy.privacy.incognito_active);
        assert_eq!(fixture.store.operation(&reference).unwrap().operation_observation().await.unwrap().unwrap().outcome,
            OperationOutcome::Returned { value: privacy });
        let (stale, _) = mutate(&fixture, "updateAssistantPreferences", json!({
            "expectedRevision":current["revision"],
            "mutation":{"kind":"privacy","incognitoActive":false}
        }), None).await;
        assert_eq!(stale["kind"], "revision_conflict");
        let current = query(&fixture, "assistantPreferences", json!({})).await;
        assert_eq!(current["shellTitles"], true);
        let (disabled, reference) = mutate(&fixture, "updateAssistantPreferences", json!({
            "expectedRevision":current["revision"],
            "mutation":{"kind":"shell_titles","enabled":false}
        }), None).await;
        assert_eq!(disabled["kind"], "committed");
        assert_eq!(query(&fixture, "assistantPreferences", json!({})).await["shellTitles"], false);
        assert!(!fixture.config.runtime_policy().await.unwrap().policy.shell.titles);
        assert_eq!(fixture.store.operation(&reference).unwrap().operation_observation().await.unwrap().unwrap().outcome,
            OperationOutcome::Returned { value: disabled });
        let (stale, _) = mutate(&fixture, "updateAssistantPreferences", json!({
            "expectedRevision":current["revision"],
            "mutation":{"kind":"shell_titles","enabled":true}
        }), None).await;
        assert_eq!(stale["kind"], "revision_conflict");
        assert_eq!(query(&fixture, "assistantPreferences", json!({})).await["shellTitles"], false);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn host_proxy_settings_route_model_requests_and_keep_atomic_credential_receipts() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new("http://proxy-target.invalid/v1", None).await;
        let original = query(&fixture, "network", json!({})).await;
        assert_eq!(original["rootPath"], fixture.root.canonicalize().unwrap().to_str().unwrap());
        assert_eq!(original["rootId"], fixture.store.owned_root().unwrap().root_id());
        let mut policy = original["proxy"].clone();
        policy["enabled"] = json!(true);
        policy["protocol"] = json!("http");
        policy["host"] = json!("127.0.0.1");
        policy["port"] = json!(proxy.local_addr().unwrap().port());
        policy["authEnabled"] = json!(true);
        policy["username"] = json!("proxy-user");
        policy["bypassList"] = json!([]);
        policy["autoBypassDomains"] = json!([]);
        let update = json!({"expectedPolicyRevision":original["revision"],"expectedCredential":null,"networkProxy":policy,"credential":"replace"});
        let (saved, reference) = mutate(&fixture, "updateNetwork", update.clone(), Some("private-proxy-password")).await;
        assert_eq!(saved["result"]["kind"], "committed");
        let current = query(&fixture, "network", json!({})).await;
        assert_eq!(current["proxy"], policy);
        assert_eq!(current["credential"]["configured"], true);
        assert!(!current.to_string().contains("private-proxy-password"));
        assert_eq!(fixture.config.network_configuration().await.unwrap().password.as_deref(), Some("private-proxy-password"));
        assert_eq!(fixture.store.operation(&reference).unwrap().operation_observation().await.unwrap().unwrap().outcome,
            OperationOutcome::Returned { value: saved.clone() });
        let (stale, _) = mutate(&fixture, "updateNetwork", update, Some("different-password")).await;
        assert_eq!(stale["result"]["kind"], "revision_conflict");
        let session = fixture.create("Proxy route").await;
        fixture.send(&session).await.unwrap();
        // This hostname is deliberately unresolvable. Receiving the request at
        // the local proxy proves the actual native model transport uses settings.
        let (mut stream, _) = proxy.accept().await.unwrap();
        let sent = request(&mut stream).await;
        assert_eq!(sent["model"], "fixture-model");
        response(&mut stream).await;
        fixture.drained().await;
        let mut disabled = policy;
        disabled["enabled"] = json!(false);
        disabled["authEnabled"] = json!(false);
        let delete = json!({"expectedPolicyRevision":current["revision"],"expectedCredential":{
            "locator":current["credential"]["locator"],"credentialId":current["credential"]["credentialId"],"revision":current["credential"]["revision"]
        },"networkProxy":disabled,"credential":"delete"});
        let (removed, _) = mutate(&fixture, "updateNetwork", delete.clone(), None).await;
        assert_eq!(removed["result"]["kind"], "committed");
        let final_state = fixture.config.network_configuration().await.unwrap();
        assert!(!final_state.proxy.enabled && !final_state.proxy.auth_enabled && final_state.password.is_none());
        let mut stale_credential = delete;
        stale_credential["expectedPolicyRevision"] = removed["result"]["revision"].clone();
        let (stale, _) = mutate(&fixture, "updateNetwork", stale_credential, None).await;
        assert_eq!(stale["result"]["kind"], "credential_stale");
        let observation = fixture.store.operation(&reference).unwrap().operation_observation().await.unwrap().unwrap();
        assert_eq!(observation.outcome, OperationOutcome::Returned { value: saved });
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn global_instruction_api_and_admission_share_one_selected_file() {
    use futures_util::FutureExt;
    use std::panic::AssertUnwindSafe;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::configured(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        None,
        |settings| {
            settings.assistant = Some(AssistantConfiguration {
                home: Some(
                    settings.workspace_roots[0]
                        .path
                        .parent()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .into(),
                ),
            })
        },
    )
    .await;
    let completed = tokio::time::timeout(Duration::from_secs(60), AssertUnwindSafe(async {
        // Declare the controlled HTTP model's capacity for the full-file prompt.
        // Ordinary model context admission remains active.
        selection::edit(&f, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                context_window: Some(1_000_000), input_limit: Some(900_000), ..Default::default()
            })]));
        }).await;
        let home = f._dir.path();
        std::fs::create_dir(home.join(".agents")).unwrap();
        std::fs::create_dir(home.join(".maka")).unwrap();
        std::fs::write(home.join(".agents/AGENTS.md"), "FALLBACK UNIQUE").unwrap();
        std::fs::write(home.join(".maka/CLAUDE.md"), "OTHER GLOBAL GUIDANCE").unwrap();
        std::fs::write(f.workspace.join("AGENTS.md"), "PROJECT GUIDANCE").unwrap();
        let session = f.create("Global instructions").await;
        let workspace = f.owner.session(&session).await.unwrap().configuration.workspace;
        let policy = f.owner.configuration.runtime_policy().await.unwrap();
        let language = f.owner.resolve_language(&policy);
        let fallback = f.query("globalInstructions",json!({})).await.unwrap();
        assert_eq!(fallback["source"],"agents");
        assert_eq!(fallback["content"],"FALLBACK UNIQUE");
        assert_eq!(fallback["path"], home.join(".agents/AGENTS.md").to_str().unwrap());
        let prompt = f.owner.capture_behavior(&workspace, &policy, language).await.unwrap().unwrap().text;
        assert!(prompt.starts_with("You are [Maka](https://github.com/apache/maka), an AI agent.\n\n<global_instruction>\nFALLBACK UNIQUE\n</global_instruction>\n\n"));
        assert_eq!(prompt.matches("FALLBACK UNIQUE").count(), 1);
        assert!(prompt.contains("<workspace-instructions file=\"CLAUDE.md\" scope=\"global\">\nOTHER GLOBAL GUIDANCE"));
        assert!(prompt.contains("<workspace-instructions file=\"AGENTS.md\" scope=\"project\">\nPROJECT GUIDANCE"));
        assert!(!prompt.contains("<workspace-instructions file=\"AGENTS.md\" scope=\"global\">"));
        let mut disabled = policy.clone();
        disabled.policy.workspace_instructions.enabled = false;
        let without_instructions = f.owner.capture_behavior(&workspace, &disabled, language).await.unwrap().unwrap().text;
        assert!(!without_instructions.contains("<global_instruction>"));
        assert!(!without_instructions.contains("GUIDANCE"));
        std::fs::write(home.join(".maka/AGENTS.md"), "").unwrap();
        let empty = f.query("globalInstructions",json!({})).await.unwrap();
        assert_eq!(empty["source"],"maka");
        assert_eq!(empty["content"],"");
        let prompt = f.owner.capture_behavior(&workspace, &policy, language).await.unwrap().unwrap().text;
        assert!(!prompt.contains("FALLBACK UNIQUE"));
        assert!(!prompt.contains("<global_instruction>"));
        let stale = f.mutation(2,"updateGlobalInstructions",json!({"source":fallback["source"],"revision":fallback["revision"],"content":"STALE"}),Uuid::new_v4()).await.unwrap();
        assert_eq!(stale["kind"],"changed");
        assert_eq!(std::fs::read_to_string(home.join(".agents/AGENTS.md")).unwrap(),"FALLBACK UNIQUE");
        let input = json!({"source":empty["source"],"revision":empty["revision"],"content":"SAVED GLOBAL UNIQUE"});
        let operation = Uuid::new_v4();
        let saved = f.mutation(2,"updateGlobalInstructions",input.clone(),operation).await.unwrap();
        assert_eq!(saved["kind"],"saved");
        assert_eq!(f.send(&session).await.unwrap()["kind"],"started");
        let (mut socket,_) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let system = sent["messages"].as_array().unwrap().iter().filter(|m|m["role"]=="system")
            .map(|m|m["content"].as_str().unwrap()).collect::<Vec<_>>().join("\n");
        assert!(system.starts_with("You are [Maka](https://github.com/apache/maka), an AI agent.\n\n<global_instruction>\nSAVED GLOBAL UNIQUE\n</global_instruction>\n\n"));
        assert_eq!(system.matches("SAVED GLOBAL UNIQUE").count(), 1);
        assert!(system.contains("OTHER GLOBAL GUIDANCE") && system.contains("PROJECT GUIDANCE"));
        assert!(!system.contains("<workspace-instructions file=\"AGENTS.md\" scope=\"global\">"));
        assert!(!system.contains("FALLBACK UNIQUE"));
        response(&mut socket).await;
        f.drained().await;
        std::fs::write(home.join(".maka/AGENTS.md"),"EXTERNAL CHANGE").unwrap();
        assert_eq!(f.mutation(2,"updateGlobalInstructions",input.clone(),operation).await.unwrap(),saved);
        assert_eq!(std::fs::read_to_string(home.join(".maka/AGENTS.md")).unwrap(),"EXTERNAL CHANGE");
        assert_eq!(f.mutation(2,"updateGlobalInstructions",input,Uuid::new_v4()).await.unwrap()["kind"],"changed");
        // One selected, valid UTF-8 file beyond both former editor and prompt limits.
        let large = format!("# GLOBAL ORIGINAL START\n{}GLOBAL ORIGINAL END",
            "Preserve 中文😀 exactly.\n".repeat(40_000));
        assert!(large.len() > 1024 * 1024);
        let path = home.join(".maka/AGENTS.md");
        std::fs::write(&path, &large).unwrap();
        let available = f.query("globalInstructions", json!({})).await.unwrap();
        assert_eq!(available["kind"], "available", "the full selected file must be available through the native API");
        assert_eq!(available["source"], "maka");
        assert_eq!(available["path"], path.to_str().unwrap());
        assert_eq!(available["exists"], true);
        let content = available["content"].as_str().unwrap();
        assert!(content.as_bytes() == large.as_bytes(),
            "complete read differs: got {} bytes, expected {}", content.len(), large.len());
        assert!(std::fs::read(&path).unwrap() == large.as_bytes(), "reading changed the selected file");
        let edited = large.replace("ORIGINAL START", "EDITED START").replace("ORIGINAL END", "EDITED END");
        let saved = f.mutation(2, "updateGlobalInstructions", json!({
            "source":available["source"], "revision":available["revision"], "content":edited
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(saved["kind"], "saved");
        assert!(std::fs::read(&path).unwrap() == edited.as_bytes(), "update did not save every edited byte");
        let updated = f.query("globalInstructions", json!({})).await.unwrap();
        assert_eq!(updated["kind"], "available");
        let content = updated["content"].as_str().unwrap();
        assert!(content.as_bytes() == edited.as_bytes(),
            "complete saved read differs: got {} bytes, expected {}", content.len(), edited.len());
        assert_eq!(f.send(&session).await.unwrap()["kind"], "started");
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        response(&mut socket).await;
        f.drained().await;
        let system = sent["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "system")
            .map(|m| m["content"].as_str().unwrap()).collect::<Vec<_>>().join("\n");
        let global = system.strip_prefix("You are [Maka](https://github.com/apache/maka), an AI agent.\n\n<global_instruction>\n")
            .and_then(|body| body.split_once("\n</global_instruction>")).expect("selected global instruction block").0;
        assert!(global.as_bytes() == edited.as_bytes(),
            "HTTP global instructions differ: got {} bytes, expected {}", global.len(), edited.len());
        assert_eq!(system.matches("<global_instruction>").count(), 1);
        assert!(system.contains("OTHER GLOBAL GUIDANCE") && system.contains("PROJECT GUIDANCE"));
        assert!(!system.contains("<workspace-instructions file=\"AGENTS.md\" scope=\"global\">"));
        assert!(!system.contains("FALLBACK UNIQUE"));
        assert_eq!(std::fs::read_to_string(home.join(".agents/AGENTS.md")).unwrap(), "FALLBACK UNIQUE");
        assert_eq!(std::fs::read_to_string(home.join(".maka/CLAUDE.md")).unwrap(), "OTHER GLOBAL GUIDANCE");
        assert_eq!(std::fs::read_to_string(f.workspace.join("AGENTS.md")).unwrap(), "PROJECT GUIDANCE");
    }).catch_unwind()).await;
    let app_shutdown = f.app.shutdown().await;
    let config_shutdown = f.config.shutdown().await;
    app_shutdown.unwrap();
    config_shutdown.unwrap();
    completed
        .expect("global instruction API and prompt sequence timed out")
        .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
}
