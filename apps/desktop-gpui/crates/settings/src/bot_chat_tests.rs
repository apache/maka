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

//! UI integration tests of the Remote access page against the fake bot
//! sidecar (`bots::testing::FakeSidecar`) and a settings file in a scratch
//! folder: the overview's states (a conflict among them), the detail's
//! actions and what they say, the enable switch, secrets that never reach
//! the page, the QR onboarding's polling and expiry, and the bot runtime
//! the page keeps running while it shows. Answers follow the sidecar's
//! protocol (docs/bots-sidecar.md).

// Test setup writes and reads the settings file directly; no UI thread is
// involved.
#![allow(clippy::disallowed_methods)]

use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use bots::testing::FakeSidecar;
use bots::{BotChatSettings, BotHost, BotProvider, BotReadiness, BotService, BotSettingsStore};
use futures_lite::future::block_on;
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, ElementId, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    TestAppContext, Window, WindowHandle, div, px, size,
};
use host_client::{ConnectionEvent, HostEvent};
use serde_json::{Value, json};
use shared::copy::Locale;
use shared::copy::bots as copy;
use shared::domain_element_id;
use workspace::{ConnectionCatalog, HostSession, ProjectSelection};

use crate::bot_chat_page::BotAction;
use crate::tests::{ScriptedHost, accepted, catalog_page, policy, reveal};
use crate::{AboutFacts, BotChatPage, SettingsContext, SettingsSection, SettingsView};

const ROOT: &str = "/tmp/.dev-root";

struct Shell(Entity<SettingsView>);

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut gpui_kit::Context<Self>) -> impl IntoElement {
        div().size_full().child(self.0.clone())
    }
}

/// The folder the settings file lives in, removed with it.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

struct Page {
    bots: Entity<BotService>,
    fake: FakeSidecar,
    view: Entity<SettingsView>,
    window: WindowHandle<Root>,
    _scratch: Scratch,
}

