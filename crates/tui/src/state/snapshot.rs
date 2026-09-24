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

use crate::{
    app::{Action, App},
    editor::{Editor, saved::Saved},
    i18n::LocalePreference,
    navigation::{Route, tabs::LIMIT},
    pages::sending::{Delivery, Sending, Submission},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    version: u32,
    pub root: String,
    tabs: Vec<String>,
    drafts: BTreeMap<String, Saved>,
    attachments: BTreeMap<String, Vec<crate::pages::attachments::Saved>>,
    directories: BTreeMap<String, Vec<maka_protocol::turn::DirectoryReference>>,
    skills: BTreeMap<String, Vec<crate::pages::skills::Picked>>,
    unresolved: Vec<Submission>,
    locale: LocalePreference,
    theme: crate::theme::Choice,
    ascii: bool,
    motion: bool,
    sidebar: Option<bool>,
    fullscreen: bool,
    #[serde(default)]
    inspector: bool,
    readings: Vec<(String, crate::pages::chat::reading::Checkpoint)>,
    navigation: crate::navigation::Navigation,
    pages: Vec<(Route, crate::navigation::state::Saved)>,
    oauth: Option<crate::pages::manage::oauth::saved::Checkpoint>,
    branch: Option<crate::pages::branch::Checkpoint>,
    recap: Option<crate::pages::recap::Checkpoint>,
    #[serde(default)]
    resume: Option<crate::pages::resume::Checkpoint>,
    revision: Option<crate::pages::revision::Checkpoint>,
    apps: Vec<crate::apps::Checkpoint>,
}

impl Snapshot {
    pub fn capture(app: &App, root: &str) -> Self {
        let mut unresolved: Vec<_> = app
            .sending
            .values()
            .filter(|sent| sent.delivery.blocks_send())
            .map(|sent| sent.request.clone())
            .collect();
        unresolved.sort_by(|left, right| left.session.cmp(&right.session));
        Self {
            version: 16,
            attachments: app.attachments.saved.clone(),
            directories: app.directories.clone(),
            skills: app.skills.saved.clone(),
            root: root.into(),
            tabs: app.tabs.entries.iter().map(|tab| tab.id.clone()).collect(),
            drafts: app
                .drafts
                .iter()
                .map(|(id, editor)| (id.clone(), editor.save()))
                .collect(),
            unresolved,
            locale: app.i18n.preference,
            theme: app.theme.choice,
            ascii: app.chrome.ascii,
            motion: app.chrome.motion,
            sidebar: app.chrome.sidebar_expanded,
            fullscreen: app.chrome.session_fullscreen,
            inspector: app.chrome.inspector,
            readings: app.chat.checkpoints(),
            navigation: app.navigation.clone(),
            pages: app.saved_pages(),
            oauth: app.management.oauth.checkpoint(),
            branch: app.branch.checkpoint(),
            recap: app.recap.checkpoint(),
            resume: app.resume.checkpoint(),
            revision: app.revision.checkpoint(),
            apps: app.apps.checkpoints(root),
        }
    }

