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
fn document(root: &std::path::Path, version: &str, body: &str) {
    std::fs::create_dir_all(root.join("review")).unwrap();
    std::fs::write(
        root.join("review/SKILL.md"),
        format!("---\nname: review\ndescription: {version}\n---\n{body}"),
    )
    .unwrap();
}
async fn send(f: &Fixture, session: &str, message: &str, operation: Uuid) -> Value {
    f.mutation(
        2,
        "send",
        json!({"sessionId":session,"message":message,"model":f.selection().await}),
        operation,
    )
    .await
    .unwrap()
}
fn model_text(sent: &Value, role: &str) -> String {
    sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == role)
        .map(|message| message["content"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}
#[tokio::test]
async fn skill_input_freezes_original_admission_and_queue_edits_before_actual_http() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
            Some(service_tools::Setup::skill_preparation(dir.path().into(), true).with_standard_sources())).await;
        let session = f.create("Skill preparation").await;
        let workspace = f.owner.session(&session).await.unwrap().configuration.workspace;
        let source = std::path::Path::new(&workspace.path).join(".maka/skills");
        let complete_instructions = format!("CAPTURED ONE {}", "完整说明".repeat(8_000));
        document(&source, "VERSION ONE", &complete_instructions);
        let original = "🦀 /skill:review inspect this";
        assert_eq!(send(&f, &session, original, Uuid::new_v4()).await["kind"], "started");
        let (mut first, _) = listener.accept().await.unwrap();
        let sent = request(&mut first).await;
        let prompt = model_text(&sent, "system");
        assert!(prompt.contains("LoadGuide"), "{sent}");
        assert!(prompt.contains("FindGuide"));
        assert!(prompt.contains("VERSION ONE"));
        let user = model_text(&sent, "user");
        assert!(user.contains(&complete_instructions));
        assert!(!user.contains("/skill:review"));
        let facts = service_tools::facts(&f, &session).await;
        let maka_agent_facts::event::Fact::InvocationOpened { input: maka_agent_facts::event::InvocationInput::Message { content, source_messages, .. }, .. } = facts.iter().find(|fact| matches!(fact, maka_agent_facts::event::Fact::InvocationOpened { .. })).unwrap() else { panic!() };
        assert_eq!(content.display_text.as_deref(), Some(original));
        assert_eq!(content.inline_references.as_ref().unwrap()[0].start, 3);
        assert_eq!(source_messages[0].unprepared_content.text, original);
        assert_eq!(source_messages[0].message.submitted_content_digest, MessageInput::from(original).content_digest().unwrap());
        assert_eq!(content.preparation.len(), 1);
        assert_eq!(content.preparation[0].receipt["invocation"]["receipts"][0]["success"], true);
        let metadata = content.preparation[0].receipt["metadataPrompt"].as_str().unwrap();
        assert!(metadata.contains("VERSION ONE"));
        let composition = session_context::composition(&f, &session).await;
        assert_eq!(composition.system_prompt.as_deref(), Some(metadata));
        assert!(prompt.contains(metadata), "the actual request must retain the exact prepared metadata");
        let operation = Uuid::new_v4();
        let queued = send(&f, &session, "/skill:review queued", operation).await;
        assert_eq!(queued["kind"], "queued");
        let rejected = send(&f, &session, "/skill:missing", Uuid::new_v4()).await;
        assert_eq!(rejected["kind"], "rejected");
        assert_eq!(rejected["skills"]["failed"][0]["reason"], "not_found");
        document(&source, "VERSION TWO", "CAPTURED TWO");
        let edit = json!({"sessionId":session,"expectedRevision":queued["revision"],"edit":{"kind":"update","messageId":queued["messageId"],"message":"/skill:review edited"}});
        let updated = f.mutation(2, "editQueue", edit, Uuid::new_v4()).await.unwrap();
        assert_eq!(updated["kind"], "committed");
        std::fs::write(source.join("review/SKILL.md"), "invalid").unwrap();
        let failed = f.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":updated["revision"],"edit":{"kind":"update","messageId":queued["messageId"],"message":"/skill:review rejected edit"}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(failed["kind"], "rejected");
        assert_eq!(f.query("queueMessage", json!({"sessionId":session,"expectedRevision":updated["revision"],"messageId":queued["messageId"]})).await.unwrap()["message"], "/skill:review edited");
        document(&source, "VERSION THREE", "CAPTURED THREE");
        assert_eq!(send(&f, &session, "/skill:review queued", operation).await, queued);
        response(&mut first).await;
        let (mut second, _) = listener.accept().await.unwrap();
        let resumed = request(&mut second).await;
        let user = model_text(&resumed, "user");
        assert!(user.contains("CAPTURED TWO"));
        assert!(!user.contains("CAPTURED THREE"));
        assert!(model_text(&resumed, "system").contains("VERSION TWO"));
        assert!(!model_text(&resumed, "system").contains("VERSION THREE"));
        response(&mut second).await;
        f.drained().await;
        assert!(f.query("queue", json!({"sessionId":session})).await.unwrap()["entries"].as_array().unwrap().is_empty());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
