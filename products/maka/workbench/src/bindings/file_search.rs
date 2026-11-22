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

//! On-demand filename catalog. Each directory is listed again only when its mtime changes.
use nsh_core::prelude::*;
use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

const PERSONAL: &[&str] = &[
    "Downloads",
    "Desktop",
    "Documents",
    "Pictures",
    "Music",
    "Movies",
];
#[derive(Clone, JsObject)]
pub struct ScopeStatus {
    pub root: String,
    pub state: String,
}
#[derive(Clone, JsObject)]
pub struct SearchResult {
    pub paths: Vec<String>,
    pub scopes: Vec<ScopeStatus>,
    pub volumes: Vec<String>,
}

struct Entry {
    name: String,
    lower: String,
    directory: bool,
}
struct Listing {
    modified: Option<SystemTime>,
    entries: Vec<Entry>,
}
#[derive(Default)]
struct Catalog {
    dirs: HashMap<PathBuf, Arc<Listing>>,
    checked: Option<Instant>,
    running: bool,
    state: &'static str,
}
#[derive(Default)]
struct Scope {
    catalog: Mutex<Catalog>,
    cancelled: AtomicBool,
}
static SCOPES: LazyLock<Mutex<HashMap<String, Arc<Scope>>>> = LazyLock::new(Default::default);

fn read_listing(dir: &Path, home_remainder: bool) -> io::Result<Listing> {
    let modified = fs::metadata(dir)?.modified().ok();
    let mut entries = Vec::new();
    for item in fs::read_dir(dir)? {
        let item = item?;
        let Ok(name) = item.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.')
            || (home_remainder && (name == "Library" || PERSONAL.contains(&name.as_str())))
        {
            continue;
        }
        let directory = match item.file_type() {
            Ok(kind) => kind.is_dir(),
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        };
        if directory
            && matches!(
                name.as_str(),
                "node_modules" | "target" | "Caches" | "__pycache__"
            )
        {
            continue;
        }
        entries.push(Entry {
            lower: name.to_lowercase(),
            directory: directory
                && ![".app", ".photoslibrary", ".bundle", ".framework"]
                    .iter()
                    .any(|suffix| name.ends_with(suffix)),
            name,
        });
    }
    Ok(Listing { modified, entries })
}

fn failure(err: &io::Error) -> &'static str {
    match err.kind() {
        io::ErrorKind::PermissionDenied => "denied",
        io::ErrorKind::NotFound => "missing",
        _ => "unavailable",
    }
}

fn scan(scope: &Scope, root: &Path, home_remainder: bool) {
    let mut pending = VecDeque::from([root.to_owned()]);
    let mut visited = std::collections::HashSet::new();
    let mut state = "ready";
    while let Some(dir) = pending.pop_front() {
        if scope.cancelled.load(Ordering::Relaxed) {
            return;
        }
        let old = scope.catalog.lock().unwrap().dirs.get(&dir).cloned();
        let result = fs::metadata(&dir).and_then(|meta| {
            let modified = meta.modified().ok();
            if let Some(old) = old.filter(|old| modified.is_some() && modified == old.modified) {
                return Ok(old);
            }
            read_listing(&dir, home_remainder && dir == root).map(Arc::new)
        });
        match result {
            Ok(list) => {
                for entry in &list.entries {
                    if entry.directory {
                        pending.push_back(dir.join(&entry.name));
                    }
                }
                visited.insert(dir.clone());
                scope.catalog.lock().unwrap().dirs.insert(dir, list);
            }
            Err(err) if dir == root => {
                state = failure(&err);
                break;
            }
            Err(err) if err.kind() != io::ErrorKind::NotFound => state = "partial",
            Err(_) => {}
        }
    }
    let mut catalog = scope.catalog.lock().unwrap();
    catalog.dirs.retain(|dir, _| visited.contains(dir));
    catalog.checked = Some(Instant::now());
    catalog.state = state;
    catalog.running = false;
}

fn expand(raw: &str, home: &Path) -> Option<PathBuf> {
    if raw == "~" {
        return Some(home.to_owned());
    }
    if let Some(path) = raw.strip_prefix("~/") {
        return Some(home.join(path));
    }
    Path::new(raw).is_absolute().then(|| PathBuf::from(raw))
}

