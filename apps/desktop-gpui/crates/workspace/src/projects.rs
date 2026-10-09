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

//! The Host's projects and the one new tasks go into.
//!
//! [`ProjectSelection`] reads projects through the small
//! [`ProjectCatalogSource`] trait: [`HostProjectCatalog`] asks the Host
//! (`project.catalog.query`), tests substitute fixed lists, and
//! [`UnavailableProjectCatalog`] stands in where no catalog can be read.
//! It changes them with `project.catalog.mutate` (register a folder,
//! rename, archive, restore, relink). New tasks go into the chosen project;
//! without a catalog, into a folder the user chose; never silently into
//! another task's folder.
//!
//! A remote Host's owner cannot name folders by path: the catalog is read
//! in the `summary` view (no folders), and a project is added from a folder
//! the Host offers ([`list_directory_roots`], [`list_directory`],
//! [`ProjectSelection::register_directory`]), as Desktop's remote directory
//! browser does.

use std::collections::BTreeMap;
use std::rc::Rc;

use futures_lite::future::Boxed;
use gpui_kit::{
    Context, Entity, EventEmitter, PathPromptOptions, SharedString, Subscription, Task,
};
use host_protocol::{
    ChangeNotice, ProjectCatalogMutate, ProjectCatalogMutateInput, ProjectCatalogMutateResult,
    ProjectCatalogPageItem, ProjectCatalogProject, ProjectCatalogQuery, ProjectCatalogQueryInput,
    ProjectCatalogQueryResult, ProjectCatalogView, ProjectDirectoryEntry, ProjectDirectoryRoot,
    PushFrame, WorkspaceTarget,
};
use shared::copy::{self, Locale, Text, failure};
use thiserror::Error;

use crate::{HostRequestError, HostRequester, HostSession, HostSessionEvent};

/// One project from the catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ProjectEntry {
    pub id: SharedString,
    pub name: SharedString,
    /// Absolute directory on the Host: the preferred location, else the
    /// first one. Empty when the Host does not show folders to this client
    /// (a remote owner reads the `summary` view).
    pub path: SharedString,
    /// Archived projects are listed in Settings only.
    pub archived: bool,
    /// Whether any of its locations is a directory now; one that is not
    /// can be relinked to a folder that is.
    pub available: bool,
    /// Ids it was known by before, which tasks may still name (a project
    /// merged into this one).
    pub aliases: Vec<SharedString>,
}

impl ProjectEntry {
    /// An active project whose folder exists.
    pub fn new(
        id: impl Into<SharedString>,
        name: impl Into<SharedString>,
        path: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            path: path.into(),
            archived: false,
            available: true,
            aliases: Vec::new(),
        }
    }

    pub fn with_archived(mut self, archived: bool) -> Self {
        self.archived = archived;
        self
    }

    pub fn with_available(mut self, available: bool) -> Self {
        self.available = available;
        self
    }

    pub fn with_aliases(
        mut self,
        aliases: impl IntoIterator<Item = impl Into<SharedString>>,
    ) -> Self {
        self.aliases = aliases.into_iter().map(Into::into).collect();
        self
    }

    /// Whether a task naming project `id` runs in this one: its id, or one
    /// of its aliases.
    pub fn answers_to(&self, id: &str) -> bool {
        self.id == id || self.aliases.iter().any(|alias| alias == id)
    }

    /// Whether a new task can go into it: not archived, and its folder is
    /// there.
    pub fn is_usable(&self) -> bool {
        !self.archived && self.available
    }

    /// Its name, or the name of its folder when the name is empty.
    pub fn label(&self) -> SharedString {
        if self.name.is_empty() {
            folder_name(&self.path).to_owned().into()
        } else {
            self.name.clone()
        }
    }
}

/// Why the project list could not be read.
#[derive(Debug, Clone, PartialEq, Error)]
#[non_exhaustive]
pub enum ProjectCatalogError {
    /// This client cannot query projects yet.
    #[error("the project catalog is not available yet")]
    NotAvailableYet,
    #[error(transparent)]
    Request(#[from] HostRequestError),
}

/// Reads the Host's projects.
pub trait ProjectCatalogSource: 'static {
    fn list(
        &self,
        requester: &HostRequester,
    ) -> Boxed<Result<Vec<ProjectEntry>, ProjectCatalogError>>;
}

/// Always answers [`ProjectCatalogError::NotAvailableYet`]: for hosts or
/// previews without a project catalog.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnavailableProjectCatalog;

impl ProjectCatalogSource for UnavailableProjectCatalog {
    fn list(&self, _: &HostRequester) -> Boxed<Result<Vec<ProjectEntry>, ProjectCatalogError>> {
        Box::pin(async { Err(ProjectCatalogError::NotAvailableYet) })
    }
}

/// Restarts allowed when the catalog changes between pages
/// (`MAX_STABLE_READ_ATTEMPTS` in `packages/runtime-host/src/client/catalog-reader.ts`).
const MAX_STABLE_READ_ATTEMPTS: usize = 8;

/// Reads `project.catalog.query` in the `locations` view, which carries the
/// directories a session needs (and which the Host offers to local owners
/// only). Archived and unavailable projects are listed, marked; projects
/// with no location at all are left out. Over a remote owner's connection
/// ([`HostRequester::access`]) it reads the `summary` view, which lists
/// every project without its folders (Desktop's `includeHostPaths: false`).
#[derive(Debug, Clone, Copy, Default)]
pub struct HostProjectCatalog;

