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

//! UI integration tests of the Health page against the scripted Host: the
//! connection catalog as `connection.catalog.query` pages it
//! (packages/runtime-host/src/protocol/connection-catalog.ts) and the last
//! model call as `usage.query` logs answer it (usage-pricing.ts).

use std::sync::Arc;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{ElementId, TestAppContext};
use serde_json::{Value, json};
use shared::copy::health as copy;
use shared::domain_element_id;
use workspace::HostRequestError;

use crate::tests::{Harness, ScriptedHost, header, policy};
use crate::{HealthStatus, SettingsSection};

/// The default connection (verified), a disabled one, and one whose test
/// failed.
fn catalog() -> Value {
    let mut local = header(0, "c-local", "local", "Local", "custom:openai-chat", true);
    local["lastTest"] = json!({"status": "verified", "checkedAt": "2026-09-28T10:00:00.000Z"});
    let mut relay = header(2, "c-relay", "relay", "Relay", "custom:openai-chat", true);
    relay["lastTest"] = json!({"status": "error", "checkedAt": "2026-09-28T10:00:00.000Z",
                               "errorClass": "auth"});
    json!({"kind": "page", "revision": 3,
           "defaultTarget": {"connectionId": "c-local", "modelId": "m1"},
           "connectionCount": 3, "nextCursor": null, "items": [
        local,
        {"kind": "enabled_model_id", "connectionIndex": 0, "itemIndex": 0, "modelId": "m1"},
        header(1, "c-off", "off", "Off", "deepseek", false),
        relay,
        {"kind": "enabled_model_id", "connectionIndex": 2, "itemIndex": 0, "modelId": "m2"},
    ]})
}

fn logs(status: &str) -> Value {
    json!({"kind": "logs", "source": "llm", "offset": 0, "total": 1, "nextOffset": null,
        "rows": [{"source": "llm", "id": "p1", "ts": 1.0, "connectionSlug": "local",
            "providerId": "custom", "modelId": "m1", "inputTokens": 1, "outputTokens": 1,
            "cacheMissTokens": 1, "cacheReadTokens": 0, "cacheWriteTokens": 0,
            "reasoningTokens": 0, "totalTokens": 2, "latencyMs": 640.0, "status": status}],
        "provenance": {"coverage": {"attempts": 1, "pricedAttempts": 0, "unpricedAttempts": 1,
            "usageReportedAttempts": 1, "usagePartialAttempts": 0, "usageMissingAttempts": 0},
            "legacyRecords": 0, "unreadableRecords": 0, "pendingRepairs": 0}})
}

fn open(transport: Arc<ScriptedHost>, cx: &mut TestAppContext) -> Harness {
    transport.reply("runtime.policy.query", Ok(policy(3, "ask")));
    Harness::open_with_transport(SettingsSection::Health, transport, cx)
}

fn signal(id: &str) -> ElementId {
    domain_element_id("health-signal", id)
}

impl Harness {
    fn health_statuses(&self, cx: &mut TestAppContext) -> Vec<(String, HealthStatus)> {
        self.view.read_with(cx, |view, cx| {
            let page = view.health().read(cx);
            page.signals().iter().map(|s| (s.id().to_owned(), s.status())).collect()
        })
    }
}

