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

//! UI integration tests of the Web Search page against the scripted Host
//! of [`crate::tests`]: the source and the switch (`set_web_search`), the
//! Tavily key through the vault (saved, replaced over a stale read,
//! cleared, never read back), its test, and a live query with its
//! results. Answers follow `decodeCredentialQueryResult`,
//! `decodeSetCredentialResult` (packages/runtime-host/src/protocol/runtime-policy.ts)
//! and `decodeWebSearchExecuteResult` (web-search.ts).

use std::sync::Arc;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{ElementId, TestAppContext};
use serde_json::{Value, json};
use shared::copy::web_search as copy;
use shared::domain_element_id;

use crate::SettingsSection;
use crate::tests::{Harness, ScriptedHost, policy};

fn locator() -> Value {
    json!({"scope": "web_search", "provider": "tavily", "kind": "api_key"})
}

fn status(revision: Option<u64>) -> Value {
    match revision {
        Some(revision) => json!({"locator": locator(), "configured": true, "credentialId": "k1",
                                 "revision": revision, "updatedAt": 1}),
        None => json!({"locator": locator(), "configured": false, "credentialId": null,
                       "revision": null, "updatedAt": null}),
    }
}

fn queried(revision: Option<u64>) -> Value {
    json!({"kind": "status", "status": status(revision)})
}

fn committed(revision: Option<u64>) -> Value {
    json!({"kind": "committed", "vaultRevision": 9, "status": status(revision)})
}

fn policy_with(revision: u64, enabled: bool, provider: &str) -> Value {
    let mut value = policy(revision, "ask");
    value["policy"]["webSearch"] = json!({"enabled": enabled, "defaultProvider": provider});
    value
}

/// Settings on Web Search with the policy and whether a key is saved.
fn open(enabled: bool, provider: &str, key: Option<u64>, cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("runtime.policy.query", Ok(policy_with(3, enabled, provider)));
    // The policy's read of the proxy password takes one too.
    transport.always("credential.vault.query", Ok(queried(key)));
    Harness::open_with_transport(SettingsSection::Search, transport, cx)
}

fn set_web_search(revision: u64, enabled: bool, provider: &str) -> Value {
    json!({"expectedRevision": revision, "operation": {"kind": "set_web_search",
           "value": {"enabled": enabled, "defaultProvider": provider}}})
}

fn row(url: &str, title: &str) -> Value {
    json!({"provider": "tavily", "title": title, "url": url, "snippet": "A snippet.",
           "source": "example.com"})
}

impl Harness {
    fn web_label(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|e| e.label().map(str::to_owned))
        })
    }

    fn present(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> bool {
        let id = id.into();
        self.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    fn state(&self, cx: &mut TestAppContext) -> Option<String> {
        self.web_label(domain_element_id("settings-state", "web-search"), cx)
    }

    fn key_line(&self, cx: &mut TestAppContext) -> Option<String> {
        self.web_label(domain_element_id("settings-status", "web-search-key-action"), cx)
    }

    fn enter(&self, id: &'static str, text: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| {
            window.click(id, cx);
            window.press("cmd-a", cx);
            window.input(text, cx);
        });
    }
}

