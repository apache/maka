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

use super::*;
use std::sync::Arc;

struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
    private: PathBuf,
    control: PathBuf,
    identity: Observation,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let private = root.join("business-root");
        let control = root.join("control");
        fs::create_dir(&private).unwrap();
        fs::create_dir(&control).unwrap();
        let (root, identity) = crate::directory::capture(&root).unwrap();
        Self {
            temp,
            root,
            private,
            control,
            identity,
        }
    }
    fn open(&self, path: Option<&WorkspacePath>) -> io::Result<Directory> {
        Directory::open(
            &self.root,
            &self.identity,
            &self.private,
            &self.control,
            None,
            path,
            &AtomicBool::new(false),
        )
    }
}
#[test]
fn markdown_paths_refer_to_the_bound_workspace_and_follow_its_read_policy() {
    use crate::path::FileReadPath;
    use maka_sandbox::filesystem::{Access, Policy, Rule};
    let f = Fixture::new();
    let dir = f.open(None).unwrap();
    let file = f.root.join("screen shot.png");
    let path = WorkspacePath::from_bytes(b"screen shot.png").unwrap();
    for spelling in [
        b"./nested/../screen shot.png".as_slice(),
        file.as_os_str().as_encoded_bytes(),
    ] {
        assert_eq!(
            dir.resolve_link(spelling.to_vec(), None).unwrap(),
            FileReadPath::Workspace(path.clone())
        );
    }
    let external = f.temp.path().canonicalize().unwrap().join("outside.png");
    let denied = Policy {
        default: Access::Deny,
        rules: vec![Rule::subtree(&f.root, Access::Read)],
        deny_globs: vec![],
    }
    .compile()
    .unwrap();
    assert!(
        dir.resolve_link(
            external.as_os_str().as_encoded_bytes().into(),
            Some(&denied)
        )
        .is_err()
    );
    assert!(
        dir.read_external_image(&external, Some(&denied), None, &AtomicBool::new(false))
            .is_err()
    );
    assert!(matches!(
        dir.resolve_link(external.as_os_str().as_encoded_bytes().into(), None),
        Ok(FileReadPath::External { .. })
    ));
    assert!(
        dir.resolve_link(
            f.private
                .join("state")
                .as_os_str()
                .as_encoded_bytes()
                .into(),
            None
        )
        .is_err()
    );
}

fn names(page: &FilePage) -> Vec<Vec<u8>> {
    page.entries
        .iter()
        .map(|e| e.path.bytes().unwrap())
        .collect()
}

#[test]
fn bounded_live_pages_preserve_names_and_reject_foreign_directory_cursors() {
    let f = Fixture::new();
    for i in 0..130 {
        fs::write(f.root.join(format!("{i:03}")), "").unwrap();
    }
    let root = f.open(None).unwrap();
    let first = root.list(None, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        names(&first),
        (0..128)
            .map(|i| format!("{i:03}").into_bytes())
            .collect::<Vec<_>>()
    );
    let second = root
        .list(first.next.as_ref(), &AtomicBool::new(false))
        .unwrap();
    assert_eq!(names(&second), vec![b"128".to_vec(), b"129".to_vec()]);
    assert_eq!(second.next, None);
    fs::create_dir(f.root.join("nested")).unwrap();
    let path = WorkspacePath::from_bytes(b"nested").unwrap();
    let nested = f.open(Some(&path)).unwrap();
    assert_eq!(
        nested
            .list(first.next.as_ref(), &AtomicBool::new(false))
            .unwrap_err()
            .to_string(),
        "files_invalid_cursor"
    );
    assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_PAGE_BYTES);
    assert_eq!(
        root.list(None, &AtomicBool::new(true))
            .unwrap_err()
            .to_string(),
        "files_cancelled"
    );
}

