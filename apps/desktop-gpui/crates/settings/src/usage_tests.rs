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

//! UI integration tests of the Usage page against the scripted Host, whose
//! answers follow `decodeUsageScreenResult`
//! (packages/runtime-host/src/protocol/usage-screen.ts).

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{ElementId, TestAppContext};
use serde_json::{Value, json};
use shared::copy::usage as copy;
use shared::domain_element_id;
use workspace::HostRequestError;

use crate::tests::{Harness, ScriptedHost, policy};
use crate::{AppPreferences, OpenTask, SettingsSection, UsageRange, UsageStatus, UsageTab};

fn log(id: &str, session: Option<&str>) -> Value {
    let mut row = json!({"id": id, "ts": 1_790_000_000_000.0_f64, "kind": "model",
        "provider": "openai", "model": "gpt-5", "inputTokens": 1200, "outputTokens": 300,
        "costUsd": 0.25, "latencyMs": 1834.0, "status": "success"});
    if let Some(session) = session {
        row["sessionId"] = json!(session);
        row["sessionName"] = json!("Refactor the parser");
    }
    row
}

/// A screen of `total` activity rows with `logs` on its first page.
fn screen(total: u64, logs: Vec<Value>, next: Option<&str>) -> Value {
    json!({"kind": "screen", "screen": {
        "revision": "r1", "queryIdentity": "q1", "nextCursor": next,
        // The Host echoes the query it answered; the page does not check.
        "query": {"range": {"from": 0.0, "to": 1.0}, "search": "", "status": "all"},
        "activityTotal": total, "logs": logs,
        "summary": {"totalRequests": 1, "totalCostUsd": 0.25, "totalTokens": 1500,
                    "inputTokens": 1200, "outputTokens": 300, "cacheTokens": 1200,
                    "cacheMiss": 200, "cacheRead": 1000, "cacheCreation": 0, "reasoning": 40},
        "byProvider": [{"provider": "openai", "requests": 1, "tokens": 1500, "costUsd": 0.25}],
        "byModel": [{"model": "gpt-5", "requests": 1, "tokens": 1500, "costUsd": 0.25}],
        "byTool": [], "pricing": [],
        "provenance": {"coverage": {"attempts": 1, "pricedAttempts": 1, "unpricedAttempts": 0,
            "usageReportedAttempts": 1, "usagePartialAttempts": 0, "usageMissingAttempts": 0},
            "legacyRecords": 0, "unreadableRecords": 0, "pendingRepairs": 0}
    }})
}

fn open(first: Value, cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("runtime.policy.query", Ok(policy(3, "ask")));
    transport.reply("usage.query", Ok(first));
    Harness::open_with_transport(SettingsSection::Usage, transport, cx)
}

fn figure(key: &str) -> ElementId {
    domain_element_id("usage-figure", key)
}

impl Harness {
    fn usage_queries(&self) -> Vec<Value> {
        self.transport.requests("usage.query")
    }

    fn label_of(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|element| element.label().map(str::to_owned))
        })
    }

    fn usage_page(&self, cx: &mut TestAppContext) -> usize {
        self.view.read_with(cx, |view, cx| view.usage().read(cx).page())
    }
}

/// The span of a screen request's range, in milliseconds.
fn span(query: &Value) -> f64 {
    let range = &query["query"]["range"];
    range["to"].as_f64().expect("to") - range["from"].as_f64().expect("from")
}

