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

//! The Skill catalog of the project new tasks go into, as the Extensions
//! page shows it, after Desktop's Skills controller
//! (apps/desktop/src/renderer/features/module-hub/controller/use-skills-controller.ts)
//! and the main-process side it calls
//! (apps/desktop/src/main/runtime-host-skills-ipc-main.ts).

use gpui_kit::{App, Context, Entity, SharedString, Subscription, Task};
use host_protocol::{
    SkillCatalogBundledItem, SkillCatalogManagedSourceItem, SkillCatalogMutate,
    SkillCatalogMutateInput, SkillCatalogMutateResult, SkillCatalogMutation,
    SkillCatalogMutationRejectedReason, SkillCatalogPageItem, SkillCatalogPreview,
    SkillCatalogPreviewRejectedReason, SkillCatalogPreviewUpdate, SkillCatalogPreviewUpdateInput,
    SkillCatalogPreviewUpdateResult, SkillCatalogQuery, SkillCatalogQueryInput,
    SkillCatalogQueryResult, SkillCatalogView, SkillCatalogWorkspaceContext,
    SkillInstallSourceType, WorkspaceProjection, WorkspaceTarget,
};
use shared::copy::Text;
use shared::copy::extensions as copy;
use workspace::{HostRequester, HostSession, HostSessionEvent, ProjectSelection};

/// How often a listing is read again from its first page after the
/// catalog changed under it (`MAX_STABLE_READ_ATTEMPTS` in
/// packages/runtime-host/src/client/catalog-reader.ts).
const STABLE_READ_ATTEMPTS: usize = 8;

/// How often a change is rebuilt after a revision conflict
/// (`MAX_REVISION_ATTEMPTS`).
const REVISION_ATTEMPTS: usize = 3;

/// One of the catalog's views, as the page reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CatalogView {
    /// The workspace's Skills (`governance`).
    Installed,
    /// The Skills that ship with Maka (`bundled`).
    Bundled,
    /// The local source library (`managed_sources`).
    Sources,
}

impl CatalogView {
    pub const ALL: [Self; 3] = [Self::Installed, Self::Bundled, Self::Sources];

    fn wire(self) -> SkillCatalogView {
        match self {
            Self::Installed => SkillCatalogView::Governance,
            Self::Bundled => SkillCatalogView::Bundled,
            Self::Sources => SkillCatalogView::ManagedSources,
        }
    }

    /// What a failed read of the view is called.
    pub fn read_failed(self) -> Text {
        match self {
            Self::Installed => copy::REFRESH_SKILLS_FAILED,
            Self::Bundled => copy::REFRESH_BUNDLED_FAILED,
            Self::Sources => copy::REFRESH_SOURCES_FAILED,
        }
    }
}

/// Why something failed, in words the page shows.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum FailureReason {
    /// A reason this client words (Desktop's failure tables).
    Text(Text),
    /// The Host's own message, which is in English.
    Host(SharedString),
}

/// A failed read or change: its title (Desktop's toast title) and why.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ActionFailure {
    pub title: Text,
    pub reason: FailureReason,
}

impl ActionFailure {
    pub fn new(title: Text, reason: FailureReason) -> Self {
        Self { title, reason }
    }

    fn text(title: Text, reason: Text) -> Self {
        Self::new(title, FailureReason::Text(reason))
    }
}

/// One complete listing of a view: every page, at the first page's
/// revision.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Listing<T> {
    pub revision: String,
    pub items: Vec<T>,
    /// The workspace the Host resolved the context to: `host_cwd` is the
    /// project's folder.
    pub workspace: WorkspaceProjection,
}

/// A view as last read: its listing, which stays while it is read again,
/// and why the last read failed.
#[derive(Debug)]
pub struct Projection<T> {
    listing: Option<Listing<T>>,
    loading: bool,
    error: Option<ActionFailure>,
    /// Bumped by every read; a result for an older one is dropped.
    generation: u64,
}

impl<T> Default for Projection<T> {
    fn default() -> Self {
        Self { listing: None, loading: false, error: None, generation: 0 }
    }
}

impl<T> Projection<T> {
    pub fn listing(&self) -> Option<&Listing<T>> {
        self.listing.as_ref()
    }