#[test]
fn root_rgignore_overrides_nested_gitignore_in_candidate_search() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("src")).unwrap();
    fs::write(f.root.join(".rgignore"), "!keep.cache\n").unwrap();
    fs::write(f.root.join("src/.gitignore"), "*.cache\n").unwrap();
    fs::write(f.root.join("src/keep.cache"), "").unwrap();
    fs::write(f.root.join("src/skip.cache"), "").unwrap();

    let mut paths = Vec::new();
    f.open(None)
        .unwrap()
        .candidates(".cache", &AtomicBool::new(false), |entry| {
            paths.push(entry.path.bytes().unwrap());
            Ok(())
        })
        .unwrap();
    assert_eq!(paths, [b"src/keep.cache".to_vec()]);
}

#[cfg(unix)]
#[test]
fn searches_match_names_shallow_first_and_skip_hidden_or_unreadable_folders() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    fs::create_dir_all(f.root.join("locked/inner")).unwrap();
    fs::create_dir(f.root.join("open")).unwrap();
    fs::create_dir_all(f.root.join(".cache/Downloads")).unwrap();
    fs::create_dir(f.root.join("Downloads")).unwrap();
    fs::write(f.root.join("Downloads/report.pdf"), "").unwrap();
    fs::write(f.root.join("open/download.rs"), "fn open() {}").unwrap();
    fs::write(f.root.join("secret.rs"), "fn secret() {}").unwrap();
    let mode = |path: &str, mode| {
        fs::set_permissions(f.root.join(path), fs::Permissions::from_mode(mode)).unwrap()
    };
    mode("locked", 0o000);
    mode("secret.rs", 0o000);

    let directory = f.open(None).unwrap();
    let mut paths = Vec::new();
    let found = directory.candidates("down", &AtomicBool::new(false), |entry| {
        paths.push(entry.path.bytes().unwrap());
        Ok(())
    });
    let mut hidden_paths = Vec::new();
    let hidden_found = directory.candidates(".cac", &AtomicBool::new(false), |entry| {
        hidden_paths.push(entry.path.bytes().unwrap());
        Ok(())
    });
    let mut texts = Vec::new();
    let visited = directory.visit_text_files(1024, 10, &AtomicBool::new(false), |_, path, _| {
        texts.push(path);
        Ok(true)
    });
    mode("locked", 0o755);
    mode("secret.rs", 0o644);

    found.unwrap();
    hidden_found.unwrap();
    visited.unwrap();
    assert_eq!(paths, [b"Downloads".to_vec(), b"open/download.rs".to_vec()]);
    assert_eq!(hidden_paths, [b".cache".to_vec()]);
    let mut children = Vec::new();
    directory
        .child_candidates("down", &AtomicBool::new(false), |entry| {
            children.push(entry.path.bytes().unwrap());
            Ok(())
        })
        .unwrap();
    assert_eq!(children, [b"Downloads".to_vec()]);
    assert_eq!(texts, ["open/download.rs"]);
}

#[test]
fn home_paths_resolve_inside_workspace_and_reject_outside() {
    let home = Fixture::new();
    fs::create_dir(home.root.join("Downloads")).unwrap();
    let home_dir = home.open(None).unwrap();

    let tilde = WorkspacePath::from_bytes(b"~").unwrap();
    let downloads = WorkspacePath::from_bytes(b"~/Downloads").unwrap();
    let other_user = WorkspacePath::from_bytes(b"~other").unwrap();
    let plain = WorkspacePath::from_bytes(b"Downloads").unwrap();

    assert!(tilde.is_home());
    assert!(downloads.is_home());
    assert!(!other_user.is_home());
    assert!(!plain.is_home());

    assert_eq!(home_dir.home_path(&tilde, &home.root).unwrap(), None);
    assert_eq!(
        home_dir.home_path(&downloads, &home.root).unwrap(),
        Some(plain)
    );
    assert_eq!(
        home_dir
            .home_path(&other_user, &home.root)
            .unwrap_err()
            .to_string(),
        "files_invalid_path"
    );

    let project_root = home.root.join("project");
    fs::create_dir_all(project_root.join("src")).unwrap();
    let (project_root, project_identity) = crate::directory::capture(&project_root).unwrap();
    let project = Directory::open(
        &project_root,
        &project_identity,
        &home.private,
        &home.control,
        None,
        None,
        &AtomicBool::new(false),
    )
    .unwrap();

    let project_home = WorkspacePath::from_bytes(b"~/project").unwrap();
    let project_src = WorkspacePath::from_bytes(b"~/project/src").unwrap();
    assert_eq!(project.home_path(&project_home, &home.root).unwrap(), None);
    assert_eq!(
        project.home_path(&project_src, &home.root).unwrap(),
        Some(WorkspacePath::from_bytes(b"src").unwrap())
    );
    for outside in [&tilde, &downloads] {
        assert_eq!(
            project
                .home_path(outside, &home.root)
                .unwrap_err()
                .to_string(),
            "files_invalid_path"
        );
    }
}

