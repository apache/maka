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

//! Workspace's Runtime Host block, after Desktop's
//! `RuntimeHostProfilesSection` (apps/desktop/src/renderer/settings/runtime-host-profiles-section.tsx):
//! the default Host, then the other Hosts with Add computer.
//!
//! Desktop keeps every enabled Host connected together and shows their
//! tasks side by side; a window here talks to one Host at a time. So the
//! Default Host is the one the window uses and opens on, choosing another
//! switches the window, and "enabled" means offered in the Host pickers
//! (here, the settings header, the sidebar footer) rather than connected.
//! Desktop's Remote access row (sharing this computer's Host) and Peer Mesh
//! are left out: both need a service-managed Host with Direct peer.
//!
//! Add computer offers what this client can do: a connection code (a
//! Direct peer one is refused, with the sentence why) and the manual form
//! (TLS, plain WebSocket with the acknowledgement, or SSH to a Host that
//! listens or that its operator starts). Desktop's "Set up over SSH"
//! installs Maka on the other computer, which this client does not.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Selectable as _, h_flex, v_flex,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, EventEmitter, FocusHandle,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, rems,
};
use shared::copy::remote_hosts as copy;
use shared::copy::{self as shared_copy, Locale, failure};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::menu::{MenuEntry, MenuItem, MenuSlot};
use shared::theme::FadedSwitch;
use shared::theme::{
    ActiveMakaPalette as _, badge, control_button, row_icon_button, warning_badge,
};
use workspace::{
    HostAction, HostDirectory, HostOutcome, HostRefusal, HostSession, RemoteHostEntry, SshFailure,
    remote_endpoint_label,
};

use crate::manual_host_form::{ManualHostForm, ManualHostFormEvent};
use crate::rows::{
    Choice, ChoiceSelect, SETTINGS_CONTROL_WIDTH_REMS, SettingsGroup, SettingsRow, StatusLine,
    settings_button, sync_choices,
};

/// What the block asks of the window that shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RuntimeHostEvent {
    /// Talk to the Host `profile_id` names (`local` or a remote profile's)
    /// from now on.
    SwitchHost(SharedString),
}

/// Behavior and presentation owner of the Runtime Host block. It reads and
/// changes the app's [`HostDirectory`]; it knows which Host this window
/// talks to from its [`HostSession`], and asks the window to switch with
/// [`RuntimeHostEvent::SwitchHost`]. The manual form lives while it
/// shows.
/// The group a Host row's hover reveals its "…" through.
const HOST_ROW_GROUP: &str = "host-row";

pub struct RuntimeHostSection {
    directory: Entity<HostDirectory>,
    host: Entity<HostSession>,
    default_host: Entity<ChoiceSelect<SharedString>>,
    form: Option<Entity<ManualHostForm>>,
    /// Each Host row's menu slot, focused while its "…" has focus, so the
    /// button shows to the keyboard as to the pointer.
    menu_focus: RefCell<HashMap<SharedString, FocusHandle>>,
    /// The Host whose row menu is open (its "…" stays shown), and the menu.
    menu_open: Option<SharedString>,
    row_menu: MenuSlot,
    /// Add computer's menu, while it is open.
    add_menu: MenuSlot,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for RuntimeHostSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeHostSection").finish_non_exhaustive()
    }
}

impl EventEmitter<RuntimeHostEvent> for RuntimeHostSection {}

