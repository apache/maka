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

use super::{
    GitBranchEntry, GitChangeKind, GitCommitSummary, GitCompare, GitCompareEntry, GitCompareSpec,
    GitDiff, GitRemoteRepo, GitRevisions, GitWorkspaceDiff, GitWorktreeEntry, WorkspacePath, diff,
    failure, interrupted, repository,
};
use gix::{bstr::ByteSlice, hash::ObjectId, index::entry::Mode};
use std::{
    cmp::Ordering as CmpOrdering,
    collections::{BinaryHeap, HashMap, HashSet},
    io,
};

const MAX_BRANCHES: usize = 200;
const MAX_COMMITS: usize = 40;
const MAX_MERGE_BASE_STEPS: usize = 32_768;
const MAX_COMPARE_PATCH_BYTES: usize = 2 * 1024 * 1024;

pub(super) fn read_revisions(repo: &repository::Repository) -> io::Result<GitRevisions> {
    interrupted(&repo.cancel)?;
    let head_branch = repo
        .repo
        .head_name()
        .map_err(io::Error::other)?
        .and_then(|name| {
            name.as_bstr()
                .strip_prefix(b"refs/heads/")
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .map(str::to_owned)
        });

    let mut branches = Vec::new();
    let refs = repo.repo.references().map_err(io::Error::other)?;
    if let Ok(local_iter) = refs.local_branches() {
        for item in local_iter {
            interrupted(&repo.cancel)?;
            if branches.len() >= MAX_BRANCHES {
                break;
            }
            let Ok(mut reference) = item else { continue };
            let Some(name) = reference
                .name()
                .as_bstr()
                .strip_prefix(b"refs/heads/")
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .map(str::to_owned)
            else {
                continue;
            };
            let Ok(id) = reference.peel_to_id() else {
                continue;
            };
            let oid = id.detach();
            if repo.repo.find_commit(oid).is_err() {
                continue;
            }
            branches.push(GitBranchEntry {
                name,
                oid: oid.to_string(),
                remote: false,
            });
        }
    }
    if let Ok(remote_iter) = refs.remote_branches() {
        for item in remote_iter {
            interrupted(&repo.cancel)?;
            if branches.len() >= MAX_BRANCHES {
                break;
            }
            let Ok(mut reference) = item else { continue };
            let Some(name) = reference
                .name()
                .as_bstr()
                .strip_prefix(b"refs/remotes/")
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .map(str::to_owned)
            else {
                continue;
            };
            if name.ends_with("/HEAD") {
                continue;
            }
            let Ok(id) = reference.peel_to_id() else {
                continue;
            };
            let oid = id.detach();
            if repo.repo.find_commit(oid).is_err() {
                continue;
            }
            branches.push(GitBranchEntry {
                name,
                oid: oid.to_string(),
                remote: true,
            });
        }
    }
    branches.sort_by(|a, b| a.remote.cmp(&b.remote).then_with(|| a.name.cmp(&b.name)));

    let default_base = detect_default_base(repo, head_branch.as_deref(), &branches);
    let commits = read_recent_commits(repo)?;
    let remotes = read_remotes(repo)?;
    let worktrees = read_worktrees(repo);

    Ok(GitRevisions {
        head_branch,
        head_oid: repo.head.clone(),
        default_base,
        branches,
        commits,
        remotes,
        worktrees,
    })
}