/// Parks until `done` holds, or panics after about 5 s.
fn wait(cx: &mut TestAppContext, what: &str, mut done: impl FnMut(&mut TestAppContext) -> bool) {
    for _ in 0..500 {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}

/// Settings on Remote access over a settings file `seed` writes, with the
/// fake sidecar running.
fn open(cx: &mut TestAppContext, seed: impl FnOnce(&mut BotChatSettings)) -> Page {
    cx.executor().allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init(cx);
        cx.set_reduce_motion(true);
    });
    let scratch =
        std::env::temp_dir().join(format!("bot-chat-page-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let store = Arc::new(BotSettingsStore::new(scratch.join("bot-chat.json")));
    block_on(store.update(seed)).expect("seeded");
    let fake = FakeSidecar::new();
    let launcher = fake.launcher();
    let bots = cx.new(|cx| BotService::new(store, cx).with_launcher(launcher));
    wait(cx, "the settings", |cx| {
        bots.read_with(cx, |bots, _| bots.channel(BotProvider::Qq).is_some())
    });
    bots.update(cx, |bots, cx| {
        bots.set_host(Some(BotHost::Local { state_root: PathBuf::from(ROOT) }), cx)
    });

    let transport = Arc::new(ScriptedHost::default());
    transport.reply("runtime.policy.query", Ok(policy(3, "ask")));
    transport.reply("connection.catalog.query", Ok(catalog_page(6)));
    let host = cx.new(|_| HostSession::with_transport(PathBuf::from(ROOT), transport.clone()));
    host.update(cx, |host, cx| {
        host.handle_host_event(
            HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
            cx,
        )
    });
    let connections = cx.new(|cx| ConnectionCatalog::new(host.clone(), cx));
    let projects = cx.new(|cx| {
        ProjectSelection::new(host.clone(), Rc::new(workspace::UnavailableProjectCatalog), cx)
    });
    let context = SettingsContext::new(host, connections, projects, AboutFacts::new("9.9.9"))
        .with_bots(bots.clone());
    let mut view = None;
    let window = cx.open_window(size(px(1512.), px(885.)), |window, cx| {
        let settings =
            cx.new(|cx| SettingsView::new(context, SettingsSection::BotChat, window, cx));
        view = Some(settings.clone());
        Root::new(cx.new(|_| Shell(settings)), window, cx)
    });
    let page =
        Page { bots, fake, view: view.expect("the surface"), window, _scratch: Scratch(scratch) };
    wait(cx, "the bot runtime", |cx| page.bots.read_with(cx, |bots, _| bots.is_running()));
    page
}

impl Page {
    fn page(&self, cx: &mut TestAppContext) -> Entity<BotChatPage> {
        self.view.read_with(cx, |view, _| view.bot_chat().clone())
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Window, &mut gpui_kit::App) -> R,
    ) -> R {
        let result = cx
            .update_window(self.window.into(), |_, window, cx| {
                window.render_frame(cx);
                f(window, cx)
            })
            .expect("window");
        cx.run_until_parked();
        result
    }

    fn click(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) {
        let id = id.into();
        self.with_window(cx, |window, cx| {
            reveal(window, &id, cx);
            window.click(id, cx)
        });
    }

    fn label(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|e| e.label().map(str::to_owned))
        })
    }

    fn present(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> bool {
        let id = id.into();
        self.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    /// The line under the actions.
    fn feedback(&self, cx: &mut TestAppContext) -> Option<String> {
        self.label(domain_element_id("settings-status", "bot-action"), cx)
    }

    fn open_detail(&self, provider: BotProvider, cx: &mut TestAppContext) {
        self.click(domain_element_id("bot-channel-row", provider.as_str()), cx);
        let page = self.page(cx);
        assert_eq!(page.read_with(cx, |page, _| page.detail()), Some(provider));
    }

    /// Types `text` into the detail's `field` and presses Enter.
    fn type_into(&self, field: &str, text: &str, cx: &mut TestAppContext) {
        let page = self.page(cx);
        let setting = page.read_with(cx, |page, _| page.field(field).cloned()).expect(field);
        let id: ElementId = ("settings-text", setting.entity_id()).into();
        self.with_window(cx, |window, cx| {
            reveal(window, &id, cx);
            window.click(id, cx);
            window.press("cmd-a", cx);
            window.input(text, cx);
            window.press("enter", cx);
        });
    }

    fn saved(&self, cx: &mut TestAppContext) -> BotChatSettings {
        let store = self.bots.read_with(cx, |bots, _| bots.store().clone());
        block_on(store.load()).expect("saved")
    }

    /// Waits for the action in flight to end.
    fn settle(&self, cx: &mut TestAppContext) {
        let page = self.page(cx);
        wait(cx, "the action", |cx| {
            page.read_with(cx, |page, _| page.pending().is_none() && !page.is_busy())
        });
    }
}

fn status(platform: &str, running: bool, readiness: &str, extra: Value) -> Value {
    let mut status = json!({"platform": platform, "running": running, "readiness": readiness,
                            "connection": if running { "polling" } else { "none" }});
    if let Value::Object(fields) = extra {
        for (key, value) in fields {
            status[key] = value;
        }
    }
    json!({ "status": status })
}

fn en(text: shared::copy::Text) -> &'static str {
    text.in_locale(Locale::English)
}

