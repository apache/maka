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

//! Native HTTPS GitHub Pull Request integration using Host network policy.

use super::*;
use maka_capabilities::call::Scope;
use reqwest::{
    Method as HttpMethod, StatusCode, Url,
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderValue},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

const GITHUB_API_VERSION: &str = "2022-11-28";
const GITHUB_ACCEPT: &str = "application/vnd.github+json";
const CLI_TOKEN_TTL: Duration = Duration::from_secs(600);
const MAX_CONFIG_FILE_BYTES: u64 = 64 * 1024;
const MAX_PR_CACHE_ENTRIES: usize = 8;
const MAX_PR_PATCH_BYTES: usize = 2 * 1024 * 1024;
const MAX_GITHUB_JSON_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct GitHubHub {
    manual_tokens: Mutex<BTreeMap<String, Option<String>>>,
    cli_tokens: Mutex<BTreeMap<String, CachedCliToken>>,
    pr_files: Mutex<Vec<CachedPrFiles>>,
    #[cfg(test)]
    base_url_overrides: Mutex<BTreeMap<String, String>>,
}

#[derive(Clone)]
struct CachedCliToken {
    token: Option<String>,
    fetched_at: Instant,
}

#[derive(Clone)]
struct CachedPrFile {
    path: String,
    previous_path: Option<String>,
    status: GitHubPullFileStatus,
    additions: u64,
    deletions: u64,
    digest: String,
    patch: Option<String>,
}

#[derive(Clone)]
struct CachedPrFiles {
    repo: GitHubRepoRef,
    number: u64,
    head_sha: String,
    files: Vec<CachedPrFile>,
}

#[derive(Clone)]
struct ResolvedAuth {
    host: String,
    token: Option<String>,
    source: Option<GitHubTokenSource>,
}

impl ResolvedAuth {
    fn status(&self) -> GitHubAuthStatus {
        GitHubAuthStatus {
            host: self.host.clone(),
            authenticated: self.token.is_some(),
            token_source: self.source,
        }
    }
}

enum ApiFailure {
    Unauthorized(String),
    NotFound,
    Unprocessable(String),
    Other(String),
}

impl GitHubHub {
    #[cfg(test)]
    async fn set_base_url_override(&self, host: &str, base_url: String) {
        self.base_url_overrides
            .lock()
            .await
            .insert(host.to_ascii_lowercase(), base_url);
    }

    async fn api_base_url(&self, host: &str) -> Result<Url, String> {
        #[cfg(test)]
        if let Some(custom) = self.base_url_overrides.lock().await.get(host).cloned() {
            return Url::parse(&custom).map_err(|_| "agent_github_invalid_host".into());
        }
        let raw = if host == "github.com" {
            "https://api.github.com/".to_owned()
        } else {
            format!("https://{host}/api/v3/")
        };
        Url::parse(&raw).map_err(|_| "agent_github_invalid_host".into())
    }

    async fn write_manual_token(
        &self,
        configuration: Option<&ConfigurationStore>,
        host: &str,
        token: Option<String>,
    ) -> Result<(), String> {
        if let Some(store) = configuration {
            let ns = credential_namespace()?;
            let key = credential_key(host);
            for _ in 0..2 {
                let actual = store
                    .plugin_credential(ns.clone(), key.clone())
                    .await
                    .map_err(|e| e.to_string())?
                    .map(|record| record.revision);
                let result = store
                    .write_plugin_credential(
                        ns.clone(),
                        maka_capabilities::credentials::Write {
                            key: key.clone(),
                            expected_revision: actual,
                            secret: token.clone(),
                        },
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                if matches!(
                    result,
                    maka_capabilities::credentials::WriteResult::Written { .. }
                ) {
                    break;
                }
            }
        }
        self.manual_tokens
            .lock()
            .await
            .insert(host.to_owned(), token);
        Ok(())
    }

    async fn invalidate_cli_token(&self, host: &str) {
        self.cli_tokens.lock().await.remove(host);
    }

    async fn resolve_auth(
        &self,
        host: &str,
        configuration: Option<&ConfigurationStore>,
        home: Option<PathBuf>,
    ) -> ResolvedAuth {
        let cached_manual = self.manual_tokens.lock().await.get(host).cloned();
        let manual = match cached_manual {
            Some(value) => value,
            None => {
                let loaded = if let Some(store) = configuration
                    && let Ok(ns) = credential_namespace()
                    && let Ok(record) = store.plugin_credential(ns, credential_key(host)).await
                {
                    record.and_then(|r| r.secret)
                } else {
                    None
                };
                self.manual_tokens
                    .lock()
                    .await
                    .insert(host.to_owned(), loaded.clone());
                loaded
            }
        };
        if let Some(token) = manual {
            return ResolvedAuth {
                host: host.to_owned(),
                token: Some(token),
                source: Some(GitHubTokenSource::Manual),
            };
        }

        let host_owned = host.to_owned();
        let file_or_env = tokio::task::spawn_blocking(move || {
            resolve_env_or_file_token(&host_owned, home.as_deref())
        })
        .await
        .ok()
        .flatten();

        if let Some((token, source)) = file_or_env {
            return ResolvedAuth {
                host: host.to_owned(),
                token: Some(token),
                source: Some(source),
            };
        }

        let cached_cli = {
            let guard = self.cli_tokens.lock().await;
            guard
                .get(host)
                .filter(|entry| entry.fetched_at.elapsed() < CLI_TOKEN_TTL)
                .cloned()
        };
        let cli_token = match cached_cli {
            Some(entry) => entry.token,
            None => {
                let fetched = fetch_gh_cli_token(host).await;
                self.cli_tokens.lock().await.insert(
                    host.to_owned(),
                    CachedCliToken {
                        token: fetched.clone(),
                        fetched_at: Instant::now(),
                    },
                );
                fetched
            }
        };

        match cli_token {
            Some(token) => ResolvedAuth {
                host: host.to_owned(),
                token: Some(token),
                source: Some(GitHubTokenSource::GhCli),
            },
            None => ResolvedAuth {
                host: host.to_owned(),
                token: None,
                source: None,
            },
        }
    }

    async fn cache_pr_files(&self, entry: CachedPrFiles) {
        let mut guard = self.pr_files.lock().await;
        guard.retain(|item| !(item.repo == entry.repo && item.number == entry.number));
        if guard.len() >= MAX_PR_CACHE_ENTRIES {
            guard.remove(0);
        }
        guard.push(entry);
    }

    async fn cached_pr_files(
        &self,
        repo: &GitHubRepoRef,
        number: u64,
        head_sha: Option<&str>,
    ) -> Option<CachedPrFiles> {
        let guard = self.pr_files.lock().await;
        guard
            .iter()
            .find(|item| {
                &item.repo == repo
                    && item.number == number
                    && head_sha.is_none_or(|expected| item.head_sha == expected)
            })
            .cloned()
    }
}

impl Owner {
    pub async fn save_github_token(
        self: &Arc<Self>,
        input: GitHubTokenKey,
        secret: String,
    ) -> Result<GitHubTokenResult, String> {
        let Some(host) = normalize_host(&input.host) else {
            return Err("agent_github_invalid_host".into());
        };
        let trimmed = secret.trim().to_owned();
        if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
            return Ok(GitHubTokenResult::InvalidToken);
        }
        self.github
            .write_manual_token(Some(&self.configuration), &host, Some(trimmed))
            .await?;
        let auth = self
            .github
            .resolve_auth(&host, Some(&self.configuration), self.home.clone())
            .await;
        Ok(GitHubTokenResult::Updated {
            auth: auth.status(),
        })
    }

    pub async fn delete_github_token(
        self: &Arc<Self>,
        input: GitHubTokenKey,
    ) -> Result<GitHubTokenResult, String> {
        let Some(host) = normalize_host(&input.host) else {
            return Err("agent_github_invalid_host".into());
        };
        self.github
            .write_manual_token(Some(&self.configuration), &host, None)
            .await?;
        let auth = self
            .github
            .resolve_auth(&host, Some(&self.configuration), self.home.clone())
            .await;
        Ok(GitHubTokenResult::Updated {
            auth: auth.status(),
        })
    }

