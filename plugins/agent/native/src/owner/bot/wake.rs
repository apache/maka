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

//! Waking the Bot when a worker it created finishes a run. The worker stays an
//! ordinary Session; the Bot only keeps a durable watch per worker so that each
//! finished run is reported to it once, even across restarts.
use super::*;
use maka_agent_facts::durable::{ExecutionIdentity, RunId, Terminal};

const WATCH_PREFIX: &str = "watch/";
const POLL: Duration = Duration::from_secs(2);

fn watch_key(worker: &str) -> String {
    format!("{WATCH_PREFIX}{worker}")
}

/// One worker the Bot waits on. It keeps only what a wake needs to start a Turn: the
/// Bot's model selection and workspace as of its latest call about this worker. The
/// model is resolved again when the Bot is woken, so a later change to what an accepted
/// model contains cannot make a stored watch unreadable.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Watch {
    model: ModelSelection,
    thinking_level: Option<ThinkingLevel>,
    workspace: Workspace,
    binding: maka_sandbox::workspace::BindingStamp,
    /// The last finished logical Run already reported to the Bot.
    notified: Option<RunId>,
}

impl Bot {
    /// Record or refresh the watch for `worker`, keeping what was already reported.
    async fn watch_mutation(
        &self,
        worker: &str,
        route: crate::owner::notifications::ReturnRoute,
    ) -> Result<Mutation, StoreError> {
        let key = watch_key(worker);
        // Read the record itself: one an earlier build wrote may no longer decode, and a
        // refresh has to be able to replace it. What it had reported is then unknown.
        let record = self.storage.read(key.clone()).await?;
        let revision = record.as_ref().map(|record| record.revision);
        let notified = record
            .and_then(|record| record.data.value().cloned())
            .and_then(|value| serde_json::from_value::<Watch>(value).ok())
            .and_then(|watch| watch.notified);
        let binding = route.binding_model();
        let watch = Watch {
            model: ModelSelection {
                connection_id: binding.connection_id.clone(),
                model_id: binding.model.clone(),
            },
            thinking_level: route.thinking_level(),
            workspace: route.workspace.clone(),
            binding: route.binding,
            notified,
        };
        Self::mutation(key, revision, &watch)
    }
    /// Every stored watch with its revision. A record that does not decode is returned as
    /// its error, so the caller can still retire it when its worker is gone.
    async fn watches(
        &self,
    ) -> Result<Vec<(String, Option<u64>, Result<Watch, StoreError>)>, StoreError> {
        let mut found = Vec::new();
        let mut after = None;
        loop {
            let page = self
                .storage
                .scan(Scan {
                    prefix: WATCH_PREFIX.into(),
                    after: after.take(),
                })
                .await?;
            for entry in page.entries {
                if let Some(value) = entry.record.data.value() {
                    let worker = entry.key[WATCH_PREFIX.len()..].to_owned();
                    let watch = serde_json::from_value(value.clone())
                        .map_err(|error| StoreError::Unavailable(error.to_string()));
                    found.push((worker, Some(entry.record.revision), watch));
                }
            }
            match page.next_after {
                Some(next) => after = Some(next),
                None => return Ok(found),
            }
        }
    }

    async fn forget(&self, worker: &str, revision: Option<u64>) -> Result<(), StoreError> {
        self.storage
            .batch(vec![Mutation {
                key: watch_key(worker),
                expected_revision: revision,
                data: Data::Deleted,
            }])
            .await
            .map(drop)
    }
}

impl Owner {
    pub(in crate::owner) async fn prepare_bot_watch(
        &self,
        scope: &maka_capabilities::call::Scope,
        worker: &str,
    ) -> Result<Vec<Mutation>, String> {
        let Some(source) = scope.identity.agent() else {
            return Ok(Vec::new());
        };
        if self.settings.bot {
            self.bot.load().await.map_err(|error| error.to_string())?;
        }
        if !self.bot.is(&source.session_id) || !self.owns(worker) {
            return Ok(Vec::new());
        }
        let route = self.return_route(source).await?;
        self.bot
            .watch_mutation(worker, route)
            .await
            .map(|mutation| vec![mutation])
            .map_err(|error| error.to_string())
    }

