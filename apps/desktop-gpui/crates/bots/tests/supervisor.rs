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

//! The supervisor against a fake sidecar (`tests/fixtures/fake-sidecar.sh`),
//! which speaks the stdio protocol without Node or Maka: commands and
//! answers, the replay of the settings to a restarted sidecar, backoff,
//! suspension after `fatal`, the ready and command timeouts, and shutdown.
#![cfg(unix)]
// Tests read the fake's command log and wait in real time.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use bots::{
    BotChannelSettings, BotChatSettings, BotCommandError, BotEvent, BotHandle, BotProvider,
    RestartPolicy, SidecarCommand, SupervisedBots, supervise,
};
use futures_lite::future::block_on;
use host_protocol::WorkspaceTarget;

const WAIT: Duration = Duration::from_secs(10);

struct Fake {
    handle: BotHandle,
    events: async_channel::Receiver<BotEvent>,
    log: PathBuf,
    scratch: PathBuf,
    run: Option<thread::JoinHandle<()>>,
}

impl Fake {
    fn start(mode: &str, policy: RestartPolicy, extra: &[(&str, &Path)]) -> Self {
        let scratch = std::env::temp_dir()
            .join(format!("bots-supervisor-{mode}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&scratch).expect("scratch");
        let log = scratch.join("commands.log");
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-sidecar.sh");
        let mut command = SidecarCommand::new("/bin/sh")
            .arg(script)
            .env("FAKE_SIDECAR_MODE", mode)
            .env("FAKE_SIDECAR_LOG", &log);
        for (key, value) in extra {
            command = command.env(*key, *value);
        }
        let SupervisedBots { handle, run, events, .. } = supervise(command, policy, None);
        let run = thread::spawn(move || block_on(run));
        Self { handle, events, log, scratch, run: Some(run) }
    }

    /// The next event that `pick` accepts; earlier ones are skipped.
    fn next<T>(&self, mut pick: impl FnMut(BotEvent) -> Option<T>) -> T {
        let deadline = Instant::now() + WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = block_on(futures_lite::future::or(
                async { self.events.recv().await.ok() },
                async {
                    async_io::Timer::after(remaining).await;
                    None
                },
            ))
            .expect("an event before the deadline");
            if let Some(picked) = pick(event) {
                return picked;
            }
        }
    }

    fn started(&self) -> u32 {
        self.next(|event| match event {
            BotEvent::Started { pid, compatibility_epoch } => {
                assert_eq!(compatibility_epoch, Some(197));
                Some(pid)
            }
            _ => None,
        })
    }

    /// Each command the fake received: `(pid, command name)`.
    fn commands(&self) -> Vec<(u32, String)> {
        let text = std::fs::read_to_string(&self.log).unwrap_or_default();
        text.lines()
            .map(|line| {
                let (pid, json) = line.split_once(' ').expect("pid and line");
                let value: serde_json::Value = serde_json::from_str(json).expect("command JSON");
                (pid.parse().expect("pid"), value["command"].as_str().expect("command").to_owned())
            })
            .collect()
    }

    /// Shuts the supervisor down and returns the events it sent meanwhile.
    fn shutdown(&mut self) -> Vec<BotEvent> {
        block_on(self.handle.shutdown());
        self.run.take().expect("run").join().expect("supervisor thread");
        let mut rest = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            rest.push(event);
        }
        rest
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        if self.run.is_some() {
            self.shutdown();
        }
        std::fs::remove_dir_all(&self.scratch).ok();
    }
}

fn fast() -> RestartPolicy {
    RestartPolicy::default()
        .with_backoff(Duration::from_millis(20), Duration::from_millis(200))
        .with_timeouts(Duration::from_secs(5), Duration::from_secs(5), Duration::from_secs(2))
}

