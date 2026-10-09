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

//! Configure manually: the form under Other Hosts that adds a Runtime Host
//! by its connection details, after the `showAdd` rows of Desktop's
//! `RuntimeHostProfilesSection` (`createTransport`, `draftComplete`).
//!
//! TLS takes a `wss:` URL; a plain WebSocket a `ws:` URL and the plaintext
//! acknowledgement; an SSH tunnel an OpenSSH destination and either the
//! port and path of a Host that already listens there (Desktop's manual
//! SSH) or the operator that starts one (the activation Desktop's guided
//! setup saves). All take the State Root id and the access credential.
//! Save and enable hands the profile to [`HostDirectory::add_manual`],
//! which reaches the Host, pairs, and enables it; the form shows that it
//! is verifying, and why it did not work.
//!
//! The form is one plate (radius 12, a 1px `border` ring, 16px padding):
//! its title at the top, the fields as rows, then Cancel and Save and
//! enable at the bottom right.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window, div,
    rems,
};
use host_protocol::{
    AccessCredential, DEFAULT_WEBSOCKET_PATH, OperatorCommand, OperatorPlatform, RemoteTransport,
    SshTransport, is_canonical_websocket_path,
};
use shared::copy::remote_hosts as copy;
use shared::copy::settings::CANCEL;
use shared::copy::{Locale, Text, failure};
use shared::domain_element_id;
use shared::theme::FadedSwitch;
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, RADIUS_MODAL, control_button, quiet_button, segment, segmented_track,
};
use workspace::{AddMethod, HostAction, HostDirectory, HostOutcome, RemoteHostProfile};

use crate::rows::{SettingsRow, StatusLine};
use crate::runtime_host_section::refusal_text;

/// The width of a field at a row's end: the row kit's end cap.
const FIELD_WIDTH_REMS: f32 = 20.;

/// How the Host is reached (`RuntimeHostRemoteTransport["kind"]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TransportChoice {
    Tls,
    Ssh,
    Plaintext,
}

impl TransportChoice {
    const ALL: [Self; 3] = [Self::Tls, Self::Ssh, Self::Plaintext];

    fn key(self) -> &'static str {
        match self {
            Self::Tls => "tls",
            Self::Ssh => "ssh",
            Self::Plaintext => "plaintext",
        }
    }

    fn label(self) -> Text {
        match self {
            Self::Tls => copy::TRANSPORT_TLS,
            Self::Ssh => copy::TRANSPORT_SSH,
            Self::Plaintext => copy::TRANSPORT_PLAINTEXT,
        }
    }
}

/// Over SSH: a Host that listens there, or one its operator starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SshHostChoice {
    Listening,
    Operator,
}

/// The form's text fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ManualField {
    Name,
    Url,
    Destination,
    SshPort,
    RemotePort,
    WebSocketPath,
    NodePath,
    ModulePath,
    RootId,
    Credential,
}

/// Behavior and presentation owner of the manual form: its fields and
/// choices until Save and enable hands them to the [`HostDirectory`].
pub struct ManualHostForm {
    directory: Entity<HostDirectory>,
    transport: TransportChoice,
    ssh_host: SshHostChoice,
    platform: OperatorPlatform,
    plaintext_acknowledged: bool,
    name: Entity<InputState>,
    url: Entity<InputState>,
    destination: Entity<InputState>,
    ssh_port: Entity<InputState>,
    remote_port: Entity<InputState>,
    websocket_path: Entity<InputState>,
    node_path: Entity<InputState>,
    module_path: Entity<InputState>,
    root_id: Entity<InputState>,
    credential: Entity<InputState>,
    /// Why the details do not make a profile (a URL that is not one).
    error: Option<SharedString>,
    _subscriptions: Vec<Subscription>,
}

/// What the form asks of the section that shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ManualHostFormEvent {
    /// Cancel: close the form.
    Cancelled,
}

impl EventEmitter<ManualHostFormEvent> for ManualHostForm {}

impl std::fmt::Debug for ManualHostForm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManualHostForm")
            .field("transport", &self.transport)
            .field("ssh_host", &self.ssh_host)
            .finish_non_exhaustive()
    }
}