    pub fn items(&self) -> &[T] {
        self.listing.as_ref().map_or(&[], |listing| &listing.items)
    }

    pub fn is_loading(&self) -> bool {
        self.loading
    }

    pub fn error(&self) -> Option<&ActionFailure> {
        self.error.as_ref()
    }
}

/// Where a Skill to install comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallSource {
    Bundled,
    Source,
}

/// Behavior owner of the Skill catalog for one window: the three views of
/// the project new tasks go into, read in one pass each (every page, again
/// from the start when the catalog changes between pages), and every
/// change the page makes to them.
///
/// Reading starts once the page first shows ([`Self::activate`]), and
/// again on every new connection and whenever the project changes (a
/// different project drops what was read). A change is built on a fresh
/// read of the view it names, sent at that read's revision, and rebuilt
/// after a revision conflict at most [`REVISION_ATTEMPTS`] times; once it is
/// committed the views Desktop reads again after it are read again, and the
/// change's task resolves after that, so the page shows the result and the
/// change together.
pub struct SkillCatalog {
    host: Entity<HostSession>,
    projects: Entity<ProjectSelection>,
    /// The workspace the views were read for.
    workspace: Option<WorkspaceTarget>,
    installed: Projection<SkillCatalogPageItem>,
    bundled: Projection<SkillCatalogBundledItem>,
    sources: Projection<SkillCatalogManagedSourceItem>,
    active: bool,
    _reads: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for SkillCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SkillCatalog")
            .field("workspace", &self.workspace)
            .field("active", &self.active)
            .finish_non_exhaustive()
    }
}

