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

//! UI integration tests of the Daily Review page against the scripted Host,
//! whose answers follow `decodeDailyReviewQueryResult` and
//! `decodeDailyReviewMutateResult`
//! (packages/runtime-host/src/protocol/daily-review.ts).

use std::sync::Arc;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{ElementId, Entity, TestAppContext};
use serde_json::{Value, json};
use shared::copy::system as copy;
use shared::domain_element_id;
use workspace::HostRequestError;

use crate::SettingsSection;
use crate::tests::{Harness, ScriptedHost, header, nav, policy, reveal};

/// `daily-review.query` `config` at `revision`.
fn config(revision: u64, enabled: bool, time: &str, model: &str) -> Value {
    json!({"kind": "config", "revision": revision,
           "config": {"enabled": enabled, "executeTime": time, "modelKey": model}})
}

fn committed(revision: u64, enabled: bool, time: &str, model: &str) -> Value {
    json!({"kind": "config_committed", "revision": revision,
           "config": {"enabled": enabled, "executeTime": time, "modelKey": model}})
}

fn update(revision: u64, enabled: bool, time: &str, model: &str) -> Value {
    json!({"kind": "update_config", "expectedRevision": revision,
           "config": {"enabled": enabled, "executeTime": time, "modelKey": model}})
}

fn catalog_entry(index: u64, item: u64, id: &str, name: Option<&str>, chat: bool) -> Value {
    let mut entry = json!({"id": id, "canUseAsChatDefault": chat, "isDefault": item == 0,
                           "supportsVision": false, "thinkingLevels": []});
    if let Some(name) = name {
        entry["displayName"] = json!(name);
    }
    json!({"kind": "catalog_entry", "connectionIndex": index, "itemIndex": item, "entry": entry})
}

fn enabled_model(index: u64, item: u64, id: &str) -> Value {
    json!({"kind": "enabled_model_id", "connectionIndex": index, "itemIndex": item,
           "modelId": id})
}

/// Two DeepSeek connections that both offer "DeepSeek V4" (so each is named
/// by its provider and slug), a model one of them has not enabled, one it
/// cannot chat with, and a disabled connection whose models are not offered.
fn catalog() -> Value {
    json!({"kind": "page", "revision": 4, "defaultTarget": null, "connectionCount": 3,
           "nextCursor": null, "items": [
        header(0, "c-a", "deepseek-a", "DeepSeek A", "deepseek", true),
        enabled_model(0, 0, "deepseek-v4"),
        enabled_model(0, 1, "deepseek-embed"),
        catalog_entry(0, 0, "deepseek-v4", Some("DeepSeek V4"), true),
        catalog_entry(0, 1, "deepseek-embed", None, false),
        catalog_entry(0, 2, "deepseek-old", None, true),
        header(1, "c-b", "deepseek-b", "DeepSeek B", "deepseek", true),
        enabled_model(1, 0, "deepseek-v4"),
        catalog_entry(1, 0, "deepseek-v4", Some("DeepSeek V4"), true),
        header(2, "c-off", "off", "Off", "deepseek", false),
        enabled_model(2, 0, "deepseek-v9"),
        catalog_entry(2, 0, "deepseek-v9", None, true),
    ]})
}

/// Settings on Daily Review with [`catalog`] as the connections; `transport`
/// has the first `daily-review.query` scripted.
fn open(transport: Arc<ScriptedHost>, cx: &mut TestAppContext) -> Harness {
    transport.reply("runtime.policy.query", Ok(policy(3, "ask")));
    transport.reply("connection.catalog.query", Ok(catalog()));
    Harness::open_with_transport(SettingsSection::DailyReview, transport, cx)
}

fn toggle(key: &str) -> ElementId {
    domain_element_id("settings-toggle", key)
}

fn status(key: &str) -> ElementId {
    domain_element_id("settings-status", key)
}

impl Harness {
    fn time_field(&self, cx: &mut TestAppContext) -> Entity<crate::rows::TextSetting> {
        self.view.read_with(cx, |view, cx| view.daily_review().read(cx).time_field().clone())
    }

    fn enter_time(&self, text: &str, cx: &mut TestAppContext) {
        let field = self.time_field(cx);
        let id: ElementId = ("settings-text", field.entity_id()).into();
        self.with_window(cx, |window, cx| {
            reveal(window, &id, cx);
            window.click(id, cx);
            window.press("cmd-a", cx);
            window.input(text, cx);
            window.press("enter", cx);
        });
    }

