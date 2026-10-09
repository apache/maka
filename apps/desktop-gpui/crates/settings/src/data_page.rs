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

//! The Data page, after Maka Desktop's
//! (apps/desktop/src/renderer/settings/data-settings-page.tsx): where the
//! files live, with Open workspace folder and Copy path, the backup and
//! restore note, and the configuration file (see [`crate::config_transfer`]):
//! the categories to export, what an import does with a connection whose
//! name the Host already has, Export and Import. Outcomes show as toasts,
//! as Desktop's do.
//!
//! The workspace is this window's State Root. Desktop's "Clear input
//! history" row is left out: this client keeps no history of sent prompts.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::notification::Notification;
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::component::{Disableable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClipboardItem, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, PathPromptOptions, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, rems,
};
use shared::copy::system as copy;
use shared::copy::{self as shell_copy, Locale};
use shared::domain_element_id;
use shared::theme::{ActiveMakaPalette as _, control_button};
use workspace::{ConnectionCatalog, HostSession};

use crate::config_transfer::{
    self, ConfigBundle, ConfigCategory, ConflictStrategy, ImportSummary, ParseFailure,
    TransferError,
};
use crate::page_kit::warning_line;
use crate::policy::{HostPolicy, host_error_reason};
use crate::rows::{
    ActionRow, Choice, ChoiceSelect, SettingsGroup, SettingsRow, StatusLine, row_rule,
    settings_button, sync_choices,
};

/// Between the parts of an import's summary, in every language.
const SUMMARY_SEPARATOR: &str = " · ";

/// Supporting text: 12px on 20px lines.
const SUPPORTING_LINE_REMS: f32 = 1.25;

type Opener = Rc<dyn Fn(&Path, &mut App)>;

/// Which transfer is under way; one runs at a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataTransfer {
    Export,
    Import,
}

/// The toast an action ended with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataNotice {
    pub ok: bool,
    pub title: String,
    pub detail: Option<String>,
}

/// Behavior and presentation owner of the Data page.
pub struct DataPage {
    host: Entity<HostSession>,
    policy: Entity<HostPolicy>,
    connections: Entity<ConnectionCatalog>,
    app_version: SharedString,
    /// Connections and settings, as Desktop starts.
    selected: Vec<ConfigCategory>,
    strategy: ConflictStrategy,
    strategy_select: Entity<ChoiceSelect<ConflictStrategy>>,
    transfer: Option<DataTransfer>,
    opening: bool,
    notice: Option<DataNotice>,
    opener: Opener,
    #[cfg(test)]
    workspace_override: Option<PathBuf>,
    _run: Option<Task<()>>,
    _open: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for DataPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DataPage")
            .field("selected", &self.selected)
            .field("strategy", &self.strategy)
            .field("transfer", &self.transfer)
            .finish_non_exhaustive()
    }
}

fn strategy_choices(locale: Locale) -> Vec<Choice<ConflictStrategy>> {
    vec![
        Choice::new(ConflictStrategy::Skip, copy::DATA_SKIP.in_locale(locale)),
        Choice::new(ConflictStrategy::Overwrite, copy::DATA_OVERWRITE.in_locale(locale)),
    ]
}

fn category_label(category: ConfigCategory, locale: Locale) -> &'static str {
    match category {
        ConfigCategory::Connections => copy::DATA_CONNECTIONS,
        ConfigCategory::Settings => copy::DATA_SETTINGS,
        ConfigCategory::Credentials => copy::DATA_CREDENTIALS,
        ConfigCategory::Memory => copy::DATA_MEMORY,
    }
    .in_locale(locale)
}

fn category_help(category: ConfigCategory, locale: Locale) -> &'static str {
    match category {
        ConfigCategory::Connections => copy::DATA_CONNECTIONS_HELP,
        ConfigCategory::Settings => copy::DATA_SETTINGS_HELP,
        ConfigCategory::Credentials => copy::DATA_CREDENTIALS_HELP,
        ConfigCategory::Memory => copy::DATA_MEMORY_HELP,
    }
    .in_locale(locale)
}