fn collect(query: String, roots: Vec<String>) -> Result<SearchResult, String> {
    let home = std::env::home_dir().ok_or("Home folder unavailable")?;
    let needle = query.trim().to_lowercase();
    let mut matches = BTreeSet::new();
    let mut scopes = Vec::new();
    let active = {
        let mut active = SCOPES.lock().unwrap();
        active.retain(|key, scope| {
            let keep = roots.contains(key);
            if !keep {
                scope.cancelled.store(true, Ordering::Relaxed);
            }
            keep
        });
        roots
            .into_iter()
            .map(|root| {
                let scope = active.entry(root.clone()).or_default().clone();
                (root, scope)
            })
            .collect::<Vec<_>>()
    };
    for (key, scope) in active {
        let Some(root) = expand(&key, &home) else {
            continue;
        };
        let meta = fs::metadata(&root);
        let mut catalog = scope.catalog.lock().unwrap();
        if let Err(err) = meta {
            catalog.dirs.clear();
            catalog.checked = None;
            scopes.push(ScopeStatus {
                root: key,
                state: failure(&err).into(),
            });
            continue;
        }
        let changed = catalog
            .dirs
            .get(&root)
            .is_some_and(|d| meta.as_ref().ok().and_then(|m| m.modified().ok()) != d.modified);
        if !catalog.running
            && (changed
                || catalog
                    .checked
                    .is_none_or(|at| at.elapsed() >= Duration::from_secs(30)))
        {
            catalog.running = true;
            let worker = scope.clone();
            let root = root.clone();
            let remainder = key == "~";
            std::thread::spawn(move || scan(&worker, &root, remainder));
        }
        let state = if catalog.running {
            "indexing"
        } else {
            catalog.state
        };
        scopes.push(ScopeStatus {
            root: key,
            state: state.into(),
        });
        if needle.is_empty() {
            continue;
        }
        let listings: Vec<_> = catalog
            .dirs
            .iter()
            .map(|(dir, list)| (dir.clone(), list.clone()))
            .collect();
        drop(catalog);
        for (dir, list) in listings {
            for item in &list.entries {
                if !item.lower.contains(&needle) {
                    continue;
                }
                let rank = if item.lower == needle {
                    0
                } else if item.lower.starts_with(&needle) {
                    1
                } else {
                    2
                };
                let path = dir.join(&item.name);
                let score = (rank, item.lower.as_str(), &path);
                if matches.len() >= 6
                    && matches
                        .last()
                        .is_some_and(|(r, n, p): &(u8, String, PathBuf)| {
                            (*r, n.as_str(), p) <= score
                        })
                {
                    continue;
                }
                if path.symlink_metadata().is_err() {
                    continue;
                }
                matches.insert((rank, item.lower.clone(), path));
                if matches.len() > 6 {
                    matches.pop_last();
                }
            }
        }
    }
    let mut volumes = Vec::new();
    if let Ok(entries) = fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                volumes.push(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    volumes.sort();
    Ok(SearchResult {
        paths: matches
            .into_iter()
            .map(|(_, _, p)| p.to_string_lossy().into_owned())
            .collect(),
        scopes,
        volumes,
    })
}

pub async fn search(query: String, roots: Vec<String>) -> Result<SearchResult, String> {
    tokio::task::spawn_blocking(move || collect(query, roots))
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settled(query: &str, roots: &[String]) -> SearchResult {
        let start = Instant::now();
        loop {
            let result = collect(query.into(), roots.to_vec()).unwrap();
            if !result.scopes.iter().any(|scope| scope.state == "indexing") {
                return result;
            }
            assert!(start.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn scoped_catalog_matches_nested_names_and_handles_volume_reconnects() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Drive");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        for name in ["周报.pdf", "旧周报.txt", ".周报"] {
            fs::write(nested.join(name), []).unwrap();
        }
        let hidden = root.join(".archive");
        fs::create_dir(&hidden).unwrap();
        fs::write(hidden.join("周报"), []).unwrap();
        let key = root.to_string_lossy().into_owned();
        let roots = vec![key.clone(), nested.to_string_lossy().into_owned()];
        let found = settled("周", &roots);
        assert_eq!(
            found.paths,
            ["周报.pdf", "旧周报.txt"].map(|n| nested.join(n).to_string_lossy().into_owned())
        );
        assert_eq!(
            settled("周", &[hidden.to_string_lossy().into_owned()])
                .paths
                .len(),
            1
        );
        assert!(settled("周", &[]).paths.is_empty());
        let away = temp.path().join("unmounted");
        fs::rename(&root, &away).unwrap();
        let missing = settled("周", std::slice::from_ref(&key));
        assert_eq!(missing.scopes[0].state, "missing");
        assert!(missing.paths.is_empty());
        fs::rename(away, &root).unwrap();
        assert_eq!(settled("周", std::slice::from_ref(&key)).paths.len(), 2);
        fs::write(root.join("Report.PDF"), []).unwrap();
        assert_eq!(settled("port", &[key]).paths.len(), 1);
    }

    #[test]
    fn home_remainder_excludes_independently_selectable_and_private_folders() {
        let temp = tempfile::tempdir().unwrap();
        for name in [
            "Downloads",
            "Desktop",
            "Documents",
            "Library",
            ".hidden",
            "Projects",
        ] {
            fs::create_dir(temp.path().join(name)).unwrap();
        }
        let list = read_listing(temp.path(), true).unwrap();
        assert_eq!(
            list.entries.iter().map(|e| &e.name).collect::<Vec<_>>(),
            ["Projects"]
        );
    }
}