#[cfg(unix)]
#[test]
fn listing_keeps_hidden_raw_names_and_dangling_links_but_prunes_original_private_roots() {
    use std::os::unix::{ffi::OsStringExt, fs::symlink};
    let f = Fixture::new();
    fs::write(f.root.join(".hidden"), "").unwrap();
    fs::create_dir(f.root.join(".git")).unwrap();
    symlink("missing", f.root.join("dangling")).unwrap();
    #[cfg(target_os = "macos")]
    let raw = b"raw-\\name";
    #[cfg(not(target_os = "macos"))]
    let raw = b"raw-\xff\\name";
    fs::write(f.root.join(std::ffi::OsString::from_vec(raw.to_vec())), "").unwrap();
    let directory = f.open(None).unwrap();
    let page = directory.list(None, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        names(&page),
        vec![b".hidden".to_vec(), b"dangling".to_vec(), raw.to_vec()]
    );
    assert_eq!(
        page.entries.iter().map(|e| e.kind).collect::<Vec<_>>(),
        vec![FileKind::File, FileKind::Symlink, FileKind::File]
    );
    let link = WorkspacePath::from_bytes(b"dangling").unwrap();
    assert!(f.open(Some(&link)).is_err());
    let private = WorkspacePath::from_bytes(b"business-root").unwrap();
    assert_eq!(
        f.open(Some(&private)).err().unwrap().to_string(),
        "files_private"
    );

    fs::create_dir_all(f.root.join("src")).unwrap();
    fs::create_dir_all(f.root.join("src/nested")).unwrap();
    fs::create_dir_all(f.root.join("skipped")).unwrap();
    fs::create_dir_all(f.root.join(".git/info")).unwrap();
    fs::write(f.root.join(".gitignore"), "ignored.rs\n*.cache\nskipped/\n").unwrap();
    fs::write(
        f.root.join(".ignore"),
        format!("#{}\nignored-by-ignore.rs\n", "x".repeat(1024 * 1024)),
    )
    .unwrap();
    fs::write(f.root.join(".rgignore"), "ignored-by-rg.rs\n!keep.cache\n").unwrap();
    fs::write(f.root.join(".git/info/exclude"), "from-exclude.rs\n").unwrap();
    fs::write(f.root.join("src/nested/.gitignore"), "!ignored.rs\n").unwrap();
    for name in [
        "src/visible.rs",
        "src/nested/ignored.rs",
        "src/UPPER.RS",
        "src/ignored.rs",
        "src/ignored-by-ignore.rs",
        "src/ignored-by-rg.rs",
        "src/from-exclude.rs",
        "src/keep.cache",
        "src/skip.cache",
        "skipped/leaked.rs",
        "business-root/private-secret.rs",
        "control/private-control.rs",
    ] {
        fs::write(f.root.join(name), "not read by candidate search").unwrap();
    }
    let outside = f.temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("leaked.rs"), "outside sentinel").unwrap();
    symlink(&outside, f.root.join("linked-directory")).unwrap();
    symlink("src/visible.rs", f.root.join("visible-link.rs")).unwrap();
    let collect = |directory: &Directory, query: &str| {
        let mut entries = Vec::new();
        directory
            .candidates(query, &AtomicBool::new(false), |entry| {
                entries.push(entry);
                Ok(())
            })
            .unwrap();
        entries
    };
    for query in ["", " \t "] {
        assert_eq!(
            collect(&directory, query)
                .into_iter()
                .map(|entry| (entry.path.bytes().unwrap(), entry.kind))
                .collect::<Vec<_>>(),
            vec![
                (b".gitignore".to_vec(), FileKind::File),
                (b".hidden".to_vec(), FileKind::File),
                (b".ignore".to_vec(), FileKind::File),
                (b".rgignore".to_vec(), FileKind::File),
                (b"dangling".to_vec(), FileKind::Symlink),
                (b"linked-directory".to_vec(), FileKind::Symlink),
                (raw.to_vec(), FileKind::File),
                (b"src".to_vec(), FileKind::Directory),
                (b"visible-link.rs".to_vec(), FileKind::Symlink),
            ],
            "an empty search browses root entries without descending into src"
        );
    }
    let candidates = collect(&directory, ".rS");
    assert_eq!(
        candidates
            .iter()
            .map(|entry| (entry.path.bytes().unwrap(), entry.kind))
            .collect::<Vec<_>>(),
        vec![
            (b"visible-link.rs".to_vec(), FileKind::Symlink),
            (b"src/UPPER.RS".to_vec(), FileKind::File),
            (b"src/visible.rs".to_vec(), FileKind::File),
            (b"src/nested/ignored.rs".to_vec(), FileKind::File),
        ]
    );
    for (query, expected) in [
        ("RAW", raw.to_vec()),
        (".cache", b"src/keep.cache".to_vec()),
    ] {
        assert_eq!(
            collect(&directory, query)
                .into_iter()
                .map(|entry| entry.path.bytes().unwrap())
                .collect::<Vec<_>>(),
            vec![expected]
        );
    }
    let source_path = WorkspacePath::from_bytes(b"src").unwrap();
    let source = f.open(Some(&source_path)).unwrap();
    assert_eq!(
        collect(&source, "")
            .into_iter()
            .map(|entry| (entry.path.bytes().unwrap(), entry.kind))
            .collect::<Vec<_>>(),
        vec![
            (b"src/UPPER.RS".to_vec(), FileKind::File),
            (b"src/keep.cache".to_vec(), FileKind::File),
            (b"src/nested".to_vec(), FileKind::Directory),
            (b"src/visible.rs".to_vec(), FileKind::File),
        ],
        "browsing a selected directory retains its ancestors' ignore rules"
    );
    assert_eq!(
        collect(&source, "visible")
            .into_iter()
            .map(|entry| entry.path.bytes().unwrap())
            .collect::<Vec<_>>(),
        vec![b"src/visible.rs".to_vec()],
        "a selected directory search cannot return its sibling file link"
    );
    fs::remove_file(f.root.join(".rgignore")).unwrap();
    fs::write(outside.join("unsafe-ignore"), "*.rs\n").unwrap();
    symlink(outside.join("unsafe-ignore"), f.root.join(".rgignore")).unwrap();
    assert_eq!(
        collect(&directory, ".rs")
            .into_iter()
            .map(|entry| entry.path.bytes().unwrap())
            .collect::<Vec<_>>(),
        vec![
            b"visible-link.rs".to_vec(),
            b"src/UPPER.RS".to_vec(),
            b"src/ignored-by-rg.rs".to_vec(),
            b"src/visible.rs".to_vec(),
            b"src/nested/ignored.rs".to_vec(),
        ],
        "an external ignore symlink cannot supply rules"
    );
    assert_eq!(
        directory
            .candidates("", &AtomicBool::new(true), |_| Ok(()))
            .unwrap_err()
            .to_string(),
        "files_cancelled"
    );
}