impl ProjectCatalogSource for HostProjectCatalog {
    fn list(
        &self,
        requester: &HostRequester,
    ) -> Boxed<Result<Vec<ProjectEntry>, ProjectCatalogError>> {
        let requester = requester.clone();
        Box::pin(async move { read_projects(&requester).await })
    }
}

async fn read_projects(
    requester: &HostRequester,
) -> Result<Vec<ProjectEntry>, ProjectCatalogError> {
    let view = if requester.access().can_use_host_paths() {
        ProjectCatalogView::Locations
    } else {
        ProjectCatalogView::Summary
    };
    let mut attempts = 0;
    let mut items = Vec::new();
    let mut input = ProjectCatalogQueryInput::ListStart { view: view.clone() };
    loop {
        match requester.request::<ProjectCatalogQuery>(&input).await? {
            ProjectCatalogQueryResult::Page { revision, items: page, next_cursor, .. } => {
                items.extend(page);
                match next_cursor {
                    Some(cursor) => {
                        input = ProjectCatalogQueryInput::ListContinue {
                            view: view.clone(),
                            revision,
                            cursor,
                        }
                    }
                    None => return Ok(projects_from_items(items, &view)),
                }
            }
            ProjectCatalogQueryResult::RevisionChanged { .. } => {
                attempts += 1;
                if attempts >= MAX_STABLE_READ_ATTEMPTS {
                    return Err(HostRequestError::Transport(
                        "the project catalog kept changing while it was read".into(),
                    )
                    .into());
                }
                items.clear();
                input = ProjectCatalogQueryInput::ListStart { view: view.clone() };
            }
            _ => {
                return Err(HostRequestError::Transport(
                    "project.catalog.query answered with an unexpected result".into(),
                )
                .into());
            }
        }
    }
}

/// Folds the flat page items (a `project` header, then its `location`
/// items, joined by `projectIndex`) into one entry per project that has a
/// location, in the Host's order (active first, most recently used first).
/// The `summary` view has no locations: every project is listed, with no
/// folder.
fn projects_from_items(
    items: Vec<ProjectCatalogPageItem>,
    view: &ProjectCatalogView,
) -> Vec<ProjectEntry> {
    let summary = *view == ProjectCatalogView::Summary;
    struct Header {
        id: String,
        name: String,
        preferred: Option<u64>,
        archived: bool,
        available: bool,
        aliases: Vec<(u64, String)>,
        locations: Vec<(u64, String)>,
    }
    let mut projects: BTreeMap<u64, Header> = BTreeMap::new();
    let mut locations = Vec::new();
    let mut aliases = Vec::new();
    for item in items {
        match item {
            ProjectCatalogPageItem::Project {
                project_index,
                id,
                name,
                preferred_location_index,
                archived_at,
                available,
                ..
            } => {
                projects.insert(
                    project_index,
                    Header {
                        id,
                        name,
                        preferred: preferred_location_index,
                        archived: archived_at.is_some(),
                        available,
                        aliases: Vec::new(),
                        locations: Vec::new(),
                    },
                );
            }
            ProjectCatalogPageItem::Alias { project_index, item_index, alias } => {
                aliases.push((project_index, item_index, alias));
            }
            ProjectCatalogPageItem::Location { project_index, item_index, location } => {
                locations.push((project_index, item_index, location.path));
            }
            _ => {}
        }
    }
    for (project_index, item_index, path) in locations {
        if let Some(header) = projects.get_mut(&project_index) {
            header.locations.push((item_index, path));
        }
    }
    for (project_index, item_index, alias) in aliases {
        if let Some(header) = projects.get_mut(&project_index) {
            header.aliases.push((item_index, alias));
        }
    }
    projects
        .into_values()
        .filter_map(|mut header| {
            header.aliases.sort_by_key(|(ix, _)| *ix);
            let path = header
                .locations
                .iter()
                .find(|(ix, _)| Some(*ix) == header.preferred)
                .or_else(|| header.locations.first())
                .map(|(_, path)| path.clone())
                .or_else(|| summary.then(String::new))?;
            Some(
                ProjectEntry::new(header.id, header.name, path)
                    .with_archived(header.archived)
                    .with_available(header.available)
                    .with_aliases(header.aliases.into_iter().map(|(_, alias)| alias)),
            )
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
enum Catalog {
    Loading,
    Unavailable,
    Loaded(Vec<ProjectEntry>),
    Failed(SharedString),
}

/// Where a new task goes.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum NewTaskTarget {
    /// A registered project; the Host resolves its folder.
    Project(ProjectEntry),
    /// A folder the user chose while no project catalog can be read.
    Folder(SharedString),
}

impl NewTaskTarget {
    /// How it reads in one short line: the project's name, or the folder's.
    pub fn label(&self) -> SharedString {
        match self {
            Self::Project(project) => project.label(),
            Self::Folder(path) => folder_name(path).to_owned().into(),
        }
    }

    /// The `session.create` workspace for it.
    pub fn workspace(&self) -> WorkspaceTarget {
        match self {
            Self::Project(project) => {
                WorkspaceTarget::Project { project_id: project.id.to_string() }
            }
            Self::Folder(path) => WorkspaceTarget::HostPath { path: path.to_string() },
        }
    }
}

/// A `project.catalog.mutate` this client sent, while the Host answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProjectCommand {
    Register,
    Rename,
    Archive,
    Restore,
    Relink,
}

impl ProjectCommand {
    fn failed(self) -> Text {
        match self {
            Self::Register => copy::PROJECT_REGISTER_FAILED,
            Self::Rename => copy::PROJECT_RENAME_FAILED,
            Self::Archive => copy::PROJECT_ARCHIVE_FAILED,
            Self::Restore => copy::PROJECT_RESTORE_FAILED,
            Self::Relink => copy::PROJECT_RELINK_FAILED,
        }
    }
}

/// What [`ProjectSelection`] asks of the window it serves.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProjectSelectionEvent {
    /// A new project was asked for while the window talks to a remote
    /// Host, whose folders this machine's dialog cannot choose: the window
    /// shows the Host's own (settings' remote directory browser).
    ChooseHostFolder,
}