#[tokio::test]
async fn skill_input_has_no_implicit_tools_grant_or_model_fallback_for_rejections() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let dir = tempfile::tempdir().unwrap();
        document(
            dir.path(),
            "EXPLICIT ONLY REVIEW METADATA",
            "Explicit instructions",
        );
        for mode in ["absent", "no_grant", "explicit_only"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let setup = match mode {
                "absent" => None,
                "no_grant" => Some(
                    service_tools::Setup::skill_preparation(dir.path().into(), false)
                        .without_grant(),
                ),
                _ => Some(service_tools::Setup::skill_preparation(
                    dir.path().into(),
                    false,
                )),
            };
            let f = Fixture::with_services(
                &format!("http://{}/v1", listener.local_addr().unwrap()),
                None,
                None,
                setup,
            )
            .await;
            let session = f.create("Skill input boundary").await;
            let value = send(&f, &session, "/skill:review /skill:missing", Uuid::new_v4()).await;
            if mode == "explicit_only" {
                assert_eq!(value["kind"], "started", "{value}");
                let (mut socket, _) = listener.accept().await.unwrap();
                let sent = request(&mut socket).await;
                let system = model_text(&sent, "system");
                assert!(!system.contains("EXPLICIT ONLY REVIEW METADATA"));
                assert!(!system.contains("Explicit instructions"));
                assert!(sent["tools"].is_null() || sent["tools"].as_array().unwrap().is_empty());
                let user = model_text(&sent, "user");
                assert!(user.contains("Explicit instructions"));
                assert!(!user.contains("/skill:"));
                response(&mut socket).await;
                f.drained().await;
                let body = "x".repeat(96 * 1024);
                let large = format!("/skill:review {body}");
                let accepted = send(&f, &session, &large, Uuid::new_v4()).await;
                assert_eq!(accepted["kind"], "started", "{accepted}");
                let (mut socket, _) = listener.accept().await.unwrap();
                let sent = request(&mut socket).await;
                assert!(model_text(&sent, "user").contains(&body));
                response(&mut socket).await;
                f.drained().await;
            } else {
                assert_eq!(value["kind"], "rejected", "{value}");
                assert_eq!(value["reason"], "skills_unavailable");
                assert!(service_tools::facts(&f, &session).await.is_empty());
            }
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn skill_preparation_survives_host_restart_without_preparing_again() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let dir = tempfile::tempdir().unwrap();
        document(dir.path(), "FROZEN METADATA", "FROZEN INSTRUCTIONS");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()),
            None, None, Some(service_tools::Setup::skill_preparation(dir.path().into(), false))).await;
        let session = f.create("Prepared restart").await;
        let deployment = f.app.client().snapshot().effective.unwrap().deployment;
        let raw = rusqlite::Connection::open(f.session_database(&session)).unwrap();
        raw.execute_batch("CREATE TRIGGER hold_opening BEFORE INSERT ON event_log WHEN NEW.kind='invocation_opened' BEGIN SELECT RAISE(ABORT, 'fixture opening failure'); END;").unwrap();
        assert!(f.mutation(2, "send", json!({"sessionId":session,"message":"/skill:review inspect","model":f.selection().await}), Uuid::new_v4()).await.is_err());
        assert_eq!(f.session(&session).await.pending_messages(&session).await.unwrap().len(), 1);
        f.app.shutdown().await.unwrap();
        raw.execute_batch("DROP TRIGGER hold_opening").unwrap();
        drop(raw);
        document(dir.path(), "CHANGED METADATA", "CHANGED INSTRUCTIONS");
        let mut native = NativeRegistry::default();
        crate::owner::tests::provide_all(&mut native).unwrap();
        maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
        // Restore has no native prepare grant: it must use the original durable message.
        let resumed = Application::start_from_store(f.store.clone(), deployment, native,
            f.issuer.clone(), Arc::new(Grant(f.issuer.clone(), None)), Some(maka_host_js::factory(Default::default()))).await.unwrap();
        resumed.ready().await.unwrap();
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept()).await
            .unwrap_or_else(|_| panic!("restored input never reached the model")).unwrap();
        let sent = request(&mut socket).await;
        let system = model_text(&sent, "system");
        for skill_content in ["FROZEN METADATA", "CHANGED METADATA", "FROZEN INSTRUCTIONS", "CHANGED INSTRUCTIONS"] {
            assert!(!system.contains(skill_content), "explicit skill content must remain user input: {system}");
        }
        assert!(model_text(&sent, "user").contains("FROZEN INSTRUCTIONS"));
        assert!(!model_text(&sent, "user").contains("CHANGED INSTRUCTIONS"));
        response(&mut socket).await;
        while !f.session(&session).await.pending_messages(&session).await.unwrap().is_empty() { tokio::task::yield_now().await; }
        resumed.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
