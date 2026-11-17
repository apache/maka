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

//! Opportunistic local Language Server client pool with strict `Directory` capability
//! containment, bounded latency, and clean process-group teardown.

use super::{
    CodeBackend, CodeDefinitionResult, CodeHoverResult, CodeLocation, CodePosition, CodeRange,
    CodeReferencesResult, index,
};
use crate::{files::Directory, path::WorkspacePath};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex as AsyncMutex, OnceCell, oneshot},
    time::timeout,
};

const MAX_CLIENTS: usize = 4;
const IDLE_TTL: Duration = Duration::from_secs(300);
const FAILURE_TTL: Duration = Duration::from_secs(60);
const INIT_TIMEOUT: Duration = Duration::from_millis(3000);
const QUERY_TIMEOUT: Duration = Duration::from_millis(3500);
const LINK_HOVER_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_LSP_REFERENCES: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum LanguageFamily {
    Rust,
    TypeScript,
    Python,
    Go,
    Cpp,
    Swift,
    Zig,
    Lua,
}

struct ServerCandidate {
    name: &'static str,
    bin: &'static str,
    args: &'static [&'static str],
}

impl LanguageFamily {
    fn from_path(path: &str) -> Option<(Self, &'static str)> {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".rs") {
            Some((Self::Rust, "rust"))
        } else if lower.ends_with(".tsx") {
            Some((Self::TypeScript, "typescriptreact"))
        } else if lower.ends_with(".ts") || lower.ends_with(".mts") || lower.ends_with(".cts") {
            Some((Self::TypeScript, "typescript"))
        } else if lower.ends_with(".jsx") {
            Some((Self::TypeScript, "javascriptreact"))
        } else if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
            Some((Self::TypeScript, "javascript"))
        } else if lower.ends_with(".py") || lower.ends_with(".pyi") {
            Some((Self::Python, "python"))
        } else if lower.ends_with(".go") {
            Some((Self::Go, "go"))
        } else if lower.ends_with(".c") || lower.ends_with(".h") {
            Some((Self::Cpp, "c"))
        } else if lower.ends_with(".cc")
            || lower.ends_with(".cpp")
            || lower.ends_with(".cxx")
            || lower.ends_with(".hpp")
        {
            Some((Self::Cpp, "cpp"))
        } else if lower.ends_with(".swift") {
            Some((Self::Swift, "swift"))
        } else if lower.ends_with(".zig") {
            Some((Self::Zig, "zig"))
        } else if lower.ends_with(".lua") {
            Some((Self::Lua, "lua"))
        } else {
            None
        }
    }

    fn candidates(self) -> &'static [ServerCandidate] {
        match self {
            Self::Rust => &[ServerCandidate {
                name: "rust-analyzer",
                bin: "rust-analyzer",
                args: &[],
            }],
            Self::TypeScript => &[
                ServerCandidate {
                    name: "typescript-language-server",
                    bin: "typescript-language-server",
                    args: &["--stdio"],
                },
                ServerCandidate {
                    name: "vtsls",
                    bin: "vtsls",
                    args: &["--stdio"],
                },
            ],
            Self::Python => &[
                ServerCandidate {
                    name: "basedpyright",
                    bin: "basedpyright-langserver",
                    args: &["--stdio"],
                },
                ServerCandidate {
                    name: "pyright",
                    bin: "pyright-langserver",
                    args: &["--stdio"],
                },
                ServerCandidate {
                    name: "pylsp",
                    bin: "pylsp",
                    args: &[],
                },
            ],
            Self::Go => &[ServerCandidate {
                name: "gopls",
                bin: "gopls",
                args: &["serve"],
            }],
            Self::Cpp => &[ServerCandidate {
                name: "clangd",
                bin: "clangd",
                args: &["--log=error"],
            }],
            Self::Swift => &[ServerCandidate {
                name: "sourcekit-lsp",
                bin: "sourcekit-lsp",
                args: &[],
            }],
            Self::Zig => &[ServerCandidate {
                name: "zls",
                bin: "zls",
                args: &[],
            }],
            Self::Lua => &[ServerCandidate {
                name: "lua-language-server",
                bin: "lua-language-server",
                args: &[],
            }],
        }
    }

    fn initialization_options(self) -> Value {
        match self {
            // Keep navigation strictly read-only: never run `cargo check`, `build.rs`, or proc-macros.
            Self::Rust => json!({
                "checkOnSave": false,
                "cargo": { "buildScripts": { "enable": false } },
                "procMacro": { "enable": false },
            }),
            _ => Value::Null,
        }
    }
}

#[derive(Clone, Debug)]
pub struct CustomServerCommand {
    pub name: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
}

#[derive(Clone, Default)]
pub struct LspPool {
    inner: Arc<PoolOwner>,
    override_cmd: Option<Arc<CustomServerCommand>>,
}

#[derive(Default)]
struct PoolOwner {
    state: Mutex<PoolState>,
}