#[gpui_kit::test]
fn the_page_reads_the_screen_when_shown_and_shows_its_figures(cx: &mut TestAppContext) {
    let harness = open(screen(1, vec![log("m1", Some("s1"))], None), cx);
    let queries = harness.usage_queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0]["kind"], "screen");
    assert_eq!(span(&queries[0]), 86_400_000., "24 hours by default");
    assert_eq!(queries[0]["query"]["search"], "");
    assert_eq!(queries[0]["query"]["status"], "all");
    assert_eq!(harness.label_of(figure("requests"), cx).as_deref(), Some("Model calls: 1"));
    assert_eq!(harness.label_of(figure("cost"), cx).as_deref(), Some("Total cost: $0.25"));
    assert_eq!(harness.label_of(figure("tokens"), cx).as_deref(), Some("Total tokens: 1.5K"));
    assert_eq!(harness.label_of(figure("cache"), cx).as_deref(), Some("Cache tokens: 1.2K"));
    // One row of cards, top-aligned and of one height, though the first
    // has no detail line.
    harness.with_window(cx, |window, _| {
        let first = window.find(figure("requests")).bounds();
        for key in ["cost", "tokens", "cache"] {
            let card = window.find(figure(key)).bounds();
            assert_eq!(card.top(), first.top(), "{key}: {card:?} vs {first:?}");
            assert_eq!(card.size.height, first.size.height, "{key}");
        }
        // `.settingsUsageSummary`: 6 between the cards.
        let cost = window.find(figure("cost")).bounds();
        assert_eq!(cost.left() - first.right(), gpui_kit::px(6.));
    });

    // The activity log shows its rows once the detailed records are on,
    // which the preferences keep.
    let summary_only = domain_element_id("settings-status", "usage-summary-only");
    assert_eq!(
        harness.label_of(summary_only.clone(), cx).as_deref(),
        Some(copy::SUMMARY_ONLY.en())
    );
    harness.click("usage-show-details", cx);
    assert!(harness.label_of(summary_only, cx).is_none());
    assert!(cx.update(|cx| AppPreferences::current(cx).usage.show_details));
    harness.with_window(cx, |window, _| {
        assert!(window.find(domain_element_id("usage-requests", "m1")).visible());
        assert_eq!(window.find("usage-record-count").label(), Some("1 record"));
        // The filter bar holds all its controls, and the table starts below
        // it: nothing of the bar lies over the first record.
        let bar = window.find("usage-filters").bounds();
        let first = window.find(domain_element_id("usage-requests", "m1")).bounds();
        for id in ["usage-filter", "usage-status", "usage-details", "usage-record-count"] {
            let control = window.find(id).bounds();
            assert!(bar.contains(&control.center()), "{id} {control:?} in the bar {bar:?}");
            assert!(control.bottom() <= first.top(), "{id} {control:?} above {first:?}");
        }
    });

    // Another tab shows its breakdown and is remembered.
    harness
        .with_window(cx, |window, cx| window.within("usage-tabs").click(ElementId::Integer(1), cx));
    assert_eq!(cx.update(|cx| AppPreferences::current(cx).usage.active_tab), UsageTab::Providers);
    harness.with_window(cx, |window, _| {
        assert!(window.find(domain_element_id("usage-providers", "openai")).visible());
    });
    harness
        .with_window(cx, |window, cx| window.within("usage-tabs").click(ElementId::Integer(3), cx));
    assert_eq!(harness.label_of("usage-tools-empty", cx).as_deref(), Some(copy::TOOL_EMPTY.en()));
}