/// The project list, the chosen project, and the commands that change the
/// catalog.
///
/// Reloads when a connection becomes ready, on `project.catalog.changed`,
/// and after each command it sends. One command runs at a time; another is
/// refused until it is answered. Observe it for changes.
pub struct ProjectSelection {
    host: Entity<HostSession>,
    source: Rc<dyn ProjectCatalogSource>,
    catalog: Catalog,
    selected: Option<SharedString>,
    /// A folder the user chose, used while no project catalog can be read.
    chosen_folder: Option<SharedString>,
    pending: Option<ProjectCommand>,
    error: Option<SharedString>,
    generation: u64,
    _subscription: Subscription,
    _load: Option<Task<()>>,
}

impl EventEmitter<ProjectSelectionEvent> for ProjectSelection {}

impl std::fmt::Debug for ProjectSelection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectSelection")
            .field("catalog", &self.catalog)
            .field("selected", &self.selected)
            .field("chosen_folder", &self.chosen_folder)
            .field("pending", &self.pending)
            .finish_non_exhaustive()
    }
}

impl ProjectSelection {
    pub fn new(
        host: Entity<HostSession>,
        source: Rc<dyn ProjectCatalogSource>,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscription =
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| match event {
                HostSessionEvent::Connected { .. } => this.reload(cx),
                HostSessionEvent::Push(frame)
                    if matches!(
                        frame.as_ref(),
                        PushFrame::Change(ChangeNotice::ProjectCatalogChanged { .. })
                    ) =>
                {
                    this.reload(cx)
                }
                _ => {}
            });
        let mut this = Self {
            host,
            source,
            catalog: Catalog::Loading,
            selected: None,
            chosen_folder: None,
            pending: None,
            error: None,
            generation: 0,
            _subscription: subscription,
            _load: None,
        };
        this.reload(cx);
        this
    }

    /// Reads the project list again. A newer reload supersedes an older one.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let list = self.source.list(&self.host.read(cx).requester());
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = list.await;
            this.update(cx, |this, cx| this.finish_reload(generation, result, cx)).ok();
        }));
    }

    fn finish_reload(
        &mut self,
        generation: u64,
        result: Result<Vec<ProjectEntry>, ProjectCatalogError>,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation {
            return;
        }
        self.catalog = match result {
            Ok(projects) => Catalog::Loaded(projects),
            Err(ProjectCatalogError::NotAvailableYet) => Catalog::Unavailable,
            Err(ProjectCatalogError::Request(error)) => {
                // Not blocking: New task asks for a folder instead.
                log::warn!("project.catalog.query failed: {error}");
                Catalog::Failed(error.to_string().into())
            }
        };
        self.keep_a_usable_selection();
        cx.notify();
    }

    /// Keeps the choice on a usable project: the one chosen while it stays
    /// usable, else the first usable one (the most recently used).
    fn keep_a_usable_selection(&mut self) {
        let Catalog::Loaded(projects) = &self.catalog else {
            return;
        };
        let usable = |id: &SharedString| projects.iter().any(|p| &p.id == id && p.is_usable());
        if !self.selected.as_ref().is_some_and(usable) {
            self.selected = projects.iter().find(|p| p.is_usable()).map(|p| p.id.clone());
        }
    }

    /// Every listed project, archived and unavailable ones included, once
    /// the catalog has loaded.
    pub fn projects(&self) -> Option<&[ProjectEntry]> {
        match &self.catalog {
            Catalog::Loaded(projects) => Some(projects),
            _ => None,
        }
    }

    /// The projects that are not archived: the project picker's list.
    pub fn active_projects(&self) -> impl Iterator<Item = &ProjectEntry> {
        self.projects().unwrap_or_default().iter().filter(|project| !project.archived)
    }

    /// The project with `id`.
    pub fn project(&self, id: &str) -> Option<&ProjectEntry> {
        self.projects()?.iter().find(|project| project.id == id)
    }

    /// The project a task runs in: the one its workspace names, else the
    /// one whose folder it is.
    pub fn project_for(&self, project_id: Option<&str>, path: &str) -> Option<&ProjectEntry> {
        self.registered_project(project_id)
            .or_else(|| self.projects()?.iter().find(|project| project.path == path))
    }

    /// The registered project a task's workspace names, by its id or one of
    /// its aliases.
    pub fn registered_project(&self, project_id: Option<&str>) -> Option<&ProjectEntry> {
        let id = project_id?;
        self.projects()?.iter().find(|project| project.answers_to(id))
    }

    /// Whether the catalog is being read for the first time.
    pub fn is_loading(&self) -> bool {
        self.catalog == Catalog::Loading
    }

    /// Why the last read failed, while no list has loaded.
    pub fn load_error(&self) -> Option<&SharedString> {
        match &self.catalog {
            Catalog::Failed(message) => Some(message),
            _ => None,
        }
    }

    /// Whether this Host keeps a project catalog: then a chosen folder is
    /// registered as a project instead of used as it is.
    pub fn has_catalog(&self) -> bool {
        self.catalog != Catalog::Unavailable
    }

    /// Whether folders on this machine can become projects: only when the
    /// window talks to its local Host. A remote Host offers its own folders
    /// instead ([`Self::register_directory`]).
    pub fn can_use_host_paths(&self, cx: &gpui_kit::App) -> bool {
        self.host.read(cx).access().can_use_host_paths()
    }

    /// The window's Host session.
    pub fn host(&self) -> &Entity<HostSession> {
        &self.host
    }

    /// The chosen project, when the catalog has loaded.
    pub fn selected_project(&self) -> Option<&ProjectEntry> {
        let selected = self.selected.as_ref()?;
        self.projects()?.iter().find(|project| &project.id == selected)
    }

    /// Chooses the project with `id`, if it is usable.
    pub fn select_project(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.project(id).is_some_and(ProjectEntry::is_usable)
            && self.selected.as_deref() != Some(id)
        {
            self.selected = Some(SharedString::from(id.to_owned()));
            cx.notify();
        }
    }

    /// Uses the folder `path` for new tasks while no project catalog can be
    /// read.
    pub fn choose_folder(&mut self, path: impl Into<SharedString>, cx: &mut Context<Self>) {
        let path = path.into();
        if self.chosen_folder.as_ref() != Some(&path) {
            self.chosen_folder = Some(path);
            cx.notify();
        }
    }

    /// Where a new task goes: the chosen project; without a catalog, the
    /// folder the user chose; otherwise nowhere yet (New task asks).
    pub fn target(&self) -> Option<NewTaskTarget> {
        match self.selected_project() {
            Some(project) => Some(NewTaskTarget::Project(project.clone())),
            None if !self.has_catalog() => self.chosen_folder.clone().map(NewTaskTarget::Folder),
            None => None,
        }
    }

    /// Asks for a folder with the platform dialog and makes it where new
    /// tasks go ([`Self::use_folder`]). On a remote Host it asks the window
    /// to show the Host's folders instead
    /// ([`ProjectSelectionEvent::ChooseHostFolder`]). The task resolves to
    /// whether a folder was chosen (`false` when the dialog was cancelled,
    /// or for the Host's own folders), or to why the Host refused it.
    pub fn add_project(&mut self, cx: &mut Context<Self>) -> Task<Result<bool, SharedString>> {
        if !self.can_use_host_paths(cx) {
            cx.emit(ProjectSelectionEvent::ChooseHostFolder);
            return Task::ready(Ok(false));
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(copy::FOLDER_CHOOSE_BUTTON.get(cx).into()),
        });
        cx.spawn(async move |this, cx| {
            let path = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                Ok(Err(error)) => {
                    log::warn!("the folder dialog failed: {error:#}");
                    None
                }
                _ => None,
            };
            let Some(path) = path else {
                return Ok(false);
            };
            let path = path.to_string_lossy().into_owned();
            let Ok(used) = this.update(cx, |this, cx| this.use_folder(path, cx)) else {
                return Ok(false);
            };
            used.await
        })
    }

    /// What the folder dialog's answer does: makes `path` where new tasks
    /// go, registered as a project (and chosen) when the Host keeps a
    /// catalog, else used as it is. Resolves to `true` once it is, or to
    /// why the Host refused it.
    pub fn use_folder(
        &mut self,
        path: String,
        cx: &mut Context<Self>,
    ) -> Task<Result<bool, SharedString>> {
        if !self.has_catalog() {
            self.choose_folder(path, cx);
            return Task::ready(Ok(true));
        }
        let registered = self.register_folder(path, cx);
        cx.spawn(async move |this, cx| {
            if registered.await.is_some() {
                return Ok(true);
            }
            let reason = this.read_with(cx, |this, cx| {
                this.command_error()
                    .cloned()
                    .unwrap_or_else(|| copy::PROJECT_REGISTER_FAILED.get(cx).into())
            });
            Err(reason.unwrap_or_default())
        })
    }

    /// The command waiting for the Host's answer, if any.
    pub fn pending_command(&self) -> Option<ProjectCommand> {
        self.pending
    }

    /// Why the last command failed, until the next one starts.
    pub fn command_error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    /// Registers the folder `path` as a project (`register`, `prefer:
    /// true`), restores it if it was archived, and chooses it. The task
    /// resolves to the project's id, or `None` when the Host refused (the
    /// reason is [`Self::command_error`]) or another command is running.
    pub fn register_folder(
        &mut self,
        path: impl Into<SharedString>,
        cx: &mut Context<Self>,
    ) -> Task<Option<SharedString>> {
        if self.pending.is_some() {
            return Task::ready(None);
        }
        let path = path.into();
        let requester = self.host.read(cx).requester();
        let input =
            ProjectCatalogMutateInput::Register { path: path.to_string(), prefer: Some(true) };
        log::info!("project.catalog.mutate register {path}");
        self.begin(ProjectCommand::Register, cx);
        cx.spawn(async move |this, cx| {
            let result = async {
                let project = mutate(&requester, &input).await?;
                if project.archived_at.is_none() {
                    return Ok(project);
                }
                let restore = ProjectCatalogMutateInput::Restore { project_id: project.id };
                mutate(&requester, &restore).await
            }
            .await;
            this.update(cx, |this, cx| {
                let project = this.finish(ProjectCommand::Register, result, cx)?;
                let entry = ProjectEntry::new(project.id.clone(), project.name, path)
                    .with_available(project.available)
                    .with_aliases(project.aliases);
                let id: SharedString = project.id.into();
                // Listed and chosen at once; the reload that follows brings
                // the folder as the Host stored it.
                if let Catalog::Loaded(projects) = &mut this.catalog {
                    projects.retain(|existing| existing.id != id);
                    projects.insert(0, entry);
                } else {
                    this.catalog = Catalog::Loaded(vec![entry]);
                }
                this.selected = Some(id.clone());
                cx.notify();
                Some(id)
            })
            .ok()
            .flatten()
        })
    }

    /// Registers the folder `segments` under the Host's directory root
    /// `root_id` as a project (`register_directory`, the way a remote owner
    /// adds one), restores it if it was archived, and chooses it. The task
    /// resolves to the project's id, or `None` when the Host refused (the
    /// reason is [`Self::command_error`]) or another command is running.
    pub fn register_directory(
        &mut self,
        root_id: &str,
        segments: Vec<String>,
        cx: &mut Context<Self>,
    ) -> Task<Option<SharedString>> {
        if self.pending.is_some() {
            return Task::ready(None);
        }
        let requester = self.host.read(cx).requester();
        let input =
            ProjectCatalogMutateInput::RegisterDirectory { root_id: root_id.to_owned(), segments };
        log::info!("project.catalog.mutate {input:?}");
        self.begin(ProjectCommand::Register, cx);
        cx.spawn(async move |this, cx| {
            let result = async {
                let project = mutate(&requester, &input).await?;
                if project.archived_at.is_none() {
                    return Ok(project);
                }
                let restore = ProjectCatalogMutateInput::Restore { project_id: project.id };
                mutate(&requester, &restore).await
            }
            .await;
            this.update(cx, |this, cx| {
                let project = this.finish(ProjectCommand::Register, result, cx)?;
                let entry = ProjectEntry::new(project.id.clone(), project.name, "")
                    .with_available(project.available)
                    .with_aliases(project.aliases);
                let id: SharedString = project.id.into();
                if let Catalog::Loaded(projects) = &mut this.catalog {
                    projects.retain(|existing| existing.id != id);
                    projects.insert(0, entry);
                } else {
                    this.catalog = Catalog::Loaded(vec![entry]);
                }
                this.selected = Some(id.clone());
                cx.notify();
                Some(id)
            })
            .ok()
            .flatten()
        })
    }

    /// Renames project `id` to `name` (trimmed; an empty name sends
    /// nothing).
    pub fn rename_project(&mut self, id: &str, name: &str, cx: &mut Context<Self>) {
        let name = name.trim();
        if name.is_empty() || self.project(id).is_some_and(|project| project.name == name) {
            return;
        }
        let input =
            ProjectCatalogMutateInput::Rename { project_id: id.to_owned(), name: name.to_owned() };
        self.run(ProjectCommand::Rename, input, cx);
    }

    /// Archives project `id`, or restores it.
    pub fn set_project_archived(&mut self, id: &str, archived: bool, cx: &mut Context<Self>) {
        let project_id = id.to_owned();
        let (command, input) = if archived {
            (ProjectCommand::Archive, ProjectCatalogMutateInput::Archive { project_id })
        } else {
            (ProjectCommand::Restore, ProjectCatalogMutateInput::Restore { project_id })
        };
        self.run(command, input, cx);
    }

    /// Points project `id` at the folder `path`, for a project whose folder
    /// moved; the Host moves its tasks along.
    pub fn relink_project(&mut self, id: &str, path: &str, cx: &mut Context<Self>) {
        let input =
            ProjectCatalogMutateInput::Relink { project_id: id.to_owned(), path: path.to_owned() };
        self.run(ProjectCommand::Relink, input, cx);
    }

    fn run(
        &mut self,
        command: ProjectCommand,
        input: ProjectCatalogMutateInput,
        cx: &mut Context<Self>,
    ) {
        if self.pending.is_some() {
            return;
        }
        log::info!("project.catalog.mutate {input:?}");
        let request = mutate(&self.host.read(cx).requester(), &input);
        self.begin(command, cx);
        cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this.finish(command, result, cx);
            })
            .ok();
        })
        .detach();
    }

    fn begin(&mut self, command: ProjectCommand, cx: &mut Context<Self>) {
        self.pending = Some(command);
        self.error = None;
        cx.notify();
    }

    /// Ends `command`: on success reads the list again and returns the
    /// project; on failure keeps the reason.
    fn finish(
        &mut self,
        command: ProjectCommand,
        result: Result<ProjectCatalogProject, HostRequestError>,
        cx: &mut Context<Self>,
    ) -> Option<ProjectCatalogProject> {
        self.pending = None;
        let project = match result {
            Ok(project) => Some(project),
            Err(error) => {
                log::warn!("project.catalog.mutate failed: {error}");
                let locale = Locale::current(cx);
                self.error = Some(
                    failure(locale, command.failed().in_locale(locale), &error.to_string()).into(),
                );
                None
            }
        };
        self.reload(cx);
        cx.notify();
        project
    }
}