impl Drop for PoolOwner {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.state.lock() {
            guard.stopped = true;
            for (_, entry) in guard.entries.drain() {
                entry.client.abort();
            }
        }
    }
}

#[derive(Default)]
struct PoolState {
    stopped: bool,
    entries: HashMap<(PathBuf, LanguageFamily), PoolEntry>,
    detected: HashMap<LanguageFamily, Option<CustomServerCommand>>,
}

struct PoolEntry {
    client: Arc<LspClient>,
    last_used: Instant,
}

#[derive(Clone)]
pub struct LspRequestContext {
    pub directory: Arc<Directory>,
    pub allow_lsp: bool,
    pub cancel: Arc<AtomicBool>,
}

enum LspOutcome<T> {
    Unavailable,
    Authoritative { server: String, value: T },
}

impl LspPool {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    fn with_override(cmd: CustomServerCommand) -> Self {
        Self {
            inner: Arc::new(PoolOwner::default()),
            override_cmd: Some(Arc::new(cmd)),
        }
    }

    pub fn shutdown_all(&self) {
        let clients: Vec<Arc<LspClient>> = {
            let mut guard = self.inner.state.lock().expect("lsp pool mutex");
            guard.stopped = true;
            guard
                .entries
                .drain()
                .map(|(_, entry)| entry.client)
                .collect()
        };
        for client in clients {
            client.abort();
        }
    }

    async fn resolve_target(
        ctx: &LspRequestContext,
        path: &WorkspacePath,
        position: CodePosition,
        explicit_symbol: Option<String>,
    ) -> Result<Option<index::TargetSymbol>, String> {
        let dir = ctx.directory.clone();
        let cancel = ctx.cancel.clone();
        let path_owned = path.clone();
        tokio::task::spawn_blocking(move || {
            index::resolve_target(
                &dir,
                &path_owned,
                position,
                explicit_symbol.as_deref(),
                &cancel,
            )
        })
        .await
        .map_err(|_| "agent_symbols_unavailable".to_owned())?
        .map_err(|err| {
            if err.to_string() == "files_cancelled" {
                "agent_files_cancelled".to_owned()
            } else {
                "agent_symbols_unavailable".to_owned()
            }
        })
    }

    pub async fn definition(
        &self,
        ctx: &LspRequestContext,
        path: &WorkspacePath,
        position: CodePosition,
        explicit_symbol: Option<&str>,
        hover_only: bool,
    ) -> Result<CodeDefinitionResult, String> {
        let Some(target) =
            Self::resolve_target(ctx, path, position, explicit_symbol.map(str::to_owned)).await?
        else {
            return Ok(CodeDefinitionResult {
                backend: CodeBackend::Indexed,
                symbol: String::new(),
                origin_range: None,
                locations: Vec::new(),
            });
        };

        let budget = if hover_only {
            LINK_HOVER_TIMEOUT
        } else {
            QUERY_TIMEOUT
        };

        if ctx.allow_lsp
            && explicit_symbol.is_none()
            && let Some(source_text) = target.source_text.as_deref()
        {
            let doc_uri = file_uri(&ctx.directory.root_path().join(index::path_string(path)));
            if let LspOutcome::Authoritative { server, value } = self
                .try_lsp_locations(
                    ctx,
                    path,
                    source_text,
                    "textDocument/definition",
                    json!({
                        "textDocument": { "uri": doc_uri },
                        "position": { "line": position.line, "character": position.column },
                    }),
                    budget,
                    MAX_LSP_REFERENCES,
                )
                .await
            {
                return Ok(CodeDefinitionResult {
                    backend: CodeBackend::Lsp { server },
                    symbol: target.name,
                    origin_range: target.range,
                    locations: value.0,
                });
            }
        }

        let dir = ctx.directory.clone();
        let cancel = ctx.cancel.clone();
        let path_owned = path.clone();
        tokio::task::spawn_blocking(move || index::definition(&dir, &path_owned, &target, &cancel))
            .await
            .map_err(|_| "agent_symbols_unavailable".to_owned())?
            .map_err(|_| "agent_symbols_unavailable".to_owned())
    }

    pub async fn references(
        &self,
        ctx: &LspRequestContext,
        path: &WorkspacePath,
        position: CodePosition,
        explicit_symbol: Option<&str>,
        include_declaration: bool,
    ) -> Result<CodeReferencesResult, String> {
        let Some(target) =
            Self::resolve_target(ctx, path, position, explicit_symbol.map(str::to_owned)).await?
        else {
            return Ok(CodeReferencesResult {
                backend: CodeBackend::Indexed,
                symbol: String::new(),
                locations: Vec::new(),
                truncated: false,
            });
        };

        if ctx.allow_lsp
            && explicit_symbol.is_none()
            && let Some(source_text) = target.source_text.as_deref()
        {
            let doc_uri = file_uri(&ctx.directory.root_path().join(index::path_string(path)));
            if let LspOutcome::Authoritative {
                server,
                value: (locations, truncated),
            } = self
                .try_lsp_locations(
                    ctx,
                    path,
                    source_text,
                    "textDocument/references",
                    json!({
                        "textDocument": { "uri": doc_uri },
                        "position": { "line": position.line, "character": position.column },
                        "context": { "includeDeclaration": include_declaration },
                    }),
                    QUERY_TIMEOUT,
                    MAX_LSP_REFERENCES,
                )
                .await
            {
                return Ok(CodeReferencesResult {
                    backend: CodeBackend::Lsp { server },
                    symbol: target.name,
                    locations,
                    truncated,
                });
            }
        }

        let dir = ctx.directory.clone();
        let cancel = ctx.cancel.clone();
        let path_owned = path.clone();
        tokio::task::spawn_blocking(move || {
            index::references(&dir, &path_owned, &target, include_declaration, &cancel)
        })
        .await
        .map_err(|_| "agent_symbols_unavailable".to_owned())?
        .map_err(|_| "agent_symbols_unavailable".to_owned())
    }