#[gpui_kit::test]
fn the_overview_lists_the_platforms_in_use_and_to_connect(cx: &mut TestAppContext) {
    let page = open(cx, |settings| {
        let telegram = settings.channel_mut(BotProvider::Telegram);
        telegram.enabled = true;
        telegram.token = "123:abc".into();
        telegram.readiness = Some(BotReadiness::CredentialsValid);
        let discord = settings.channel_mut(BotProvider::Discord);
        discord.token = "discord-token".into();
        discord.readiness = Some(BotReadiness::Configured);
        discord.last_error = Some("token_invalid".into());
    });
    page.fake.send(FakeSidecar::status(status(
        "telegram",
        true,
        "operational",
        json!({"identity": {"username": "maka_test_bot"}}),
    )));
    cx.run_until_parked();
    let row = |provider: &str| domain_element_id("bot-channel-row", provider);
    let summary = |provider: &str| domain_element_id("bot-channel-summary", provider);
    page.with_window(cx, |window, _| {
        let active =
            window.find(domain_element_id("settings-group", "remote-access-active")).bounds();
        let more =
            window.find(domain_element_id("settings-group", "remote-access-available")).bounds();
        // In use: Discord first, since it needs attention; then Telegram.
        let discord = window.find(row("discord")).bounds();
        let telegram = window.find(row("telegram")).bounds();
        assert!(active.contains(&discord.center()) && active.contains(&telegram.center()));
        assert!(discord.top() < telegram.top(), "attention first");
        for provider in ["feishu", "wecom", "wechat", "dingtalk", "qq", "slack"] {
            assert!(more.contains(&window.find(row(provider)).bounds().center()), "{provider}");
        }
        assert_eq!(
            window.find(row("telegram")).label(),
            Some("Manage Telegram, Operational"),
            "the row names its state"
        );
        assert_eq!(window.find(row("qq")).label(), Some("Connect QQ"));
    });
    assert!(
        page.label(summary("telegram"), cx)
            .is_some_and(|line| line.starts_with("Listening · maka_test_bot"))
    );
    assert_eq!(page.label(summary("discord"), cx).as_deref(), Some(en(copy::TEST_TOKEN_INVALID)));
    assert_eq!(page.label(summary("qq"), cx).as_deref(), Some(en(copy::HELP_QQ)));

    // Another client polling the token: said as such, on the row and the
    // detail.
    page.fake.send(FakeSidecar::status(json!({
        "status": {"platform": "telegram", "running": false, "readiness": "credentials_valid",
                   "reason": "disabled", "connection": "none"},
        "conflict": {"kind": "polling", "detectedAt": 5}
    })));
    cx.run_until_parked();
    assert_eq!(page.label(summary("telegram"), cx).as_deref(), Some(en(copy::CONFLICT_POLLING)));
    assert_eq!(
        page.label(domain_element_id("settings-state", "telegram"), cx).as_deref(),
        Some(en(copy::CONFLICT_STATUS))
    );
    page.open_detail(BotProvider::Telegram, cx);
    assert_eq!(
        page.label(domain_element_id("settings-warning", "bot-conflict"), cx).as_deref(),
        Some(en(copy::CONFLICT_POLLING))
    );
    // Test and connect resumes it: the listener is restarted.
    page.fake.answer(
        "restart_listeners",
        json!({"statuses": [status("telegram", true, "operational", json!({}))]}),
    );
    page.click("bot-connect", cx);
    page.settle(cx);
    let restarts = page.fake.commands_named("restart_listeners");
    assert_eq!(restarts, [json!({"command": "restart_listeners", "provider": "telegram"})]);
    assert!(page.feedback(cx).is_some_and(|line| line.starts_with("Telegram is listening")));
}