fn detect_default_base(
    repo: &repository::Repository,
    head_branch: Option<&str>,
    branches: &[GitBranchEntry],
) -> Option<String> {
    let differs_from_head = |candidate: &str| {
        let Some(current) = head_branch else {
            return true;
        };
        candidate != current && candidate != format!("origin/{current}")
    };

    if let Ok(Some(origin_head)) = repo.repo.try_find_reference("refs/remotes/origin/HEAD")
        && let Some(target) = origin_head.target().try_name()
        && let Some(short) = target
            .as_bstr()
            .strip_prefix(b"refs/remotes/")
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
        && differs_from_head(short)
        && branches.iter().any(|b| b.name == short)
    {
        return Some(short.to_owned());
    }

    const CANDIDATES: &[&str] = &[
        "origin/main",
        "origin/master",
        "origin/rust-preview",
        "origin/develop",
        "main",
        "master",
        "rust-preview",
        "develop",
    ];
    for candidate in CANDIDATES {
        if differs_from_head(candidate) && branches.iter().any(|b| b.name == *candidate) {
            return Some((*candidate).to_owned());
        }
    }
    branches
        .iter()
        .find(|b| differs_from_head(&b.name))
        .map(|b| b.name.clone())
}

fn read_recent_commits(repo: &repository::Repository) -> io::Result<Vec<GitCommitSummary>> {
    let Some(head_hex) = repo.head.as_deref() else {
        return Ok(Vec::new());
    };
    let mut current = Some(ObjectId::from_hex(head_hex.as_bytes()).map_err(io::Error::other)?);
    let mut seen = HashSet::new();
    let mut commits = Vec::new();
    while let Some(oid) = current {
        interrupted(&repo.cancel)?;
        if commits.len() >= MAX_COMMITS || !seen.insert(oid) {
            break;
        }
        let commit = repo.repo.find_commit(oid).map_err(io::Error::other)?;
        let decoded = commit.decode().map_err(io::Error::other)?;
        let message = decoded.message.to_str_lossy();
        let summary = message
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .chars()
            .take(160)
            .collect::<String>();
        let author = decoded
            .author()
            .map(|sig| sig.name.to_str_lossy().into_owned())
            .unwrap_or_default();
        let timestamp = commit.time().map(|time| time.seconds).unwrap_or(0);
        let hex = oid.to_string();
        let short_oid = hex.chars().take(7).collect();
        current = commit.parent_ids().next().map(|id| id.detach());
        commits.push(GitCommitSummary {
            oid: hex,
            short_oid,
            summary,
            author,
            timestamp,
        });
    }
    Ok(commits)
}

fn read_remotes(repo: &repository::Repository) -> io::Result<Vec<GitRemoteRepo>> {
    let config_path = repo.repo.common_dir().join("config");
    let Some(bytes) = repository::optional(&config_path)? else {
        return Ok(Vec::new());
    };
    let text = String::from_utf8_lossy(&bytes);
    Ok(parse_git_config_remotes(&text))
}

pub(crate) fn parse_git_config_remotes(config_text: &str) -> Vec<GitRemoteRepo> {
    let mut raw: Vec<(String, String)> = Vec::new();
    let mut current_remote: Option<String> = None;

    for line in config_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('[') {
            current_remote = None;
            let Some(header) = rest.split(']').next() else {
                continue;
            };
            let header = header.trim();
            if let Some(after) = header.strip_prefix("remote") {
                let after = after.trim();
                if let Some(quoted) = after.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
                    if !quoted.is_empty() {
                        current_remote = Some(quoted.to_owned());
                    }
                } else if let Some(dotted) = after.strip_prefix('.')
                    && !dotted.is_empty()
                {
                    current_remote = Some(dotted.to_owned());
                }
            }
            continue;
        }
        let Some(remote_name) = current_remote.as_ref() else {
            continue;
        };
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("url") {
            continue;
        }
        let value = strip_config_value(value);
        if !value.is_empty() && !raw.iter().any(|(name, _)| name == remote_name) {
            raw.push((remote_name.clone(), value));
        }
    }

    raw.sort_by(|(a, _), (b, _)| {
        let rank = |name: &str| match name {
            "origin" => 0_u8,
            "upstream" => 1_u8,
            _ => 2_u8,
        };
        rank(a).cmp(&rank(b)).then_with(|| a.cmp(b))
    });

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (remote, url) in raw {
        if let Some(parsed) = parse_remote_repo(&remote, &url) {
            let dedup_key = (
                parsed.host.to_ascii_lowercase(),
                parsed.owner.to_ascii_lowercase(),
                parsed.repo.to_ascii_lowercase(),
            );
            if seen.insert(dedup_key) {
                out.push(parsed);
            }
        }
    }
    out
}