    pub async fn hover(
        &self,
        ctx: &LspRequestContext,
        path: &WorkspacePath,
        position: CodePosition,
    ) -> Result<Option<CodeHoverResult>, String> {
        let Some(target) = Self::resolve_target(ctx, path, position, None).await? else {
            return Ok(None);
        };

        if ctx.allow_lsp
            && let Some(source_text) = target.source_text.as_deref()
            && let LspOutcome::Authoritative { server, value } =
                self.try_lsp_hover(ctx, path, source_text, position).await
        {
            return Ok(value.map(|(markdown, range)| CodeHoverResult {
                backend: CodeBackend::Lsp { server },
                symbol: target.name,
                range: range.or(target.range),
                markdown,
            }));
        }

        let dir = ctx.directory.clone();
        let cancel = ctx.cancel.clone();
        let path_owned = path.clone();
        tokio::task::spawn_blocking(move || index::hover(&dir, &path_owned, &target, &cancel))
            .await
            .map_err(|_| "agent_symbols_unavailable".to_owned())?
            .map_err(|_| "agent_symbols_unavailable".to_owned())
    }

    async fn try_lsp_locations(
        &self,
        ctx: &LspRequestContext,
        path: &WorkspacePath,
        source_text: &str,
        method: &'static str,
        params: Value,
        budget: Duration,
        max_items: usize,
    ) -> LspOutcome<(Vec<CodeLocation>, bool)> {
        let rel = index::path_string(path);
        let Some((family, lang_id)) = LanguageFamily::from_path(&rel) else {
            return LspOutcome::Unavailable;
        };
        let root = ctx.directory.root_path().to_path_buf();
        let Some(client) = self.client_for(&root, family).await else {
            return LspOutcome::Unavailable;
        };
        if !client
            .ensure_ready(&root, family.initialization_options())
            .await
        {
            return LspOutcome::Unavailable;
        }
        let doc_uri = file_uri(&root.join(&rel));
        if client
            .sync_document(&doc_uri, lang_id, source_text)
            .await
            .is_err()
        {
            return LspOutcome::Unavailable;
        }
        let Ok(Ok(response)) = timeout(budget, client.request(method, params)).await else {
            return LspOutcome::Unavailable;
        };
        let raw_locs = parse_lsp_locations(&response);
        if raw_locs.is_empty() {
            return LspOutcome::Authoritative {
                server: client.server_name.clone(),
                value: (Vec::new(), false),
            };
        }
        let dir = ctx.directory.clone();
        let cancel = ctx.cancel.clone();
        let source_owned = source_text.to_owned();
        let Ok((resolved, truncated)) = tokio::task::spawn_blocking(move || {
            let root = dir.root_path().to_path_buf();
            let mut preview_cache: HashMap<String, Option<String>> = HashMap::new();
            preview_cache.insert(rel, Some(source_owned));
            let mut out = Vec::new();
            let mut truncated = false;
            for (uri, range) in raw_locs {
                let Some(ws_path) = uri_to_workspace_path(&uri, &root) else {
                    continue;
                };
                let key = index::path_string(&ws_path);
                let file_text = match preview_cache.get(&key) {
                    Some(cached) => cached.clone(),
                    None => {
                        let loaded = index::read_text(&dir, &ws_path, &cancel).ok().flatten();
                        preview_cache.insert(key, loaded.clone());
                        loaded
                    }
                };
                // `Directory::read_file` enforces `open_dir_nofollow` and private/control exclusions
                // while permitting this session's bound managed worktree.
                let Some(file_text) = file_text else {
                    continue;
                };
                if out.len() >= max_items {
                    truncated = true;
                    break;
                }
                out.push(CodeLocation {
                    path: ws_path,
                    range,
                    preview: index::line_preview(&file_text, range.start.line),
                });
            }
            (out, truncated)
        })
        .await
        else {
            return LspOutcome::Unavailable;
        };
        LspOutcome::Authoritative {
            server: client.server_name.clone(),
            value: (resolved, truncated),
        }
    }