#[gpui_kit::test]
fn test_and_connect_enables_a_channel_once_its_credentials_pass(cx: &mut TestAppContext) {
    let page = open(cx, |settings| {
        settings.channel_mut(BotProvider::Discord).token = "discord-token".into();
    });
    page.open_detail(BotProvider::Discord, cx);
    // Not proven yet: the switch waits, and says for what.
    assert_eq!(page.label("bot-enable-hint", cx).as_deref(), Some(en(copy::TEST_FIRST_HINT)));
    page.click(domain_element_id("settings-toggle", "bot-enabled"), cx);
    assert!(
        !page.saved(cx).channel(BotProvider::Discord).enabled,
        "a disabled switch does nothing"
    );

    // A failed test says why, and enables nothing.
    page.fake
        .answer("test_channel", json!({"result": {"ok": false, "errorCode": "token_invalid"}}));
    page.click("bot-connect", cx);
    page.settle(cx);
    assert_eq!(
        page.feedback(cx).as_deref(),
        Some(format!("Discord credential test failed. {}", en(copy::TEST_TOKEN_INVALID)).as_str())
    );
    let discord = page.saved(cx).channel(BotProvider::Discord).clone();
    assert!(!discord.enabled);
    assert_eq!(discord.last_error.as_deref(), Some("token_invalid"));
    assert!(page.fake.commands_named("restart_listeners").is_empty());

    // A passing one enables it and starts the listener.
    page.fake.answer(
        "test_channel",
        json!({"result": {"ok": true, "identity": {"username": "maka_discord"}}}),
    );
    page.fake.answer(
        "restart_listeners",
        json!({"statuses": [status("discord", false, "credentials_valid", json!({"reason": "gateway-closed-4004"}))]}),
    );
    page.click("bot-connect", cx);
    page.settle(cx);
    let discord = page.saved(cx).channel(BotProvider::Discord).clone();
    assert!(discord.enabled);
    assert_eq!(discord.readiness, Some(BotReadiness::CredentialsValid));
    assert_eq!(
        page.feedback(cx).as_deref(),
        Some("Discord did not start listening. Gateway connection closed (4004); reconnecting.")
    );
    let names: Vec<Value> =
        page.fake.commands().iter().map(|command| command["command"].clone()).collect();
    let test = names.iter().rposition(|name| name == "test_channel").expect("tested");
    assert_eq!(
        names[test + 1..],
        [
            json!("apply_settings"),
            json!("apply_settings"),
            json!("apply_settings"),
            json!("restart_listeners")
        ]
    );
}

#[gpui_kit::test]
fn secrets_are_replaced_but_never_shown(cx: &mut TestAppContext) {
    let page = open(cx, |settings| {
        let feishu = settings.channel_mut(BotProvider::Feishu);
        feishu.app_id = Some("cli_saved".into());
        feishu.app_secret = Some("feishu-saved-secret".into());
    });
    page.open_detail(BotProvider::Feishu, cx);
    page.click(domain_element_id("bot-setup-mode", "manual"), cx);
    let bot_page = page.page(cx);
    let value = |key: &str, cx: &mut TestAppContext| {
        let setting = bot_page.read_with(cx, |page, _| page.field(key).cloned()).expect(key);
        setting.read_with(cx, |setting, cx| setting.input().read(cx).value().to_string())
    };
    assert_eq!(value("app-id", cx), "cli_saved", "a plain field shows its value");
    assert_eq!(value("app-secret", cx), "", "a secret never does");

    page.type_into("app-secret", "feishu-new-secret", cx);
    wait(cx, "the save", |cx| bot_page.read_with(cx, |page, _| !page.is_busy()));
    assert_eq!(value("app-secret", cx), "", "the field empties once committed");
    assert_eq!(
        page.saved(cx).channel(BotProvider::Feishu).app_secret.as_deref(),
        Some("feishu-new-secret")
    );
    // Nothing the page keeps names a secret: its state, its fields, and
    // the channel it reads.
    let shown = bot_page.read_with(cx, |page, cx| {
        let fields: Vec<String> = ["app-id", "app-secret"]
            .iter()
            .filter_map(|key| page.field(key))
            .map(|setting| {
                format!("{:?} {}", setting.read(cx), setting.read(cx).input().read(cx).value())
            })
            .collect();
        format!("{page:?} {fields:?}")
    });
    let summary =
        page.bots.read_with(cx, |bots, _| format!("{:?}", bots.channel(BotProvider::Feishu)));
    for secret in ["feishu-saved-secret", "feishu-new-secret"] {
        assert!(!shown.contains(secret) && !summary.contains(secret), "{secret} leaked");
    }
    // An empty commit keeps the saved secret.
    page.type_into("app-secret", "", cx);
    assert_eq!(
        page.saved(cx).channel(BotProvider::Feishu).app_secret.as_deref(),
        Some("feishu-new-secret")
    );
    // A plain field saves what is typed.
    page.type_into("app-id", "cli_new", cx);
    wait(cx, "the save", |cx| bot_page.read_with(cx, |page, _| !page.is_busy()));
    assert_eq!(page.saved(cx).channel(BotProvider::Feishu).app_id.as_deref(), Some("cli_new"));
}

