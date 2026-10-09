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

//! The Extensions page, after Desktop's (`SkillsModuleMain` in
//! packages/ui/src/skills-panel.tsx, the detail in skill-detail.tsx, the
//! states in skill-status.ts): the page ([`ExtensionsView::render_page`]),
//! headed by its title and its search, refresh, and Add menu, then the
//! installed Skills and the ones to discover, and each installed Skill's
//! detail in a dialog.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dialog::Dialog;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::skeleton::Skeleton;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, IconName, Selectable as _, Sizable as _,
    StyledExt as _, ThemeStyled as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyBinding, MouseButton, MouseDownEvent,
    ParentElement as _, PathPromptOptions, Render, Role, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _, px, relative, rems,
};
use host_protocol::{
    SkillCatalogBundledItem, SkillCatalogContextStatus, SkillCatalogGovernanceItem,
    SkillCatalogManagedSourceItem, SkillCatalogManagedUpdateStatus, SkillCatalogPageItem,
    SkillCatalogPreview, SkillCatalogRuntimeStatus, SkillCatalogScope, SkillCatalogSourceType,
    SkillCatalogValidationCode, SkillCatalogValidationStatus,
};
use shared::copy::extensions as copy;
use shared::copy::{self as shell_copy, Locale, Text};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::layout::PAGE_MAX_WIDTH_REMS;
use shared::menu::{MenuEntry, MenuItem, MenuSlot};
use shared::rows::{list_row, row_rule};
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, HEADING_LINE_REMS, HEADING_TEXT_REMS, RADIUS_SURFACE, control_button,
    floating_surface, page_header, plate_radius, quiet_button, selectable_row,
};
use shared::theme::{FadedSwitch, Surface};
use workspace::actions::FocusSearch;
use workspace::{HostSession, ProjectSelection};

use crate::catalog::{ActionFailure, CatalogView, FailureReason, InstallSource, SkillCatalog};
use crate::import::{ImportFailure, import_skill_source, skill_sources_root};
use crate::locations::{
    LocationStatus, SkillLocation, SkillLocationRef, SkillRoots, inspect_locations, open_location,
    resolve_skill_file,
};

/// Key context of the page's body, where the installed Skills are one Tab
/// stop: Up, Down, Home, and End move through them, Enter or Space opens
/// the one under the cursor.
pub const SKILL_LIST_CONTEXT: &str = "SkillList";

/// Key context of the whole page: ⌘F moves focus to its search.
pub const EXTENSIONS_PAGE_CONTEXT: &str = "ExtensionsPage";

/// The Add menu's least width (240px).
const ADD_MENU_WIDTH_REMS: f32 = 15.;

/// The header's search field (Desktop's 220px).
const SEARCH_WIDTH_REMS: f32 = 13.75;

/// The detail dialog (Desktop's 560px) and its label column (120px).
const DETAIL_WIDTH_REMS: f32 = 35.;
const DETAIL_LABEL_WIDTH_REMS: f32 = 7.5;

/// Lines of each side the update review shows (`SKILL_UPDATE_PREVIEW_MAX_LINES`).
const REVIEW_MAX_LINES: usize = 80;

/// The longest search query kept, as Desktop's field.
const SEARCH_MAX_CHARS: usize = 120;

gpui_kit::actions!(
    skill_list,
    [
        /// Move to the installed Skill above.
        SelectPreviousSkill,
        /// Move to the installed Skill below.
        SelectNextSkill,
        /// Move to the first installed Skill.
        SelectFirstSkill,
        /// Move to the last installed Skill.
        SelectLastSkill,
        /// Open the detail of the Skill under the cursor.
        OpenSkill,
    ]
);

/// Binds the page's keys. Called by [`crate::init`].
pub(crate) fn bind_keys(cx: &mut App) {
    let context = Some(SKILL_LIST_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("up", SelectPreviousSkill, context),
        KeyBinding::new("down", SelectNextSkill, context),
        KeyBinding::new("home", SelectFirstSkill, context),
        KeyBinding::new("end", SelectLastSkill, context),
        KeyBinding::new("enter", OpenSkill, context),
        KeyBinding::new("space", OpenSkill, context),
        KeyBinding::new("secondary-f", FocusSearch, Some(EXTENSIONS_PAGE_CONTEXT)),
    ]);
}

/// Opens a file or folder with the system; tests record instead.
pub type Opener = Rc<dyn Fn(&Path, &mut App)>;

/// What the page works on: the window's Host session and projects, the
/// home directory the user's Skill locations and the source library are
/// under, and whether the Host shares this machine's files (only then do
/// the local actions show: importing, the Skill locations, opening a
/// SKILL.md). Cheap to clone.
#[derive(Clone)]
pub struct ExtensionsContext {
    host: Entity<HostSession>,
    projects: Entity<ProjectSelection>,
    home: PathBuf,
    local_paths: bool,
    opener: Opener,
}

impl std::fmt::Debug for ExtensionsContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExtensionsContext")
            .field("home", &self.home)
            .field("local_paths", &self.local_paths)
            .finish_non_exhaustive()
    }
}

impl ExtensionsContext {
    /// The page for a local Host: this user's home, files opened with the
    /// system.
    pub fn new(host: Entity<HostSession>, projects: Entity<ProjectSelection>) -> Self {
        Self {
            host,
            projects,
            home: dirs::home_dir().unwrap_or_default(),
            local_paths: true,
            opener: Rc::new(|path, cx| cx.open_with_system(path)),
        }
    }

    pub fn home(mut self, home: impl Into<PathBuf>) -> Self {
        self.home = home.into();
        self
    }

    /// Whether the Host reads this machine's files, so its paths can be
    /// opened here. A remote Host's cannot.
    pub fn local_paths(mut self, local_paths: bool) -> Self {
        self.local_paths = local_paths;
        self
    }

    pub fn opener(mut self, opener: impl Fn(&Path, &mut App) + 'static) -> Self {
        self.opener = Rc::new(opener);
        self
    }
}

/// The action in flight: one at a time, as in Desktop, and the control
/// that started it shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Pending {
    Refresh,
    Install(SharedString),
    Import,
    Enable(SharedString),
    Pin(SharedString),
    Review(SharedString),
    Update(SharedString),
    Delete(SharedString),
    Open(SharedString),
    Location(SkillLocationRef),
}

/// What the page last had to say about an action.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Feedback {
    Failure(ActionFailure),
    Imported(SharedString),
}

/// An installed Skill's update under review.
#[derive(Debug, Clone, PartialEq)]
struct Review {
    skill_ref: SharedString,
    preview: Box<SkillCatalogPreview>,
}

/// One entry of Discover: a built-in Skill or a source not installed yet.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DiscoverEntry {
    id: SharedString,
    name: SharedString,
    description: SharedString,
    category: SharedString,
    source: InstallSource,
}

/// Behavior and presentation owner of the page. The catalog
/// ([`SkillCatalog`]) owns what the Host says; this view owns the search,
/// the keyboard cursor, the Skill whose detail is open and its update
/// review, the one action in flight, what the last action said, and the
/// Skill locations as last inspected. It lives as long as its window, so
/// leaving the page and coming back finds it as it was.
pub struct ExtensionsView {
    context: ExtensionsContext,
    catalog: Entity<SkillCatalog>,
    search: Entity<InputState>,
    /// The body's focus: the installed Skills' Tab stop.
    focus: FocusHandle,
    scroll: ScrollHandle,
    /// The installed Skill under the keyboard cursor, by ref.
    cursor: Option<SharedString>,
    /// The installed Skill whose detail dialog is open, by ref.
    detail: Option<SharedString>,
    review: Option<Review>,
    pending: Option<Pending>,
    feedback: Option<Feedback>,
    locations: Vec<SkillLocation>,
    /// The Add menu, while it is open.
    add_menu: MenuSlot,
    /// The roots the locations were inspected under; a change inspects
    /// them again.
    inspected: Option<SkillRoots>,
    _action: Option<Task<()>>,
    _inspect: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ExtensionsView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExtensionsView")
            .field("detail", &self.detail)
            .field("pending", &self.pending)
            .finish_non_exhaustive()
    }
}