    async fn try_lsp_hover(
        &self,
        ctx: &LspRequestContext,
        path: &WorkspacePath,
        source_text: &str,
        position: CodePosition,
    ) -> LspOutcome<Option<(String, Option<CodeRange>)>> {
        let rel = index::path_string(path);
        let Some((family, lang_id)) = LanguageFamily::from_path(&rel) else {
            return LspOutcome::Unavailable;
        };
        let root = ctx.directory.root_path().to_path_buf();
        let Some(client) = self.client_for(&root, family).await else {
            return LspOutcome::Unavailable;
        };
        if !client
            .ensure_ready(&root, family.initialization_options())
            .await
        {
            return LspOutcome::Unavailable;
        }
        let doc_uri = file_uri(&root.join(&rel));
        if client
            .sync_document(&doc_uri, lang_id, source_text)
            .await
            .is_err()
        {
            return LspOutcome::Unavailable;
        }
        let Ok(Ok(response)) = timeout(
            QUERY_TIMEOUT,
            client.request(
                "textDocument/hover",
                json!({
                    "textDocument": { "uri": doc_uri },
                    "position": { "line": position.line, "character": position.column },
                }),
            ),
        )
        .await
        else {
            return LspOutcome::Unavailable;
        };
        if response.is_null() {
            return LspOutcome::Authoritative {
                server: client.server_name.clone(),
                value: None,
            };
        }
        let parsed = response
            .get("contents")
            .and_then(extract_hover_markdown)
            .and_then(|md| {
                if md.trim().is_empty() {
                    None
                } else {
                    Some((md, response.get("range").and_then(parse_lsp_range)))
                }
            });
        LspOutcome::Authoritative {
            server: client.server_name.clone(),
            value: parsed,
        }
    }

    async fn client_for(&self, root: &Path, family: LanguageFamily) -> Option<Arc<LspClient>> {
        let now = Instant::now();
        let cached_cmd: Option<Option<CustomServerCommand>>;
        {
            let mut guard = self.inner.state.lock().expect("lsp pool mutex");
            if guard.stopped {
                return None;
            }
            let expired: Vec<(PathBuf, LanguageFamily)> = guard
                .entries
                .iter()
                .filter(|(_, e)| {
                    let ttl = if e.client.is_dead() {
                        FAILURE_TTL
                    } else {
                        IDLE_TTL
                    };
                    now.duration_since(e.last_used) > ttl
                })
                .map(|(k, _)| k.clone())
                .collect();
            for key in expired {
                if let Some(removed) = guard.entries.remove(&key) {
                    removed.client.abort();
                }
            }
            let lookup_key = (root.to_path_buf(), family);
            if let Some(existing) = guard.entries.get_mut(&lookup_key) {
                if existing.client.is_dead() {
                    return None;
                }
                existing.last_used = now;
                return Some(existing.client.clone());
            }
            cached_cmd = guard.detected.get(&family).cloned();
        }

        let cmd = if let Some(custom) = &self.override_cmd {
            (**custom).clone()
        } else if let Some(cached) = cached_cmd {
            cached?
        } else {
            let found = tokio::task::spawn_blocking(move || detect_server(family))
                .await
                .ok()?;
            if let Ok(mut guard) = self.inner.state.lock() {
                guard.detected.insert(family, found.clone());
            }
            found?
        };

        let root_owned = root.to_path_buf();
        let spawned = tokio::task::spawn_blocking(move || LspClient::spawn(&root_owned, cmd))
            .await
            .ok()?
            .ok()?;

        let mut evicted: Option<Arc<LspClient>> = None;
        let selected = {
            let mut guard = self.inner.state.lock().expect("lsp pool mutex");
            if guard.stopped {
                spawned.abort();
                return None;
            }
            let key = (root.to_path_buf(), family);
            if let Some(existing) = guard.entries.get_mut(&key) {
                spawned.abort();
                if existing.client.is_dead() {
                    return None;
                }
                existing.last_used = now;
                existing.client.clone()
            } else {
                if guard.entries.len() >= MAX_CLIENTS
                    && let Some(oldest_key) = guard
                        .entries
                        .iter()
                        .min_by_key(|(_, e)| e.last_used)
                        .map(|(k, _)| k.clone())
                    && let Some(old) = guard.entries.remove(&oldest_key)
                {
                    evicted = Some(old.client);
                }
                guard.entries.insert(
                    key,
                    PoolEntry {
                        client: spawned.clone(),
                        last_used: now,
                    },
                );
                spawned
            }
        };
        if let Some(old) = evicted {
            old.abort();
        }
        Some(selected)
    }
}

struct ClientIo {
    dead: AtomicBool,
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
}

