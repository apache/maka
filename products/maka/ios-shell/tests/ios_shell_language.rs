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

#![cfg(not(target_os = "ios"))]

use maka_ios_shell::engine_config;
use nsh_core::{
    Size,
    platform::{Environment, Languages, LocaleSettings, Os},
    prelude::px,
};
use nsh_engine::HostChannel;
use nsh_testing::Headless;
use serde_json::json;
use std::path::Path;

fn start(data: &Path, device_locale: &str) -> Headless {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.reply(Ok(json!({
            "revision": 1,
            "devicePeerId": "fixture",
            "filter": { "kind": "all_computers" },
            "hosts": [],
            "active": null,
        })));
    });
    start_with_channel(data, channel, device_locale)
}

fn start_with_channel(data: &Path, channel: HostChannel, device_locale: &str) -> Headless {
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.data_dir = Some(data.to_owned());
    config.viewport = Size::new(px(390.), px(844.));
    let mut locale_settings = LocaleSettings::default();
    locale_settings.languages = Languages::parse(["ar-SA", device_locale]).unwrap();
    config.environment = Environment {
        // Headless drives the desktop projection of the same native menu and tab shell.
        os: Os::MacOs,
        locale_settings,
        reduce_motion: true,
        ..Environment::default()
    };
    Headless::start(config).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn language_override_survives_restart_and_automatic_returns_to_device_language() {
    let data = tempfile::tempdir().unwrap();
    {
        // Onboarding WelcomeScreen exposes a discrete Language picker in the header.
        let mut app = start(data.path(), "zh-Hant-HK");
        app.wait_for("text:自動").unwrap();
        app.press("label:語言").unwrap();
        app.choose_menu_item("日本語").unwrap();
        app.wait_for("text:コンピュータの QR コードをスキャン")
            .unwrap();
    }
    {
        let mut app = start(data.path(), "zh-Hans-CN");
        app.wait_for("text:コンピュータの QR コードをスキャン")
            .unwrap();
        app.press("label:言語").unwrap();
        app.choose_menu_item("システムに合わせる").unwrap();
        app.wait_for("text:扫码配对电脑").unwrap();
        app.wait_for("text:自动").unwrap();
    }
}

#[tokio::test]
async fn auto_negotiates_device_languages_including_hong_kong() {
    for (raw, expected) in [
        ("zh-Hans-CN", "粘贴配对链接或手动连接"),
        ("zh-Hant-TW", "貼上配對連結或手動連線"),
        ("zh-Hant-HK", "貼上配對連結或手動連接"),
        ("ja-JP", "コンピュータの QR コードをスキャン"),
        ("ko-KR", "컴퓨터의 QR 코드 스캔"),
        ("en-US", "Scan QR code on computer"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut app = start(dir.path(), raw);
        app.wait_for(&format!("text:{expected}")).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changing_language_updates_tabs_settings_inbox_recovery_and_pairing() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.reply(Ok(json!({
            "revision": 1,
            "devicePeerId": "locale-device",
            "filter": { "kind": "all_computers" },
            "hosts": [{
                "rootId": "root",
                "hostName": "Locale Host",
                "peerId": "peer-root",
                "connected": true,
                "endpoints": ["agent", "settings"]
            }],
            "active": {
                "rootId": "root",
                "hostName": "Locale Host",
                "epoch": "e1",
                "session": "locale-anchor",
                "generation": 1,
                "endpoints": ["agent", "settings"],
                "pathSummary": null,
                "transport": "quic"
            },
        })));
    });
    let session = json!({
        "id": "locale-session",
        "title": "Locale conversation",
        "kind": "agent",
        "parentSessionId": null,
        "revision": 1,
        "updatedAt": 1700000000000u64,
        "archived": false,
        "pinned": false,
        "hasUnread": false,
        "activity": "waiting",
        "workspace": { "name": "work", "path": "/work" },
        "labels": []
    });
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({
                "revision": "1",
                "sessions": [session],
                "needsYouCount": 1,
                "before": null,
                "after": null
            }),
            "pendingInteractions" => json!({
                "revision": 1,
                "entries": [
                    { "kind": "service_approval", "requestId": "locale-service", "toolUseId": "t1" },
                    { "kind": "permissions", "requestId": "locale-permission", "toolUseId": "t2" }
                ]
            }),
            "interaction" if data["input"]["requestId"] == "locale-permission" => json!({
                "requestId": "locale-permission",
                "outcome": null,
                "request": {
                    "kind": "permissions",
                    "toolUseId": "t2",
                    "request": {
                        "reason": "Fixture grant",
                        "command": null,
                        "permissions": {
                            "filesystem": [{ "path": "/fixture", "scope": "subtree", "access": "write" }],
                            "network": "denied",
                        },
                    },
                }
            }),
            "interaction" => json!({
                "requestId": "locale-service",
                "outcome": null,
                "request": {
                    "kind": "service_approval",
                    "toolUseId": "t1",
                    "toolName": "Fixture",
                    "service": "test",
                    "method": "start",
                    "binding": "local",
                    "through": 1
                }
            }),
            method => panic!("unexpected query {method}"),
        };
        call.reply(Ok(json!({ "value": value })));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.reply(Ok(json!({
            "subscriptionId": data["subscriptionId"],
            "rootId": "root",
            "generation": 1
        })));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({ "cancelled": true })));
    });

    let dir = tempfile::tempdir().unwrap();
    let mut app = start_with_channel(dir.path(), channel, "en-US");

    // Tab 1: Chats shows conversation under Needs Attention.
    app.wait_for("label:Conversation: Locale conversation")
        .unwrap();

    // Tab 2: Pending Inbox shows both interactions with localized descriptions.
    app.press("label:Pending").unwrap();
    app.wait_for("text:Allow service call Fixture?").unwrap();
    app.wait_for("text:/(?s)Read[/]write.*Network: no access/")
        .unwrap();

    // Tab 3: Settings shows Paired Computers, This iPhone (no steer-while-running), and Computer Settings.
    app.press("label:Settings").unwrap();
    app.wait_for("text:Paired Computers").unwrap();
    app.wait_for("text:This iPhone").unwrap();
    app.wait_for("text:Computer Settings").unwrap();
    assert!(!app.shows("Steer while the agent is running"));

    // Switch language to Japanese and confirm live re-render across Settings, Inbox, Recovery, and Pairing.
    app.press("label:Language").unwrap();
    app.choose_menu_item("日本語").unwrap();
    app.wait_for("text:ペアリング済みコンピュータ").unwrap();
    app.wait_for("text:この iPhone").unwrap();
    app.wait_for("text:コンピュータ設定").unwrap();

    app.press("label:保留中").unwrap();
    app.wait_for("text:サービス「Fixture」の呼び出しを許可しますか？")
        .unwrap();
    app.wait_for("text:/(?s)読み書き.*ネットワーク：アクセス不可/")
        .unwrap();
    assert!(!app.shows("Network: no access"));

    app.press("label:チャット").unwrap();
    app.send_host_event(
        "ios.operationRecovery",
        json!({ "session": "locale-anchor", "settled": 1, "pending": 1 }),
    )
    .unwrap();
    app.wait_for("text:/結果.*取得しました/").unwrap();

    app.send_url_scheme("maka://pair/v1?payload=fixture");
    app.wait_for("text:リンクでペアリング").unwrap();
}