/// The order Desktop lists the categories in on the page.
const PAGE_ORDER: [ConfigCategory; 4] = [
    ConfigCategory::Connections,
    ConfigCategory::Settings,
    ConfigCategory::Memory,
    ConfigCategory::Credentials,
];

/// Why a transfer stopped, as its toast's detail.
pub fn transfer_reason(error: &TransferError, locale: Locale) -> String {
    match error {
        TransferError::Host(error) => host_error_reason(error, locale),
        TransferError::File(failure) => parse_reason(*failure, locale).to_owned(),
        TransferError::Failed(message) => {
            log::warn!("configuration transfer failed: {message}");
            copy::DATA_UNKNOWN_ERROR.in_locale(locale).to_owned()
        }
        TransferError::Memory(reason) => reason.clone(),
    }
}

fn parse_reason(failure: ParseFailure, locale: Locale) -> &'static str {
    match failure {
        ParseFailure::NotJson => copy::DATA_NOT_JSON,
        ParseFailure::Malformed => copy::DATA_MALFORMED,
        ParseFailure::UnsupportedVersion => copy::DATA_UNSUPPORTED_VERSION,
    }
    .in_locale(locale)
}

/// `summarizeImportResult`: what the import wrote, part by part.
pub fn import_summary(summary: &ImportSummary, locale: Locale) -> String {
    let mut parts = Vec::new();
    if let Some(counts) = summary.connections {
        parts.push(copy::DATA_SUMMARY_CONNECTIONS.fill(
            locale,
            &[
                ("created", &counts.created.to_string()),
                ("overwritten", &counts.overwritten.to_string()),
                ("skipped", &counts.skipped.to_string()),
            ],
        ));
    }
    if summary.settings {
        parts.push(copy::DATA_SUMMARY_SETTINGS.in_locale(locale).to_owned());
    }
    if let Some(counts) = summary.credentials {
        let (applied, skipped) = (counts.applied.to_string(), counts.skipped.to_string());
        let text = if counts.skipped > 0 {
            copy::DATA_SUMMARY_CREDENTIALS_SKIPPED
        } else {
            copy::DATA_SUMMARY_CREDENTIALS
        };
        parts.push(text.fill(locale, &[("applied", &applied), ("skipped", &skipped)]));
    }
    if summary.memory {
        parts.push(copy::DATA_SUMMARY_MEMORY.in_locale(locale).to_owned());
    }
    if parts.is_empty() {
        return copy::DATA_SUMMARY_EMPTY.in_locale(locale).to_owned();
    }
    parts.join(SUMMARY_SEPARATOR)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// The chosen file, written whole. Called only on the background executor.
#[allow(clippy::disallowed_methods)]
fn write_file(path: &Path, text: &str) -> std::io::Result<()> {
    std::fs::write(path, text)
}

/// The chosen file's bytes. Called only on the background executor.
#[allow(clippy::disallowed_methods)]
fn read_file(path: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(path)
}

/// `maka-config-YYYY-MM-DD.json`, today as UTC reckons it.
fn suggested_file_name(now_ms: u64) -> String {
    let date: String = shared::time::iso_time(now_ms).chars().take(10).collect();
    format!("maka-config-{date}.json")
}

impl DataPage {
    pub fn new(
        host: Entity<HostSession>,
        policy: Entity<HostPolicy>,
        connections: Entity<ConnectionCatalog>,
        app_version: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let locale = Locale::current(cx);
        let strategy_select =
            cx.new(|cx| ChoiceSelect::new(strategy_choices(locale), None, window, cx));
        sync_choices(
            &strategy_select,
            strategy_choices(locale),
            Some(&ConflictStrategy::Skip),
            window,
            cx,
        );
        let subscriptions = vec![
            cx.observe(&host, |_, _, cx| cx.notify()),
            cx.subscribe_in(
                &strategy_select,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<ConflictStrategy>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(strategy)) = event {
                        this.strategy = *strategy;
                        cx.notify();
                    }
                },
            ),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let choices = strategy_choices(Locale::current(cx));
                sync_choices(&this.strategy_select, choices, Some(&this.strategy), window, cx);
            }),
        ];
        Self {
            host,
            policy,
            connections,
            app_version,
            selected: vec![ConfigCategory::Connections, ConfigCategory::Settings],
            strategy: ConflictStrategy::Skip,
            strategy_select,
            transfer: None,
            opening: false,
            notice: None,
            opener: Rc::new(|path, cx| cx.open_with_system(path)),
            #[cfg(test)]
            workspace_override: None,
            _run: None,
            _open: None,
            _subscriptions: subscriptions,
        }
    }

    /// Opens folders with `opener` instead of the system (tests).
    pub fn set_opener(&mut self, opener: impl Fn(&Path, &mut App) + 'static) {
        self.opener = Rc::new(opener);
    }

    /// The toast the last action ended with.
    pub fn notice(&self) -> Option<&DataNotice> {
        self.notice.as_ref()
    }

    /// The categories an export writes, in the file's order.
    pub fn selected(&self) -> Vec<ConfigCategory> {
        ConfigCategory::ALL.into_iter().filter(|c| self.selected.contains(c)).collect()
    }

    pub fn strategy(&self) -> ConflictStrategy {
        self.strategy
    }

    pub fn transfer(&self) -> Option<DataTransfer> {
        self.transfer
    }

    /// Whether a transfer is unanswered.
    pub fn is_busy(&self) -> bool {
        self.transfer.is_some()
    }

    fn workspace(&self, cx: &App) -> PathBuf {
        #[cfg(test)]
        if let Some(path) = &self.workspace_override {
            return path.clone();
        }
        self.host.read(cx).root().to_owned()
    }

    /// Shows `path` as the workspace instead of the State Root (tests).
    #[cfg(test)]
    pub(crate) fn set_workspace(&mut self, path: PathBuf) {
        self.workspace_override = Some(path);
    }

    pub fn set_selected(&mut self, category: ConfigCategory, on: bool, cx: &mut Context<Self>) {
        self.selected.retain(|c| *c != category);
        if on {
            self.selected.push(category);
        }
        cx.notify();
    }

    fn say(&mut self, notice: DataNotice, window: &mut Window, cx: &mut Context<Self>) {
        let toast = match (&notice.detail, notice.ok) {
            (Some(detail), true) => {
                Notification::success(detail.clone()).title(notice.title.clone())
            }
            (Some(detail), false) => {
                Notification::error(detail.clone()).title(notice.title.clone())
            }
            (None, true) => Notification::success(notice.title.clone()),
            (None, false) => Notification::error(notice.title.clone()),
        };
        window.push_notification(toast, cx);
        self.notice = Some(notice);
        cx.notify();
    }

    /// Opens the workspace folder in the file manager, unless it is gone.
    pub fn open_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.opening {
            return;
        }
        let path = self.workspace(cx);
        let check = path.clone();
        let found = cx.background_spawn(async move {
            match std::fs::metadata(&check) {
                Ok(meta) if meta.is_dir() => Ok(()),
                Ok(_) => Err(copy::DATA_NOT_A_FOLDER),
                Err(_) => Err(copy::DATA_FOLDER_MISSING),
            }
        });
        let opener = self.opener.clone();
        let locale = Locale::current(cx);
        self.opening = true;
        self._open = Some(cx.spawn_in(window, async move |this, cx| {
            let found = found.await;
            this.update_in(cx, |this, window, cx| {
                this.opening = false;
                match found {
                    Ok(()) => {
                        opener(&path, cx);
                        cx.notify();
                    }
                    Err(why) => {
                        let notice = DataNotice {
                            ok: false,
                            title: copy::DATA_OPEN_FAILED.in_locale(locale).to_owned(),
                            detail: Some(why.in_locale(locale).to_owned()),
                        };
                        this.say(notice, window, cx);
                    }
                }
            })
            .ok();
        }));
        cx.notify();
    }

    /// Writes the workspace path to the clipboard.
    pub fn copy_path(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path = self.workspace(cx).display().to_string();
        cx.write_to_clipboard(ClipboardItem::new_string(path));
        let title = copy::DATA_PATH_COPIED.get(cx).to_owned();
        self.say(DataNotice { ok: true, title, detail: None }, window, cx);
    }

    /// Asks where to save, then writes the chosen categories there.
    pub fn export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.transfer.is_some() || !self.host.read(cx).is_connected() {
            return;
        }
        let locale = Locale::current(cx);
        let categories = self.selected();
        if categories.is_empty() {
            let title = copy::DATA_SELECT_CATEGORY.in_locale(locale).to_owned();
            self.say(DataNotice { ok: false, title, detail: None }, window, cx);
            return;
        }
        self.transfer = Some(DataTransfer::Export);
        let directory = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let now = now_ms();
        let path = cx.prompt_for_new_path(&directory, Some(&suggested_file_name(now)));
        let requester = self.host.read(cx).requester();
        let app_version = self.app_version.to_string();
        self._run = Some(cx.spawn_in(window, async move |this, cx| {
            let picked = match path.await {
                Ok(Ok(Some(path))) => Some(path),
                Ok(Err(error)) => {
                    log::warn!("the save dialog failed: {error:#}");
                    None
                }
                _ => None,
            };
            let notice = match picked {
                None => None,
                Some(path) => {
                    let exported_at = shared::time::iso_time(now);
                    let bundle =
                        config_transfer::export(&requester, &categories, &app_version, exported_at)
                            .await;
                    let title = copy::DATA_EXPORT_FAILED.in_locale(locale).to_owned();
                    Some(match bundle {
                        Ok(bundle) => {
                            let file = bundle.to_file();
                            let written = cx
                                .background_executor()
                                .spawn(async move { write_file(&path, &file) })
                                .await;
                            match written {
                                Ok(()) => exported(&bundle, locale),
                                Err(error) => {
                                    DataNotice { ok: false, title, detail: Some(error.to_string()) }
                                }
                            }
                        }
                        Err(error) => DataNotice {
                            ok: false,
                            title,
                            detail: Some(transfer_reason(&error, locale)),
                        },
                    })
                }
            };
            this.update_in(cx, |this, window, cx| {
                this.transfer = None;
                match notice {
                    Some(notice) => this.say(notice, window, cx),
                    None => cx.notify(),
                }
            })
            .ok();
        }));
        cx.notify();
    }

    /// Asks for a file, then imports it with the chosen way of handling a
    /// connection the Host already has.
    pub fn import(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.transfer.is_some() || !self.host.read(cx).is_connected() {
            return;
        }
        self.transfer = Some(DataTransfer::Import);
        let locale = Locale::current(cx);
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(copy::DATA_IMPORT_PROMPT.in_locale(locale).into()),
        });
        let requester = self.host.read(cx).requester();
        let strategy = self.strategy;
        self._run = Some(cx.spawn_in(window, async move |this, cx| {
            let picked = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                Ok(Err(error)) => {
                    log::warn!("the file dialog failed: {error:#}");
                    None
                }
                _ => None,
            };
            let Some(path) = picked else {
                this.update(cx, |this, cx| {
                    this.transfer = None;
                    cx.notify();
                })
                .ok();
                return;
            };
            let read = cx.background_executor().spawn(async move { read_file(&path) }).await;
            let failed = |detail: String| DataNotice {
                ok: false,
                title: copy::DATA_IMPORT_FAILED.in_locale(locale).to_owned(),
                detail: Some(detail),
            };
            let mut wrote = false;
            let notice = match read {
                Err(error) => failed(error.to_string()),
                Ok(bytes) => match ConfigBundle::parse(&String::from_utf8_lossy(&bytes)) {
                    Err(failure) => failed(parse_reason(failure, locale).to_owned()),
                    Ok(bundle) => {
                        wrote = true;
                        match config_transfer::import(&requester, &bundle, strategy, locale).await {
                            Ok(summary) => DataNotice {
                                ok: true,
                                title: copy::DATA_IMPORTED.in_locale(locale).to_owned(),
                                detail: Some(import_summary(&summary, locale)),
                            },
                            Err(error) => failed(transfer_reason(&error, locale)),
                        }
                    }
                },
            };
            this.update_in(cx, |this, window, cx| {
                this.transfer = None;
                if wrote {
                    // What the import wrote shows on the pages at once, not
                    // at the Host's next notice.
                    this.policy.update(cx, |policy, cx| policy.reload(cx));
                    this.connections.update(cx, |connections, cx| connections.reload(cx));
                }
                this.say(notice, window, cx);
            })
            .ok();
        }));
        cx.notify();
    }

    fn render_location(&self, cx: &mut Context<Self>) -> SettingsGroup {
        let path = self.workspace(cx).display().to_string();
        let busy = self.opening;
        let open = settings_button("data-open-workspace", copy::DATA_OPEN_WORKSPACE.get(cx), cx)
            .loading(self.opening)
            .disabled(busy)
            .on_click(cx.listener(|this, _, window, cx| this.open_workspace(window, cx)));
        let copy_path = settings_button("data-copy-path", copy::DATA_COPY_PATH.get(cx), cx)
            .disabled(busy)
            .on_click(cx.listener(|this, _, window, cx| this.copy_path(window, cx)));
        SettingsGroup::new("data-location")
            .title(copy::DATA_LOCATION.get(cx))
            .description(copy::DATA_LOCATION_HELP.get(cx))
            .child(
                SettingsRow::path("data-workspace", copy::DATA_WORKSPACE.get(cx), path)
                    .detail(copy::DATA_WORKSPACE_HELP.get(cx))
                    .end(open)
                    .end(copy_path),
            )
            .child(
                SettingsRow::new("data-backup", copy::DATA_BACKUP.get(cx))
                    .detail(copy::DATA_BACKUP_NOTICE.get(cx)),
            )
    }

    fn render_category(&self, category: ConfigCategory, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let label = category_label(category, locale);
        let this = cx.weak_entity();
        let checkbox = Checkbox::new(domain_element_id("data-category", category.wire()))
            .accessibility_label(label)
            .checked(self.selected.contains(&category))
            .disabled(self.transfer.is_some())
            .on_click(move |checked, _, cx| {
                this.update(cx, |this, cx| this.set_selected(category, *checked, cx)).ok();
            });
        h_flex()
            .id(domain_element_id("data-category-row", category.wire()))
            .test_support()
            .aria_label(label)
            .w_full()
            .items_start()
            .gap_3()
            .py_2()
            .child(h_flex().h(rems(SUPPORTING_LINE_REMS)).child(checkbox))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(maka.ink)
                            .child(label),
                    )
                    .child(
                        div()
                            .text_xs()
                            .line_height(rems(SUPPORTING_LINE_REMS))
                            .text_color(maka.ink_muted)
                            .child(category_help(category, locale)),
                    ),
            )
            .into_any_element()
    }

    fn render_config(&self, cx: &mut Context<Self>) -> SettingsGroup {
        let connected = self.host.read(cx).is_connected();
        let transfer = self.transfer;
        let sensitive = self.selected.iter().any(|category| category.is_sensitive());
        let export = control_button(Button::new("data-export").primary())
            .label(copy::DATA_EXPORT.get(cx))
            .loading(transfer == Some(DataTransfer::Export))
            .disabled(!connected || transfer.is_some())
            .on_click(cx.listener(|this, _, window, cx| this.export(window, cx)));
        let import = settings_button("data-import", copy::DATA_IMPORT.get(cx), cx)
            .loading(transfer == Some(DataTransfer::Import))
            .disabled(!connected || transfer.is_some())
            .on_click(cx.listener(|this, _, window, cx| this.import(window, cx)));
        // The categories are rows of the group: a rule between each, as
        // between every row of a group (Desktop's rows.css).
        let mut categories: Vec<AnyElement> = Vec::new();
        for category in PAGE_ORDER {
            if !categories.is_empty() {
                categories.push(row_rule(cx));
            }
            categories.push(self.render_category(category, cx));
        }
        if sensitive {
            categories.push(row_rule(cx));
            categories.push(warning_line(
                "data-sensitive",
                copy::DATA_SENSITIVE_WARNING.get(cx),
                cx,
            ));
        }
        let conflict = SettingsRow::select(
            "data-conflict",
            copy::DATA_CONFLICT.get(cx),
            Select::new(&self.strategy_select).disabled(transfer.is_some()),
        );
        SettingsGroup::new("data-config")
            .title(copy::DATA_CONFIG.get(cx))
            .description(copy::DATA_CONFIG_HELP.get(cx))
            .child(
                v_flex()
                    .id("data-categories")
                    .test_support()
                    .aria_label(copy::DATA_CATEGORIES.get(cx))
                    .w_full()
                    .children(categories),
            )
            .child(conflict)
            .children(
                (!connected).then(|| StatusLine::info("data-offline", copy::DATA_OFFLINE.get(cx))),
            )
            .child(ActionRow::new("data-config-actions").child(export).child(import))
    }
}