impl ClientIo {
    async fn send_raw(&self, payload: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("lsp_stdin_closed")?;
        stdin
            .write_all(header.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.write_all(&body).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn notify(&self, method: &'static str, params: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.send_raw(&payload).await
    }
}

struct LspClient {
    server_name: String,
    next_id: AtomicU64,
    ready: OnceCell<bool>,
    io: Arc<ClientIo>,
    child_pid: Option<u32>,
    child: Mutex<Option<Child>>,
    docs: AsyncMutex<HashMap<String, (i32, [u8; 32])>>,
}

impl Drop for LspClient {
    fn drop(&mut self) {
        self.abort();
    }
}

impl LspClient {
    fn spawn(root: &Path, server: CustomServerCommand) -> Result<Arc<Self>, String> {
        let mut command = Command::new(&server.executable);
        let mut path_dirs = augmented_search_dirs();
        if let Some(parent) = server.executable.parent()
            && !path_dirs.iter().any(|d| d == parent)
        {
            path_dirs.insert(0, parent.to_path_buf());
        }
        if let Ok(joined) = env::join_paths(&path_dirs) {
            command.env("PATH", joined);
        }
        command
            .args(&server.args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let child_pid = child.id();
        let stdin = child.stdin.take().ok_or("missing lsp stdin")?;
        let stdout = child.stdout.take().ok_or("missing lsp stdout")?;

        let io = Arc::new(ClientIo {
            dead: AtomicBool::new(false),
            stdin: AsyncMutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
        });

        let reader_io = io.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            while let Some(msg) = read_rpc_frame(&mut reader).await {
                if let Some(id_val) = msg.get("id") {
                    if msg.get("method").is_some() {
                        let response = json!({
                            "jsonrpc": "2.0",
                            "id": id_val,
                            "result": null,
                        });
                        let _ = reader_io.send_raw(&response).await;
                    } else if let Some(id) = id_val.as_u64() {
                        let tx = reader_io
                            .pending
                            .lock()
                            .expect("lsp pending mutex")
                            .remove(&id);
                        if let Some(tx) = tx {
                            if let Some(err) = msg.get("error") {
                                let _ = tx.send(Err(err.to_string()));
                            } else {
                                let _ =
                                    tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                            }
                        }
                    }
                }
            }
            reader_io.dead.store(true, Ordering::Relaxed);
            let waiters: Vec<_> = reader_io
                .pending
                .lock()
                .expect("lsp pending mutex")
                .drain()
                .map(|(_, tx)| tx)
                .collect();
            for tx in waiters {
                let _ = tx.send(Err("lsp_closed".into()));
            }
        });

        Ok(Arc::new(Self {
            server_name: server.name,
            next_id: AtomicU64::new(1),
            ready: OnceCell::new(),
            io,
            child_pid,
            child: Mutex::new(Some(child)),
            docs: AsyncMutex::new(HashMap::new()),
        }))
    }

    fn is_dead(&self) -> bool {
        self.io.dead.load(Ordering::Relaxed)
    }

    fn abort(&self) {
        self.io.dead.store(true, Ordering::Relaxed);
        if let Ok(mut stdin_guard) = self.io.stdin.try_lock() {
            let _ = stdin_guard.take();
        }
        if let Some(mut child) = self.child.lock().expect("lsp child mutex").take() {
            if let Some(pid) = self.child_pid {
                kill_process_tree(pid);
            }
            let _ = child.start_kill();
        }
    }

    async fn ensure_ready(&self, root: &Path, init_options: Value) -> bool {
        let root_buf = root.to_path_buf();
        *self
            .ready
            .get_or_init(|| async move {
                let uri = file_uri(&root_buf);
                let init = timeout(
                    INIT_TIMEOUT,
                    self.request(
                        "initialize",
                        json!({
                            "processId": std::process::id(),
                            "rootUri": uri,
                            "workspaceFolders": [{ "uri": uri, "name": "workspace" }],
                            "initializationOptions": init_options,
                            "capabilities": {
                                "textDocument": {
                                    "definition": { "linkSupport": true },
                                    "references": {},
                                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                                }
                            }
                        }),
                    ),
                )
                .await;
                if !matches!(init, Ok(Ok(_))) {
                    self.abort();
                    return false;
                }
                let _ = self.io.notify("initialized", json!({})).await;
                true
            })
            .await
    }

    async fn sync_document(&self, uri: &str, language_id: &str, text: &str) -> Result<(), String> {
        let digest: [u8; 32] = Sha256::digest(text.as_bytes()).into();
        // Hold `docs` lock across `notify` so `didOpen` (v1) always precedes `didChange` (v2) on stdin.
        let mut docs = self.docs.lock().await;
        match docs.get_mut(uri) {
            None => {
                self.io
                    .notify(
                        "textDocument/didOpen",
                        json!({
                            "textDocument": {
                                "uri": uri,
                                "languageId": language_id,
                                "version": 1,
                                "text": text,
                            }
                        }),
                    )
                    .await?;
                docs.insert(uri.to_owned(), (1, digest));
                Ok(())
            }
            Some((version, prev_digest)) => {
                if *prev_digest == digest {
                    return Ok(());
                }
                let next_ver = *version + 1;
                self.io
                    .notify(
                        "textDocument/didChange",
                        json!({
                            "textDocument": { "uri": uri, "version": next_ver },
                            "contentChanges": [{ "text": text }],
                        }),
                    )
                    .await?;
                *version = next_ver;
                *prev_digest = digest;
                Ok(())
            }
        }
    }

    async fn request(&self, method: &'static str, params: Value) -> Result<Value, String> {
        if self.is_dead() {
            return Err("lsp_dead".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.io
            .pending
            .lock()
            .expect("lsp pending mutex")
            .insert(id, tx);

        struct PendingGuard {
            id: u64,
            armed: bool,
            io: Arc<ClientIo>,
        }
        impl Drop for PendingGuard {
            fn drop(&mut self) {
                if !self.armed {
                    return;
                }
                let removed = self
                    .io
                    .pending
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(&self.id))
                    .is_some();
                if removed && !self.io.dead.load(Ordering::Relaxed) {
                    let io = self.io.clone();
                    let id = self.id;
                    if let Ok(handle) = tokio::runtime::Handle::try_current() {
                        handle.spawn(async move {
                            let _ = io.notify("$/cancelRequest", json!({ "id": id })).await;
                        });
                    }
                }
            }
        }
        let mut guard = PendingGuard {
            id,
            armed: true,
            io: self.io.clone(),
        };

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.io.send_raw(&payload).await?;
        let reply = rx.await.map_err(|_| "lsp_cancelled".to_owned())?;
        guard.armed = false;
        reply
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(unix)]
    if let Ok(pgid) = i32::try_from(pid)
        && pgid > 1
    {
        // SAFETY: `LspClient::spawn` sets `process_group(0)`, making `pid` its own process-group leader.
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

async fn read_rpc_frame<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> Option<Value> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await.ok()?;
        if n == 0 {
            return None;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, val)) = trimmed.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            content_length = val.trim().parse::<usize>().ok();
        }
    }
    let len = content_length?;
    if len > 16 * 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0_u8; len];
    reader.read_exact(&mut buf).await.ok()?;
    serde_json::from_slice(&buf).ok()
}

