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
use maka_agent_facts::event::InvocationOutcome;
use maka_event_log::turns::InvocationState;

const WATCH_PREFIX: &str = "watch/";
const POLL: Duration = Duration::from_secs(2);

fn watch_key(worker: &str) -> String {
    format!("{WATCH_PREFIX}{worker}")
}

/// One worker the Bot waits on. `route` is the Bot's model and workspace as of its
/// latest call about this worker, which is what a wake needs to start a Turn.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Watch {
    route: crate::owner::notifications::ReturnRoute,
    /// The last finished invocation already reported to the Bot.
    notified: Option<String>,
}

impl Bot {
    /// Record or refresh the watch for `worker`, keeping what was already reported.
    async fn watch(
        &self,
        worker: &str,
        route: crate::owner::notifications::ReturnRoute,
    ) -> Result<(), StoreError> {
        let key = watch_key(worker);
        let (revision, current) = self.read::<Watch>(&key).await?;
        let watch = Watch {
            route,
            notified: current.and_then(|watch| watch.notified),
        };
        self.storage
            .batch(vec![Self::mutation(key, revision, &watch)?])
            .await
            .map(drop)
    }
    async fn watches(&self) -> Result<Vec<(String, Option<u64>, Watch)>, StoreError> {
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
                        .map_err(|error| StoreError::Unavailable(error.to_string()))?;
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
    /// After the Bot creates or sends to a conversation, remember to wake it when
    /// that conversation finishes. Best effort: the effect already happened, and
    /// the next send refreshes the watch.
    pub(crate) async fn bot_watch(&self, scope: &maka_capabilities::call::Scope, worker: &str) {
        let Some(source) = scope.identity.agent() else {
            return;
        };
        if !self.bot.is(&source.session_id) || !self.owns(worker) {
            return;
        }
        let result = async {
            let route = self.return_route(source).await?;
            self.bot
                .watch(worker, route)
                .await
                .map_err(|error| error.to_string())
        }
        .await;
        if let Err(error) = result {
            eprintln!("Bot worker watch: {error}");
        }
    }

    /// A worker runs on the model the Bot itself is running on. A model selection
    /// carries the connection's revision, which the Bot cannot know, so whatever
    /// it supplied is replaced with the current selection of its own model. When
    /// that cannot be resolved the supplied value is left for normal validation.
    pub(crate) async fn use_bot_model(
        &self,
        scope: &maka_capabilities::call::Scope,
        model: &mut crate::contract::ModelSelection,
    ) {
        let Some(source) = scope.identity.agent() else {
            return;
        };
        if !self.bot.is(&source.session_id) {
            return;
        }
        let Ok(route) = self.return_route(source).await else {
            return;
        };
        let binding = route.binding_model();
        let Ok(catalog) = self.configuration.catalog().await else {
            return;
        };
        if let Some(entry) = catalog
            .connections
            .iter()
            .find(|entry| entry.connection_id == binding.connection_id)
            .filter(|entry| entry.enabled_model_ids.contains(&binding.model))
        {
            *model = crate::contract::ModelSelection {
                connection_id: entry.connection_id.clone(),
                revision: entry.revision,
                model_id: binding.model.clone(),
            };
        }
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
                let result = owner.wake_bot_pass().await;
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
            if self.runs.lock().await.busy(&worker) {
                continue;
            }
            let Some(boundary) = self
                .store
                .session(&worker)
                .await
                .map_err(|error| error.to_string())?
                .latest_turn_boundary(&worker)
                .await
                .map_err(|_| "agent_execution_unavailable")?
            else {
                continue;
            };
            let invocation_id = boundary.invocation.invocation_id.clone();
            let InvocationState::Ended { outcome, .. } = &boundary.state else {
                continue;
            };
            let result = match outcome {
                InvocationOutcome::Completed => WorkerResult::Completed,
                InvocationOutcome::Failed { .. } => WorkerResult::Failed,
                InvocationOutcome::Cancelled { .. } => WorkerResult::Cancelled,
                // A pause or a context compaction is not a result of the work.
                InvocationOutcome::HandoffPaused { .. }
                | InvocationOutcome::ContextCompactFinished { .. } => continue,
            };
            if watch.notified.as_deref() == Some(invocation_id.as_str()) {
                continue;
            }
            let identity = hex::encode(Sha256::digest(
                format!("bot-worker/{worker}/{invocation_id}").as_bytes(),
            ))[..32]
                .to_owned();
            let source = Invocation {
                session_id: bot.clone(),
                turn_id: format!("t_{identity}"),
                run_id: format!("r_{identity}"),
                invocation_id: format!("i_{identity}"),
            };
            let title = stored.configuration.title.clone();
            let Some(admission) = self
                .prepare_notification(
                    &source,
                    &watch.route,
                    &identity,
                    |language| worker_message(language, &worker, &title, &invocation_id, result),
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
                    route: watch.route,
                    notified: Some(invocation_id),
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
        Ok(())
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
