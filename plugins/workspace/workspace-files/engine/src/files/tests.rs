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
    identity: DirectoryIdentity,
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

#[cfg(unix)]
#[test]
fn listing_keeps_hidden_raw_names_and_dangling_links_but_prunes_original_private_roots() {
    use std::os::unix::{ffi::OsStringExt, fs::symlink};
    let f = Fixture::new();
    fs::write(f.root.join(".hidden"), "").unwrap();
    fs::create_dir(f.root.join(".git")).unwrap();
    fs::write(f.root.join(crate::workspace::MARKER_FILE), "private marker").unwrap();
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
    fs::write(f.root.join(".ignore"), "ignored-by-ignore.rs\n").unwrap();
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
            (b"src/UPPER.RS".to_vec(), FileKind::File),
            (b"src/nested/ignored.rs".to_vec(), FileKind::File),
            (b"src/visible.rs".to_vec(), FileKind::File),
            (b"visible-link.rs".to_vec(), FileKind::Symlink),
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
            b"src/UPPER.RS".to_vec(),
            b"src/ignored-by-rg.rs".to_vec(),
            b"src/nested/ignored.rs".to_vec(),
            b"src/visible.rs".to_vec(),
            b"visible-link.rs".to_vec(),
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
    fs::write(f.root.join(crate::workspace::MARKER_FILE), b"marker").unwrap();
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