    pub async fn github_pull_requests(
        self: &Arc<Self>,
        input: GitHubPullRequestsRead,
        scope: &Scope,
    ) -> Result<GitHubPullRequestsResult, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let (remotes, head_branch) = owner
                    .discover_session_remotes(&input.session_id, &scope)
                    .await?;
                let effective_branch = input.head_branch.or(head_branch);
                let selected_repo = match input.repo {
                    Some(explicit) => Some(match_remote_allowlist(explicit, &remotes)?),
                    None => choose_default_remote(&remotes),
                };
                let Some(repo) = selected_repo else {
                    return Ok(GitHubPullRequestsResult::NoRemote { remotes });
                };
                let auth = owner
                    .github
                    .resolve_auth(&repo.host, Some(&owner.configuration), owner.home.clone())
                    .await;
                let client = owner.github_http_client().await?;

                let state_param = match input.state {
                    GitHubPullStateFilter::Open => "open",
                    GitHubPullStateFilter::Closed => "closed",
                    GitHubPullStateFilter::All => "all",
                };
                let url = owner
                    .github_repo_url(
                        &repo,
                        &["pulls"],
                        &[
                            ("state", state_param),
                            ("sort", "updated"),
                            ("direction", "desc"),
                            ("per_page", "40"),
                        ],
                    )
                    .await?;