/// Sends one `project.catalog.mutate` and returns the project it answers
/// with.
fn mutate(
    requester: &HostRequester,
    input: &ProjectCatalogMutateInput,
) -> impl Future<Output = Result<ProjectCatalogProject, HostRequestError>> + 'static {
    let request = requester.request::<ProjectCatalogMutate>(input);
    async move {
        match request.await? {
            ProjectCatalogMutateResult::Project { project } => Ok(project),
            _ => Err(HostRequestError::Transport(
                "project.catalog.mutate answered with an unexpected result".into(),
            )),
        }
    }
}

/// The folders a Host offers for adding projects
/// (`project.catalog.query` `directory_roots`).
pub fn list_directory_roots(
    requester: &HostRequester,
) -> impl Future<Output = Result<Vec<ProjectDirectoryRoot>, HostRequestError>> + 'static {
    let request =
        requester.request::<ProjectCatalogQuery>(&ProjectCatalogQueryInput::DirectoryRoots);
    async move {
        match request.await? {
            ProjectCatalogQueryResult::DirectoryRoots { roots } => Ok(roots),
            _ => Err(HostRequestError::Transport(
                "project.catalog.query answered with an unexpected result".into(),
            )),
        }
    }
}

/// The page limit a directory listing is read to; a larger folder shows
/// its first entries (Desktop reads every page; a folder of more than a
/// few thousand subfolders is not one a person browses).
const MAX_DIRECTORY_PAGES: usize = 64;

