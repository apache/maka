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

//! The General page's Network group: the proxy AI model requests go
//! through, after Maka Desktop's `NetworkProxySection`
//! (general-settings-page.tsx): the switch, the protocol, server and port,
//! authentication with a username and a password, the bypass list, and
//! "Test current configuration".
//!
//! The proxy and its password are one write,
//! `runtime.policy.network-proxy.update` ([`HostPolicy::update_proxy`]).
//! The password goes to the Host's vault and never comes back: the field
//! is write-only, empty once its value is sent (saved or not), and says
//! "Password saved" when the vault has one (`credential.vault.query`).

use std::collections::HashMap;

use gpui_kit::component::Disableable as _;
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::{
    App, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Subscription, Task, Window, div,
};
use host_protocol::{
    NetworkProxyPolicy, NetworkProxyTest, NetworkProxyTestInput, NetworkProxyTestResult,
    ProxyProtocol,
};
use shared::copy::conversation::FOOTER_SEPARATOR;
use shared::copy::settings as copy;
use shared::copy::{Locale, Text, failure};
use workspace::HostSession;

use crate::policy::{HostPolicy, ProxyPassword, Refusal, host_error_reason};
use crate::rows::{
    ActionRow, Choice, ChoiceSelect, FieldBlock, SettingsGroup, SettingsRow, StatusKind,
    StatusLine, TextSetting, TextSettingEvent, settings_button, sync_choices,
};

/// The protocols in Desktop's order, by its labels (protocol names, the
/// same in every language).
fn protocol_choices() -> Vec<Choice<ProxyProtocol>> {
    vec![
        Choice::new(ProxyProtocol::Http, "HTTP/HTTPS"),
        Choice::new(ProxyProtocol::Https, "HTTPS"),
        Choice::new(ProxyProtocol::Socks5, "SOCKS5"),
    ]
}

/// The bypass list as its field shows it.
fn bypass_text(proxy: &NetworkProxyPolicy) -> String {
    proxy.bypass_list.join(", ")
}

/// A comma-separated list as the bypass list (Desktop's `csvList`).
fn bypass_list(text: &str) -> Vec<String> {
    text.split(',').map(str::trim).filter(|part| !part.is_empty()).map(str::to_owned).collect()
}

/// Where "Test current configuration" stands.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ProxyTestState {
    Idle,
    /// Asked for while a change was in flight: it runs once that is answered.
    Waiting,
    Testing,
    Done(StatusKind, SharedString),
}

/// What a proxy test found, as its line says it (Desktop's
/// `proxyTestFailure` and `settingsTestResultMessage`): reachable, with the
/// endpoint, where the probe was seen from, and how long it took; or why
/// not.
fn test_line(
    result: &NetworkProxyTestResult,
    proxy: &NetworkProxyPolicy,
    locale: Locale,
) -> (StatusKind, String) {
    let separator = FOOTER_SEPARATOR.in_locale(locale);
    if result.ok {
        let endpoint = format!("{}://{}:{}", proxy.protocol, proxy.host, proxy.port);
        let location = result.ip.as_deref().map(|ip| match result.country_flag.as_deref() {
            Some(flag) => format!("{flag} {ip}"),
            None => ip.to_owned(),
        });
        let mut parts = vec![copy::PROXY_RESULT_REACHABLE.in_locale(locale).to_owned(), endpoint];
        parts.extend(location);
        parts.push(copy::proxy_latency(locale, result.latency_ms));
        return (StatusKind::Info, parts.join(separator));
    }
    let error = result.error.as_deref().unwrap_or_default().to_lowercase();
    let message = if error.contains("proxy disabled") {
        copy::PROXY_RESULT_DISABLED.in_locale(locale).to_owned()
    } else if error.contains("proxy host/port required") {
        copy::PROXY_RESULT_CONFIGURATION_MISSING.in_locale(locale).to_owned()
    } else if error.contains("proxy credential is not configured") {
        copy::PROXY_RESULT_CREDENTIAL_MISSING.in_locale(locale).to_owned()
    } else if error.contains("timeout") {
        copy::PROXY_RESULT_TIMEOUT.in_locale(locale).to_owned()
    } else if let Some(status) = result.status {
        copy::proxy_http_status(locale, status)
    } else {
        copy::PROXY_RESULT_UNREACHABLE.in_locale(locale).to_owned()
    };
    (StatusKind::Error, failure(locale, copy::PROXY_TEST_FAILED.in_locale(locale), &message))
}