impl ExtensionsView {
    pub fn new(context: ExtensionsContext, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let catalog =
            cx.new(|cx| SkillCatalog::new(context.host.clone(), context.projects.clone(), cx));
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::SEARCH_SKILLS.get(cx)));
        let subscriptions = vec![
            cx.observe(&catalog, |this, _, cx| {
                this.inspect_locations(cx);
                cx.notify();
            }),
            cx.subscribe_in(&search, window, |this, search, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Change) {
                    let value = search.read(cx).value();
                    if value.chars().count() > SEARCH_MAX_CHARS {
                        let kept: String = value.chars().take(SEARCH_MAX_CHARS).collect();
                        search.update(cx, |search, cx| search.set_value(kept, window, cx));
                    }
                    this.cursor = None;
                    cx.notify();
                }
            }),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let placeholder = copy::SEARCH_SKILLS.get(cx);
                this.search
                    .update(cx, |search, cx| search.set_placeholder(placeholder, window, cx));
            }),
        ];
        Self {
            context,
            catalog,
            search,
            focus: cx.focus_handle().tab_stop(true),
            scroll: ScrollHandle::new(),
            cursor: None,
            detail: None,
            review: None,
            pending: None,
            feedback: None,
            locations: Vec::new(),
            inspected: None,
            _action: None,
            _inspect: None,
            add_menu: MenuSlot::default(),
            _subscriptions: subscriptions,
        }
    }

    pub fn catalog(&self) -> &Entity<SkillCatalog> {
        &self.catalog
    }

    pub fn search(&self) -> &Entity<InputState> {
        &self.search
    }

    /// The installed Skill whose detail is open.
    pub fn detail(&self) -> Option<&SharedString> {
        self.detail.as_ref()
    }

    /// Whether an action is in flight.
    pub fn is_busy(&self) -> bool {
        self.pending.is_some()
    }

    /// The page shows: the catalog is read the first time.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        self.catalog.update(cx, |catalog, cx| catalog.activate(cx));
    }

    /// Moves focus to the installed Skills.
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.focus.focus(window, cx);
    }

    fn query(&self, cx: &App) -> String {
        self.search.read(cx).value().trim().to_lowercase()
    }

    /// ⌘F: the search field, its text selected.
    fn focus_search(&mut self, _: &FocusSearch, window: &mut Window, cx: &mut Context<Self>) {
        self.search.update(cx, |search, cx| {
            search.focus(window, cx);
            search.select_all(window, cx);
        });
    }

    fn busy(&self) -> bool {
        self.pending.is_some()
    }

    /// The roots Skill locations are under: the project's folder as the
    /// Host resolved it, the State Root, and the home directory.
    fn roots(&self, cx: &App) -> SkillRoots {
        let catalog = self.catalog.read(cx);
        let project =
            catalog.installed().listing().map(|listing| PathBuf::from(&listing.workspace.host_cwd));
        SkillRoots::new(
            project,
            self.context.host.read(cx).root().to_path_buf(),
            self.context.home.clone(),
        )
    }

    /// Inspects the Skill locations again in the background when their
    /// roots changed (or `force`).
    fn inspect_locations(&mut self, cx: &mut Context<Self>) {
        self.inspect_locations_with(false, cx);
    }

    fn inspect_locations_with(&mut self, force: bool, cx: &mut Context<Self>) {
        if !self.context.local_paths {
            return;
        }
        let roots = self.roots(cx);
        if !force && self.inspected.as_ref() == Some(&roots) {
            return;
        }
        self.inspected = Some(roots.clone());
        let inspect = cx.background_spawn(async move { inspect_locations(&roots) });
        self._inspect = Some(cx.spawn(async move |this, cx| {
            let locations = inspect.await;
            this.update(cx, |this, cx| {
                this.locations = locations;
                cx.notify();
            })
            .ok();
        }));
    }

    /// Runs `action` as the one action in flight: nothing while another
    /// runs. `then` gets the outcome.
    fn run<R: 'static>(
        &mut self,
        pending: Pending,
        action: Task<R>,
        then: impl FnOnce(&mut Self, R, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy() {
            return;
        }
        self.pending = Some(pending);
        self.feedback = None;
        cx.notify();
        self._action = Some(cx.spawn_in(window, async move |this, cx| {
            let outcome = action.await;
            this.update_in(cx, |this, window, cx| {
                this.pending = None;
                then(this, outcome, window, cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Records a failed action, where the person is looking: in the open
    /// detail, else at the top of the page.
    fn fail(&mut self, failure: ActionFailure) {
        self.feedback = Some(Feedback::Failure(failure));
    }

    fn report(&mut self, outcome: Result<(), ActionFailure>) {
        if let Err(failure) = outcome {
            self.fail(failure);
        }
    }

    /// Reads every view again (the header's refresh).
    pub fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let read = self.catalog.update(cx, |catalog, cx| catalog.read_views(&CatalogView::ALL, cx));
        self.run(
            Pending::Refresh,
            read,
            |this, (), _, cx| this.inspect_locations_with(true, cx),
            window,
            cx,
        );
    }

    /// Installs a Discover entry.
    fn install(&mut self, entry: &DiscoverEntry, window: &mut Window, cx: &mut Context<Self>) {
        let (source, id) = (entry.source, entry.id.clone());
        let task = self.catalog.update(cx, |catalog, cx| catalog.install(source, id.clone(), cx));
        self.run(
            Pending::Install(id),
            task,
            |this, outcome, _, cx| {
                this.report(outcome);
                this.inspect_locations_with(true, cx);
            },
            window,
            cx,
        );
    }

    /// Opens the detail of the installed Skill `skill_ref` in a dialog.
    pub fn open_detail(
        &mut self,
        skill_ref: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.detail.is_some() || window.has_active_dialog(cx) {
            return;
        }
        self.detail = Some(skill_ref.clone());
        self.cursor = Some(skill_ref);
        self.review = None;
        self.feedback = None;
        let view = cx.entity();
        window.open_dialog(cx, move |dialog, window, cx| {
            view.update(cx, |view, cx| view.detail_dialog(dialog, window, cx))
        });
        cx.notify();
    }

    /// The detail dialog went away (Escape, the close button, a press
    /// outside, or once its Skill was deleted).
    fn detail_closed(&mut self, cx: &mut Context<Self>) {
        self.detail = None;
        self.review = None;
        if matches!(self.feedback, Some(Feedback::Failure(_))) {
            self.feedback = None;
        }
        cx.notify();
    }

    pub fn set_enabled(
        &mut self,
        skill_ref: SharedString,
        enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let task = self
            .catalog
            .update(cx, |catalog, cx| catalog.set_enabled(skill_ref.clone(), enabled, cx));
        self.run(
            Pending::Enable(skill_ref),
            task,
            |this, outcome, _, _| this.report(outcome),
            window,
            cx,
        );
    }

    pub fn set_pinned(
        &mut self,
        skill_ref: SharedString,
        pinned: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let task = self
            .catalog
            .update(cx, |catalog, cx| catalog.set_pinned(skill_ref.clone(), pinned, cx));
        self.run(
            Pending::Pin(skill_ref),
            task,
            |this, outcome, _, _| this.report(outcome),
            window,
            cx,
        );
    }

    /// Reads the update's preview and shows it in the detail.
    pub fn review_update(
        &mut self,
        skill_ref: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let task =
            self.catalog.update(cx, |catalog, cx| catalog.preview_update(skill_ref.clone(), cx));
        let reviewed = skill_ref.clone();
        self.run(
            Pending::Review(skill_ref),
            task,
            move |this, outcome, _, _| match outcome {
                Ok(preview) if this.detail.as_ref() == Some(&reviewed) => {
                    this.review = Some(Review { skill_ref: reviewed, preview });
                }
                Ok(_) => {}
                Err(failure) => this.fail(failure),
            },
            window,
            cx,
        );
    }

    /// Applies the reviewed update, over local changes when the Skill has
    /// them (the preview's hashes confirm what was shown).
    pub fn apply_update(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(review) = self.review.clone() else {
            return;
        };
        let local_modified = self.installed_skill(&review.skill_ref, cx).is_some_and(|skill| {
            skill.managed_update_status == Some(SkillCatalogManagedUpdateStatus::LocalModified)
        });
        let overwrite = local_modified.then(|| {
            (
                review.preview.expected_current_sha256.clone(),
                review.preview.expected_source_sha256.clone(),
            )
        });
        let skill_ref = review.skill_ref.clone();
        let task =
            self.catalog.update(cx, |catalog, cx| catalog.update(skill_ref.clone(), overwrite, cx));
        self.run(
            Pending::Update(skill_ref),
            task,
            |this, outcome, _, _| match outcome {
                Ok(()) => this.review = None,
                Err(failure) => this.fail(failure),
            },
            window,
            cx,
        );
    }

    /// Asks before deleting a Skill's files, over its detail; Cancel leaves
    /// the detail as it was.
    pub fn confirm_delete(
        &mut self,
        skill_ref: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(skill) = self.installed_skill(&skill_ref, cx) else {
            return;
        };
        let locale = Locale::current(cx);
        let title: SharedString = copy::delete_skill_title(locale, &skill.name).into();
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let (view, skill_ref) = (view.clone(), skill_ref.clone());
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(title.clone()))
                .description(shared::dialog::confirmation_text(copy::DELETE_SKILL_BODY.get(cx)))
                .footer(shared::dialog::confirmation_answers(
                    shell_copy::CANCEL.get(cx),
                    shell_copy::DELETE.get(cx),
                    true,
                    cx,
                ))
                .on_ok(move |_, window, cx| {
                    view.update(cx, |view, cx| view.delete(skill_ref.clone(), window, cx)).ok();
                    true
                })
        });
    }

    /// Deletes a Skill's files; its detail closes once it is gone.
    pub fn delete(&mut self, skill_ref: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let task = self.catalog.update(cx, |catalog, cx| catalog.delete(skill_ref.clone(), cx));
        let deleted = skill_ref.clone();
        self.run(
            Pending::Delete(skill_ref),
            task,
            move |this, outcome, window, cx| match outcome {
                Ok(()) => {
                    if this.detail.as_ref() == Some(&deleted) {
                        // The confirmation closed first; the detail is on top.
                        if window.has_active_dialog(cx) {
                            window.close_dialog(cx);
                        }
                        this.detail_closed(cx);
                    }
                    if this.cursor.as_ref() == Some(&deleted) {
                        this.cursor = None;
                    }
                    this.inspect_locations_with(true, cx);
                }
                Err(failure) => this.fail(failure),
            },
            window,
            cx,
        );
    }

    /// Opens the Skill's SKILL.md with the system.
    pub fn open_skill_file(
        &mut self,
        skill_ref: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let roots = self.roots(cx);
        let target = skill_ref.to_string();
        let resolve = cx.background_spawn(async move { resolve_skill_file(&roots, &target) });
        let opener = self.context.opener.clone();
        self.run(
            Pending::Open(skill_ref),
            resolve,
            move |this, outcome, _, cx| match outcome {
                Ok(path) => opener(&path, cx),
                Err(failure) => this.fail(ActionFailure::new(
                    copy::OPEN_FAILED,
                    FailureReason::Text(failure.reason()),
                )),
            },
            window,
            cx,
        );
    }

    /// Opens a Skill location in the file manager, creating it first when
    /// it is missing.
    pub fn open_location(
        &mut self,
        location: SkillLocationRef,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let create = self
            .locations
            .iter()
            .any(|shown| shown.location == location && shown.status == LocationStatus::Missing);
        let roots = self.roots(cx);
        let open = cx.background_spawn(async move { open_location(&roots, location, create) });
        let opener = self.context.opener.clone();
        self.run(
            Pending::Location(location),
            open,
            move |this, outcome, _, cx| {
                match outcome {
                    Ok(path) => opener(&path, cx),
                    Err(failure) => this.fail(ActionFailure::new(
                        copy::OPEN_LOCATION_FAILED,
                        FailureReason::Text(failure.reason()),
                    )),
                }
                if create {
                    this.inspect_locations_with(true, cx);
                }
            },
            window,
            cx,
        );
    }

    /// Asks for a SKILL.md and imports it into the source library.
    pub fn import_local(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy() {
            return;
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(copy::IMPORT.get(cx).into()),
        });
        self._action = Some(cx.spawn_in(window, async move |this, cx| {
            let path = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                Ok(Err(error)) => {
                    log::warn!("the file dialog failed: {error:#}");
                    None
                }
                _ => None,
            };
            let Some(path) = path else {
                return;
            };
            this.update_in(cx, |this, window, cx| this.import_file(path, window, cx)).ok();
        }));
    }

    /// Imports `path` into the source library, then reads the sources
    /// again.
    pub fn import_file(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let root = skill_sources_root(&self.context.home);
        let import = cx.background_spawn(async move { import_skill_source(&root, &path) });
        let catalog = self.catalog.downgrade();
        let task = cx.spawn(async move |_, cx| {
            let imported = import.await;
            if imported.is_ok()
                && let Ok(read) = catalog
                    .update(cx, |catalog, cx| catalog.read_views(&[CatalogView::Sources], cx))
            {
                read.await;
            }
            imported
        });
        self.run(
            Pending::Import,
            task,
            |this, outcome, _, _| match outcome {
                Ok(source) => this.feedback = Some(Feedback::Imported(source.name.into())),
                Err(failure) => this.fail(ActionFailure::new(
                    copy::IMPORT_FAILED,
                    FailureReason::Text(import_reason(failure)),
                )),
            },
            window,
            cx,
        );
    }

    /// The installed Skill `skill_ref` names.
    fn installed_skill<'a>(
        &self,
        skill_ref: &str,
        cx: &'a App,
    ) -> Option<&'a SkillCatalogGovernanceItem> {
        self.catalog.read(cx).installed().items().iter().find_map(|item| match item {
            SkillCatalogPageItem::Skill(skill) if skill.skill_ref == skill_ref => Some(skill),
            _ => None,
        })
    }

    /// The installed Skills and diagnostics the search finds, in the
    /// Host's order.
    fn visible_installed<'a>(&self, query: &str, cx: &'a App) -> Vec<&'a SkillCatalogPageItem> {
        let roots = self.roots(cx);
        self.catalog
            .read(cx)
            .installed()
            .items()
            .iter()
            .filter(|item| {
                let Some(skill) = item.governance() else {
                    return false;
                };
                let path = roots
                    .skill_dir(&skill.skill_ref)
                    .map(|path| path.display().to_string())
                    .unwrap_or_default();
                matches_query(query, &[&skill.id, &skill.name, &skill.description, &path])
            })
            .collect()
    }

    /// The refs of the visible installed Skills: what the cursor moves
    /// through.
    fn cursor_refs(&self, cx: &App) -> Vec<SharedString> {
        let query = self.query(cx);
        self.visible_installed(&query, cx)
            .into_iter()
            .filter_map(|item| match item {
                SkillCatalogPageItem::Skill(skill) => Some(skill.skill_ref.clone().into()),
                _ => None,
            })
            .collect()
    }

    /// Built-in Skills and sources not installed, as one list by name; an
    /// id offered by both is installed through its built-in entry.
    fn discover_entries(&self, query: &str, cx: &App) -> Vec<DiscoverEntry> {
        let catalog = self.catalog.read(cx);
        let locale = Locale::current(cx);
        let installed: std::collections::HashSet<&str> = catalog
            .installed()
            .items()
            .iter()
            .filter_map(|item| match item {
                SkillCatalogPageItem::Skill(skill) => Some(skill.id.as_str()),
                _ => None,
            })
            .collect();
        let mut entries: Vec<DiscoverEntry> = Vec::new();
        for item in catalog.bundled().items() {
            if item.installed || installed.contains(item.id.as_str()) {
                continue;
            }
            entries.push(bundled_entry(item, locale));
        }
        for item in catalog.sources().items() {
            if installed.contains(item.id.as_str()) || entries.iter().any(|e| e.id == item.id) {
                continue;
            }
            entries.push(source_entry(item, locale));
        }
        entries.sort_by_cached_key(|entry| entry.name.to_lowercase());
        entries
            .into_iter()
            .filter(|entry| {
                matches_query(query, &[&entry.id, &entry.name, &entry.description, &entry.category])
            })
            .collect()
    }

    /// Moves the cursor, while the list's Tab stop itself has focus; for a
    /// control inside the page (an Install button) the key goes on to it.
    fn move_cursor(&mut self, step: CursorStep, window: &Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window) {
            cx.propagate();
            return;
        }
        let refs = self.cursor_refs(cx);
        let Some(last) = refs.len().checked_sub(1) else {
            return;
        };
        let current = self.cursor.as_ref().and_then(|cursor| refs.iter().position(|r| r == cursor));
        let target = match (step, current) {
            (CursorStep::First, _) | (CursorStep::Next, None) => 0,
            (CursorStep::Last, _) | (CursorStep::Previous, None) => last,
            (CursorStep::Next, Some(ix)) => (ix + 1).min(last),
            (CursorStep::Previous, Some(ix)) => ix.saturating_sub(1),
        };
        self.cursor = Some(refs[target].clone());
        cx.notify();
    }

    fn select_previous(
        &mut self,
        _: &SelectPreviousSkill,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_cursor(CursorStep::Previous, window, cx);
    }

    fn select_next(&mut self, _: &SelectNextSkill, window: &mut Window, cx: &mut Context<Self>) {
        self.move_cursor(CursorStep::Next, window, cx);
    }

    fn select_first(&mut self, _: &SelectFirstSkill, window: &mut Window, cx: &mut Context<Self>) {
        self.move_cursor(CursorStep::First, window, cx);
    }

    fn select_last(&mut self, _: &SelectLastSkill, window: &mut Window, cx: &mut Context<Self>) {
        self.move_cursor(CursorStep::Last, window, cx);
    }

    fn open_cursor(&mut self, _: &OpenSkill, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window) {
            cx.propagate();
            return;
        }
        let refs = self.cursor_refs(cx);
        if let Some(cursor) = self.cursor.clone().filter(|cursor| refs.contains(cursor)) {
            self.open_detail(cursor, window, cx);
        }
    }

    /// The page header's controls: the search, the refresh, and (for a
    /// Host on this machine) the Add menu.
    fn render_header_actions(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let busy = self.busy();
        let refreshing = self.pending == Some(Pending::Refresh);
        let refresh_label = if refreshing { copy::REFRESHING } else { copy::REFRESH };
        let refresh = Button::new("skills-refresh")
            .ghost()
            .small()
            .size_7()
            .icon(Icon::new(IconName::RotateCw).size_4().text_color(maka.ink_muted))
            .loading(refreshing)
            .disabled(busy && !refreshing)
            .accessibility_label(refresh_label.get(cx))
            .tooltip(copy::REFRESH.get(cx))
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.refresh(window, cx)));
        h_flex()
            .id("extensions-actions")
            .test_support()
            .flex_shrink_0()
            .gap_2()
            .child(
                Input::new(&self.search)
                    .field_fill(cx)
                    .px_3()
                    .w(rems(SEARCH_WIDTH_REMS))
                    .aria_label(copy::SEARCH_SKILLS.get(cx))
                    .prefix(Icon::new(MakaIcon::Search).small())
                    .cleanable(true),
            )
            .child(refresh)
            .when(self.context.local_paths, |this| this.child(self.render_add_menu(cx)))
            .into_any_element()
    }

    /// Add: "Import local Skill…" and "Skill locations…", Desktop's two
    /// local actions, in Maka's menu (32px rows, 16px icons).
    fn render_add_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let button = control_button(Button::new("skills-add").primary())
            .icon(Icon::new(MakaIcon::Plus))
            .label(copy::ADD.get(cx))
            .loading(matches!(self.pending, Some(Pending::Import)))
            .disabled(self.busy())
            .selected(self.add_menu.is_open())
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                let width = window.rem_size() * ADD_MENU_WIDTH_REMS;
                MenuSlot::toggle(
                    this,
                    |view| &mut view.add_menu,
                    event,
                    add_menu,
                    width,
                    window,
                    cx,
                );
            }));
        div().relative().child(button).children(self.add_menu.layer()).into_any_element()
    }

    /// Opens the Add menu with its Skill locations submenu, for captures.
    /// Whether it shows.
    pub fn open_add_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if let Some(menu) = self.add_menu.menu().cloned() {
            return menu.update(cx, |menu, cx| menu.open_submenu_of("skill-locations", cx));
        }
        if self.locations.is_empty() {
            // Not inspected yet: the menu would have no locations.
            return false;
        }
        let width = window.rem_size() * ADD_MENU_WIDTH_REMS;
        let entries = add_menu(self, cx);
        MenuSlot::open(self, |view| &mut view.add_menu, entries, width, window, cx);
        false
    }

    /// How many installed Skills (disabled, shadowed and rejected ones
    /// included) each location holds (`withSkillLocationCounts`), and the
    /// status a diagnostic reports for it.
    fn location_counts(&self, cx: &App) -> Vec<(SkillLocationRef, usize, Option<LocationStatus>)> {
        let items = self.catalog.read(cx).installed().items();
        SkillLocationRef::ALL
            .into_iter()
            .map(|location| {
                let at = |skill: &&SkillCatalogGovernanceItem| {
                    SkillLocationRef::of(skill.scope.as_str(), skill.source.as_str())
                        == Some(location)
                };
                let count = items
                    .iter()
                    .filter_map(|item| match item {
                        SkillCatalogPageItem::Skill(skill) => Some(skill),
                        _ => None,
                    })
                    .filter(at)
                    .count();
                let diagnostic = items.iter().find_map(|item| match item {
                    SkillCatalogPageItem::DiscoveryDiagnostic(diagnostic) if at(&diagnostic) => {
                        diagnostic_status(diagnostic)
                    }
                    _ => None,
                });
                (location, count, diagnostic)
            })
            .collect()
    }

    /// The page under the header: the tab, what the last action said, and
    /// the Skills tab, in the page's column, which scrolls inside the plate.
    pub fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let query = self.query(cx);
        let keyboard = self.focus.is_focused(window) && window.last_input_was_keyboard();
        let content = self.render_skills(&query, keyboard, window, cx);
        let maka = cx.maka();
        // Desktop's Skills / MCP tabs: MCP is Desktop's own (its main
        // process runs the MCP clients), and a strip with one tab says
        // nothing, so the page has none while Skills is the only one.
        let header =
            page_header(copy::EXTENSIONS.get(cx), None, self.render_header_actions(window, cx), cx);
        div()
            .id("extensions-page")
            .test_support()
            .key_context(EXTENSIONS_PAGE_CONTEXT)
            .on_action(cx.listener(Self::focus_search))
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(
                div()
                    .id("extensions-body")
                    .test_support()
                    .track_focus(&self.focus)
                    .key_context(SKILL_LIST_CONTEXT)
                    .on_action(cx.listener(Self::select_previous))
                    .on_action(cx.listener(Self::select_next))
                    .on_action(cx.listener(Self::select_first))
                    .on_action(cx.listener(Self::select_last))
                    .on_action(cx.listener(Self::open_cursor))
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        v_flex()
                            .w_full()
                            .max_w(rems(PAGE_MAX_WIDTH_REMS))
                            .mx_auto()
                            .px_6()
                            .pb_12()
                            .gap_6()
                            .text_color(maka.ink)
                            .child(header)
                            .children(self.render_page_feedback(cx))
                            .child(content),
                    ),
            )
            .child(Scrollbar::vertical(&self.scroll))
            .into_any_element()
    }

    /// What the last action said, at the top of the page, unless the
    /// detail it concerns is open.
    fn render_page_feedback(&self, cx: &App) -> Option<AnyElement> {
        if self.detail.is_some() {
            return None;
        }
        self.feedback.as_ref().map(|feedback| render_feedback("extensions-feedback", feedback, cx))
    }

    fn render_skills(
        &mut self,
        query: &str,
        keyboard: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (needs_folder, offline, loading, installed_error, has_installed) = {
            let catalog = self.catalog.read(cx);
            let installed = catalog.installed();
            let connected = catalog.host().read(cx).is_connected();
            (
                catalog.workspace().is_none() && !catalog.is_waiting_for_projects(cx),
                installed.listing().is_none() && !connected,
                installed.listing().is_none() && installed.error().is_none(),
                installed.error().cloned(),
                !installed.items().is_empty(),
            )
        };
        if needs_folder {
            return notice("extensions-needs-folder", copy::NEEDS_FOLDER.get(cx), cx);
        }
        if offline {
            return notice("extensions-offline", copy::OFFLINE.get(cx), cx);
        }
        let visible: Vec<SkillCatalogPageItem> =
            self.visible_installed(query, cx).into_iter().cloned().collect();
        let discover = self.discover_entries(query, cx);
        let searching = !query.is_empty();
        let mut sections = Vec::new();
        if searching {
            sections.push(self.render_search_summary(visible.len() + discover.len(), cx));
        }
        if searching && visible.is_empty() && discover.is_empty() {
            let clear = self.clear_search_button(cx);
            sections.push(empty_state(
                "skills-empty-search",
                Icon::new(AssetIcon::Search),
                copy::EMPTY_SEARCH_TITLE.get(cx),
                copy::EMPTY_SEARCH_BODY.get(cx),
                Some(clear),
                cx,
            ));
            return v_flex().gap_6().children(sections).into_any_element();
        }
        if !(searching && visible.is_empty()) {
            let body = if loading {
                render_skeleton()
            } else if !has_installed {
                let refresh = quiet_button(Button::new("skills-empty-refresh"), cx)
                    .label(if self.pending == Some(Pending::Refresh) {
                        copy::REFRESHING.get(cx)
                    } else {
                        copy::REFRESH_SKILLS.get(cx)
                    })
                    .disabled(self.busy())
                    .on_click(
                        cx.listener(|this, _: &ClickEvent, window, cx| this.refresh(window, cx)),
                    )
                    .into_any_element();
                empty_state(
                    "skills-empty",
                    Icon::new(AssetIcon::Blocks),
                    copy::EMPTY_TITLE.get(cx),
                    copy::EMPTY_BODY.get(cx),
                    Some(refresh),
                    cx,
                )
            } else {
                self.render_installed(&visible, keyboard, window, cx)
            };
            let note = installed_error
                .map(|failure| self.render_read_error(CatalogView::Installed, &failure, cx));
            sections.push(section(
                "skills-installed-section",
                copy::INSTALLED.get(cx),
                note,
                body,
                cx,
            ));
        }
        if !discover.is_empty() {
            let body = self.render_discover(&discover, searching, cx);
            sections.push(section(
                "skills-discover-section",
                copy::DISCOVER.get(cx),
                None,
                body,
                cx,
            ));
        }
        v_flex().gap_8().children(sections).into_any_element()
    }

    fn render_search_summary(&self, count: usize, cx: &mut Context<Self>) -> AnyElement {
        h_flex()
            .id("skills-search-summary")
            .test_support()
            .aria_label(copy::search_matches(Locale::current(cx), count))
            .gap_2()
            .text_xs()
            .text_color(cx.maka().ink_muted)
            .child(copy::search_matches(Locale::current(cx), count))
            .child(self.clear_search_button(cx))
            .into_any_element()
    }

    fn clear_search_button(&self, cx: &mut Context<Self>) -> AnyElement {
        quiet_button(Button::new("skills-clear-search"), cx)
            .label(copy::CLEAR_SEARCH.get(cx))
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                this.search.update(cx, |search, cx| search.set_value("", window, cx));
                cx.notify();
            }))
            .into_any_element()
    }

    /// A failed read of `view`: why, and Retry.
    fn render_read_error(
        &self,
        view: CatalogView,
        failure: &ActionFailure,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let retry =
            quiet_button(Button::new(domain_element_id("skills-retry", read_key(view))), cx)
                .label(shell_copy::RETRY.get(cx))
                .disabled(self.busy())
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.catalog.update(cx, |catalog, cx| catalog.reload(&[view], cx));
                }));
        h_flex()
            .items_start()
            .gap_2()
            .child(render_failure(&format!("skills-read-{}", read_key(view)), failure, cx))
            .child(retry)
            .into_any_element()
    }

    /// The installed Skills, one row each, the Tab stop's rows.
    fn render_installed(
        &self,
        items: &[SkillCatalogPageItem],
        keyboard: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        // Two visible Skills with one name show their ids.
        let mut names = std::collections::HashMap::<&str, usize>::new();
        for item in items {
            if let SkillCatalogPageItem::Skill(skill) = item {
                *names.entry(skill.name.as_str()).or_default() += 1;
            }
        }
        // Only what draws a row is a row: a rule goes between rows, never
        // under the last.
        let shown: Vec<&SkillCatalogPageItem> = items
            .iter()
            .filter(|item| {
                matches!(
                    item,
                    SkillCatalogPageItem::DiscoveryDiagnostic(_) | SkillCatalogPageItem::Skill(_)
                )
            })
            .collect();
        let len = shown.len();
        let rows = shown.into_iter().enumerate().map(|(ix, item)| match item {
            SkillCatalogPageItem::Skill(skill) => {
                let duplicate = names.get(skill.name.as_str()).is_some_and(|count| *count > 1);
                let cursor = keyboard && self.cursor.as_deref() == Some(skill.skill_ref.as_str());
                self.render_skill_row(skill, duplicate, cursor, (ix, len), window, cx)
            }
            SkillCatalogPageItem::DiscoveryDiagnostic(diagnostic) => {
                render_diagnostic(diagnostic, locale, cx)
            }
            _ => unreachable!("filtered above"),
        });
        rows_with_rules("skills-installed", Role::List, rows.collect(), cx)
    }

    fn render_skill_row(
        &self,
        skill: &SkillCatalogGovernanceItem,
        duplicate: bool,
        cursor: bool,
        (ix, len): (usize, usize),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let skill_ref: SharedString = skill.skill_ref.clone().into();
        let selected = self.detail.as_ref() == Some(&skill_ref);
        let status = exceptional_label(skill)
            .map(|label| (semantic(skill), label))
            .or_else(|| (!skill.enabled).then_some((Semantic::Neutral, copy::STATUS_DISABLED)));
        let description = library_description(skill, locale);
        let focus = self.focus.clone();
        let opened = skill_ref.clone();
        let label = match &status {
            Some((_, status)) => {
                shell_copy::parts(locale, &[&skill.name, status.in_locale(locale)])
            }
            None => skill.name.clone(),
        };
        h_flex()
            .id(domain_element_id("skill-row", &skill.skill_ref))
            .test_support()
            .role(Role::ListItem)
            .aria_label(label)
            .aria_selected(selected)
            .w_full()
            .min_h(rems(3.5))
            .py_2()
            .gap_3()
            .map(|this| list_row(this, ix, len))
            // Its detail opens in a modal dialog, so a selected fill would
            // only show under the scrim (review round 10): the row hovers
            // and keeps its selection for assistive technology only.
            .map(|this| selectable_row(this, false, cx))
            .when(cursor, |this| this.focus_ring_style(window, cx))
            .on_mouse_down(MouseButton::Left, move |_: &MouseDownEvent, window, cx| {
                // The list's one Tab stop keeps focus, not the row.
                window.prevent_default();
                focus.focus(window, cx);
            })
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.open_detail(opened.clone(), window, cx);
            }))
            .child(monogram(&skill.name, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap_2()
                            .text_sm()
                            .font_medium()
                            .child(div().min_w_0().truncate().child(skill.name.clone()))
                            .when(duplicate, |this| {
                                this.child(
                                    div()
                                        .flex_shrink_0()
                                        .text_xs()
                                        .font_family(cx.theme().mono_font_family.clone())
                                        .text_color(maka.ink_muted)
                                        .child(skill.id.clone()),
                                )
                            }),
                    )
                    // Desktop's ModuleRow description: body, 14/20, muted.
                    .when_some(description, |this, description| {
                        this.child(
                            div()
                                .truncate()
                                .text_sm()
                                .text_color(maka.ink_muted)
                                .child(description),
                        )
                    }),
            )
            .children(status.map(|(semantic, label)| status_label(semantic, label.get(cx), cx)))
            .into_any_element()
    }

    /// Discover: one row per entry with Install; grouped by category while
    /// browsing more than one.
    fn render_discover(
        &self,
        entries: &[DiscoverEntry],
        searching: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut groups: Vec<(SharedString, Vec<&DiscoverEntry>)> = Vec::new();
        for entry in entries {
            match groups.iter_mut().find(|(category, _)| *category == entry.category) {
                Some((_, members)) => members.push(entry),
                None => groups.push((entry.category.clone(), vec![entry])),
            }
        }
        let grouped = !searching && groups.len() > 1;
        if !grouped {
            let rows = entries.iter().map(|entry| self.render_discover_row(entry, cx)).collect();
            return rows_with_rules("skills-discover", Role::List, rows, cx);
        }
        v_flex()
            .gap_4()
            .children(groups.into_iter().map(|(category, members)| {
                let rows =
                    members.iter().map(|entry| self.render_discover_row(entry, cx)).collect();
                v_flex()
                    .id(domain_element_id("skills-category", &category))
                    .test_support()
                    .aria_label(category.clone())
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .font_medium()
                            .text_color(cx.maka().ink_muted)
                            .child(category.clone()),
                    )
                    .child(rows_with_rules(
                        domain_element_id("skills-discover", &category),
                        Role::List,
                        rows,
                        cx,
                    ))
            }))
            .into_any_element()
    }

    fn render_discover_row(&self, entry: &DiscoverEntry, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let installing = self.pending == Some(Pending::Install(entry.id.clone()));
        let installed = entry.clone();
        h_flex()
            .id(domain_element_id("skill-discover", &entry.id))
            .test_support()
            .role(Role::ListItem)
            .aria_label(entry.name.clone())
            .w_full()
            .min_h(rems(3.5))
            .py_2()
            .gap_3()
            .child(monogram(&entry.name, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(div().truncate().text_sm().font_medium().child(entry.name.clone()))
                    .child(
                        div()
                            .truncate()
                            .text_sm()
                            .text_color(maka.ink_muted)
                            .child(entry.description.clone()),
                    ),
            )
            .child(
                // Desktop's `size="sm"`: 28 tall.
                quiet_button(Button::new(domain_element_id("skill-install", &entry.id)), cx)
                    .h_7()
                    .label(copy::INSTALL.get(cx))
                    .accessibility_label(copy::install_named(locale, &entry.name))
                    .loading(installing)
                    .disabled(self.busy() && !installing)
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        this.install(&installed, window, cx);
                    })),
            )
            .into_any_element()
    }

    /// The detail dialog of the Skill `self.detail` names, built every time
    /// the dialog draws, so it follows the catalog: the Skill's facts and
    /// switches, or its update review.
    fn detail_dialog(
        &mut self,
        dialog: Dialog,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Dialog {
        let width = window.rem_size() * DETAIL_WIDTH_REMS;
        let view = cx.entity().downgrade();
        let dialog = floating_surface(dialog, cx).w(width).on_close(move |_, _, cx| {
            view.update(cx, |view, cx| view.detail_closed(cx)).ok();
        });
        let Some(skill_ref) = self.detail.clone() else {
            return dialog;
        };
        let Some(skill) = self.installed_skill(&skill_ref, cx).cloned() else {
            // It left the catalog (another client deleted it).
            return dialog.with_header(skill_header(copy::SKILLS.get(cx))).child(
                div()
                    .text_sm()
                    .text_color(cx.maka().ink_muted)
                    .child(copy::SKILL_NOT_FOUND.get(cx)),
            );
        };
        match self.review.clone().filter(|review| review.skill_ref == skill_ref) {
            Some(review) => self.review_dialog(dialog, &skill, &review, cx),
            None => self.facts_dialog(dialog, &skill, cx),
        }
    }

    fn facts_dialog(
        &self,
        dialog: Dialog,
        skill: &SkillCatalogGovernanceItem,
        cx: &mut Context<Self>,
    ) -> Dialog {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let skill_ref: SharedString = skill.skill_ref.clone().into();
        let busy = self.busy();
        let broken = skill.runtime_status == SkillCatalogRuntimeStatus::StateError
            || context_status(skill) == SkillCatalogContextStatus::Invalid;
        let reviewable = matches!(
            skill.managed_update_status,
            Some(
                SkillCatalogManagedUpdateStatus::UpdateAvailable
                    | SkillCatalogManagedUpdateStatus::LocalModified
            )
        );
        let banner = exceptional_label(skill).map(|label| {
            let review_label = if self.pending == Some(Pending::Review(skill_ref.clone())) {
                copy::REVIEWING
            } else if skill.managed_update_status
                == Some(SkillCatalogManagedUpdateStatus::LocalModified)
            {
                copy::VIEW_DIFF
            } else {
                copy::VIEW_UPDATE
            };
            let reviewed = skill_ref.clone();
            let review = reviewable.then(|| {
                quiet_button(Button::new("skill-review-update"), cx)
                    .label(review_label.get(cx))
                    .disabled(busy)
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        this.review_update(reviewed.clone(), window, cx);
                    }))
            });
            h_flex()
                .id("skill-detail-banner")
                .test_support()
                .aria_label(label.get(cx))
                .w_full()
                .gap_2()
                .px_3()
                .py_2()
                .rounded(RADIUS_SURFACE)
                .border_1()
                .border_color(maka.border_soft)
                .child(status_label(semantic(skill), label.get(cx), cx))
                .child(div().flex_1())
                .children(review)
        });
        let enabled_ref = skill_ref.clone();
        let enabled = {
            let (checked, disabled) = (skill.enabled, busy || broken);
            FadedSwitch::new(
                Switch::new("skill-detail-enabled")
                    .checked(checked)
                    .disabled(disabled)
                    .accessibility_label(copy::DETAIL_ENABLED.get(cx))
                    .on_click(cx.listener(move |this, checked: &bool, window, cx| {
                        this.set_enabled(enabled_ref.clone(), *checked, window, cx);
                    })),
                checked,
                disabled,
            )
            .on(Surface::Overlay)
        };
        let pinned_ref = skill_ref.clone();
        let pinned = {
            let (checked, disabled) = (skill.pinned, busy || broken);
            FadedSwitch::new(
                Switch::new("skill-detail-pinned")
                    .checked(checked)
                    .disabled(disabled)
                    .accessibility_label(copy::PIN_TO_CONTEXT.get(cx))
                    .on_click(cx.listener(move |this, checked: &bool, window, cx| {
                        this.set_pinned(pinned_ref.clone(), *checked, window, cx);
                    })),
                checked,
                disabled,
            )
            .on(Surface::Overlay)
        };
        let mut facts = vec![
            fact("skill-detail-enabled-row", copy::DETAIL_ENABLED.get(cx), enabled, cx),
            fact("skill-detail-pinned-row", copy::PIN_TO_CONTEXT.get(cx), pinned, cx),
        ];
        if skill.id != skill.name {
            facts.push(text_fact(
                "skill-detail-id",
                copy::DETAIL_ID.get(cx),
                machine_text(skill.id.clone(), cx),
                cx,
            ));
        }
        if self.context.local_paths
            && let Some(path) = self.roots(cx).skill_dir(&skill.skill_ref)
        {
            facts.push(text_fact(
                "skill-detail-path",
                copy::DETAIL_PATH.get(cx),
                machine_text(path.display().to_string(), cx),
                cx,
            ));
        }
        let scope = [
            Some(scope_label(&skill.scope).in_locale(locale)),
            Some(if skill.source_type == SkillCatalogSourceType::Managed {
                copy::STATUS_MANAGED.in_locale(locale)
            } else {
                status_word(skill).in_locale(locale)
            }),
        ];
        let scope: Vec<&str> = scope.into_iter().flatten().collect();
        facts.push(text_fact(
            "skill-detail-scope",
            copy::DETAIL_SCOPE.get(cx),
            scope.join(" · "),
            cx,
        ));
        if !skill.declared_tools.is_empty() {
            facts.push(text_fact(
                "skill-detail-tools",
                copy::DETAIL_TOOLS.get(cx),
                skill.declared_tools.join(", "),
                cx,
            ));
        }
        let feedback = self
            .feedback
            .as_ref()
            .map(|feedback| render_feedback("skill-detail-feedback", feedback, cx));
        let content = v_flex()
            .id("skill-detail")
            .test_support()
            .gap_4()
            .children(feedback)
            .children(banner)
            .child(v_flex().children(facts));
        let delete_ref = skill_ref.clone();
        let open_ref = skill_ref.clone();
        let opening = self.pending == Some(Pending::Open(skill_ref.clone()));
        let deleting = self.pending == Some(Pending::Delete(skill_ref.clone()));
        let footer = h_flex()
            .w_full()
            .gap_2()
            .when(skill.manageable, |this| {
                this.child(
                    shared::theme::destructive_button(Button::new("skill-detail-delete"), cx)
                        .label(shell_copy::DELETE.get(cx))
                        .loading(deleting)
                        .disabled(busy && !deleting)
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.confirm_delete(delete_ref.clone(), window, cx);
                        })),
                )
            })
            .child(div().flex_1())
            .when(self.context.local_paths, |this| {
                this.child(
                    quiet_button(Button::new("skill-detail-open"), cx)
                        .label(if opening {
                            copy::OPENING.get(cx)
                        } else {
                            copy::OPEN_SKILL_MD.get(cx)
                        })
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.open_skill_file(open_ref.clone(), window, cx);
                        })),
                )
            });
        dialog
            .with_header(
                skill_header(skill.name.clone())
                    .when_some(library_description(skill, locale), |header, description| {
                        header.subtitle(description)
                    }),
            )
            .child(content)
            .with_footer(footer)
    }

    fn review_dialog(
        &self,
        dialog: Dialog,
        skill: &SkillCatalogGovernanceItem,
        review: &Review,
        cx: &mut Context<Self>,
    ) -> Dialog {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let preview = &review.preview;
        let local_modified =
            skill.managed_update_status == Some(SkillCatalogManagedUpdateStatus::LocalModified);
        let summary = [
            status_word(skill).in_locale(locale).to_owned(),
            copy::REVIEW_MANAGED_SOURCE.in_locale(locale).to_owned(),
            if preview.has_managed_baseline {
                copy::REVIEW_HAS_BASELINE.in_locale(locale).to_owned()
            } else {
                copy::REVIEW_NO_BASELINE.in_locale(locale).to_owned()
            },
            copy::review_lines(
                locale,
                preview.summary.current_line_count,
                preview.summary.source_line_count,
            ),
            copy::review_changed(locale, preview.summary.changed_line_count),
        ];
        let side = |key: &'static str, label: Text, text: &str, cx: &App| {
            v_flex()
                .id(key)
                .test_support()
                .flex_1()
                .min_w_0()
                .gap_1()
                .child(
                    div().text_xs().font_medium().text_color(maka.ink_muted).child(label.get(cx)),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("{key}-text")))
                        .max_h(rems(20.))
                        .overflow_y_scroll()
                        .p_3()
                        .rounded(RADIUS_SURFACE)
                        .bg(maka.code)
                        .font_family(cx.theme().mono_font_family.clone())
                        .text_xs()
                        .child(preview_text(text)),
                )
        };
        let feedback = self
            .feedback
            .as_ref()
            .map(|feedback| render_feedback("skill-review-feedback", feedback, cx));
        let content = v_flex()
            .id("skill-review")
            .test_support()
            .gap_4()
            .children(feedback)
            .child(
                h_flex()
                    .id("skill-review-summary")
                    .test_support()
                    .aria_label(shell_copy::parts(
                        locale,
                        &summary.iter().map(String::as_str).collect::<Vec<_>>(),
                    ))
                    .flex_wrap()
                    .gap_3()
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .children(summary.iter().cloned()),
            )
            .when(local_modified, |this| {
                this.child(
                    div()
                        .id("skill-review-warning")
                        .test_support()
                        .text_sm()
                        .text_color(maka.warning)
                        .child(copy::REVIEW_WARNING.get(cx)),
                )
            })
            .child(
                h_flex()
                    .items_start()
                    .gap_3()
                    .child(side(
                        "skill-review-current",
                        copy::REVIEW_CURRENT,
                        &preview.current_snippet,
                        cx,
                    ))
                    .child(side(
                        "skill-review-source",
                        copy::REVIEW_SOURCE,
                        &preview.source_snippet,
                        cx,
                    )),
            );
        let busy = self.busy();
        let updating = self.pending == Some(Pending::Update(review.skill_ref.clone()));
        let apply_label = if local_modified { copy::REVIEW_OVERWRITE } else { copy::REVIEW_UPDATE };
        let footer = h_flex()
            .w_full()
            .justify_end()
            .gap_2()
            .child(
                quiet_button(Button::new("skill-review-cancel"), cx)
                    .label(shell_copy::CANCEL.get(cx))
                    .disabled(busy)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                        this.review = None;
                        cx.notify();
                    })),
            )
            .child(
                control_button(Button::new("skill-review-apply").primary())
                    .label(apply_label.get(cx))
                    .loading(updating)
                    .disabled(busy && !updating)
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.apply_update(window, cx);
                    })),
            );
        dialog
            .with_header(skill_header(copy::REVIEW_TITLE.get(cx)).subtitle(skill.name.clone()))
            .child(content)
            .with_footer(footer)
    }
}

