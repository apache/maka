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

//! The About page, after Maka Desktop's
//! (apps/desktop/src/renderer/settings/about-settings-page.tsx): the
//! wordmark over the license and the source and release-notes links, the
//! facts this client knows (version, Host, protocol, data folder, Maka
//! checkout), and Support: Copy diagnostics, Report an issue, Keyboard
//! shortcuts. Desktop's update group is left out: this client has no
//! updater.
//!
//! Copy diagnostics writes a plain-text report to the clipboard, in the
//! shape of Desktop's `formatDesktopDiagnosticReport`
//! (apps/desktop/src/main/main-process-diagnostics.ts): the client's
//! environment with the home folder shown as `~`, the connection, and the
//! Host's own diagnostics (`host.diagnostics.query`) or why they could not
//! be read. Nothing is uploaded.

use gpui_kit::component::button::Button;
use gpui_kit::component::notification::Notification;
use gpui_kit::component::{WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    ClipboardItem, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _,
    Window, div, rems, svg,
};
use host_protocol::{
    HostDiagnostics, HostDiagnosticsResult, HostStatusInput, RUNTIME_HOST_COMPATIBILITY_EPOCH,
};
use shared::copy::settings as settings_copy;
use shared::copy::system as copy;
use shared::copy::{self as shell_copy, Locale};
use shared::domain_element_id;
use shared::icons::MAKA_WORDMARK;
use shared::theme::{ActiveMakaPalette as _, text_link};
use shared::time::iso_time;
use workspace::{
    ConnectionStatus, HostRequestError, HostSession, RetryState, actions::ShowKeyboardShortcuts,
};

use crate::page_kit::{Tone, status_dot};
use crate::rows::{SettingsGroup, SettingsRow, settings_button};
use crate::surface::AboutFacts;

/// Maka's repository and the pages under it that About links to
/// (`REPOSITORY_URL` in about-settings-page.tsx).
pub const REPOSITORY_URL: &str = "https://github.com/apache/maka";
const ISSUES_URL: &str = "https://github.com/apache/maka/issues";
const RELEASES_URL: &str = "https://github.com/apache/maka/releases";

/// The wordmark over the license line: Desktop's 128px wide, at the
/// sidebar wordmark's proportions (69 by 18).
const WORDMARK_WIDTH_REMS: f32 = 8.;
const WORDMARK_HEIGHT_REMS: f32 = 8. * 18. / 69.;

/// Behavior and presentation owner of the About page. Copy diagnostics
/// runs once at a time.
pub struct AboutPage {
    host: Entity<HostSession>,
    about: AboutFacts,
    copying: bool,
    _copy: Option<Task<()>>,
    _subscription: Subscription,
}

impl std::fmt::Debug for AboutPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AboutPage").field("copying", &self.copying).finish_non_exhaustive()
    }
}

impl AboutPage {
    pub fn new(host: Entity<HostSession>, about: AboutFacts, cx: &mut Context<Self>) -> Self {
        let subscription = cx.observe(&host, |_, _, cx| cx.notify());
        Self { host, about, copying: false, _copy: None, _subscription: subscription }
    }