fn snapshot(provider: &str, state: &str, extra: Value) -> Value {
    let mut snapshot = json!({"sessionId": "s-1", "provider": provider, "state": state,
                              "nextPollAfterMs": 0, "canOpenInBrowser": true});
    if let Value::Object(fields) = extra {
        for (key, value) in fields {
            snapshot[key] = value;
        }
    }
    snapshot
}

#[gpui_kit::test]
fn qr_setup_polls_until_the_scan_is_saved(cx: &mut TestAppContext) {
    let page = open(cx, |_| {});
    page.open_detail(BotProvider::Dingtalk, cx);
    page.fake.answer(
        "onboarding_start",
        json!({"snapshot": snapshot("dingtalk", "waiting",
            json!({"qr": {"text": "https://open-dev.dingtalk.com/openapp/registration?code=abc"}}))}),
    );
    page.fake
        .answer("onboarding_poll", json!({"snapshot": snapshot("dingtalk", "scanned", json!({}))}));
    page.fake.answer(
        "onboarding_poll",
        json!({"snapshot": snapshot("dingtalk", "connecting", json!({"identity": {"id": "ding-app"}})),
               "channel": {"enabled": true, "connected": false, "readiness": "configured",
                           "readinessUpdatedAt": 9, "appId": "ding-app", "appSecret": "ding-secret"}}),
    );
    page.fake.answer(
        "onboarding_finish",
        json!({"snapshot": snapshot("dingtalk", "connected", json!({"identity": {"id": "ding-app"}}))}),
    );
    page.click("bot-scan", cx);
    let bot_page = page.page(cx);
    let dialog = bot_page.read_with(cx, |page, _| page.onboarding().cloned()).expect("the dialog");
    let line = |cx: &mut TestAppContext| {
        dialog.read_with(cx, |dialog, _| dialog.status_line(Locale::English))
    };
    wait(cx, "the code", |cx| dialog.read_with(cx, |dialog, _| dialog.shows_qr()));
    assert_eq!(line(cx), en(copy::DINGTALK_WAITING));
    assert!(page.present("bot-onboarding-qr", cx));
    assert!(page.present("bot-onboarding-browser", cx), "a verification page to open");
    // Polls at least 400 ms apart, as Desktop does.
    cx.executor().advance_clock(Duration::from_millis(399));
    cx.run_until_parked();
    assert!(page.fake.commands_named("onboarding_poll").is_empty());
    cx.executor().advance_clock(Duration::from_millis(1));
    wait(cx, "the scan", |cx| line(cx) == en(copy::DINGTALK_SCANNED));
    cx.executor().advance_clock(Duration::from_millis(400));
    wait(cx, "the save", |cx| line(cx) == "DingTalk connected");
    assert_eq!(page.fake.commands_named("onboarding_poll").len(), 2);
    let dingtalk = page.saved(cx).channel(BotProvider::Dingtalk).clone();
    assert!(dingtalk.enabled);
    assert_eq!(dingtalk.app_secret.as_deref(), Some("ding-secret"));
    assert!(page.present("bot-onboarding-done", cx));
    assert!(page.feedback(cx).is_some_and(|line| line.starts_with("DingTalk QR setup complete")));
    let shown = dialog.read_with(cx, |dialog, _| format!("{dialog:?}"));
    assert!(!shown.contains("ding-secret"));
    // Done closes it, and the setup can run again.
    page.click("bot-onboarding-done", cx);
    assert!(bot_page.read_with(cx, |page, _| page.onboarding().is_none()));
    assert!(!page.present("bot-onboarding", cx));
    page.click("bot-scan", cx);
    assert!(bot_page.read_with(cx, |page, _| page.onboarding().is_some()));
}

