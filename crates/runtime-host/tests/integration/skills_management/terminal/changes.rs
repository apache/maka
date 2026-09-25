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
    pub(in crate::skills_management) async fn update(
        &mut self,
        peer: &mut Peer,
        source: &Path,
        installed: &Path,
        updated: &str,
        local: &str,
    ) {
        let route = json!({"kind":"preview","reference":"workspace:legacy:review"});
        let view = read(peer, route.clone(), "en").await;
        assert!(
            view.action("apply")
                .unwrap()
                .confirm
                .as_ref()
                .unwrap()
                .destructive
        );
        assert!(
            serde_json::to_string(&view)
                .unwrap()
                .contains("Current SKILL.md")
        );
        // Dismissing the displayed review/confirmation makes no request or effect.
        assert_eq!(
            std::fs::read(installed.join("SKILL.md")).unwrap(),
            local.as_bytes()
        );
        let stale = view
            .submission(route.clone(), "apply", BTreeMap::new(), "en".into())
            .unwrap();
        let changed = crate::skills_management::document("Changed after source review");
        std::fs::write(source.join("SKILL.md"), &changed).unwrap();
        assert!(matches!(
            call(peer, stale).await,
            Reply::Conflict | Reply::Rejected { .. }
        ));
        assert_eq!(
            std::fs::read(installed.join("SKILL.md")).unwrap(),
            local.as_bytes()
        );
        std::fs::write(source.join("SKILL.md"), updated).unwrap();
        let view = read(peer, route.clone(), "zh-CN").await;
        let request = view
            .submission(route.clone(), "apply", BTreeMap::new(), "zh-CN".into())
            .unwrap();
        // A local edit after review also invalidates the frozen request.
        let changed = crate::skills_management::document("Changed after current review");
        std::fs::write(installed.join("SKILL.md"), &changed).unwrap();
        assert!(matches!(
            call(peer, request).await,
            Reply::Conflict | Reply::Rejected { .. }
        ));
        assert_eq!(
            std::fs::read(installed.join("SKILL.md")).unwrap(),
            changed.as_bytes()
        );
        std::fs::write(installed.join("SKILL.md"), local).unwrap();
        let view = read(peer, route.clone(), "zh-TW").await;
        let request = view
            .submission(route, "apply", BTreeMap::new(), "zh-TW".into())
            .unwrap();
        self.submit(peer, &view, request).await;
        verify(installed, updated);
        assert_eq!(
            std::fs::read(installed.join("notes.txt")).unwrap(),
            b"keep my resource"
        );
        assert_eq!(
            std::fs::read(source.join("SKILL.md")).unwrap(),
            updated.as_bytes()
        );
    }
    pub(in crate::skills_management) async fn delete(
        &mut self,
        peer: &mut Peer,
        installed: &Path,
        source: &Path,
    ) {
        let route = json!({"kind":"delete","reference":"workspace:legacy:review"});
        let view = read(peer, route.clone(), "en").await;
        assert!(
            view.action("delete")
                .unwrap()
                .confirm
                .as_ref()
                .unwrap()
                .destructive
        );
        let request = view
            .submission(route.clone(), "delete", BTreeMap::new(), "en".into())
            .unwrap();
        std::fs::write(installed.join("new-resource.txt"), b"appeared after review").unwrap();
        assert!(matches!(
            call(peer, request).await,
            Reply::Rejected { .. } | Reply::Conflict
        ));
        assert_eq!(
            std::fs::read(installed.join("new-resource.txt")).unwrap(),
            b"appeared after review"
        );
        assert_eq!(
            std::fs::read(installed.join("notes.txt")).unwrap(),
            b"keep my resource"
        );
        let view = read(peer, route.clone(), "en").await;
        let request = view
            .submission(route, "delete", BTreeMap::new(), "en".into())
            .unwrap();
        self.submit(peer, &view, request).await;
        assert!(!installed.exists());
        assert!(source.join("SKILL.md").is_file());
        let picker = raw_value(peer, "request", json!({"kind":"invocable","page":null})).await;
        assert_eq!(picker["ok"], true, "{picker}");
        assert!(
            !picker["result"]["value"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["ref"] == "workspace:legacy:review")
        );
    }
}