/// The subfolders of `segments` under the Host's directory root `root_id`,
/// every page (`directory_list_start`, then `directory_list_continue`), as
/// `listProjectDirectories` in Desktop's `runtime-host-client.ts` reads
/// them.
pub fn list_directory(
    requester: &HostRequester,
    root_id: &str,
    segments: Vec<String>,
) -> impl Future<Output = Result<Vec<ProjectDirectoryEntry>, HostRequestError>> + 'static {
    let requester = requester.clone();
    let root_id = root_id.to_owned();
    async move {
        let unexpected = || {
            HostRequestError::Transport(
                "project.catalog.query answered with an unexpected directory page".into(),
            )
        };
        let mut entries = Vec::new();
        let mut input = ProjectCatalogQueryInput::DirectoryListStart {
            root_id: root_id.clone(),
            segments: segments.clone(),
        };
        for _ in 0..MAX_DIRECTORY_PAGES {
            let ProjectCatalogQueryResult::DirectoryPage {
                root_id: page_root,
                segments: page_segments,
                entries: page,
                next_cursor,
            } = requester.request::<ProjectCatalogQuery>(&input).await?
            else {
                return Err(unexpected());
            };
            if page_root != root_id || page_segments != segments {
                return Err(unexpected());
            }
            entries.extend(page);
            match next_cursor {
                Some(cursor) => {
                    input = ProjectCatalogQueryInput::DirectoryListContinue {
                        root_id: root_id.clone(),
                        segments: segments.clone(),
                        cursor,
                    }
                }
                None => break,
            }
        }
        Ok(entries)
    }
}