#[gpui_kit::test]
fn an_expired_code_offers_a_new_one(cx: &mut TestAppContext) {
    let page = open(cx, |_| {});
    page.open_detail(BotProvider::Qq, cx);
    page.fake.answer(
        "onboarding_start",
        json!({"snapshot": snapshot("qq", "waiting", json!({"qr": {"text": "https://q.qq.com/qqbot/openclaw/connect.html?task_id=1"}}))}),
    );
    page.fake.answer("onboarding_poll", json!({"snapshot": snapshot("qq", "expired", json!({}))}));
    page.click("bot-scan", cx);
    let dialog =
        page.page(cx).read_with(cx, |page, _| page.onboarding().cloned()).expect("the dialog");
    wait(cx, "the code", |cx| dialog.read_with(cx, |dialog, _| dialog.shows_qr()));
    cx.executor().advance_clock(Duration::from_millis(400));
    wait(cx, "the expiry", |cx| {
        dialog.read_with(cx, |dialog, _| dialog.status_line(Locale::English))
            == en(copy::ONBOARDING_EXPIRED)
    });
    assert!(!dialog.read_with(cx, |dialog, _| dialog.shows_qr()), "an expired code is not shown");
    assert!(page.present("bot-onboarding-regenerate", cx));
    assert!(!page.present("bot-onboarding-browser", cx));
    // Generate again starts a new session.
    page.fake.answer("onboarding_start", json!({"snapshot": snapshot("qq", "waiting", json!({"qr": {"text": "https://q.qq.com/x"}}))}));
    page.click("bot-onboarding-regenerate", cx);
    wait(cx, "the new code", |cx| dialog.read_with(cx, |dialog, _| dialog.shows_qr()));
    assert_eq!(page.fake.commands_named("onboarding_start").len(), 2);
}

#[gpui_kit::test]
fn the_page_keeps_the_bot_runtime_running_while_settings_show(cx: &mut TestAppContext) {
    let page = open(cx, |_| {});
    assert_eq!(page.fake.launches().len(), 1, "no channel is enabled; the page holds it");
    assert_eq!(
        page.label(domain_element_id("bot-fact", "identity"), cx),
        None,
        "the overview shows"
    );
    page.open_detail(BotProvider::Feishu, cx);
    assert_eq!(
        page.label(domain_element_id("bot-fact", "last-test"), cx).as_deref(),
        Some(en(copy::NEVER_TESTED))
    );
    page.click("bot-test", cx);
    page.settle(cx);
    assert!(page.feedback(cx).is_some_and(|line| line.starts_with("Feishu credentials verified")));
    assert_eq!(
        page.page(cx).read_with(cx, |page, _| page.pending()),
        None::<(BotProvider, BotAction)>
    );
    // Leaving settings lets it stop.
    let Page { fake, view, window, _scratch, .. } = page;
    drop(view);
    cx.update_window(window.into(), |_, window, _| window.remove_window()).expect("window");
    wait(cx, "the shutdown", |_| !fake.commands_named("shutdown").is_empty());
}

#[gpui_kit::test]
fn the_search_finds_remote_access_by_its_platforms(cx: &mut TestAppContext) {
    let _ = cx;
    let found = |query: &str, locale| -> Vec<SettingsSection> {
        SettingsSection::listed().filter(|s| s.matches(query, locale)).collect()
    };
    assert_eq!(found("telegram", Locale::English), [SettingsSection::BotChat]);
    assert_eq!(found("remote", Locale::English), [SettingsSection::BotChat]);
    assert_eq!(found("飞书", Locale::SimplifiedChinese), [SettingsSection::BotChat]);
    assert_eq!(SettingsSection::from_key("bot-chat"), Some(SettingsSection::BotChat));
}