    /// Native workers inherit the Bot's admitted model; an explicitly selected
    /// executor remains a different backend and goes through ordinary admission.
    /// Source-specific thinking levels stay only when they already name that model.
    pub(crate) async fn use_bot_model(
        &self,
        scope: &maka_capabilities::call::Scope,
        backend: Option<crate::contract::BackendPreference>,
    ) -> Result<Option<crate::contract::BackendPreference>, String> {
        if matches!(
            backend,
            Some(crate::contract::BackendPreference::Executor { .. })
        ) {
            return Ok(backend);
        }
        let Some(source) = scope.identity.agent() else {
            return Ok(backend);
        };
        if !self.bot.is(&source.session_id) {
            return Ok(backend);
        }
        let route = self.return_route(source).await?;
        let binding = route.binding_model();
        let thinking_level = match &backend {
            Some(crate::contract::BackendPreference::Model {
                connection_id,
                model_id,
                thinking_level,
            }) if *connection_id == binding.connection_id && *model_id == binding.model => {
                *thinking_level
            }
            _ => None,
        };
        Ok(Some(crate::contract::BackendPreference::Model {
            connection_id: binding.connection_id.clone(),
            model_id: binding.model.clone(),
            thinking_level,
        }))
    }

    pub(in crate::owner) fn start_bot_wake(self: &Arc<Self>) {
        if !self.settings.bot {
            return;
        }
        let owner = self.clone();
        self.background(move |stop| async move {
            let mut commits = owner.store.subscribe_changes();
            let mut previous_error = None;
            loop {
                if stop.is_cancelled() {
                    return;
                }
                let Some(producer) = owner.producer().await else {
                    return;
                };
                let result = async {
                    owner.bot.load().await.map_err(|error| error.to_string())?;
                    owner.wake_bot_pass().await
                }
                .await;
                drop(producer);
                match result {
                    Ok(()) => previous_error = None,
                    Err(error) => {
                        if previous_error.as_ref() != Some(&error) && !stop.is_cancelled() {
                            eprintln!("Bot worker wake: {error}");
                        }
                        previous_error = Some(error);
                    }
                }
                tokio::select! {
                    () = stop.cancelled() => return,
                    () = tokio::time::sleep(POLL) => {},
                    result = commits.changed() => if result.is_err() { return; },
                }
                // Coalesce streaming writes into one pass.
                tokio::select! {
                    () = stop.cancelled() => return,
                    () = tokio::time::sleep(Duration::from_millis(250)) => {},
                }
                commits.borrow_and_update();
            }
        });
    }