/// The Add menu's items; the locations submenu lists what was inspected
/// last.
fn add_menu(this: &ExtensionsView, cx: &mut Context<ExtensionsView>) -> Vec<MenuEntry> {
    let view = cx.entity().downgrade();
    let locale = Locale::current(cx);
    let import = view.clone();
    let mut entries: Vec<MenuEntry> = vec![
        MenuItem::new("import-local-skill", copy::IMPORT_LOCAL_SKILL.get(cx))
            .icon(Icon::new(AssetIcon::Download))
            .on_select(move |window, cx| {
                import.update(cx, |view, cx| view.import_local(window, cx)).ok();
            })
            .into(),
    ];
    if this.locations.is_empty() {
        return entries;
    }
    let counts = this.location_counts(cx);
    let locations: Vec<MenuEntry> = this
        .locations
        .iter()
        .map(|location| {
            let (count, diagnostic) = counts
                .iter()
                .find(|(at, ..)| *at == location.location)
                .map_or((0, None), |(_, count, diagnostic)| (*count, *diagnostic));
            let status = diagnostic.unwrap_or(location.status);
            let end = match status {
                LocationStatus::Available => copy::location_count(locale, count),
                LocationStatus::Missing => copy::LOCATION_MISSING.in_locale(locale).to_owned(),
                LocationStatus::BlockedPath => copy::LOCATION_BLOCKED.in_locale(locale).to_owned(),
                LocationStatus::ReadFailed => {
                    copy::LOCATION_READ_FAILED.in_locale(locale).to_owned()
                }
            };
            let (opened, key) = (view.clone(), location.location);
            // FolderOpen on each, as Desktop's (skills-panel.tsx), so the
            // labels line up with the parent menu's.
            MenuItem::new(format!("skill-location:{}", key.key()), key.label().in_locale(locale))
                .icon(Icon::new(AssetIcon::FolderOpen))
                .detail(location.path.display().to_string())
                .end(end)
                .disabled(matches!(
                    status,
                    LocationStatus::BlockedPath | LocationStatus::ReadFailed
                ))
                .on_select(move |window, cx| {
                    opened.update(cx, |view, cx| view.open_location(key, window, cx)).ok();
                })
                .into()
        })
        .collect();
    entries.push(
        MenuItem::new("skill-locations", copy::SKILL_LOCATIONS.get(cx))
            .icon(Icon::new(AssetIcon::FolderOpen))
            // Desktop's `menuWidth={420}`: a long path ends in an ellipsis.
            .submenu(locations)
            .submenu_width(px(420.))
            .into(),
    );
    entries
}

