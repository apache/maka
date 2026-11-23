/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use super::watch_inputs::WatchAuthority;
use super::*;
use futures_util::{StreamExt, stream};
use maka_agent_facts::discovery::{WatchId, WatchKind, WatchRecord, WatchTrigger};
use maka_agent_state::discovery::guards::{ScheduledWatch, WatchCheck};
use serde_json::json;
use std::io;
use tokio::sync::{broadcast, watch};

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct RegisterWatch {
    topic_id: TopicId,
    on_trigger: WatchTrigger,
    expires_at: Option<UnixMillis>,
    #[serde(flatten)]
    spec: WatchSpec,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WatchSpec {
    FileHash {
        target: String,
        predicate: FilePredicate,
    },
    HttpCheck {
        target: String,
        predicate: HttpPredicate,
        interval_secs: Option<u64>,
    },
    Deadline {
        target: Option<String>,
        predicate: DeadlinePredicate,
    },
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct FilePredicate {
    expected_hash: Option<String>,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct DeadlinePredicate {
    trigger_at_ms: i64,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct HttpPredicate {
    status_code: Option<u16>,
    contains_text: Option<String>,
    not_contains_text: Option<String>,
    json_pointer_equals: Option<PointerEquals>,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct PointerEquals {
    pointer: String,
    value: Value,
}

impl HttpPredicate {
    fn validate(&self) -> Result<(), String> {
        if self.status_code.is_none()
            && self.contains_text.is_none()
            && self.not_contains_text.is_none()
            && self.json_pointer_equals.is_none()
        {
            return Err("provide at least one HTTP predicate".into());
        }
        if self.status_code.is_some_and(|s| !(100..=599).contains(&s))
            || [&self.contains_text, &self.not_contains_text]
                .into_iter()
                .flatten()
                .any(String::is_empty)
            || self
                .json_pointer_equals
                .as_ref()
                .is_some_and(|p| !p.pointer.is_empty() && !p.pointer.starts_with('/'))
        {
            return Err("invalid HTTP predicate".into());
        }
        Ok(())
    }
    fn matches(&self, status: u16, body: &[u8]) -> Result<bool, String> {
        if !self
            .status_code
            .map_or((200..300).contains(&status), |s| s == status)
        {
            return Ok(false);
        }
        if self.contains_text.is_some() || self.not_contains_text.is_some() {
            let text = std::str::from_utf8(body).map_err(reason)?;
            if self
                .contains_text
                .as_ref()
                .is_some_and(|s| !text.contains(s))
                || self
                    .not_contains_text
                    .as_ref()
                    .is_some_and(|s| text.contains(s))
            {
                return Ok(false);
            }
        }
        if let Some(p) = &self.json_pointer_equals {
            return Ok(serde_json::from_slice::<Value>(body)
                .map_err(reason)?
                .pointer(&p.pointer)
                == Some(&p.value));
        }
        Ok(true)
    }
}

pub(in crate::owner) struct WatchRunner {
    pub(super) changes: watch::Sender<()>,
    pub(super) paths: broadcast::Sender<String>,
    http_min: Duration,
    #[cfg(test)]
    pub(in crate::owner) file_checks: tokio::sync::Mutex<()>,
    http: std::sync::Mutex<Option<(maka_config::network::NetworkConfiguration, reqwest::Client)>>,
}
impl Default for WatchRunner {
    fn default() -> Self {
        Self {
            changes: watch::channel(()).0,
            paths: broadcast::channel(256).0,
            http_min: Duration::from_secs(10),
            #[cfg(test)]
            file_checks: Default::default(),
            http: Default::default(),
        }
    }
}
impl WatchRunner {
    #[cfg(test)]
    pub(in crate::owner) fn set_test_interval(&mut self, min: Duration) {
        self.http_min = min;
    }
    pub(super) fn wake(&self) {
        self.changes.send_modify(|_| {})
    }
}

impl Owner {
    pub(super) async fn register_watch(
        &self,
        context: &ToolCallContext,
        input: RegisterWatch,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let authority = self
            .watch_authority(context, REGISTER, &input.topic_id)
            .await?;
        let at = UnixMillis(now() as i64);
        if input.expires_at.is_some_and(|end| end <= at) {
            return Err(ToolError::Failed("watch already expired".into()));
        }
        let (kind, target, predicate, baseline, interval, due) = match input.spec {
            WatchSpec::FileHash {
                target,
                mut predicate,
            } => {
                let inputs = self
                    .watch_inputs(&authority, input.topic_id.clone())
                    .await
                    .map_err(ToolError::Failed)?;
                let (key, hash) =
                    tokio::task::spawn_blocking(move || inputs.hash(&target, &cancel))
                        .await
                        .map_err(|e| ToolError::Failed(reason(e)))?
                        .map_err(|e| ToolError::Failed(reason(e)))?;
                if let Some(expected) = &mut predicate.expected_hash {
                    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Err(ToolError::Failed("expected a SHA-256 hex digest".into()));
                    }
                    expected.make_ascii_lowercase();
                }
                let baseline = predicate.expected_hash.clone().unwrap_or(hash);
                (
                    WatchKind::FileHash,
                    key,
                    json!(predicate),
                    Some(baseline),
                    30_000,
                    at.0,
                )
            }
            WatchSpec::Deadline { target, predicate } => {
                if predicate.trigger_at_ms <= 0 {
                    return Err(ToolError::Failed("invalid deadline".into()));
                }
                (
                    WatchKind::Deadline,
                    target.unwrap_or_default(),
                    json!(predicate),
                    None,
                    1,
                    predicate.trigger_at_ms,
                )
            }
            WatchSpec::HttpCheck {
                target,
                predicate,
                interval_secs,
            } => {
                predicate.validate().map_err(ToolError::Failed)?;
                let url = reqwest::Url::parse(&target).map_err(|e| ToolError::Failed(reason(e)))?;
                if !matches!(url.scheme(), "http" | "https")
                    || url.host().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err(ToolError::Failed(
                        "expected HTTP(S) URL without credentials".into(),
                    ));
                }
                let destination = maka_sandbox::Destination::new(
                    url.host_str().expect("validated host"),
                    url.port_or_known_default()
                        .ok_or_else(|| ToolError::Failed("invalid watch port".into()))?,
                )
                .map_err(|e| ToolError::Failed(reason(e)))?;
                if !authority.effect_ceiling.network().allows(&destination) {
                    return Err(ToolError::Failed(
                        "HTTP watch outside authorized network".into(),
                    ));
                }
                let interval = Duration::from_secs(interval_secs.unwrap_or(60));
                if interval < self.watch_runner.http_min || interval.as_millis() > i64::MAX as u128
                {
                    return Err(ToolError::Failed(format!(
                        "invalid polling interval (minimum {} seconds)",
                        self.watch_runner.http_min.as_secs()
                    )));
                }
                (
                    WatchKind::HttpCheck,
                    url.to_string(),
                    json!(predicate),
                    None,
                    interval.as_millis() as i64,
                    at.0,
                )
            }
        };
        let watch_key = serde_json::to_vec(&(
            &authority,
            &input.topic_id,
            kind,
            &target,
            &predicate,
            input.on_trigger,
            input.expires_at,
            interval,
        ))
        .map_err(|e| ToolError::Failed(reason(e)))?;
        let id = WatchId(crate::tools::native_operation_uuid(&watch_key).to_string());
        self.discovery
            .register_watch(
                ScheduledWatch {
                    watch: WatchRecord {
                        watch_id: id.clone(),
                        topic_id: input.topic_id,
                        kind,
                        target,
                        predicate,
                        on_trigger: input.on_trigger,
                        last_state_hash: baseline,
                        expires_at: input.expires_at,
                        created_at: at,
                        updated_at: at,
                    },
                    authority: json!(authority),
                    interval_ms: interval,
                    action_id: None,
                },
                UnixMillis(due),
            )
            .await
            .map_err(dossiers::write_error)?;
        self.watch_runner.wake();
        Ok(json!({"watch_id":id}))
    }

    pub(in crate::owner) fn start_watch_runner(self: &Arc<Self>) {
        for kind in [
            WatchKind::HttpCheck,
            WatchKind::FileHash,
            WatchKind::Deadline,
        ] {
            let owner = self.clone();
            self.producers
                .spawn(async move { owner.watch_loop(kind).await });
        }
        let owner = self.clone();
        self.producers
            .spawn(async move { owner.followup_loop().await });
    }
    async fn watch_loop(&self, kind: WatchKind) {
        let mut changes = self.watch_runner.changes.subscribe();
        let mut paths = self.watch_runner.paths.subscribe();
        loop {
            if self.stop.is_cancelled() {
                break;
            }
            changes.borrow_and_update();
            let next = match self.check_due_watches(kind).await {
                Ok(next) => next,
                Err(e) => {
                    tracing::warn!(%e,?kind,"Discovery watch sweep failed");
                    Some(now() as i64 + 5000)
                }
            };
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => break,
                first = paths.recv(), if kind == WatchKind::FileHash && next.is_some() => {
                    if let Err(error) = self.wake_watched_paths(first, &mut paths).await {
                        tracing::warn!(%error,"Could not wake discovery file watches");
                    }
                }
                _ = wait_until(next) => {}
                _ = changes.changed() => {}
            }
        }
    }
    async fn wake_watched_paths(
        &self,
        first: Result<String, broadcast::error::RecvError>,
        events: &mut broadcast::Receiver<String>,
    ) -> Result<(), String> {
        let mut affected = BTreeSet::new();
        if let Ok(path) = first {
            affected.insert(path);
        }
        for _ in 1..256 {
            match events.try_recv() {
                Ok(path) => {
                    affected.insert(path);
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
        let targets = affected.into_iter().collect();
        self.discovery
            .wake_file_watches(targets, UnixMillis(now() as i64))
            .await
            .map_err(reason)
    }
    async fn check_due_watches(&self, kind: WatchKind) -> Result<Option<i64>, String> {
        #[cfg(test)]
        let _file_checks = if kind == WatchKind::FileHash {
            Some(self.watch_runner.file_checks.lock().await)
        } else {
            None
        };
        let at = UnixMillis(now() as i64);
        if kind == WatchKind::Deadline {
            self.discovery.expire_actions(at).await.map_err(reason)?
        }
        let batch = self
            .discovery
            .due_watches(kind, at, 32)
            .await
            .map_err(reason)?;
        stream::iter(batch)
            .for_each_concurrent(4, |w| async move {
                let id = w.watch.watch_id.clone();
                let retry = w.interval_ms.max(1000);
                if let Err(e) = self.evaluate_watch(w).await
                    && !self.stop.is_cancelled()
                {
                    tracing::warn!(watch_id=%id.0,%e,"Discovery watch check unavailable");
                    if let Err(e) = self
                        .discovery
                        .reschedule_watch(id, Some((now() as i64).saturating_add(retry)))
                        .await
                    {
                        tracing::warn!(%e,"Could not reschedule discovery watch")
                    }
                }
            })
            .await;
        let next = self.discovery.next_watch_due(kind).await.map_err(reason)?;
        Ok(if kind == WatchKind::Deadline {
            next.into_iter()
                .chain(self.discovery.next_action_expiry().await.map_err(reason)?)
                .min()
        } else {
            next
        })
    }
    async fn evaluate_watch(&self, w: ScheduledWatch) -> Result<(), String> {
        if w.watch.expires_at.is_some_and(|end| end.0 <= now() as i64) {
            self.discovery
                .reschedule_watch(w.watch.watch_id, None)
                .await
                .map_err(reason)?;
            if w.watch.kind == WatchKind::FileHash {
                self.watch_runner.wake();
            }
            return Ok(());
        }
        let auth = WatchAuthority::deserialize(&w.authority).map_err(reason)?;
        let mut retry_after = None;
        let (hash, matched, method) = match w.watch.kind {
            WatchKind::FileHash => {
                let hash = match self.watch_inputs(&auth, w.watch.topic_id.clone()).await {
                    Ok(inputs) => {
                        let path = w.watch.target.clone();
                        let stop = self.stop.clone();
                        tokio::task::spawn_blocking(move || inputs.hash(&path, &stop))
                            .await
                            .map_err(reason)?
                    }
                    Err(error) if w.watch.on_trigger == WatchTrigger::InvalidateAction => {
                        Err(io::Error::other(error))
                    }
                    Err(error) => return Err(error),
                };
                let hash = match hash {
                    Ok((_, hash)) => hash,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => return Err(reason(e)),
                    Err(e)
                        if w.watch.on_trigger == WatchTrigger::InvalidateAction
                            || matches!(
                                e.kind(),
                                io::ErrorKind::NotFound | io::ErrorKind::InvalidInput
                            ) =>
                    {
                        "unavailable".into()
                    }
                    Err(e) => return Err(reason(e)),
                };
                let predicate = FilePredicate::deserialize(&w.watch.predicate).map_err(reason)?;
                let matched = predicate
                    .expected_hash
                    .as_ref()
                    .or(w.watch.last_state_hash.as_ref())
                    .is_some_and(|s| s != &hash);
                (hash, matched, "file_hash SHA-256")
            }
            WatchKind::HttpCheck => {
                check_target(&self.session(&auth.target.session_id).await?, &auth.target)?;
                let predicate = HttpPredicate::deserialize(&w.watch.predicate).map_err(reason)?;
                let client = self.watch_http_client().await?;
                let get = async {
                    let mut response = client
                        .get(&w.watch.target)
                        .timeout(Duration::from_secs(6))
                        .send()
                        .await
                        .map_err(reason)?;
                    let status = response.status().as_u16();
                    if matches!(status, 429 | 503) {
                        retry_after = response
                            .headers()
                            .get(reqwest::header::RETRY_AFTER)
                            .and_then(|value| value.to_str().ok())
                            .and_then(|s| {
                                if let Ok(delta) = s.parse::<i64>() {
                                    Some((now() as i64).saturating_add(delta.saturating_mul(1000)))
                                } else {
                                    jiff::fmt::rfc2822::parse(s)
                                        .ok()
                                        .map(|at| at.timestamp().as_millisecond())
                                }
                            });
                    }
                    let mut bytes = Vec::new();
                    if predicate.contains_text.is_some()
                        || predicate.not_contains_text.is_some()
                        || predicate.json_pointer_equals.is_some()
                    {
                        while let Some(chunk) = response.chunk().await.map_err(reason)? {
                            if bytes.len() + chunk.len() > 1024 * 1024 {
                                return Err("HTTP watch body exceeds 1 MiB".into());
                            }
                            bytes.extend_from_slice(&chunk)
                        }
                    }
                    tokio::task::spawn_blocking(move || predicate.matches(status, &bytes))
                        .await
                        .map_err(reason)?
                };
                let matched =
                    tokio::select! {_ = self.stop.cancelled()=>return Ok(()), result=get=>result?};
                // Only the observed predicate can cause an interrupt. Advertising, timestamps and unrelated JSON fields cannot.
                (
                    hex::encode(Sha256::digest([u8::from(matched)])),
                    matched,
                    "http_check GET",
                )
            }
            WatchKind::Deadline => {
                check_target(&self.session(&auth.target.session_id).await?, &auth.target)?;
                let p = DeadlinePredicate::deserialize(&w.watch.predicate).map_err(reason)?;
                if (now() as i64) < p.trigger_at_ms {
                    return self
                        .discovery
                        .reschedule_watch(w.watch.watch_id, Some(p.trigger_at_ms))
                        .await
                        .map_err(reason);
                }
                (
                    "fired".into(),
                    w.watch.last_state_hash.is_none(),
                    "deadline",
                )
            }
        };
        let at = UnixMillis(now() as i64);
        let reason = format!(
            "{method} · {} · observed_at {}",
            w.watch.target,
            context::timestamp(at.0 as u64).ok_or("invalid observation time")?
        );
        let next =
            at.0.saturating_add(w.interval_ms)
                .max(retry_after.unwrap_or(0));
        let followup = matched
            && w.watch.on_trigger == WatchTrigger::EnqueueFollowup
            && w.watch.last_state_hash.as_ref() != Some(&hash);
        self.discovery
            .observe_watch(
                w,
                WatchCheck {
                    state_hash: hash,
                    matched,
                    observed_at: at,
                    reason,
                },
                next,
            )
            .await
            .map_err(self::reason)?;
        if followup {
            self.watch_runner.wake()
        }
        Ok(())
    }
    async fn watch_http_client(&self) -> Result<reqwest::Client, String> {
        let net = self
            .configuration
            .network_configuration()
            .await
            .map_err(reason)?;
        if let Some((_, client)) = self
            .watch_runner
            .http
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(cached, _)| cached.proxy == net.proxy && cached.password == net.password)
        {
            return Ok(client.clone());
        }
        let (net, client) = tokio::task::spawn_blocking(move || {
            let policy =
                maka_network::Policy::from_host_settings(&net.proxy, net.password.as_deref())
                    .map_err(reason)?;
            let client = policy
                .client_builder()
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("Apache-Maka/Discovery")
                .build()
                .map_err(reason)?;
            Ok::<_, String>((net, client))
        })
        .await
        .map_err(reason)??;
        *self.watch_runner.http.lock().unwrap() = Some((net, client.clone()));
        Ok(client)
    }
    async fn followup_loop(&self) {
        let mut changes = self.watch_runner.changes.subscribe();
        let mut schedules = self.schedule_changes();
        loop {
            if self.stop.is_cancelled() {
                return;
            }
            changes.borrow_and_update();
            schedules.borrow_and_update();
            let retry = match self.dispatch_watch_followup().await {
                Ok(()) => None,
                Err(error) => {
                    tracing::warn!(%error,"Discovery follow-up scheduling failed");
                    Some(now() as i64 + 5000)
                }
            };
            tokio::select! {_=self.stop.cancelled()=>return,_=changes.changed()=>{},_=schedules.changed()=>{},_=wait_until(retry)=>{}}
        }
    }
    async fn dispatch_watch_followup(&self) -> Result<(), String> {
        if self.scheduler.investigation.read().unwrap().is_some() {
            return Ok(());
        }
        let pending = self
            .discovery
            .pending_watch_followups()
            .await
            .map_err(reason)?;
        if pending.is_empty() {
            return Ok(());
        }
        let _gate = self.scheduler.gate.lock().await;
        let catalog = self.scheduler.load_change_plans().await?;
        if self.scheduler.investigation.read().unwrap().is_some() || catalog.has_pending_discovery()
        {
            return Ok(());
        }
        let at = now() as i64;
        for (id, topic, observed, auth) in pending {
            let auth: WatchAuthority = serde_json::from_value(auth).map_err(reason)?;
            for saved in catalog.plans.values() {
                let plan = &saved.plan;
                let Some((approval, _)) = scheduler::file_change_grant(plan) else {
                    continue;
                };
                if plan.task.expires_at.is_some_and(|end| end <= at)
                    || auth.plan.as_ref().is_some_and(|id| id != &plan.task.id)
                    || approval.target.workspace != auth.target.workspace
                {
                    continue;
                }
                let session = match self.session(&approval.target.session_id).await {
                    Ok(session) => session,
                    Err(error) if error == "agent_session_unavailable" => continue,
                    Err(error) => return Err(error),
                };
                if check_target(&session, &approval.target).is_err() {
                    continue;
                }
                let mut plan = plan.clone();
                if plan
                    .claim_preserving_schedule(at, FireSource::Watch)
                    .map_err(reason)?
                    .is_none()
                {
                    continue;
                }
                let fire = plan.pending.as_mut().expect("just claimed");
                fire.intent = maka_scheduler::task::Intent::Text {
                    body: format!(
                        "Review dossier {} after its watch matched at {}.\n{}",
                        topic.0,
                        observed.0,
                        fire.intent.body()
                    ),
                };
                let writes = catalog.watch_fire(&plan)?;
                self.commit_discovery_writes(
                    self.discovery.acknowledge_followup(id, observed),
                    writes,
                )
                .await
                .map_err(reason)?;
                self.scheduler.notify_status_changed();
                self.scheduler.wake.notify_one();
                return Ok(());
            }
        }
        Ok(())
    }
}
async fn wait_until(at: Option<i64>) {
    match at {
        Some(at) => {
            tokio::time::sleep(
                Duration::from_millis(at.max(0) as u64)
                    .saturating_sub(Duration::from_millis(now())),
            )
            .await
        }
        None => std::future::pending().await,
    }
}