#[tokio::test]
async fn native_watch_wakes_for_create_and_closes_before_original_custody_is_released() {
    let f = Fixture::new();
    let directory = Arc::new(f.open(None).unwrap());
    let setup = directory.clone();
    let mut watch = tokio::task::spawn_blocking(move || setup.watch())
        .await
        .unwrap()
        .unwrap();
    fs::write(f.root.join("created"), "new\n").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), watch.changed())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        names(&directory.list(None, &AtomicBool::new(false)).unwrap()),
        vec![b"created".to_vec()]
    );
    watch.close().await.unwrap();
    fs::write(f.root.join("after-close"), "closed\n").unwrap();
    assert_eq!(
        names(&directory.list(None, &AtomicBool::new(false)).unwrap()),
        vec![b"after-close".to_vec(), b"created".to_vec()]
    );
}

#[tokio::test]
async fn ancestor_move_wakes_without_reading_the_moved_outside_directory() {
    let f = Fixture::new();
    fs::create_dir_all(f.root.join("parent/target")).unwrap();
    let path = WorkspacePath::from_bytes(b"parent/target").unwrap();
    let directory = Arc::new(f.open(Some(&path)).unwrap());
    let setup = directory.clone();
    let mut watch = tokio::task::spawn_blocking(move || setup.watch())
        .await
        .unwrap()
        .unwrap();
    let moved = f.temp.path().join("outside");
    fs::rename(f.root.join("parent"), &moved).unwrap();
    fs::write(moved.join("target/private-outside"), "outside sentinel\n").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), watch.changed())
        .await
        .unwrap()
        .unwrap();
    let result = directory.list(None, &AtomicBool::new(false));
    watch.close().await.unwrap();
    assert_eq!(result.unwrap_err().to_string(), "files_changed");
}