#[derive(Debug, Clone, Copy)]
enum CursorStep {
    Previous,
    Next,
    First,
    Last,
}

/// Whether one of `fields` holds `query` (already lowercased), as
/// Desktop's search does.
fn matches_query(query: &str, fields: &[&str]) -> bool {
    query.is_empty() || fields.join(" ").to_lowercase().contains(query)
}

fn bundled_entry(item: &SkillCatalogBundledItem, locale: Locale) -> DiscoverEntry {
    let description = if item.description.is_empty() {
        copy::BUILTIN_FALLBACK.in_locale(locale).to_owned()
    } else {
        item.description.clone()
    };
    DiscoverEntry {
        id: item.id.clone().into(),
        name: item.name.clone().into(),
        description: description.into(),
        category: copy::category_label(locale, &item.category).into(),
        source: InstallSource::Bundled,
    }
}

fn source_entry(item: &SkillCatalogManagedSourceItem, locale: Locale) -> DiscoverEntry {
    let description = if item.description.is_empty() {
        copy::SOURCE_FALLBACK.in_locale(locale).to_owned()
    } else {
        item.description.clone()
    };
    DiscoverEntry {
        id: item.id.clone().into(),
        name: item.name.clone().into(),
        description: description.into(),
        category: copy::category_label(locale, &item.category).into(),
        source: InstallSource::Source,
    }
}

