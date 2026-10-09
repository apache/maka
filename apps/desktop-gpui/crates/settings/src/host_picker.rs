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

//! The compact Host picker at the end of a settings page's header, after
//! Desktop's `settingsRuntimeHostSelector` in settings-surface.tsx: on the
//! pages whose settings belong to a Host (every page but the client's own,
//! `SETTINGS_SECTION_SCOPES` in settings-nav.ts), once more than one Host
//! is offered. Desktop's picks which Host's settings the page shows; a
//! window here talks to one Host, so choosing one switches the window.

use gpui_kit::component::h_flex;
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, Styled as _, Subscription, TestSupportExt as _,
    Window, div, rems,
};
use shared::copy::remote_hosts as copy;
use shared::copy::{self as shared_copy, Locale};
use shared::theme::ActiveMakaPalette as _;
use workspace::{HostDirectory, HostSession};

use crate::rows::{Choice, ChoiceSelect, sync_choices};
use crate::runtime_host_section::RuntimeHostEvent;
use crate::section::SettingsSection;

/// The picker's width: Desktop's 220px (the header's selector, not a
/// settings row's select).
pub(crate) const PICKER_WIDTH_REMS: f32 = 13.75;

/// Whether `section`'s settings belong to the Host (Desktop's `mixed` and
/// `runtime-host` scopes), so its header offers the Host picker.
pub fn section_shows_host_picker(section: SettingsSection) -> bool {
    !matches!(
        section,
        SettingsSection::Appearance
            | SettingsSection::BotChat
            | SettingsSection::ArchivedTasks
            | SettingsSection::About
    )
}

/// Behavior owner of the header's Host picker: the Hosts the directory
/// offers, the window's own chosen. It asks the window to switch with
/// [`RuntimeHostEvent::SwitchHost`].
pub struct HostPicker {
    directory: Entity<HostDirectory>,
    host: Entity<HostSession>,
    select: Entity<ChoiceSelect<SharedString>>,
    /// How many Hosts are offered, as of the last sync.
    offered: usize,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for HostPicker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostPicker").field("offered", &self.offered).finish_non_exhaustive()
    }
}

impl EventEmitter<RuntimeHostEvent> for HostPicker {}

impl HostPicker {
    pub fn new(
        directory: Entity<HostDirectory>,
        host: Entity<HostSession>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let select = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        let subscriptions = vec![
            cx.subscribe_in(
                &select,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<SharedString>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(id)) = event
                        && this.host.read(cx).host().profile_id() != id.as_ref()
                    {
                        cx.emit(RuntimeHostEvent::SwitchHost(id.clone()));
                    }
                },
            ),
            cx.observe_in(&directory, window, |this, _, window, cx| this.sync(window, cx)),
            cx.observe_global_in::<Locale>(window, |this, window, cx| this.sync(window, cx)),
        ];
        let mut this = Self { directory, host, select, offered: 0, _subscriptions: subscriptions };
        this.sync(window, cx);
        this
    }

    /// How many Hosts the picker offers.
    pub fn offered(&self) -> usize {
        self.offered
    }

    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(list) = self.directory.read(cx).list() else {
            return;
        };
        let local = shared_copy::HOST_LOCAL.get(cx);
        let choices: Vec<_> = list
            .choices()
            .into_iter()
            .map(|choice| {
                let label = choice.name.clone().unwrap_or_else(|| local.into());
                Choice::new(choice.profile_id, label)
            })
            .collect();
        self.offered = choices.len();
        let current = SharedString::from(self.host.read(cx).host().profile_id().to_owned());
        sync_choices(&self.select, choices, Some(&current), window, cx);
        cx.notify();
    }

    /// The picker, when there is more than one Host to pick from. The
    /// width sits on a box that does not shrink: `Select`'s own root fills
    /// its parent, so styled directly it would claim the whole header.
    pub fn render_picker(&self, cx: &gpui_kit::App) -> Option<AnyElement> {
        // Desktop hides the selector's label; here it says whose Host it
        // is, since the page may show the default Host's select too.
        (self.offered > 1).then(|| {
            h_flex()
                .flex_none()
                .gap_2()
                .child(
                    div()
                        .id("settings-host-picker-label")
                        .test_support()
                        .text_xs()
                        .text_color(cx.maka().ink_muted)
                        .child(copy::THIS_WINDOW_BADGE.get(cx)),
                )
                .child(
                    div().flex_none().w(rems(PICKER_WIDTH_REMS)).child(
                        Select::new(&self.select)
                            .id("settings-host-picker")
                            .accessibility_label(copy::HOST_BLOCK_TITLE.get(cx))
                            .disabled(self.directory.read(cx).is_busy()),
                    ),
                )
                .into_any_element()
        })
    }
}
