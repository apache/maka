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

use crate::goal::{Arm, Control, Error, Goal, Meter, Report, Repository, Saved, Status, invalid};
use maka_agent_facts::event::Invocation;
use maka_agent_facts::language::Language;
use maka_agent_ports::execution::Progress;
use maka_agent_ports::usage;
use maka_capabilities::authorization::Capability;
use maka_capabilities::authorization::CommandError;
use maka_capabilities::authorization::Id;
use maka_capabilities::authorization::Target;
use maka_capabilities::background::BackgroundWork;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
pub struct Owner {
    pub executions: Arc<dyn maka_agent_ports::execution::Access>,
    authorizations: Arc<dyn maka_capabilities::authorization::Access>,
    preferences: Arc<dyn maka_agent_ports::preferences::Preferences>,
    usage: Arc<dyn usage::Usage>,
    pub repo: Repository,
    gate: Mutex<()>,
    pending: AtomicBool,
    wake: Notify,
    /// Moves on every durable Goal write, for views that follow it.
    pub revisions: tokio::sync::watch::Sender<u64>,
}
impl BackgroundWork for Owner {
    fn is_pending(&self) -> bool {
        self.pending.load(Ordering::Acquire)
    }
    fn wake(&self) {
        self.wake.notify_one()
    }
}
impl Owner {
    pub fn new(
        storage: Arc<dyn maka_capabilities::storage::Store>,
        executions: Arc<dyn maka_agent_ports::execution::Access>,
        authorizations: Arc<dyn maka_capabilities::authorization::Access>,
        preferences: Arc<dyn maka_agent_ports::preferences::Preferences>,
        usage: Arc<dyn usage::Usage>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repo: Repository::new(storage),
            executions,
            authorizations,
            preferences,
            usage,
            gate: Mutex::new(()),
            pending: AtomicBool::new(true),
            wake: Notify::new(),
            revisions: tokio::sync::watch::channel(0).0,
        })
    }
    /// A write that views following Goals should see.
    fn written(&self) {
        self.revisions.send_modify(|revision| *revision += 1);
    }
    pub fn changed(&self) {
        self.pending.store(true, Ordering::Release);
        self.wake.notify_one();
    }
    pub async fn privacy(&self) -> Result<(), Error> {
        if self
            .preferences
            .read()
            .await
            .map_err(invalid)?
            .privacy
            .incognito_active
        {
            Err(invalid("Goal continuation is disabled in incognito mode"))
        } else {
            Ok(())
        }
    }
    pub async fn grant(&self, id: Id, session: &str) -> Result<(), Error> {
        let owned = self.authorizations.open(id).await?;
        let valid = owned.grant.request.target
            == Target::Session {
                session_id: session.into(),
            }
            && [Capability::Executions, Capability::ReadUsage]
                .iter()
                .all(|c| owned.grant.request.capabilities.contains(c));
        owned.call.finish().await?;
        if valid {
            Ok(())
        } else {
            Err(invalid(
                "Approve execution and usage access for this Session in Goal settings",
            ))
        }
    }
    pub async fn meter(&self, id: Id, session: &str) -> Result<Meter, Error> {
        let owned = self.authorizations.open(id).await?;
        let result = async {
            let page = self
                .usage
                .activity(
                    owned.call.scope(),
                    usage::Read::Start {
                        filter: usage::Filter {
                            from: 0.0,
                            to: 253402300799999.0,
                            session_id: Some(session.into()),
                            activity: Default::default(),
                        },
                    },
                )
                .await?;
            let summary = self.usage.summary(owned.call.scope(), page.cursor).await?;
            Ok::<_, Error>(Meter {
                known: summary
                    .models
                    .input
                    .known
                    .saturating_add(summary.models.output.known),
                missing: summary
                    .models
                    .input
                    .missing
                    .saturating_add(summary.models.output.missing),
            })
        }
        .await;
        owned.call.finish().await?;
        result
    }
    pub async fn arm(&self, session: &str, arm: Arm) -> Result<Goal, Error> {
        self.privacy().await?;
        self.grant(arm.grant, session).await?;
        // A retry is a read of the original durable intent, even while it is running.
        if let Some(saved) = self.repo.read(session).await?
            && saved.goal.id == arm.operation_id
        {
            let _gate = self.gate.lock().await;
            return self.repo.arm(session, arm, saved.goal.baseline).await;
        }
        let commands = self.executions.restore(arm.grant).await?;
        if commands.activity(session.into()).await?.busy {
            return Err(invalid(
                "Wait for the current Session execution to settle before creating a Goal",
            ));
        }
        let baseline = self.meter(arm.grant, session).await?;
        let _gate = self.gate.lock().await;
        let goal = self.repo.arm(session, arm, baseline).await?;
        self.written();
        self.changed();
        Ok(goal)
    }
    pub async fn control(
        &self,
        session: &str,
        id: uuid::Uuid,
        revision: u64,
        action: Control,
        grant: Option<Id>,
    ) -> Result<Goal, Error> {
        let mut saved = self
            .repo
            .read(session)
            .await?
            .ok_or_else(|| invalid("No Goal"))?;
        if saved.revision != revision || saved.goal.id != id {
            return Err(invalid("Goal changed; refresh before applying control"));
        }
        if let Some(grant) = grant {
            if !matches!(action, Control::Resume | Control::Cancel) {
                return Err(invalid(
                    "A renewed grant is only accepted with resume or cancel",
                ));
            }
            self.grant(grant, session).await?;
            saved.goal.arm.grant = grant;
            saved.goal.authority_blocked = false;
        }
        if action == Control::Resume {
            self.privacy().await?;
            self.grant(saved.goal.arm.grant, session).await?;
            let commands = self.executions.restore(saved.goal.arm.grant).await?;
            if commands
                .activity(session.into())
                .await?
                .execution
                .is_some_and(|e| matches!(e.progress, Progress::Paused))
            {
                return Err(invalid(
                    "Resume the paused Host execution through Session controls before resuming the Goal",
                ));
            }
            saved.goal.authority_blocked = false;
        }
        saved.goal.control(action)?;
        let goal = saved.goal.clone();
        let _gate = self.gate.lock().await;
        self.repo.save(saved).await?;
        self.written();
        self.changed();
        Ok(goal)
    }
    pub async fn report(&self, invocation: &Invocation, report: Report) -> Result<Goal, Error> {
        if report.note.trim().is_empty() || report.note.len() > 4096 {
            return Err(invalid("Provide a checkpoint or evidence of 1–4096 bytes"));
        }
        let mut saved = self
            .repo
            .read(&invocation.session_id)
            .await?
            .ok_or_else(|| invalid("No Goal"))?;
        if saved.goal.status != Status::Active {
            return Err(invalid("Goal is not active"));
        }
        let pending = saved
            .goal
            .pending
            .as_ref()
            .ok_or_else(|| invalid("No Goal-owned execution"))?;
        let commands = self.executions.restore(saved.goal.arm.grant).await?;
        let observation = commands.query(pending.request.operation()).await?;
        if observation.receipt.invocation != *invocation {
            return Err(invalid("This execution does not belong to the Goal"));
        }
        saved.goal.report = Some(report);
        let goal = saved.goal.clone();
        let _gate = self.gate.lock().await;
        self.repo.save(saved).await?;
        self.written();
        self.changed();
        Ok(goal)
    }
    pub async fn run(self: Arc<Self>, stop: CancellationToken) -> Result<(), String> {
        let mut sweep = 0_u64;
        loop {
            if stop.is_cancelled() {
                return Ok(());
            }
            let sessions = {
                let _gate = self.gate.lock().await;
                let sessions = self.repo.sessions().await;
                if let Ok(sessions) = &sessions {
                    self.pending.store(
                        sessions.iter().any(|saved| saved.goal.keeps_host_awake()),
                        Ordering::Release,
                    );
                }
                sessions
            };
            let sessions = match sessions {
                Ok(sessions) => sessions,
                Err(Error::Storage(maka_capabilities::storage::StoreError::Retired)) => {
                    return Ok(());
                }
                Err(_) => {
                    // A transient storage failure must not silently kill the owner.
                    self.pending.store(true, Ordering::Release);
                    tokio::select! {
                        _ = stop.cancelled() => return Ok(()),
                        _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
                    }
                    continue;
                }
            };
            for mut saved in sessions {
                if saved.goal.status == Status::CancellationUnknown && !sweep.is_multiple_of(60) {
                    continue;
                }
                if stop.is_cancelled() {
                    return Ok(());
                }
                if let Err(error) = self.tick(saved.clone()).await {
                    // No new operation identity on transient or uncertain outcomes.
                    if matches!(
                        error,
                        Error::Authority(
                            CommandError::Denied
                                | CommandError::Revoked
                                | CommandError::Invalid(_)
                                | CommandError::Conflict
                        )
                    ) {
                        // Failure belongs to the observed revision. A concurrent control,
                        // renewed grant or replacement Goal must not inherit it.
                        saved.goal.authority_blocked = true;
                        if saved.goal.status == Status::Active {
                            saved.goal.status = Status::Blocked;
                        }
                        saved.goal.note = error.to_string();
                        let _ = self.repo.save(saved).await;
                        self.written();
                    }
                }
            }
            sweep = sweep.wrapping_add(1);
            tokio::select! {
                _ = stop.cancelled() => return Ok(()),
                _ = self.wake.notified() => {},
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
            }
        }
    }
    async fn tick(&self, mut saved: Saved) -> Result<(), Error> {
        let session_id = saved.goal.session_id.clone();
        let session = session_id.as_str();
        let goal = &mut saved.goal;
        if goal.status == Status::Cancelled && goal.pending.as_ref().is_some_and(|p| !p.dispatched)
        {
            goal.pending = None;
            self.repo.save(saved).await?;
            self.written();
            return Ok(());
        }
        let commands = self.executions.restore(goal.arm.grant).await?;
        if let Some(pending) = goal.pending.clone() {
            let observation = match commands.query(pending.request.operation()).await {
                Ok(o) => o,
                Err(CommandError::NotFound) if goal.status == Status::Active => {
                    if self.privacy().await.is_err() {
                        goal.status = Status::Paused;
                        goal.note = (match goal.arm.language {
                            Language::En => "Incognito mode stopped Goal continuation",
                            Language::ZhCn => "隐私模式已停止目标继续执行",
                            Language::ZhTw => "隱私模式已停止目標繼續執行",
                        })
                        .into();
                        self.repo.save(saved).await?;
                        self.written();
                        return Ok(());
                    }
                    // Commit the dispatch boundary under the same short gate as controls.
                    // Never hold this gate while awaiting Host execution admission.
                    {
                        let _gate = self.gate.lock().await;
                        let mut current = self
                            .repo
                            .read(session)
                            .await?
                            .ok_or_else(|| invalid("Goal disappeared"))?;
                        if current.goal.id != goal.id || current.goal.status != Status::Active {
                            return Ok(());
                        }
                        let Some(next) = current.goal.pending.as_mut() else {
                            return Ok(());
                        };
                        if next.request != pending.request {
                            return Ok(());
                        }
                        next.dispatched = true;
                        self.repo.save(current).await?;
                        self.written();
                    }
                    let result = commands.submit(pending.request.clone()).await;
                    if matches!(
                        &result,
                        Err(CommandError::Busy
                            | CommandError::Draining
                            | CommandError::Denied
                            | CommandError::Revoked
                            | CommandError::Invalid(_)
                            | CommandError::Conflict)
                    ) {
                        let _gate = self.gate.lock().await;
                        if let Some(mut current) = self.repo.read(session).await?
                            && let Some(next) = current.goal.pending.as_mut()
                            && next.request == pending.request
                        {
                            next.dispatched = false;
                            self.repo.save(current).await?;
                            self.written();
                        }
                    }
                    result?;
                    // Cancellation can race the dispatch commitment. Settle it promptly
                    // after admission rather than waiting for the next owner sweep.
                    if let Some(current) = self.repo.read(session).await?
                        && current.goal.id == goal.id
                        && matches!(
                            current.goal.status,
                            Status::Cancelled | Status::CancellationUnknown
                        )
                    {
                        commands.cancel(pending.request.operation()).await?;
                    }
                    return Ok(());
                }
                Err(CommandError::NotFound) => {
                    if goal.status == Status::Cancelled {
                        if !pending.dispatched {
                            goal.pending = None;
                        } else {
                            goal.status = Status::CancellationUnknown;
                            goal.note = (match goal.arm.language {
                                Language::En => "Cancellation acceptance is unknown. Only the original receipt will be checked; no request is resubmitted. This does not keep Host awake.",
                                Language::ZhCn => "取消是否被接纳未知。只检查原始回执，不重新提交请求。此状态不会使 Host 保持唤醒。",
                                Language::ZhTw => "取消是否被接納未知。只檢查原始回執，不重新提交請求。此狀態不會使 Host 保持喚醒。",
                            })
                                .into();
                        }
                        self.repo.save(saved).await?;
                        self.written();
                    }
                    return Ok(());
                }
                Err(e) => return Err(e.into()),
            };
            if matches!(goal.status, Status::Cancelled | Status::CancellationUnknown)
                && !matches!(
                    observation.progress,
                    Progress::Ended { .. } | Progress::Paused
                )
            {
                commands.cancel(pending.request.operation()).await?;
                return Ok(());
            }
            match observation.progress {
                Progress::Ended { outcome } => {
                    let usage = self
                        .meter(goal.arm.grant, session)
                        .await
                        .map_err(|e| e.to_string());
                    goal.settled(outcome, usage);
                    self.repo.save(saved).await?;
                    self.written();
                    self.changed();
                    return Ok(());
                }
                Progress::Paused => {
                    goal.handoff_paused();
                    self.repo.save(saved).await?;
                    self.written();
                    self.changed();
                    return Ok(());
                }
                Progress::WaitingForUser => return Ok(()),
                _ => return Ok(()),
            }
        }
        if goal.status != Status::Active {
            return Ok(());
        }
        if self.privacy().await.is_err() {
            goal.status = Status::Paused;
            goal.note = (match goal.arm.language {
                Language::En => "Incognito mode stopped Goal continuation",
                Language::ZhCn => "隐私模式已停止目标继续执行",
                Language::ZhTw => "隱私模式已停止目標繼續執行",
            })
            .into();
            self.repo.save(saved).await?;
            self.written();
            return Ok(());
        }
        if commands.activity(session.into()).await?.busy {
            return Ok(());
        }
        goal.meter(self.meter(goal.arm.grant, session).await?);
        if goal.status == Status::Active {
            goal.reserve()?;
        }
        self.repo.save(saved).await?;
        self.written();
        self.changed();
        Ok(())
    }
}