impl SkillCatalog {
    pub fn new(
        host: Entity<HostSession>,
        projects: Entity<ProjectSelection>,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscriptions = vec![
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
                if matches!(event, HostSessionEvent::Connected { .. }) && this.active {
                    this.reload(&CatalogView::ALL, cx);
                }
            }),
            cx.observe(&host, |_, _, cx| cx.notify()),
            cx.observe(&projects, |this, _, cx| this.follow_project(cx)),
        ];
        let workspace = projects.read(cx).target().map(|target| target.workspace());
        Self {
            host,
            projects,
            workspace,
            installed: Projection::default(),
            bundled: Projection::default(),
            sources: Projection::default(),
            active: false,
            _reads: Vec::new(),
            _subscriptions: subscriptions,
        }
    }

    /// Starts reading the catalog, the first time the page shows.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        if !self.active {
            self.active = true;
            self.reload(&CatalogView::ALL, cx);
        }
    }

    pub fn host(&self) -> &Entity<HostSession> {
        &self.host
    }

    /// The workspace whose Skills these are: the project new tasks go
    /// into.
    pub fn workspace(&self) -> Option<&WorkspaceTarget> {
        self.workspace.as_ref()
    }

    /// Whether the projects are still being read, so there is no workspace
    /// yet but there may be one.
    pub fn is_waiting_for_projects(&self, cx: &App) -> bool {
        self.workspace.is_none() && self.projects.read(cx).is_loading()
    }

    pub fn installed(&self) -> &Projection<SkillCatalogPageItem> {
        &self.installed
    }

    pub fn bundled(&self) -> &Projection<SkillCatalogBundledItem> {
        &self.bundled
    }

    pub fn sources(&self) -> &Projection<SkillCatalogManagedSourceItem> {
        &self.sources
    }

    /// Whether any view is being read.
    pub fn is_loading(&self) -> bool {
        self.installed.loading || self.bundled.loading || self.sources.loading
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    fn context(&self) -> Option<SkillCatalogWorkspaceContext> {
        self.workspace.clone().map(SkillCatalogWorkspaceContext::new)
    }

    /// Reads the catalog again for the project new tasks go into when that
    /// changed; what was read for another project goes.
    fn follow_project(&mut self, cx: &mut Context<Self>) {
        let workspace = self.projects.read(cx).target().map(|target| target.workspace());
        if workspace == self.workspace {
            cx.notify();
            return;
        }
        self.workspace = workspace;
        self.installed = Projection::default();
        self.bundled = Projection::default();
        self.sources = Projection::default();
        if self.active {
            self.reload(&CatalogView::ALL, cx);
        }
        cx.notify();
    }

    /// Reads `views` again in the background.
    pub fn reload(&mut self, views: &[CatalogView], cx: &mut Context<Self>) {
        let read = self.read_views(views, cx);
        self._reads.retain(|task| !task.is_ready());
        self._reads.push(read);
    }

    /// Reads `views` again; the task resolves once they are applied.
    pub fn read_views(&mut self, views: &[CatalogView], cx: &mut Context<Self>) -> Task<()> {
        let Some(context) = self.context() else {
            return Task::ready(());
        };
        if !self.host.read(cx).is_connected() {
            return Task::ready(());
        }
        let requester = self.requester(cx);
        let mut reads = Vec::with_capacity(views.len());
        for &view in views {
            let generation = match view {
                CatalogView::Installed => start(&mut self.installed),
                CatalogView::Bundled => start(&mut self.bundled),
                CatalogView::Sources => start(&mut self.sources),
            };
            reads.push((view, generation));
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            for (view, generation) in reads {
                let result = read_listing(&requester, &context, view).await;
                let applied = this.update(cx, |this, cx| {
                    match view {
                        CatalogView::Installed => {
                            finish(&mut this.installed, generation, view, result, |item| {
                                item.governance().is_some().then_some(item)
                            })
                        }
                        CatalogView::Bundled => {
                            finish(&mut this.bundled, generation, view, result, |item| match item {
                                SkillCatalogPageItem::Bundled(item) => Some(item),
                                _ => None,
                            })
                        }
                        CatalogView::Sources => {
                            finish(&mut this.sources, generation, view, result, |item| match item {
                                SkillCatalogPageItem::ManagedSource(item) => Some(item),
                                _ => None,
                            })
                        }
                    }
                    cx.notify();
                });
                if applied.is_err() {
                    return;
                }
            }
        })
    }

    /// Installs a built-in Skill or a source into the workspace, then reads
    /// the installed Skills and the view it came from again.
    pub fn install(
        &mut self,
        source: InstallSource,
        id: SharedString,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), ActionFailure>> {
        let (title, view, source_type) = match source {
            InstallSource::Bundled => (
                copy::INSTALL_BUNDLED_FAILED,
                CatalogView::Bundled,
                SkillInstallSourceType::Bundled,
            ),
            InstallSource::Source => {
                (copy::INSTALL_FAILED, CatalogView::Sources, SkillInstallSourceType::Managed)
            }
        };
        let mutation = SkillCatalogMutation::Install { source_type, source_id: id.to_string() };
        self.change(
            title,
            Change::OnView(view, mutation),
            install_reason,
            vec![CatalogView::Installed, view],
            cx,
        )
    }

    /// Turns a Skill on or off for the project.
    pub fn set_enabled(
        &mut self,
        skill_ref: SharedString,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), ActionFailure>> {
        let mutation =
            SkillCatalogMutation::SetEnabled { skill_ref: skill_ref.to_string(), enabled };
        self.change(
            copy::TOGGLE_FAILED,
            Change::OnSkill(skill_ref, mutation),
            runtime_reason,
            vec![CatalogView::Installed],
            cx,
        )
    }

    /// Pins a Skill to the model's context, or unpins it.
    pub fn set_pinned(
        &mut self,
        skill_ref: SharedString,
        pinned: bool,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), ActionFailure>> {
        let mutation = SkillCatalogMutation::SetPinned { skill_ref: skill_ref.to_string(), pinned };
        self.change(
            copy::TOGGLE_FAILED,
            Change::OnSkill(skill_ref, mutation),
            runtime_reason,
            vec![CatalogView::Installed],
            cx,
        )
    }

    /// Deletes a Skill's files, then reads the installed and the built-in
    /// Skills again (a deleted built-in one can be installed again).
    pub fn delete(
        &mut self,
        skill_ref: SharedString,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), ActionFailure>> {
        let mutation = SkillCatalogMutation::Delete { skill_ref: skill_ref.to_string() };
        self.change(
            copy::DELETE_FAILED,
            Change::OnSkill(skill_ref, mutation),
            delete_reason,
            vec![CatalogView::Installed, CatalogView::Bundled],
            cx,
        )
    }

    /// Brings a Skill installed from a source up to the source. With
    /// `overwrite` (the preview's hashes of the workspace copy and of the
    /// source) local changes are replaced; without it an update over local
    /// changes is refused.
    pub fn update(
        &mut self,
        skill_ref: SharedString,
        overwrite: Option<(String, String)>,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), ActionFailure>> {
        let mutation = match overwrite {
            Some((current, source)) => {
                SkillCatalogMutation::overwrite_managed(skill_ref.to_string(), current, source)
            }
            None => SkillCatalogMutation::update_managed(skill_ref.to_string()),
        };
        self.change(
            copy::UPDATE_FAILED,
            Change::OnSkill(skill_ref, mutation),
            update_reason,
            vec![CatalogView::Installed],
            cx,
        )
    }

    /// The start of a Skill's workspace copy and of its source, for the
    /// update review.
    pub fn preview_update(
        &mut self,
        skill_ref: SharedString,
        cx: &mut Context<Self>,
    ) -> Task<Result<Box<SkillCatalogPreview>, ActionFailure>> {
        let title = copy::PREVIEW_FAILED;
        let Some(context) = self.context() else {
            return Task::ready(Err(ActionFailure::text(title, copy::NEEDS_FOLDER)));
        };
        let requester = self.requester(cx);
        cx.spawn(async move |_, _| {
            for _ in 0..REVISION_ATTEMPTS {
                let listing = read_listing(&requester, &context, CatalogView::Installed)
                    .await
                    .map_err(|reason| ActionFailure::new(title, reason))?;
                if !listing.items.iter().any(|item| is_skill(item, &skill_ref)) {
                    return Err(ActionFailure::text(title, copy::SKILL_NOT_FOUND));
                }
                let input = SkillCatalogPreviewUpdateInput::new(
                    context.clone(),
                    listing.revision,
                    skill_ref.to_string(),
                );
                match requester.request::<SkillCatalogPreviewUpdate>(&input).await {
                    Ok(SkillCatalogPreviewUpdateResult::Preview(preview)) => return Ok(preview),
                    Ok(SkillCatalogPreviewUpdateResult::RevisionConflict { .. }) => continue,
                    Ok(SkillCatalogPreviewUpdateResult::Rejected { reason, .. }) => {
                        return Err(ActionFailure::text(title, preview_reason(&reason)));
                    }
                    Ok(_) => return Err(ActionFailure::text(title, copy::TRY_AGAIN_LATER)),
                    Err(error) => {
                        return Err(ActionFailure::new(
                            title,
                            FailureReason::Host(error.to_string().into()),
                        ));
                    }
                }
            }
            Err(ActionFailure::text(title, copy::CATALOG_UNSTABLE))
        })
    }

    /// Sends `change`, rebuilding it after a revision conflict, then reads
    /// `reread` again. A refusal is worded by `reason`.
    fn change(
        &mut self,
        title: Text,
        change: Change,
        reason: fn(&SkillCatalogMutationRejectedReason) -> Text,
        reread: Vec<CatalogView>,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), ActionFailure>> {
        let Some(context) = self.context() else {
            return Task::ready(Err(ActionFailure::text(title, copy::NEEDS_FOLDER)));
        };
        let requester = self.requester(cx);
        cx.spawn(async move |this, cx| {
            send_change(&requester, &context, &change, title, reason).await?;
            if let Ok(read) = this.update(cx, |this, cx| this.read_views(&reread, cx)) {
                read.await;
            }
            Ok(())
        })
    }
}