fn augmented_search_dirs() -> Vec<PathBuf> {
    let mut search_dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect())
        .unwrap_or_default();
    if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        for rel in [".cargo/bin", ".local/bin", "go/bin"] {
            let candidate = home.join(rel);
            if !search_dirs.iter().any(|d| d == &candidate) {
                search_dirs.push(candidate);
            }
        }
    }
    #[cfg(unix)]
    {
        for sys in ["/opt/homebrew/bin", "/usr/local/bin"] {
            let candidate = PathBuf::from(sys);
            if !search_dirs.iter().any(|d| d == &candidate) {
                search_dirs.push(candidate);
            }
        }
    }
    search_dirs
}

fn detect_server(family: LanguageFamily) -> Option<CustomServerCommand> {
    let search_dirs = augmented_search_dirs();
    for candidate in family.candidates() {
        for dir in &search_dirs {
            if let Some(found) = executable_in_dir(dir, candidate.bin) {
                return Some(CustomServerCommand {
                    name: candidate.name.to_owned(),
                    executable: found,
                    args: candidate.args.iter().map(|s| (*s).to_owned()).collect(),
                });
            }
        }
    }
    None
}

fn executable_in_dir(dir: &Path, bin: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        for ext in [".exe", ".cmd", ".bat", ""] {
            let path = dir.join(format!("{bin}{ext}"));
            if path.is_file() {
                return Some(path);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(bin);
        let meta = path.metadata().ok()?;
        if meta.is_file() && (meta.permissions().mode() & 0o111 != 0) {
            Some(path)
        } else {
            None
        }
    }
}

fn file_uri(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let mut encoded = String::with_capacity(raw.len() + 16);
    encoded.push_str("file://");
    if !raw.starts_with('/') {
        encoded.push('/');
    }
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let decoded_bytes = percent_decode(rest);
    let decoded = String::from_utf8(decoded_bytes).ok()?;
    #[cfg(windows)]
    {
        let stripped = if decoded.starts_with('/') && decoded.as_bytes().get(2) == Some(&b':') {
            &decoded[1..]
        } else {
            &decoded
        };
        Some(PathBuf::from(stripped))
    }
    #[cfg(not(windows))]
    {
        Some(PathBuf::from(decoded))
    }
}

fn percent_decode(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn uri_to_workspace_path(uri: &str, canonical_root: &Path) -> Option<WorkspacePath> {
    let path = uri_to_path(uri)?;
    let canonical = dunce::canonicalize(&path).ok()?;
    let rel = canonical.strip_prefix(canonical_root).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    let rel_str = rel.to_str()?.replace('\\', "/");
    WorkspacePath::from_bytes(rel_str.as_bytes()).ok()
}

fn parse_lsp_locations(value: &Value) -> Vec<(String, CodeRange)> {
    let mut out = Vec::new();
    let items: Vec<&Value> = if let Some(arr) = value.as_array() {
        arr.iter().collect()
    } else if value.is_object() {
        vec![value]
    } else {
        Vec::new()
    };
    for item in items {
        if let (Some(uri), Some(range)) = (
            item.get("uri").and_then(Value::as_str),
            item.get("range").and_then(parse_lsp_range),
        ) {
            out.push((uri.to_owned(), range));
        } else if let Some(uri) = item.get("targetUri").and_then(Value::as_str) {
            let range = item
                .get("targetSelectionRange")
                .or_else(|| item.get("targetRange"))
                .and_then(parse_lsp_range);
            if let Some(range) = range {
                out.push((uri.to_owned(), range));
            }
        }
    }
    out
}

fn parse_lsp_range(value: &Value) -> Option<CodeRange> {
    let start = value.get("start")?;
    let end = value.get("end")?;
    Some(CodeRange {
        start: CodePosition {
            line: start.get("line")?.as_u64()?,
            column: start.get("character")?.as_u64()?,
        },
        end: CodePosition {
            line: end.get("line")?.as_u64()?,
            column: end.get("character")?.as_u64()?,
        },
    })
}

fn extract_hover_markdown(contents: &Value) -> Option<String> {
    if let Some(s) = contents.as_str() {
        return Some(s.to_owned());
    }
    if let Some(obj) = contents.as_object()
        && let Some(val) = obj.get("value").and_then(Value::as_str)
    {
        if let Some(lang) = obj.get("language").and_then(Value::as_str) {
            return Some(format!("```{lang}\n{val}\n```"));
        }
        return Some(val.to_owned());
    }
    if let Some(arr) = contents.as_array() {
        let parts: Vec<String> = arr.iter().filter_map(extract_hover_markdown).collect();
        if !parts.is_empty() {
            return Some(parts.join("\n\n"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::Worktrees;
    use std::fs;
    use tempfile::TempDir;

    fn detect_python(bin: &str) -> Option<PathBuf> {
        let dirs: Vec<PathBuf> = env::var_os("PATH")
            .map(|p| env::split_paths(&p).collect())
            .unwrap_or_default();
        for d in dirs {
            if let Some(found) = executable_in_dir(&d, bin) {
                return Some(found);
            }
        }
        None
    }

    fn write_mock_lsp_script(dir: &Path) -> PathBuf {
        let script_path = dir.join("mock_lsp.py");
        fs::write(
            &script_path,
            r#"import json, os, sys

def send(obj):
    raw = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii") + raw)
    sys.stdout.buffer.flush()

pid_file = sys.argv[1]
mode = sys.argv[2]
extra_uri = sys.argv[3]
with open(pid_file, "w") as f:
    f.write(str(os.getpid()))

root_uri = ""
while True:
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        s = line.decode("ascii").strip()
        if not s:
            break
        k, v = s.split(":", 1)
        headers[k.lower()] = v.strip()
    body = sys.stdin.buffer.read(int(headers["content-length"]))
    msg = json.loads(body.decode("utf-8"))
    method = msg.get("method")
    if method == "initialize":
        root_uri = msg["params"]["rootUri"]
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"capabilities": {}}})
    elif method == "textDocument/definition":
        if mode == "external_only":
            send({"jsonrpc": "2.0", "id": msg["id"], "result": [
                {"uri": extra_uri, "range": {"start": {"line": 0, "character": 7}, "end": {"line": 0, "character": 10}}}
            ]})
        else:
            send({"jsonrpc": "2.0", "id": msg["id"], "result": [
                {"uri": extra_uri, "range": {"start": {"line": 0, "character": 7}, "end": {"line": 0, "character": 13}}},
                {"uri": root_uri + "/src/lib.rs", "range": {"start": {"line": 0, "character": 7}, "end": {"line": 0, "character": 12}}}
            ]})
    elif method == "textDocument/hover":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"contents": {"language": "rust", "value": "pub fn greet() -> i32"}}})
"#,
        )
        .unwrap();
        script_path
    }

    #[tokio::test]
    async fn resolves_in_managed_worktree_filters_leaks_and_cleans_up_on_drop() {
        let Some(python_exe) = detect_python("python3").or_else(|| detect_python("python")) else {
            return;
        };
        let private = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("leak.rs"), "pub fn secret() {}\n").unwrap();
        let pid_file = outside.path().join("server.pid");
        let script_path = write_mock_lsp_script(outside.path());

        // Managed worktree lives inside `<private_root>/subagent-worktrees/...`.
        let origin_repo = TempDir::new().unwrap();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"][..],
            &["config", "user.name", "T"][..],
        ] {
            assert!(
                std::process::Command::new("git")
                    .current_dir(origin_repo.path())
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        fs::create_dir_all(origin_repo.path().join("src")).unwrap();
        fs::write(
            origin_repo.path().join("src/lib.rs"),
            "pub fn greet() -> i32 { 42 }\npub fn caller() -> i32 { greet() }\n",
        )
        .unwrap();
        assert!(
            std::process::Command::new("git")
                .current_dir(origin_repo.path())
                .args(["add", "."])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            std::process::Command::new("git")
                .current_dir(origin_repo.path())
                .args(["commit", "-q", "-m", "init"])
                .status()
                .unwrap()
                .success()
        );
        let manager = Worktrees::open(&private.path().join("subagent-worktrees")).unwrap();
        let binding = manager
            .plan(
                origin_repo.path(),
                &"1".repeat(64),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        manager.ensure(&binding, &AtomicBool::new(false)).unwrap();

        let control_dir = private.path().join("control");
        fs::create_dir_all(&control_dir).unwrap();
        let (canonical, obs) = crate::directory::capture(binding.directory()).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let dir = Arc::new(
            Directory::open(
                &canonical,
                &obs,
                private.path(),
                &control_dir,
                Some(&binding),
                None,
                &cancel,
            )
            .unwrap(),
        );
        let leak_uri = file_uri(&outside.path().join("leak.rs"));
        let pool = LspPool::with_override(CustomServerCommand {
            name: "mock-rust-lsp".into(),
            executable: python_exe,
            args: vec![
                script_path.to_string_lossy().into_owned(),
                pid_file.to_string_lossy().into_owned(),
                "normal".into(),
                leak_uri,
            ],
        });

        let ctx = LspRequestContext {
            directory: dir,
            allow_lsp: true,
            cancel,
        };
        let lib_path = WorkspacePath::from_bytes(b"src/lib.rs").unwrap();
        let res = pool
            .definition(
                &ctx,
                &lib_path,
                CodePosition {
                    line: 1,
                    column: 26,
                },
                None,
                false,
            )
            .await
            .unwrap();
        assert_eq!(
            res.backend,
            CodeBackend::Lsp {
                server: "mock-rust-lsp".into()
            }
        );
        assert_eq!(res.locations.len(), 1);
        assert_eq!(res.locations[0].path, lib_path);

        let pid: i32 = fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // Drop pool directly without calling `shutdown_all()` and verify subprocess termination.
        drop(pool);
        #[cfg(unix)]
        {
            let mut exited = false;
            for _ in 0..40 {
                // SAFETY: `kill(pid, 0)` only probes process existence.
                if unsafe { libc::kill(pid, 0) } != 0 {
                    exited = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert!(
                exited,
                "LSP child process {pid} leaked after dropping LspPool"
            );
        }
    }

    #[tokio::test]
    async fn authoritative_external_lsp_result_does_not_jump_to_workspace_homonym_and_read_only_skips_lsp()
     {
        let Some(python_exe) = detect_python("python3").or_else(|| detect_python("python")) else {
            return;
        };
        let workspace = TempDir::new().unwrap();
        let private = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("stdlib.rs"), "pub fn new() {}\n").unwrap();
        fs::create_dir_all(workspace.path().join("src")).unwrap();
        fs::write(
            workspace.path().join("src/other.rs"),
            "pub fn new() -> u32 { 99 }\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("src/lib.rs"),
            "pub fn make() { let _ = Vec::<u8>::new(); }\n",
        )
        .unwrap();

        let pid_file = outside.path().join("ext.pid");
        let script_path = write_mock_lsp_script(outside.path());
        let stdlib_uri = file_uri(&outside.path().join("stdlib.rs"));
        let pool = LspPool::with_override(CustomServerCommand {
            name: "mock-rust-lsp".into(),
            executable: python_exe,
            args: vec![
                script_path.to_string_lossy().into_owned(),
                pid_file.to_string_lossy().into_owned(),
                "external_only".into(),
                stdlib_uri,
            ],
        });

        let (canonical, obs) = crate::directory::capture(workspace.path()).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let dir = Arc::new(
            Directory::open(
                &canonical,
                &obs,
                private.path(),
                private.path(),
                None,
                None,
                &cancel,
            )
            .unwrap(),
        );
        let lib_path = WorkspacePath::from_bytes(b"src/lib.rs").unwrap();

        // 1. Read-only context must not spawn external LSP.
        let ro_ctx = LspRequestContext {
            directory: dir.clone(),
            allow_lsp: false,
            cancel: cancel.clone(),
        };
        let ro_res = pool
            .definition(
                &ro_ctx,
                &lib_path,
                CodePosition {
                    line: 0,
                    column: 36,
                },
                None,
                false,
            )
            .await
            .unwrap();
        assert_eq!(ro_res.backend, CodeBackend::Indexed);
        assert!(
            !pid_file.exists(),
            "read-only session must not spawn external LSP"
        );

        // 2. Writable context uses LSP and keeps authoritative empty result when target is outside workspace.
        let rw_ctx = LspRequestContext {
            directory: dir,
            allow_lsp: true,
            cancel,
        };
        let rw_res = pool
            .definition(
                &rw_ctx,
                &lib_path,
                CodePosition {
                    line: 0,
                    column: 36,
                },
                None,
                false,
            )
            .await
            .unwrap();
        assert_eq!(
            rw_res.backend,
            CodeBackend::Lsp {
                server: "mock-rust-lsp".into()
            }
        );
        assert!(
            rw_res.locations.is_empty(),
            "must not fall back to unrelated src/other.rs::new()"
        );
    }
}