#[gpui_kit::test]
fn the_range_resolves_anew_and_a_filter_keeps_its_bounds(cx: &mut TestAppContext) {
    let harness = open(screen(0, vec![], None), cx);
    harness.click("usage-show-details", cx);
    harness.transport.reply("usage.query", Ok(screen(0, vec![], None)));
    harness.click(domain_element_id("usage-range", "7d"), cx);
    assert_eq!(span(&harness.usage_queries()[1]), 7. * 86_400_000.);
    assert_eq!(cx.update(|cx| AppPreferences::current(cx).usage.range), UsageRange::Week);

    // The status filter reads the screen again on the same bounds.
    harness.transport.reply("usage.query", Ok(screen(0, vec![], None)));
    harness.with_window(cx, |window, cx| window.click("usage-status", cx));
    // The menu opens on the chosen row, All statuses; Error is two below.
    harness.with_window(cx, |window, cx| {
        for _ in 0..2 {
            window.press("down", cx);
        }
        window.press("enter", cx);
    });
    let queries = harness.usage_queries();
    assert_eq!(queries[2]["query"]["status"], "error");
    assert_eq!(queries[2]["query"]["range"], queries[1]["query"]["range"], "the same bounds");
    assert_eq!(cx.update(|cx| AppPreferences::current(cx).usage.status), UsageStatus::Error);

    // The text filter waits for the typing to stop, then sends it trimmed
    // and lowercased.
    harness.transport.reply("usage.query", Ok(screen(0, vec![], None)));
    harness.with_window(cx, |window, cx| {
        window.click("usage-filter", cx);
        window.input(" GPT", cx);
    });
    assert_eq!(harness.usage_queries().len(), 3, "not yet");
    cx.executor().advance_clock(Duration::from_millis(300));
    cx.run_until_parked();
    let queries = harness.usage_queries();
    assert_eq!(queries.len(), 4);
    assert_eq!(queries[3]["query"]["search"], "gpt");
    assert_eq!(queries[3]["query"]["range"], queries[1]["query"]["range"]);
    assert_eq!(
        harness.label_of("usage-requests-empty", cx).as_deref(),
        Some(copy::FILTERED_EMPTY.en())
    );

    // Clear filters empties both and reads again; Refresh resolves the
    // range anew.
    harness.transport.reply("usage.query", Ok(screen(0, vec![], None)));
    harness.click("usage-clear-filters", cx);
    let queries = harness.usage_queries();
    assert_eq!(queries[4]["query"]["search"], "");
    assert_eq!(queries[4]["query"]["status"], "all");
    harness.transport.reply("usage.query", Ok(screen(0, vec![], None)));
    harness.click("usage-refresh", cx);
    let queries = harness.usage_queries();
    assert_eq!(queries.len(), 6);
    assert!(
        queries[5]["query"]["range"]["to"].as_f64() >= queries[4]["query"]["range"]["to"].as_f64()
    );
}

#[gpui_kit::test]
fn a_page_past_the_ones_read_loads_the_continuation_it_needs(cx: &mut TestAppContext) {
    let logs: Vec<Value> = (0..100).map(|ix| log(&format!("m{ix}"), None)).collect();
    let harness = open(screen(130, logs, Some("c1")), cx);
    harness.click("usage-show-details", cx);
    harness.with_window(cx, |window, _| {
        assert!(window.find(domain_element_id("usage-requests", "m0")).visible());
        assert!(window.try_find(domain_element_id("usage-requests", "m50")).is_none());
    });
    // Page 2 is read already: no request.
    harness.click(domain_element_id("usage-page", "2"), cx);
    assert_eq!(harness.usage_page(cx), 2);
    assert_eq!(harness.usage_queries().len(), 1);
    // Page 3 needs the continuation.
    let rest: Vec<Value> = (100..130).map(|ix| log(&format!("m{ix}"), None)).collect();
    harness.transport.reply(
        "usage.query",
        Ok(json!({"kind": "activity", "page": {
        "revision": "r1", "queryIdentity": "q1", "logs": rest, "nextCursor": null}})),
    );
    harness.click(domain_element_id("usage-page", "3"), cx);
    let continuation = &harness.usage_queries()[1];
    assert_eq!(continuation["kind"], "activity");
    assert_eq!(continuation["cursor"], "c1");
    assert_eq!(continuation["revision"], "r1");
    assert_eq!(continuation["queryIdentity"], "q1");
    assert_eq!(harness.usage_page(cx), 3);
    harness.with_window(cx, |window, _| {
        assert!(window.find(domain_element_id("usage-requests", "m129")).visible());
    });
}

#[gpui_kit::test]
fn a_moved_screen_asks_for_refresh_and_keeps_the_rows(cx: &mut TestAppContext) {
    let logs: Vec<Value> = (0..100).map(|ix| log(&format!("m{ix}"), None)).collect();
    let harness = open(screen(130, logs, Some("c1")), cx);
    harness.click("usage-show-details", cx);
    harness.transport.reply("usage.query", Ok(json!({"kind": "revision_changed"})));
    harness.click(domain_element_id("usage-page", "3"), cx);
    let stale = domain_element_id("settings-status", "usage-stale");
    let line = harness.label_of(stale.clone(), cx).expect("asks for a refresh");
    assert!(line.starts_with(copy::USAGE_STALE_TITLE.en()), "{line}");
    assert_eq!(harness.usage_page(cx), 1);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(domain_element_id("usage-requests", "m0")).is_some(), "kept");
    });
    harness.transport.reply("usage.query", Ok(screen(1, vec![log("n1", None)], None)));
    harness.click("usage-stale-refresh", cx);
    assert_eq!(harness.usage_queries()[2]["kind"], "screen");
    assert!(harness.label_of(stale, cx).is_none());
}