#[gpui_kit::test]
fn the_page_reads_the_connections_and_the_default_ones_last_run(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    // The page reads the catalog itself, every time.
    transport.always("connection.catalog.query", Ok(catalog()));
    transport.reply("usage.query", Ok(logs("success")));
    let harness = open(transport.clone(), cx);
    assert_eq!(
        transport.requests("usage.query"),
        [json!({"kind": "logs", "source": "llm", "offset": 0, "limit": 1,
                "query": {"range": "all", "connectionSlug": "local", "modelId": "m1"}})]
    );
    assert_eq!(
        harness.health_statuses(cx),
        [
            ("connection:local".to_owned(), HealthStatus::Ok),
            ("connection:local:runtime".to_owned(), HealthStatus::Ok),
            ("connection:off".to_owned(), HealthStatus::Info),
            ("connection:relay".to_owned(), HealthStatus::Warning),
        ]
    );
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find(signal("connection:local:runtime")).label(),
            Some("Local runtime, The latest send completed., Healthy")
        );
        assert_eq!(
            window.find(domain_element_id("settings-status", "health-blockers")).label(),
            Some("Across all health signals, 1 of 4 blocks sending")
        );
        for layer in ["configuration", "validation", "runtime-probe"] {
            // Each layer is a sub-header among the rows of one section, not
            // a group of its own (Desktop's `settingsRowsSubheading`).
            let heading = window.find(domain_element_id("health-layer", layer));
            assert!(heading.visible(), "{layer}");
            assert_eq!(heading.role(), Some(gpui_kit::Role::Heading), "{layer}");
            assert!(window.try_find(domain_element_id("settings-group-title", layer)).is_none());
        }
        assert!(
            window.try_find(domain_element_id("settings-group-title", "health-signals")).is_none()
        );
        // A count is Desktop's summary filter: its words at 14/20, no dot,
        // the first on the column's edge.
        let error = window.find(domain_element_id("health-count", "error"));
        assert_eq!(error.label(), Some("Error 0"));
        assert_eq!(error.bounds().size.height, gpui_kit::px(20.));
        assert!(
            window.try_find(domain_element_id("settings-state", "health-count-error")).is_none()
        );
        let first = window.find(domain_element_id("health-count", "ok")).bounds();
        let intro = window.find(domain_element_id("settings-group-description", "health-summary"));
        assert_eq!(first.left(), intro.bounds().left());
        // Desktop's first group has no heading: its line is the page's
        // intro, at the body size, not a caption under a missing title.
        let group = |id| domain_element_id(id, "health-summary");
        assert!(window.try_find(group("settings-group-title")).is_none());
        let intro = window.find(group("settings-group-description"));
        assert_eq!(intro.label(), Some(shared::copy::health::HEALTH_SUBTITLE.en()));
        assert!(intro.bounds().size.height >= gpui_kit::px(20.), "{:?}", intro.bounds());
        assert_eq!(
            window.find(domain_element_id("health-filter", "error")).label(),
            Some("Show only error health signals, 0")
        );
    });

    // The status filter shows one status; pressing it again shows all.
    harness.click(domain_element_id("health-filter", "warning"), cx);
    harness.with_window(cx, |window, _| {
        assert!(window.find(signal("connection:relay")).visible());
        assert!(window.try_find(signal("connection:local")).is_none());
        assert!(window.try_find(domain_element_id("health-layer", "runtime-probe")).is_none());
    });
    harness.click(domain_element_id("health-filter", "warning"), cx);
    harness.with_window(cx, |window, _| {
        assert!(window.find(signal("connection:local")).visible());
    });
}

#[gpui_kit::test]
fn refresh_reads_again_and_a_failure_keeps_the_last_snapshot(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    transport.always("connection.catalog.query", Ok(catalog()));
    transport.reply(
        "usage.query",
        Ok(json!({"kind": "logs", "source": "llm", "offset": 0,
        "total": 0, "nextOffset": null, "rows": []})),
    );
    let harness = open(transport.clone(), cx);
    assert_eq!(
        harness.health_statuses(cx)[1],
        ("connection:local:runtime".to_owned(), HealthStatus::Unknown),
        "no run yet"
    );
    transport.reply("usage.query", Ok(logs("error")));
    harness.click("health-refresh", cx);
    assert_eq!(
        harness.health_statuses(cx)[1],
        ("connection:local:runtime".to_owned(), HealthStatus::Warning)
    );
    transport.reply("connection.catalog.query", Err(HostRequestError::Transport("closed".into())));
    harness.click("health-refresh", cx);
    harness.with_window(cx, |window, _| {
        let line = window.find(domain_element_id("settings-status", "health"));
        assert!(line.label().is_some_and(|l| l.starts_with(copy::HEALTH_READ_FAILED.en())));
        assert!(window.find(signal("connection:local")).visible(), "the last snapshot stays");
    });
}
