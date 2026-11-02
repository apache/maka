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

//! Temporary source snapshots. No repository cache or second skill library is retained.
use maka_agent_facts::shell_run::PipeStream;
use maka_capabilities::call::Scope;
use maka_skills_api::contract::{DiscoveredSource, SourceSkill, SourceSnapshot};
use std::path::{Component, Path, PathBuf};

pub(super) struct Checkout {
    pub source: SourceSnapshot,
    pub root: PathBuf,
    _temporary: Option<tempfile::TempDir>,
}

pub(super) fn relative(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("Source directory must stay inside the selected repository".into());
    }
    Ok(path.to_owned())
}

pub(super) fn read_manifest(directory: &cap_std::fs::Dir) -> std::io::Result<String> {
    use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
    use std::io::Read;
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = directory.open_with("SKILL.md", &options)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other("SKILL.md must be an ordinary file"));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

async fn git(
    cwd: &Path,
    args: &[&str],
    route: &maka_network::Policy,
    scope: &Scope,
) -> Result<String, String> {
    let executable = which::which("git").map_err(|error| format!("Git is unavailable: {error}"))?;
    let mut command = maka_process::Command::new(executable, cwd).network_route(route.clone());
    command.env("GIT_TERMINAL_PROMPT", "0");
    for arg in args {
        command.arg(arg);
    }
    let mut process = command
        .observe(None, scope.cancellation.clone())
        .map_err(|error| error.to_string())?;
    let mut ticket = scope
        .resources
        .reserve()
        .map_err(|error| error.to_string())?;
    ticket.start();
    let mut stdout = Vec::new();
    let mut receiving = true;
    let result = loop {
        tokio::select! {
            result = &mut process.completion => break result,
            event = process.events.recv(), if receiving => match event {
                Some(maka_process::PipeEvent::Output { stream: PipeStream::Stdout, bytes }) => stdout.extend(bytes),
                None => receiving = false,
                _ => {},
            }
        }
    };
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            let cleanup =
                if let maka_agent_facts::tools::ToolError::CleanupUnconfirmed(message) = &error {
                    Err(message.clone())
                } else {
                    Ok(())
                };
            ticket.complete(cleanup);
            return Err(error.to_string());
        }
    };
    while let Some(event) = process.events.recv().await {
        if let maka_process::PipeEvent::Output {
            stream: PipeStream::Stdout,
            bytes,
        } = event
        {
            stdout.extend(bytes);
        }
    }
    ticket.complete(Ok(()));
    match result.outcome {
        maka_process::ProcessOutcome::Exited(status) if status.success() => {
            String::from_utf8(stdout).map_err(|error| error.to_string())
        }
        maka_process::ProcessOutcome::Exited(_) => {
            Err(format!("Git failed: {}", result.stderr.trim()))
        }
        maka_process::ProcessOutcome::Interrupted { .. } => {
            Err("Skill source operation cancelled".into())
        }
    }
}

impl Checkout {
    pub async fn open(
        source: SourceSnapshot,
        latest: bool,
        route: &maka_network::Policy,
        scope: &Scope,
    ) -> Result<Self, String> {
        match source {
            SourceSnapshot::Directory { path } => {
                let root = std::fs::canonicalize(&path).map_err(|error| error.to_string())?;
                if !root.is_dir() {
                    return Err("Skill source is not a directory".into());
                }
                Ok(Self {
                    source: SourceSnapshot::Directory {
                        path: root.to_string_lossy().into_owned(),
                    },
                    root,
                    _temporary: None,
                })
            }
            SourceSnapshot::Git {
                url,
                reference,
                revision,
            } => {
                let temporary = tempfile::tempdir().map_err(|error| error.to_string())?;
                let mut args = vec!["clone", "--no-checkout", "--depth", "1"];
                let commit_reference = reference.as_deref().filter(|reference| {
                    matches!(reference.len(), 40 | 64)
                        && reference.bytes().all(|byte| byte.is_ascii_hexdigit())
                });
                if let Some(reference) = &reference
                    && commit_reference.is_none()
                {
                    args.extend(["--branch", reference]);
                }
                args.extend(["--", &url, "repository"]);
                git(temporary.path(), &args, route, scope).await?;
                let root = temporary.path().join("repository");
                let commit = if let Some(commit) = commit_reference {
                    git(
                        &root,
                        &["fetch", "--depth", "1", "origin", commit],
                        route,
                        scope,
                    )
                    .await?;
                    commit.to_owned()
                } else if latest || revision.is_empty() {
                    git(&root, &["rev-parse", "HEAD"], route, scope)
                        .await?
                        .trim()
                        .to_owned()
                } else {
                    if !matches!(revision.len(), 40 | 64)
                        || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
                    {
                        return Err("Invalid Git commit".into());
                    }
                    git(
                        &root,
                        &["fetch", "--depth", "1", "origin", &revision],
                        route,
                        scope,
                    )
                    .await?;
                    revision
                };
                git(
                    &root,
                    &["checkout", "--detach", &commit, "--"],
                    route,
                    scope,
                )
                .await?;
                Ok(Self {
                    source: SourceSnapshot::Git {
                        url,
                        reference,
                        revision: commit,
                    },
                    root,
                    _temporary: Some(temporary),
                })
            }
        }
    }