/// A change and the view its revision comes from.
enum Change {
    /// A change that installs from `CatalogView`, built on that view's
    /// revision (as Desktop's `mutateSkill` does).
    OnView(CatalogView, SkillCatalogMutation),
    /// A change to the installed Skill with this ref, built on the
    /// governance revision once the Skill is found there
    /// (`mutateResolvedSkillRaw`).
    OnSkill(SharedString, SkillCatalogMutation),
}

async fn send_change(
    requester: &HostRequester,
    context: &SkillCatalogWorkspaceContext,
    change: &Change,
    title: Text,
    reason: fn(&SkillCatalogMutationRejectedReason) -> Text,
) -> Result<(), ActionFailure> {
    let host_failure = |error: workspace::HostRequestError| {
        ActionFailure::new(title, FailureReason::Host(error.to_string().into()))
    };
    for _ in 0..REVISION_ATTEMPTS {
        let (view, mutation) = match change {
            Change::OnView(view, mutation) => (*view, mutation),
            Change::OnSkill(_, mutation) => (CatalogView::Installed, mutation),
        };
        let listing = read_listing(requester, context, view)
            .await
            .map_err(|reason| ActionFailure::new(title, reason))?;
        if let Change::OnSkill(skill_ref, _) = change
            && !listing.items.iter().any(|item| is_skill(item, skill_ref))
        {
            return Err(ActionFailure::text(
                title,
                reason(&SkillCatalogMutationRejectedReason::NotFound),
            ));
        }
        let input =
            SkillCatalogMutateInput::new(context.clone(), listing.revision, mutation.clone());
        match requester.request::<SkillCatalogMutate>(&input).await.map_err(host_failure)? {
            SkillCatalogMutateResult::Committed { .. }
            | SkillCatalogMutateResult::Unchanged { .. } => {
                return Ok(());
            }
            SkillCatalogMutateResult::RevisionConflict { .. } => continue,
            SkillCatalogMutateResult::Rejected { reason: rejected, .. } => {
                return Err(ActionFailure::text(title, reason(&rejected)));
            }
            _ => return Err(ActionFailure::text(title, copy::TRY_AGAIN_LATER)),
        }
    }
    Err(ActionFailure::text(title, copy::CATALOG_UNSTABLE))
}