impl ManualHostForm {
    pub fn new(
        directory: Entity<HostDirectory>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let field = |placeholder: &str, window: &mut Window, cx: &mut Context<Self>| {
            let placeholder = placeholder.to_owned();
            cx.new(|cx| InputState::new(window, cx).placeholder(placeholder))
        };
        let name = field("", window, cx);
        let url = field("wss://host.example", window, cx);
        let destination = field("user@host.example", window, cx);
        let ssh_port = field("22", window, cx);
        let remote_port = field("8765", window, cx);
        let websocket_path = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(DEFAULT_WEBSOCKET_PATH)
                .default_value(DEFAULT_WEBSOCKET_PATH)
        });
        let node_path = field("/usr/local/bin/node", window, cx);
        let module_path = field("/opt/maka/operator.mjs", window, cx);
        let root_id = field("", window, cx);
        let credential = cx.new(|cx| InputState::new(window, cx).masked(true));
        let mut subscriptions = vec![cx.observe(&directory, |_, _, cx| cx.notify())];
        for input in [
            &name,
            &url,
            &destination,
            &ssh_port,
            &remote_port,
            &websocket_path,
            &node_path,
            &module_path,
            &root_id,
            &credential,
        ] {
            subscriptions.push(cx.subscribe(input, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.error = None;
                    cx.notify();
                }
            }));
        }
        Self {
            directory,
            transport: TransportChoice::Tls,
            ssh_host: SshHostChoice::Listening,
            platform: OperatorPlatform::Posix,
            plaintext_acknowledged: false,
            name,
            url,
            destination,
            ssh_port,
            remote_port,
            websocket_path,
            node_path,
            module_path,
            root_id,
            credential,
            error: None,
            _subscriptions: subscriptions,
        }
    }

    /// The field `field`.
    pub fn input(&self, field: ManualField) -> &Entity<InputState> {
        match field {
            ManualField::Name => &self.name,
            ManualField::Url => &self.url,
            ManualField::Destination => &self.destination,
            ManualField::SshPort => &self.ssh_port,
            ManualField::RemotePort => &self.remote_port,
            ManualField::WebSocketPath => &self.websocket_path,
            ManualField::NodePath => &self.node_path,
            ManualField::ModulePath => &self.module_path,
            ManualField::RootId => &self.root_id,
            ManualField::Credential => &self.credential,
        }
    }

    pub fn set_transport(
        &mut self,
        transport: TransportChoice,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.transport != transport {
            self.transport = transport;
            self.error = None;
            let placeholder = if transport == TransportChoice::Plaintext {
                "ws://host.example"
            } else {
                "wss://host.example"
            };
            self.url.update(cx, |url, cx| url.set_placeholder(placeholder, window, cx));
            cx.notify();
        }
    }

    pub fn set_ssh_host(&mut self, choice: SshHostChoice, cx: &mut Context<Self>) {
        if self.ssh_host != choice {
            self.ssh_host = choice;
            self.error = None;
            cx.notify();
        }
    }

    pub fn set_platform(&mut self, platform: OperatorPlatform, cx: &mut Context<Self>) {
        if self.platform != platform {
            self.platform = platform;
            self.error = None;
            cx.notify();
        }
    }

    pub fn set_plaintext_acknowledged(&mut self, acknowledged: bool, cx: &mut Context<Self>) {
        self.plaintext_acknowledged = acknowledged;
        cx.notify();
    }

    fn value(&self, field: ManualField, cx: &App) -> String {
        self.input(field).read(cx).value().trim().to_owned()
    }

    /// Whether the directory is adding this form's Host.
    fn is_adding(&self, cx: &App) -> bool {
        self.directory.read(cx).action() == Some(&HostAction::Add(AddMethod::Manual))
    }

    /// `draftComplete`: every field the chosen method needs has a value, the
    /// ports are ports, the WebSocket path is canonical, and plaintext is
    /// acknowledged.
    pub fn is_complete(&self, cx: &App) -> bool {
        let filled = |field| !self.value(field, cx).is_empty();
        if ![ManualField::Name, ManualField::RootId, ManualField::Credential]
            .into_iter()
            .all(filled)
        {
            return false;
        }
        match self.transport {
            TransportChoice::Ssh => {
                let ssh_port = self.value(ManualField::SshPort, cx);
                let common = filled(ManualField::Destination)
                    && (ssh_port.is_empty() || parse_port(&ssh_port).is_some());
                common
                    && match self.ssh_host {
                        SshHostChoice::Listening => {
                            parse_port(&self.value(ManualField::RemotePort, cx)).is_some()
                                && is_canonical_websocket_path(
                                    &self.value(ManualField::WebSocketPath, cx),
                                )
                        }
                        SshHostChoice::Operator => {
                            filled(ManualField::NodePath) && filled(ManualField::ModulePath)
                        }
                    }
            }
            TransportChoice::Tls => filled(ManualField::Url),
            TransportChoice::Plaintext => filled(ManualField::Url) && self.plaintext_acknowledged,
        }
    }

    /// The transport the fields describe (`createTransport`).
    fn transport(&self, cx: &App) -> Result<RemoteTransport, String> {
        let error = |error: host_protocol::TransportError| error.to_string();
        match self.transport {
            TransportChoice::Tls => {
                RemoteTransport::tls(&self.value(ManualField::Url, cx)).map_err(error)
            }
            TransportChoice::Plaintext => {
                RemoteTransport::plaintext(&self.value(ManualField::Url, cx)).map_err(error)
            }
            TransportChoice::Ssh => {
                let destination = self.value(ManualField::Destination, cx);
                let ssh_port = self.value(ManualField::SshPort, cx);
                let ssh_port = (!ssh_port.is_empty()).then(|| parse_port(&ssh_port)).flatten();
                let transport = match self.ssh_host {
                    SshHostChoice::Listening => SshTransport::forward(
                        &destination,
                        ssh_port,
                        parse_port(&self.value(ManualField::RemotePort, cx)).unwrap_or_default(),
                        &self.value(ManualField::WebSocketPath, cx),
                    ),
                    SshHostChoice::Operator => OperatorCommand::node(
                        self.platform,
                        &self.value(ManualField::NodePath, cx),
                        &self.value(ManualField::ModulePath, cx),
                    )
                    .and_then(|operator| SshTransport::activated(&destination, ssh_port, operator)),
                };
                transport.map(RemoteTransport::Ssh).map_err(error)
            }
        }
    }

    /// Save and enable: builds the profile and hands it to the directory,
    /// or says why the details do not make one.
    pub fn submit(&mut self, cx: &mut Context<Self>) {
        if !self.is_complete(cx) || self.directory.read(cx).is_busy() {
            return;
        }
        let built = self.transport(cx).and_then(|transport| {
            let profile = RemoteHostProfile::with_new_id(
                &self.value(ManualField::Name, cx),
                &self.value(ManualField::RootId, cx),
                transport,
            )
            .map_err(|error| error.to_string())?;
            let credential = AccessCredential::new(self.value(ManualField::Credential, cx))
                .map_err(|error| error.to_string())?;
            Ok((profile, credential))
        });
        match built {
            Ok((profile, credential)) => {
                self.error = None;
                self.directory
                    .update(cx, |directory, cx| directory.add_manual(profile, credential, cx));
            }
            Err(reason) => {
                let locale = Locale::current(cx);
                self.error =
                    Some(failure(locale, copy::SAVE_FAILED.in_locale(locale), &reason).into());
            }
        }
        cx.notify();
    }

    fn field_row(
        &self,
        field: ManualField,
        key: &str,
        title: Text,
        help: Text,
        disabled: bool,
        cx: &App,
    ) -> AnyElement {
        let input = Input::new(self.input(field))
            .field_fill(cx)
            .id(domain_element_id("host-field", key))
            .aria_label(title.get(cx))
            .disabled(disabled);
        let input = if field == ManualField::Credential { input.mask_toggle() } else { input };
        SettingsRow::new(key.to_owned(), title.get(cx))
            .detail(help.get(cx))
            .end(div().w(rems(FIELD_WIDTH_REMS)).child(input))
            .into_any_element()
    }

    /// A segmented row of `choices`, `selected` on the plate.
    fn segmented<V: Copy + PartialEq + 'static>(
        &self,
        key: &str,
        choices: Vec<(V, &'static str, Text)>,
        selected: V,
        disabled: bool,
        on_choose: fn(&mut Self, V, &mut Window, &mut Context<Self>),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        segmented_track(cx)
            .id(domain_element_id("host-choice", key))
            .test_support()
            .w(rems(FIELD_WIDTH_REMS))
            .children(choices.into_iter().map(|(value, choice_key, label)| {
                let button =
                    Button::new(domain_element_id("host-choice", &format!("{key}-{choice_key}")))
                        .disabled(disabled);
                segment(button, label.get(cx), value == selected, cx).on_click(
                    cx.listener(move |this, _, window, cx| on_choose(this, value, window, cx)),
                )
            }))
            .into_any_element()
    }

    /// What the form says under its fields: that it is verifying, why it did
    /// not work, or why the details are not a profile.
    fn status(&self, cx: &App) -> Option<StatusLine> {
        let locale = Locale::current(cx);
        if self.is_adding(cx) {
            return Some(StatusLine::info("host-form-status", copy::VERIFYING.get(cx)));
        }
        if let Some(error) = &self.error {
            return Some(StatusLine::error("host-form-status", error.clone()));
        }
        match self.directory.read(cx).outcome() {
            Some(HostOutcome::Refused { action: HostAction::Add(AddMethod::Manual), refusal }) => {
                Some(StatusLine::error("host-form-status", refusal_text(refusal, locale)))
            }
            _ => None,
        }
    }
}