/// What a Skill's one status says (skill-status.ts's `StatusSemantic`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Semantic {
    Error,
    Attention,
    Neutral,
    Active,
}

/// `skillContextStatus`: `unknown` reads as in context when enabled.
fn context_status(skill: &SkillCatalogGovernanceItem) -> SkillCatalogContextStatus {
    match skill.context_status {
        SkillCatalogContextStatus::Unknown if skill.enabled => {
            SkillCatalogContextStatus::Advertised
        }
        SkillCatalogContextStatus::Unknown => SkillCatalogContextStatus::Disabled,
        ref status => status.clone(),
    }
}

/// A Skill installed from a source whose source says something.
fn has_managed_attention(skill: &SkillCatalogGovernanceItem) -> bool {
    skill.source_type == SkillCatalogSourceType::Managed
        && skill.managed_update_status.as_ref().is_some_and(|status| {
            !matches!(
                status,
                SkillCatalogManagedUpdateStatus::NotManaged
                    | SkillCatalogManagedUpdateStatus::UpToDate
            )
        })
}

/// `skillStatusSemantic`: broken beats needs-looking-at beats off beats
/// fine.
fn semantic(skill: &SkillCatalogGovernanceItem) -> Semantic {
    let context = context_status(skill);
    if skill.runtime_status == SkillCatalogRuntimeStatus::StateError
        || skill.validation_status == SkillCatalogValidationStatus::MetadataError
        || context == SkillCatalogContextStatus::Invalid
    {
        return Semantic::Error;
    }
    if skill.needs_review
        || skill.validation_status != SkillCatalogValidationStatus::Ok
        || matches!(
            context,
            SkillCatalogContextStatus::Shadowed
                | SkillCatalogContextStatus::Budget
                | SkillCatalogContextStatus::HostIncompatible
        )
        || has_managed_attention(skill)
    {
        return Semantic::Attention;
    }
    if !skill.enabled { Semantic::Neutral } else { Semantic::Active }
}