/// Whether `item` is the installed Skill `skill_ref` names.
fn is_skill(item: &SkillCatalogPageItem, skill_ref: &str) -> bool {
    matches!(item, SkillCatalogPageItem::Skill(skill) if skill.skill_ref == skill_ref)
}

/// Every page of `view` at the first page's revision
/// (`readRuntimeHostSkillCatalog`): read again from the start when a page
/// comes back at another revision or for another workspace, at most
/// [`STABLE_READ_ATTEMPTS`] times; a cursor seen twice is an error.
async fn read_listing(
    requester: &HostRequester,
    context: &SkillCatalogWorkspaceContext,
    view: CatalogView,
) -> Result<Listing<SkillCatalogPageItem>, FailureReason> {
    let host = |error: workspace::HostRequestError| FailureReason::Host(error.to_string().into());
    let wire = view.wire();
    'attempts: for _ in 0..STABLE_READ_ATTEMPTS {
        let start = SkillCatalogQueryInput::Start { context: context.clone(), view: wire.clone() };
        let SkillCatalogQueryResult::Page {
            view: first_view,
            revision,
            mut items,
            mut next_cursor,
            resolved_workspace,
        } = requester.request::<SkillCatalogQuery>(&start).await.map_err(host)?
        else {
            continue;
        };
        if first_view != wire {
            continue;
        }
        let mut cursors = std::collections::HashSet::new();
        while let Some(cursor) = next_cursor.take() {
            if !cursors.insert(cursor.clone()) {
                return Err(FailureReason::Text(copy::CATALOG_UNSTABLE));
            }
            let next = SkillCatalogQueryInput::Continue {
                context: context.clone(),
                view: wire.clone(),
                revision: revision.clone(),
                cursor,
            };
            match requester.request::<SkillCatalogQuery>(&next).await.map_err(host)? {
                SkillCatalogQueryResult::Page {
                    view: page_view,
                    revision: page_revision,
                    items: page_items,
                    next_cursor: page_cursor,
                    resolved_workspace: page_workspace,
                } if page_view == wire
                    && page_revision == revision
                    && page_workspace == resolved_workspace =>
                {
                    items.extend(page_items);
                    next_cursor = page_cursor;
                }
                _ => continue 'attempts,
            }
        }
        return Ok(Listing { revision, items, workspace: resolved_workspace });
    }
    Err(FailureReason::Text(copy::CATALOG_UNSTABLE))
}

/// Marks `projection` as being read; its new generation.
fn start<T>(projection: &mut Projection<T>) -> u64 {
    projection.generation += 1;
    projection.loading = true;
    projection.generation
}

