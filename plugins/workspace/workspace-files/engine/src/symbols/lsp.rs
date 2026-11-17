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

//! Opportunistic local Language Server client pool with strict workspace containment
//! and bounded latency. Falls back to the built-in lexical index whenever no server
//! is installed, initialization is still warming up, or the server returns nothing.

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
}

#[derive(Clone, Debug)]
pub struct CustomServerCommand {
    pub name: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
}

#[derive(Clone, Default)]
pub struct LspPool {
    inner: Arc<Mutex<PoolState>>,
    override_cmd: Option<Arc<CustomServerCommand>>,
}

#[derive(Default)]
struct PoolState {
    stopped: bool,
    entries: HashMap<(PathBuf, LanguageFamily), PoolEntry>,
}

struct PoolEntry {
    client: Arc<LspClient>,
    last_used: Instant,
}

#[derive(Clone)]
pub struct LspRequestContext {
    pub workspace_root: PathBuf,
    pub private_root: PathBuf,
    pub directory: Arc<Directory>,
    pub cancel: Arc<AtomicBool>,
}

impl LspPool {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    fn with_override(cmd: CustomServerCommand) -> Self {
        Self {
            inner: Arc::new(Mutex::new(PoolState::default())),
            override_cmd: Some(Arc::new(cmd)),
        }
    }

