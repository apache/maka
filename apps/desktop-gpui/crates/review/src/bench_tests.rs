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

//! How long a review takes to read and parse: an ignored test, run by hand
//! in the dev build (`cargo test -p review --locked bench -- --ignored
//! --nocapture`). It measures, for all changes against a base, the list
//! (`read_review`), the patches (every batch, one after another), the
//! panel's preparation (each file cut and parsed as `shown::prepare` does)
//! and the Diff taking the files (`DiffState::set_files`, the one step on
//! the main thread). Two repositories: the one `REVIEW_BENCH_REPO` names,
//! against `REVIEW_BENCH_BASE`, read only (skipped without it), and one it
//! builds under `target/tmp` with `git fast-import` and deletes after:
//! 3,000 files, 20 binary files, a 50 MB generated file, 300 commits and
//! untracked files. `REVIEW_BENCH_BATCHES` prints each patch batch's time.

// Building the repository writes files and runs `git`; the timings block.
#![allow(clippy::disallowed_methods)]

use std::fmt::Write as _;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::component::diff::{DiffFile, DiffState};
use gpui_kit::{AppContext as _, TestAppContext};

use crate::DIFF_LINE_CAP;
use crate::git::{FilePatch, GitRunner, ReviewScope, SystemGit, read_patches, read_review};
use crate::git_tests::{run, scratch};
use crate::shown::{DiffInput, DiffSource, prepare};

/// What one measured read found and how long each step took.
struct Measure {
    files: usize,
    lines: u64,
    commits: usize,
    batches: usize,
    patch_bytes: usize,
    too_large: usize,
    binary: usize,
    list: Duration,
    patches: Duration,
    parse: Duration,
    parsed: Vec<DiffFile>,
}

fn measure(root: &Path, base: &str) -> Measure {
    let git: Arc<dyn GitRunner> = Arc::new(SystemGit);
    let started = Instant::now();
    let snapshot =
        async_io::block_on(read_review(root, Some(base), &ReviewScope::All, git.clone()))
            .expect("a listing");
    let list = started.elapsed();
    let batches = snapshot.patch_batches();
    let started = Instant::now();
    let mut patches = std::collections::HashMap::new();
    for batch in batches.iter().cloned() {
        let (files, at) = (batch.len(), Instant::now());
        patches.extend(async_io::block_on(read_patches(batch, git.clone())).expect("patches"));
        if std::env::var("REVIEW_BENCH_BATCHES").is_ok() {
            println!("  batch of {files}: {:?}", at.elapsed());
        }
    }
    let patches_took = started.elapsed();
    let inputs: Vec<DiffInput> = snapshot
        .files
        .iter()
        .map(|file| DiffInput {
            path: file.path.clone().into(),
            status: file.status,
            source: match patches.get(&file.path) {
                Some(FilePatch::Text(text)) if file.unread_size.is_none() => {
                    DiffSource::Text(text.clone())
                }
                _ => DiffSource::TooLarge,
            },
            whole_text: false,
            more: true,
            step: None,
            cap: DIFF_LINE_CAP,
        })
        .collect();
    let started = Instant::now();
    let parsed: Vec<DiffFile> = inputs.into_iter().map(|input| prepare(input).file).collect();
    let parse = started.elapsed();
    Measure {
        files: snapshot.files.len(),
        lines: u64::from(snapshot.additions) + u64::from(snapshot.deletions),
        commits: snapshot.commits.len(),
        batches: batches.len(),
        patch_bytes: patches
            .values()
            .map(|patch| match patch {
                FilePatch::Text(text) => text.len(),
                _ => 0,
            })
            .sum(),
        too_large: patches.values().filter(|patch| **patch == FilePatch::TooLarge).count(),
        binary: snapshot.files.iter().filter(|file| file.binary).count(),
        list,
        patches: patches_took,
        parse,
        parsed,
    }
}

/// Reports `measure` with the time the Diff took to take its files.
fn report(name: &str, measure: Measure, cx: &mut TestAppContext) {
    let diff = cx.new(|cx| DiffState::new([], cx));
    let started = Instant::now();
    diff.update(cx, |diff, cx| diff.set_files(measure.parsed, cx));
    let install = started.elapsed();
    let mut line = format!("{name}: {} files, {} changed lines", measure.files, measure.lines);
    write!(
        line,
        ", {} commits, {} binary; list {:?}; patches {:?} ({} batches, {:.1} MB, {} too large); \
         parse {:?}; set_files {install:?}",
        measure.commits,
        measure.binary,
        measure.list,
        measure.patches,
        measure.batches,
        measure.patch_bytes as f64 / 1_048_576.,
        measure.too_large,
        measure.parse,
    )
    .ok();
    println!("{line}");
}