    pub fn validate(&self, root: &str) -> Result<(), String> {
        let id = |id: &str| {
            !id.is_empty() && id.encode_utf16().count() <= 256 && !id.chars().any(char::is_control)
        };
        if self.version != 16
            || self.root != root
            || self.tabs.len() > LIMIT
            || self.drafts.len() > LIMIT
            || self.unresolved.len() > LIMIT
            || self.readings.len() > LIMIT
            || self.pages.len() > LIMIT + Route::PAGE_COUNT
        {
            return Err("Unsupported or mismatched TUI checkpoint".into());
        }
        let tabs: HashSet<_> = self.tabs.iter().collect();
        if tabs.len() != self.tabs.len()
            || self
                .tabs
                .iter()
                .any(|key| !id(key) || !self.drafts.contains_key(key))
            || self.drafts.keys().any(|key| !id(key))
        {
            return Err("Invalid TUI checkpoint destinations".into());
        }
        let destination = |route: &Route| match route {
            Route::Session(key) => tabs.contains(key),
            _ => true,
        };
        let mut pages = Vec::new();
        if !self.navigation.valid(destination)
            || self.pages.iter().any(|(route, saved)| {
                let duplicate = pages.contains(&route);
                pages.push(route);
                duplicate || !destination(route) || !saved.valid(route, destination)
            })
        {
            return Err("Invalid saved navigation".into());
        }
        if self.skills.len() > LIMIT {
            return Err("Too many Skills drafts".into());
        }
        for (session, items) in &self.skills {
            if !self.drafts.contains_key(session) {
                return Err("Invalid Skills draft destination".into());
            }
            crate::pages::skills::validate(items)?;
        }
        if self.directories.len() > LIMIT {
            return Err("Too many directory drafts".into());
        }
        for (session, items) in &self.directories {
            if !self.drafts.contains_key(session) {
                return Err("Invalid directory draft destination".into());
            }
            crate::pages::references::validate(items, root)?;
        }
        let mut uploads = HashSet::new();
        if self.attachments.len() > LIMIT {
            return Err("Too many attachment drafts".into());
        }
        for (session, items) in &self.attachments {
            if !self.drafts.contains_key(session) || items.len() > crate::pages::attachments::LIMIT
            {
                return Err("Invalid attachment draft destination or count".into());
            }
            for item in items {
                if !uploads.insert(item.id.as_str()) {
                    return Err("Duplicate attachment upload".into());
                }
                item.validate(session)?;
            }
        }
        for saved in self.drafts.values() {
            // Validate through the editor's actual Unicode and input-size rules.
            saved.validate()?;
        }
        let mut readings = HashSet::new();
        if self
            .readings
            .iter()
            .any(|(key, saved)| !id(key) || !readings.insert(key) || !saved.valid())
            || self
                .readings
                .iter()
                .map(|(id, saved)| id.len() * 2 + saved.bytes())
                .sum::<usize>()
                > crate::pages::chat::reading::DISK_BUDGET
        {
            return Err("Invalid saved reading metadata".into());
        }
        let mut seen = HashSet::new();
        for request in &self.unresolved {
            if request.root_id != root
                || !self.drafts.contains_key(&request.session)
                || !seen.insert(request.session.clone())
            {
                return Err("Invalid saved submission identity".into());
            }
            request.input().validate().map_err(|e| e.to_string())?;
        }
        if let Some(oauth) = &self.oauth {
            oauth.validate()?;
        }
        if self.apps.len() > crate::navigation::tabs::LIMIT {
            return Err("Too many plugin checkpoints".into());
        }
        for checkpoint in &self.apps {
            checkpoint.validate(root)?;
        }
        if let Some(revision) = &self.revision {
            revision.validate(root)?;
            if revision.upload_ids().any(|id| !uploads.insert(id)) {
                return Err("Duplicate revision/composer upload".into());
            }
        }
        if let Some(recap) = &self.recap {
            recap.validate(root)?;
        }
        if let Some(resume) = &self.resume {
            resume.validate(root)?;
        }
        if let Some(branch) = &self.branch {
            branch.validate(root)?;
        }
        Ok(())
    }

