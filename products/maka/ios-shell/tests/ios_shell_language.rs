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
        // Headless drives the desktop projection of the same native menu.
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
        let mut app = start(data.path(), "zh-Hant-HK");
        app.wait_for("label:設定").unwrap();
        app.press("label:設定").unwrap();
        app.wait_for("text:自動（系統）").unwrap();
        app.press("label:語言").unwrap();
        app.choose_menu_item("日本語").unwrap();
        app.wait_for("label:言語").unwrap();
    }
    {
        let mut app = start(data.path(), "zh-Hans-CN");
        app.wait_for("label:設定").unwrap();
        app.press("label:設定").unwrap();
        app.wait_for("label:言語").unwrap();
        app.wait_for("text:日本語").unwrap();
        app.press("label:言語").unwrap();
        app.choose_menu_item("自動（システム設定）").unwrap();
        app.wait_for("label:语言").unwrap();
        app.wait_for("text:自动（系统）").unwrap();
    }
}

#[tokio::test]
async fn auto_negotiates_device_languages_including_hong_kong() {
    for (raw, title) in [
        ("zh-Hans-CN", "连接你的第一台电脑"),
        ("zh-Hant-TW", "連接你的第一台電腦"),
        ("zh-Hant-HK", "連接第一部電腦"),
        ("ja-JP", "最初のコンピュータに接続"),
        ("ko-KR", "첫 번째 컴퓨터 연결"),
        ("en-US", "Connect your first computer"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut app = start(dir.path(), raw);
        app.wait_for(&format!("text:{title}")).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changing_language_updates_open_settings_approval_toast_and_pairing() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| call.reply(Ok(json!({
        "revision":1,"devicePeerId":"locale-device","filter":{"kind":"all_computers"},
        "hosts":[{"rootId":"root","hostName":"Locale Host","connected":true,"endpoints":["agent"]}],
        "active":{"rootId":"root","hostName":"Locale Host","session":"locale-anchor","endpoints":["agent"]},
    }))));
    let session = json!({"id":"locale-session","title":"Locale conversation","kind":"agent","revision":1,
        "workspace":{"path":"/work"},"labels":[]});
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let value = match data["method"].as_str().unwrap() {
            "projects" => json!({"kind":"projects","projects":[]}),
            "directories" => json!({"kind":"roots","roots":[]}),
            "list" => json!({"revision":"1","sessions":[session],"needsYouCount":0,"after":null}),
            "observe" => json!({"session":session,"through":1,"run":null}),
            "history" => json!({"kind":"ready","through":1,"chunks":[],"before":null}),
            "goal" => json!({"enabled":false,"current":null}),
            "pendingInteractions" => json!({"entries":[
                {"kind":"service_approval","requestId":"locale-service"},
                {"kind":"permissions","requestId":"locale-permission"}
            ]}),
            "interaction" if data["input"]["requestId"] == "locale-permission" => json!({
                "requestId":"locale-permission","outcome":null,"request":{
                    "kind":"permissions","toolUseId":"fixture-tool","request":{
                        "reason":"Fixture grant","command":null,"permissions":{
                            "filesystem":[{"path":"/fixture","scope":"subtree","access":"write"}],
                            "network":"denied",
                        },
                    },
                }
            }),
            "interaction" => json!({"requestId":"locale-service","outcome":null,"request":{
                "kind":"service_approval","toolName":"Fixture","service":"test","method":"start","binding":"local",
            }}),
            method => panic!("unexpected query {method}"),
        };
        call.reply(Ok(json!({"value":value})));
    });
    channel.handle("ios.hostMutate", |mut call| {
        let data = call.take_data();
        assert_eq!(data["anchorSession"], "locale-anchor");
        assert_eq!(data["input"]["requestId"], "locale-permission");
        assert_eq!(
            data["input"]["answer"]["decision"],
            json!({
                "decision":"allow","scope":"once","permissions":{
                    "filesystem":[{"path":"/fixture","scope":"subtree","access":"write"}],
                    "network":"denied",
                },
            })
        );
        call.reply(Ok(json!({"value":{"kind":"recorded"}})));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.reply(Ok(
            json!({"subscriptionId":data["subscriptionId"],"generation":1}),
        ));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({"cancelled":true})))
    });
    let dir = tempfile::tempdir().unwrap();
    let mut app = start_with_channel(dir.path(), channel, "en-US");
    app.wait_for("label:Conversation: Locale conversation")
        .unwrap();
    app.press("label:Conversation: Locale conversation")
        .unwrap();
    app.wait_for("text:Allow service call Fixture?").unwrap();
    app.press("label:Allow once").unwrap();
    app.wait_for("text:/(?s)Allowed once.*Read[/]write.*Network: no access/")
        .unwrap();
    app.press("label:Open drawer").unwrap();
    app.press("label:Settings").unwrap();
    app.wait_for("text:Appearance & interaction").unwrap();
    app.wait_for("text:Root root").unwrap();
    app.press("label:Language").unwrap();
    app.choose_menu_item("日本語").unwrap();
    app.wait_for("text:外観と操作").unwrap();
    app.wait_for("text:ルート ID：root").unwrap();
    app.press("label:設定画面から戻る").unwrap();
    app.wait_for("text:サービス「Fixture」の呼び出しを許可しますか？")
        .unwrap();
    app.wait_for("label:許可").unwrap();
    app.wait_for("text:/(?s)今回のみ許可済み.*読み書き.*ネットワーク：アクセス不可/")
        .unwrap();
    assert!(!app.shows("Network: no access"));
    app.send_host_event(
        "ios.operationRecovery",
        json!({"session":"locale-anchor","settled":1,"pending":1}),
    )
    .unwrap();
    app.wait_for("text:/結果.*取得しました/").unwrap();
    app.send_url_scheme("maka://pair/v1?payload=fixture");
    app.wait_for("text:ホストに接続").unwrap();
}