    /// Report each finished worker run to the Bot once. A Bot that is busy keeps the
    /// report pending; it is retried on the next pass.
    async fn wake_bot_pass(self: &Arc<Self>) -> Result<(), String> {
        let Some(bot) = self.bot.session() else {
            return Ok(());
        };
        let mut unreadable = Vec::new();
        for (worker, revision, watch) in self.bot.watches().await.map_err(|e| e.to_string())? {
            let stored = self
                .store
                .get_session::<StoredSessionConfiguration>(&worker)
                .await
                .map_err(|_| "agent_store_unavailable")?;
            let Some(stored) = stored.filter(|stored| {
                !stored.archived
                    && stored.configuration.parent_session_id.as_deref() == Some(bot.as_str())
            }) else {
                self.bot
                    .forget(&worker, revision)
                    .await
                    .map_err(|e| e.to_string())?;
                continue;
            };
            // A worker that is gone was retired above without decoding anything. For a live
            // one an unreadable watch is reported, and the worker's next refresh replaces it.
            let watch = match watch {
                Ok(watch) => watch,
                Err(error) => {
                    unreadable.push(format!("watch for {worker}: {error}"));
                    continue;
                }
            };
            if self.runs.lock().await.busy(&worker) {
                continue;
            }
            let Some(run) = self
                .durable
                .latest_run(worker.clone())
                .await
                .map_err(|e| e.to_string())?
            else {
                continue;
            };
            let view = self
                .durable
                .frontier(run)
                .await
                .map_err(|e| e.to_string())?;
            let result = match view.terminal {
                Some(Terminal::Completed) => WorkerResult::Completed,
                Some(Terminal::Failed) => WorkerResult::Failed,
                Some(Terminal::Cancelled) => WorkerResult::Cancelled,
                None => continue,
            };
            if watch.notified == Some(run) {
                continue;
            }
            let identity = hex::encode(Sha256::digest(
                format!("bot-worker/{worker}/{run}").as_bytes(),
            ))[..32]
                .to_owned();
            let Some(bot_run) = self
                .durable
                .latest_run(bot.clone())
                .await
                .map_err(|e| e.to_string())?
            else {
                continue;
            };
            let bot_view = self
                .durable
                .frontier(bot_run)
                .await
                .map_err(|e| e.to_string())?;
            let source = ExecutionIdentity {
                session_id: bot.clone(),
                turn_id: bot_view.spec.turn_id,
                run_id: bot_run,
            };
            let run_label = run.to_string();
            let title = stored.configuration.title.clone();
            // The Bot's model as it is now, not as it was when the watch was written.
            let route = match crate::model::Source::select(
                self.configuration.clone(),
                self.catalog.clone(),
                self.credentials.clone(),
                watch.model.clone(),
                watch.thinking_level,
                bot.clone(),
                self.revision.clone(),
            )
            .await
            {
                Ok((model, _)) => crate::owner::notifications::ReturnRoute::new(
                    model.accepted,
                    watch.workspace.clone(),
                    watch.binding,
                ),
                Err(error) => {
                    unreadable.push(format!("model for {worker}: {}", public_error(error)));
                    continue;
                }
            };
            let Some(admission) = self
                .prepare_notification(
                    &source,
                    &route,
                    &identity,
                    |language| worker_message(language, &worker, &title, &run_label, result),
                    MessageOrigin::BotWorker {
                        session_id: worker.clone(),
                    },
                )
                .await?
            else {
                continue;
            };
            if self.admit_notification(&admission).await? {
                let next = Watch {
                    notified: Some(run),
                    ..watch
                };
                match self
                    .bot
                    .storage
                    .batch(vec![
                        Bot::mutation(watch_key(&worker), revision, &next)
                            .map_err(|e| e.to_string())?,
                    ])
                    .await
                {
                    Ok(_) => {}
                    // A concurrent refresh keeps the older report marker; the original
                    // message identity makes a repeat admission a no-op.
                    Err(StoreError::Conflict { .. }) => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
        // The caller reports a repeated error once.
        if unreadable.is_empty() {
            Ok(())
        } else {
            Err(unreadable.join("\n"))
        }
    }
}

#[derive(Clone, Copy)]
enum WorkerResult {
    Completed,
    Failed,
    Cancelled,
}

fn worker_message(
    language: Language,
    worker: &str,
    title: &str,
    invocation: &str,
    result: WorkerResult,
) -> String {
    match language {
        Language::ZhCn => {
            let what = match result {
                WorkerResult::Completed => "已结束",
                WorkerResult::Failed => "失败了",
                WorkerResult::Cancelled => "被停止了",
            };
            format!(
                "你派出的会话「{title}」（{worker}）这一轮{what}（执行编号 {invocation}）。先用会话读取工具看它的实际结果，再决定是否告诉用户、是否继续派活；不要凭这条通知转述结果。"
            )
        }
        Language::ZhTw => {
            let what = match result {
                WorkerResult::Completed => "已結束",
                WorkerResult::Failed => "失敗了",
                WorkerResult::Cancelled => "被停止了",
            };
            format!(
                "你派出的會話「{title}」（{worker}）這一輪{what}（執行編號 {invocation}）。先用會話讀取工具看它的實際結果，再決定是否告訴使用者、是否繼續派活；不要憑這則通知轉述結果。"
            )
        }
        _ => {
            let what = match result {
                WorkerResult::Completed => "finished",
                WorkerResult::Failed => "failed",
                WorkerResult::Cancelled => "was stopped",
            };
            format!(
                "The conversation you delegated to, \"{title}\" ({worker}), {what} its latest run (invocation {invocation}). Read its actual result with the conversation read tools before deciding whether to tell the user or hand out more work; do not relay a result from this notice alone."
            )
        }
    }
}