fn strip_config_value(raw: &str) -> String {
    let mut out = String::new();
    let mut in_quotes = false;
    let mut escaped = false;
    for ch in raw.trim().chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && in_quotes {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_quotes = !in_quotes;
            continue;
        }
        if !in_quotes && (ch == '#' || ch == ';') {
            break;
        }
        out.push(ch);
    }
    out.trim().to_owned()
}

pub fn parse_remote_repo(remote: &str, raw_url: &str) -> Option<GitRemoteRepo> {
    let url = raw_url.trim();
    if url.is_empty() || url.chars().any(char::is_control) {
        return None;
    }
    let (host, path) = if let Some((_, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/')?;
        let host_port = authority
            .rsplit_once('@')
            .map_or(authority, |(_, right)| right);
        let host = if host_port.starts_with('[') {
            return None;
        } else {
            host_port
                .split_once(':')
                .map_or(host_port, |(left, _)| left)
        };
        (host, path)
    } else {
        let (left, path) = url.split_once(':')?;
        if left.contains('/') || left.contains('\\') || left.len() <= 1 {
            return None;
        }
        let host = left.rsplit_once('@').map_or(left, |(_, right)| right);
        (host, path)
    };

    let host = host.trim().to_ascii_lowercase();
    if !valid_hostname(&host) {
        return None;
    }
    let trimmed_path = path.trim_matches('/');
    let trimmed_path = trimmed_path.strip_suffix(".git").unwrap_or(trimmed_path);
    let mut segments = trimmed_path.split('/');
    let owner = segments.next()?;
    let repo_name = segments.next()?;
    if segments.next().is_some() || !valid_repo_segment(owner) || !valid_repo_segment(repo_name) {
        return None;
    }
    Some(GitRemoteRepo {
        remote: remote.to_owned(),
        host,
        owner: owner.to_owned(),
        repo: repo_name.to_owned(),
    })
}

fn valid_hostname(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.starts_with('-')
        && !host.ends_with('-')
        && host.contains('.')
        && !host.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn valid_repo_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub(super) fn compare(
    repo: &repository::Repository,
    spec: &GitCompareSpec,
    include_patch: bool,
) -> io::Result<GitCompare> {
    let resolved = resolve_spec_trees(repo, spec)?;
    let base_index = repo
        .repo
        .index_from_tree(&resolved.base_tree)
        .map_err(io::Error::other)?;
    let head_index = repo
        .repo
        .index_from_tree(&resolved.head_tree)
        .map_err(io::Error::other)?;

    for entry in base_index.entries().iter().chain(head_index.entries()) {
        interrupted(&repo.cancel)?;
        if entry.mode == Mode::COMMIT || entry.mode == Mode::DIR {
            return Err(failure("git_unsupported"));
        }
    }

    let left = base_index.entries();
    let right = head_index.entries();
    let (mut i, mut j) = (0_usize, 0_usize);
    let mut raw_changes: Vec<(
        Vec<u8>,
        GitChangeKind,
        String,
        Option<(ObjectId, u32)>,
        Option<(ObjectId, u32)>,
    )> = Vec::new();

    while i < left.len() || j < right.len() {
        interrupted(&repo.cancel)?;
        let ordering = match (left.get(i), right.get(j)) {
            (Some(a), Some(b)) => a.path(&base_index).cmp(b.path(&head_index)),
            (Some(_), None) => CmpOrdering::Less,
            (None, Some(_)) => CmpOrdering::Greater,
            (None, None) => break,
        };
        match ordering {
            CmpOrdering::Less => {
                let old = &left[i];
                let path_bytes = old.path(&base_index).to_vec();
                let digest = format!("{:06o}:{}..000000:0", old.mode.bits(), old.id);
                raw_changes.push((
                    path_bytes,
                    GitChangeKind::Deleted,
                    digest,
                    Some((old.id, old.mode.bits())),
                    None,
                ));
                i += 1;
            }
            CmpOrdering::Greater => {
                let new = &right[j];
                let path_bytes = new.path(&head_index).to_vec();
                let digest = format!("000000:0..{:06o}:{}", new.mode.bits(), new.id);
                raw_changes.push((
                    path_bytes,
                    GitChangeKind::Added,
                    digest,
                    None,
                    Some((new.id, new.mode.bits())),
                ));
                j += 1;
            }
            CmpOrdering::Equal => {
                let old = &left[i];
                let new = &right[j];
                if old.id != new.id || old.mode != new.mode {
                    let path_bytes = new.path(&head_index).to_vec();
                    let kind = if (old.mode.bits() & 0o170000) != (new.mode.bits() & 0o170000) {
                        GitChangeKind::TypeChanged
                    } else {
                        GitChangeKind::Modified
                    };
                    let digest = format!(
                        "{:06o}:{}..{:06o}:{}",
                        old.mode.bits(),
                        old.id,
                        new.mode.bits(),
                        new.id
                    );
                    raw_changes.push((
                        path_bytes,
                        kind,
                        digest,
                        Some((old.id, old.mode.bits())),
                        Some((new.id, new.mode.bits())),
                    ));
                }
                i += 1;
                j += 1;
            }
        }
    }

    let mut entries = Vec::with_capacity(raw_changes.len());
    let mut combined = String::new();
    let mut truncated = false;
    let mut skipped_files = 0_u64;

    for (path_bytes, kind, digest, old_obj, new_obj) in raw_changes {
        interrupted(&repo.cancel)?;
        let path = WorkspacePath::from_bytes(&path_bytes)?;
        entries.push(GitCompareEntry { path, kind, digest });
        if !include_patch {
            continue;
        }
        if truncated {
            skipped_files += 1;
            continue;
        }
        let before = old_obj
            .map(|(oid, mode)| diff::object(repo, oid, mode))
            .transpose()?;
        let after = new_obj
            .map(|(oid, mode)| diff::object(repo, oid, mode))
            .transpose()?;
        match diff::patch_images(repo, &path_bytes, before.as_ref(), after.as_ref())? {
            diff::PatchDiff::Text(patch) => {
                if combined.len() + patch.len() > MAX_COMPARE_PATCH_BYTES {
                    truncated = true;
                    skipped_files += 1;
                } else {
                    combined.push_str(&patch);
                }
            }
            diff::PatchDiff::Binary | diff::PatchDiff::Unsupported => {
                skipped_files += 1;
            }
            diff::PatchDiff::Unchanged => {}
        }
    }

    Ok(GitCompare {
        base_oid: resolved.base_oid.map(|id| id.to_string()),
        head_oid: resolved.head_oid.to_string(),
        entries,
        patch: include_patch.then_some(GitWorkspaceDiff {
            patch: combined,
            truncated,
            skipped_files,
        }),
    })
}

pub(super) fn compare_diff(
    repo: &repository::Repository,
    spec: &GitCompareSpec,
    name: &[u8],
) -> io::Result<GitDiff> {
    let resolved = resolve_spec_trees(repo, spec)?;
    let before = lookup_tree_image(repo, resolved.base_tree, name)?;
    let after = lookup_tree_image(repo, resolved.head_tree, name)?;
    diff::diff_images(repo, name, before, after)
}

const MAX_WORKTREES: usize = 64;

fn read_worktrees(repo: &repository::Repository) -> Vec<GitWorktreeEntry> {
    let Ok(common_dir) = dunce::canonicalize(repo.repo.common_dir()) else {
        return Vec::new();
    };
    let current_root = repo.root.clone();
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    if let Some(main_parent) = common_dir.parent()
        && let Ok(main_root) = dunce::canonicalize(main_parent)
        && main_root.is_dir()
        && seen.insert(main_root.clone())
    {
        let (branch, head_oid) = parse_head_file(repo, &common_dir.join("HEAD"));
        let name = main_root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("main")
            .to_owned();
        out.push(GitWorktreeEntry {
            is_current: main_root == current_root,
            is_main: true,
            path: main_root.to_string_lossy().into_owned(),
            name,
            branch,
            head_oid,
        });
    }

    let wt_dir = common_dir.join("worktrees");
    if let Ok(read_dir) = std::fs::read_dir(&wt_dir) {
        let mut entries: Vec<_> = read_dir.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if out.len() >= MAX_WORKTREES {
                break;
            }
            let entry_path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&entry_path) else {
                continue;
            };
            if !meta.is_dir() || meta.file_type().is_symlink() {
                continue;
            }
            let Ok(Some(gitdir_bytes)) = repository::optional(&entry_path.join("gitdir")) else {
                continue;
            };
            let Ok(gitdir_str) = std::str::from_utf8(&gitdir_bytes) else {
                continue;
            };
            let gitdir_trimmed = gitdir_str.trim();
            if gitdir_trimmed.is_empty() {
                continue;
            }
            let gitdir_path = if std::path::Path::new(gitdir_trimmed).is_absolute() {
                std::path::PathBuf::from(gitdir_trimmed)
            } else {
                entry_path.join(gitdir_trimmed)
            };
            let Some(wt_parent) = gitdir_path.parent() else {
                continue;
            };
            let Ok(wt_root) = dunce::canonicalize(wt_parent) else {
                continue;
            };
            if !wt_root.is_dir() || !seen.insert(wt_root.clone()) {
                continue;
            }
            let (branch, head_oid) = parse_head_file(repo, &entry_path.join("HEAD"));
            let fallback_name = entry.file_name();
            let name = wt_root
                .file_name()
                .and_then(|s| s.to_str())
                .or_else(|| fallback_name.to_str())
                .unwrap_or("worktree")
                .to_owned();
            out.push(GitWorktreeEntry {
                is_current: wt_root == current_root,
                is_main: false,
                path: wt_root.to_string_lossy().into_owned(),
                name,
                branch,
                head_oid,
            });
        }
    }

    if !out.iter().any(|w| w.is_current) {
        let name = current_root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("workspace")
            .to_owned();
        out.insert(
            0,
            GitWorktreeEntry {
                path: current_root.to_string_lossy().into_owned(),
                name,
                branch: repo.repo.head_name().ok().flatten().and_then(|n| {
                    n.as_bstr()
                        .strip_prefix(b"refs/heads/")
                        .and_then(|b| std::str::from_utf8(b).ok())
                        .map(str::to_owned)
                }),
                head_oid: repo.head.clone(),
                is_current: true,
                is_main: false,
            },
        );
    }
    out
}