fn enabled_telegram() -> BotChatSettings {
    let mut settings = BotChatSettings::default();
    let telegram = settings.channel_mut(BotProvider::Telegram);
    telegram.enabled = true;
    telegram.token = "123:abc".into();
    settings
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[test]
fn commands_reach_the_sidecar_and_answers_come_back() {
    let fake = Fake::start("normal", fast(), &[]);
    let pid = fake.started();
    block_on(fake.handle.apply_settings(enabled_telegram())).expect("apply");
    let status = fake.next(|event| match event {
        BotEvent::Status(status) => Some(status),
        _ => None,
    });
    assert_eq!(status.provider(), BotProvider::Telegram);
    assert!(status.status.running);

    let statuses = block_on(fake.handle.list_statuses()).expect("statuses");
    assert_eq!(statuses.len(), 1);
    let result = block_on(
        fake.handle
            .test_channel(BotProvider::Telegram, BotChannelSettings::new(BotProvider::Telegram)),
    )
    .expect("test");
    assert!(result.ok);
    assert_eq!(
        result.identity.and_then(|identity| identity.username).as_deref(),
        Some("maka_test_bot")
    );

    let mut fake = fake;
    let rest = fake.shutdown();
    assert!(!alive(pid), "the sidecar exited on shutdown");
    assert_eq!(rest.last(), Some(&BotEvent::Stopped));
    let names: Vec<_> = fake.commands().into_iter().map(|(_, command)| command).collect();
    assert_eq!(names, ["apply_settings", "list_statuses", "test_channel", "shutdown"]);
}

#[test]
fn a_crashed_sidecar_is_restarted_with_the_settings_and_workspace_replayed() {
    let scratch =
        std::env::temp_dir().join(format!("bots-crash-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let marker = scratch.join("crashed");
    let fake = Fake::start("normal", fast(), &[("FAKE_SIDECAR_CRASH_ONCE", &marker)]);
    let first = fake.started();
    let workspace = WorkspaceTarget::Project { project_id: "p1".into() };
    block_on(fake.handle.set_workspace(Some(workspace))).expect("workspace");
    block_on(fake.handle.apply_settings(enabled_telegram())).expect("apply");

    // The first sidecar exits in the middle of a command.
    let crashed = block_on(
        fake.handle
            .test_channel(BotProvider::Telegram, BotChannelSettings::new(BotProvider::Telegram)),
    );
    assert_eq!(crashed, Err(BotCommandError::Interrupted));
    let restart_in = fake.next(|event| match event {
        BotEvent::Exited { reason, restart_in } => {
            assert!(reason.contains("exit status: 3"), "{reason}");
            Some(restart_in)
        }
        _ => None,
    });
    assert_eq!(restart_in, Duration::from_millis(20));
    let second = fake.started();
    assert_ne!(first, second);
    block_on(
        fake.handle
            .test_channel(BotProvider::Telegram, BotChannelSettings::new(BotProvider::Telegram)),
    )
    .expect("the new sidecar answers");

    // The new sidecar got the settings and the workspace before anything else.
    let second_commands: Vec<_> = fake
        .commands()
        .into_iter()
        .filter(|(pid, _)| *pid == second)
        .map(|(_, command)| command)
        .collect();
    assert_eq!(second_commands[..2], ["apply_settings".to_owned(), "set_workspace".to_owned()]);
    let replayed = std::fs::read_to_string(&fake.log).expect("log");
    let settings_line = replayed
        .lines()
        .find(|line| line.starts_with(&format!("{second} ")) && line.contains("apply_settings"))
        .expect("replayed settings");
    assert!(settings_line.contains(r#""token":"123:abc""#), "{settings_line}");
    drop(fake);
    std::fs::remove_dir_all(scratch).ok();
}

#[test]
fn a_fatal_sidecar_waits_for_a_restart() {
    let fake = Fake::start("fatal", fast(), &[]);
    let reason = fake.next(|event| match event {
        BotEvent::Suspended { reason } => Some(reason),
        BotEvent::Exited { .. } => panic!("a fatal sidecar is not restarted by itself"),
        _ => None,
    });
    assert!(reason.contains("checkout_unavailable"), "{reason}");
    assert!(reason.contains("is not built"), "{reason}");
    // Nothing runs: queries fail, settings are kept for the next sidecar.
    assert_eq!(block_on(fake.handle.list_statuses()), Err(BotCommandError::NotRunning));
    block_on(fake.handle.apply_settings(enabled_telegram())).expect("recorded");
    thread::sleep(Duration::from_millis(100));
    assert!(fake.events.try_recv().is_err(), "no retry without a restart");

    fake.handle.restart();
    fake.next(|event| matches!(event, BotEvent::Suspended { .. }).then_some(()));
}

#[test]
fn a_sidecar_that_never_reports_ready_is_killed_and_retried() {
    let policy = fast().with_timeouts(
        Duration::from_millis(300),
        Duration::from_secs(5),
        Duration::from_secs(2),
    );
    let fake = Fake::start("silent", policy, &[]);
    let reason = fake.next(|event| match event {
        BotEvent::Exited { reason, .. } => Some(reason),
        _ => None,
    });
    assert!(reason.contains("did not report ready"), "{reason}");
    // And again, a little later: it counts as a crash.
    let restart_in = fake.next(|event| match event {
        BotEvent::Exited { restart_in, .. } => Some(restart_in),
        _ => None,
    });
    assert_eq!(restart_in, Duration::from_millis(40));
}

#[test]
fn an_unanswered_command_times_out() {
    let policy = fast().with_timeouts(
        Duration::from_secs(5),
        Duration::from_millis(300),
        Duration::from_secs(2),
    );
    let fake = Fake::start("mute", policy, &[]);
    fake.started();
    let started = Instant::now();
    assert_eq!(
        block_on(fake.handle.apply_settings(enabled_telegram())),
        Err(BotCommandError::TimedOut)
    );
    assert!(started.elapsed() >= Duration::from_millis(300));
    // The sidecar still answers everything else.
    block_on(fake.handle.list_statuses()).expect("statuses");
}

#[test]
fn a_sidecar_that_ignores_shutdown_is_killed_after_the_grace() {
    let policy = fast().with_timeouts(
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_millis(300),
    );
    let mut fake = Fake::start("stubborn", policy, &[]);
    let pid = fake.started();
    let started = Instant::now();
    let rest = fake.shutdown();
    assert!(started.elapsed() >= Duration::from_millis(300));
    assert!(!alive(pid), "killed");
    assert_eq!(rest.last(), Some(&BotEvent::Stopped));
}
