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
    MountItem, Size,
    platform::{Environment, Languages, LocaleSettings, Os},
    prelude::px,
};
use nsh_engine::HostChannel;
use nsh_testing::Headless;
use serde_json::json;
use std::{path::Path, time::Duration};

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
    start_on(data, channel, device_locale, Os::MacOs)
}

fn start_on(data: &Path, channel: HostChannel, device_locale: &str, os: Os) -> Headless {
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.data_dir = Some(data.to_owned());
    config.viewport = Size::new(px(390.), px(844.));
    let mut locale_settings = LocaleSettings::default();
    locale_settings.languages = Languages::parse(["ar-SA", device_locale]).unwrap();
    config.environment = Environment {
        os,
        tab_bar: false,
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
        app.press("label:扫码配对电脑").unwrap();
        app.wait_for("label:返回").unwrap();
        app.press("label:返回").unwrap();
        app.wait_for("text:扫码配对电脑").unwrap();
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
        let active = json!({
            "rootId": "root",
            "hostName": "Locale Host",
            "epoch": "e1",
            "session": "locale-anchor",
            "generation": 1,
            "endpoints": ["agent", "settings"],
            "pathSummary": null,
            "transport": "quic"
        });
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
            "active": active,
            "connections": {"root": {"status": "connected", "connection": active}},
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
            "botOutbox" => json!({"isBot":false,"through":0,"readThrough":0,"preview":"","messages":[]}),
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
                            "network": {"restricted":{"destinations":[{"host":"example.test","port":8080}]}},
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
    let (respond_tx, mut replies) = tokio::sync::mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        assert_eq!(data["method"], "respond");
        assert_eq!(data["input"]["requestId"], "locale-permission");
        respond_tx.send(call.into_reply().unwrap()).unwrap();
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

    assert!(!app.shows("label:All"));
    assert!(!app.shows("label:Locale Host"));

    // Tab 2: Pending Inbox shows both interactions with localized descriptions.
    app.press("label:Pending").unwrap();
    app.wait_for("text:Allow service call Fixture?").unwrap();
    app.wait_for("text:/(?s)Read[/]write.*Network: exact host .*port 8080/")
        .unwrap();

    // Tab 3: Settings shows Paired Computers, This iPhone (no steer-while-running), and Computer Settings.
    app.press("label:Settings").unwrap();
    app.wait_for("label:Computer: Locale Host").unwrap();
    assert!(!app.shows("text:Paired Computers"));
    for title in [
        "General",
        "Models & Connections",
        "Subagents",
        "Plugins",
        "MCP",
        "Skills",
        "Web Search",
        "Network Proxy",
    ] {
        app.wait_for(&format!("text:{title}")).unwrap();
    }
    app.wait_for("text:This iPhone").unwrap();
    app.wait_for("text:Computer Settings").unwrap();
    assert!(!app.shows("Steer while the agent is running"));

    // Switch language to Japanese and confirm live re-render across Settings, Inbox, Recovery, and Pairing.
    app.press("label:Language").unwrap();
    app.choose_menu_item("日本語").unwrap();
    app.wait_for("text:Locale Host").unwrap();
    app.wait_for("text:この iPhone").unwrap();
    app.wait_for("text:コンピュータ設定").unwrap();

    app.press("label:保留中").unwrap();
    app.wait_for("text:サービス「Fixture」の呼び出しを許可しますか？")
        .unwrap();
    app.wait_for("text:/(?s)読み書き.*ネットワーク.*8080/")
        .unwrap();
    assert!(!app.shows("text:/8[,.]080/"));
    app.press("label:今回のみ許可").unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), replies.recv())
        .await
        .unwrap()
        .unwrap();
    response.resolve(json!({"value":{"kind":"rejected","reason":"invalid_answer"}}));
    app.wait_for("text:回答が無効です").unwrap();

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chinese_settings_localize_connection_and_dynamic_model_controls() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let connection = json!({
            "rootId": "root", "hostName": "Locale Host", "peerId": "peer", "connected": true,
            "epoch": "e1", "session": "anchor", "generation": 1,
            "endpoints": ["agent", "settings", "management"], "transport": "quic"
        });
        call.resolve(json!({
            "revision": 1, "devicePeerId": "fixture", "hosts": [connection], "active": connection,
            "connections": {"root": {"status": "connected", "connection": connection}}
        }));
    });
    let model = json!({
        "label":"Fixture Model", "connectionName":"Fixture",
        "selection":{"connectionId":"fixture","modelId":"fixture-model"},
        "thinkingLevels":["off","minimal","low","medium","high","xhigh","max","ultra","future_level"],
        "defaultThinkingLevel":"xhigh",
    });
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let value = match data["method"].as_str().unwrap() {
            "botOutbox" => json!({"isBot":false}),
            "list" => json!({"sessions":[]}),
            "pendingInteractions" => json!({"entries":[]}),
            "connections" => json!({
                "kind":"ready", "revision":1, "connections":[], "next":null,
                "defaultTarget":{"connectionId":"fixture","modelId":"fixture-model"}
            }),
            "models" => json!({"kind":"ready","revision":1,"next":null,"choices":[model]}),
            "resolveModel" => json!({"kind":"ready","choice":model}),
            "presets" => json!([{
                "id":"future-preset","revision":1,"name":"Fixture Preset","description":"",
                "model":{"connectionId":"fixture","modelId":"fixture-model"},
                "thinkingLevel":"future_level","enabled":true,"availability":{"kind":"available"}
            }]),
            "externalAgents" => json!({
                "runtimes":[{"id":"fixture-agent","name":"Fixture Agent","enabled":false}],
                "state":{"kind":"disabled"}
            }),
            method => panic!("unexpected query {method}"),
        };
        call.resolve(json!({"value":value}));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.resolve(json!({
            "subscriptionId":data["subscriptionId"], "rootId":"root", "generation":1
        }));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });

    let dir = tempfile::tempdir().unwrap();
    let mut app = start_on(dir.path(), channel, "zh-Hans-CN", Os::Ios);
    // Headless does not open UIKit menus; inspect the items sent to the native menu.
    let (menu_tx, menus) = std::sync::mpsc::channel();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ComponentProps { props, .. } = item {
                for (name, value) in props {
                    if name.as_ref() == "items"
                        && let Some(items) = value.as_ref().and_then(|value| value.as_array())
                        && items.iter().any(|item| item["id"] == "future_level")
                    {
                        menu_tx.send(items.clone()).unwrap();
                    }
                }
            }
        }
    });
    app.wait_for("label:搜索对话或项目").unwrap();
    app.type_text("label:搜索对话或项目", "fixture").unwrap();
    app.press("label:清除搜索").unwrap();
    assert!(!app.shows("label:清除搜索"));

    app.press("label:设置").unwrap();
    app.wait_for("text:已连接").unwrap();
    app.press("label:子 Agent").unwrap();
    app.wait_for("text:Fixture Model · future_level").unwrap();
    app.press("label:设置").unwrap();
    app.press("label:模型与连接").unwrap();
    app.wait_for("text:很高").unwrap();
    let items = menus.try_iter().last().unwrap();
    let labels = items
        .iter()
        .map(|item| item["label"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        labels,
        [
            "关闭",
            "极低",
            "低",
            "中",
            "高",
            "很高",
            "最高",
            "超高",
            "future_level"
        ]
    );

    app.answer_dialogs_myself();
    app.press("role:switch[Fixture Agent]").unwrap();
    let dialog = app.pending_dialog().unwrap();
    assert_eq!(dialog.title.as_deref(), Some("确认权限并启用"));
    assert!(dialog.buttons.iter().any(|button| button.text == "启用"));
}