/// `managed` in the skills copy.
fn managed_word(status: Option<&SkillCatalogManagedUpdateStatus>) -> Text {
    match status {
        Some(SkillCatalogManagedUpdateStatus::SourceMissing) => copy::STATUS_SOURCE_MISSING,
        Some(SkillCatalogManagedUpdateStatus::UpdateAvailable) => copy::STATUS_UPDATE_AVAILABLE,
        Some(SkillCatalogManagedUpdateStatus::LocalModified) => copy::STATUS_LOCAL_MODIFIED,
        Some(SkillCatalogManagedUpdateStatus::MetadataError) => copy::STATUS_METADATA_ERROR,
        _ => copy::STATUS_MANAGED,
    }
}

/// `skillExceptionalStateLabel`: what a Skill's row says beyond its name,
/// only when something is not as it should be.
fn exceptional_label(skill: &SkillCatalogGovernanceItem) -> Option<Text> {
    if skill.runtime_status == SkillCatalogRuntimeStatus::StateError {
        return Some(copy::STATUS_STATE_ERROR);
    }
    if skill.validation_status == SkillCatalogValidationStatus::MetadataError {
        return Some(copy::STATUS_METADATA_ERROR);
    }
    match context_status(skill) {
        SkillCatalogContextStatus::Invalid => return Some(copy::CONTEXT_INVALID),
        SkillCatalogContextStatus::HostIncompatible => {
            return Some(copy::CONTEXT_HOST_INCOMPATIBLE);
        }
        SkillCatalogContextStatus::Shadowed => return Some(copy::CONTEXT_SHADOWED),
        SkillCatalogContextStatus::Budget => return Some(copy::CONTEXT_BUDGET),
        _ => {}
    }
    if skill.needs_review {
        return Some(copy::NEEDS_REVIEW);
    }
    has_managed_attention(skill).then(|| managed_word(skill.managed_update_status.as_ref()))
}