    fn line(&self, key: &str, cx: &mut TestAppContext) -> Option<String> {
        self.with_window(cx, |window, _| {
            window.try_find(status(key)).and_then(|line| line.label().map(str::to_owned))
        })
    }
}

#[gpui_kit::test]
fn the_page_reads_the_settings_only_when_shown_and_offers_the_catalogs_models(
    cx: &mut TestAppContext,
) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("runtime.policy.query", Ok(policy(3, "ask")));
    transport.reply("connection.catalog.query", Ok(catalog()));
    let harness = Harness::open_with_transport(SettingsSection::General, transport.clone(), cx);
    assert!(transport.requests("daily-review.query").is_empty(), "not read before it shows");

    transport.reply("daily-review.query", Ok(config(2, true, "08:00", "")));
    harness.click(nav("daily-review"), cx);
    assert_eq!(transport.requests("daily-review.query"), [json!({"kind": "config"})]);
    harness.with_window(cx, |window, _| {
        let heading = domain_element_id("settings-group-title", "daily-review-schedule");
        assert_eq!(window.find(heading).label(), Some(copy::REVIEW_SCHEDULE.en()));
        assert_eq!(window.find(toggle("daily-review-enabled")).checked(), Some(true));
        let analysis = domain_element_id("settings-group-title", "daily-review-analysis");
        assert_eq!(window.find(analysis).label(), Some(copy::REVIEW_ANALYSIS.en()));
    });
    assert_eq!(harness.chosen("daily-review-model", cx).as_deref(), Some("Follow task default"));
    let time = harness.time_field(cx);
    assert_eq!(time.read_with(cx, |field, _| field.committed().to_string()), "08:00");
    let choices = harness.view.read_with(cx, |view, cx| view.daily_review().read(cx).choices(cx));
    assert_eq!(
        choices,
        [
            ("".to_owned(), "Follow task default".to_owned()),
            (
                "deepseek-a::deepseek-v4".to_owned(),
                "DeepSeek V4 · DeepSeek · deepseek-a".to_owned()
            ),
            (
                "deepseek-b::deepseek-v4".to_owned(),
                "DeepSeek V4 · DeepSeek · deepseek-b".to_owned()
            ),
        ],
        "enabled chat models of enabled connections, same names told apart by source"
    );
}

#[gpui_kit::test]
fn a_saved_model_no_connection_offers_is_kept_and_marked_unavailable(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("daily-review.query", Ok(config(2, false, "08:00", "gone::m7")));
    let harness = open(transport, cx);
    assert_eq!(
        harness.chosen("daily-review-model", cx).as_deref(),
        Some("m7 · gone · Currently unavailable")
    );
}

#[gpui_kit::test]
fn the_switch_saves_on_the_settings_read_again_retrying_a_conflict(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("daily-review.query", Ok(config(2, false, "08:00", "")));
    let harness = open(transport.clone(), cx);
    // The switch keeps the Host's value until the Host answers, and Back to
    // app waits for it.
    transport.reply("daily-review.query", Ok(config(2, false, "08:00", "")));
    let answer = transport.hold("daily-review.mutate");
    harness.click(toggle("daily-review-enabled"), cx);
    assert!(harness.view.read_with(cx, |view, cx| view.is_busy(cx)));
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(toggle("daily-review-enabled")).checked(), Some(false));
    });
    answer.try_send(Ok(committed(3, true, "08:00", ""))).expect("answer");
    cx.run_until_parked();
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(toggle("daily-review-enabled")).checked(), Some(true));
    });
    assert!(!harness.view.read_with(cx, |view, cx| view.is_busy(cx)));

    // The change is laid on the settings read just before it; a conflict
    // reads them once more and keeps what another client saved.
    transport.reply("daily-review.query", Ok(config(3, true, "08:00", "")));
    transport.reply(
        "daily-review.mutate",
        Ok(json!({"kind": "revision_conflict", "expectedRevision": 3, "actualRevision": 4})),
    );
    transport.reply("daily-review.query", Ok(config(4, true, "09:15", "")));
    transport.reply("daily-review.mutate", Ok(committed(5, false, "09:15", "")));
    harness.click(toggle("daily-review-enabled"), cx);
    assert_eq!(
        transport.requests("daily-review.mutate"),
        [
            update(2, true, "08:00", ""),
            update(3, false, "08:00", ""),
            update(4, false, "09:15", "")
        ]
    );
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(toggle("daily-review-enabled")).checked(), Some(false));
    });
    let time = harness.time_field(cx);
    assert_eq!(
        time.read_with(cx, |field, _| field.committed().to_string()),
        "09:15",
        "the settings the Host now has"
    );

    // Settings that keep changing give up after three tries and say so.
    for revision in 5..8 {
        transport.reply("daily-review.query", Ok(config(revision, false, "09:15", "")));
        transport.reply(
            "daily-review.mutate",
            Ok(json!({"kind": "revision_conflict", "expectedRevision": revision,
                      "actualRevision": revision + 1})),
        );
    }
    harness.click(toggle("daily-review-enabled"), cx);
    assert_eq!(transport.requests("daily-review.mutate").len(), 6);
    let line = harness.line("daily-review-enabled", cx).expect("says why");
    assert!(line.starts_with(copy::REVIEW_SAVE_FAILED.en()), "{line}");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(toggle("daily-review-enabled")).checked(), Some(false));
    });
}