    pub fn restore(self, app: &mut App, keep_locale: bool) -> Result<(), String> {
        self.validate(&self.root)?;
        if !app.bind_root(&self.root) {
            return Err("TUI checkpoint belongs to another Root".into());
        }
        if let Some(oauth) = self.oauth {
            app.management.oauth.restore(&self.root, oauth);
        }
        if let Some(revision) = self.revision {
            app.revision.restore(revision);
        }
        app.apps.restore(self.apps)?;
        if let Some(recap) = self.recap {
            app.recap.restore(recap);
        }
        if let Some(resume) = self.resume {
            app.resume.restore(resume);
        }
        if let Some(branch) = self.branch {
            app.branch.restore(branch);
        }
        app.attachments.saved = self.attachments;
        app.directories = self.directories;
        app.skills.saved = self.skills;
        for (id, saved) in self.drafts {
            app.drafts.insert(id, Editor::restore(saved)?);
        }
        for request in self.unresolved {
            app.sending.insert(
                request.session.clone(),
                Sending {
                    request,
                    delivery: Delivery::Unknown(None),
                },
            );
        }
        for id in self.tabs {
            app.tabs.open(&id);
        }
        app.chat.restore_checkpoints(self.readings);
        app.theme.choice = self.theme;
        app.chrome.ascii = self.ascii;
        app.chrome.motion = self.motion;
        app.chrome.sidebar_expanded = self.sidebar;
        app.chrome.session_fullscreen = self.fullscreen;
        app.chrome.inspector = self.inspector;
        if !keep_locale {
            app.i18n.preference = self.locale;
        }
        app.apply(Action::Visit(self.navigation.current()));
        app.navigation = self.navigation;
        app.page_states = self
            .pages
            .into_iter()
            .map(|(route, saved)| (route, saved.restore()))
            .collect();
        app.enter_page();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::{ConnectionState, Focus},
        i18n::{I18n, Locale},
    };
    fn app() -> App {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "old-epoch".into(),
        };
        app
    }
    #[test]
    fn checkpoint_restores_drafts_preferences_and_original_unknown_identity_without_dispatching() {
        let mut original = app();
        original.apply(Action::Visit(Route::Session("a".into())));
        original.drafts.get_mut("a").unwrap().insert("中文🦀");
        original.skills.saved.insert(
            "a".into(),
            vec![crate::pages::skills::Picked {
                id: "review".into(),
                name: "Review".into(),
            }],
        );
        original.directories.insert(
            "a".into(),
            vec![maka_protocol::turn::DirectoryReference {
                host_id: "root".into(),
                path: "/selected".into(),
            }],
        );
        let request = original.submission().unwrap();
        original.drafts.get_mut("a").unwrap().insert(" new edits");
        original.i18n.preference = LocalePreference::Explicit(Locale::ZhTw);
        original.chrome.ascii = true;
        original.theme.choice = crate::theme::Choice::Paper;
        original.apply(Action::Visit(Route::Settings));
        original.apply(Action::Onboard(crate::pages::onboarding::Command::Open));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|f| crate::view::draw(f, &mut original))
            .unwrap();
        original.apply(Action::Onboard(crate::pages::onboarding::Command::Field(2)));
        original.input(crossterm::event::Event::Paste(
            "never-persist-this-api-key".into(),
        ));
        let bytes = serde_json::to_vec(&Snapshot::capture(&original, "root")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("never-persist-this-api-key"));
        let saved: Snapshot = serde_json::from_slice(&bytes).unwrap();
        assert!(saved.validate("different-root").is_err());
        let mut restored = app();
        saved.restore(&mut restored, false).unwrap();
        assert!(
            restored.onboarding.dialog.is_none(),
            "credential entry is never restored or replayed"
        );
        assert_eq!(restored.navigation.current(), Route::Settings);
        assert_eq!(restored.drafts["a"].text(), "中文🦀 new edits");
        assert_eq!(
            restored.directories["a"],
            request.content.directory_references.clone().unwrap()
        );
        assert_eq!(restored.sending["a"].request.input(), request.input());
        assert_eq!(
            crate::pages::skills::selections(&restored.skills.saved["a"]),
            request.input_selections
        );
        assert!(restored.skills.dialog.is_none());
        assert!(matches!(
            restored.sending["a"].delivery,
            Delivery::Unknown(None)
        ));
        assert!(restored.chrome.ascii);
        assert_eq!(restored.theme.choice, crate::theme::Choice::Paper);
        assert_eq!(
            restored.i18n.preference,
            LocalePreference::Explicit(Locale::ZhTw)
        );
        restored.apply(Action::Visit(Route::Session("a".into())));
        assert!(restored.submission().is_none());
        restored.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "new-epoch".into(),
        };
        assert!(restored.retry_submission().is_none());
        assert!(restored.reconciliation().is_some());
        let mut invalid: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        invalid["version"] = serde_json::json!(u32::MAX);
        assert!(
            serde_json::from_value::<Snapshot>(invalid)
                .unwrap()
                .validate("root")
                .is_err()
        );
        for invalid_items in [
            serde_json::json!([{"hostId":"foreign","path":"/selected"}]),
            serde_json::json!([{"hostId":"root","path":"relative"}]),
            serde_json::json!(vec![serde_json::json!({"hostId":"root","path":"/x"}); 5]),
        ] {
            let mut invalid: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            invalid["directories"]["a"] = invalid_items;
            assert!(
                serde_json::from_value::<Snapshot>(invalid)
                    .unwrap()
                    .validate("root")
                    .is_err()
            );
        }
        let mut oauth = serde_json::to_value(Snapshot::capture(&original, "root")).unwrap();
        oauth["oauth"] = serde_json::json!({"attempt":{
            "attemptId":"persisted-login", "target":{"kind":"create","provider":crate::providers::fixtures::entry("xai-oauth", true).identity, "configuration":{}, "name":"Account", "slug":"account"}}, "connection":null});
        let mut reopened = app();
        serde_json::from_value::<Snapshot>(oauth.clone())
            .unwrap()
            .restore(&mut reopened, false)
            .unwrap();
        assert!(reopened.management.dialog.is_none());
        assert!(reopened.oauth_request().is_none());
        assert_eq!(
            serde_json::to_value(Snapshot::capture(&reopened, "root")).unwrap()["oauth"],
            oauth["oauth"]
        );
    }

    #[test]
    fn structured_unknown_requests_keep_all_content_and_intent_across_restore_and_retry() {
        use maka_protocol::message::{Placement, SubmitResult};
        use serde_json::json;

        let mut original = app();
        original.apply(Action::Visit(Route::Session("a".into())));
        original
            .drafts
            .get_mut("a")
            .unwrap()
            .insert("Original prompt");
        let mut request = original.submission_for(Placement::CurrentTurn).unwrap();
        request.content = serde_json::from_value(json!({
            "text":"Original prompt", "displayText":"🦀 @src/main.rs",
            "attachments":[{"kind":"image","name":"image.png","mimeType":"image/png","bytes":42,
                "ref":{"kind":"session_file","sessionId":"source","relativePath":"image.png"}}],
            "quotes":[{"text":"Original quotation","label":"Source","sourceTurnId":"source-turn"}],
            "directoryReferences":[{"hostId":"origin-host","path":"/original/workspace"}],
            "inlineReferences":[{"kind":"workspace_file","value":"@src/main.rs","label":"main.rs","start":3}]
        })).unwrap();
        request
            .input_selections
            .insert("skills".into(), vec!["review".into()]);
        request.turn_orchestration =
            Some(serde_json::from_value(json!({"mode":"code","source":"slash_command"})).unwrap());
        request.input().validate().unwrap();
        original.sending.get_mut("a").unwrap().request = request.clone();
        let saved = serde_json::to_value(Snapshot::capture(&original, "root")).unwrap();
        assert_eq!(saved["version"], 16);
        let mut restored = app();
        serde_json::from_value::<Snapshot>(saved.clone())
            .unwrap()
            .restore(&mut restored, false)
            .unwrap();
        assert_eq!(restored.sending["a"].request.input(), request.input());
        assert!(matches!(
            restored.sending["a"].delivery,
            Delivery::Unknown(None)
        ));
        let retry = restored.retry_submission().unwrap();
        assert_eq!(retry, request);

        // Same message ID is not enough: an altered attachment, display or
        // preparation intent must not release the saved request or its draft.
        let mut changed = retry.clone();
        changed.content.attachments.as_mut().unwrap()[0].name = "other.png".into();
        assert!(!restored.after_checkpoint(&changed, &Ok(())));
        restored.submitted(
            changed.clone(),
            Ok(SubmitResult::Blocked {
                message: "foreign reply".into(),
                preparation: vec![],
            }),
        );
        assert!(matches!(restored.sending["a"].delivery, Delivery::Retrying));
        assert!(restored.after_checkpoint(&retry, &Ok(())));
        restored.abandon_pending_submissions();
        let checking = restored.reconciliation().unwrap();
        let accepted = maka_protocol::message::ExecutionResolution::Pending {
            message_id: retry.id.clone(),
        };
        restored.reconciled(changed, Ok(Some(accepted.clone())));
        assert!(matches!(restored.sending["a"].delivery, Delivery::Checking));
        assert_eq!(restored.drafts["a"].text(), "Original prompt");
        restored.reconciled(checking, Ok(Some(accepted)));
        assert!(restored.drafts["a"].text().is_empty());

        for (pointer, value) in [
            ("/unresolved/0/placement", json!("next_turn")),
            ("/unresolved/0/content/inlineReferences/0/start", json!(2)),
            (
                "/unresolved/0/content/attachments/0/ref",
                json!({"kind":"session_context","sessionId":"source","refId":"owned"}),
            ),
        ] {
            let mut invalid = saved.clone();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(
                serde_json::from_value::<Snapshot>(invalid)
                    .unwrap()
                    .validate("root")
                    .is_err(),
                "{pointer}"
            );
        }
        let mut incomplete = saved;
        incomplete["unresolved"][0]
            .as_object_mut()
            .unwrap()
            .remove("input_selections");
        assert!(
            serde_json::from_value::<Snapshot>(incomplete).is_err(),
            "incomplete requests must not be restored"
        );
    }

    #[test]
    fn navigation_checkpoint_restores_both_branches_and_safe_focus_but_not_live_controls() {
        let mut original = app();
        original.apply(Action::Visit(Route::Session("a".into())));
        original.focus = Focus::Transcript;
        original.apply(Action::Visit(Route::Settings));
        original.settings.focus_setting(&Action::ToggleSymbols);
        original.apply(Action::Visit(Route::Help));
        original.apply(Action::Back);
        let encoded = serde_json::to_value(Snapshot::capture(&original, "root")).unwrap();
        let mut restored = app();
        serde_json::from_value::<Snapshot>(encoded.clone())
            .unwrap()
            .restore(&mut restored, false)
            .unwrap();
        assert_eq!(restored.navigation.current(), Route::Settings);
        assert_eq!(restored.focus, Focus::Page);
        assert_eq!(
            restored.settings.focused_setting(),
            Some(Action::ToggleSymbols),
            "the focused setting survives a restart"
        );
        assert_eq!(
            restored.settings.category,
            crate::pages::settings::Category::Interface
        );
        restored.apply(Action::Back);
        assert_eq!(restored.navigation.current(), Route::Session("a".into()));
        assert_eq!(restored.focus, Focus::Transcript);
        assert!(!restored.chrome.details);
        restored.apply(Action::Forward);
        restored.apply(Action::Forward);
        assert_eq!(restored.navigation.current(), Route::Help);
        restored.apply(Action::Back);
        restored.apply(Action::Visit(Route::Host));
        restored.apply(Action::Forward);
        assert_eq!(restored.navigation.current(), Route::Host);

        // Sidebar cursor is a destination, not an index into possibly changed tabs.
        restored.focus = Focus::Navigation;
        restored.sidebar.focus_route(&Route::Session("a".into()));
        let saved = Snapshot::capture(&restored, "root");
        let mut sidebar = app();
        saved.restore(&mut sidebar, false).unwrap();
        assert_eq!(sidebar.focus, Focus::Navigation);
        assert_eq!(
            sidebar.sidebar.focused_route(),
            Some(Route::Session("a".into()))
        );
        sidebar.apply(Action::CloseTab("a".into()));
        Snapshot::capture(&sidebar, "root")
            .validate("root")
            .unwrap();

        for focus in [Focus::Page, Focus::Queue] {
            original.apply(Action::Visit(Route::Session("a".into())));
            original.focus = focus;
            original.chrome.details = true;
            let mut reopened = app();
            Snapshot::capture(&original, "root")
                .restore(&mut reopened, false)
                .unwrap();
            assert_eq!(reopened.focus, Focus::Composer);
            assert!(reopened.chrome.details);
        }
        let mut tabs = app();
        for id in ["a", "b", "a"] {
            tabs.apply(Action::Visit(Route::Session(id.into())));
        }
        let mut reopened = app();
        Snapshot::capture(&tabs, "root")
            .restore(&mut reopened, false)
            .unwrap();
        assert_eq!(
            reopened
                .tabs
                .entries
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(reopened.navigation.current(), Route::Session("a".into()));

        for (pointer, value) in [
            ("/navigation/entries", serde_json::json!([])),
            ("/navigation/cursor", serde_json::json!(128)),
            (
                "/navigation/entries/0",
                serde_json::json!({"page":"session","id":"closed"}),
            ),
            ("/pages/0/1/focus", serde_json::json!("queue")),
        ] {
            let mut invalid = encoded.clone();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(
                serde_json::from_value::<Snapshot>(invalid)
                    .unwrap()
                    .validate("root")
                    .is_err(),
                "{pointer}"
            );
        }
    }
}