/// Applies a read of `view` to `projection` unless a newer read started;
/// `keep` picks the items of the view's kind. A failed read keeps the
/// listing there was.
fn finish<T>(
    projection: &mut Projection<T>,
    generation: u64,
    view: CatalogView,
    result: Result<Listing<SkillCatalogPageItem>, FailureReason>,
    keep: impl Fn(SkillCatalogPageItem) -> Option<T>,
) {
    if projection.generation != generation {
        return;
    }
    projection.loading = false;
    match result {
        Ok(listing) => {
            projection.error = None;
            projection.listing = Some(Listing {
                revision: listing.revision,
                items: listing.items.into_iter().filter_map(keep).collect(),
                workspace: listing.workspace,
            });
        }
        Err(reason) => {
            log::warn!("skill.catalog.query failed: {reason:?}");
            projection.error = Some(ActionFailure::new(view.read_failed(), reason));
        }
    }
}

/// `mapMutationReason`: how Desktop groups the Host's refusals.
fn mapped(reason: &SkillCatalogMutationRejectedReason) -> SkillCatalogMutationRejectedReason {
    use SkillCatalogMutationRejectedReason as Reason;
    match reason {
        Reason::SourceChanged => Reason::LocalModified,
        Reason::SourceInvalid | Reason::NeedsReview => Reason::MetadataError,
        other => other.clone(),
    }
}

/// `installFailures`.
fn install_reason(reason: &SkillCatalogMutationRejectedReason) -> Text {
    use SkillCatalogMutationRejectedReason as Reason;
    match mapped(reason) {
        Reason::NotFound => copy::INSTALL_NOT_FOUND,
        Reason::AlreadyExists => copy::INSTALL_ALREADY_EXISTS,
        Reason::BlockedPath => copy::TARGET_BLOCKED,
        _ => copy::TRY_AGAIN_LATER,
    }
}

/// `updateFailures`.
fn update_reason(reason: &SkillCatalogMutationRejectedReason) -> Text {
    use SkillCatalogMutationRejectedReason as Reason;
    match mapped(reason) {
        Reason::NotFound => copy::SKILL_NOT_FOUND,
        Reason::NotManaged => copy::NOT_MANAGED,
        Reason::SourceMissing => copy::SOURCE_MISSING,
        Reason::LocalModified => copy::UPDATE_LOCAL_MODIFIED,
        Reason::MetadataError => copy::UPDATE_METADATA_ERROR,
        Reason::BlockedPath => copy::TARGET_BLOCKED,
        _ => copy::TRY_AGAIN_LATER,
    }
}

/// `deleteFailures`.
fn delete_reason(reason: &SkillCatalogMutationRejectedReason) -> Text {
    use SkillCatalogMutationRejectedReason as Reason;
    match mapped(reason) {
        Reason::NotFound => copy::SKILL_NOT_FOUND,
        Reason::BlockedPath => copy::DELETE_BLOCKED,
        Reason::BlockedScope => copy::DELETE_BLOCKED_SCOPE,
        _ => copy::TRY_AGAIN_LATER,
    }
}

/// `runtimeFailures`, for enabling and pinning.
fn runtime_reason(reason: &SkillCatalogMutationRejectedReason) -> Text {
    use SkillCatalogMutationRejectedReason as Reason;
    match mapped(reason) {
        Reason::NotFound => copy::SKILL_NOT_FOUND,
        Reason::BlockedPath => copy::STATE_BLOCKED,
        Reason::StateError => copy::STATE_ERROR,
        _ => copy::TRY_AGAIN_LATER,
    }
}

/// `previewFailures`, after `mapPreviewReason`.
fn preview_reason(reason: &SkillCatalogPreviewRejectedReason) -> Text {
    use SkillCatalogPreviewRejectedReason as Reason;
    match reason {
        Reason::NotFound => copy::SKILL_NOT_FOUND,
        Reason::NotManaged => copy::NOT_MANAGED,
        Reason::SourceMissing => copy::SOURCE_MISSING,
        Reason::SourceInvalid | Reason::MetadataError => copy::PREVIEW_METADATA_ERROR,
        _ => copy::TRY_AGAIN_LATER,
    }
}
