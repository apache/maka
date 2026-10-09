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

//! [`BotService`] against a scripted supervisor and the fake sidecar: what it
//! hands a new sidecar, how it follows the sidecar's events, when it runs
//! one, the settings actions, and the QR onboarding.

// Test setup reads and writes the settings file directly; no UI thread is
// involved.
#![allow(clippy::disallowed_methods)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_lite::future::block_on;
use gpui_kit::{AppContext as _, Entity, TestAppContext};
use host_protocol::WorkspaceTarget;
use serde_json::{Value, json};

use crate::launch::{BotHost, LaunchOptions};
use crate::protocol::{ChannelStatus, Command, HostLinkState, OnboardingBrand, OnboardingState};
use crate::service::{BotService, BotServiceState, launcher};
use crate::settings::{BotProvider, BotReadiness, BotSettingsStore};
use crate::supervisor::{BotCommandError, BotEvent, Request, RestartPolicy, Script, scripted};
use crate::testing::FakeSidecar;

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn store(name: &str) -> (Arc<BotSettingsStore>, Scratch) {
    let dir =
        std::env::temp_dir().join(format!("bots-service-{name}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("scratch");
    let store = Arc::new(BotSettingsStore::new(dir.join("bot-chat.json")));
    block_on(store.update(|settings| {
        let telegram = settings.channel_mut(BotProvider::Telegram);
        telegram.enabled = true;
        telegram.token = "123:abc".into();
    }))
    .expect("saved settings");
    (store, Scratch(dir))
}

fn status(value: Value) -> ChannelStatus {
    serde_json::from_value(value).expect("channel status")
}

/// The next request the service sent; it may come from a background task
/// that reads the settings file, so this parks until it arrives.
fn next_request(
    script: &Script,
    cx: &mut TestAppContext,
) -> (Command, Option<crate::supervisor::Reply>) {
    let request = cx
        .foreground_executor()
        .block_test(async {
            futures_lite::future::or(async { script.requests.recv().await.ok() }, async {
                async_io::Timer::after(Duration::from_secs(10)).await;
                None
            })
            .await
        })
        .expect("a request");
    match request {
        Request::Command { command, reply } => (command, Some(reply)),
        Request::Restart => panic!("unexpected restart"),
        Request::Shutdown { .. } => panic!("unexpected shutdown"),
    }
}

fn answer(reply: Option<crate::supervisor::Reply>, value: Value) {
    reply.expect("reply").try_send(Ok(value)).expect("answered");
}

fn attached(cx: &mut TestAppContext, name: &str) -> (Entity<BotService>, Script, Scratch) {
    cx.executor().allow_parking();
    let (store, scratch) = store(name);
    let service = cx.new(|cx| BotService::new(store, cx));
    let (supervised, script) = scripted();
    service.update(cx, |service, cx| {
        service.set_workspace(Some(WorkspaceTarget::Project { project_id: "p1".into() }), cx);
        service.attach(supervised, cx);
        assert_eq!(service.state(), &BotServiceState::Starting);
    });
    (service, script, scratch)
}

#[gpui_kit::test]
fn a_new_sidecar_gets_the_workspace_and_the_saved_settings(cx: &mut TestAppContext) {
    let (_service, script, _scratch) = attached(cx, "handover");
    let (workspace, reply) = next_request(&script, cx);
    let Command::SetWorkspace { workspace: Some(WorkspaceTarget::Project { project_id }) } =
        workspace
    else {
        panic!("the workspace first, got {workspace:?}");
    };
    assert_eq!(project_id, "p1");
    answer(reply, json!({}));
    let (settings, reply) = next_request(&script, cx);
    let Command::ApplySettings { settings } = settings else {
        panic!("then the settings, got {settings:?}");
    };
    assert!(settings.channel(BotProvider::Telegram).enabled);
    assert_eq!(settings.channel(BotProvider::Telegram).token, "123:abc");
    answer(reply, json!({}));
}

#[gpui_kit::test]
fn state_statuses_and_the_host_link_follow_the_sidecar(cx: &mut TestAppContext) {
    let (service, script, _scratch) = attached(cx, "events");
    for event in [
        BotEvent::Started { pid: 4321, compatibility_epoch: Some(197) },
        BotEvent::Status(status(json!({
            "status": {"platform": "telegram", "running": true, "readiness": "credentials_valid",
                       "connection": "polling", "identity": {"username": "maka_test_bot"}}
        }))),
        BotEvent::Host(HostLinkState::Connected { root_id: "r".into(), host_epoch: "e".into() }),
    ] {
        script.events.try_send(event).expect("event");
    }
    cx.run_until_parked();
    service.read_with(cx, |service, _| {
        assert_eq!(service.state(), &BotServiceState::Running { pid: 4321 });
        let telegram = service.channel_status(BotProvider::Telegram).expect("telegram");
        assert_eq!(telegram.status.readiness, BotReadiness::CredentialsValid);
        assert_eq!(service.channel_status(BotProvider::Slack), None);
        assert!(matches!(service.host_link(), Some(HostLinkState::Connected { .. })));
    });

    // A conflict replaces the status, and a crash shows the restart.
    script
        .events
        .try_send(BotEvent::Status(status(json!({
            "status": {"platform": "telegram", "running": false, "readiness": "scaffolded",
                       "reason": "disabled", "connection": "none"},
            "conflict": {"kind": "polling", "detectedAt": 5}
        }))))
        .expect("event");
    script
        .events
        .try_send(BotEvent::Exited {
            reason: "the bot sidecar exited (exit status: 1)".into(),
            restart_in: Duration::from_secs(1),
        })
        .expect("event");
    cx.run_until_parked();
    service.read_with(cx, |service, _| {
        let telegram = service.channel_status(BotProvider::Telegram).expect("telegram");
        assert!(telegram.conflict.is_some());
        assert!(matches!(
            service.state(),
            BotServiceState::Restarting { restart_in, .. } if *restart_in == Duration::from_secs(1)
        ));
        assert_eq!(service.host_link(), None, "the next sidecar reports its own");
    });
}

#[gpui_kit::test]
fn a_channel_test_is_recorded_in_the_settings_and_applied(cx: &mut TestAppContext) {
    let (service, script, _scratch) = attached(cx, "test");
    for _ in 0..2 {
        let (_, reply) = next_request(&script, cx);
        answer(reply, json!({}));
    }
    let task = service.update(cx, |service, cx| service.test_channel(BotProvider::Telegram, cx));
    let (command, reply) = next_request(&script, cx);
    let Command::TestChannel { provider, channel } = command else {
        panic!("a channel test, got {command:?}");
    };
    assert_eq!((provider, channel.token.as_str()), (BotProvider::Telegram, "123:abc"));
    answer(reply, json!({"result": {"ok": false, "errorCode": "token_invalid"}}));
    let (command, reply) = next_request(&script, cx);
    let Command::ApplySettings { settings } = command else {
        panic!("the recorded settings, got {command:?}");
    };
    let telegram = settings.channel(BotProvider::Telegram);
    assert_eq!(telegram.readiness, Some(BotReadiness::Configured));
    assert_eq!(telegram.last_error.as_deref(), Some("token_invalid"));
    answer(reply, json!({}));
    let result = cx.foreground_executor().block_test(task).expect("tested");
    assert_eq!(result.error_code.as_deref(), Some("token_invalid"));
    let saved = service.read_with(cx, |service, _| service.store().clone());
    let saved = block_on(saved.load()).expect("saved");
    assert_eq!(saved.channel(BotProvider::Telegram).last_error.as_deref(), Some("token_invalid"));

    // A refusal from the sidecar reaches the caller.
    let task = service.update(cx, |service, cx| service.restart_channel(BotProvider::Telegram, cx));
    let (_, reply) = next_request(&script, cx);
    answer(reply, json!({}));
    let (command, reply) = next_request(&script, cx);
    assert!(matches!(command, Command::RestartListeners { provider: Some(BotProvider::Telegram) }));
    reply.expect("reply").try_send(Err(BotCommandError::NotRunning)).expect("answered");
    assert!(cx.foreground_executor().block_test(task).is_err());
}

/// Parks until `done` holds of the service, or panics after about 5 s.
fn wait_for(
    service: &Entity<BotService>,
    cx: &mut TestAppContext,
    what: &str,
    done: impl Fn(&BotService) -> bool,
) {
    for _ in 0..500 {
        cx.run_until_parked();
        if service.read_with(cx, |service, _| done(service)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let state = service.read_with(cx, |service, _| format!("{service:?}"));
    panic!("timed out waiting for {what}: {state}");
}

fn local_host() -> BotHost {
    BotHost::Local { state_root: PathBuf::from("/roots/demo") }
}

/// A service over an empty settings file, launching `fake`s.
fn faked(cx: &mut TestAppContext, name: &str, fake: &FakeSidecar) -> (Entity<BotService>, Scratch) {
    cx.executor().allow_parking();
    let dir =
        std::env::temp_dir().join(format!("bots-service-{name}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("scratch");
    let store = Arc::new(BotSettingsStore::new(dir.join("bot-chat.json")));
    let launcher = fake.launcher();
    let service = cx.new(|cx| BotService::new(store, cx).with_launcher(launcher));
    wait_for(&service, cx, "the settings", |service| service.channel(BotProvider::Qq).is_some());
    (service, Scratch(dir))
}

#[gpui_kit::test]
fn a_remote_host_leaves_the_bots_unavailable(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (store, _scratch) = store("remote");
    let service = cx.new(|cx| {
        BotService::new(store, cx)
            .with_launcher(launcher(LaunchOptions::default(), RestartPolicy::default()))
    });
    service.update(cx, |service, cx| service.set_host(Some(BotHost::Remote), cx));
    wait_for(&service, cx, "a refusal", |service| {
        matches!(service.state(), BotServiceState::Unavailable { .. })
    });
    service.read_with(cx, |service, _| {
        let BotServiceState::Unavailable { reason, held_elsewhere } = service.state() else {
            panic!("unavailable, got {:?}", service.state());
        };
        assert!(reason.contains("on this computer"), "{reason}");
        assert!(!held_elsewhere);
    });
}

#[gpui_kit::test]
fn the_sidecar_runs_while_a_channel_is_enabled(cx: &mut TestAppContext) {
    let fake = FakeSidecar::new();
    let (service, _scratch) = faked(cx, "lifecycle", &fake);
    service.update(cx, |service, cx| service.set_host(Some(local_host()), cx));
    cx.run_until_parked();
    assert!(fake.launches().is_empty(), "no channel is enabled");
    assert_eq!(service.read_with(cx, |service, _| service.state().clone()), BotServiceState::Idle);

    let enable = service.update(cx, |service, cx| {
        service.update_channel(BotProvider::Telegram, |channel| channel.enabled = true, cx)
    });
    cx.foreground_executor().block_test(enable).expect("enabled");
    wait_for(&service, cx, "the sidecar", BotService::is_running);
    assert_eq!(fake.launches(), [local_host()]);
    wait_for(&service, cx, "the settings", |_| !fake.commands_named("apply_settings").is_empty());
    let applied = fake.commands_named("apply_settings");
    assert_eq!(
        applied.last().expect("applied")["settings"]["channels"]["telegram"]["enabled"],
        true
    );

    // Another channel on and off keeps it running; the last one off stops it.
    for enabled in [true, false] {
        let change = service.update(cx, |service, cx| {
            service.update_channel(
                BotProvider::Discord,
                move |channel| channel.enabled = enabled,
                cx,
            )
        });
        cx.foreground_executor().block_test(change).expect("changed");
    }
    assert!(service.read_with(cx, |service, _| service.is_running()));
    let disable = service.update(cx, |service, cx| {
        service.update_channel(BotProvider::Telegram, |channel| channel.enabled = false, cx)
    });
    cx.foreground_executor().block_test(disable).expect("disabled");
    wait_for(&service, cx, "the shutdown", |_| !fake.commands_named("shutdown").is_empty());
    assert_eq!(service.read_with(cx, |service, _| service.state().clone()), BotServiceState::Idle);
    assert_eq!(fake.launches().len(), 1);

    // The saved channel starts it again with the next Host.
    let enable = service.update(cx, |service, cx| {
        service.update_channel(BotProvider::Slack, |channel| channel.enabled = true, cx)
    });
    cx.foreground_executor().block_test(enable).expect("enabled");
    wait_for(&service, cx, "the sidecar again", BotService::is_running);
    let stopped = service.update(cx, |service, cx| service.stop(cx));
    cx.foreground_executor().block_test(stopped);
    assert_eq!(fake.launches().len(), 2);
    assert_eq!(service.read_with(cx, |service, _| service.state().clone()), BotServiceState::Idle);
}

#[gpui_kit::test]
fn a_settings_page_holds_the_sidecar_for_a_test(cx: &mut TestAppContext) {
    let fake = FakeSidecar::new();
    let (service, _scratch) = faked(cx, "hold", &fake);
    service.update(cx, |service, cx| {
        service.set_host(Some(local_host()), cx);
        service.hold(cx);
    });
    wait_for(&service, cx, "the sidecar", BotService::is_running);
    fake.answer("test_channel", json!({ "result": { "ok": false, "errorCode": "token_missing" } }));
    let test = service.update(cx, |service, cx| service.test_channel(BotProvider::Telegram, cx));
    let result = cx.foreground_executor().block_test(test).expect("tested");
    assert_eq!(result.error_code.as_deref(), Some("token_missing"));
    let telegram = service.read_with(cx, |service, _| service.channel(BotProvider::Telegram));
    assert_eq!(telegram.expect("telegram").last_error.as_deref(), Some("token_missing"));
    service.update(cx, |service, cx| service.release(cx));
    wait_for(&service, cx, "the shutdown", |_| !fake.commands_named("shutdown").is_empty());
}

fn onboarding_snapshot(state: &str) -> Value {
    json!({
        "sessionId": "s-1", "provider": "feishu", "brand": "lark", "state": state,
        "nextPollAfterMs": 5000, "canOpenInBrowser": true, "identity": { "id": "cli_lark" }
    })
}

#[gpui_kit::test]
fn a_confirmed_scan_is_saved_without_reaching_the_page(cx: &mut TestAppContext) {
    let fake = FakeSidecar::new();
    let (service, _scratch) = faked(cx, "onboarding", &fake);
    service.update(cx, |service, cx| {
        service.set_host(Some(local_host()), cx);
        service.hold(cx);
    });
    wait_for(&service, cx, "the sidecar", BotService::is_running);
    let mut started = onboarding_snapshot("waiting");
    started["qr"] = json!({ "text": "https://accounts.larksuite.com/verify?code=1" });
    fake.answer("onboarding_start", json!({ "snapshot": started }));
    let start = service.update(cx, |service, cx| {
        service.start_onboarding(BotProvider::Feishu, Some(OnboardingBrand::Lark), cx)
    });
    let snapshot = cx.foreground_executor().block_test(start).expect("started");
    assert_eq!(snapshot.state, OnboardingState::Waiting);
    assert_eq!(
        fake.commands_named("onboarding_start")[0],
        json!({ "command": "onboarding_start", "provider": "feishu", "brand": "lark" })
    );

    fake.answer(
        "onboarding_poll",
        json!({
            "snapshot": onboarding_snapshot("connecting"),
            "channel": { "enabled": true, "connected": false, "readiness": "configured",
                         "readinessUpdatedAt": 7, "appId": "cli_lark", "appSecret": "lark-secret",
                         "domain": "larksuite.com" }
        }),
    );
    let mut finished = onboarding_snapshot("connected");
    finished["warningCode"] = json!("saved_not_connected");
    fake.answer("onboarding_finish", json!({ "snapshot": finished }));
    let poll = service.update(cx, |service, cx| service.poll_onboarding("s-1".into(), cx));
    let snapshot = cx.foreground_executor().block_test(poll).expect("polled");
    assert_eq!(snapshot.state, OnboardingState::Connected);
    assert_eq!(snapshot.warning_code.as_deref(), Some("saved_not_connected"));
    assert!(!format!("{snapshot:?}").contains("lark-secret"));

    // Saved, enabled, and applied before the sidecar was asked to finish.
    let names: Vec<_> = fake.commands().iter().map(|command| command["command"].clone()).collect();
    let finish = names.iter().position(|name| name == "onboarding_finish").expect("finish");
    assert_eq!(names[finish - 1], "apply_settings");
    let saved = service.read_with(cx, |service, _| service.store().clone());
    let feishu = block_on(saved.load()).expect("saved").channel(BotProvider::Feishu).clone();
    assert!(feishu.enabled);
    assert_eq!(feishu.app_secret.as_deref(), Some("lark-secret"));
    assert_eq!(feishu.domain.as_deref(), Some("larksuite.com"));
    let summary = service.read_with(cx, |service, _| service.channel(BotProvider::Feishu));
    let summary = summary.expect("summary");
    assert!(summary.has_app_secret && summary.enabled);
    assert!(!format!("{summary:?}").contains("lark-secret"));
}

#[gpui_kit::test]
fn a_cancelled_scan_saves_nothing(cx: &mut TestAppContext) {
    let fake = FakeSidecar::new();
    let (service, _scratch) = faked(cx, "cancelled", &fake);
    service.update(cx, |service, cx| {
        service.set_host(Some(local_host()), cx);
        service.hold(cx);
    });
    wait_for(&service, cx, "the sidecar", BotService::is_running);
    fake.answer("onboarding_cancel", json!({ "snapshot": onboarding_snapshot("cancelled") }));
    fake.answer(
        "onboarding_poll",
        json!({
            "snapshot": onboarding_snapshot("connecting"),
            "channel": { "appId": "cli_lark", "appSecret": "lark-secret" }
        }),
    );
    fake.answer("onboarding_cancel", json!({ "snapshot": onboarding_snapshot("cancelled") }));
    service.update(cx, |service, cx| service.cancel_onboarding("s-1".into(), cx));
    let poll = service.update(cx, |service, cx| service.poll_onboarding("s-1".into(), cx));
    let snapshot = cx.foreground_executor().block_test(poll).expect("polled");
    assert_eq!(snapshot.state, OnboardingState::Cancelled);
    let saved = service.read_with(cx, |service, _| service.store().clone());
    let feishu = block_on(saved.load()).expect("saved").channel(BotProvider::Feishu).clone();
    assert_eq!(feishu.app_secret, None);
    assert!(fake.commands_named("onboarding_finish").is_empty());
}
