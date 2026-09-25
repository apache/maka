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
    pub(in crate::skills_management) async fn import(
        &mut self,
        peer: &mut Peer,
        original: &Path,
        managed: &Path,
        private: &Path,
        bytes: &str,
    ) -> Value {
        let route = json!({"kind":"import"});
        for locale in ["en", "zh-CN", "zh-TW"] {
            let view = read(peer, route.clone(), locale).await;
            assert_eq!(view.fields.len(), 1);
            assert!(view.actions[0].recovery.is_some());
        }
        let view = read(peer, route.clone(), "en").await;
        let mut request = view
            .submission(
                route,
                "import",
                BTreeMap::from([("path".into(), json!(original))]),
                "en".into(),
            )
            .unwrap();
        let Reply::Consent {
            request: authorization,
        } = call(peer, request.clone()).await
        else {
            panic!("import consent");
        };
        assert!(!managed.exists(), "canceling consent copies nothing");
        assert_eq!(std::fs::read_to_string(original).unwrap(), bytes);
        let absent = call(
            peer,
            Request::Recover {
                route: view.action("import").unwrap().recovery.clone().unwrap(),
                locale: "en".into(),
            },
        )
        .await;
        assert!(matches!(absent, Reply::Unrecorded));
        // Approval targets the configured user home, not the source directory.
        let approved = crate::skills_plugin::client::authorization(
            peer,
            json!({"kind":"approve","request":authorization}),
        )
        .await;
        let grant = approved["grant"]["id"].clone();
        if let Request::Submit { grant: field, .. } = &mut request {
            *field = Some(serde_json::from_value(grant.clone()).unwrap());
        }
        self.submit(peer, &view, request.clone()).await;
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
        let transaction =
            publication_gap(managed, private, &journal, &view.revision, &["SKILL.md"]);
        let moved = original
            .parent()
            .unwrap()
            .with_file_name("moved-import-source");
        std::fs::rename(original.parent().unwrap(), &moved).unwrap();
        assert!(matches!(
            call(
                peer,
                Request::Recover {
                    route: view.action("import").unwrap().recovery.clone().unwrap(),
                    locale: "en".into()
                }
            )
            .await,
            Reply::Unrecorded
        ));
        assert!(!transaction.join("committed").exists());
        assert!(
            matches!(call(peer, request.clone()).await, Reply::Applied { .. }),
            "original import settles without reopening its removed source parent"
        );
        assert!(!transaction.exists());
        std::fs::rename(&moved, original.parent().unwrap()).unwrap();
        if let Request::Submit { fields, .. } = &mut request {
            fields.insert("path".into(), json!("/another-file.md"));
        }
        assert_eq!(
            raw(peer, request).await["ok"],
            false,
            "same operation cannot change its source path"
        );
        assert_eq!(
            std::fs::read(managed.join("SKILL.md")).unwrap(),
            bytes.as_bytes()
        );
        assert_eq!(
            std::fs::read_dir(managed).unwrap().count(),
            1,
            "import copies only Markdown"
        );
        assert_eq!(std::fs::read_to_string(original).unwrap(), bytes);
        grant
    }
    pub(in crate::skills_management) async fn install(
        &mut self,
        peer: &mut Peer,
        installed: &Path,
        bytes: &str,
    ) {
        let route = json!({"kind":"source","source":"managed","id":"review"});
        let view = read(peer, route.clone(), "en").await;
        assert!(
            serde_json::to_string(&view)
                .unwrap()
                .contains("Maka skill library")
        );
        let mut forged = view
            .submission(route.clone(), "install", BTreeMap::new(), "en".into())
            .unwrap();
        if let Request::Submit { fields, .. } = &mut forged {
            fields.insert("path".into(), json!("/not-authorized"));
        }
        assert_eq!(raw(peer, forged).await["ok"], false);
        let request = view
            .submission(route, "install", BTreeMap::new(), "en".into())
            .unwrap();
        self.submit(peer, &view, request.clone()).await;
        verify(installed, bytes);
        let recovery = view.action("install").unwrap().recovery.clone().unwrap();
        let private = installed.parent().unwrap().parent().unwrap();
        let transaction = publication_gap(
            installed,
            private,
            &private.join("transactions"),
            &view.revision,
            &[
                ".maka",
                ".maka/baseline",
                "SKILL.md",
                "skill.lock.json",
                ".maka/baseline/SKILL.md",
            ],
        );
        assert!(matches!(
            call(
                peer,
                Request::Recover {
                    route: recovery.clone(),
                    locale: "en".into()
                }
            )
            .await,
            Reply::Unrecorded
        ));
        assert!(
            !transaction.join("committed").exists(),
            "Recover must not replay an intent"
        );
        // The old catalog changed when install published. Explicit retry still
        // settles that original intent before checking a new source-page CAS.
        assert!(matches!(call(peer, request).await, Reply::Applied { .. }));
        assert!(!transaction.exists());
        assert!(matches!(
            call(
                peer,
                Request::Recover {
                    route: recovery,
                    locale: "en".into()
                }
            )
            .await,
            Reply::Applied { .. }
        ));
        verify(installed, bytes);
        let picker = raw_value(peer, "request", json!({"kind":"invocable","page":null})).await;
        assert_eq!(picker["ok"], true, "{picker}");
        assert!(
            picker["result"]["value"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["ref"] == "workspace:legacy:review")
        );
    }
}