    /// Reads the Host's diagnostics (when connected), writes the report to
    /// the clipboard, and says so.
    pub fn copy_diagnostics(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.copying {
            return;
        }
        self.copying = true;
        let host = self.host.read(cx);
        let connected = host.is_connected();
        let request = connected
            .then(|| host.requester().request::<HostDiagnostics>(&HostStatusInput::default()));
        let environment = Environment {
            app_version: self.about.app_version.to_string(),
            locale: Locale::current(cx).tag().to_owned(),
            state_root: redact_home(&host.root().display().to_string()),
            maka_checkout: self
                .about
                .maka_checkout
                .as_ref()
                .map(|path| redact_home(&path.display().to_string())),
            connection: host.status().label().in_locale(Locale::English).to_owned(),
        };
        let locale = Locale::current(cx);
        self._copy = Some(cx.spawn_in(window, async move |this, cx| {
            let host = match request {
                Some(request) => request.await,
                None => Err(HostRequestError::NotConnected),
            };
            let report = diagnostic_report(&environment, &host, now_ms());
            this.update_in(cx, |this, window, cx| {
                this.copying = false;
                cx.write_to_clipboard(ClipboardItem::new_string(report));
                let copied = Notification::success(copy::ABOUT_PASTE_HINT.in_locale(locale))
                    .title(copy::ABOUT_COPIED.in_locale(locale));
                window.push_notification(copied, cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }
}

impl Render for AboutPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        let host = self.host.read(cx);
        let locale = Locale::current(cx);
        let host_epoch = host.accepted().map(|accepted| accepted.compatibility_epoch);
        let checkout = self
            .about
            .maka_checkout
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| settings_copy::ABOUT_UNKNOWN.get(cx).to_owned());
        // Desktop's `Link type="inherit"` takes the line's size and line
        // height (12/20) but keeps Astryx Link's accent colour, underlined
        // only under the pointer.
        let link = |id: &'static str, label: &str, url: &'static str| {
            text_link(
                Button::new(id),
                label.to_owned(),
                maka.primary,
                rems(0.75),
                gpui_kit::FontWeight::NORMAL,
                cx,
            )
            .on_click(move |_, _, cx| cx.open_url(url))
        };
        // Desktop's `{' · '}`: the spaces are the separator's own, as in
        // the license, so every gap on the line is the same (review round
        // 16).
        let separator = || div().child(" · ");
        let identity = v_flex()
            .gap_4()
            .child(
                svg()
                    .path(MAKA_WORDMARK)
                    .w(rems(WORDMARK_WIDTH_REMS))
                    .h(rems(WORDMARK_HEIGHT_REMS))
                    .text_color(maka.brand),
            )
            .child(
                h_flex()
                    .flex_wrap()
                    .items_center()
                    .text_xs()
                    .line_height(rems(1.25))
                    .text_color(maka.ink_muted)
                    .child(copy::ABOUT_LICENSE.get(cx))
                    .child(separator())
                    .child(link("about-source", copy::ABOUT_SOURCE.get(cx), REPOSITORY_URL))
                    .child(separator())
                    .child(link(
                        "about-release-notes",
                        copy::ABOUT_RELEASE_NOTES.get(cx),
                        RELEASES_URL,
                    )),
            );
        let facts = SettingsGroup::new("about")
            .child(SettingsRow::value(
                "version",
                settings_copy::ABOUT_CLIENT.get(cx),
                self.about.app_version.clone(),
                cx,
            ))
            .child(
                // The Host's name, then its state in the one status recipe
                // (the dot and its words).
                SettingsRow::new("host", settings_copy::ABOUT_HOST.get(cx)).end(
                    h_flex()
                        .id(domain_element_id("settings-value", "host"))
                        .test_support()
                        .aria_label(shell_copy::parts(
                            locale,
                            &[shell_copy::HOST_LOCAL.get(cx), host.status().label().get(cx)],
                        ))
                        .gap_3()
                        .text_sm()
                        .text_color(maka.ink_muted)
                        .child(shell_copy::HOST_LOCAL.get(cx))
                        .child(status_dot(
                            "about-host",
                            host.status().label().get(cx),
                            host_tone(host.status()),
                            cx,
                        )),
                ),
            )
            .child(SettingsRow::value(
                "protocol",
                settings_copy::ABOUT_PROTOCOL.get(cx),
                settings_copy::protocol_epochs(
                    locale,
                    RUNTIME_HOST_COMPATIBILITY_EPOCH,
                    host_epoch,
                ),
                cx,
            ))
            .child(SettingsRow::path(
                "state-root",
                settings_copy::ABOUT_STATE_ROOT.get(cx),
                host.root().display().to_string(),
            ))
            .child(SettingsRow::path(
                "maka-checkout",
                settings_copy::ABOUT_MAKA_CHECKOUT.get(cx),
                checkout,
            ));
        let copy_button = settings_button("about-copy-diagnostics", copy::ABOUT_COPY.get(cx), cx)
            .accessibility_label(copy::ABOUT_COPY_DIAGNOSTICS.get(cx))
            .loading(self.copying)
            .on_click(cx.listener(|this, _, window, cx| this.copy_diagnostics(window, cx)));
        let report = settings_button("about-report-issue", copy::ABOUT_OPEN.get(cx), cx)
            .accessibility_label(copy::ABOUT_REPORT_ISSUE.get(cx))
            .on_click(|_, _, cx| cx.open_url(ISSUES_URL));
        let shortcuts = settings_button("about-shortcuts", copy::ABOUT_VIEW.get(cx), cx)
            .accessibility_label(copy::ABOUT_SHORTCUTS.get(cx))
            .on_click(|_, window, cx| window.dispatch_action(Box::new(ShowKeyboardShortcuts), cx));
        let support = SettingsGroup::new("about-support")
            .title(copy::ABOUT_SUPPORT.get(cx))
            .child(
                SettingsRow::new("copy-diagnostics", copy::ABOUT_COPY_DIAGNOSTICS.get(cx))
                    .detail(copy::ABOUT_COPY_HELP.get(cx))
                    .end(copy_button),
            )
            .child(
                SettingsRow::new("report-issue", copy::ABOUT_REPORT_ISSUE.get(cx))
                    .detail(copy::ABOUT_REPORT_ISSUE_HELP.get(cx))
                    .end(report),
            )
            .child(
                SettingsRow::new("keyboard-shortcuts", copy::ABOUT_SHORTCUTS.get(cx))
                    .detail(copy::ABOUT_SHORTCUTS_HELP.get(cx))
                    .end(shortcuts),
            );
        v_flex().w_full().gap_8().child(identity).child(facts).child(support)
    }
}

/// What the report says about this client.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Environment {
    app_version: String,
    locale: String,
    state_root: String,
    maka_checkout: Option<String>,
    /// The connection's state, in English.
    connection: String,
}

/// `path` with the home folder shown as `~`.
fn redact_home(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && (path == home || path.starts_with(&format!("{home}/"))) => {
            format!("~{}", &path[home.len()..])
        }
        _ => path.to_owned(),
    }
}

/// Now, in milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// The report, as Desktop lays its sections out: the capture, this
/// client's environment, the connection, and the Runtime Host's
/// diagnostics or the reason they are missing.
fn diagnostic_report(
    environment: &Environment,
    host: &Result<HostDiagnosticsResult, HostRequestError>,
    captured_at_ms: u64,
) -> String {
    let mut lines = vec![
        "Maka GPUI diagnostic report".to_owned(),
        format!("Captured at: {}", iso_time(captured_at_ms)),
        String::new(),
        "Capture".to_owned(),
        "Surface: manual".to_owned(),
        String::new(),
        "Environment".to_owned(),
        format!("Maka GPUI: {}", environment.app_version),
        format!("Protocol: compatibility {RUNTIME_HOST_COMPATIBILITY_EPOCH}"),
        format!("OS: {} ({})", std::env::consts::OS, std::env::consts::ARCH),
        format!("Locale: {}", environment.locale),
        format!("Data folder: {}", environment.state_root),
        format!(
            "Maka checkout: {}",
            environment.maka_checkout.as_deref().unwrap_or("<not configured>")
        ),
        String::new(),
        "Runtime Host connection".to_owned(),
        format!("Local: {}", environment.connection),
        String::new(),
        "Runtime Host".to_owned(),
    ];
    match host {
        Ok(host) => {
            lines.extend([
                format!("Epoch: {}", host.host_epoch),
                format!(
                    "Protocol: v{} · compatibility {}",
                    host.protocol_version, host.compatibility_epoch
                ),
                format!("State: {}", host.state),
                format!("Process: {} · uptime {}s", host.pid, host.process_uptime_seconds),
                format!(
                    "Runtime: Node {} · {} {} ({})",
                    host.node_version, host.platform, host.os_release, host.arch
                ),
                format!(
                    "Activity: {} connections · {} operations · {} residencies",
                    host.connections, host.active_operations, host.active_residencies
                ),
                format!("Recent Runtime Host logs ({})", host.logs.len()),
            ]);
            if host.logs.is_empty() {
                lines.push("<none captured>".to_owned());
            } else {
                lines.extend(host.logs.iter().cloned());
            }
        }
        Err(HostRequestError::NotConnected) => {
            lines.push("Error: Runtime Host is unavailable".to_owned());
        }
        Err(error) => lines.push(format!("Error: {error}")),
    }
    let mut report = lines.join("\n");
    report.push('\n');
    report
}

/// How the Host's state reads in its status dot.
fn host_tone(status: &ConnectionStatus) -> Tone {
    match status {
        ConnectionStatus::Connected => Tone::Success,
        ConnectionStatus::Disconnected { retry: RetryState::Suspended, .. } => Tone::Error,
        ConnectionStatus::Disconnected { .. } => Tone::Attention,
        _ => Tone::Neutral,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn environment() -> Environment {
        Environment {
            app_version: "0.1.0".into(),
            locale: "en".into(),
            state_root: "~/maka/dev".into(),
            maka_checkout: None,
            connection: "Connected".into(),
        }
    }

    #[test]
    fn the_report_carries_the_hosts_diagnostics() {
        let host: HostDiagnosticsResult = serde_json::from_value(json!({
            "hostEpoch": "e1", "compositionId": "maka.interactive", "compositionRevision": "3",
            "state": "ready", "connections": 2, "activeOperations": 1, "activeResidencies": 0,
            "upgradeBlockingActivity": false, "compositionModules": [], "residencies": [],
            "protocolVersion": 0, "compatibilityEpoch": 197, "pid": 42,
            "processUptimeSeconds": 61, "nodeVersion": "v24.18.0", "platform": "darwin",
            "arch": "arm64", "osRelease": "25.6.0", "logs": ["[info] ready"]
        }))
        .expect("diagnostics");
        let report = diagnostic_report(&environment(), &Ok(host), 1_790_000_000_000);
        let lines: Vec<&str> = report.lines().collect();
        assert_eq!(lines[0], "Maka GPUI diagnostic report");
        assert_eq!(lines[1], "Captured at: 2026-09-21T14:13:20.000Z");
        assert!(lines.contains(&"Data folder: ~/maka/dev"));
        assert!(lines.contains(&"Maka checkout: <not configured>"));
        assert!(lines.contains(&"Epoch: e1"));
        assert!(lines.contains(&"Protocol: v0 · compatibility 197"));
        assert!(lines.contains(&"Runtime: Node v24.18.0 · darwin 25.6.0 (arm64)"));
        assert!(lines.contains(&"Activity: 2 connections · 1 operations · 0 residencies"));
        assert_eq!(&lines[lines.len() - 2..], ["Recent Runtime Host logs (1)", "[info] ready"]);
    }

    #[test]
    fn a_missing_host_says_why() {
        let report = diagnostic_report(&environment(), &Err(HostRequestError::NotConnected), 0);
        assert!(report.ends_with("Runtime Host\nError: Runtime Host is unavailable\n"));
        let failed = Err(HostRequestError::Transport("timed out".into()));
        let report = diagnostic_report(&environment(), &failed, 0);
        assert!(report.ends_with("Error: timed out\n"));
    }

    #[test]
    fn the_home_folder_reads_as_a_tilde() {
        let home = std::env::var("HOME").expect("home");
        assert_eq!(redact_home(&format!("{home}/maka")), "~/maka");
        assert_eq!(redact_home("/tmp/maka"), "/tmp/maka");
        assert_eq!(redact_home(&format!("{home}er/x")), format!("{home}er/x"));
    }
}