/// Behavior and presentation owner of the Network group.
///
/// The switches and the protocol save as they change; the server, port,
/// username, and bypass list when their field is committed (Enter, or
/// leaving it; Escape puts the saved value back); the password likewise,
/// replacing the saved one. The new value shows at once; a refusal puts the
/// saved one back and says why under the row it came from. The test probes
/// the proxy as saved, after any change in flight.
pub struct NetworkSection {
    host: Entity<HostSession>,
    policy: Entity<HostPolicy>,
    protocol: Entity<ChoiceSelect<ProxyProtocol>>,
    server: Entity<TextSetting>,
    port: Entity<TextSetting>,
    username: Entity<TextSetting>,
    password: Entity<TextSetting>,
    bypass: Entity<TextSetting>,
    /// Why a row's last change was refused, by the row's key.
    errors: HashMap<&'static str, SharedString>,
    saving: bool,
    test: ProxyTestState,
    _save: Option<Task<()>>,
    _test: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for NetworkSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NetworkSection")
            .field("errors", &self.errors)
            .field("test", &self.test)
            .finish_non_exhaustive()
    }
}

impl NetworkSection {
    pub fn new(
        host: Entity<HostSession>,
        policy: Entity<HostPolicy>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let protocol = cx.new(|cx| ChoiceSelect::new(protocol_choices(), None, window, cx));
        let field = |label: Text, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| TextSetting::new(label, "", window, cx))
        };
        let server = field(copy::PROXY_HOST, window, cx);
        let port = field(copy::PROXY_PORT, window, cx);
        let username = field(copy::PROXY_USERNAME, window, cx);
        let password = field(copy::PROXY_PASSWORD, window, cx);
        let bypass = field(copy::PROXY_BYPASS, window, cx);
        password.update(cx, |password, cx| {
            password.input().update(cx, |input, cx| input.set_masked(true, window, cx));
        });
        server.update(cx, |field, cx| field.set_placeholder("127.0.0.1", window, cx));
        port.update(cx, |field, cx| field.set_placeholder("7890", window, cx));
        bypass.update(cx, |field, cx| field.set_placeholder("metaso.cn, baidu.com", window, cx));
        let committed = |key: &'static str| {
            move |this: &mut Self,
                  _: &Entity<TextSetting>,
                  event: &TextSettingEvent,
                  window: &mut Window,
                  cx: &mut Context<Self>| {
                let TextSettingEvent::Committed(value) = event;
                this.commit_field(key, value.clone(), window, cx);
            }
        };
        let subscriptions = vec![
            cx.subscribe_in(
                &protocol,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<ProxyProtocol>>>, window, cx| {
                    if let SelectEvent::Confirm(Some(protocol)) = event {
                        let protocol = protocol.clone();
                        this.change(
                            "proxy-server",
                            copy::PROXY_SAVE_FAILED,
                            window,
                            cx,
                            move |p| p.protocol = protocol.clone(),
                        );
                    }
                },
            ),
            cx.subscribe_in(&server, window, committed("proxy-server")),
            cx.subscribe_in(&port, window, committed("proxy-port")),
            cx.subscribe_in(&username, window, committed("proxy-username")),
            cx.subscribe_in(&password, window, committed("proxy-password")),
            cx.subscribe_in(&bypass, window, committed("proxy-bypass")),
            cx.observe_in(&policy, window, |this, policy, window, cx| {
                this.sync(window, cx);
                if this.test == ProxyTestState::Waiting && !policy.read(cx).is_saving() {
                    this.test_proxy(window, cx);
                }
                cx.notify();
            }),
            cx.observe_global_in::<Locale>(window, |this, window, cx| this.sync(window, cx)),
            cx.observe(&host, |_, _, cx| cx.notify()),
        ];
        let mut this = Self {
            host,
            policy,
            protocol,
            server,
            port,
            username,
            password,
            bypass,
            errors: HashMap::new(),
            saving: false,
            test: ProxyTestState::Idle,
            _save: None,
            _test: None,
            _subscriptions: subscriptions,
        };
        this.sync(window, cx);
        this
    }

    /// The text field of `key` (`server`, `port`, `username`, `password`,
    /// `bypass`), for tests that type into it.
    #[cfg(test)]
    pub(crate) fn field(&self, key: &str) -> &Entity<TextSetting> {
        match key {
            "server" => &self.server,
            "port" => &self.port,
            "username" => &self.username,
            "password" => &self.password,
            _ => &self.bypass,
        }
    }

    /// Whether a change is in flight (a test is not one: leaving drops it).
    pub fn is_busy(&self) -> bool {
        self.saving
    }

    /// The proxy as the page shows it.
    fn proxy(&self, cx: &App) -> Option<NetworkProxyPolicy> {
        self.policy.read(cx).policy().map(|policy| policy.network_proxy.clone())
    }

    /// Brings the fields up to the proxy as the Host has it (a field being
    /// edited keeps its text), and the password's placeholder up to whether
    /// one is saved.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let proxy = self.proxy(cx);
        let protocol = proxy.as_ref().map(|proxy| proxy.protocol.clone());
        sync_choices(&self.protocol, protocol_choices(), protocol.as_ref(), window, cx);
        let Some(proxy) = proxy else {
            return;
        };
        let editable = self.host.read(cx).is_connected() && !self.policy.read(cx).is_saving();
        for (field, value) in [
            (&self.server, proxy.host.clone()),
            (&self.port, proxy.port.to_string()),
            (&self.username, proxy.username.clone()),
            (&self.bypass, bypass_text(&proxy)),
        ] {
            field.update(cx, |field, cx| {
                field.set_committed(value, window, cx);
                field.set_disabled(!editable, cx);
            });
        }
        let placeholder = if self.policy.read(cx).proxy_password_saved() {
            copy::PROXY_PASSWORD_SAVED.get(cx)
        } else {
            ""
        };
        self.password.update(cx, |password, cx| {
            password.set_placeholder(placeholder, window, cx);
            password.set_disabled(!editable, cx);
        });
    }

    /// Puts the proxy's value back in the field of the row `key`, even while
    /// it is being edited.
    fn revert(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(proxy) = self.proxy(cx) else {
            return;
        };
        let (field, value) = match key {
            "proxy-server" => (&self.server, proxy.host.clone()),
            "proxy-port" => (&self.port, proxy.port.to_string()),
            "proxy-username" => (&self.username, proxy.username.clone()),
            "proxy-bypass" => (&self.bypass, bypass_text(&proxy)),
            _ => return,
        };
        field.update(cx, |field, cx| field.reset(value, window, cx));
    }

    /// A committed field: the server, port, username, bypass list, or a
    /// new password.
    fn commit_field(
        &mut self,
        key: &'static str,
        value: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let what = copy::PROXY_SAVE_FAILED;
        match key {
            "proxy-server" => {
                let host = value.trim().to_owned();
                self.change(key, what, window, cx, move |proxy| proxy.host = host.clone());
            }
            "proxy-port" => match value.trim().parse::<u16>() {
                Ok(port) if port > 0 => {
                    self.change(key, what, window, cx, move |proxy| proxy.port = port);
                }
                _ => {
                    self.errors.insert(key, copy::PROXY_PORT_INVALID.get(cx).into());
                    self.revert(key, window, cx);
                    cx.notify();
                }
            },
            "proxy-username" => {
                let username = value.trim().to_owned();
                self.change(key, what, window, cx, move |proxy| proxy.username = username.clone());
            }
            "proxy-bypass" => {
                let list = bypass_list(&value);
                self.change(key, what, window, cx, move |proxy| proxy.bypass_list = list.clone());
            }
            "proxy-password" => {
                // The secret leaves the field for the Host whatever it
                // answers; a refused one is typed again.
                self.password.update(cx, |password, cx| password.clear(window, cx));
                if !value.is_empty() {
                    let password = ProxyPassword::Replace(value.to_string());
                    self.send(key, what, password, window, cx, |_| {});
                }
            }
            _ => {}
        }
    }

    /// Changes the proxy as `edit` does to it, keeping the password.
    fn change(
        &mut self,
        key: &'static str,
        what: Text,
        window: &mut Window,
        cx: &mut Context<Self>,
        edit: impl Fn(&mut NetworkProxyPolicy) + 'static,
    ) {
        self.send(key, what, ProxyPassword::Keep, window, cx, edit);
    }

    /// Sends the proxy `edit` makes, with `password`, for the row `key`.
    fn send(
        &mut self,
        key: &'static str,
        what: Text,
        password: ProxyPassword,
        window: &mut Window,
        cx: &mut Context<Self>,
        edit: impl Fn(&mut NetworkProxyPolicy) + 'static,
    ) {
        let locale = Locale::current(cx);
        let change = move |proxy: &NetworkProxyPolicy| {
            let mut proxy = proxy.clone();
            edit(&mut proxy);
            proxy
        };
        let task =
            self.policy.update(cx, |policy, cx| policy.update_proxy(change, password, locale, cx));
        let Some(task) = task else {
            // Another change runs: the fields show the proxy again.
            self.sync(window, cx);
            return;
        };
        self.errors.remove(key);
        self.saving = true;
        self._save = Some(cx.spawn_in(window, async move |this, cx| {
            let result: Result<(), Refusal> = task.await;
            this.update_in(cx, |this, window, cx| {
                this._save = None;
                this.saving = false;
                if let Err(refusal) = result {
                    let what = what.in_locale(locale);
                    this.errors.insert(key, failure(locale, what, refusal.reason()).into());
                    this.revert(key, window, cx);
                }
                this.sync(window, cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn set_enabled(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.change("proxy", copy::PROXY_SAVE_FAILED, window, cx, move |proxy| proxy.enabled = on);
    }

    fn set_auth(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !on {
            // Off deletes the saved password; nothing typed survives it.
            self.password.update(cx, |password, cx| password.clear(window, cx));
        }
        self.change("proxy-auth", copy::PROXY_SAVE_FAILED, window, cx, move |proxy| {
            proxy.auth_enabled = on
        });
    }

    /// Probes the proxy as saved (`network-proxy.test`), after the change in
    /// flight, if one is.
    pub fn test_proxy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.test == ProxyTestState::Testing {
            return;
        }
        if self.policy.read(cx).is_saving() {
            self.test = ProxyTestState::Waiting;
            cx.notify();
            return;
        }
        let Some(proxy) = self.proxy(cx) else {
            return;
        };
        let locale = Locale::current(cx);
        let request = self
            .host
            .read(cx)
            .requester()
            .request::<NetworkProxyTest>(&NetworkProxyTestInput::through(proxy.clone()));
        self.test = ProxyTestState::Testing;
        self._test = Some(cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this._test = None;
                let (kind, line) = match result {
                    Ok(result) => test_line(&result, &proxy, locale),
                    Err(error) => {
                        let what = copy::PROXY_TEST_ERROR.in_locale(locale);
                        let reason = host_error_reason(&error, locale);
                        (StatusKind::Error, failure(locale, what, &reason))
                    }
                };
                this.test = ProxyTestState::Done(kind, line.into());
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn status(&self, keys: &[&'static str]) -> Option<StatusLine> {
        keys.iter().find_map(|key| {
            self.errors.get(key).map(|error| StatusLine::error(*key, error.clone()))
        })
    }

    fn toggle(
        &self,
        key: &'static str,
        title: Text,
        detail: Text,
        checked: bool,
        editable: bool,
        set: fn(&mut Self, bool, &mut Window, &mut Context<Self>),
        cx: &mut Context<Self>,
    ) -> SettingsRow {
        let this = cx.weak_entity();
        SettingsRow::toggle(key, title.get(cx), checked, !editable, move |on, window, cx| {
            this.update(cx, |this, cx| set(this, *on, window, cx)).ok();
        })
        .detail(detail.get(cx))
        .status(self.status(&[key]))
    }
}

impl Render for NetworkSection {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let group = SettingsGroup::new("network")
            .title(copy::NETWORK.get(cx))
            .description(copy::NETWORK_HELP.get(cx));
        let Some(proxy) = self.proxy(cx) else {
            let row = SettingsRow::loading("proxy", copy::PROXY.get(cx), 6., cx)
                .detail(copy::PROXY_HELP.get(cx));
            return group.child(row);
        };
        let editable = self.host.read(cx).is_connected() && !self.policy.read(cx).is_saving();
        let enabled = self.toggle(
            "proxy",
            copy::PROXY,
            copy::PROXY_HELP,
            proxy.enabled,
            editable,
            Self::set_enabled,
            cx,
        );
        let group = group.child(enabled);
        if !proxy.enabled {
            return group;
        }
        let server = FieldBlock::new("proxy-server")
            .field(
                copy::PROXY_PROTOCOL.get(cx),
                Select::new(&self.protocol)
                    .id("proxy-protocol")
                    .accessibility_label(copy::PROXY_PROTOCOL.get(cx))
                    .disabled(!editable),
            )
            .field(copy::PROXY_HOST.get(cx), self.server.clone())
            .field(copy::PROXY_PORT.get(cx), self.port.clone())
            .status(self.status(&["proxy-server", "proxy-port"]));
        let auth = self.toggle(
            "proxy-auth",
            copy::PROXY_AUTH,
            copy::PROXY_AUTH_HELP,
            proxy.auth_enabled,
            editable,
            Self::set_auth,
            cx,
        );
        let credentials = proxy.auth_enabled.then(|| {
            FieldBlock::new("proxy-credentials")
                .field(copy::PROXY_USERNAME.get(cx), self.username.clone())
                .field(copy::PROXY_PASSWORD.get(cx), self.password.clone())
                .status(self.status(&["proxy-username", "proxy-password"]))
        });
        let bypass = FieldBlock::new("proxy-bypass")
            .field(copy::PROXY_BYPASS.get(cx), self.bypass.clone())
            .help(copy::proxy_bypass_help(Locale::current(cx), proxy.auto_bypass_domains.len()))
            .status(self.status(&["proxy-bypass"]));
        let testing = matches!(self.test, ProxyTestState::Waiting | ProxyTestState::Testing);
        let label = if testing { copy::PROXY_TESTING } else { copy::PROXY_TEST };
        let test = settings_button("proxy-test", label.get(cx), cx)
            .loading(testing)
            .disabled(!self.host.read(cx).is_connected() || testing)
            .on_click(cx.listener(|this, _, window, cx| this.test_proxy(window, cx)));
        let result = match &self.test {
            ProxyTestState::Done(kind, line) => {
                Some(div().w_full().child(StatusLine::new("proxy-test", *kind, line.clone())))
            }
            _ => None,
        };
        group
            .field(server)
            .child(auth)
            .field(credentials)
            .field(bypass)
            .child(ActionRow::new("proxy-test").child(test).children(result))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn proxy() -> NetworkProxyPolicy {
        serde_json::from_value(json!({"enabled": true, "protocol": "http", "host": "127.0.0.1",
            "port": 7890, "authEnabled": false, "username": "", "bypassList": [],
            "autoBypassDomains": []}))
        .expect("proxy")
    }

    fn result(value: serde_json::Value) -> NetworkProxyTestResult {
        serde_json::from_value(value).expect("result")
    }

    #[test]
    fn a_test_says_what_it_found_as_desktop_does() {
        let en = Locale::English;
        let (kind, line) = test_line(
            &result(json!({"ok": true, "latencyMs": 120, "ip": "203.0.113.4",
                           "countryFlag": "🇸🇬"})),
            &proxy(),
            en,
        );
        assert_eq!(kind, StatusKind::Info);
        assert_eq!(
            line,
            "The proxy is reachable · http://127.0.0.1:7890 · 🇸🇬 203.0.113.4 · 120 ms"
        );
        for (error, status, expected) in [
            ("proxy disabled", None, copy::PROXY_RESULT_DISABLED.en().to_owned()),
            (
                "Proxy host/port required",
                None,
                copy::PROXY_RESULT_CONFIGURATION_MISSING.en().to_owned(),
            ),
            (
                "proxy credential is not configured",
                None,
                copy::PROXY_RESULT_CREDENTIAL_MISSING.en().to_owned(),
            ),
            ("proxy test timeout", None, copy::PROXY_RESULT_TIMEOUT.en().to_owned()),
            ("bad gateway", Some(502), copy::proxy_http_status(en, 502)),
            ("ECONNREFUSED", None, copy::PROXY_RESULT_UNREACHABLE.en().to_owned()),
        ] {
            let mut value = json!({"ok": false, "latencyMs": 3, "error": error});
            if let Some(status) = status {
                value["status"] = json!(status);
            }
            let (kind, line) = test_line(&result(value), &proxy(), en);
            assert_eq!(kind, StatusKind::Error);
            assert_eq!(line, failure(en, copy::PROXY_TEST_FAILED.en(), &expected), "{error}");
        }
    }

    #[test]
    fn the_bypass_list_is_comma_separated() {
        assert_eq!(bypass_list(" a.cn, ,b.com ,"), ["a.cn", "b.com"]);
        let mut with_list = proxy();
        with_list.bypass_list = bypass_list("a.cn,b.com");
        assert_eq!(bypass_text(&with_list), "a.cn, b.com");
    }
}