/// `formatSkillStatusLabel`: where a Skill came from, in a word.
fn status_word(skill: &SkillCatalogGovernanceItem) -> Text {
    if skill.validation_status == SkillCatalogValidationStatus::MetadataError {
        return copy::STATUS_METADATA_ERROR;
    }
    match skill.source_type {
        SkillCatalogSourceType::Managed => managed_word(skill.managed_update_status.as_ref()),
        _ if skill.user_modified => copy::STATUS_MODIFIED,
        SkillCatalogSourceType::Bundled => copy::STATUS_BUILT_IN,
        _ => copy::STATUS_LOCAL,
    }
}

/// `formatSkillLibraryDescription`: a built-in Skill left as it shipped
/// takes Desktop's own words.
fn library_description(skill: &SkillCatalogGovernanceItem, locale: Locale) -> Option<String> {
    let raw = skill.description.trim();
    if raw.is_empty() {
        return None;
    }
    if skill.source_type == SkillCatalogSourceType::Bundled
        && !skill.user_modified
        && skill.id == "computer-use"
    {
        return Some(copy::COMPUTER_USE_DESCRIPTION.in_locale(locale).to_owned());
    }
    Some(raw.to_owned())
}

fn scope_label(scope: &SkillCatalogScope) -> Text {
    match scope {
        SkillCatalogScope::Project => copy::SCOPE_PROJECT,
        SkillCatalogScope::Workspace => copy::SCOPE_WORKSPACE,
        SkillCatalogScope::User => copy::SCOPE_USER,
        _ => copy::SCOPE_CUSTOM,
    }
}

/// The status a diagnostic reports for its source.
fn diagnostic_status(diagnostic: &SkillCatalogGovernanceItem) -> Option<LocationStatus> {
    if diagnostic.validation_codes.contains(&SkillCatalogValidationCode::BlockedPath) {
        Some(LocationStatus::BlockedPath)
    } else if diagnostic.validation_codes.contains(&SkillCatalogValidationCode::ReadFailed) {
        Some(LocationStatus::ReadFailed)
    } else {
        None
    }
}

/// A discovery source that could not be read: which, and why (Desktop's
/// row falls back to "Needs review"; the reason is in its codes).
fn render_diagnostic(
    diagnostic: &SkillCatalogGovernanceItem,
    locale: Locale,
    cx: &App,
) -> AnyElement {
    let reason = match diagnostic_status(diagnostic) {
        Some(LocationStatus::BlockedPath) => copy::DIAGNOSTIC_BLOCKED_PATH,
        Some(LocationStatus::ReadFailed) => copy::DIAGNOSTIC_READ_FAILED,
        _ => copy::NEEDS_REVIEW,
    };
    let label =
        copy::discovery_source(locale, diagnostic.scope.as_str(), diagnostic.source.as_str());
    h_flex()
        .id(domain_element_id("skill-diagnostic", &diagnostic.skill_ref))
        .test_support()
        .role(Role::ListItem)
        .aria_label(shell_copy::parts(locale, &[&label, reason.in_locale(locale)]))
        .w_full()
        .min_h(rems(3.5))
        .py_2()
        .gap_3()
        .child(monogram(diagnostic.source.as_str(), cx))
        .child(div().flex_1().min_w_0().truncate().text_sm().font_medium().child(label))
        .child(status_label(Semantic::Attention, reason.in_locale(locale), cx))
        .into_any_element()
}