#[gpui_kit::test]
fn the_tavily_key_goes_to_the_vault_and_is_never_read_back(cx: &mut TestAppContext) {
    let harness = open(false, "tavily", None, cx);
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_NOT_CONFIGURED.en()));
    // The kit does not report a disabled control: a click does nothing.
    let enabled = domain_element_id("settings-toggle", "web-search-enabled");
    harness.click(enabled.clone(), cx);
    assert!(harness.transport.requests("runtime.policy.mutate").is_empty(), "no source to use");
    harness.click("web-search-save-key", cx);
    assert!(harness.transport.requests("credential.vault.set").is_empty(), "nothing typed");
    harness.click("web-search-test-key", cx);
    assert!(harness.transport.requests("web-search.execute").is_empty(), "no key to test");
    assert!(!harness.present("web-search-clear-key", cx));

    harness.enter("web-search-key-field", "tvly-secret", cx);
    harness.transport.reply("credential.vault.query", Ok(queried(None)));
    harness.transport.reply("credential.vault.set", Ok(committed(Some(1))));
    harness.click("web-search-save-key", cx);
    assert_eq!(
        harness.transport.requests("credential.vault.set"),
        [json!({"locator": locator(), "expected": null, "secret": "tvly-secret"})]
    );
    let key = harness.view.read_with(cx, |view, cx| view.web_search().read(cx).key_input().clone());
    assert_eq!(key.read_with(cx, |key, _| key.value()), "", "the field empties once saved");
    assert!(harness.view.read_with(cx, |view, cx| view.web_search().read(cx).key_saved()));
    assert_eq!(
        harness.key_line(cx),
        Some(format!("{}. {}", copy::KEY_SAVED.en(), copy::KEY_SAVED_DETAIL.en()))
    );
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_UNTESTED.en()));

    // Testing the saved key sends no key; what it finds shows as the status.
    harness.transport.reply(
        "web-search.execute",
        Ok(json!({"ok": true, "provider": "tavily", "results": [row("https://a.dev", "A")]})),
    );
    harness.click("web-search-test-key", cx);
    assert_eq!(
        harness.transport.requests("web-search.execute"),
        [json!({"kind": "test", "provider": "tavily"})]
    );
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_VALID_DISABLED.en()));
    assert_eq!(
        harness.key_line(cx),
        Some(format!("{}. Returned 1 result.", copy::CREDENTIAL_VALID.en()))
    );

    // With a key, the switch turns web search on.
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 4})));
    harness.click(enabled, cx);
    assert_eq!(
        harness.transport.requests("runtime.policy.mutate"),
        [set_web_search(3, true, "tavily")]
    );
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_VALID_ENABLED.en()));

    // A typed key is tested in place of the saved one, which keeps its status.
    harness.enter("web-search-key-field", "tvly-bad", cx);
    harness.transport.reply(
        "web-search.execute",
        Ok(json!({"ok": false, "reason": "invalid_credentials", "message": "401"})),
    );
    harness.click("web-search-test-key", cx);
    assert_eq!(
        harness.transport.requests("web-search.execute").last(),
        Some(&json!({"kind": "test", "provider": "tavily", "apiKey": "tvly-bad"}))
    );
    assert_eq!(
        harness.key_line(cx),
        Some(format!("{}. {}", copy::TEST_FAILED.en(), copy::ERROR_INVALID_CREDENTIALS.en()))
    );
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_VALID_ENABLED.en()));

    // A write over a key that changed meanwhile reads it again and retries.
    harness.transport.reply("credential.vault.query", Ok(queried(Some(1))));
    harness.transport.reply(
        "credential.vault.set",
        Ok(json!({"kind": "credential_stale", "expected": null, "actual": null})),
    );
    harness.transport.reply("credential.vault.query", Ok(queried(Some(2))));
    harness.transport.reply("credential.vault.set", Ok(committed(Some(3))));
    harness.click("web-search-save-key", cx);
    let sets = harness.transport.requests("credential.vault.set");
    assert_eq!(sets.len(), 3);
    assert_eq!(sets[1]["expected"], json!({"credentialId": "k1", "revision": 1}));
    assert_eq!(sets[2]["expected"], json!({"credentialId": "k1", "revision": 2}));
    assert_eq!(sets[2]["secret"], "tvly-bad");
    // The key changed, so the test no longer describes it.
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_UNKNOWN_ENABLED.en()));
}

