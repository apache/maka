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

//! Logical delta scope and the physical subscriptions needed to cover it.
use super::{
    changes::{generated_directory, ignored, visible_in_workspace},
    *,
};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use notify::RecursiveMode;
use std::{
    ffi::OsStr,
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

pub(super) type Directories = BTreeMap<PathBuf, Dir>;

pub(super) fn host_path(path: &Path) -> io::Result<&Path> {
    maka_fs_tools::workspace::project::host_path(path).map(Path::new)
}

pub(super) fn open_relative(root: &Dir, relative: &Path) -> io::Result<Dir> {
    let mut dir = root.try_clone()?;
    for part in relative.components() {
        let Component::Normal(name) = part else {
            return Err(io::ErrorKind::InvalidInput.into());
        };
        dir = dir.open_dir_nofollow(name)?;
    }
    Ok(dir)
}

pub(super) fn home_child(name: &OsStr) -> bool {
    #[cfg(target_os = "macos")]
    const SYSTEM: &[&str] = &[
        "Library",
        "Applications",
        "Movies",
        "Music",
        "Pictures",
        "Public",
        "Trash",
    ];
    #[cfg(windows)]
    const SYSTEM: &[&str] = &[
        "AppData",
        "Application Data",
        "Local Settings",
        "Contacts",
        "Favorites",
        "Links",
        "Music",
        "Pictures",
        "Saved Games",
        "Searches",
        "Videos",
        "IntelGraphicsProfiles",
    ];
    #[cfg(not(any(windows, target_os = "macos")))]
    const SYSTEM: &[&str] = &["Public", "Templates", "Videos", "Music", "Pictures", "snap"];
    !name.as_encoded_bytes().starts_with(b".")
        && !SYSTEM.iter().any(|n| {
            if cfg!(any(windows, target_os = "macos")) {
                name.eq_ignore_ascii_case(n)
            } else {
                name == *n
            }
        })
}

pub(super) const TAG: &str = "CACHEDIR.TAG";
const SIGNATURE: &[u8; 43] = b"Signature: 8a477f597d28d172789f06886806bc55";

fn cache_tag(dir: &Dir) -> io::Result<bool> {
    if !dir.symlink_metadata(TAG)?.is_file() {
        return Ok(false);
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    cap_std::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NONBLOCK);
    let mut file = dir.open_with(TAG, &options)?;
    let mut prefix = [0; SIGNATURE.len()];
    Ok(file.metadata()?.is_file()
        && match file.read_exact(&mut prefix) {
            Ok(()) => &prefix == SIGNATURE,
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => false,
            Err(e) => return Err(e),
        })
}

#[derive(Clone, Default)]
pub(super) struct CacheTags(BTreeMap<PathBuf, bool>);

impl CacheTags {
    pub(super) fn invalidate(&mut self, path: &Path) {
        if path.file_name().is_some_and(|name| name == TAG) {
            if let Some(parent) = path.parent() {
                self.0.remove(parent);
            }
        } else if self.0.contains_key(path) {
            self.0.retain(|p, _| !p.starts_with(path));
        }
    }

    pub(super) fn source_ignored(&mut self, path: &Path, roots: &Directories) -> bool {
        let Some((root, cap)) = roots.iter().find(|(p, _)| path.starts_with(p)) else {
            return true;
        };
        if path == root {
            return self.ignored(root, roots);
        }
        let parent = path.parent().expect("below root");
        let meta = open_relative(cap, parent.strip_prefix(root).expect("matched root"))
            .and_then(|d| d.symlink_metadata(path.file_name().expect("below root")));
        match meta {
            Ok(m) if m.is_file() => self.ignored(parent, roots),
            Ok(m) if m.is_dir() => self.ignored(path, roots),
            _ => true,
        }
    }

    pub(super) fn ignored(&mut self, dir: &Path, roots: &Directories) -> bool {
        let Some((root, cap)) = roots.iter().find(|(p, _)| dir.starts_with(p)) else {
            return true;
        };
        for ancestor in dir.ancestors().take_while(|p| p.starts_with(root)) {
            if let Some(&blocked) = self.0.get(ancestor) {
                if blocked {
                    return true;
                }
                continue;
            }
            let found = open_relative(cap, ancestor.strip_prefix(root).expect("matched root"))
                .and_then(|dir| cache_tag(&dir));
            let blocked = match found {
                Ok(tagged) => tagged,
                Err(e) if e.kind() == io::ErrorKind::NotFound => false,
                Err(error) => {
                    tracing::debug!(%error, ?ancestor, "Could not check discovery cache tag");
                    true
                }
            };
            if self.0.len() >= 2048 {
                self.0.clear();
            }
            self.0.insert(ancestor.to_owned(), blocked);
            if blocked {
                return true;
            }
        }
        false
    }
}

#[derive(Default)]
pub(super) struct DeltaRoots {
    pub home: Option<PathBuf>,
    pub surveyed_home: bool,
    pub recursive: BTreeSet<PathBuf>,
    pub included: Arc<BTreeSet<PathBuf>>,
    pub excluded: Arc<BTreeSet<PathBuf>>,
    pub private: Vec<PathBuf>,
}

impl DeltaRoots {
    pub(super) fn permits(&self, path: &Path, directory: bool) -> bool {
        let dir = if directory {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        self.in_scope(path, directory) && !self.generated(dir)
    }

    fn generated(&self, path: &Path) -> bool {
        path.ancestors()
            .take_while(|p| !self.recursive.contains(*p) && Some(*p) != self.home.as_deref())
            .any(generated_directory)
    }

    pub(super) fn permits_mapped(&self, path: &Path) -> bool {
        if ignored(path, &self.private) {
            return false;
        }
        // The nearest explicit rule wins. A mapped watch root cannot override an exclusion.
        for ancestor in path.ancestors() {
            if self.excluded.contains(ancestor) {
                return false;
            }
            if self.included.contains(ancestor) {
                return true;
            }
        }
        true
    }

    fn in_scope(&self, path: &Path, directory: bool) -> bool {
        if !self.permits_mapped(path) {
            return false;
        }
        self.recursive.contains(path)
            || visible_in_workspace(path, directory, |p| {
                self.recursive.contains(p)
                    || self.home.as_deref().is_some_and(|home| {
                        p == home
                            && (!self.surveyed_home || path == home || path.parent() == Some(home))
                            && path
                                .strip_prefix(home)
                                .is_ok_and(|rel| rel.iter().next().is_none_or(home_child))
                    })
            })
    }

    pub(super) fn subscriptions<'a>(
        &self,
        roots: &Directories,
        files: impl Iterator<Item = &'a Path>,
        can_read: impl Fn(&Path) -> bool,
    ) -> io::Result<BTreeMap<PathBuf, RecursiveMode>> {
        let mut wanted = BTreeMap::new();
        let mut tags = CacheTags::default();
        let mut subscribe = |path: &Path, mode| {
            if !can_read(path) || !self.in_scope(path, true) {
                return;
            }
            let Some((root, cap)) = roots.iter().find(|(p, _)| path.starts_with(p)) else {
                return;
            };
            // Persisted roots and directory entries can be replaced by symlinks between reloads.
            let relative = path.strip_prefix(root).expect("matched root");
            if let Err(error) = open_relative(cap, relative) {
                // A mapped single file needs its parent to observe atomic replacement.
                if let (Some(parent), Some(name)) = (relative.parent(), relative.file_name())
                    && can_read(&root.join(parent))
                    && open_relative(cap, parent)
                        .and_then(|dir| dir.symlink_metadata(name))
                        .is_ok_and(|m| m.is_file())
                {
                    wanted
                        .entry(root.join(parent))
                        .or_insert(RecursiveMode::NonRecursive);
                    return;
                }
                tracing::debug!(?path, %error, "Skipping unavailable discovery directory");
                return;
            }
            // A tagged root only needs to observe changes to its own marker.
            let mode = if tags.ignored(path, roots) {
                RecursiveMode::NonRecursive
            } else if self.generated(path) {
                return;
            } else {
                mode
            };
            wanted.insert(path.to_owned(), mode);
        };
        if let Some(home) = &self.home
            && can_read(home)
            && self.permits(home, true)
        {
            subscribe(home, RecursiveMode::NonRecursive);
            if !self.surveyed_home {
                let (root, cap) = roots
                    .iter()
                    .find(|(p, _)| home.starts_with(p))
                    .ok_or(io::ErrorKind::PermissionDenied)?;
                let dir = open_relative(cap, home.strip_prefix(root).expect("matched root"))?;
                for entry in dir.entries()? {
                    let entry = entry?;
                    let name = entry.file_name();
                    let path = home.join(&name);
                    if home_child(&name) && can_read(&path) && entry.file_type()?.is_dir() {
                        subscribe(&path, RecursiveMode::Recursive);
                    }
                }
            }
        }
        for path in &self.recursive {
            subscribe(path, RecursiveMode::Recursive);
        }
        for path in files.filter_map(Path::parent) {
            wanted
                .entry(path.to_owned())
                .or_insert(RecursiveMode::NonRecursive);
        }
        let mut minimal = BTreeMap::new();
        for (path, mode) in wanted {
            if !path
                .ancestors()
                .skip(1)
                .any(|p| minimal.get(p) == Some(&RecursiveMode::Recursive))
            {
                minimal.insert(path, mode);
            }
        }
        Ok(minimal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn discovery_home_subscriptions_expand_real_content_and_keep_file_watches_shallow() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        #[cfg(target_os = "macos")]
        let system = ["Library", "Applications", "Pictures"];
        #[cfg(windows)]
        let system = ["AppData", "Application Data", "Pictures"];
        #[cfg(not(any(windows, target_os = "macos")))]
        let system = ["snap", "Templates", "Pictures"];
        let content = home.join("Documents");
        let cache = home.join("build");
        let leaf = home.join(system[0]).join("attachments");
        let guards = home.join(system[0]).join("guards");
        for dir in [
            ".hidden",
            "Media.photoslibrary",
            "Media.musiclibrary",
            "Media.tvlibrary",
            "Documents/notes",
            "build/tmp",
            "skip",
        ]
        .iter()
        .chain(&system)
        {
            fs::create_dir_all(home.join(dir)).unwrap();
        }
        for dir in [&leaf, &guards] {
            fs::create_dir_all(dir).unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&content, home.join("alias")).unwrap();
        fs::write(
            cache.join(TAG),
            [SIGNATURE.as_slice(), b"\n# generated"].concat(),
        )
        .unwrap();
        let cap = Dir::open_ambient_dir(home, cap_std::ambient_authority()).unwrap();
        let caps = [(home.to_owned(), cap)].into();
        let scope = DeltaRoots {
            home: Some(home.to_owned()),
            surveyed_home: false,
            recursive: [leaf.clone(), content.join("notes")].into(),
            included: Arc::new([leaf.clone()].into()),
            excluded: Arc::new([home.join("skip")].into()),
            private: vec![],
        };
        let target = guards.join("guard.txt");
        let wanted = || {
            scope
                .subscriptions(&caps, [target.as_path()].into_iter(), |_| true)
                .unwrap()
        };
        assert_eq!(
            wanted(),
            [
                (home.to_owned(), RecursiveMode::NonRecursive),
                (content, RecursiveMode::Recursive),
                (cache.clone(), RecursiveMode::NonRecursive),
                (leaf.clone(), RecursiveMode::Recursive),
                (guards, RecursiveMode::NonRecursive),
            ]
            .into()
        );
        assert!(scope.permits(&leaf.join("file"), false));
        assert!(!scope.permits(&target, false));
        assert!(!scope.permits(&home.join("skip/old-change"), false));
        fs::create_dir(home.join("NewProject")).unwrap();
        assert_eq!(wanted()[&home.join("NewProject")], RecursiveMode::Recursive);

        let mut tags = CacheTags::default();
        assert!(tags.ignored(&cache.join("tmp"), &caps));
        fs::write(cache.join(TAG), b"an unrelated file").unwrap();
        assert!(tags.ignored(&cache.join("tmp"), &caps));
        tags.invalidate(&cache.join(TAG));
        assert!(!tags.ignored(&cache.join("tmp"), &caps));
        #[cfg(unix)]
        {
            fs::remove_file(cache.join(TAG)).unwrap();
            fs::write(home.join("signature"), SIGNATURE).unwrap();
            std::os::unix::fs::symlink(home.join("signature"), cache.join(TAG)).unwrap();
            tags.invalidate(&cache.join(TAG));
            assert!(!tags.ignored(&cache, &caps));
        }
    }
}