/// `validPort`: an integer from 1 to 65535.
fn parse_port(value: &str) -> Option<u16> {
    value.trim().parse::<u16>().ok().filter(|port| *port >= 1)
}

impl Render for ManualHostForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let adding = self.is_adding(cx);
        let busy = adding || self.directory.read(cx).is_busy();
        let mut rows =
            vec![self.field_row(ManualField::Name, "name", copy::NAME, copy::NAME_HELP, busy, cx)];
        let transports = TransportChoice::ALL
            .into_iter()
            .map(|choice| (choice, choice.key(), choice.label()))
            .collect();
        let transport = self.segmented(
            "transport",
            transports,
            self.transport,
            busy,
            |this, choice, window, cx| this.set_transport(choice, window, cx),
            cx,
        );
        rows.push(
            SettingsRow::new("transport", copy::TRANSPORT.get(cx))
                .detail(copy::TRANSPORT_HELP.get(cx))
                .end(transport)
                .into_any_element(),
        );
        match self.transport {
            TransportChoice::Ssh => {
                rows.push(self.field_row(
                    ManualField::Destination,
                    "destination",
                    copy::SSH_DESTINATION,
                    copy::SSH_DESTINATION_HELP,
                    busy,
                    cx,
                ));
                rows.push(self.field_row(
                    ManualField::SshPort,
                    "ssh-port",
                    copy::SSH_PORT,
                    copy::SSH_PORT_HELP,
                    busy,
                    cx,
                ));
                let modes = vec![
                    (SshHostChoice::Listening, "listening", copy::SSH_HOST_LISTENING),
                    (SshHostChoice::Operator, "operator", copy::SSH_HOST_OPERATOR),
                ];
                let mode = self.segmented(
                    "ssh-host",
                    modes,
                    self.ssh_host,
                    busy,
                    |this, choice, _, cx| this.set_ssh_host(choice, cx),
                    cx,
                );
                rows.push(
                    SettingsRow::new("ssh-host", copy::SSH_HOST.get(cx))
                        .detail(copy::SSH_HOST_HELP.get(cx))
                        .end(mode)
                        .into_any_element(),
                );
                match self.ssh_host {
                    SshHostChoice::Listening => {
                        rows.push(self.field_row(
                            ManualField::RemotePort,
                            "remote-port",
                            copy::REMOTE_PORT,
                            copy::REMOTE_PORT_HELP,
                            busy,
                            cx,
                        ));
                        rows.push(self.field_row(
                            ManualField::WebSocketPath,
                            "websocket-path",
                            copy::WEBSOCKET_PATH,
                            copy::WEBSOCKET_PATH_HELP,
                            busy,
                            cx,
                        ));
                    }
                    SshHostChoice::Operator => {
                        let platforms = vec![
                            (OperatorPlatform::Posix, "posix", copy::PLATFORM_POSIX),
                            (OperatorPlatform::Win32, "win32", copy::PLATFORM_WINDOWS),
                        ];
                        let platform = self.segmented(
                            "platform",
                            platforms,
                            self.platform,
                            busy,
                            |this, choice, _, cx| this.set_platform(choice, cx),
                            cx,
                        );
                        rows.push(
                            SettingsRow::new("platform", copy::OPERATOR_PLATFORM.get(cx))
                                .end(platform)
                                .into_any_element(),
                        );
                        rows.push(self.field_row(
                            ManualField::NodePath,
                            "node-path",
                            copy::OPERATOR_NODE,
                            copy::OPERATOR_NODE_HELP,
                            busy,
                            cx,
                        ));
                        rows.push(self.field_row(
                            ManualField::ModulePath,
                            "module-path",
                            copy::OPERATOR_MODULE,
                            copy::OPERATOR_MODULE_HELP,
                            busy,
                            cx,
                        ));
                    }
                }
            }
            TransportChoice::Tls => {
                rows.push(self.field_row(
                    ManualField::Url,
                    "url",
                    copy::URL,
                    copy::URL_HELP,
                    busy,
                    cx,
                ));
            }
            TransportChoice::Plaintext => {
                rows.push(self.field_row(
                    ManualField::Url,
                    "url",
                    copy::PLAINTEXT_URL,
                    copy::PLAINTEXT_URL_HELP,
                    busy,
                    cx,
                ));
                let acknowledged = {
                    let (checked, disabled) = (self.plaintext_acknowledged, busy);
                    FadedSwitch::new(
                        Switch::new("host-plaintext-acknowledged")
                            .checked(checked)
                            .disabled(disabled)
                            .accessibility_label(copy::PLAINTEXT_ACKNOWLEDGEMENT.get(cx))
                            .on_change(cx.listener(|this, checked: &bool, _, cx| {
                                this.set_plaintext_acknowledged(*checked, cx)
                            })),
                        checked,
                        disabled,
                    )
                };
                rows.push(
                    SettingsRow::new(
                        "plaintext-acknowledgement",
                        copy::PLAINTEXT_ACKNOWLEDGEMENT.get(cx),
                    )
                    .detail(copy::PLAINTEXT_ACKNOWLEDGEMENT_HELP.get(cx))
                    .status(StatusLine::error("plaintext-warning", copy::PLAINTEXT_WARNING.get(cx)))
                    .end(acknowledged)
                    .into_any_element(),
                );
            }
        }
        rows.push(self.field_row(
            ManualField::RootId,
            "root-id",
            copy::STATE_ROOT_ID,
            copy::STATE_ROOT_ID_HELP,
            busy,
            cx,
        ));
        rows.push(self.field_row(
            ManualField::Credential,
            "credential",
            copy::CREDENTIAL,
            copy::CREDENTIAL_HELP,
            busy,
            cx,
        ));
        let save = control_button(Button::new("host-save-and-enable").primary())
            .label(copy::SAVE_AND_ENABLE.get(cx))
            .loading(adding)
            .disabled(busy || !self.is_complete(cx))
            .on_click(cx.listener(|this, _, _, cx| this.submit(cx)));
        let cancel = quiet_button(Button::new("host-form-cancel"), cx)
            .label(CANCEL.get(cx))
            .disabled(adding)
            .on_click(cx.listener(|_, _, _, cx| cx.emit(ManualHostFormEvent::Cancelled)));
        let maka = cx.maka();
        let mut children = Vec::with_capacity(rows.len() * 2);
        for (ix, row) in rows.into_iter().enumerate() {
            if ix > 0 {
                children.push(div().h_px().w_full().bg(maka.border_soft).into_any_element());
            }
            children.push(row);
        }
        let title = copy::ADD_REMOTE_HOST.get(cx);
        v_flex()
            .id("manual-host-form")
            .test_support()
            .aria_label(title)
            .w_full()
            .p_4()
            .gap_2()
            .rounded(RADIUS_MODAL)
            .border_1()
            .border_color(maka.border)
            .child(
                div()
                    .id("manual-host-form-title")
                    .test_support()
                    .role(Role::Heading)
                    .aria_label(title)
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(maka.ink)
                    .child(title),
            )
            .child(v_flex().w_full().children(children))
            .children(self.status(cx))
            .child(h_flex().w_full().justify_end().gap_2().child(cancel).child(save))
    }
}
