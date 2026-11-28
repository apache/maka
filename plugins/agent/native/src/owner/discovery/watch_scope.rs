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

//! Workspace-scoped discovery settings. The scheduler namespace owns the canonical record.
use super::{
    roots::{DeltaRoots, Directories, host_path, open_relative},
    *,
};
use cap_std::fs::Dir;
use maka_sandbox::filesystem::Compiled;
use std::{
    io,
    path::{Component, Path, PathBuf},
};
use tokio::sync::{Mutex, watch};

pub(in crate::owner) struct WatchScopes {
    pub(super) directories: Arc<Directories>,
    pub(super) home: Option<PathBuf>,
    pub(super) changed: watch::Sender<SavedScopes>,
    pub(super) private: Vec<PathBuf>,
    pub(in crate::owner) timing: changes::Timing,
    pub(super) edits: Mutex<()>,
}

#[derive(Default)]
pub(super) struct SavedScopes {
    by_key: BTreeMap<String, Arc<WatchScope>>,
    excluded: Arc<BTreeSet<PathBuf>>,
    mapped_watch_roots: BTreeMap<String, Vec<PathBuf>>,
}

impl WatchScopes {
    pub(super) fn set_mapped_watch_roots(&self, key: String, roots: Vec<PathBuf>) {
        self.changed.send_modify(|scopes| {
            scopes.mapped_watch_roots.insert(key, roots);
        });
    }
}

impl SavedScopes {
    fn index_exclusions(&mut self) {
        self.excluded = Arc::new(
            self.by_key
                .values()
                .flat_map(|scope| scope.exclude_roots.iter().map(|r| r.path.clone()))
                .collect(),
        );
    }
}