    pub fn shutdown_all(&self) {
        let clients: Vec<Arc<LspClient>> = {
            let mut guard = self.inner.lock().expect("lsp pool mutex");
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
        .map_err(|_| "agent_symbols_unavailable".to_owned())
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

        if explicit_symbol.is_none()
            && let Some(source_text) = target.source_text.as_deref()
            && let Some((server_name, locations)) = self
                .try_lsp_locations(
                    ctx,
                    path,
                    source_text,
                    "textDocument/definition",
                    json!({
                        "textDocument": { "uri": file_uri(&dunce::canonicalize(&ctx.workspace_root).unwrap_or_else(|_| ctx.workspace_root.clone()).join(index::path_string(path))) },
                        "position": { "line": position.line, "character": position.column },
                    }),
                    budget,
                )
                .await
            && !locations.is_empty()
        {
            return Ok(CodeDefinitionResult {
                backend: CodeBackend::Lsp {
                    server: server_name,
                },
                symbol: target.name,
                origin_range: target.range,
                locations,
            });
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

        if explicit_symbol.is_none()
            && let Some(source_text) = target.source_text.as_deref()
            && let Some((server_name, mut locations)) = self
                .try_lsp_locations(
                    ctx,
                    path,
                    source_text,
                    "textDocument/references",
                    json!({
                        "textDocument": { "uri": file_uri(&dunce::canonicalize(&ctx.workspace_root).unwrap_or_else(|_| ctx.workspace_root.clone()).join(index::path_string(path))) },
                        "position": { "line": position.line, "character": position.column },
                        "context": { "includeDeclaration": include_declaration },
                    }),
                    QUERY_TIMEOUT,
                )
                .await
            && !locations.is_empty()
        {
            let truncated = locations.len() > MAX_LSP_REFERENCES;
            if truncated {
                locations.truncate(MAX_LSP_REFERENCES);
            }
            return Ok(CodeReferencesResult {
                backend: CodeBackend::Lsp {
                    server: server_name,
                },
                symbol: target.name,
                locations,
                truncated,
            });
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
        self.warm_up(&ctx.workspace_root, path);
        let Some(target) = Self::resolve_target(ctx, path, position, None).await? else {
            return Ok(None);
        };

        if let Some(source_text) = target.source_text.as_deref()
            && let Some((server_name, markdown, range)) =
                self.try_lsp_hover(ctx, path, source_text, position).await
            && !markdown.trim().is_empty()
        {
            return Ok(Some(CodeHoverResult {
                backend: CodeBackend::Lsp {
                    server: server_name,
                },
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
    ) -> Option<(String, Vec<CodeLocation>)> {
        let rel = index::path_string(path);
        let (family, lang_id) = LanguageFamily::from_path(&rel)?;
        let root = dunce::canonicalize(&ctx.workspace_root).ok()?;
        let private_root = dunce::canonicalize(&ctx.private_root).ok();
        let raw_private_root = ctx.private_root.clone();
        let client = self.client_for(&root, family)?;
        if !client.ensure_ready(&root).await {
            return None;
        }
        let doc_uri = file_uri(&root.join(&rel));
        client
            .sync_document(&doc_uri, lang_id, source_text)
            .await
            .ok()?;
        let response = timeout(budget, client.request(method, params))
            .await
            .ok()?
            .ok()?;
        let raw_locs = parse_lsp_locations(&response);
        if raw_locs.is_empty() {
            return None;
        }
        let dir = ctx.directory.clone();
        let cancel = ctx.cancel.clone();
        let source_owned = source_text.to_owned();
        let out = tokio::task::spawn_blocking(move || {
            let mut preview_cache: HashMap<String, Option<String>> = HashMap::new();
            preview_cache.insert(rel, Some(source_owned));
            let mut resolved = Vec::new();
            for (uri, range) in raw_locs {
                let Some(ws_path) =
                    resolve_workspace_uri(&uri, &root, private_root.as_deref(), &raw_private_root)
                else {
                    continue;
                };
                let key = index::path_string(&ws_path);
                let file_text = preview_cache
                    .entry(key)
                    .or_insert_with(|| index::read_text(&dir, &ws_path, &cancel).ok().flatten());
                let preview = file_text
                    .as_deref()
                    .map(|t| index::line_preview(t, range.start.line))
                    .unwrap_or_default();
                resolved.push(CodeLocation {
                    path: ws_path,
                    range,
                    preview,
                });
            }
            resolved
        })
        .await
        .ok()?;
        Some((client.server_name.clone(), out))
    }

    async fn try_lsp_hover(
        &self,
        ctx: &LspRequestContext,
        path: &WorkspacePath,
        source_text: &str,
        position: CodePosition,
    ) -> Option<(String, String, Option<CodeRange>)> {
        let rel = index::path_string(path);
        let (family, lang_id) = LanguageFamily::from_path(&rel)?;
        let root = dunce::canonicalize(&ctx.workspace_root).ok()?;
        let client = self.client_for(&root, family)?;
        if !client.ensure_ready(&root).await {
            return None;
        }
        let doc_uri = file_uri(&root.join(&rel));
        client
            .sync_document(&doc_uri, lang_id, source_text)
            .await
            .ok()?;
        let response = timeout(
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
        .ok()?
        .ok()?;
        if response.is_null() {
            return None;
        }
        let markdown = extract_hover_markdown(response.get("contents")?)?;
        let range = response.get("range").and_then(parse_lsp_range);
        Some((client.server_name.clone(), markdown, range))
    }

    fn warm_up(&self, workspace_root: &Path, path: &WorkspacePath) {
        let rel = index::path_string(path);
        let Some((family, _)) = LanguageFamily::from_path(&rel) else {
            return;
        };
        let Ok(root) = dunce::canonicalize(workspace_root) else {
            return;
        };
        if let Some(client) = self.client_for(&root, family) {
            tokio::spawn(async move {
                let _ = client.ensure_ready(&root).await;
            });
        }
    }

    fn client_for(&self, root: &Path, family: LanguageFamily) -> Option<Arc<LspClient>> {
        let now = Instant::now();
        {
            let mut guard = self.inner.lock().expect("lsp pool mutex");
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
        }

        let cmd = if let Some(custom) = &self.override_cmd {
            (**custom).clone()
        } else {
            detect_server(family)?
        };
        let spawned = LspClient::spawn(root, cmd).ok()?;

        let mut evicted: Option<Arc<LspClient>> = None;
        let selected = {
            let mut guard = self.inner.lock().expect("lsp pool mutex");
            if guard.stopped {
                spawned.abort();
                return None;
            }
            let key = (root.to_path_buf(), family);
            if let Some(existing) = guard.entries.get_mut(&key) {
                spawned.abort();
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

struct LspClient {
    server_name: String,
    next_id: AtomicU64,
    dead: AtomicBool,
    ready: OnceCell<bool>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    docs: AsyncMutex<HashMap<String, (i32, [u8; 32])>>,
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

        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or("missing lsp stdin")?;
        let stdout = child.stdout.take().ok_or("missing lsp stdout")?;

        let client = Arc::new(Self {
            server_name: server.name,
            next_id: AtomicU64::new(1),
            dead: AtomicBool::new(false),
            ready: OnceCell::new(),
            stdin: AsyncMutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            docs: AsyncMutex::new(HashMap::new()),
        });

        let reader_client = client.clone();
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
                        let _ = reader_client.send_raw(&response).await;
                    } else if let Some(id) = id_val.as_u64() {
                        let tx = reader_client
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
            reader_client.dead.store(true, Ordering::Relaxed);
            let waiters: Vec<_> = reader_client
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

        Ok(client)
    }

    fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }

    fn abort(&self) {
        self.dead.store(true, Ordering::Relaxed);
        if let Some(mut child) = self.child.lock().expect("lsp child mutex").take() {
            let _ = child.start_kill();
        }
    }

    async fn ensure_ready(&self, root: &Path) -> bool {
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
                let _ = self.notify("initialized", json!({})).await;
                true
            })
            .await
    }

    async fn sync_document(&self, uri: &str, language_id: &str, text: &str) -> Result<(), String> {
        let digest: [u8; 32] = Sha256::digest(text.as_bytes()).into();
        let mut docs = self.docs.lock().await;
        match docs.get_mut(uri) {
            None => {
                docs.insert(uri.to_owned(), (1, digest));
                drop(docs);
                self.notify(
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
                .await
            }
            Some((version, prev_digest)) => {
                if *prev_digest == digest {
                    return Ok(());
                }
                *version += 1;
                *prev_digest = digest;
                let next_ver = *version;
                drop(docs);
                self.notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": next_ver },
                        "contentChanges": [{ "text": text }],
                    }),
                )
                .await
            }
        }
    }

    async fn request(&self, method: &'static str, params: Value) -> Result<Value, String> {
        if self.is_dead() {
            return Err("lsp_dead".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("lsp pending mutex")
            .insert(id, tx);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(err) = self.send_raw(&payload).await {
            self.pending.lock().expect("lsp pending mutex").remove(&id);
            return Err(err);
        }
        rx.await.map_err(|_| "lsp_cancelled".to_owned())?
    }

    async fn notify(&self, method: &'static str, params: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.send_raw(&payload).await
    }

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

fn resolve_workspace_uri(
    uri: &str,
    root: &Path,
    private_root: Option<&Path>,
    raw_private_root: &Path,
) -> Option<WorkspacePath> {
    let path = uri_to_path(uri)?;
    let canonical = dunce::canonicalize(&path).ok()?;
    if let Some(priv_root) = private_root
        && canonical.starts_with(priv_root)
    {
        return None;
    }
    if canonical.starts_with(raw_private_root) {
        return None;
    }
    let rel = canonical.strip_prefix(root).ok()?;
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
    else_empty(&mut out, items);
    out
}

fn else_empty(out: &mut Vec<(String, CodeRange)>, items: Vec<&Value>) {
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
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn uses_lsp_when_available_and_filters_outside_workspace_uris() {
        let workspace = TempDir::new().unwrap();
        let private = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("leak.rs"), "pub fn secret() {}\n").unwrap();
        fs::create_dir_all(workspace.path().join("src")).unwrap();
        fs::write(
            workspace.path().join("src/lib.rs"),
            "pub fn greet() -> i32 { 42 }\npub fn caller() -> i32 { greet() }\n",
        )
        .unwrap();

        let script_path = outside.path().join("mock_lsp.py");
        fs::write(
            &script_path,
            r#"import json, sys

def send(obj):
    raw = json.dumps(obj).encode('utf-8')
    sys.stdout.buffer.write(f"Content-Length: {len(raw)}\r\n\r\n".encode('ascii') + raw)
    sys.stdout.buffer.flush()

root_uri = ""
leak_uri = sys.argv[1]

while True:
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        s = line.decode('ascii').strip()
        if not s:
            break
        k, v = s.split(':', 1)
        headers[k.lower()] = v.strip()
    body = sys.stdin.buffer.read(int(headers['content-length']))
    msg = json.loads(body.decode('utf-8'))
    method = msg.get('method')
    if method == 'initialize':
        root_uri = msg['params']['rootUri']
        send({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'capabilities': {}}})
    elif method == 'textDocument/definition':
        send({
            'jsonrpc': '2.0',
            'id': msg['id'],
            'result': [
                {
                    'uri': leak_uri,
                    'range': {'start': {'line': 0, 'character': 7}, 'end': {'line': 0, 'character': 13}},
                },
                {
                    'uri': root_uri + '/src/lib.rs',
                    'range': {'start': {'line': 0, 'character': 7}, 'end': {'line': 0, 'character': 12}},
                },
            ],
        })
    elif method == 'textDocument/hover':
        send({
            'jsonrpc': '2.0',
            'id': msg['id'],
            'result': {'contents': {'language': 'rust', 'value': 'pub fn greet() -> i32'}},
        })
"#,
        )
        .unwrap();

        let leak_uri = file_uri(&outside.path().join("leak.rs"));
        let Some(python_exe) = detect_python("python3").or_else(|| detect_python("python")) else {
            return;
        };

        let pool = LspPool::with_override(CustomServerCommand {
            name: "mock-rust-lsp".into(),
            executable: python_exe,
            args: vec![script_path.to_string_lossy().into_owned(), leak_uri],
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
        // Pass an unmaterialized private_root subdirectory to ensure fresh sessions still use LSP.
        let uncreated_private = private.path().join("uncreated-session-private");
        let ctx = LspRequestContext {
            workspace_root: workspace.path().to_path_buf(),
            private_root: uncreated_private,
            directory: dir,
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
        assert_eq!(res.locations[0].range.start.line, 0);

        let hov = pool
            .hover(
                &ctx,
                &lib_path,
                CodePosition {
                    line: 1,
                    column: 26,
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert!(hov.markdown.contains("pub fn greet() -> i32"));
        pool.shutdown_all();
    }

    fn detect_python(bin: &str) -> Option<PathBuf> {
        let dirs: Vec<PathBuf> = env::var_os("PATH")
            .map(|p| env::split_paths(&p).collect())
            .unwrap_or_default();
        dirs.into_iter().find_map(|d| executable_in_dir(&d, bin))
    }
}
