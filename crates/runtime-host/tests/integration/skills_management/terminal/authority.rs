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

impl History {
    pub(in crate::skills_management) async fn restricted(
        &self,
        address: std::net::SocketAddr,
        peer: &mut Peer,
        managed: &Path,
    ) {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
        let mut request = format!("ws://{address}/runtime-host")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "Authorization",
            "Bearer synthetic-skills-viewer".parse().unwrap(),
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        socket.send(Message::text(json!({"kind":"hello","clientInstanceId":"skills-viewer","protocolMin":0,"protocolMax":0,"compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH,"compositionId":"maka.interactive"}).to_string())).await.unwrap();
        let hello: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(hello["state"], "ready");
        let (original, recovery, _) = &self.originals[0];
        let Request::Submit {
            grant: Some(grant),
            fields,
            ..
        } = original
        else {
            panic!("approved import");
        };
        let grant = *grant;
        let source_path = fields["path"].clone();
        let journal = std::fs::read_dir(
            managed
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join(".skill-sources-publication"),
        )
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("transactions");
        let hash = maka_runtime::artifact::content_digest(b"restricted recovery proof");
        let pending = journal.join(format!("gc-{}-{}", uuid::Uuid::new_v4(), &hash[7..]));
        std::fs::create_dir(&pending).unwrap();
        std::fs::write(
            pending.join("proof"),
            b"must not collect without foreground authority",
        )
        .unwrap();
        let original_bytes = std::fs::read(managed.join("SKILL.md")).unwrap();
        let mut original = original.clone();
        if let Request::Submit { grant, .. } = &mut original {
            *grant = None;
        }
        let mut document = Value::Null;
        let mut target = Value::Null;
        for step in [
            "document",
            "ordinary-bind",
            "ordinary-read",
            "library-bind",
            "library-submit",
            "library-recover",
            "import-bind",
            "import-submit",
            "recovery-bind",
            "recovery-submit",
        ] {
            let method = match step.split('-').next().unwrap() {
                "ordinary" => "terminal",
                "import" => "import-source",
                "recovery" => "user-authorization",
                _ => "terminal-library",
            };
            let binding =
                json!({"packageId":"maka.skills","method":method,"sessionId":"skill-library"});
            let input = if step == "document" {
                json!({"kind":"open_document"})
            } else if step.ends_with("bind") {
                json!({"kind":"bind","binding":binding})
            } else {
                let input = match step {
                    "ordinary-read" => serde_json::to_value(Request::Read {
                        route: Value::Null,
                        locale: "en".into(),
                    })
                    .unwrap(),
                    "library-submit" => serde_json::to_value(&original).unwrap(),
                    "import-submit" => json!({"sourcePath":source_path,"grant":grant}),
                    "recovery-submit" => json!({"kind":"recover","grant":grant}),
                    _ => serde_json::to_value(Request::Recover {
                        route: recovery.clone(),
                        locale: "en".into(),
                    })
                    .unwrap(),
                };
                json!({"kind":"call","binding":binding,"document":document,"target":target,"input":input})
            };
            socket
                .send(Message::text(
                    json!({"requestId":step,"operation":"plugin.remote","input":input}).to_string(),
                ))
                .await
                .unwrap();
            let response = loop {
                let response: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                if response["requestId"] == step {
                    break response;
                }
            };
            if matches!(
                step,
                "library-submit" | "library-recover" | "import-submit" | "recovery-submit"
            ) {
                assert_eq!(
                    response["ok"], false,
                    "restricted caller borrowed remembered user authority: {response}"
                );
                assert!(
                    pending.join("proof").is_file(),
                    "denied request recovered a pending user publication"
                );
                assert_eq!(
                    std::fs::read(managed.join("SKILL.md")).unwrap(),
                    original_bytes,
                    "denied request changed managed source bytes"
                );
                assert!(
                    response["error"]["message"]
                        .as_str()
                        .unwrap()
                        .contains("retired or revoked"),
                    "{response}"
                );
            } else {
                assert_eq!(response["ok"], true, "{response}");
                if step == "document" {
                    document = response["result"]["document"].clone();
                }
                if step.ends_with("bind") {
                    target = response["result"]["target"].clone();
                }
            }
        }
        socket.close(None).await.unwrap();
        let status = crate::skills_plugin::client::request(
            peer,
            "user-authorization",
            json!({"kind":"recover","grant":grant}),
        )
        .await;
        assert!(status["recovery"].is_null());
        assert!(
            !pending.exists(),
            "an explicitly authorized owner may resume the same pending publication"
        );
    }
}

pub(in crate::skills_management) async fn credential(
    fixture: &crate::skills_management::ClientFixture,
) {
    use sha2::{Digest, Sha256};
    let configuration =
        maka_config::ConfigurationStore::for_root(std::sync::Arc::new(fixture.owner()))
            .await
            .unwrap();
    configuration
        .create_access_credential(
            maka_config::access::AccessCredential {
                credential_id: "skills-viewer".into(),
                credential_hash: format!("{:x}", Sha256::digest(b"synthetic-skills-viewer")),
                principal_id: "skills-viewer".into(),
                principal_kind: maka_runtime::access::ManagedPrincipalKind::RemoteOwner,
                grants: vec!["plugin.remote".into()],
                can_publish_client_capabilities: false,
                can_use_host_paths: true,
                created_at: "2026-09-25T00:00:00Z".into(),
                state: maka_config::access::CredentialState::Active {
                    client_instance_id: None,
                },
                capability_owner: None,
            },
            maka_config::access::AccessCreateMode::Issue,
            None,
        )
        .await
        .unwrap();
    configuration.close().await.unwrap();
}