    pub async fn discover(
        input: &str,
        base: &Path,
        private: &Path,
        route: &maka_network::Policy,
        scope: &Scope,
    ) -> Result<DiscoveredSource, String> {
        let input = input.trim();
        if input.is_empty() {
            return Err("Enter a repository or directory".into());
        }
        let local = base.join(input);
        let shorthand =
            !input.contains(':') && !input.starts_with('.') && repository(input).is_ok();
        let (source, subtree) = if local.is_dir() && !shorthand {
            (
                SourceSnapshot::Directory {
                    path: local.to_string_lossy().into_owned(),
                },
                String::new(),
            )
        } else {
            let (url, tree) = repository(input)?;
            let (reference, subtree) = if let Some(tree) = tree {
                let listing = git(
                    base,
                    &["ls-remote", "--heads", "--tags", "--", &url],
                    route,
                    scope,
                )
                .await?;
                let reference = listing
                    .lines()
                    .filter_map(|line| {
                        let (_, name) = line.split_once('\t')?;
                        let name = name
                            .strip_prefix("refs/heads/")
                            .or_else(|| name.strip_prefix("refs/tags/"))?;
                        (tree == name
                            || tree
                                .strip_prefix(name)
                                .is_some_and(|rest| rest.starts_with('/')))
                        .then_some(name)
                    })
                    .max_by_key(|name| name.len())
                    .map(str::to_owned);
                // A tree URL can also pin a commit.
                let reference =
                    reference.unwrap_or_else(|| tree.split('/').next().unwrap_or("").into());
                let subtree = tree
                    .strip_prefix(&reference)
                    .unwrap_or("")
                    .trim_start_matches('/')
                    .to_owned();
                (Some(reference), subtree)
            } else {
                (None, String::new())
            };
            (
                SourceSnapshot::Git {
                    url,
                    reference,
                    revision: String::new(),
                },
                subtree,
            )
        };
        let checkout = Self::open(source, true, route, scope).await?;
        let start = relative(&subtree)?;
        let root = cap_std::fs::Dir::open_ambient_dir(&checkout.root, cap_std::ambient_authority())
            .map_err(|error| error.to_string())?;
        let mut pending = vec![start];
        let mut skills = Vec::new();
        while let Some(path) = pending.pop() {
            if scope.cancellation.is_cancelled() {
                return Err("Skill discovery cancelled".into());
            }
            let resolved = root
                .canonicalize(if path.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    &path
                })
                .map_err(|error| error.to_string())?;
            if checkout.root.join(&resolved).starts_with(private) {
                continue;
            }
            let directory = root
                .open_dir(if path.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    &path
                })
                .map_err(|error| error.to_string())?;
            match read_manifest(&directory) {
                Ok(text) => {
                    if let Ok(document) = maka_skills::parse(&text) {
                        skills.push(SourceSkill {
                            directory: path
                                .to_string_lossy()
                                .replace(std::path::MAIN_SEPARATOR, "/"),
                            name: document.manifest.name,
                            description: document.manifest.description,
                        });
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
            for entry in directory.entries().map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if entry.file_name() == ".git" {
                    continue;
                }
                if entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_dir()
                {
                    pending.push(path.join(entry.file_name()));
                }
            }
        }
        skills.sort_by(|a, b| a.directory.cmp(&b.directory));
        Ok(DiscoveredSource {
            source: checkout.source.clone(),
            skills,
        })
    }
}

fn repository(input: &str) -> Result<(String, Option<String>), String> {
    if !input.contains("://") && !input.starts_with("git@") {
        let parts: Vec<_> = input.split('/').collect();
        if parts.len() == 2
            && parts.iter().all(|part| {
                !part.is_empty()
                    && part.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
            })
        {
            return Ok((
                format!("https://github.com/{}.git", input.trim_end_matches(".git")),
                None,
            ));
        }
        return Err("Use owner/repository, a Git URL, or an existing Host directory".into());
    }
    if let Ok(mut url) = url::Url::parse(input)
        && url.host_str() == Some("github.com")
    {
        let path = percent_encoding::percent_decode_str(url.path())
            .decode_utf8()
            .map_err(|_| "Source URL path is not UTF-8")?;
        let parts: Vec<_> = path.trim_matches('/').split('/').collect();
        if parts.len() >= 4 && matches!(parts[2], "tree" | "blob") {
            let repository = format!("/{}/{}.git", parts[0], parts[1].trim_end_matches(".git"));
            let end = if parts[2] == "blob" && parts.last() == Some(&"SKILL.md") {
                parts.len() - 1
            } else {
                parts.len()
            };
            let tree = parts[3..end].join("/");
            url.set_path(&repository);
            url.set_query(None);
            url.set_fragment(None);
            return Ok((url.into(), Some(tree)));
        }
    }
    Ok((input.into(), None))
}