fn parse_head_file(
    repo: &repository::Repository,
    head_path: &std::path::Path,
) -> (Option<String>, Option<String>) {
    let Ok(Some(bytes)) = repository::optional(head_path) else {
        return (None, None);
    };
    let Ok(raw) = std::str::from_utf8(&bytes) else {
        return (None, None);
    };
    let trimmed = raw.trim();
    if let Some(ref_name) = trimmed.strip_prefix("ref:").map(str::trim) {
        let branch = ref_name.strip_prefix("refs/heads/").map(str::to_owned);
        let oid = repo
            .repo
            .try_find_reference(ref_name)
            .ok()
            .flatten()
            .and_then(|mut r| r.peel_to_id().ok().map(|id| id.detach().to_string()));
        (branch, oid)
    } else if ObjectId::from_hex(trimmed.as_bytes()).is_ok() {
        (None, Some(trimmed.to_owned()))
    } else {
        (None, None)
    }
}

pub(super) fn same_common_git_dir(first: &std::path::Path, second: &std::path::Path) -> bool {
    let open_common = |dir: &std::path::Path| -> Option<std::path::PathBuf> {
        let canonical = dunce::canonicalize(dir).ok()?;
        let dot_git = std::fs::symlink_metadata(canonical.join(".git")).ok()?;
        if dot_git.file_type().is_symlink() {
            return None;
        }
        let repo = gix::open::Options::isolated()
            .strict_config(true)
            .filter_config_section(|_| false)
            .open(&canonical)
            .ok()?
            .to_thread_local();
        let workdir = repo.workdir().and_then(|w| dunce::canonicalize(w).ok())?;
        if workdir != canonical {
            return None;
        }
        dunce::canonicalize(repo.common_dir()).ok()
    };
    match (open_common(first), open_common(second)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

pub(super) fn merge_base_file_diff(
    repo: &repository::Repository,
    base_oid: &str,
    head_oid: &str,
    name: &[u8],
    previous_name: Option<&[u8]>,
) -> io::Result<GitDiff> {
    let target_base = resolve_commit_oid(repo, base_oid)?;
    let head = resolve_commit_oid(repo, head_oid)?;
    let lca = merge_base(repo, target_base, head)?;
    let base_tree = commit_tree_id(repo, lca)?;
    let head_tree = commit_tree_id(repo, head)?;
    let old_name = previous_name.unwrap_or(name);
    let before = lookup_tree_image(repo, base_tree, old_name)?;
    let after = lookup_tree_image(repo, head_tree, name)?;
    diff::diff_images_pair(repo, old_name, name, before, after)
}

fn lookup_tree_image(
    repo: &repository::Repository,
    tree_id: ObjectId,
    name: &[u8],
) -> io::Result<Option<super::image::Image>> {
    if tree_id == ObjectId::empty_tree(repo.repo.object_hash()) {
        return Ok(None);
    }
    let tree = repo.repo.find_tree(tree_id).map_err(io::Error::other)?;
    let Some(entry) = tree
        .lookup_entry(name.split(|b| *b == b'/').map(|part| part.to_vec()))
        .map_err(io::Error::other)?
    else {
        return Ok(None);
    };
    let mode = u32::from(entry.mode().value());
    if entry.mode().is_commit() || entry.mode().is_tree() {
        return Err(failure("git_unsupported"));
    }
    diff::object(repo, entry.object_id(), mode).map(Some)
}

struct ResolvedTrees {
    base_oid: Option<ObjectId>,
    head_oid: ObjectId,
    base_tree: ObjectId,
    head_tree: ObjectId,
}

fn resolve_spec_trees(
    repo: &repository::Repository,
    spec: &GitCompareSpec,
) -> io::Result<ResolvedTrees> {
    match spec {
        GitCompareSpec::Branch { base } => {
            let Some(head_hex) = repo.head.as_deref() else {
                return Err(failure("git_revision_not_found"));
            };
            let head_oid =
                ObjectId::from_hex(head_hex.as_bytes()).map_err(|_| failure("git_unavailable"))?;
            let target_base = resolve_commit_oid(repo, base)?;
            let lca = merge_base(repo, target_base, head_oid)?;
            let base_tree = commit_tree_id(repo, lca)?;
            let head_tree = commit_tree_id(repo, head_oid)?;
            Ok(ResolvedTrees {
                base_oid: Some(lca),
                head_oid,
                base_tree,
                head_tree,
            })
        }
        GitCompareSpec::Commit { oid } => {
            let head_oid = resolve_commit_oid(repo, oid)?;
            let commit = repo.repo.find_commit(head_oid).map_err(io::Error::other)?;
            let base_oid = commit.parent_ids().next().map(|id| id.detach());
            let base_tree = match base_oid {
                Some(parent) => commit_tree_id(repo, parent)?,
                None => ObjectId::empty_tree(repo.repo.object_hash()),
            };
            let head_tree = commit.tree_id().map_err(io::Error::other)?.detach();
            Ok(ResolvedTrees {
                base_oid,
                head_oid,
                base_tree,
                head_tree,
            })
        }
        GitCompareSpec::Range { base, head } => {
            let base_oid = resolve_commit_oid(repo, base)?;
            let head_oid = resolve_commit_oid(repo, head)?;
            let base_tree = commit_tree_id(repo, base_oid)?;
            let head_tree = commit_tree_id(repo, head_oid)?;
            Ok(ResolvedTrees {
                base_oid: Some(base_oid),
                head_oid,
                base_tree,
                head_tree,
            })
        }
    }
}

fn resolve_commit_oid(repo: &repository::Repository, raw: &str) -> io::Result<ObjectId> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains("..") || trimmed.chars().any(char::is_control) {
        return Err(failure("git_invalid_revision"));
    }
    if let Ok(oid) = ObjectId::from_hex(trimmed.as_bytes())
        && let Ok(obj) = repo.repo.find_object(oid)
        && let Ok(commit) = obj.peel_to_commit()
    {
        return Ok(commit.id);
    }
    if let Ok(Some(mut reference)) = repo.repo.try_find_reference(trimmed)
        && let Ok(peeled) = reference.peel_to_id()
        && let Ok(obj) = repo.repo.find_object(peeled.detach())
        && let Ok(commit) = obj.peel_to_commit()
    {
        return Ok(commit.id);
    }
    Err(failure("git_revision_not_found"))
}

fn commit_tree_id(repo: &repository::Repository, commit_id: ObjectId) -> io::Result<ObjectId> {
    Ok(repo
        .repo
        .find_commit(commit_id)
        .map_err(io::Error::other)?
        .tree_id()
        .map_err(io::Error::other)?
        .detach())
}

fn commit_timestamp(repo: &repository::Repository, commit_id: ObjectId) -> io::Result<i64> {
    Ok(repo
        .repo
        .find_commit(commit_id)
        .map_err(io::Error::other)?
        .time()
        .map(|t| t.seconds)
        .unwrap_or(0))
}

fn merge_base(repo: &repository::Repository, a: ObjectId, b: ObjectId) -> io::Result<ObjectId> {
    if a == b {
        return Ok(a);
    }
    let mut seen: HashMap<ObjectId, u8> = HashMap::new();
    let mut processed: HashMap<ObjectId, u8> = HashMap::new();
    let mut heap: BinaryHeap<(i64, ObjectId)> = BinaryHeap::new();
    let mut candidates: Vec<ObjectId> = Vec::new();

    seen.insert(a, 1);
    heap.push((commit_timestamp(repo, a)?, a));
    let b_flags = seen.entry(b).or_insert(0);
    *b_flags |= 2;
    heap.push((commit_timestamp(repo, b)?, b));

    let mut steps = 0_usize;
    while let Some((_, oid)) = heap.pop() {
        interrupted(&repo.cancel)?;
        let flags = seen.get(&oid).copied().unwrap_or(0);
        let done = processed.get(&oid).copied().unwrap_or(0);
        if (done & flags) == flags {
            continue;
        }
        processed.insert(oid, done | flags);

        let is_common = (flags & 3) == 3;
        if is_common && (flags & 4) == 0 && !candidates.contains(&oid) {
            candidates.push(oid);
        }

        steps += 1;
        if steps >= MAX_MERGE_BASE_STEPS {
            break;
        }

        let propagate = if is_common { 3 | 4 } else { flags };
        let commit = repo.repo.find_commit(oid).map_err(io::Error::other)?;
        for parent_id in commit.parent_ids() {
            let parent = parent_id.detach();
            let prev = seen.get(&parent).copied().unwrap_or(0);
            let next = prev | propagate;
            if next != prev {
                seen.insert(parent, next);
                heap.push((commit_timestamp(repo, parent)?, parent));
            }
        }

        if is_common
            && !heap
                .iter()
                .any(|(_, queued)| (seen.get(queued).copied().unwrap_or(0) & 3) != 3)
        {
            break;
        }
    }

    Ok(candidates
        .into_iter()
        .find(|candidate| (seen.get(candidate).copied().unwrap_or(0) & 4) == 0)
        .unwrap_or(a))
}
