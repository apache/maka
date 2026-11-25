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

//! Durable per-workspace semantic map built during cold-start onboarding (`DiscoveryMode::Onboard`)
//! and incrementally maintained during `FollowUp` / `Wander`. Stored in scheduler `plugin_data`
//! with independent capacity from `WatchScope`'s explicit include/exclude lists.

use super::{
    roots::{host_path, open_relative},
    *,
};
use cap_std::fs::Dir;
use maka_sandbox::filesystem::Compiled;
use schemars::JsonSchema;
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    path::{Component, Path, PathBuf},
};

const PREFIX: &str = "discovery/workspace-map/";
const MAX_SOURCES: usize = 128;
const MAX_FRONTIER: usize = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(super) enum MapPhase {
    #[default]
    Uninitialized,
    Scanning,
    Ready,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(super) enum SourceKind {
    Project,
    Docs,
    MessagingFiles,
    AiSessions,
    Data,
    #[default]
    Other,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(super) enum SourcePriority {
    High,
    #[default]
    Medium,
    Low,
}

impl SourcePriority {
    fn base_interval_ms(self) -> i64 {
        match self {
            Self::High => 6 * 3_600_000,    // 6h
            Self::Medium => 18 * 3_600_000, // 18h
            Self::Low => 72 * 3_600_000,    // 72h
        }
    }

    fn weight(self) -> f64 {
        match self {
            Self::High => 3.0,
            Self::Medium => 1.5,
            Self::Low => 0.7,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(super) enum SourceWatchMode {
    Watch,
    #[default]
    Periodic,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub(super) struct MappedSource {
    pub path: PathBuf,
    #[serde(default)]
    pub kind: SourceKind,
    pub summary: String,
    #[serde(default)]
    pub recheck_hint: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub priority: SourcePriority,
    #[serde(default)]
    pub watch_mode: SourceWatchMode,
    #[serde(default)]
    pub last_verified_at: i64,
    #[serde(default)]
    pub low_yield_streak: u32,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct MappedSourceInput {
    pub path: PathBuf,
    #[serde(default)]
    pub kind: SourceKind,
    pub summary: String,
    #[serde(default)]
    pub recheck_hint: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub priority: SourcePriority,
    #[serde(default)]
    pub watch_mode: SourceWatchMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub(super) struct FrontierBranch {
    pub path: PathBuf,
    pub reason: String,
    #[serde(default)]
    pub next_probe_after: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct FrontierBranchInput {
    pub path: PathBuf,
    pub reason: String,
    #[serde(default)]
    pub next_probe_after: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(super) struct WorkspaceMap {
    pub phase: MapPhase,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub sources: Vec<MappedSource>,
    #[serde(default)]
    pub frontier: Vec<FrontierBranch>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct WanderTarget {
    pub path: PathBuf,
    pub is_frontier: bool,
    pub hint: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Update {
    Inspect,
    UpsertSources {
        sources: Vec<MappedSourceInput>,
    },
    MarkVerified {
        paths: Vec<PathBuf>,
        #[serde(default)]
        material_finding: bool,
    },
    RecordFrontier {
        branches: Vec<FrontierBranchInput>,
    },
    ResolveFrontier {
        paths: Vec<PathBuf>,
    },
    RemoveSources {
        paths: Vec<PathBuf>,
    },
    /// Merge any final sources/frontier and mark cold-start onboarding complete.
    MarkReady {
        #[serde(default)]
        sources: Vec<MappedSourceInput>,
        #[serde(default)]
        frontier: Vec<FrontierBranchInput>,
    },
    /// Reset map phase so the next discovery run re-onboards this workspace.
    Reset,
}

pub(super) fn map_key(workspace: &Path) -> String {
    format!(
        "{PREFIX}{}",
        hex::encode(Sha256::digest(workspace.as_os_str().as_encoded_bytes()))
    )
}

fn top_bucket(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .and_then(|rel| rel.components().next())
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .unwrap_or_default()
}

impl WorkspaceMap {
    pub(super) fn deepest_source_for(&self, path: &Path) -> Option<&MappedSource> {
        self.sources
            .iter()
            .filter(|s| path.starts_with(&s.path))
            .max_by_key(|s| s.path.components().count())
    }

    pub(super) fn watch_roots(&self) -> Vec<PathBuf> {
        self.sources
            .iter()
            .filter(|s| s.watch_mode == SourceWatchMode::Watch)
            .map(|s| s.path.clone())
            .collect()
    }

    /// Select up to `limit` targets from due frontier branches and due mapped sources,
    /// spreading across distinct top-level buckets when possible and backing off on
    /// repeated low-yield sources while guaranteeing starved entries get a turn.
    pub(super) fn select_wander_targets(
        &self,
        root: &Path,
        now_ms: i64,
        limit: usize,
        mut allowed: impl FnMut(&Path) -> bool,
    ) -> Vec<WanderTarget> {
        if limit == 0 {
            return Vec::new();
        }
        let mut candidates: Vec<(f64, String, WanderTarget)> = Vec::new();

        for branch in &self.frontier {
            if branch.next_probe_after.is_some_and(|after| after > now_ms) {
                continue;
            }
            if !allowed(&branch.path) {
                continue;
            }
            let bucket = top_bucket(root, &branch.path);
            // Frontier branches represent unexamined blind spots; give them strong priority.
            candidates.push((
                100.0,
                bucket,
                WanderTarget {
                    path: branch.path.clone(),
                    is_frontier: true,
                    hint: branch.reason.clone(),
                },
            ));
        }

        for source in &self.sources {
            if !allowed(&source.path) {
                continue;
            }
            let age_ms = now_ms.saturating_sub(source.last_verified_at).max(0);
            let backoff = 1_i64 << source.low_yield_streak.min(3);
            let due_interval = source.priority.base_interval_ms().saturating_mul(backoff);
            // Always allow sources never verified or overdue; cap starvation at 7 days.
            let max_starve_ms = 7 * 86_400_000_i64;
            if source.last_verified_at > 0 && age_ms < due_interval.min(max_starve_ms) {
                continue;
            }
            let overdue_ratio = (age_ms as f64) / (due_interval.max(1) as f64);
            let score = source.priority.weight() * (1.0 + overdue_ratio.min(10.0));
            let bucket = top_bucket(root, &source.path);
            let hint = if source.recheck_hint.is_empty() {
                source.summary.clone()
            } else {
                format!("{} ({})", source.summary, source.recheck_hint)
            };
            candidates.push((
                score,
                bucket,
                WanderTarget {
                    path: source.path.clone(),
                    is_frontier: false,
                    hint,
                },
            ));
        }

        // Highest score first, deterministic path tie-breaker.
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.2.path.cmp(&b.2.path)));

        // First pass: pick highest-scoring candidate per distinct top-level bucket.
        let mut chosen = Vec::with_capacity(limit);
        let mut used_buckets = BTreeSet::new();
        let mut used_paths = BTreeSet::new();
        for (_, bucket, target) in &candidates {
            if chosen.len() >= limit {
                break;
            }
            if used_buckets.insert(bucket.clone()) && used_paths.insert(target.path.clone()) {
                chosen.push(target.clone());
            }
        }
        // Second pass: fill any remaining slots by score.
        for (_, _, target) in candidates {
            if chosen.len() >= limit {
                break;
            }
            if used_paths.insert(target.path.clone()) {
                chosen.push(target);
            }
        }
        chosen
    }

    pub(super) fn compact_checkpoint(&self, root: &Path) -> String {
        if self.sources.is_empty() && self.frontier.is_empty() {
            return String::new();
        }
        let rel = |p: &Path| {
            p.strip_prefix(root)
                .unwrap_or(p)
                .to_string_lossy()
                .into_owned()
        };
        let mut out = String::new();
        if !self.sources.is_empty() {
            out.push_str("Mapped sources [path | kind | priority | summary | recheck]:\n");
            for s in self.sources.iter().take(24) {
                out.push_str(&format!(
                    "- {} | {:?} | {:?} | {} | {}\n",
                    rel(&s.path),
                    s.kind,
                    s.priority,
                    s.summary,
                    s.recheck_hint
                ));
            }
            if self.sources.len() > 24 {
                out.push_str(&format!(
                    "... (+{} more sources)\n",
                    self.sources.len() - 24
                ));
            }
        }
        if !self.frontier.is_empty() {
            out.push_str("Unfinished frontier [path | reason]:\n");
            for b in self.frontier.iter().take(16) {
                out.push_str(&format!("- {} | {}\n", rel(&b.path), b.reason));
            }
            if self.frontier.len() > 16 {
                out.push_str(&format!(
                    "... (+{} more frontier branches)\n",
                    self.frontier.len() - 16
                ));
            }
        }
        out
    }
}

struct MapValidator {
    root: PathBuf,
    dir: Dir,
    home: Option<PathBuf>,
    policy: Compiled,
}

fn is_broad_system_root(path: &Path, home: Option<&Path>) -> bool {
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

impl MapValidator {
    fn resolve(&self, supplied: &Path, must_exist: bool) -> Result<PathBuf, String> {
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
            return Err("provide a concrete path strictly inside this workspace".into());
        }
        if !self.policy.access(&absolute).can_read() {
            return Err("workspace read access required".into());
        }
        match open_relative(&self.dir, rel) {
            Ok(_) => {
                let canonical = self.root.join(self.dir.canonicalize(rel).map_err(reason)?);
                if !canonical.starts_with(&self.root)
                    || canonical == self.root
                    || !self.policy.access(&canonical).can_read()
                {
                    return Err("path outside authorized scope".into());
                }
                Ok(canonical)
            }
            Err(_) if !must_exist => Ok(absolute),
            // Allow single files inside the workspace (e.g. a top-level urgent file).
            Err(_) => {
                if let Some(parent) = rel.parent()
                    && let Some(name) = rel.file_name()
                    && let Ok(parent_dir) = open_relative(&self.dir, parent)
                    && parent_dir.symlink_metadata(name).is_ok()
                {
                    return Ok(absolute);
                }
                Err("expected an existing path without symlinks inside workspace".into())
            }
        }
    }

    fn upsert_source(
        &self,
        map: &mut WorkspaceMap,
        input: MappedSourceInput,
        at: i64,
    ) -> Result<(), String> {
        let path = self.resolve(&input.path, true)?;
        if is_broad_system_root(&path, self.home.as_deref()) {
            return Err("map a concrete content directory below the system root".into());
        }
        let summary = input.summary.trim();
        if summary.is_empty()
            || summary.chars().count() > 200
            || summary.chars().any(char::is_control)
        {
            return Err("provide a concise single-line summary (up to 200 characters)".into());
        }
        let recheck_hint = input.recheck_hint.trim();
        if recheck_hint.chars().count() > 200 || recheck_hint.chars().any(char::is_control) {
            return Err("recheck_hint must be a single line (up to 200 characters)".into());
        }
        let evidence = input.evidence.trim();
        if evidence.chars().count() > 240 || evidence.chars().any(char::is_control) {
            return Err("evidence must be a single line (up to 240 characters)".into());
        }
        if let Some(existing) = map.sources.iter_mut().find(|s| s.path == path) {
            existing.kind = input.kind;
            existing.summary = summary.to_owned();
            existing.recheck_hint = recheck_hint.to_owned();
            if !evidence.is_empty() {
                existing.evidence = evidence.to_owned();
            }
            existing.priority = input.priority;
            existing.watch_mode = input.watch_mode;
            existing.last_verified_at = at;
        } else {
            if map.sources.len() >= MAX_SOURCES {
                return Err(format!("at most {MAX_SOURCES} mapped sources permitted"));
            }
            map.sources.push(MappedSource {
                path: path.clone(),
                kind: input.kind,
                summary: summary.to_owned(),
                recheck_hint: recheck_hint.to_owned(),
                evidence: evidence.to_owned(),
                priority: input.priority,
                watch_mode: input.watch_mode,
                last_verified_at: at,
                low_yield_streak: 0,
            });
        }
        // Automatically resolve any matching frontier entry now that it's mapped.
        map.frontier.retain(|b| b.path != path);
        Ok(())
    }

    fn record_frontier(
        &self,
        map: &mut WorkspaceMap,
        input: FrontierBranchInput,
    ) -> Result<(), String> {
        let path = self.resolve(&input.path, false)?;
        let reason_text = input.reason.trim();
        if reason_text.is_empty()
            || reason_text.chars().count() > 200
            || reason_text.chars().any(char::is_control)
        {
            return Err(
                "provide a concise single-line frontier reason (up to 200 characters)".into(),
            );
        }
        if let Some(existing) = map.frontier.iter_mut().find(|b| b.path == path) {
            existing.reason = reason_text.to_owned();
            existing.next_probe_after = input.next_probe_after;
        } else {
            if map.frontier.len() >= MAX_FRONTIER {
                return Err(format!(
                    "at most {MAX_FRONTIER} frontier branches permitted"
                ));
            }
            map.frontier.push(FrontierBranch {
                path,
                reason: reason_text.to_owned(),
                next_probe_after: input.next_probe_after,
            });
        }
        Ok(())
    }

    fn apply(&self, map: &mut WorkspaceMap, update: Update, at: i64) -> Result<(), String> {
        match update {
            Update::Inspect => return Ok(()),
            Update::UpsertSources { sources } => {
                if map.phase == MapPhase::Uninitialized {
                    map.phase = MapPhase::Scanning;
                    map.started_at = Some(at);
                }
                for src in sources {
                    self.upsert_source(map, src, at)?;
                }
            }
            Update::MarkVerified {
                paths,
                material_finding,
            } => {
                for raw in paths {
                    let path = self.resolve(&raw, false)?;
                    if let Some(src) = map.sources.iter_mut().find(|s| s.path == path) {
                        src.last_verified_at = at;
                        if material_finding {
                            src.low_yield_streak = 0;
                        } else {
                            src.low_yield_streak = src.low_yield_streak.saturating_add(1);
                        }
                    }
                    map.frontier.retain(|b| b.path != path);
                }
            }
            Update::RecordFrontier { branches } => {
                if map.phase == MapPhase::Uninitialized {
                    map.phase = MapPhase::Scanning;
                    map.started_at = Some(at);
                }
                for branch in branches {
                    self.record_frontier(map, branch)?;
                }
            }
            Update::ResolveFrontier { paths } => {
                for raw in paths {
                    let path = self.resolve(&raw, false)?;
                    map.frontier.retain(|b| b.path != path);
                }
            }
            Update::RemoveSources { paths } => {
                for raw in paths {
                    let path = self.resolve(&raw, false)?;
                    map.sources.retain(|s| s.path != path);
                }
            }
            Update::MarkReady { sources, frontier } => {
                if map.started_at.is_none() {
                    map.started_at = Some(at);
                }
                for src in sources {
                    self.upsert_source(map, src, at)?;
                }
                for branch in frontier {
                    self.record_frontier(map, branch)?;
                }
                map.phase = MapPhase::Ready;
                map.completed_at = Some(at);
            }
            Update::Reset => {
                map.phase = MapPhase::Uninitialized;
                map.started_at = None;
                map.completed_at = None;
            }
        }
        map.updated_at = at;
        Ok(())
    }
}

impl scheduler::Scheduler {
    pub(super) async fn workspace_map(
        &self,
        workspace: &Path,
    ) -> Result<(Option<u64>, WorkspaceMap), String> {
        let Some(record) = self
            .storage
            .read(map_key(workspace))
            .await
            .map_err(reason)?
        else {
            return Ok((None, WorkspaceMap::default()));
        };
        let Data::Present(value) = record.data else {
            return Ok((Some(record.revision), WorkspaceMap::default()));
        };
        let map = serde_json::from_value(value).map_err(reason)?;
        Ok((Some(record.revision), map))
    }

    pub(super) async fn all_mapped_watch_roots(
        &self,
    ) -> Result<BTreeMap<String, Vec<PathBuf>>, String> {
        let mut after = None;
        let mut by_key = BTreeMap::new();
        loop {
            let page = self
                .storage
                .scan(maka_plugin_core::storage::Scan {
                    prefix: PREFIX.into(),
                    after,
                })
                .await
                .map_err(reason)?;
            for entry in page.entries {
                if let Data::Present(data) = entry.record.data
                    && let Ok(map) = serde_json::from_value::<WorkspaceMap>(data)
                {
                    by_key.insert(entry.key, map.watch_roots());
                }
            }
            after = page.next_after;
            if after.is_none() {
                break;
            }
        }
        Ok(by_key)
    }
}

impl Owner {
    pub(super) async fn update_workspace_map(
        &self,
        context: &ToolCallContext,
        update: Update,
    ) -> Result<Value, ToolError> {
        let access = self.discovery_call_access(context, WORKSPACE_MAP).await?;
        let id = &context.execution.session_id;
        if self.bot.is(id) {
            self.check_bot_invocation(context)
                .await
                .map_err(ToolError::Failed)?;
        } else {
            let (_, job) = self
                .scheduler
                .investigation()
                .await
                .map_err(ToolError::Failed)?;
            self.check_discovery_invocation(
                context,
                &job.ok_or_else(|| ToolError::Failed("discovery_not_active".into()))?,
            )
            .await
            .map_err(ToolError::Failed)?;
        }
        let session = self.session(id).await.map_err(ToolError::Failed)?;
        let selected = &session.configuration.workspace;
        let dir =
            workspace::open_workspace(&self.workspace_roots, selected, &self.managed_worktrees)
                .await
                .map_err(ToolError::Failed)?;
        let root = PathBuf::from(&selected.path);
        let floor = access
            .sandbox_floor(&context.call.origin)
            .await
            .map_err(|e| ToolError::Failed(e.to_string()))?;
        let maka_sandbox::Sandbox::Managed { filesystem, .. } = self
            .capture_sandbox(&session.configuration, &floor)
            .await
            .map_err(ToolError::Failed)?
            .intersect(&floor)
            .map_err(|e| ToolError::Failed(reason(e)))?
        else {
            return Err(ToolError::Failed("workspace read access required".into()));
        };
        if matches!(update, Update::Inspect) {
            let (_, map) = self
                .scheduler
                .workspace_map(&root)
                .await
                .map_err(ToolError::Failed)?;
            return serde_json::to_value(map).map_err(|e| ToolError::Failed(e.to_string()));
        }
        let validator = MapValidator {
            root: root.clone(),
            dir,
            home: self.watch_scopes.home.clone(),
            policy: filesystem
                .compile()
                .map_err(|e| ToolError::Failed(reason(e)))?,
        };
        let _edit = self.watch_scopes.edits.lock().await;
        let (revision, mut map) = self
            .scheduler
            .workspace_map(&root)
            .await
            .map_err(ToolError::Failed)?;
        let key = map_key(&root);
        let at = now() as i64;
        let map = tokio::task::spawn_blocking(move || {
            validator.apply(&mut map, update, at)?;
            Ok::<_, String>(map)
        })
        .await
        .map_err(|e| ToolError::Failed(reason(e)))?
        .map_err(ToolError::Failed)?;
        let watch_roots = map.watch_roots();
        let summary = serde_json::json!({
            "updated": true,
            "phase": map.phase,
            "source_count": map.sources.len(),
            "frontier_count": map.frontier.len(),
        });
        self.scheduler
            .storage
            .batch(vec![
                mutation(key.clone(), revision, &map).map_err(ToolError::Failed)?,
            ])
            .await
            .map_err(result_write_error)?;
        self.watch_scopes.set_mapped_watch_roots(key, watch_roots);
        Ok(summary)
    }
}

/// Fast 0-token top-level directory listing (including dotfiles and common app containers)
/// used as the starting inventory for `DiscoveryMode::Onboard`.
pub(super) fn onboard_inventory(root: &Path, dir: &Dir, policy: &Compiled) -> io::Result<String> {
    let mut rows: Vec<(i64, String, &'static str)> = Vec::new();
    for entry in dir.entries()? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let path = root.join(&name);
        if !policy.access(&path).can_read() {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let kind = if ft.is_dir() {
            "dir"
        } else if ft.is_file() {
            "file"
        } else {
            continue;
        };
        let mtime_ms = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.into_std().duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
        rows.push((mtime_ms, name.to_string_lossy().into_owned(), kind));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut out = String::from("Workspace top-level entries [name (kind, mtime_ms)]:\n");
    for (mtime, name, kind) in rows.iter().take(60) {
        out.push_str(&format!("- {name} ({kind}, {mtime})\n"));
    }
    if rows.len() > 60 {
        out.push_str(&format!("... (+{} more entries)\n", rows.len() - 60));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_wander_targets_prioritizes_frontier_and_spreads_across_buckets() {
        let root = PathBuf::from("/home/u");
        let now_ms = 10 * 86_400_000_i64;
        let map = WorkspaceMap {
            phase: MapPhase::Ready,
            started_at: Some(1),
            completed_at: Some(2),
            updated_at: 2,
            sources: vec![
                MappedSource {
                    path: root.join("Documents/a"),
                    kind: SourceKind::Docs,
                    summary: "doc a".into(),
                    recheck_hint: "check latest".into(),
                    evidence: String::new(),
                    priority: SourcePriority::High,
                    watch_mode: SourceWatchMode::Periodic,
                    last_verified_at: 0,
                    low_yield_streak: 0,
                },
                MappedSource {
                    path: root.join("Documents/b"),
                    kind: SourceKind::Docs,
                    summary: "doc b".into(),
                    recheck_hint: String::new(),
                    evidence: String::new(),
                    priority: SourcePriority::High,
                    watch_mode: SourceWatchMode::Periodic,
                    last_verified_at: 0,
                    low_yield_streak: 0,
                },
                MappedSource {
                    path: root.join("Developer/proj"),
                    kind: SourceKind::Project,
                    summary: "proj".into(),
                    recheck_hint: String::new(),
                    evidence: String::new(),
                    priority: SourcePriority::Medium,
                    watch_mode: SourceWatchMode::Watch,
                    last_verified_at: 0,
                    low_yield_streak: 0,
                },
            ],
            frontier: vec![FrontierBranch {
                path: root.join("Desktop/urgent"),
                reason: "unchecked desktop folder".into(),
                next_probe_after: None,
            }],
        };

        let picked = map.select_wander_targets(&root, now_ms, 3, |_| true);
        assert_eq!(picked.len(), 3);
        assert_eq!(picked[0].path, root.join("Desktop/urgent"));
        assert!(picked[0].is_frontier);
        // Should spread across Documents and Developer rather than picking two Documents entries.
        let paths: Vec<_> = picked.iter().map(|t| t.path.clone()).collect();
        assert!(paths.contains(&root.join("Documents/a")));
        assert!(paths.contains(&root.join("Developer/proj")));
    }

    #[test]
    fn deepest_source_matches_most_specific_root() {
        let root = PathBuf::from("/home/u");
        let map = WorkspaceMap {
            sources: vec![
                MappedSource {
                    path: root.join("Documents"),
                    kind: SourceKind::Docs,
                    summary: "docs".into(),
                    recheck_hint: String::new(),
                    evidence: String::new(),
                    priority: SourcePriority::Low,
                    watch_mode: SourceWatchMode::Periodic,
                    last_verified_at: 0,
                    low_yield_streak: 0,
                },
                MappedSource {
                    path: root.join("Documents/reports"),
                    kind: SourceKind::Docs,
                    summary: "weekly reports".into(),
                    recheck_hint: "check latest md".into(),
                    evidence: String::new(),
                    priority: SourcePriority::High,
                    watch_mode: SourceWatchMode::Watch,
                    last_verified_at: 0,
                    low_yield_streak: 0,
                },
            ],
            ..Default::default()
        };
        let found = map
            .deepest_source_for(&root.join("Documents/reports/week12.md"))
            .unwrap();
        assert_eq!(found.summary, "weekly reports");
    }
}