#[gpui_kit::test]
fn clearing_the_key_turns_web_search_off_then_deletes_it(cx: &mut TestAppContext) {
    let harness = open(true, "tavily", Some(4), cx);
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_UNKNOWN_ENABLED.en()));
    let source = harness.web_label("web-search-source", cx);
    assert_eq!(source.as_deref(), Some(copy::SOURCE_SAVED.en()));
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 4})));
    harness.transport.reply("credential.vault.query", Ok(queried(Some(4))));
    harness.transport.reply("credential.vault.delete", Ok(committed(None)));
    harness.click("web-search-clear-key", cx);
    assert_eq!(
        harness.transport.requests("runtime.policy.mutate"),
        [set_web_search(3, false, "tavily")]
    );
    assert_eq!(
        harness.transport.requests("credential.vault.delete"),
        [json!({"expected": {"locator": locator(), "credentialId": "k1", "revision": 4}})]
    );
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_NOT_CONFIGURED.en()));
    assert!(!harness.present("web-search-clear-key", cx));
    assert_eq!(
        harness.key_line(cx),
        Some(format!(
            "{}. {}",
            copy::CREDENTIALS_CLEARED.en(),
            copy::CREDENTIALS_CLEARED_DETAIL.en()
        ))
    );
}

#[gpui_kit::test]
fn a_live_query_shows_web_links_only_and_says_why_it_cannot_run(cx: &mut TestAppContext) {
    let harness = open(false, "tavily", Some(1), cx);
    let blocked = |harness: &Harness, cx: &mut TestAppContext| {
        harness.web_label("web-search-query-blocked", cx)
    };
    assert_eq!(blocked(&harness, cx).as_deref(), Some(copy::DISABLED_REASON.en()));
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 4})));
    harness.click(domain_element_id("settings-toggle", "web-search-enabled"), cx);
    assert_eq!(blocked(&harness, cx).as_deref(), Some(copy::NO_QUERY_REASON.en()));
    harness.click("web-search-search", cx);
    assert!(harness.transport.requests("web-search.execute").is_empty(), "nothing to search");

    harness.enter("web-search-query-field", "  gpui kit  ", cx);
    harness.transport.reply(
        "web-search.execute",
        Ok(json!({"ok": true, "provider": "tavily", "results": [
            row("https://gpui.rs/", "GPUI"), row("javascript:alert(1)", "Bad"),
            row("http://kit.dev/", "Kit")]})),
    );
    harness.click("web-search-search", cx);
    assert_eq!(
        harness.transport.requests("web-search.execute"),
        [json!({"kind": "query", "query": "gpui kit", "limit": 5})]
    );
    let titles = harness.with_window(cx, |window, _| {
        (0..3usize)
            .filter_map(|ix| window.try_find(("web-search-result", ix)))
            .filter_map(|row| row.label().map(str::to_owned))
            .collect::<Vec<_>>()
    });
    assert_eq!(titles, ["GPUI", "Kit"], "a javascript: link is not shown");
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_VALID_ENABLED.en()));

    // Editing the query drops the results that answered the old one.
    harness.enter("web-search-query-field", "rust", cx);
    assert!(!harness.present("web-search-results", cx));
    harness.transport.reply(
        "web-search.execute",
        Ok(json!({"ok": false, "reason": "rate_limited", "message": "429"})),
    );
    harness.with_window(cx, |window, cx| {
        window.click("web-search-query-field", cx);
        window.press("enter", cx);
    });
    let line = harness.web_label(domain_element_id("settings-status", "web-search-query"), cx);
    assert_eq!(
        line,
        Some(copy::query_failed(shared::copy::Locale::English, copy::ERROR_RATE_LIMITED.en()))
    );
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_RATE_LIMITED.en()));
}

#[gpui_kit::test]
fn the_models_own_search_needs_no_key(cx: &mut TestAppContext) {
    let harness = open(false, "model", None, cx);
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_MODEL_DISABLED.en()));
    assert!(harness.present(domain_element_id("settings-row", "web-search-model"), cx));
    assert!(!harness.present("web-search-key-field", cx), "no second key");
    assert!(!harness.present("web-search-query-field", cx), "no search from settings");
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 4})));
    harness.click(domain_element_id("settings-toggle", "web-search-enabled"), cx);
    assert_eq!(harness.state(cx).as_deref(), Some(copy::STATUS_MODEL_ENABLED.en()));
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 5})));
    harness.choose("web-search-provider", &["down"], cx);
    assert_eq!(
        harness.transport.requests("runtime.policy.mutate"),
        [set_web_search(3, true, "model"), set_web_search(4, true, "tavily")]
    );
    assert!(harness.present("web-search-key-field", cx));
}