#[gpui_kit::test]
#[ignore = "a measurement, run by hand"]
fn bench_reading_a_review(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    if let (Ok(repo), Ok(base)) =
        (std::env::var("REVIEW_BENCH_REPO"), std::env::var("REVIEW_BENCH_BASE"))
    {
        report("worktree", measure(Path::new(&repo), &base), cx);
    }
    let repo = synthetic_repository();
    let measured = measure(&repo, "refs/heads/main");
    std::fs::remove_dir_all(&repo).expect("the synthetic repository is deleted");
    report("synthetic", measured, cx);
}

/// The synthetic branch: on `main`, 3,000 text files in 30 folders and 20
/// binary files; on `feature`, 300 commits each changing ten text files
/// (every file once) and one in ten a binary file, the last adding a 50 MB
/// generated file; then 40 untracked files.
fn synthetic_repository() -> std::path::PathBuf {
    let repo = scratch("bench");
    run(&repo, &["init", "-q", "-b", "main"]);
    let mut stream = Vec::new();
    let text = |ix: usize, version: usize| -> String {
        let mut text = format!("// file {ix}, version {version}\n");
        for line in 0..40 {
            writeln!(text, "fn item_{line}() -> usize {{ {} }}", line * ix).ok();
        }
        for line in 0..version.min(1) * 2 {
            writeln!(text, "fn added_{line}() {{}}").ok();
        }
        text
    };
    let binary = |ix: usize, version: usize| -> Vec<u8> {
        (0..8192u32).map(|n| (n as u8).wrapping_mul(ix as u8 + 1) ^ version as u8).collect()
    };
    let path = |ix: usize| format!("src/mod{:02}/file{ix:04}.rs", ix / 100);
    let put = |stream: &mut Vec<u8>, path: &str, bytes: &[u8]| {
        stream.extend_from_slice(
            format!("M 100644 inline {path}\ndata {}\n", bytes.len()).as_bytes(),
        );
        stream.extend_from_slice(bytes);
        stream.push(b'\n');
    };
    let header = |stream: &mut Vec<u8>, branch: &str, n: usize, message: &str| {
        let when = 1_700_000_000 + n;
        stream.extend_from_slice(
            format!(
                "commit refs/heads/{branch}\nmark :{}\ncommitter Bench <bench@example.invalid> {when} +0000\ndata {}\n{message}\n",
                n + 1,
                message.len()
            )
            .as_bytes(),
        );
    };
    header(&mut stream, "main", 0, "Start");
    for ix in 0..3000 {
        put(&mut stream, &path(ix), text(ix, 0).as_bytes());
    }
    for ix in 0..20 {
        put(&mut stream, &format!("assets/img{ix:02}.png"), &binary(ix, 0));
    }
    for commit in 1..=300 {
        header(&mut stream, "feature", commit, &format!("Change batch {commit}"));
        if commit == 1 {
            stream.extend_from_slice(b"from :1\n");
        }
        for ix in (commit - 1) * 10..commit * 10 {
            put(&mut stream, &path(ix), text(ix, 1).as_bytes());
        }
        if commit % 10 == 0 {
            let ix = commit / 10 % 20;
            put(&mut stream, &format!("assets/img{ix:02}.png"), &binary(ix, commit));
        }
        if commit == 300 {
            let mut big = String::with_capacity(52 * 1024 * 1024);
            let mut n = 0;
            while big.len() < 50 * 1024 * 1024 {
                writeln!(big, "{{\"id\": {n}, \"name\": \"generated row {n}\", \"ok\": true}},")
                    .ok();
                n += 1;
            }
            put(&mut stream, "generated/big.json", big.as_bytes());
        }
    }
    let stream_path = repo.join(".git/bench-stream");
    std::fs::write(&stream_path, &stream).expect("stream");
    drop(stream);
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["fast-import", "--quiet"])
        .stdin(std::fs::File::open(&stream_path).expect("stream"))
        .status()
        .expect("fast-import");
    assert!(status.success(), "fast-import");
    std::fs::remove_file(&stream_path).ok();
    run(&repo, &["checkout", "-q", "-f", "feature"]);
    for ix in 0..40 {
        std::fs::write(repo.join(format!("notes-{ix:02}.md")), format!("note {ix}\n").repeat(20))
            .expect("untracked");
    }
    repo
}