impl WatchScopes {
    pub(in crate::owner) fn open(
        configured: &[workspace::Root],
        state: &maka_event_log::root::RootOwner,
    ) -> io::Result<Self> {
        let directories = configured
            .iter()
            .filter_map(workspace::Root::configured_directory)
            .map(|r| {
                Ok((
                    host_path(r.path())?.to_owned(),
                    maka_fs_tools::directory::open(r.path(), &r.identity()?)?,
                ))
            })
            .collect::<io::Result<_>>()?;
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(std::env::home_dir);
        let home = match home {
            Some(p) => match p.canonicalize() {
                Ok(canonical) => Some(host_path(&canonical)?.to_owned()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Some(p),
                Err(e) => return Err(e),
            },
            None => None,
        };
        let namespace = maka_sandbox::native_task_namespace()?;
        let private = [
            state.canonical_path(),
            state.control_directory(),
            state.lock_path(),
            &namespace,
        ]
        .into_iter()
        .map(|p| host_path(p).map(Path::to_owned))
        .collect::<io::Result<_>>()?;
        Ok(Self {
            private,
            timing: Default::default(),
            directories: Arc::new(directories),
            home,
            changed: watch::channel(SavedScopes::default()).0,
            edits: Mutex::new(()),
        })
    }
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ScopedRoot {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct WatchScope {
    pub include_roots: Vec<ScopedRoot>,
    pub exclude_roots: Vec<ScopedRoot>,
    pub surveyed_at: Option<i64>,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Update {
    Inspect,
    AddInclude {
        path: PathBuf,
        reason: String,
    },
    AddExclude {
        path: PathBuf,
        reason: String,
    },
    Remove {
        path: PathBuf,
    },
    /// Merge the supplied roots and record the current survey time in one operation.
    MarkSurveyed {
        #[serde(default)]
        include_roots: Vec<ScopedRoot>,
        #[serde(default)]
        exclude_roots: Vec<ScopedRoot>,
    },
    Resurvey,
}

const PREFIX: &str = "discovery/watch-scope/";

pub(super) enum ScopeView {
    Watcher,
    Workspace,
}

fn scope_key(workspace: &Path) -> String {
    format!(
        "{PREFIX}{}",
        hex::encode(Sha256::digest(workspace.as_os_str().as_encoded_bytes()))
    )
}

pub(super) fn broad_root(path: &Path, home: Option<&Path>) -> bool {
    path.parent().is_none()
        || home.is_some_and(|home| {
            path.strip_prefix(home).is_ok_and(|rel| {
                let lower = rel.as_os_str().to_ascii_lowercase();
                [
                    "",
                    "library",
                    "library/containers",
                    "library/application support",
                    "library/group containers",
                    "library/caches",
                    "appdata",
                    "appdata/local",
                    "appdata/roaming",
                ]
                .iter()
                .any(|b| Path::new(&lower) == Path::new(b))
            })
        })
}

struct WorkspaceScope {
    root: PathBuf,
    dir: Dir,
    home: Option<PathBuf>,
    policy: Compiled,
}

impl WorkspaceScope {
    fn absolute(&self, supplied: &Path) -> Result<PathBuf, String> {
        let supplied = host_path(supplied).map_err(reason)?;
        let absolute = if let Ok(rel) = supplied.strip_prefix("~") {
            self.home.as_ref().ok_or("home unavailable")?.join(rel)
        } else {
            self.root.join(supplied)
        };
        let rel = absolute
            .strip_prefix(&self.root)
            .map_err(|_| "path outside workspace")?;
        if rel.as_os_str().is_empty()
            || !rel.components().all(|c| matches!(c, Component::Normal(_)))
        {
            return Err("provide a directory strictly inside this workspace".into());
        }
        if !self.policy.access(&absolute).can_read() {
            return Err("workspace read access required".into());
        }
        Ok(absolute)
    }

    fn path(&self, supplied: &Path, must_exist: bool) -> Result<PathBuf, String> {
        let absolute = self.absolute(supplied)?;
        let rel = absolute
            .strip_prefix(&self.root)
            .expect("validated workspace path");
        match open_relative(&self.dir, rel) {
            Ok(_) => {
                let canonical = self.root.join(self.dir.canonicalize(rel).map_err(reason)?);
                if !canonical.starts_with(&self.root)
                    || canonical == self.root
                    || !self.policy.access(&canonical).can_read()
                {
                    return Err("directory outside authorized scope".into());
                }
                Ok(canonical)
            }
            Err(e)
                if !must_exist
                    && matches!(
                        e.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                    ) =>
            {
                Ok(absolute)
            }
            Err(e) => Err(format!("expected a real directory without symlinks: {e}")),
        }
    }

    fn add(
        &self,
        entries: &mut Vec<ScopedRoot>,
        input: ScopedRoot,
        include: bool,
    ) -> Result<(), String> {
        let path = self.path(&input.path, include)?;
        if include && broad_root(&path, self.home.as_deref()) {
            return Err("include a concrete content directory below the system root".into());
        }
        let reason = input.reason.trim();
        if reason.is_empty() || reason.len() > 160 || reason.chars().any(char::is_control) {
            return Err("provide a concise single-line reason (up to 160 bytes)".into());
        }
        if let Some(existing) = entries.iter_mut().find(|r| r.path == path) {
            existing.reason = reason.into();
        } else {
            let limit = if include { 16 } else { 64 };
            if entries.len() >= limit {
                return Err(format!("at most {limit} roots permitted"));
            }
            entries.push(ScopedRoot {
                path,
                reason: reason.into(),
            });
        }
        Ok(())
    }

    fn apply(&self, scope: &mut WatchScope, update: Update, at: i64) -> Result<(), String> {
        match update {
            Update::Inspect => unreachable!("read-only action"),
            Update::AddInclude { path, reason } => {
                self.add(&mut scope.include_roots, ScopedRoot { path, reason }, true)?
            }
            Update::AddExclude { path, reason } => {
                self.add(&mut scope.exclude_roots, ScopedRoot { path, reason }, false)?
            }
            Update::Remove { path } => {
                let path = self.absolute(&path)?;
                scope.include_roots.retain(|r| r.path != path);
                scope.exclude_roots.retain(|r| r.path != path);
            }
            Update::MarkSurveyed {
                include_roots,
                exclude_roots,
            } => {
                if include_roots.len() > 16 || exclude_roots.len() > 64 {
                    return Err("survey exceeds root limits".into());
                }
                for root in include_roots {
                    self.add(&mut scope.include_roots, root, true)?;
                }
                for root in exclude_roots {
                    self.add(&mut scope.exclude_roots, root, false)?;
                }
                scope.surveyed_at = Some(at);
            }
            Update::Resurvey => scope.surveyed_at = None,
        }
        Ok(())
    }
}

impl scheduler::Scheduler {
    pub(super) async fn visit_workspace_records(
        &self,
        prefix: &str,
        mut visit: impl FnMut(String, Value) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut after = None;
        loop {
            let page = self
                .storage
                .scan(maka_plugin_core::storage::Scan {
                    prefix: prefix.to_owned(),
                    after,
                })
                .await
                .map_err(reason)?;
            for entry in page.entries {
                if let Data::Present(value) = entry.record.data {
                    visit(entry.key, value)?;
                }
            }
            let Some(next) = page.next_after else {
                return Ok(());
            };
            after = Some(next);
        }
    }

    pub(super) async fn watch_scope(
        &self,
        root: &Path,
    ) -> Result<(Option<u64>, WatchScope), String> {
        let (revision, scope) = self.discovery_record(scope_key(root)).await?;
        Ok((revision, scope.unwrap_or_default()))
    }
}

impl WatchScopes {
    pub(in crate::owner) async fn restore(
        &self,
        scheduler: &scheduler::Scheduler,
    ) -> Result<(), String> {
        let mut saved = SavedScopes::default();
        scheduler
            .visit_workspace_records(PREFIX, |key, value| {
                let scope = serde_json::from_value(value).map_err(reason)?;
                saved.by_key.insert(key, Arc::new(scope));
                Ok(())
            })
            .await?;
        saved.mapped_watch_roots = scheduler.all_mapped_watch_roots().await.unwrap_or_default();
        saved.index_exclusions();
        self.changed.send_replace(saved);
        Ok(())
    }

    pub(super) fn survey(
        &self,
        root: &Path,
        tools: &[String],
        language: Language,
        at: i64,
    ) -> Option<&'static str> {
        if self.home.as_deref() != Some(root) || !tools.iter().any(|t| t == WATCH_SCOPE) {
            return None;
        }
        let surveyed_at = self
            .changed
            .borrow()
            .by_key
            .get(&scope_key(root))
            .and_then(|scope| scope.surveyed_at);
        if surveyed_at.is_some_and(|last| at.saturating_sub(last) <= 7 * 86_400_000) {
            return None;
        }
        Some(match language {
            Language::ZH_CN => {
                "此主目录需要调查监测范围。先查看顶层目录、云盘或即时通讯应用中具体的文档/接收文件目录、本地 AI 工具会话目录，以及噪声缓存/构建目录（注意：系统 Library 与隐藏点目录默认不会递归监听，需要显式加入 include_roots 才会监听）。调用一次 UpdateWatchScope，使用 mark_surveyed 提交 include_roots、exclude_roots 和简短理由，然后继续调查。"
            }
            Language::ZH_TW => {
                "此家目錄需要調查監測範圍。先查看頂層目錄、雲端硬碟或即時通訊應用程式中具體的文件/接收檔案目錄、本地 AI 工具會話目錄，以及雜訊快取/建置目錄（注意：系統 Library 與隱藏點目錄預設不會遞迴監聽，需明確加入 include_roots 才會監聽）。呼叫一次 UpdateWatchScope，使用 mark_surveyed 提交 include_roots、exclude_roots 和簡短理由，然後繼續調查。"
            }
            _ => {
                "This home directory is due for a watch-scope survey. Inspect top-level folders, concrete document/attachment folders inside cloud drives or messaging apps, local AI coding/chat session directories, and noisy cache/build subdirectories (note: system Library and hidden dot-directories are not watched recursively by default unless explicitly included). Call UpdateWatchScope once with action mark_surveyed, include_roots and exclude_roots with brief reasons. Then continue discovery."
            }
        })
    }

    pub(super) fn delta_roots(&self, workspaces: BTreeSet<PathBuf>, view: ScopeView) -> DeltaRoots {
        let saved = self.changed.borrow();
        let mut roots = DeltaRoots {
            private: self.private.clone(),
            excluded: saved.excluded.clone(),
            ..Default::default()
        };
        let add_includes = |scope: &Arc<WatchScope>, out: &mut BTreeSet<PathBuf>| {
            out.extend(
                scope
                    .include_roots
                    .iter()
                    .map(|r| &r.path)
                    .filter(|p| p.ancestors().any(|a| workspaces.contains(a)))
                    .cloned(),
            );
        };
        match view {
            ScopeView::Watcher => {
                for scope in saved.by_key.values() {
                    add_includes(scope, &mut roots.recursive);
                }
                for mapped in saved.mapped_watch_roots.values().flatten() {
                    if mapped.ancestors().any(|a| workspaces.contains(a)) {
                        roots.recursive.insert(mapped.clone());
                    }
                }
            }
            ScopeView::Workspace => {
                let policies: BTreeSet<_> = workspaces
                    .iter()
                    .flat_map(|p| {
                        p.ancestors()
                            .filter(move |a| *a == p || self.directories.contains_key(*a))
                    })
                    .collect();
                for path in policies {
                    if let Some(scope) = saved.by_key.get(&scope_key(path)) {
                        add_includes(scope, &mut roots.recursive);
                    }
                    if let Some(mapped) =
                        saved.mapped_watch_roots.get(&workspace_map::map_key(path))
                    {
                        for p in mapped {
                            if p.ancestors().any(|a| workspaces.contains(a)) {
                                roots.recursive.insert(p.clone());
                            }
                        }
                    }
                }
            }
        }
        roots.recursive.extend(workspaces);
        roots.home = self
            .home
            .as_ref()
            .and_then(|home| roots.recursive.take(home));
        roots
    }
}

impl Owner {
    pub(super) async fn update_watch_scope(
        &self,
        context: &ToolCallContext,
        update: Update,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        if cancel.is_cancelled() {
            return Err(ToolError::Failed("discovery_cancelled".into()));
        }
        let access = self.discovery_call_access(context, WATCH_SCOPE).await?;
        let id = &context.execution.session_id;
        if self.bot.is(id) {
            self.check_bot_invocation(context)
                .await
                .map_err(ToolError::Failed)?;
        } else if self
            .discovery
            .thread_topic(id.clone())
            .await
            .map_err(dossiers::write_error)?
            .is_none()
        {
            let (job, _) = self.discovery_tool_job(context).await?;
            if !self.discovery_reads_files(&job.tools.names) {
                return Err(ToolError::Failed("workspace read tools required".into()));
            }
        }
        let selected = self
            .session(id)
            .await
            .map_err(ToolError::Failed)?
            .configuration
            .workspace;
        let (root, dir, _) = workspace::open_workspace_observation(
            &self.workspace_roots,
            &selected,
            &self.managed_worktrees,
        )
        .await
        .map_err(ToolError::Failed)?;
        let root = host_path(&root)
            .map_err(|e| ToolError::Failed(reason(e)))?
            .to_owned();
        if !root
            .ancestors()
            .any(|p| self.watch_scopes.directories.contains_key(p))
        {
            return Err(ToolError::Failed("configured workspace required".into()));
        }
        let floor = access.workspace_sandbox_floor().await?;
        let policy = self
            .discovery_workspace_policy(&selected, &floor)
            .await
            .map_err(ToolError::Failed)?;
        let workspace = WorkspaceScope {
            root: root.clone(),
            dir,
            home: self.watch_scopes.home.clone(),
            policy,
        };

        if matches!(update, Update::Inspect) {
            let (_, scope) = self
                .scheduler
                .watch_scope(&root)
                .await
                .map_err(ToolError::Failed)?;
            let mut base = self
                .watch_scopes
                .delta_roots([root.clone()].into(), ScopeView::Workspace);
            base.recursive.retain(|p| p == &root);
            let caps = self.watch_scopes.directories.clone();
            let baseline = tokio::task::spawn_blocking(move || {
                let paths = base.subscriptions(&caps, std::iter::empty(), |p| workspace.policy.access(p).can_read())?;
                Ok::<_, io::Error>(paths.into_iter().filter_map(|(path, mode)| {
                    Some(serde_json::json!({"path": path.to_str()?, "recursive": mode == notify::RecursiveMode::Recursive}))
                }).collect::<Vec<_>>())
            }).await.map_err(|e| ToolError::Failed(reason(e)))?.map_err(|e| ToolError::Failed(reason(e)))?;
            let mut result =
                serde_json::to_value(scope).map_err(|e| ToolError::Failed(reason(e)))?;
            result["baseline"] = serde_json::json!(baseline);
            return Ok(result);
        }
        if cancel.is_cancelled() {
            return Err(ToolError::Failed("discovery_cancelled".into()));
        }
        let state = self.store.owned_root().map_err(dossiers::write_error)?;
        let prune_exclusions = matches!(
            update,
            Update::AddExclude { .. } | Update::MarkSurveyed { .. }
        );
        self.watch_scopes
            .save(&self.scheduler, state, workspace, update, &cancel)
            .await?;
        if prune_exclusions {
            let scope = self
                .watch_scopes
                .delta_roots([root.clone()].into(), ScopeView::Workspace);
            let _ = self
                .discovery
                .prune_cursors_matching(move |p| {
                    p.starts_with(&root) && !scope.permits(p, false) && !scope.permits(p, true)
                })
                .await;
        }
        Ok(serde_json::json!({"updated":true}))
    }
}

impl WatchScopes {
    async fn save(
        &self,
        scheduler: &scheduler::Scheduler,
        state: Arc<maka_event_log::root::RootOwner>,
        workspace: WorkspaceScope,
        update: Update,
        cancel: &CancellationToken,
    ) -> Result<(), ToolError> {
        let root = workspace.root.clone();
        let home = workspace.home.as_ref() == Some(&root);
        let edit = self.edits.lock().await;
        if cancel.is_cancelled() {
            return Err(ToolError::Failed("discovery_cancelled".into()));
        }
        let (revision, mut scope) = scheduler
            .watch_scope(&root)
            .await
            .map_err(ToolError::Failed)?;
        let key = scope_key(&root);
        let scope = tokio::task::spawn_blocking(move || {
            workspace.apply(&mut scope, update, now() as i64)?;
            Ok::<_, String>(scope)
        })
        .await
        .map_err(|e| ToolError::Failed(reason(e)))?
        .map_err(ToolError::Failed)?;
        if cancel.is_cancelled() {
            return Err(ToolError::Failed("discovery_cancelled".into()));
        }
        scheduler
            .storage
            .batch(vec![
                mutation(key.clone(), revision, &scope).map_err(ToolError::Failed)?,
            ])
            .await
            .map_err(result_write_error)?;
        self.changed.send_modify(|scopes| {
            scopes.by_key.insert(key.clone(), Arc::new(scope));
            scopes.index_exclusions();
        });
        drop(edit);
        let saved = self.changed.clone();
        let mirror = tokio::task::spawn_blocking(move || {
            preferences::sync_watch_scope(&state, &root, home, || {
                saved.borrow().by_key[&key].clone()
            })
        })
        .await;
        if let Err(error) = mirror.unwrap_or_else(|e| Err(e.into())) {
            tracing::warn!(%error, "Could not sync discovery watch scope to preferences.md");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_sandbox::filesystem::{Access, Policy, Rule};
    use std::fs;

    #[tokio::test]
    async fn discovery_scope_preserves_deleted_revisions_and_rejects_invalid_records() {
        let (temp, root, _) = test_store().await;
        let scheduler = scheduler::Scheduler::new(root, "test/".into());
        let workspace = temp.path();
        let key = scope_key(workspace);
        let (revision, _) = scheduler.watch_scope(workspace).await.unwrap();
        assert_eq!(revision, None);
        let created = mutation(key.clone(), revision, &WatchScope::default()).unwrap();
        let created = scheduler.storage.batch(vec![created]).await.unwrap();
        let deleted = scheduler
            .storage
            .batch(vec![Mutation {
                key: key.clone(),
                expected_revision: Some(created[0].revision),
                data: Data::Deleted,
            }])
            .await
            .unwrap();
        let (revision, scope) = scheduler.watch_scope(workspace).await.unwrap();
        assert_eq!(revision, Some(deleted[0].revision));
        assert!(scope.include_roots.is_empty());
        let malformed = mutation(key, revision, &"malformed scope").unwrap();
        scheduler.storage.batch(vec![malformed]).await.unwrap();
        assert!(scheduler.watch_scope(workspace).await.is_err());
    }

    #[tokio::test]
    async fn discovery_scope_validates_the_whole_survey_before_persisting_and_reloading() {
        let (temp, log, _) = test_store().await;
        let home = temp.path().join("home");
        let leaf = Path::new("Library/Containers/example/received");
        for path in [
            leaf,
            Path::new("Library/Application Support"),
            Path::new("Library/Group Containers"),
            Path::new("Library/Caches"),
            Path::new("AppData/Local"),
            Path::new("AppData/Roaming"),
            Path::new("denied"),
        ] {
            fs::create_dir_all(home.join(path)).unwrap();
        }
        let home = host_path(&home.canonicalize().unwrap()).unwrap().to_owned();
        let dir = Dir::open_ambient_dir(&home, cap_std::ambient_authority()).unwrap();
        let policy = Policy {
            default: Access::Read,
            rules: vec![Rule::subtree(home.join("denied"), Access::Deny)],
            deny_globs: vec![],
        };
        let workspace = || WorkspaceScope {
            root: home.clone(),
            dir: dir.try_clone().unwrap(),
            home: Some(home.clone()),
            policy: policy.compile().unwrap(),
        };
        let scoped = |path: &Path| ScopedRoot {
            path: path.into(),
            reason: "Received documents".into(),
        };
        for path in [
            ".",
            "~",
            "/",
            "~/Library",
            "Library/Containers",
            "Library/Application Support",
            "Library/Group Containers",
            "Library/Caches",
            "AppData",
            "AppData/Roaming",
            "AppData/Local",
            "../outside",
            "denied",
            "missing",
        ] {
            assert!(
                workspace()
                    .add(&mut vec![], scoped(Path::new(path)), true)
                    .is_err(),
                "{path}"
            );
        }
        assert!(workspace().path(temp.path(), false).is_err());
        for (include, limit) in [(true, 16), (false, 64)] {
            let mut entries = Vec::new();
            for i in 0..=limit {
                let path = home.join(format!("root-{i}"));
                if include {
                    fs::create_dir(&path).unwrap();
                }
                let result = workspace().add(&mut entries, scoped(&path), include);
                assert_eq!(result.is_ok(), i < limit);
            }
        }
        assert!(workspace().add(&mut vec![], scoped(&home), false).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(home.join("Library"), home.join("linked")).unwrap();
            for p in ["linked", "linked/Containers/example/received"] {
                assert!(
                    workspace()
                        .add(&mut vec![], scoped(Path::new(p)), true)
                        .is_err(),
                    "{p}"
                );
            }
        }
        let state = log.owned_root().unwrap();
        let scheduler = scheduler::Scheduler::new(log.clone(), "test/".into());
        let configured = workspace::open(
            vec![maka_host_runtime::DirectoryRootSpec {
                label: "home".into(),
                path: home.clone(),
            }],
            state.canonical_path(),
        )
        .unwrap();
        let mut scopes = WatchScopes::open(&configured, &state).unwrap();
        scopes.home = Some(home.clone());
        let tools = [WATCH_SCOPE.to_owned()];
        assert!(scopes.survey(&home, &tools, Language::EN, 0).is_some());
        assert!(scopes.survey(&home, &[], Language::EN, 0).is_none());
        assert!(
            scopes
                .survey(&home.join("project"), &tools, Language::EN, 0)
                .is_none()
        );
        let mut changed = scopes.changed.subscribe();
        let cancel = CancellationToken::new();
        let save = |update| scopes.save(&scheduler, state.clone(), workspace(), update, &cancel);

        assert!(
            save(Update::MarkSurveyed {
                include_roots: vec![scoped(leaf), scoped(Path::new("denied"))],
                exclude_roots: vec![],
            })
            .await
            .is_err()
        );
        assert!(scheduler.watch_scope(&home).await.unwrap().0.is_none());
        assert!(!changed.has_changed().unwrap());

        save(Update::MarkSurveyed {
            include_roots: vec![scoped(leaf)],
            exclude_roots: vec![scoped(Path::new("build"))],
        })
        .await
        .unwrap();
        changed.changed().await.unwrap();
        let (_, saved) = scheduler.watch_scope(&home).await.unwrap();
        let mut restored = WatchScopes::open(&configured, &state).unwrap();
        restored.home = Some(home.clone());
        restored.restore(&scheduler).await.unwrap();
        let week_later = saved.surveyed_at.unwrap() + 7 * 86_400_000;
        for language in [Language::EN, Language::ZH_CN, Language::ZH_TW] {
            assert!(
                restored
                    .survey(&home, &tools, language, week_later)
                    .is_none()
            );
            assert!(
                restored
                    .survey(&home, &tools, language, week_later + 1)
                    .unwrap()
                    .contains("mark_surveyed")
            );
        }
        let roots = restored.delta_roots([home.clone()].into(), ScopeView::Workspace);
        assert!(roots.permits(&home.join(leaf).join("file"), false));
        assert!(!roots.permits(&home.join("build/stale"), false));
        #[cfg(target_os = "macos")]
        assert!(!roots.permits(&home.join("Library/Containers/other/file"), false));
        assert_eq!(saved.include_roots[0].path, home.join(leaf));
        let prefs = state.canonical_path().join("discovery/preferences.md");
        let summary = fs::read_to_string(&prefs).unwrap();
        assert!(
            summary.contains("[watch-scope]")
                && summary.contains("received")
                && summary.contains("build")
        );
        save(Update::Remove { path: leaf.into() }).await.unwrap();
        let summary = fs::read_to_string(&prefs).unwrap();
        assert_eq!(summary.matches("[watch-scope]").count(), 1);
        assert!(summary.contains("build") && !summary.contains("received"));
        fs::write(&prefs, "x".repeat(16 * 1024)).unwrap();
        save(Update::Resurvey).await.unwrap();
        assert!(
            scopes
                .survey(&home, &tools, Language::EN, week_later)
                .is_some()
        );
        let reopened = scheduler::Scheduler::new(log, "test/".into())
            .watch_scope(&home)
            .await
            .unwrap()
            .1;
        assert!(reopened.surveyed_at.is_none() && reopened.include_roots.is_empty());
        assert_eq!(reopened.exclude_roots[0].path, home.join("build"));
    }
}