#[gpui_kit::test]
fn the_run_time_saves_only_a_24_hour_time(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("daily-review.query", Ok(config(2, true, "08:00", "")));
    let harness = open(transport.clone(), cx);
    harness.enter_time("8:00", cx);
    assert_eq!(
        harness.line("daily-review-time", cx).as_deref(),
        Some(copy::REVIEW_TIME_INVALID.en())
    );
    assert!(transport.requests("daily-review.mutate").is_empty(), "nothing is sent");

    transport.reply("daily-review.query", Ok(config(2, true, "08:00", "")));
    transport.reply("daily-review.mutate", Ok(committed(3, true, "21:30", "")));
    harness.enter_time("21:30", cx);
    assert_eq!(harness.line("daily-review-time", cx), None, "typing clears the complaint");
    assert_eq!(transport.requests("daily-review.mutate"), [update(2, true, "21:30", "")]);

    // A refusal puts the Host's time back and says why.
    transport.reply("daily-review.query", Ok(config(3, true, "21:30", "")));
    transport.reply(
        "daily-review.mutate",
        Err(HostRequestError::Operation {
            operation: "daily-review.mutate",
            code: host_protocol::HostOperationErrorCode::PersistenceFailed,
            message: "disk full".into(),
        }),
    );
    harness.enter_time("06:45", cx);
    assert!(
        harness
            .line("daily-review-time", cx)
            .is_some_and(|line| line.starts_with(copy::REVIEW_SAVE_FAILED.en()))
    );
    let time = harness.time_field(cx);
    assert_eq!(time.read_with(cx, |field, _| field.committed().to_string()), "21:30");
}

#[gpui_kit::test]
fn choosing_a_model_saves_its_key_and_follow_default_saves_none(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("daily-review.query", Ok(config(2, true, "08:00", "")));
    let harness = open(transport.clone(), cx);
    transport.reply("daily-review.query", Ok(config(2, true, "08:00", "")));
    transport
        .reply("daily-review.mutate", Ok(committed(3, true, "08:00", "deepseek-b::deepseek-v4")));
    harness.choose("daily-review-model", &["down", "down"], cx);
    assert_eq!(
        transport.requests("daily-review.mutate"),
        [update(2, true, "08:00", "deepseek-b::deepseek-v4")]
    );
    assert_eq!(
        harness.chosen("daily-review-model", cx).as_deref(),
        Some("DeepSeek V4 · DeepSeek · deepseek-b")
    );
    transport.reply("daily-review.query", Ok(config(3, true, "08:00", "deepseek-b::deepseek-v4")));
    transport.reply("daily-review.mutate", Ok(committed(4, true, "08:00", "")));
    harness.choose("daily-review-model", &["up", "up"], cx);
    assert_eq!(transport.requests("daily-review.mutate")[1], update(3, true, "08:00", ""));
    assert_eq!(harness.chosen("daily-review-model", cx).as_deref(), Some("Follow task default"));
}

#[gpui_kit::test]
fn a_failed_read_says_why_and_retry_reads_again(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("daily-review.query", Err(HostRequestError::Transport("closed".into())));
    let harness = open(transport.clone(), cx);
    let page_line = harness.line("daily-review", cx).expect("the page says why");
    assert!(page_line.starts_with(copy::REVIEW_LOAD_FAILED.en()), "{page_line}");
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(toggle("daily-review-enabled")).is_none());
    });
    transport.reply("daily-review.query", Ok(config(2, true, "08:00", "")));
    harness.click("daily-review-retry", cx);
    assert_eq!(harness.line("daily-review", cx), None);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(toggle("daily-review-enabled")).checked(), Some(true));
    });
}