impl RuntimeHostSection {
    pub fn new(
        directory: Entity<HostDirectory>,
        host: Entity<HostSession>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let default_host = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        let subscriptions = vec![
            cx.subscribe_in(
                &default_host,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<SharedString>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(id)) = event {
                        this.choose_default(id.clone(), cx);
                    }
                },
            ),
            cx.observe_in(&directory, window, |this, directory, window, cx| {
                // The manual form's Host was added: the form closes, and the
                // group says so.
                let added = matches!(directory.read(cx).outcome(), Some(HostOutcome::Added { .. }))
                    && directory.read(cx).action().is_none();
                if added && this.form.is_some() {
                    this.form = None;
                }
                this.sync_default(window, cx);
                cx.notify();
            }),
            cx.observe(&host, |_, _, cx| cx.notify()),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                this.sync_default(window, cx)
            }),
        ];
        let mut this = Self {
            directory,
            host,
            default_host,
            form: None,
            menu_focus: RefCell::default(),
            menu_open: None,
            row_menu: MenuSlot::default(),
            add_menu: MenuSlot::default(),
            _subscriptions: subscriptions,
        };
        this.sync_default(window, cx);
        this
    }

    /// The manual form, while it shows.
    pub fn form(&self) -> Option<&Entity<ManualHostForm>> {
        self.form.as_ref()
    }

    /// Whether an action on the Hosts is unanswered.
    pub fn is_busy(&self, cx: &App) -> bool {
        self.directory.read(cx).is_busy()
    }

    /// The Default Host dropdown's choices: the local Host and the enabled
    /// remote ones, the default chosen.
    fn sync_default(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(list) = self.directory.read(cx).list() else {
            return;
        };
        let local = shared_copy::HOST_LOCAL.get(cx);
        let choices = list
            .choices()
            .into_iter()
            .map(|choice| {
                let label = choice.name.clone().unwrap_or_else(|| local.into());
                Choice::new(choice.profile_id, label)
            })
            .collect();
        let selected = SharedString::from(list.default_profile_id().to_owned());
        sync_choices(&self.default_host, choices, Some(&selected), window, cx);
    }

    /// The Default Host dropdown's answer: it becomes the default, and the
    /// window switches to it (new tasks go to the default Host).
    pub(crate) fn choose_default(&mut self, profile_id: SharedString, cx: &mut Context<Self>) {
        self.directory.update(cx, |directory, cx| directory.set_default(&profile_id, cx));
        if self.host.read(cx).host().profile_id() != profile_id.as_ref() {
            cx.emit(RuntimeHostEvent::SwitchHost(profile_id));
        }
    }

    /// Opens the manual form, or closes it (Desktop's Configure manually
    /// item reads Cancel while the form shows).
    pub fn toggle_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.form.take().is_none() {
            let directory = self.directory.clone();
            self.directory.update(cx, |directory, cx| directory.clear_outcome(cx));
            let form = cx.new(|cx| ManualHostForm::new(directory, window, cx));
            // Lives as long as the form: closing it drops both.
            cx.subscribe(&form, |this, _, event: &ManualHostFormEvent, cx| match event {
                ManualHostFormEvent::Cancelled => {
                    this.form = None;
                    cx.notify();
                }
            })
            .detach();
            self.form = Some(form);
        }
        cx.notify();
    }

    /// Opens a place in the block, for screenshots
    /// (`--open-settings projects:<target>`): `manual` the manual form,
    /// `manual-ssh`, `manual-operator` and `manual-plaintext` the form on
    /// that method. Returns whether `target` is one of these.
    pub fn reveal(&mut self, target: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        use crate::manual_host_form::{SshHostChoice, TransportChoice};
        let (transport, ssh_host) = match target {
            "manual" => (TransportChoice::Tls, SshHostChoice::Listening),
            "manual-ssh" => (TransportChoice::Ssh, SshHostChoice::Listening),
            "manual-operator" => (TransportChoice::Ssh, SshHostChoice::Operator),
            "manual-plaintext" => (TransportChoice::Plaintext, SshHostChoice::Listening),
            _ => return false,
        };
        if self.form.is_none() {
            self.toggle_form(window, cx);
        }
        if let Some(form) = &self.form {
            form.update(cx, |form, cx| {
                form.set_transport(transport, window, cx);
                form.set_ssh_host(ssh_host, cx);
            });
        }
        true
    }

    fn render_default_group(&self, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.is_busy(cx);
        let loaded = self.directory.read(cx).list().is_some();
        let title = copy::DEFAULT_HOST.get(cx);
        // A settings row's select, at the one control width.
        let select = Select::new(&self.default_host)
            .id(domain_element_id("settings-select", "default-host"))
            .accessibility_label(title)
            .disabled(busy || !loaded);
        SettingsGroup::new("runtime-host")
            .title(copy::HOST_BLOCK_TITLE.get(cx))
            .description(copy::RUNTIME_HOST_DESCRIPTION.get(cx))
            .child(
                SettingsRow::new("default-host", title)
                    .detail(copy::DEFAULT_HOST_HELP.get(cx))
                    .end(div().flex_none().w(rems(SETTINGS_CONTROL_WIDTH_REMS)).child(select)),
            )
            .into_any_element()
    }

    /// Add computer: Use connection code, and Configure manually (Cancel
    /// while the form shows).
    fn render_add_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let button = control_button(Button::new("hosts-add-computer").primary())
            .label(copy::ADD_COMPUTER.get(cx))
            .dropdown_caret(true)
            .disabled(self.is_busy(cx))
            .selected(self.add_menu.is_open())
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                let width = window.rem_size() * 20.;
                MenuSlot::toggle(
                    this,
                    |section| &mut section.add_menu,
                    event,
                    Self::add_menu_entries,
                    width,
                    window,
                    cx,
                );
            }));
        div().relative().child(button).children(self.add_menu.layer()).into_any_element()
    }

    /// Use connection code, and Configure manually (Cancel while the form
    /// shows), each over what it does, as Desktop's Add computer menu.
    /// Every code Desktop or the CLI makes is a Direct peer, which this
    /// client refuses, so Use connection code is disabled, its tooltip
    /// saying why, and opens nothing (review round 16 retired its dialog).
    fn add_menu_entries(&self, cx: &mut Context<Self>) -> Vec<MenuEntry> {
        let manual = cx.weak_entity();
        let manual_label =
            if self.form.is_some() { shared_copy::CANCEL } else { copy::CONFIGURE_MANUALLY };
        vec![
            MenuItem::new("hosts-add:code", copy::USE_CONNECTION_CODE.get(cx))
                .detail(copy::USE_CONNECTION_CODE_DESCRIPTION.get(cx))
                .disabled(true)
                .tooltip(copy::CONNECTION_CODE_UNSUPPORTED.get(cx))
                .into(),
            MenuItem::new("hosts-add:manual", manual_label.get(cx))
                .detail(copy::CONFIGURE_MANUALLY_DESCRIPTION.get(cx))
                .on_select(move |window, cx| {
                    manual.update(cx, |this, cx| this.toggle_form(window, cx)).ok();
                })
                .into(),
        ]
    }

    fn render_other_group(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let current = self.host.read(cx).host().profile_id().to_owned();
        let mut group = SettingsGroup::new("other-hosts")
            .title(copy::OTHER_HOSTS.get(cx))
            .description(copy::OTHER_HOSTS_DESCRIPTION.get(cx))
            .action(self.render_add_menu(cx));
        let directory = self.directory.read(cx);
        let busy = directory.is_busy();
        if let Some(message) = directory.load_error().filter(|_| directory.list().is_none()) {
            let reason = failure(locale, copy::LOAD_FAILED.in_locale(locale), message);
            return group
                .child(div().py_2().child(StatusLine::error("hosts-load", reason)))
                .into_any_element();
        }
        let Some(list) = directory.list().cloned() else {
            return group
                .child(SettingsRow::loading("hosts-loading", copy::OTHER_HOSTS.get(cx), 10., cx))
                .into_any_element();
        };
        // An unfinished pairing first, the section's first row as Desktop's,
        // with its Retry, over the form when that is open (Desktop renders
        // it before `showAdd`); the form on its own plate; then what the
        // list says about itself, above the list.
        if let Some(form) = &self.form {
            group = group.lead(form.clone());
        }
        if let Some(pending) = list.remotes.iter().find(|entry| entry.pairing_pending) {
            let (directory, id) = (self.directory.clone(), pending.profile.id().to_owned());
            let row = SettingsRow::new("pairing-recovery", copy::PAIRING_RECOVERY_TITLE.get(cx))
                .detail(copy::PAIRING_RECOVERY_DESCRIPTION.get(cx))
                .end(
                    settings_button("hosts-retry-pairing", copy::RETRY_PAIRING.get(cx), cx)
                        .disabled(busy)
                        .on_click(move |_, _, cx| {
                            directory.update(cx, |directory, cx| directory.retry_pairing(&id, cx));
                        }),
                );
            group = if self.form.is_some() { group.above_lead(row) } else { group.child(row) };
        }
        if let Some(status) = self.render_outcome(cx) {
            group = group.child(div().py_1().child(status));
        }
        if list.remotes.is_empty() && self.form.is_none() {
            // Desktop renders it as a row with only its label (14/500).
            group = group.child(SettingsRow::new("hosts-empty", copy::EMPTY.get(cx)));
        }
        let rows: Vec<AnyElement> = list
            .remotes
            .iter()
            .map(|entry| {
                let id = entry.profile.id();
                let facts = RowFacts {
                    is_default: list.default_profile_id() == id,
                    is_current: current == id,
                    enabled: list.is_enabled(id),
                    busy,
                };
                self.render_host_row(entry, facts, cx)
            })
            .collect();
        group.children(rows).into_any_element()
    }

    /// How the last row action or the manual form ended, when it says
    /// something: an action refused, or a Host added.
    fn render_outcome(&self, cx: &App) -> Option<StatusLine> {
        let locale = Locale::current(cx);
        match self.directory.read(cx).outcome()? {
            HostOutcome::Added { name, .. } => {
                Some(StatusLine::info("hosts-outcome", copy::added(locale, name)))
            }
            HostOutcome::Refused { action, refusal } => {
                let title = match action {
                    // The form and the dialog say it themselves.
                    HostAction::Add(_) => return None,
                    HostAction::Remove(_) => copy::REMOVE_FAILED,
                    _ => copy::SELECT_FAILED,
                };
                let sentence = refusal_text(refusal, locale);
                Some(StatusLine::error(
                    "hosts-outcome",
                    shared_copy::sentences(locale, title.in_locale(locale), &sentence),
                ))
            }
            _ => None,
        }
    }

    /// One remote Host: its name and where it points, its badges, the
    /// switch that offers it for switching, and its menu.
    fn render_host_row(
        &self,
        entry: &RemoteHostEntry,
        facts: RowFacts,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let id: SharedString = entry.profile.id().to_owned().into();
        let name: SharedString = entry.profile.name().to_owned().into();
        let pending = entry.pairing_pending;
        let mut badges = Vec::new();
        if facts.is_default {
            badges.push(copy::DEFAULT_BADGE.get(cx));
        }
        if facts.is_current {
            badges.push(copy::THIS_WINDOW_BADGE.get(cx));
        }
        if pending {
            badges.push(copy::PAIRING_PENDING_BADGE.get(cx));
        }
        // A disabled switch says why (Desktop's `disabledMessage`).
        let locked = if pending {
            Some(copy::PAIRING_RECOVERY_DESCRIPTION.get(cx))
        } else if facts.is_default {
            Some(copy::DEFAULT_DISABLE_HELP.get(cx))
        } else if facts.is_current {
            Some(copy::CURRENT_DISABLE_HELP.get(cx))
        } else {
            None
        };
        let disabled = facts.busy || locked.is_some();
        let switch = {
            let (directory, id) = (self.directory.clone(), id.clone());
            let switch = Switch::new(domain_element_id("host-enabled", &id))
                .checked(facts.enabled)
                .disabled(disabled)
                .accessibility_label(name.clone())
                .on_change(move |enabled, _, cx| {
                    directory.update(cx, |directory, cx| directory.set_enabled(&id, *enabled, cx));
                });
            match locked {
                Some(reason) => switch.tooltip(reason),
                None => switch,
            }
        };
        let spoken = std::iter::once(name.to_string())
            .chain(badges.iter().map(|badge| (*badge).to_owned()))
            .collect::<Vec<_>>()
            .join(shared_copy::PART_SEPARATOR.get(cx));
        h_flex()
            .id(domain_element_id("host-row", &id))
            .test_support()
            .group(HOST_ROW_GROUP)
            .aria_label(spoken)
            .w_full()
            .items_center()
            .gap_3()
            .py_2()
            // Desktop's `startContent`: the bare 16px Cpu.
            .child(Icon::new(AssetIcon::Cpu).size_4().flex_shrink_0().text_color(maka.ink_muted))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(maka.ink)
                            .child(name.clone()),
                    )
                    .child(
                        // Where it is, as machine text: compact mono 12/20.
                        div()
                            .truncate()
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_xs()
                            .line_height(rems(1.25))
                            .text_color(maka.ink_muted)
                            .child(endpoint_text(entry)),
                    ),
            )
            // Desktop's `endContent`: the badges, then the switch and "…".
            .child(
                h_flex()
                    .flex_shrink_0()
                    .gap_2()
                    .children(badges.iter().map(|label| {
                        if pending && *label == copy::PAIRING_PENDING_BADGE.get(cx) {
                            warning_badge(*label, cx)
                        } else {
                            badge(*label, cx)
                        }
                    }))
                    .child(FadedSwitch::new(switch, facts.enabled, disabled))
                    .child(self.render_row_menu(entry, facts, cx)),
            )
            .into_any_element()
    }

    /// A row's menu: Use in this window and Set as default for an enabled
    /// Host, Retry pairing and Discard pairing for an unfinished one, and
    /// Remove, which waits until the Host is disabled and not the default.
    ///
    /// Its "…" is a 28px ghost icon button, always shown, as Desktop's
    /// `RuntimeHostProfileMoreMenu`, so every row's switch ends on the same
    /// line (review round 12).
    fn render_row_menu(
        &self,
        entry: &RemoteHostEntry,
        facts: RowFacts,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id: SharedString = entry.profile.id().to_owned().into();
        let locale = Locale::current(cx);
        let label = copy::more_actions(locale, entry.profile.name());
        let open = self.row_menu.is_open() && self.menu_open.as_ref() == Some(&id);
        let focus = self
            .menu_focus
            .borrow_mut()
            .entry(id.clone())
            .or_insert_with(|| cx.focus_handle())
            .clone();
        let slot = domain_element_id("host-more-slot", &id);
        let entries = self.row_menu_entries(entry, facts, cx);
        let opened = id.clone();
        let button = row_icon_button(Button::new(domain_element_id("host-more", &id)), cx)
            .size_7()
            .icon(Icon::new(MakaIcon::More).size_4().text_color(cx.maka().ink_muted))
            .accessibility_label(label)
            .disabled(facts.busy)
            .selected(open)
            .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                this.menu_open = Some(opened.clone());
                let width = window.rem_size() * 14.;
                let entries = entries();
                MenuSlot::toggle(
                    this,
                    |section| &mut section.row_menu,
                    event,
                    move |_, _| entries,
                    width,
                    window,
                    cx,
                );
            }));
        div()
            .id(slot)
            .track_focus(&focus)
            .relative()
            .flex_shrink_0()
            .child(button)
            .when(open, |this| this.children(self.row_menu.layer()))
            .into_any_element()
    }

    /// A row menu's items: Use in this window and Set as default for an
    /// enabled Host, Retry pairing and Discard pairing for an unfinished
    /// one, then Remove, which waits until the Host is disabled and not the
    /// default.
    fn row_menu_entries(
        &self,
        entry: &RemoteHostEntry,
        facts: RowFacts,
        cx: &mut Context<Self>,
    ) -> Rc<dyn Fn() -> Vec<MenuEntry>> {
        let id: SharedString = entry.profile.id().to_owned().into();
        let usable = facts.enabled && entry.has_credential && !entry.pairing_pending;
        let pending = entry.pairing_pending;
        let section = cx.weak_entity();
        let directory = self.directory.clone();
        let words = (
            copy::USE_IN_THIS_WINDOW.get(cx),
            copy::SET_AS_DEFAULT.get(cx),
            copy::RETRY_PAIRING.get(cx),
            copy::DISCARD_PAIRING.get(cx),
            copy::REMOVE.get(cx),
        );
        Rc::new(move || {
            let (use_here, set_default, retry, discard, remove) = words;
            let mut entries: Vec<MenuEntry> = Vec::new();
            if usable && !facts.is_current {
                let (section, id) = (section.clone(), id.clone());
                entries.push(
                    MenuItem::new("host:use", use_here)
                        .on_select(move |_, cx| {
                            section
                                .update(cx, |_, cx| {
                                    cx.emit(RuntimeHostEvent::SwitchHost(id.clone()))
                                })
                                .ok();
                        })
                        .into(),
                );
            }
            if usable && !facts.is_default {
                let (directory, id) = (directory.clone(), id.clone());
                entries.push(
                    MenuItem::new("host:default", set_default)
                        .on_select(move |_, cx| {
                            directory.update(cx, |directory, cx| directory.set_default(&id, cx));
                        })
                        .into(),
                );
            }
            if pending {
                let (directory_retry, id_retry) = (directory.clone(), id.clone());
                let (directory_discard, id_discard) = (directory.clone(), id.clone());
                entries.push(
                    MenuItem::new("host:retry-pairing", retry)
                        .on_select(move |_, cx| {
                            directory_retry
                                .update(cx, |directory, cx| directory.retry_pairing(&id_retry, cx));
                        })
                        .into(),
                );
                entries.push(
                    MenuItem::new("host:discard-pairing", discard)
                        .on_select(move |_, cx| {
                            directory_discard
                                .update(cx, |directory, cx| directory.remove(&id_discard, cx));
                        })
                        .into(),
                );
            }
            if !entries.is_empty() {
                entries.push(MenuEntry::Separator);
            }
            let (directory, id) = (directory.clone(), id.clone());
            entries.push(
                MenuItem::new("host:remove", remove)
                    .disabled(facts.enabled || facts.is_default)
                    .on_select(move |_, cx| {
                        directory.update(cx, |directory, cx| directory.remove(&id, cx));
                    })
                    .into(),
            );
            entries
        })
    }
}