#[gpui_kit::test]
fn failures_say_why_and_keep_the_last_screen(cx: &mut TestAppContext) {
    let harness = open(json!({"kind": "screen_response_too_large", "section": "screen"}), cx);
    let failed = domain_element_id("settings-status", "usage-failed");
    let line = harness.label_of(failed.clone(), cx).expect("says why");
    assert_eq!(line, format!("{}. {}", copy::USAGE_LOAD_FAILED.en(), copy::USAGE_CAPACITY.en()));
    harness.transport.reply("usage.query", Ok(screen(1, vec![log("m1", None)], None)));
    harness.click("usage-refresh", cx);
    assert!(harness.label_of(failed.clone(), cx).is_none());
    harness.transport.reply("usage.query", Err(HostRequestError::Transport("closed".into())));
    harness.click("usage-refresh", cx);
    let line = harness.label_of(failed, cx).expect("says why");
    assert!(line.ends_with(copy::USAGE_RETAINED.en()), "{line}");
    assert_eq!(harness.label_of(figure("requests"), cx).as_deref(), Some("Model calls: 1"));
}

#[gpui_kit::test]
fn unread_or_pending_records_say_the_figures_may_be_low(cx: &mut TestAppContext) {
    let mut first = screen(0, vec![], None);
    first["screen"]["provenance"]["pendingRepairs"] = json!(2);
    first["screen"]["provenance"]["coverage"]["pricedAttempts"] = json!(0);
    first["screen"]["summary"]["totalCostUsd"] = json!(0.0);
    let harness = open(first, cx);
    let line = harness.label_of(domain_element_id("settings-status", "usage-incomplete"), cx);
    assert!(line.is_some_and(|line| line.starts_with(copy::INCOMPLETE_TITLE.en())));
    assert_eq!(
        harness.label_of(figure("cost"), cx).as_deref(),
        Some("Total cost: Cost unavailable"),
        "nothing priced"
    );
}

#[gpui_kit::test]
fn a_rows_task_opens_it(cx: &mut TestAppContext) {
    let harness = open(screen(1, vec![log("m1", Some("s1"))], None), cx);
    harness.click("usage-show-details", cx);
    let opened = Rc::new(RefCell::new(Vec::new()));
    let recorded = opened.clone();
    cx.update(|cx| {
        cx.subscribe(&harness.view, move |_, event: &OpenTask, _| {
            recorded.borrow_mut().push(event.session_id.to_string());
        })
        .detach();
    });
    assert_eq!(
        harness.label_of(domain_element_id("usage-open-task", "m1"), cx).as_deref(),
        Some("Open session “Refactor the parser”")
    );
    harness.click(domain_element_id("usage-open-task", "m1"), cx);
    assert_eq!(*opened.borrow(), ["s1"]);
}

#[gpui_kit::test]
fn command_f_focuses_the_filter_while_the_records_show(cx: &mut TestAppContext) {
    let harness = open(screen(1, vec![log("m1", Some("s1"))], None), cx);
    // The summary alone has no filter: the section search.
    let search = harness.view.read_with(cx, |view, cx| {
        assert!(view.usage().read(cx).search_field(cx).is_none());
        view.section_search().clone()
    });
    crate::tests::command_f_focuses(&harness, &search, cx);
    harness.click("usage-show-details", cx);
    harness.with_window(cx, |window, _| assert!(window.try_find("usage-filter").is_some()));
    let filter = harness.view.read_with(cx, |view, cx| view.usage().read(cx).search_field(cx));
    crate::tests::command_f_focuses(&harness, &filter.expect("the filter shows"), cx);
}