/// The export's toast: what the file carries.
fn exported(bundle: &ConfigBundle, locale: Locale) -> DataNotice {
    let labels: Vec<&str> =
        bundle.included().into_iter().map(|category| category_label(category, locale)).collect();
    let items = shell_copy::list(locale, &labels);
    DataNotice {
        ok: true,
        title: copy::DATA_EXPORTED.in_locale(locale).to_owned(),
        detail: Some(copy::DATA_EXPORTED_DETAIL.fill(locale, &[("items", &items)])),
    }
}

impl Render for DataPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex().w_full().gap_8().child(self.render_location(cx)).child(self.render_config(cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_transfer::{ConnectionCounts, CredentialCounts};

    #[test]
    fn an_import_summary_is_desktops() {
        let summary = ImportSummary {
            connections: Some(ConnectionCounts { created: 2, overwritten: 0, skipped: 1 }),
            settings: true,
            credentials: Some(CredentialCounts { applied: 3, skipped: 1 }),
            memory: true,
        };
        assert_eq!(
            import_summary(&summary, Locale::English),
            "Connections: 2 created · 0 overwritten · 1 skipped · Settings applied · \
             Credentials: 3 applied (1 skipped) · Memory applied"
        );
        assert_eq!(
            import_summary(&summary, Locale::SimplifiedChinese),
            "连接 新增2·覆盖0·跳过1 · 设置已应用 · 凭据 3（跳过 1） · 记忆已应用"
        );
        let applied = ImportSummary {
            credentials: Some(CredentialCounts { applied: 2, skipped: 0 }),
            ..ImportSummary::default()
        };
        assert_eq!(import_summary(&applied, Locale::English), "Credentials: 2 applied");
        assert_eq!(
            import_summary(&ImportSummary::default(), Locale::English),
            "The file contains no importable data"
        );
    }

    #[test]
    fn the_suggested_file_is_named_for_the_utc_day() {
        assert_eq!(suggested_file_name(1_790_000_000_000), "maka-config-2026-09-21.json");
    }
}