/// Rows under one another with the column-wide rule between them.
fn rows_with_rules(
    id: impl Into<gpui_kit::ElementId>,
    role: Role,
    rows: Vec<AnyElement>,
    cx: &App,
) -> AnyElement {
    let mut children = Vec::with_capacity(rows.len() * 2);
    for (ix, row) in rows.into_iter().enumerate() {
        if ix > 0 {
            children.push(row_rule(cx));
        }
        children.push(row);
    }
    v_flex().id(id.into()).test_support().role(role).w_full().children(children).into_any_element()
}

/// A heading (16/600) over its content, with an optional line between.
fn section(
    id: &'static str,
    title: &'static str,
    note: Option<AnyElement>,
    body: AnyElement,
    cx: &App,
) -> AnyElement {
    v_flex()
        .id(id)
        .test_support()
        .w_full()
        .gap_2()
        .child(
            div()
                .id(SharedString::from(format!("{id}-title")))
                .role(Role::Heading)
                .aria_label(title)
                .text_size(rems(HEADING_TEXT_REMS))
                .line_height(rems(HEADING_LINE_REMS))
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(cx.maka().ink)
                .child(title),
        )
        .children(note)
        .child(body)
        .into_any_element()
}

/// A Skill's anchor: its initial on the quiet chip fill (Skills carry no
/// icon of their own), Desktop's `.maka-module-market-icon`: a 28px plate
/// at the plate radius, the initial 12/600.
fn monogram(name: &str, cx: &App) -> AnyElement {
    let initial = name.trim().chars().next().map_or("?".to_owned(), |c| c.to_uppercase().collect());
    h_flex()
        .size_7()
        .flex_shrink_0()
        .justify_center()
        .rounded(plate_radius(gpui_kit::px(28.)))
        .bg(cx.maka().chip)
        .text_xs()
        .font_semibold()
        .text_color(cx.maka().ink_muted)
        .child(initial)
        .into_any_element()
}

/// A row's trailing status in words, after a dot for the states that ask
/// for a look (`StatusLabel`); the words carry it, never the colour alone.
fn status_label(semantic: Semantic, label: &str, cx: &App) -> AnyElement {
    let maka = cx.maka();
    let dot = match semantic {
        Semantic::Error => Some(maka.destructive),
        Semantic::Attention => Some(maka.warning),
        Semantic::Active => Some(maka.accent),
        Semantic::Neutral => None,
    };
    h_flex()
        .flex_shrink_0()
        .gap_2()
        .text_xs()
        .text_color(maka.ink_muted)
        .children(dot.map(|dot| div().size_2().rounded_full().bg(dot)))
        .child(label.to_owned())
        .into_any_element()
}

/// A quiet line where the page has nothing to list.
fn notice(id: &'static str, text: &'static str, cx: &App) -> AnyElement {
    div()
        .id(id)
        .test_support()
        .aria_label(text)
        .text_sm()
        .text_color(cx.maka().ink_muted)
        .child(text)
        .into_any_element()
}

/// Desktop's `EmptyState`: an icon, a title, a line, and an action.
fn empty_state(
    id: &'static str,
    icon: Icon,
    title: &'static str,
    body: &'static str,
    action: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    v_flex()
        .id(id)
        .test_support()
        .aria_label(title)
        .w_full()
        .items_center()
        .py_8()
        .gap_2()
        .child(icon.size_6().text_color(maka.ink_muted))
        .child(div().text_sm().font_medium().child(title))
        .child(
            div().max_w(rems(28.)).text_center().text_xs().text_color(maka.ink_muted).child(body),
        )
        .children(action)
        .into_any_element()
}

fn render_skeleton() -> AnyElement {
    v_flex()
        .id("skills-loading")
        .test_support()
        .py_2()
        .gap_4()
        .children([0.7, 0.5, 0.6].into_iter().enumerate().map(|(ix, width)| {
            div().id(("skills-skeleton", ix)).child(Skeleton::new().h_3().w(relative(width)))
        }))
        .into_any_element()
}

/// What an action said: a failure's title over why (destructive, after the
/// failed glyph, so it never rests on colour alone), or the import.
fn render_feedback(id: &'static str, feedback: &Feedback, cx: &App) -> AnyElement {
    match feedback {
        Feedback::Failure(failure) => render_failure(id, failure, cx),
        Feedback::Imported(name) => {
            let locale = Locale::current(cx);
            let text = shell_copy::labeled(locale, copy::IMPORTED.in_locale(locale), name);
            div()
                .id(id)
                .test_support()
                .aria_label(text.clone())
                .text_sm()
                .text_color(cx.maka().ink_muted)
                .child(text)
                .into_any_element()
        }
    }
}

fn render_failure(id: &str, failure: &ActionFailure, cx: &App) -> AnyElement {
    let maka = cx.maka();
    let locale = Locale::current(cx);
    let title = failure.title.in_locale(locale);
    let reason = match &failure.reason {
        FailureReason::Text(text) => text.in_locale(locale).to_owned(),
        FailureReason::Host(message) => as_sentence(message),
    };
    h_flex()
        .id(SharedString::from(id.to_owned()))
        .test_support()
        .aria_label(shell_copy::labeled(locale, title, &reason))
        .items_start()
        .gap_1p5()
        .child(
            h_flex()
                .h(rems(1.25))
                .child(Icon::new(MakaIcon::StatusFailed).size_3().text_color(maka.destructive)),
        )
        .child(
            v_flex()
                .min_w_0()
                .child(div().text_sm().font_medium().text_color(maka.destructive).child(title))
                .child(div().text_xs().text_color(maka.ink_muted).child(reason)),
        )
        .into_any_element()
}

/// A Host message (English, lowercase, no period) as a sentence.
fn as_sentence(message: &str) -> String {
    let message = message.trim();
    let mut chars = message.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let end = if message.ends_with(['.', '!', '?']) { "" } else { "." };
    format!("{}{}{end}", first.to_uppercase(), chars.as_str())
}

/// A dialog's title: the name, and a quiet line under it.
/// The detail dialog's header, its title block named for the tests.
fn skill_header(title: impl Into<SharedString>) -> DialogHeader {
    DialogHeader::new(title).id("skill-detail-title")
}

/// A fact's value that is machine text (an id, a path): compact mono,
/// 12/20, breaking anywhere rather than running past the dialog.
fn machine_text(text: impl Into<SharedString>, cx: &App) -> AnyElement {
    div()
        .font_family(cx.theme().mono_font_family.clone())
        .text_xs()
        .line_height(rems(1.25))
        .child(text.into())
        .into_any_element()
}

/// One fact of the detail: its label in the label column, its value after,
/// centred on each other (a switch).
fn fact(key: &'static str, label: &str, value: impl IntoElement, cx: &App) -> AnyElement {
    fact_row(key, label, value, false, cx)
}

/// A fact whose value is text that may wrap (a path): the label sits on
/// its first line (review round 12); one line reads as [`fact`]'s.
fn text_fact(key: &'static str, label: &str, value: impl IntoElement, cx: &App) -> AnyElement {
    fact_row(key, label, value, true, cx)
}

fn fact_row(
    key: &'static str,
    label: &str,
    value: impl IntoElement,
    lines: bool,
    cx: &App,
) -> AnyElement {
    h_flex()
        .id(key)
        .test_support()
        .aria_label(label.to_owned())
        .w_full()
        .min_h_8()
        .map(|this| if lines { this.items_start().py_1p5() } else { this.py_1() })
        // Desktop's MetadataList: a 120 label column, 16 before the value,
        // and a value that wraps rather than truncates.
        .gap_4()
        .text_sm()
        .child(
            div()
                .w(rems(DETAIL_LABEL_WIDTH_REMS))
                .flex_shrink_0()
                .when(lines, |this| this.line_height(rems(1.25)))
                .text_color(cx.maka().ink_muted)
                .child(label.to_owned()),
        )
        .child(
            div().flex_1().min_w_0().when(lines, |this| this.line_height(rems(1.25))).child(value),
        )
        .into_any_element()
}

/// A side of the update review: its first lines, with "..." after when
/// there is more (`previewText`).
fn preview_text(content: &str) -> String {
    let content = content.replace("\r\n", "\n");
    let lines: Vec<&str> = content.split('\n').collect();
    let mut shown = lines[..lines.len().min(REVIEW_MAX_LINES)].join("\n");
    if lines.len() > REVIEW_MAX_LINES {
        shown.push_str("\n...");
    }
    shown
}

fn read_key(view: CatalogView) -> &'static str {
    match view {
        CatalogView::Installed => "installed",
        CatalogView::Bundled => "bundled",
        CatalogView::Sources => "sources",
    }
}

/// Desktop's `sourceFailures`.
fn import_reason(failure: ImportFailure) -> Text {
    match failure {
        ImportFailure::InvalidSkill => copy::SOURCE_INVALID,
        ImportFailure::AlreadyExists => copy::SOURCE_ALREADY_EXISTS,
        ImportFailure::BlockedPath => copy::SOURCE_BLOCKED,
        _ => copy::SOURCE_WRITE_FAILED,
    }
}

impl Focusable for ExtensionsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The page on its own, as previews and tests draw it; the shell puts it
/// on the plate under the window's chrome.
impl Render for ExtensionsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let page = self.render_page(window, cx);
        v_flex().id("extensions").test_support().size_full().child(page)
    }
}