#[cfg(target_os = "macos")]
#[test]
fn shallow_snapshot_observes_actual_entries_without_native_hints() {
    use std::os::unix::{
        ffi::OsStringExt,
        fs::{MetadataExt, symlink},
    };
    let f = Fixture::new();
    let directory = f.open(None).unwrap();
    let cancel = AtomicBool::new(false);
    let empty = directory.snapshot(&cancel).unwrap();
    assert_eq!(empty.0.len(), 0);
    fs::write(f.private.join("private"), b"private").unwrap();
    fs::write(f.control.join("control"), b"control").unwrap();
    fs::create_dir(f.root.join(".GiT")).unwrap();
    assert_eq!(directory.snapshot(&cancel).unwrap(), empty);
    let raw = std::ffi::OsString::from_vec(b"raw-\\name".to_vec());
    fs::write(f.root.join(&raw), b"first").unwrap();
    let created = directory.snapshot(&cancel).unwrap();
    assert_eq!(
        created.0.keys().cloned().collect::<Vec<_>>(),
        vec![b"raw-\\name".to_vec()]
    );
    fs::write(f.root.join(&raw), b"other").unwrap();
    let updated = directory.snapshot(&cancel).unwrap();
    assert_ne!(updated, created);
    let old_metadata = fs::metadata(f.root.join(&raw)).unwrap();
    fs::write(f.root.join("replacement"), b"other").unwrap();
    std::fs::File::open(f.root.join("replacement"))
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(old_metadata.modified().unwrap()))
        .unwrap();
    fs::rename(f.root.join("replacement"), f.root.join(&raw)).unwrap();
    let replaced_metadata = fs::metadata(f.root.join(&raw)).unwrap();
    assert_eq!(replaced_metadata.len(), old_metadata.len());
    assert_eq!(
        replaced_metadata.modified().unwrap(),
        old_metadata.modified().unwrap()
    );
    assert_ne!(replaced_metadata.ino(), old_metadata.ino());
    assert_ne!(directory.snapshot(&cancel).unwrap(), updated);
    symlink(f.temp.path().join("absent"), f.root.join("link")).unwrap();
    assert_eq!(directory.snapshot(&cancel).unwrap().0.len(), 2);
    fs::remove_file(f.root.join(&raw)).unwrap();
    let removed = directory.snapshot(&cancel).unwrap();
    assert_eq!(
        removed.0.keys().cloned().collect::<Vec<_>>(),
        vec![b"link".to_vec()]
    );
    assert_eq!(directory.snapshot(&cancel).unwrap(), removed);
    cancel.store(true, Ordering::Relaxed);
    assert_eq!(
        directory.snapshot(&cancel).unwrap_err().to_string(),
        "files_cancelled"
    );
}