                match owner
                    .github_json::<Vec<RawPullSummary>, ()>(
                        &client,
                        HttpMethod::GET,
                        url,
                        &auth,
                        None,
                        &scope,
                    )
                    .await
                {
                    Ok(raw_pulls) => {
                        let pulls: Vec<GitHubPullSummary> =
                            raw_pulls.into_iter().map(into_pull_summary).collect();
                        let current_branch_pr = effective_branch.as_deref().and_then(|branch| {
                            pulls
                                .iter()
                                .find(|pr| pr.state == "open" && pr.head_ref == branch)
                                .or_else(|| pulls.iter().find(|pr| pr.head_ref == branch))
                                .map(|pr| pr.number)
                        });
                        Ok(GitHubPullRequestsResult::Ready {
                            repo,
                            remotes,
                            auth: auth.status(),
                            current_branch_pr,
                            pulls,
                        })
                    }
                    Err(ApiFailure::Unauthorized(message)) => {
                        Ok(GitHubPullRequestsResult::Unauthorized {
                            repo,
                            remotes,
                            auth: auth.status(),
                            message,
                        })
                    }
                    Err(ApiFailure::NotFound) if !auth.status().authenticated => {
                        Ok(GitHubPullRequestsResult::Unauthorized {
                            repo,
                            remotes,
                            auth: auth.status(),
                            message: "Repository not found or requires authentication.".into(),
                        })
                    }
                    Err(ApiFailure::NotFound) => Ok(GitHubPullRequestsResult::Error {
                        repo: Some(repo),
                        remotes,
                        auth: auth.status(),
                        message: "GitHub repository not found.".into(),
                    }),
                    Err(ApiFailure::Unprocessable(message) | ApiFailure::Other(message)) => {
                        Ok(GitHubPullRequestsResult::Error {
                            repo: Some(repo),
                            remotes,
                            auth: auth.status(),
                            message,
                        })
                    }
                }
            })
        })
        .await
    }

    pub async fn github_pull_request_detail(
        self: &Arc<Self>,
        input: GitHubPullDetailRead,
        scope: &Scope,
    ) -> Result<GitHubPullDetailResult, String> {
        if input.number == 0 {
            return Err("agent_github_invalid_input".into());
        }
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let repo = owner
                    .resolve_target_repo(&input.session_id, input.repo, &scope)
                    .await?;
                let auth = owner
                    .github
                    .resolve_auth(&repo.host, Some(&owner.configuration), owner.home.clone())
                    .await;
                let client = owner.github_http_client().await?;
                let num_str = input.number.to_string();

                let pr_url = owner
                    .github_repo_url(&repo, &["pulls", &num_str], &[])
                    .await?;
                let raw_pr: RawPullDetail = match owner
                    .github_json::<RawPullDetail, ()>(
                        &client,
                        HttpMethod::GET,
                        pr_url,
                        &auth,
                        None,
                        &scope,
                    )
                    .await
                {
                    Ok(pr) => pr,
                    Err(ApiFailure::Unauthorized(message)) => {
                        return Ok(GitHubPullDetailResult::Unauthorized {
                            repo,
                            auth: auth.status(),
                            message,
                        });
                    }
                    Err(ApiFailure::NotFound) if !auth.status().authenticated => {
                        return Ok(GitHubPullDetailResult::Unauthorized {
                            repo,
                            auth: auth.status(),
                            message: "Pull request not found or requires authentication.".into(),
                        });
                    }
                    Err(ApiFailure::NotFound) => {
                        return Ok(GitHubPullDetailResult::NotFound {
                            repo,
                            auth: auth.status(),
                            number: input.number,
                        });
                    }
                    Err(ApiFailure::Unprocessable(message) | ApiFailure::Other(message)) => {
                        return Ok(GitHubPullDetailResult::Error {
                            repo: Some(repo),
                            auth: auth.status(),
                            message,
                        });
                    }
                };

                let joined = tokio::try_join!(
                    owner.fetch_pull_files(&client, &repo, input.number, &auth, &scope),
                    owner.fetch_pull_comments(&client, &repo, input.number, &auth, &scope),
                    owner.fetch_pull_reviews(&client, &repo, input.number, &auth, &scope),
                    owner.fetch_issue_comments(&client, &repo, input.number, &auth, &scope),
                )
                .map_err(|failure| match failure {
                    ApiFailure::Unauthorized(m)
                    | ApiFailure::Unprocessable(m)
                    | ApiFailure::Other(m) => m,
                    ApiFailure::NotFound => "Pull request resource not found.".into(),
                });

                let (cached_files, raw_comments, raw_reviews, raw_issue_comments) = match joined {
                    Ok(tuple) => tuple,
                    Err(message) => {
                        return Ok(GitHubPullDetailResult::Error {
                            repo: Some(repo),
                            auth: auth.status(),
                            message,
                        });
                    }
                };

                owner
                    .github
                    .cache_pr_files(CachedPrFiles {
                        repo: repo.clone(),
                        number: input.number,
                        head_sha: raw_pr.head.sha.clone(),
                        files: cached_files.clone(),
                    })
                    .await;

                let patch = if input.include_patch {
                    Some(assemble_combined_pr_patch(&cached_files))
                } else {
                    None
                };

                let files = cached_files
                    .into_iter()
                    .map(|f| GitHubPullFile {
                        path: f.path,
                        previous_path: f.previous_path,
                        status: f.status,
                        additions: f.additions,
                        deletions: f.deletions,
                        digest: f.digest,
                        has_patch: f.patch.is_some(),
                    })
                    .collect();
                let threads = group_review_threads(raw_comments);
                let reviews = raw_reviews
                    .into_iter()
                    .filter(|r| {
                        !r.state.eq_ignore_ascii_case("PENDING")
                            && (!r.body.as_deref().unwrap_or("").trim().is_empty()
                                || !r.state.eq_ignore_ascii_case("COMMENTED"))
                    })
                    .map(|r| GitHubReviewSummary {
                        id: r.id,
                        author: r.user.map_or_else(|| "ghost".into(), |u| u.login),
                        state: r.state,
                        body: r.body.unwrap_or_default(),
                        submitted_at: r.submitted_at.unwrap_or_default(),
                    })
                    .collect();
                let issue_comments = raw_issue_comments
                    .into_iter()
                    .map(|c| GitHubReviewComment {
                        id: c.id,
                        author: c.user.map_or_else(|| "ghost".into(), |u| u.login),
                        body: c.body.unwrap_or_default(),
                        created_at: c.created_at.unwrap_or_default(),
                        html_url: c.html_url.unwrap_or_default(),
                    })
                    .collect();

                Ok(GitHubPullDetailResult::Ready {
                    detail: Box::new(GitHubPullDetail {
                        repo,
                        auth: auth.status(),
                        number: raw_pr.number,
                        title: raw_pr.title,
                        body: raw_pr.body.unwrap_or_default(),
                        state: raw_pr.state,
                        draft: raw_pr.draft.unwrap_or(false),
                        merged: raw_pr.merged.unwrap_or(false),
                        author: raw_pr.user.map_or_else(|| "ghost".into(), |u| u.login),
                        head_ref: raw_pr.head.ref_name,
                        head_sha: raw_pr.head.sha,
                        base_ref: raw_pr.base.ref_name,
                        base_sha: raw_pr.base.sha,
                        additions: raw_pr.additions.unwrap_or(0),
                        deletions: raw_pr.deletions.unwrap_or(0),
                        changed_files: raw_pr.changed_files.unwrap_or(0),
                        html_url: raw_pr.html_url,
                        files,
                        threads,
                        reviews,
                        issue_comments,
                        patch,
                    }),
                })
            })
        })
        .await
    }

    pub async fn github_pull_request_file_diff(
        self: &Arc<Self>,
        input: GitHubPullFileDiffRead,
        scope: &Scope,
    ) -> Result<GitHubPullFileDiff, String> {
        if input.number == 0 || input.path.is_empty() {
            return Err("agent_github_invalid_input".into());
        }
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let repo = owner
                    .resolve_target_repo(&input.session_id, input.repo, &scope)
                    .await?;
                let files = if let Some(cached) = owner
                    .github
                    .cached_pr_files(&repo, input.number, input.head_sha.as_deref())
                    .await
                {
                    cached.files
                } else {
                    let auth = owner
                        .github
                        .resolve_auth(&repo.host, Some(&owner.configuration), owner.home.clone())
                        .await;
                    let client = owner.github_http_client().await?;
                    match owner
                        .fetch_pull_files(&client, &repo, input.number, &auth, &scope)
                        .await
                    {
                        Ok(fetched) => {
                            if let Some(head_sha) = input.head_sha.clone() {
                                owner
                                    .github
                                    .cache_pr_files(CachedPrFiles {
                                        repo: repo.clone(),
                                        number: input.number,
                                        head_sha,
                                        files: fetched.clone(),
                                    })
                                    .await;
                            }
                            fetched
                        }
                        Err(_) => return Ok(GitHubPullFileDiff::NotFound),
                    }
                };

                let Some(entry) = files.into_iter().find(|f| f.path == input.path) else {
                    return Ok(GitHubPullFileDiff::NotFound);
                };

                // Fast-path: when both base.sha and head.sha exist in the local Git object store,
                // compute three-dot merge-base(base.sha, head.sha)..head.sha and resolve previous_path
                // on renames so full before/after texts match GitHub's PR diff semantics.
                if let (Some(base_sha), Some(head_sha)) =
                    (input.base_sha.as_deref(), input.head_sha.as_deref())
                    && is_hex_oid(base_sha)
                    && is_hex_oid(head_sha)
                    && let Ok(ws_path) = WorkspacePath::from_bytes(entry.path.as_bytes())
                {
                    let ws_prev = match entry.previous_path.as_deref() {
                        Some(prev) => WorkspacePath::from_bytes(prev.as_bytes()).ok(),
                        None => None,
                    };
                    let prev_ok = entry.previous_path.is_none() || ws_prev.is_some();
                    if prev_ok {
                        let base_owned = base_sha.to_owned();
                        let head_owned = head_sha.to_owned();
                        if let Ok(Some(local_diff)) = owner
                            .read_git(
                                &input.session_id,
                                &scope,
                                move |workspace, observed, private_root, cancel| {
                                    maka_fs_tools::git::merge_base_file_diff(
                                        Path::new(&workspace.path),
                                        observed,
                                        private_root,
                                        workspace.worktree.as_deref(),
                                        &base_owned,
                                        &head_owned,
                                        &ws_path,
                                        ws_prev.as_ref(),
                                        cancel,
                                    )
                                },
                            )
                            .await
                        {
                            match local_diff {
                                GitDiff::Text {
                                    patch: local_patch,
                                    before,
                                    after,
                                    ..
                                } => {
                                    let patch = match entry.patch.as_deref() {
                                        Some(raw_hunks) => format_github_file_patch(
                                            &entry.path,
                                            entry.previous_path.as_deref(),
                                            entry.status,
                                            Some(raw_hunks),
                                        ),
                                        None => local_patch,
                                    };
                                    return Ok(GitHubPullFileDiff::Full {
                                        patch,
                                        before,
                                        after,
                                        digest: entry.digest,
                                    });
                                }
                                GitDiff::Binary => return Ok(GitHubPullFileDiff::Binary),
                                GitDiff::Unchanged | GitDiff::Unsupported => {}
                            }
                        }
                    }
                }

                match entry.patch.as_deref() {
                    Some(raw_hunks) => Ok(GitHubPullFileDiff::PatchOnly {
                        patch: format_github_file_patch(
                            &entry.path,
                            entry.previous_path.as_deref(),
                            entry.status,
                            Some(raw_hunks),
                        ),
                        digest: entry.digest,
                    }),
                    None if entry.status == GitHubPullFileStatus::Renamed
                        && entry.additions == 0
                        && entry.deletions == 0 =>
                    {
                        Ok(GitHubPullFileDiff::PatchOnly {
                            patch: format_github_file_patch(
                                &entry.path,
                                entry.previous_path.as_deref(),
                                entry.status,
                                None,
                            ),
                            digest: entry.digest,
                        })
                    }
                    None if entry.additions == 0 && entry.deletions == 0 => {
                        Ok(GitHubPullFileDiff::Binary)
                    }
                    None => Ok(GitHubPullFileDiff::Large),
                }
            })
        })
        .await
    }

    pub async fn github_submit_review(
        self: &Arc<Self>,
        input: GitHubSubmitReviewInput,
        scope: &Scope,
    ) -> Result<GitHubSubmitReviewResult, String> {
        if input.number == 0 || input.expected_head_sha.trim().is_empty() {
            return Err("agent_github_invalid_input".into());
        }
        let trimmed_body = input.body.trim().to_owned();
        if input.event == GitHubReviewEvent::RequestChanges && trimmed_body.is_empty() {
            return Ok(GitHubSubmitReviewResult::Rejected {
                message: "Requesting changes requires a summary comment.".into(),
            });
        }
        if input.event == GitHubReviewEvent::Comment
            && trimmed_body.is_empty()
            && input.comments.is_empty()
        {
            return Ok(GitHubSubmitReviewResult::Rejected {
                message: "Add a review summary or at least one inline comment before submitting."
                    .into(),
            });
        }

        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let repo = owner
                    .resolve_target_repo(&input.session_id, input.repo, &scope)
                    .await?;
                let auth = owner
                    .github
                    .resolve_auth(&repo.host, Some(&owner.configuration), owner.home.clone())
                    .await;
                if !auth.status().authenticated {
                    return Ok(GitHubSubmitReviewResult::Unauthorized {
                        message: "Configure a GitHub token to submit pull request reviews.".into(),
                    });
                }
                let client = owner.github_http_client().await?;
                let num_str = input.number.to_string();

                // Verify PR head commit has not moved before posting line comments.
                let pr_url = owner
                    .github_repo_url(&repo, &["pulls", &num_str], &[])
                    .await?;
                let live_pr: RawPullDetail = match owner
                    .github_json::<RawPullDetail, ()>(
                        &client,
                        HttpMethod::GET,
                        pr_url,
                        &auth,
                        None,
                        &scope,
                    )
                    .await
                {
                    Ok(pr) => pr,
                    Err(ApiFailure::Unauthorized(message)) => {
                        return Ok(GitHubSubmitReviewResult::Unauthorized { message });
                    }
                    Err(ApiFailure::NotFound) => {
                        return Ok(GitHubSubmitReviewResult::Rejected {
                            message: "Pull request not found.".into(),
                        });
                    }
                    Err(ApiFailure::Unprocessable(message) | ApiFailure::Other(message)) => {
                        return Ok(GitHubSubmitReviewResult::Rejected { message });
                    }
                };

                if !live_pr
                    .head
                    .sha
                    .eq_ignore_ascii_case(input.expected_head_sha.trim())
                {
                    return Ok(GitHubSubmitReviewResult::StaleHead {
                        actual_head_sha: live_pr.head.sha,
                    });
                }

                let event_wire = match input.event {
                    GitHubReviewEvent::Comment => "COMMENT",
                    GitHubReviewEvent::Approve => "APPROVE",
                    GitHubReviewEvent::RequestChanges => "REQUEST_CHANGES",
                };
                let comments: Vec<WireDraftComment> = input
                    .comments
                    .into_iter()
                    .filter(|c| !c.body.trim().is_empty() && c.line > 0)
                    .map(|c| {
                        let multi = c.start_line.filter(|&start| start > 0 && start < c.line);
                        WireDraftComment {
                            path: c.path,
                            side: match c.side {
                                GitHubDiffSide::Left => "LEFT",
                                GitHubDiffSide::Right => "RIGHT",
                            },
                            line: c.line,
                            start_line: multi,
                            start_side: multi.map(|_| match c.start_side.unwrap_or(c.side) {
                                GitHubDiffSide::Left => "LEFT",
                                GitHubDiffSide::Right => "RIGHT",
                            }),
                            body: c.body,
                        }
                    })
                    .collect();

                let payload = WireSubmitReview {
                    commit_id: input.expected_head_sha.trim().to_owned(),
                    event: event_wire,
                    body: (!trimmed_body.is_empty()).then_some(trimmed_body),
                    comments,
                };
                let submit_url = owner
                    .github_repo_url(&repo, &["pulls", &num_str, "reviews"], &[])
                    .await?;
                match owner
                    .github_json::<RawSubmittedReview, WireSubmitReview>(
                        &client,
                        HttpMethod::POST,
                        submit_url,
                        &auth,
                        Some(&payload),
                        &scope,
                    )
                    .await
                {
                    Ok(submitted) => Ok(GitHubSubmitReviewResult::Submitted {
                        review_id: submitted.id,
                        state: submitted.state,
                        html_url: submitted.html_url.unwrap_or_default(),
                    }),
                    Err(ApiFailure::Unauthorized(message)) => {
                        Ok(GitHubSubmitReviewResult::Unauthorized { message })
                    }
                    Err(ApiFailure::NotFound) => Ok(GitHubSubmitReviewResult::Rejected {
                        message: "Pull request review endpoint not found or lacks permission."
                            .into(),
                    }),
                    Err(ApiFailure::Unprocessable(message) | ApiFailure::Other(message)) => {
                        Ok(GitHubSubmitReviewResult::Rejected { message })
                    }
                }
            })
        })
        .await
    }

    pub async fn github_reply_comment(
        self: &Arc<Self>,
        input: GitHubReplyCommentInput,
        scope: &Scope,
    ) -> Result<GitHubReplyCommentResult, String> {
        let trimmed = input.body.trim().to_owned();
        if input.number == 0 || input.comment_id == 0 || trimmed.is_empty() {
            return Err("agent_github_invalid_input".into());
        }
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let repo = owner
                    .resolve_target_repo(&input.session_id, input.repo, &scope)
                    .await?;
                let auth = owner
                    .github
                    .resolve_auth(&repo.host, Some(&owner.configuration), owner.home.clone())
                    .await;
                if !auth.status().authenticated {
                    return Ok(GitHubReplyCommentResult::Unauthorized {
                        message: "Configure a GitHub token to reply to review threads.".into(),
                    });
                }
                let client = owner.github_http_client().await?;
                let num_str = input.number.to_string();
                let cid_str = input.comment_id.to_string();
                let url = owner
                    .github_repo_url(
                        &repo,
                        &["pulls", &num_str, "comments", &cid_str, "replies"],
                        &[],
                    )
                    .await?;
                let payload = WireReplyBody { body: trimmed };
                match owner
                    .github_json::<RawPullComment, WireReplyBody>(
                        &client,
                        HttpMethod::POST,
                        url,
                        &auth,
                        Some(&payload),
                        &scope,
                    )
                    .await
                {
                    Ok(raw) => Ok(GitHubReplyCommentResult::Replied {
                        comment: GitHubReviewComment {
                            id: raw.id,
                            author: raw.user.map_or_else(|| "ghost".into(), |u| u.login),
                            body: raw.body.unwrap_or_default(),
                            created_at: raw.created_at.unwrap_or_default(),
                            html_url: raw.html_url.unwrap_or_default(),
                        },
                    }),
                    Err(ApiFailure::Unauthorized(message)) => {
                        Ok(GitHubReplyCommentResult::Unauthorized { message })
                    }
                    Err(ApiFailure::NotFound) => Ok(GitHubReplyCommentResult::Rejected {
                        message: "Review thread not found or lacks write permission.".into(),
                    }),
                    Err(ApiFailure::Unprocessable(message) | ApiFailure::Other(message)) => {
                        Ok(GitHubReplyCommentResult::Rejected { message })
                    }
                }
            })
        })
        .await
    }

    pub async fn github_comment_pull_request(
        self: &Arc<Self>,
        input: GitHubIssueCommentInput,
        scope: &Scope,
    ) -> Result<GitHubReplyCommentResult, String> {
        let trimmed = input.body.trim().to_owned();
        if input.number == 0 || trimmed.is_empty() {
            return Err("agent_github_invalid_input".into());
        }
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let repo = owner
                    .resolve_target_repo(&input.session_id, input.repo, &scope)
                    .await?;
                let auth = owner
                    .github
                    .resolve_auth(&repo.host, Some(&owner.configuration), owner.home.clone())
                    .await;
                if !auth.status().authenticated {
                    return Ok(GitHubReplyCommentResult::Unauthorized {
                        message: "Configure a GitHub token to comment on pull requests.".into(),
                    });
                }
                let client = owner.github_http_client().await?;
                let num_str = input.number.to_string();
                let url = owner
                    .github_repo_url(&repo, &["issues", &num_str, "comments"], &[])
                    .await?;
                let payload = WireReplyBody { body: trimmed };
                match owner
                    .github_json::<RawPullComment, WireReplyBody>(
                        &client,
                        HttpMethod::POST,
                        url,
                        &auth,
                        Some(&payload),
                        &scope,
                    )
                    .await
                {
                    Ok(raw) => Ok(GitHubReplyCommentResult::Replied {
                        comment: GitHubReviewComment {
                            id: raw.id,
                            author: raw.user.map_or_else(|| "ghost".into(), |u| u.login),
                            body: raw.body.unwrap_or_default(),
                            created_at: raw.created_at.unwrap_or_default(),
                            html_url: raw.html_url.unwrap_or_default(),
                        },
                    }),
                    Err(ApiFailure::Unauthorized(message)) => {
                        Ok(GitHubReplyCommentResult::Unauthorized { message })
                    }
                    Err(ApiFailure::NotFound) => Ok(GitHubReplyCommentResult::Rejected {
                        message: "Pull request not found or lacks write permission.".into(),
                    }),
                    Err(ApiFailure::Unprocessable(message) | ApiFailure::Other(message)) => {
                        Ok(GitHubReplyCommentResult::Rejected { message })
                    }
                }
            })
        })
        .await
    }

    async fn discover_session_remotes(
        &self,
        session_id: &str,
        scope: &Scope,
    ) -> Result<(Vec<GitHubRepoRef>, Option<String>), String> {
        let rev = self
            .read_git(
                session_id,
                scope,
                |workspace, observed, private_root, cancel| {
                    maka_fs_tools::git::revisions(
                        Path::new(&workspace.path),
                        observed,
                        private_root,
                        workspace.worktree.as_deref(),
                        cancel,
                    )
                },
            )
            .await?;
        let Some(rev) = rev else {
            return Ok((Vec::new(), None));
        };
        let remotes = rev
            .remotes
            .into_iter()
            .map(|r| GitHubRepoRef {
                host: r.host,
                owner: r.owner,
                repo: r.repo,
            })
            .collect();
        Ok((remotes, rev.head_branch))
    }

    async fn resolve_target_repo(
        &self,
        session_id: &str,
        explicit: Option<GitHubRepoRef>,
        scope: &Scope,
    ) -> Result<GitHubRepoRef, String> {
        let (remotes, _) = self.discover_session_remotes(session_id, scope).await?;
        if let Some(repo) = explicit {
            return match_remote_allowlist(repo, &remotes);
        }
        choose_default_remote(&remotes).ok_or_else(|| "agent_github_no_remote".into())
    }

    async fn github_http_client(&self) -> Result<reqwest::Client, String> {
        let network = self
            .configuration
            .network_configuration()
            .await
            .map_err(|_| "agent_github_network_unavailable".to_owned())?;
        let policy =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|_| "agent_github_network_invalid".to_owned())?;
        policy
            .client_builder()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.stop();
                }
                let Some(origin) = attempt.previous().first() else {
                    return attempt.stop();
                };
                let target = attempt.url();
                if target.scheme() == origin.scheme()
                    && target.host_str() == origin.host_str()
                    && target.port_or_known_default() == origin.port_or_known_default()
                {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .timeout(Duration::from_secs(20))
            .user_agent("Maka-Workbench")
            .build()
            .map_err(|_| "agent_github_client_unavailable".to_owned())
    }

    async fn github_repo_url(
        &self,
        repo: &GitHubRepoRef,
        tail: &[&str],
        query: &[(&str, &str)],
    ) -> Result<Url, String> {
        let mut url = self.github.api_base_url(&repo.host).await?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|()| "agent_github_invalid_host".to_owned())?;
            segments.pop_if_empty();
            segments.extend(["repos", repo.owner.as_str(), repo.repo.as_str()]);
            segments.extend(tail.iter().copied());
        }
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (k, v) in query {
                pairs.append_pair(k, v);
            }
        }
        Ok(url)
    }

    async fn github_json<T: DeserializeOwned, B: Serialize>(
        &self,
        client: &reqwest::Client,
        method: HttpMethod,
        url: Url,
        auth: &ResolvedAuth,
        body: Option<&B>,
        scope: &Scope,
    ) -> Result<T, ApiFailure> {
        let mut req = client
            .request(method, url)
            .header(ACCEPT, HeaderValue::from_static(GITHUB_ACCEPT))
            .header(
                "X-GitHub-Api-Version",
                HeaderValue::from_static(GITHUB_API_VERSION),
            );
        if let Some(token) = auth.token.as_deref()
            && let Ok(val) = HeaderValue::from_str(&format!("Bearer {token}"))
        {
            req = req.header(AUTHORIZATION, val);
        }
        if let Some(payload) = body {
            let encoded = serde_json::to_vec(payload)
                .map_err(|e| ApiFailure::Other(format!("Failed to serialize request: {e}")))?;
            req = req
                .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
                .body(encoded);
        }

        let response = tokio::select! {
            biased;
            () = scope.cancellation.cancelled() => {
                return Err(ApiFailure::Other("Request cancelled.".into()));
            }
            () = self.stop.cancelled() => {
                return Err(ApiFailure::Other("Host shutting down.".into()));
            }
            res = req.send() => res.map_err(|e| ApiFailure::Other(format!("Network request failed: {e}")))?,
        };

        let status = response.status();
        if response
            .content_length()
            .is_some_and(|len| len > MAX_GITHUB_JSON_BYTES as u64)
        {
            return Err(ApiFailure::Other(
                "GitHub API response exceeded size limit.".into(),
            ));
        }
        let mut response = response;
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! {
                biased;
                () = scope.cancellation.cancelled() => {
                    return Err(ApiFailure::Other("Request cancelled.".into()));
                }
                () = self.stop.cancelled() => {
                    return Err(ApiFailure::Other("Host shutting down.".into()));
                }
                res = response.chunk() => res.map_err(|e| ApiFailure::Other(format!("Failed reading response: {e}")))?,
            };
            let Some(chunk) = chunk else { break };
            if bytes.len().saturating_add(chunk.len()) > MAX_GITHUB_JSON_BYTES {
                return Err(ApiFailure::Other(
                    "GitHub API response exceeded size limit.".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }

        if status.is_success() {
            return serde_json::from_slice::<T>(&bytes)
                .map_err(|e| ApiFailure::Other(format!("Invalid GitHub JSON response: {e}")));
        }

        let api_message = extract_github_error_message(&bytes)
            .unwrap_or_else(|| format!("GitHub API returned HTTP {}.", status.as_u16()));

        match status {
            StatusCode::UNAUTHORIZED => {
                if auth.source == Some(GitHubTokenSource::GhCli) {
                    self.github.invalidate_cli_token(&auth.host).await;
                }
                Err(ApiFailure::Unauthorized(api_message))
            }
            StatusCode::FORBIDDEN => {
                if !auth.status().authenticated
                    || api_message.to_ascii_lowercase().contains("rate limit")
                {
                    Err(ApiFailure::Unauthorized(api_message))
                } else {
                    Err(ApiFailure::Other(api_message))
                }
            }
            StatusCode::NOT_FOUND => Err(ApiFailure::NotFound),
            StatusCode::UNPROCESSABLE_ENTITY => Err(ApiFailure::Unprocessable(api_message)),
            _ => Err(ApiFailure::Other(api_message)),
        }
    }

    async fn fetch_pull_files(
        &self,
        client: &reqwest::Client,
        repo: &GitHubRepoRef,
        number: u64,
        auth: &ResolvedAuth,
        scope: &Scope,
    ) -> Result<Vec<CachedPrFile>, ApiFailure> {
        let num_str = number.to_string();
        let mut all = Vec::new();
        for page in 1..=3_u8 {
            let page_str = page.to_string();
            let url = self
                .github_repo_url(
                    repo,
                    &["pulls", &num_str, "files"],
                    &[("per_page", "100"), ("page", &page_str)],
                )
                .await
                .map_err(ApiFailure::Other)?;
            let batch: Vec<RawPullFile> = self
                .github_json::<Vec<RawPullFile>, ()>(
                    client,
                    HttpMethod::GET,
                    url,
                    auth,
                    None,
                    scope,
                )
                .await?;
            let count = batch.len();
            for item in batch {
                let status = match item.status.as_str() {
                    "added" => GitHubPullFileStatus::Added,
                    "removed" => GitHubPullFileStatus::Removed,
                    "modified" => GitHubPullFileStatus::Modified,
                    "renamed" => GitHubPullFileStatus::Renamed,
                    "copied" => GitHubPullFileStatus::Copied,
                    _ => GitHubPullFileStatus::Changed,
                };
                let digest = item.sha.unwrap_or_else(|| {
                    let mut hasher = Sha256::new();
                    hasher.update(item.filename.as_bytes());
                    if let Some(patch) = item.patch.as_deref() {
                        hasher.update(patch.as_bytes());
                    }
                    hex::encode(hasher.finalize())
                });
                all.push(CachedPrFile {
                    path: item.filename,
                    previous_path: item.previous_filename,
                    status,
                    additions: item.additions.unwrap_or(0),
                    deletions: item.deletions.unwrap_or(0),
                    digest,
                    patch: item.patch,
                });
            }
            if count < 100 {
                break;
            }
        }
        Ok(all)
    }

    async fn fetch_pull_comments(
        &self,
        client: &reqwest::Client,
        repo: &GitHubRepoRef,
        number: u64,
        auth: &ResolvedAuth,
        scope: &Scope,
    ) -> Result<Vec<RawPullComment>, ApiFailure> {
        let num_str = number.to_string();
        let mut all = Vec::new();
        for page in 1..=3_u8 {
            let page_str = page.to_string();
            let url = self
                .github_repo_url(
                    repo,
                    &["pulls", &num_str, "comments"],
                    &[("per_page", "100"), ("page", &page_str)],
                )
                .await
                .map_err(ApiFailure::Other)?;
            let batch: Vec<RawPullComment> = self
                .github_json::<Vec<RawPullComment>, ()>(
                    client,
                    HttpMethod::GET,
                    url,
                    auth,
                    None,
                    scope,
                )
                .await?;
            let count = batch.len();
            all.extend(batch);
            if count < 100 {
                break;
            }
        }
        Ok(all)
    }

    async fn fetch_pull_reviews(
        &self,
        client: &reqwest::Client,
        repo: &GitHubRepoRef,
        number: u64,
        auth: &ResolvedAuth,
        scope: &Scope,
    ) -> Result<Vec<RawPullReview>, ApiFailure> {
        let num_str = number.to_string();
        let url = self
            .github_repo_url(
                repo,
                &["pulls", &num_str, "reviews"],
                &[("per_page", "100")],
            )
            .await
            .map_err(ApiFailure::Other)?;
        self.github_json::<Vec<RawPullReview>, ()>(client, HttpMethod::GET, url, auth, None, scope)
            .await
    }

    async fn fetch_issue_comments(
        &self,
        client: &reqwest::Client,
        repo: &GitHubRepoRef,
        number: u64,
        auth: &ResolvedAuth,
        scope: &Scope,
    ) -> Result<Vec<RawPullComment>, ApiFailure> {
        let num_str = number.to_string();
        let url = self
            .github_repo_url(
                repo,
                &["issues", &num_str, "comments"],
                &[("per_page", "50")],
            )
            .await
            .map_err(ApiFailure::Other)?;
        match self
            .github_json::<Vec<RawPullComment>, ()>(client, HttpMethod::GET, url, auth, None, scope)
            .await
        {
            Ok(list) => Ok(list),
            Err(ApiFailure::NotFound) => Ok(Vec::new()),
            Err(other) => Err(other),
        }
    }
}

fn choose_default_remote(remotes: &[GitHubRepoRef]) -> Option<GitHubRepoRef> {
    remotes
        .iter()
        .find(|r| r.host == "github.com")
        .or_else(|| remotes.first())
        .cloned()
}

fn credential_namespace() -> Result<maka_plugin_core::storage::Namespace, String> {
    maka_plugin_core::storage::Namespace::new(
        crate::IMPLEMENTATION,
        maka_plugin_core::scope::Scope::Profile,
    )
    .map_err(|e| e.to_string())
}

fn credential_key(host: &str) -> String {
    format!("github/token/{host}")
}

fn match_remote_allowlist(
    explicit: GitHubRepoRef,
    remotes: &[GitHubRepoRef],
) -> Result<GitHubRepoRef, String> {
    let validated = validate_repo_ref(explicit)?;
    remotes
        .iter()
        .find(|r| {
            r.host.eq_ignore_ascii_case(&validated.host)
                && r.owner.eq_ignore_ascii_case(&validated.owner)
                && r.repo.eq_ignore_ascii_case(&validated.repo)
        })
        .cloned()
        .ok_or_else(|| "agent_github_repo_not_in_remotes".into())
}

fn normalize_host(raw: &str) -> Option<String> {
    let host = raw.trim().to_ascii_lowercase();
    if !host.is_empty()
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.starts_with('-')
        && !host.ends_with('-')
        && host.contains('.')
        && !host.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        Some(host)
    } else {
        None
    }
}