/// What a remote Host's row needs to know beyond its entry.
#[derive(Debug, Clone, Copy)]
struct RowFacts {
    is_default: bool,
    is_current: bool,
    enabled: bool,
    busy: bool,
}

/// Where a profile points, as its row says it: the URL, or the SSH
/// destination (Desktop's row description).
fn endpoint_text(entry: &RemoteHostEntry) -> SharedString {
    match entry.profile.transport() {
        host_protocol::RemoteTransport::Tls(url)
        | host_protocol::RemoteTransport::Plaintext(url) => url.as_str().to_owned().into(),
        _ => remote_endpoint_label(&entry.profile),
    }
}

/// The sentence for `refusal`, in `locale`, where no connection code is
/// involved (switching to a Host).
pub fn host_refusal_text(refusal: &HostRefusal, locale: Locale) -> String {
    refusal_text(refusal, locale)
}

/// The sentence for `refusal`, in `locale`.
pub(crate) fn refusal_text(refusal: &HostRefusal, locale: Locale) -> String {
    let text = |text: shared_copy::Text| text.in_locale(locale).to_owned();
    match refusal {
        HostRefusal::InvalidCode => text(copy::REFUSED_INVALID_CODE),
        HostRefusal::DirectPeer => text(copy::REFUSED_DIRECT_PEER),
        HostRefusal::CredentialRefused => text(copy::REFUSED_CREDENTIAL),
        HostRefusal::WrongHost => text(copy::REFUSED_WRONG_HOST),
        HostRefusal::Unreachable(address) => copy::refused_unreachable(locale, address),
        HostRefusal::Tls(host) => copy::refused_tls(locale, host),
        HostRefusal::UpgradeRefused(status) => copy::refused_upgrade(locale, *status),
        HostRefusal::NoAnswer => text(copy::REFUSED_NO_ANSWER),
        HostRefusal::SshMissing => text(copy::REFUSED_SSH_MISSING),
        HostRefusal::Ssh(failure) => text(match failure {
            SshFailure::HostKeyNotVerified => copy::REFUSED_SSH_HOST_KEY,
            SshFailure::AuthenticationFailed => copy::REFUSED_SSH_AUTH,
            SshFailure::UnknownHost => copy::REFUSED_SSH_UNKNOWN_HOST,
            SshFailure::Unreachable => copy::REFUSED_SSH_UNREACHABLE,
            _ => copy::REFUSED_SSH_OTHER,
        }),
        HostRefusal::SshForwarding => text(copy::REFUSED_SSH_FORWARDING),
        HostRefusal::Activation(reason) => copy::refused_activation(locale, reason),
        HostRefusal::NotReady => text(copy::REFUSED_NOT_READY),
        HostRefusal::OutcomeUnknown => text(copy::REFUSED_OUTCOME_UNKNOWN),
        HostRefusal::Store(reason) => failure(locale, copy::SAVE_FAILED.in_locale(locale), reason),
        HostRefusal::Other(reason) => {
            failure(locale, copy::SELECT_FAILED.in_locale(locale), reason)
        }
        _ => text(copy::SELECT_FAILED),
    }
}

impl Render for RuntimeHostSection {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .id("runtime-host-section")
            .test_support()
            .w_full()
            .gap_12()
            .child(self.render_default_group(cx))
            .child(self.render_other_group(cx))
    }
}