/// The last component of a directory path, for showing a folder by name.
pub fn folder_name(path: &str) -> &str {
    path_name(path).unwrap_or(path)
}

/// The last component of a directory path, or `None` for a path that has
/// none (empty, or a root such as `/`): Desktop's
/// `deriveTitlebarProjectName` fallback.
pub fn path_name(path: &str) -> Option<&str> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use gpui_kit::{AppContext as _, TestAppContext};

    use super::*;
    use crate::HostTransport;

    struct NoTransport;

    impl HostTransport for NoTransport {
        fn request(
            &self,
            _: &'static str,
            _: serde_json::Value,
            _: Duration,
        ) -> Boxed<Result<serde_json::Value, HostRequestError>> {
            Box::pin(async { Err(HostRequestError::NotConnected) })
        }
    }

    struct FixedProjects(Vec<ProjectEntry>);

    impl ProjectCatalogSource for FixedProjects {
        fn list(&self, _: &HostRequester) -> Boxed<Result<Vec<ProjectEntry>, ProjectCatalogError>> {
            let projects = self.0.clone();
            Box::pin(async move { Ok(projects) })
        }
    }

    fn selection(
        source: Rc<dyn ProjectCatalogSource>,
        cx: &mut TestAppContext,
    ) -> Entity<ProjectSelection> {
        let host =
            cx.new(|_| HostSession::with_transport(PathBuf::from("/r"), Arc::new(NoTransport)));
        let selection = cx.new(|cx| ProjectSelection::new(host, source, cx));
        cx.run_until_parked();
        selection
    }

    #[gpui_kit::test]
    fn without_a_catalog_new_tasks_go_into_a_chosen_folder_only(cx: &mut TestAppContext) {
        let selection = selection(Rc::new(UnavailableProjectCatalog), cx);
        selection.update(cx, |selection, cx| {
            assert!(selection.projects().is_none());
            assert!(!selection.has_catalog());
            assert_eq!(selection.target(), None, "no silent fallback to another task's folder");
            selection.choose_folder("/work/chosen/", cx);
            let target = selection.target().expect("target");
            assert_eq!(target.label(), "chosen");
            assert_eq!(
                target.workspace(),
                WorkspaceTarget::HostPath { path: "/work/chosen/".into() }
            );
        });
    }

    #[test]
    fn page_items_fold_into_projects_at_their_preferred_location() {
        let items: Vec<ProjectCatalogPageItem> = serde_json::from_value(serde_json::json!([
            {"kind": "project", "projectIndex": 0, "id": "p1", "name": "One", "aliasCount": 2,
             "locationCount": 2, "preferredLocationIndex": 1, "archivedAt": null, "available": true},
            {"kind": "alias", "projectIndex": 0, "itemIndex": 1, "alias": "old-b"},
            {"kind": "alias", "projectIndex": 0, "itemIndex": 0, "alias": "old-a"},
            {"kind": "location", "projectIndex": 0, "itemIndex": 0,
             "location": {"path": "/old/one", "isWorktree": false}},
            {"kind": "location", "projectIndex": 0, "itemIndex": 1,
             "location": {"path": "/p/one", "isWorktree": false}},
            {"kind": "project", "projectIndex": 1, "id": "p2", "name": "Gone", "aliasCount": 0,
             "locationCount": 1, "preferredLocationIndex": null, "archivedAt": 5, "available": false},
            {"kind": "location", "projectIndex": 1, "itemIndex": 0,
             "location": {"path": "/p/gone", "isWorktree": false}},
            {"kind": "project", "projectIndex": 2, "id": "p3", "name": "Nowhere", "aliasCount": 0,
             "locationCount": 0, "preferredLocationIndex": null, "archivedAt": null, "available": true}
        ]))
        .expect("items");
        let projects = projects_from_items(items, &ProjectCatalogView::Locations);
        assert!(projects[0].answers_to("p1") && projects[0].answers_to("old-b"));
        assert!(!projects[1].answers_to("old-a"));
        assert_eq!(
            projects,
            [
                ProjectEntry::new("p1", "One", "/p/one").with_aliases(["old-a", "old-b"]),
                ProjectEntry::new("p2", "Gone", "/p/gone")
                    .with_archived(true)
                    .with_available(false),
            ]
        );
    }

    #[test]
    fn the_summary_view_lists_every_project_without_a_folder() {
        let items: Vec<ProjectCatalogPageItem> = serde_json::from_value(serde_json::json!([
            {"kind": "project", "projectIndex": 0, "id": "p1", "name": "One", "aliasCount": 0,
             "locationCount": 1, "preferredLocationIndex": null, "archivedAt": null,
             "available": true},
            {"kind": "project", "projectIndex": 1, "id": "p2", "name": "Two", "aliasCount": 0,
             "locationCount": 1, "preferredLocationIndex": null, "archivedAt": null,
             "available": false}
        ]))
        .expect("items");
        assert_eq!(
            projects_from_items(items, &ProjectCatalogView::Summary),
            [
                ProjectEntry::new("p1", "One", ""),
                ProjectEntry::new("p2", "Two", "").with_available(false)
            ]
        );
    }

    /// Answers each operation from a queue of replies and records the
    /// inputs.
    #[derive(Default)]
    struct Scripted {
        replies: std::sync::Mutex<Vec<(&'static str, serde_json::Value)>>,
        requests: std::sync::Mutex<Vec<(&'static str, serde_json::Value)>>,
    }

    impl Scripted {
        fn reply(&self, operation: &'static str, result: serde_json::Value) {
            self.replies.lock().expect("replies").push((operation, result));
        }

        fn requests(&self) -> Vec<(&'static str, serde_json::Value)> {
            self.requests.lock().expect("requests").clone()
        }
    }

    impl HostTransport for Scripted {
        fn request(
            &self,
            operation: &'static str,
            input: serde_json::Value,
            _: Duration,
        ) -> Boxed<Result<serde_json::Value, HostRequestError>> {
            self.requests.lock().expect("requests").push((operation, input));
            let mut replies = self.replies.lock().expect("replies");
            let reply = replies
                .iter()
                .position(|(op, _)| *op == operation)
                .map(|ix| replies.remove(ix).1)
                .ok_or(HostRequestError::NotConnected);
            Box::pin(async move { reply })
        }
    }

    fn remote_host() -> crate::WindowHost {
        let transport =
            host_protocol::RemoteTransport::tls("wss://box.example.com/runtime-host").expect("tls");
        let profile = host_client::RemoteHostProfile::new("box", "Box", &"a".repeat(64), transport)
            .expect("profile");
        let credential = host_protocol::AccessCredential::new("mrha_x").expect("credential");
        crate::WindowHost::Remote(crate::RemoteHost::new(profile, credential))
    }

    #[gpui_kit::test]
    fn a_remote_owner_reads_the_summary_and_adds_a_folder_the_host_offers(cx: &mut TestAppContext) {
        let host = Arc::new(Scripted::default());
        let page = serde_json::json!({
            "kind": "page", "view": "summary", "revision": format!("sha256:{}", "0".repeat(64)),
            "projectCount": 1, "nextCursor": null,
            "items": [{"kind": "project", "projectIndex": 0, "id": "p1", "name": "One",
                       "aliasCount": 0, "locationCount": 1, "preferredLocationIndex": null,
                       "archivedAt": null, "available": true}]
        });
        host.reply("project.catalog.query", page.clone());
        let transport: Arc<dyn HostTransport> = host.clone();
        let session = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/r"), transport).for_host(remote_host())
        });
        let selection =
            cx.new(|cx| ProjectSelection::new(session, Rc::new(HostProjectCatalog), cx));
        cx.run_until_parked();
        selection.read_with(cx, |selection, cx| {
            assert!(!selection.can_use_host_paths(cx));
            assert_eq!(selection.projects().map(<[_]>::len), Some(1));
            assert_eq!(selection.selected_project().map(|p| p.id.as_str()), Some("p1"));
        });
        assert_eq!(
            host.requests()[0].1,
            serde_json::json!({"kind": "list_start", "view": "summary"})
        );

        host.reply(
            "project.catalog.mutate",
            serde_json::json!({"kind": "project", "project": {
                "id": "p2", "name": "api", "aliases": [], "locationCount": 1,
                "archivedAt": null, "available": true
            }}),
        );
        host.reply("project.catalog.query", page);
        let registered = selection.update(cx, |selection, cx| {
            selection.register_directory("home", vec!["work".into(), "api".into()], cx)
        });
        cx.run_until_parked();
        assert_eq!(cx.foreground_executor().block_test(registered).as_deref(), Some("p2"));
        let mutation = host
            .requests()
            .into_iter()
            .find(|(op, _)| *op == "project.catalog.mutate")
            .expect("mutate");
        assert_eq!(
            mutation.1,
            serde_json::json!({"kind": "register_directory", "rootId": "home",
                               "segments": ["work", "api"]})
        );
    }

    #[test]
    fn a_directory_is_read_page_by_page() {
        let host = Arc::new(Scripted::default());
        let page = |entries: &[&str], next: Option<&str>| {
            serde_json::json!({
                "kind": "directory_page", "rootId": "home", "segments": ["work"],
                "entries": entries.iter().map(|name| serde_json::json!({"name": name}))
                    .collect::<Vec<_>>(),
                "nextCursor": next
            })
        };
        host.reply("project.catalog.query", page(&["api", "web"], Some("c1")));
        host.reply("project.catalog.query", page(&["docs"], None));
        let requester = HostRequester::new(host.clone());
        let entries =
            futures_lite::future::block_on(list_directory(&requester, "home", vec!["work".into()]))
                .expect("entries");
        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["api", "web", "docs"]);
        assert_eq!(
            host.requests()[1].1,
            serde_json::json!({"kind": "directory_list_continue", "rootId": "home",
                               "segments": ["work"], "cursor": "c1"})
        );
    }

    #[gpui_kit::test]
    fn an_empty_catalog_has_no_target(cx: &mut TestAppContext) {
        let selection = selection(Rc::new(FixedProjects(Vec::new())), cx);
        selection.update(cx, |selection, cx| {
            assert_eq!(selection.projects().map(<[_]>::len), Some(0));
            assert!(selection.has_catalog());
            // With a catalog, a folder becomes a project; choosing one
            // without registering it targets nothing.
            selection.choose_folder("/work/chosen", cx);
            assert_eq!(selection.target(), None);
        });
    }

    #[gpui_kit::test]
    fn a_loaded_catalog_targets_the_chosen_usable_project(cx: &mut TestAppContext) {
        let projects = vec![
            ProjectEntry::new("p0", "Old", "/p/old").with_archived(true),
            ProjectEntry::new("p1", "One", "/p/one"),
            ProjectEntry::new("p2", "Two", "/p/two"),
            ProjectEntry::new("p3", "Moved", "/p/moved").with_available(false),
        ];
        let selection = selection(Rc::new(FixedProjects(projects)), cx);
        selection.update(cx, |selection, cx| {
            assert_eq!(selection.selected_project().map(|p| p.id.as_ref()), Some("p1"));
            assert_eq!(selection.active_projects().count(), 3);
            selection.select_project("p2", cx);
            let target = selection.target().expect("target");
            assert_eq!(target.label(), "Two");
            assert_eq!(target.workspace(), WorkspaceTarget::Project { project_id: "p2".into() });
            for unusable in ["missing", "p0", "p3"] {
                selection.select_project(unusable, cx);
                assert_eq!(selection.selected_project().map(|p| p.id.as_ref()), Some("p2"));
            }
            assert_eq!(selection.project_for(None, "/p/one").map(|p| p.id.as_ref()), Some("p1"));
            assert_eq!(
                selection.project_for(Some("p2"), "/elsewhere").map(|p| p.id.as_ref()),
                Some("p2")
            );
        });
    }

    #[test]
    fn a_folder_reads_as_its_last_component() {
        assert_eq!(folder_name("/work/demo"), "demo");
        assert_eq!(folder_name("/work/demo/"), "demo");
        assert_eq!(folder_name("C:\\work\\demo"), "demo");
        assert_eq!(folder_name("/"), "/");
        assert_eq!(folder_name("demo"), "demo");
    }
}