fn valid_repo_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn validate_repo_ref(repo: GitHubRepoRef) -> Result<GitHubRepoRef, String> {
    let host = normalize_host(&repo.host).ok_or_else(|| "agent_github_invalid_host".to_owned())?;
    let owner = repo.owner.trim().to_owned();
    let name = repo.repo.trim().to_owned();
    if !valid_repo_segment(&owner) || !valid_repo_segment(&name) {
        return Err("agent_github_invalid_repo".into());
    }
    Ok(GitHubRepoRef {
        host,
        owner,
        repo: name,
    })
}

fn is_hex_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn resolve_env_token_with(
    host: &str,
    get_env: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    if host == "github.com" {
        for key in ["GH_TOKEN", "GITHUB_TOKEN"] {
            if let Some(raw) = get_env(key) {
                let trimmed = raw.trim();
                if !trimmed.is_empty() && !trimmed.chars().any(char::is_control) {
                    return Some(trimmed.to_owned());
                }
            }
        }
        return None;
    }
    let gh_host = get_env("GH_HOST").and_then(|v| normalize_host(&v))?;
    if gh_host != host {
        return None;
    }
    for key in ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] {
        if let Some(raw) = get_env(key) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() && !trimmed.chars().any(char::is_control) {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

fn resolve_env_or_file_token(
    host: &str,
    home: Option<&Path>,
) -> Option<(String, GitHubTokenSource)> {
    if let Some(token) = resolve_env_token_with(host, |key| std::env::var(key).ok()) {
        return Some((token, GitHubTokenSource::Env));
    }

    for candidate in gh_hosts_paths(home) {
        if let Some(content) = read_bounded_utf8(&candidate)
            && let Some(token) = parse_gh_hosts_yml(&content, host)
        {
            return Some((token, GitHubTokenSource::HostsFile));
        }
    }

    if let Some(home_dir) = home {
        for name in [".netrc", "_netrc"] {
            if let Some(content) = read_bounded_utf8(&home_dir.join(name))
                && let Some(token) = parse_netrc_token(&content, host)
            {
                return Some((token, GitHubTokenSource::Netrc));
            }
        }
    }
    None
}

fn gh_hosts_paths(home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(custom) = std::env::var("GH_CONFIG_DIR")
        && !custom.trim().is_empty()
    {
        paths.push(PathBuf::from(custom).join("hosts.yml"));
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME")
        && !xdg.trim().is_empty()
    {
        paths.push(PathBuf::from(xdg).join("gh").join("hosts.yml"));
    }
    if let Some(home_dir) = home {
        paths.push(home_dir.join(".config").join("gh").join("hosts.yml"));
    }
    if cfg!(windows)
        && let Ok(appdata) = std::env::var("APPDATA")
        && !appdata.trim().is_empty()
    {
        paths.push(PathBuf::from(appdata).join("GitHub CLI").join("hosts.yml"));
    }
    paths
}

fn read_bounded_utf8(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_CONFIG_FILE_BYTES {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

pub(crate) fn parse_gh_hosts_yml(content: &str, target_host: &str) -> Option<String> {
    let mut in_target = false;
    for raw_line in content.lines() {
        let without_comment = strip_yaml_comment(raw_line);
        if without_comment.trim().is_empty() {
            continue;
        }
        let indent = without_comment.len() - without_comment.trim_start_matches(' ').len();
        let trimmed = without_comment.trim();
        if indent == 0 {
            if let Some((key, _)) = trimmed.split_once(':') {
                let host = unquote_scalar(key.trim());
                in_target = host.eq_ignore_ascii_case(target_host);
            } else {
                in_target = false;
            }
            continue;
        }
        if !in_target {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once(':')
            && unquote_scalar(key.trim()) == "oauth_token"
        {
            let token = unquote_scalar(value.trim());
            if !token.is_empty() && !token.chars().any(char::is_control) {
                return Some(token.to_owned());
            }
        }
    }
    None
}

fn strip_yaml_comment(line: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    for (idx, ch) in line.char_indices() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single
                && !in_double
                && (idx == 0 || line.as_bytes()[idx - 1].is_ascii_whitespace()) =>
            {
                return &line[..idx];
            }
            _ => {}
        }
    }
    line
}

fn unquote_scalar(raw: &str) -> &str {
    raw.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| raw.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(raw)
        .trim()
}

pub(crate) fn parse_netrc_token(content: &str, target_host: &str) -> Option<String> {
    let api_host = format!("api.{target_host}");
    let mut words = Vec::new();
    for line in content.lines() {
        let active = line.split('#').next().unwrap_or("");
        words.extend(active.split_whitespace());
    }
    let mut in_matching_machine = false;
    let mut i = 0;
    while i < words.len() {
        match words[i] {
            "machine" => {
                let Some(host) = words.get(i + 1) else { break };
                in_matching_machine =
                    host.eq_ignore_ascii_case(target_host) || host.eq_ignore_ascii_case(&api_host);
                i += 2;
            }
            "default" => {
                in_matching_machine = false;
                i += 1;
            }
            "password" if in_matching_machine => {
                let token = words.get(i + 1)?.trim();
                if !token.is_empty() && !token.chars().any(char::is_control) {
                    return Some(token.to_owned());
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    None
}

async fn fetch_gh_cli_token(host: &str) -> Option<String> {
    normalize_host(host)?;
    let mut cmd = tokio::process::Command::new("gh");
    cmd.args(["auth", "token", "--hostname", host])
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let output = tokio::time::timeout(Duration::from_secs(3), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?;
    let trimmed = token.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

pub(crate) fn format_github_file_patch(
    path: &str,
    previous_path: Option<&str>,
    status: GitHubPullFileStatus,
    raw_hunks: Option<&str>,
) -> String {
    let old_name = previous_path.unwrap_or(path);
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{old_name} b/{path}\n"));
    if status == GitHubPullFileStatus::Renamed && old_name != path {
        out.push_str(&format!("rename from {old_name}\nrename to {path}\n"));
    }
    let minus = if status == GitHubPullFileStatus::Added {
        "/dev/null".to_owned()
    } else {
        format!("a/{old_name}")
    };
    let plus = if status == GitHubPullFileStatus::Removed {
        "/dev/null".to_owned()
    } else {
        format!("b/{path}")
    };
    if raw_hunks.is_some()
        || matches!(
            status,
            GitHubPullFileStatus::Added | GitHubPullFileStatus::Removed
        )
    {
        out.push_str(&format!("--- {minus}\n+++ {plus}\n"));
    }
    if let Some(hunks) = raw_hunks {
        out.push_str(hunks);
        if !hunks.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

fn assemble_combined_pr_patch(files: &[CachedPrFile]) -> GitWorkspaceDiff {
    let mut combined = String::new();
    let mut truncated = false;
    let mut skipped_files = 0_u64;
    for file in files {
        if truncated {
            skipped_files += 1;
            continue;
        }
        let formatted = match file.patch.as_deref() {
            Some(hunks) => format_github_file_patch(
                &file.path,
                file.previous_path.as_deref(),
                file.status,
                Some(hunks),
            ),
            None if file.status == GitHubPullFileStatus::Renamed
                && file.additions == 0
                && file.deletions == 0 =>
            {
                format_github_file_patch(
                    &file.path,
                    file.previous_path.as_deref(),
                    file.status,
                    None,
                )
            }
            None => {
                skipped_files += 1;
                continue;
            }
        };
        if combined.len() + formatted.len() > MAX_PR_PATCH_BYTES {
            truncated = true;
            skipped_files += 1;
        } else {
            combined.push_str(&formatted);
        }
    }
    GitWorkspaceDiff {
        patch: combined,
        truncated,
        skipped_files,
    }
}

fn group_review_threads(mut raw: Vec<RawPullComment>) -> Vec<GitHubReviewThread> {
    raw.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut index_by_root: BTreeMap<u64, usize> = BTreeMap::new();
    let mut threads: Vec<GitHubReviewThread> = Vec::new();

    for item in raw {
        let comment = GitHubReviewComment {
            id: item.id,
            author: item.user.map_or_else(|| "ghost".into(), |u| u.login),
            body: item.body.unwrap_or_default(),
            created_at: item.created_at.unwrap_or_default(),
            html_url: item.html_url.unwrap_or_default(),
        };
        if let Some(root_id) = item.in_reply_to_id
            && let Some(&idx) = index_by_root.get(&root_id)
        {
            threads[idx].comments.push(comment);
            continue;
        }
        let side = if item
            .side
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("LEFT"))
        {
            GitHubDiffSide::Left
        } else {
            GitHubDiffSide::Right
        };
        let idx = threads.len();
        index_by_root.insert(item.id, idx);
        threads.push(GitHubReviewThread {
            id: item.id,
            path: item.path.unwrap_or_default(),
            side,
            line: item.line,
            start_line: item.start_line,
            outdated: item.line.is_none(),
            diff_hunk: item.diff_hunk.unwrap_or_default(),
            comments: vec![comment],
        });
    }
    threads
}

fn extract_github_error_message(bytes: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct RawErrItem {
        message: Option<String>,
    }
    #[derive(Deserialize)]
    struct RawErr {
        message: Option<String>,
        #[serde(default)]
        errors: Vec<serde_json::Value>,
    }
    let parsed: RawErr = serde_json::from_slice(bytes).ok()?;
    let mut details = Vec::new();
    for entry in parsed.errors {
        if let Some(s) = entry.as_str() {
            details.push(s.to_owned());
        } else if let Ok(obj) = serde_json::from_value::<RawErrItem>(entry)
            && let Some(m) = obj.message
        {
            details.push(m);
        }
    }
    match (parsed.message, details.is_empty()) {
        (Some(msg), true) => Some(msg),
        (Some(msg), false) => Some(format!("{msg}: {}", details.join("; "))),
        (None, false) => Some(details.join("; ")),
        (None, true) => None,
    }
}

#[derive(Deserialize)]
struct RawUser {
    login: String,
}

#[derive(Deserialize)]
struct RawBranchRef {
    #[serde(rename = "ref")]
    ref_name: String,
    sha: String,
}

#[derive(Deserialize)]
struct RawPullSummary {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    draft: Option<bool>,
    user: Option<RawUser>,
    head: RawBranchRef,
    base: RawBranchRef,
    updated_at: Option<String>,
    html_url: String,
}

fn into_pull_summary(raw: RawPullSummary) -> GitHubPullSummary {
    GitHubPullSummary {
        number: raw.number,
        title: raw.title,
        state: raw.state,
        draft: raw.draft.unwrap_or(false),
        author: raw.user.map_or_else(|| "ghost".into(), |u| u.login),
        head_ref: raw.head.ref_name,
        head_sha: raw.head.sha,
        base_ref: raw.base.ref_name,
        base_sha: raw.base.sha,
        updated_at: raw.updated_at.unwrap_or_default(),
        html_url: raw.html_url,
    }
}

#[derive(Deserialize)]
struct RawPullDetail {
    number: u64,
    title: String,
    body: Option<String>,
    state: String,
    draft: Option<bool>,
    merged: Option<bool>,
    user: Option<RawUser>,
    head: RawBranchRef,
    base: RawBranchRef,
    additions: Option<u64>,
    deletions: Option<u64>,
    changed_files: Option<u64>,
    html_url: String,
}

#[derive(Deserialize)]
struct RawPullFile {
    filename: String,
    previous_filename: Option<String>,
    status: String,
    additions: Option<u64>,
    deletions: Option<u64>,
    sha: Option<String>,
    patch: Option<String>,
}

#[derive(Deserialize)]
struct RawPullComment {
    id: u64,
    in_reply_to_id: Option<u64>,
    path: Option<String>,
    side: Option<String>,
    line: Option<u32>,
    start_line: Option<u32>,
    diff_hunk: Option<String>,
    body: Option<String>,
    created_at: Option<String>,
    html_url: Option<String>,
    user: Option<RawUser>,
}

#[derive(Deserialize)]
struct RawPullReview {
    id: u64,
    user: Option<RawUser>,
    state: String,
    body: Option<String>,
    submitted_at: Option<String>,
}

#[derive(Serialize)]
struct WireDraftComment {
    path: String,
    side: &'static str,
    line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_side: Option<&'static str>,
    body: String,
}

#[derive(Serialize)]
struct WireSubmitReview {
    commit_id: String,
    event: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    comments: Vec<WireDraftComment>,
}

#[derive(Deserialize)]
struct RawSubmittedReview {
    id: u64,
    state: String,
    html_url: Option<String>,
}

#[derive(Serialize)]
struct WireReplyBody {
    body: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gh_hosts_yml_both_legacy_and_multi_user_layouts() {
        let yaml = r#"
github.com:
    git_protocol: https
    users:
        m4n5ter:
            oauth_token: gho_secret123
    user: m4n5ter
ghe.corp.internal:
    oauth_token: "ghp_enterprise456" # inline comment
"#;
        assert_eq!(
            parse_gh_hosts_yml(yaml, "github.com").as_deref(),
            Some("gho_secret123")
        );
        assert_eq!(
            parse_gh_hosts_yml(yaml, "ghe.corp.internal").as_deref(),
            Some("ghp_enterprise456")
        );
        assert_eq!(parse_gh_hosts_yml(yaml, "other.host"), None);
    }

    #[test]
    fn parses_netrc_and_api_subdomain_tokens() {
        let netrc = r#"
# comment line
machine other.example login foo password wrong_tok
machine api.github.com
  login x-access-token
  password ghp_netrc_token_789
"#;
        assert_eq!(
            parse_netrc_token(netrc, "github.com").as_deref(),
            Some("ghp_netrc_token_789")
        );
        assert_eq!(parse_netrc_token(netrc, "gitlab.com"), None);
    }

    #[test]
    fn groups_review_threads_chronologically_and_marks_outdated() {
        let raw = vec![
            RawPullComment {
                id: 20,
                in_reply_to_id: Some(10),
                path: Some("src/lib.rs".into()),
                side: Some("RIGHT".into()),
                line: Some(42),
                start_line: None,
                diff_hunk: Some("@@ -40,3 +40,4 @@".into()),
                body: Some("Fixed in latest commit.".into()),
                created_at: Some("2026-11-17T10:05:00Z".into()),
                html_url: Some("https://github.com/a/b/pull/1#discussion_r20".into()),
                user: Some(RawUser {
                    login: "author".into(),
                }),
            },
            RawPullComment {
                id: 10,
                in_reply_to_id: None,
                path: Some("src/lib.rs".into()),
                side: Some("RIGHT".into()),
                line: Some(42),
                start_line: Some(40),
                diff_hunk: Some("@@ -40,3 +40,4 @@".into()),
                body: Some("Please guard this boundary.".into()),
                created_at: Some("2026-11-17T10:00:00Z".into()),
                html_url: Some("https://github.com/a/b/pull/1#discussion_r10".into()),
                user: Some(RawUser {
                    login: "reviewer".into(),
                }),
            },
            RawPullComment {
                id: 30,
                in_reply_to_id: None,
                path: Some("src/old.rs".into()),
                side: Some("LEFT".into()),
                line: None,
                start_line: None,
                diff_hunk: Some("@@ -1,2 +1,2 @@".into()),
                body: Some("Outdated note.".into()),
                created_at: Some("2026-11-17T10:02:00Z".into()),
                html_url: None,
                user: None,
            },
        ];
        let threads = group_review_threads(raw);
        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0].id, 10);
        assert!(!threads[0].outdated);
        assert_eq!(threads[0].line, Some(42));
        assert_eq!(threads[0].start_line, Some(40));
        assert_eq!(threads[0].comments.len(), 2);
        assert_eq!(threads[0].comments[0].author, "reviewer");
        assert_eq!(threads[0].comments[1].author, "author");

        assert_eq!(threads[1].id, 30);
        assert!(threads[1].outdated);
        assert_eq!(threads[1].side, GitHubDiffSide::Left);
    }

    #[test]
    fn formats_github_file_patch_with_valid_git_headers() {
        let added = format_github_file_patch(
            "src/new.rs",
            None,
            GitHubPullFileStatus::Added,
            Some("@@ -0,0 +1,2 @@\n+fn hi() {}\n+"),
        );
        assert!(added.starts_with(
            "diff --git a/src/new.rs b/src/new.rs\n--- /dev/null\n+++ b/src/new.rs\n@@ -0,0 +1,2 @@\n"
        ));
        assert!(added.ends_with('\n'));

        let renamed = format_github_file_patch(
            "src/renamed.rs",
            Some("src/orig.rs"),
            GitHubPullFileStatus::Renamed,
            None,
        );
        assert_eq!(
            renamed,
            "diff --git a/src/orig.rs b/src/renamed.rs\nrename from src/orig.rs\nrename to src/renamed.rs\n"
        );
    }

    #[test]
    fn extracts_structured_github_validation_errors_and_rejects_traversal_segments() {
        let raw_422 = br#"{"message":"Unprocessable Entity","errors":["Can not approve your own pull request",{"message":"Line could not be resolved"}]}"#;
        assert_eq!(
            extract_github_error_message(raw_422).as_deref(),
            Some(
                "Unprocessable Entity: Can not approve your own pull request; Line could not be resolved"
            )
        );
        assert!(
            validate_repo_ref(GitHubRepoRef {
                host: "github.com".into(),
                owner: "..".into(),
                repo: "maka".into(),
            })
            .is_err()
        );
        assert!(
            validate_repo_ref(GitHubRepoRef {
                host: "evil/host".into(),
                owner: "apache".into(),
                repo: "maka".into(),
            })
            .is_err()
        );
    }

    #[test]
    fn env_tokens_never_leak_github_pat_to_non_github_or_unmatched_hosts() {
        let env = |vars: &[(&str, &str)]| {
            let map: BTreeMap<String, String> = vars
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect();
            move |key: &str| map.get(key).cloned()
        };

        // GH_TOKEN / GITHUB_TOKEN apply strictly to github.com and NEVER to gitlab.com, GHE, or untrusted remotes.
        let with_pat = env(&[
            ("GH_TOKEN", "ghp_secret_pat"),
            ("GITHUB_TOKEN", "ghp_backup"),
        ]);
        assert_eq!(
            resolve_env_token_with("github.com", &with_pat).as_deref(),
            Some("ghp_secret_pat")
        );
        assert_eq!(resolve_env_token_with("gitlab.com", &with_pat), None);
        assert_eq!(resolve_env_token_with("attacker.example", &with_pat), None);
        assert_eq!(resolve_env_token_with("ghe.corp.internal", &with_pat), None);

        // GH_ENTERPRISE_TOKEN applies ONLY when GH_HOST explicitly matches that enterprise host.
        let with_ghe_no_host = env(&[("GH_ENTERPRISE_TOKEN", "ghp_ent_secret")]);
        assert_eq!(
            resolve_env_token_with("ghe.corp.internal", &with_ghe_no_host),
            None
        );

        let with_ghe_matched = env(&[
            ("GH_HOST", "GHE.CORP.INTERNAL"),
            ("GH_ENTERPRISE_TOKEN", "ghp_ent_secret"),
        ]);
        assert_eq!(
            resolve_env_token_with("ghe.corp.internal", &with_ghe_matched).as_deref(),
            Some("ghp_ent_secret")
        );
        assert_eq!(
            resolve_env_token_with("other.enterprise.internal", &with_ghe_matched),
            None
        );
    }

    #[test]
    fn remote_allowlist_and_host_validation_block_unconfigured_or_local_targets() {
        assert_eq!(normalize_host("localhost"), None);
        assert_eq!(normalize_host("127.0.0.1"), None);
        assert_eq!(normalize_host("github.com").as_deref(), Some("github.com"));

        let remotes = vec![GitHubRepoRef {
            host: "github.com".into(),
            owner: "apache".into(),
            repo: "maka".into(),
        }];
        assert!(
            match_remote_allowlist(
                GitHubRepoRef {
                    host: "GITHUB.COM".into(),
                    owner: "Apache".into(),
                    repo: "maka".into(),
                },
                &remotes,
            )
            .is_ok()
        );
        assert_eq!(
            match_remote_allowlist(
                GitHubRepoRef {
                    host: "attacker.example".into(),
                    owner: "apache".into(),
                    repo: "maka".into(),
                },
                &remotes,
            ),
            Err("agent_github_repo_not_in_remotes".into())
        );
    }

    #[tokio::test]
    async fn manual_token_persists_across_hub_restarts_in_configuration_vault() {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("root");
        let namespaces = maka_event_log::root::RootNamespaces {
            ownership: dir.path().join("owners"),
            control: dir.path().join("control"),
        };
        let root_owner =
            Arc::new(maka_event_log::root::RootOwner::create(&root_path, &namespaces).unwrap());
        let config = ConfigurationStore::for_root(root_owner).await.unwrap();

        let hub1 = GitHubHub::default();
        hub1.set_base_url_override("ghe.local", "http://127.0.0.1:18080/api/v3/".into())
            .await;
        let base = hub1.api_base_url("ghe.local").await.unwrap();
        assert_eq!(base.as_str(), "http://127.0.0.1:18080/api/v3/");

        hub1.write_manual_token(Some(&config), "ghe.local", Some("ghp_manual_tok".into()))
            .await
            .unwrap();
        let auth1 = hub1.resolve_auth("ghe.local", Some(&config), None).await;
        assert_eq!(auth1.token.as_deref(), Some("ghp_manual_tok"));
        assert_eq!(auth1.source, Some(GitHubTokenSource::Manual));

        // Simulate Host restart with a brand-new empty in-memory GitHubHub: token must reload from vault.
        let hub2 = GitHubHub::default();
        let auth2 = hub2.resolve_auth("ghe.local", Some(&config), None).await;
        assert_eq!(auth2.token.as_deref(), Some("ghp_manual_tok"));
        assert_eq!(auth2.source, Some(GitHubTokenSource::Manual));

        // Deleting writes a tombstone so subsequent restarts see it removed.
        hub2.write_manual_token(Some(&config), "ghe.local", None)
            .await
            .unwrap();
        let hub3 = GitHubHub::default();
        let cleared = hub3.resolve_auth("ghe.local", Some(&config), None).await;
        assert_ne!(cleared.source, Some(GitHubTokenSource::Manual));
    }
}
