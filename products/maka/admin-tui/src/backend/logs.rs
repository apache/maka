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

use crate::model::{LogLevel, LogLine, LogSnapshot};
use base64::{Engine, engine::general_purpose::STANDARD};
use maka_event_log::root::RootNamespaces;
use maka_host_runtime::logs::{HostLogPage, HostLogPosition, HostLogRequest, Source};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const MAX_LOG_LINES: usize = 500;

struct LogBuffer {
    root_id: Option<String>,
    path: Option<String>,
    missing: bool,
    follow: bool,
    next_seq: u64,
    partial: String,
    lines: VecDeque<LogLine>,
}

impl Default for LogBuffer {
    fn default() -> Self {
        Self {
            root_id: None,
            path: None,
            missing: false,
            follow: true,
            next_seq: 1,
            partial: String::new(),
            lines: VecDeque::with_capacity(MAX_LOG_LINES),
        }
    }
}

impl LogBuffer {
    fn reset_for(&mut self, root_id: Option<String>, path: Option<String>) {
        self.root_id = root_id;
        self.path = path;
        self.missing = false;
        self.partial.clear();
        self.lines.clear();
    }

    fn apply_page(&mut self, page: HostLogPage) {
        match page {
            HostLogPage::Missing => {
                self.missing = true;
                self.partial.clear();
                self.lines.clear();
            }
            HostLogPage::Data { bytes, reset, .. } => {
                self.missing = false;
                if reset.is_some() {
                    self.partial.clear();
                    self.lines.clear();
                }
                let Ok(raw) = STANDARD.decode(bytes) else {
                    return;
                };
                let text = String::from_utf8_lossy(&raw);
                let mut combined = std::mem::take(&mut self.partial);
                combined.push_str(&text);
                let ends_with_newline = combined.ends_with('\n');
                let mut parts: Vec<&str> = combined.split('\n').collect();
                if !ends_with_newline && let Some(tail) = parts.pop() {
                    self.partial = tail.to_owned();
                }
                for line in parts {
                    let clean = line.trim_end_matches('\r');
                    if clean.is_empty() {
                        continue;
                    }
                    let seq = self.next_seq;
                    self.next_seq += 1;
                    if self.lines.len() >= MAX_LOG_LINES {
                        self.lines.pop_front();
                    }
                    self.lines.push_back(LogLine {
                        seq,
                        level: LogLevel::detect(clean),
                        text: clean.to_owned(),
                    });
                }
            }
        }
    }

    fn snapshot(&self) -> LogSnapshot {
        let mut lines: Vec<LogLine> = self.lines.iter().cloned().collect();
        if !self.partial.is_empty() {
            lines.push(LogLine {
                seq: self.next_seq,
                level: LogLevel::detect(&self.partial),
                text: self.partial.clone(),
            });
        }
        LogSnapshot {
            root_id: self.root_id.clone(),
            path: self.path.clone(),
            missing: self.missing,
            follow: self.follow,
            lines,
        }
    }
}

pub struct LogWatcher {
    buffer: Arc<Mutex<LogBuffer>>,
    active_root: Option<String>,
    cancel: Option<CancellationToken>,
    task: Option<JoinHandle<()>>,
    on_update: Arc<dyn Fn(LogSnapshot) + Send + Sync>,
}

impl LogWatcher {
    pub fn new(on_update: Arc<dyn Fn(LogSnapshot) + Send + Sync>) -> Self {
        Self {
            buffer: Arc::new(Mutex::new(LogBuffer::default())),
            active_root: None,
            cancel: None,
            task: None,
            on_update,
        }
    }

    pub fn set_follow(&mut self, follow: bool) {
        let snap = {
            let mut buf = self.buffer.lock().unwrap();
            buf.follow = follow;
            buf.snapshot()
        };
        (self.on_update)(snap);
    }

    pub async fn watch_root(&mut self, root_id: Option<String>, force_restart: bool) {
        if !force_restart && self.active_root == root_id {
            return;
        }
        self.stop().await;
        self.active_root = root_id.clone();

        let Some(root_id) = root_id else {
            let snap = {
                let mut buf = self.buffer.lock().unwrap();
                buf.reset_for(None, None);
                buf.missing = true;
                buf.snapshot()
            };
            (self.on_update)(snap);
            return;
        };

        let namespaces = match RootNamespaces::for_current_account() {
            Ok(ns) => ns,
            Err(_) => {
                let snap = {
                    let mut buf = self.buffer.lock().unwrap();
                    buf.reset_for(Some(root_id), None);
                    buf.missing = true;
                    buf.snapshot()
                };
                (self.on_update)(snap);
                return;
            }
        };

        let source = match Source::for_root(&root_id, &namespaces) {
            Ok(src) => src,
            Err(_) => {
                let snap = {
                    let mut buf = self.buffer.lock().unwrap();
                    buf.reset_for(Some(root_id), None);
                    buf.missing = true;
                    buf.snapshot()
                };
                (self.on_update)(snap);
                return;
            }
        };

        let path_str = source.path().display().to_string();
        {
            let mut buf = self.buffer.lock().unwrap();
            buf.reset_for(Some(root_id), Some(path_str));
        }

        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let buffer = self.buffer.clone();
        let on_update = self.on_update.clone();

        let task = tokio::spawn(async move {
            let request = HostLogRequest {
                position: HostLogPosition::Tail,
            };
            let _ = source
                .watch(request, task_cancel, move |page| {
                    let buffer = buffer.clone();
                    let on_update = on_update.clone();
                    async move {
                        let snap = {
                            let mut buf = buffer.lock().unwrap();
                            buf.apply_page(page);
                            buf.snapshot()
                        };
                        on_update(snap);
                        Ok(())
                    }
                })
                .await;
        });

        self.cancel = Some(cancel);
        self.task = Some(task);
    }

    pub async fn stop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
        }
    }
}
