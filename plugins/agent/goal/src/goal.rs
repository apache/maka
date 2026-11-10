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

use maka_agent_facts::language::Language;
use maka_agent_ports::execution::Submit;
use maka_capabilities::authorization::Id;
use maka_plugin_core::storage::Data;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Record;
use maka_plugin_core::storage::Store;
use maka_plugin_core::storage::StoreError;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] StoreError),
}
pub fn invalid(e: impl std::fmt::Display) -> Error {
    Error::Invalid(e.to_string())
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Arm<A = Id> {
    #[serde(default, skip_serializing_if = "Language::is_english")]
    pub language: Language,
    pub operation_id: Uuid,
    pub objective: String,
    pub grant: A,
    pub token_budget: Option<u64>,
    #[serde(default)]
    pub start: bool,
}
impl<A> Arm<A> {
    pub fn validate(&self) -> Result<(), Error> {
        if self.objective.trim().is_empty() || self.token_budget.is_some_and(|n| n == 0) {
            return Err(invalid(
                "Provide a nonempty objective and a positive optional token budget",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "GoalStatus")]
pub enum Status {
    Armed,
    Active,
    Paused,
    Achieved,
    Cancelled,
    BudgetLimited,
    Blocked,
}
impl Status {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Achieved | Self::Cancelled)
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "GoalControl")]
pub enum Control {
    Pause,
    Resume,
    Cancel,
    Complete,
    SetBudget,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Default, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "GoalMeter")]
pub struct Meter {
    pub known: u64,
    pub missing: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "GoalReportKind")]
pub enum ReportKind {
    Progress,
    Achieved,
    Blocked,
    Paused,
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "GoalReport")]
pub struct Report {
    pub status: ReportKind,
    pub note: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[expect(
    clippy::large_enum_variant,
    reason = "Admission consumes one pending request at a time; keep the owned dispatch payload inline"
)]
pub enum Pending {
    Existing {
        run: maka_agent_facts::durable::RunId,
        managed: bool,
    },
    Dispatch {
        request: Submit,
    },
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleIndex {
    pub sessions: std::collections::BTreeMap<String, Scheduled>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Scheduled {
    Ready,
    Due {
        at: u64,
    },
    Waiting {
        run: maka_agent_facts::durable::RunId,
        stop: bool,
    },
}
impl ScheduleIndex {
    fn update<A>(&mut self, goal: &Goal<A>) {
        let entry = match &goal.pending {
            Some(Pending::Existing { run, managed }) => Some(Scheduled::Waiting {
                run: *run,
                stop: *managed && matches!(goal.status, Status::Paused | Status::Cancelled),
            }),
            Some(Pending::Dispatch { .. }) => Some(Scheduled::Ready),
            None if goal.status == Status::Active && !goal.authority_blocked => {
                Some(match goal.retry_at {
                    Some(at) => Scheduled::Due { at },
                    None => Scheduled::Ready,
                })
            }
            None => None,
        };
        if let Some(entry) = entry {
            self.sessions.insert(goal.session_id.clone(), entry);
        } else {
            self.sessions.remove(&goal.session_id);
        }
    }
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time follows Unix epoch")
        .as_millis()
        .try_into()
        .expect("timestamp fits u64")
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal<A = Id> {
    pub id: Uuid,
    pub session_id: String,
    pub arm: Arm<A>,
    pub status: Status,
    pub iterations: u64,
    pub baseline: Meter,
    pub consumed: Meter,
    pub pending: Option<Pending>,
    pub created_at: u64,
    pub updated_at: u64,
    pub active_since: Option<u64>,
    pub elapsed_ms: u64,
    pub retry_at: Option<u64>,
    pub report: Option<Report>,
    pub note: String,
    pub authority_blocked: bool,
}
impl<A> Goal<A> {
    pub fn keeps_host_awake(&self) -> bool {
        !self.authority_blocked
            && (self.status == Status::Active
                || (matches!(self.status, Status::Cancelled | Status::Achieved)
                    && self.pending.is_some()))
    }

    pub fn control(&mut self, action: Control) -> Result<(), Error> {
        match action {
            Control::Pause if !self.status.terminal() => self.status = Status::Paused,
            Control::Resume
                if matches!(
                    self.status,
                    Status::Armed | Status::Paused | Status::Blocked | Status::BudgetLimited
                ) =>
            {
                self.status = Status::Active;
                self.report = None;
            }
            Control::Cancel if !self.status.terminal() || self.status == Status::Cancelled => {
                self.status = Status::Cancelled;
                self.report = None;
            }
            Control::Complete if !self.status.terminal() => self.status = Status::Achieved,
            Control::SetBudget if !self.status.terminal() => {}
            _ => return Err(invalid("Control is not valid in the current Goal state")),
        }
        Ok(())
    }
    pub fn pause_for_settings(&mut self) {
        self.status = Status::Paused;
        self.authority_blocked = true;
        self.note = match self.arm.language {
            Language::En => {
                "Review the model connection and conversation settings, then resume the Goal."
            }
            Language::ZhCn => "请检查模型连接和对话设置，然后继续目标。",
            Language::ZhTw => "請檢查模型連線和對話設定，然後繼續目標。",
        }
        .into();
    }
    pub fn settled(
        &mut self,
        outcome: maka_agent_facts::durable::Terminal,
        usage: Result<Meter, String>,
    ) -> Result<(), String> {
        let total = usage?;
        self.pending = None;
        // Stop is a persistent user fence, not an invitation to schedule another Run.
        if self.status == Status::Active
            && matches!(outcome, maka_agent_facts::durable::Terminal::Cancelled)
        {
            self.status = Status::Paused;
        }
        self.meter(total);
        Ok(())
    }
    pub fn report(&mut self, report: Report) {
        self.note = report.note.clone();
        self.status = match report.status {
            ReportKind::Progress => Status::Active,
            ReportKind::Achieved => Status::Achieved,
            ReportKind::Blocked => Status::Blocked,
            ReportKind::Paused => Status::Paused,
        };
        self.report = Some(report);
    }
    pub fn reserve(&mut self) -> Result<bool, Error> {
        self.limit_budget();
        if self.status != Status::Active || self.pending.is_some() {
            return Err(invalid("Goal is not ready to continue"));
        }
        if self.retry_at.is_some_and(|deadline| deadline > now_ms()) {
            return Ok(false);
        }
        self.retry_at = None;
        self.iterations += 1;
        self.report = None;
        let content = match self.arm.language {
            Language::En => format!(
                "Continue this explicitly authorized goal (iteration {}):\n{}\n\nGoalStatus records iteration progress or changes goal status; an answer alone does not mark achievement. A finite token budget limits further dispatch; missing usage is not treated as zero. Previous checkpoint: {}",
                self.iterations, self.arm.objective, self.note
            ),
            Language::ZhCn => format!(
                "继续此已明确授权的目标（第 {} 次迭代）：\n{}\n\nGoalStatus 记录迭代进度或改变目标状态；普通回答不会将目标标记为完成。有限 token 预算限制后续派发，缺失用量不能视为零。上次检查点：{}",
                self.iterations, self.arm.objective, self.note
            ),
            Language::ZhTw => format!(
                "繼續此已明確授權的目標（第 {} 次迭代）：\n{}\n\nGoalStatus 記錄迭代進度或改變目標狀態；一般回答不會將目標標記為完成。有限 token 預算限制後續派發，缺失用量不能視為零。上次檢查點：{}",
                self.iterations, self.arm.objective, self.note
            ),
        };
        self.pending = Some(Pending::Dispatch {
            request: Submit {
                operation_id: format!("goal-{}-{}", self.id, self.iterations),
                session_id: self.session_id.clone(),
                orchestration_mode: None,
                content: content.into(),
            },
        });
        Ok(true)
    }
    pub fn observed_usage(&self, total: Meter) -> Meter {
        Meter {
            known: total.known.saturating_sub(self.baseline.known),
            missing: total.missing.saturating_sub(self.baseline.missing),
        }
    }
    pub fn meter(&mut self, total: Meter) {
        self.consumed = self.observed_usage(total);
        self.limit_budget();
    }
    fn limit_budget(&mut self) {
        if let Some(limit) = self.arm.token_budget
            && self.status == Status::Active
            && (self.consumed.missing > 0 || self.consumed.known >= limit)
        {
            self.status = Status::BudgetLimited;
            self.note = match (self.consumed.missing > 0, self.arm.language) {
                (true, Language::En) => "Token accounting is incomplete; a larger finite budget cannot resolve missing usage.",
                (true, Language::ZhCn) => "Token 用量尚不完整，提高有限预算不能补足缺失的用量证据。",
                (true, Language::ZhTw) => "Token 用量尚不完整，提高有限預算不能補足缺失的用量證據。",
                (false, Language::En) => "Token budget reached",
                (false, Language::ZhCn) => "已达 Token 预算",
                (false, Language::ZhTw) => "已達 Token 預算",
            }.into();
        }
    }
}

#[derive(Clone)]
pub struct Saved<A = Id> {
    pub revision: u64,
    pub goal: Goal<A>,
}
#[derive(Clone)]
pub struct Repository<A = Id> {
    store: Arc<dyn Store>,
    authority: std::marker::PhantomData<A>,
}
pub fn record_key(session: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "session/{}",
        hex::encode(Sha256::digest(session.as_bytes()))
    )
}
fn decode<A: serde::de::DeserializeOwned>(record: Record) -> Result<Saved<A>, Error> {
    let goal = serde_json::from_value(
        record
            .data
            .value()
            .ok_or_else(|| invalid("Goal was removed"))?
            .clone(),
    )
    .map_err(invalid)?;
    Ok(Saved {
        revision: record.revision,
        goal,
    })
}
impl<A: Clone + Serialize + serde::de::DeserializeOwned> Repository<A> {
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self {
            store,
            authority: std::marker::PhantomData,
        }
    }
    pub async fn read(&self, session: &str) -> Result<Option<Saved<A>>, Error> {
        self.store
            .read(record_key(session))
            .await?
            .map(decode)
            .transpose()
    }
    pub async fn arm(&self, session: &str, arm: Arm<A>, baseline: Meter) -> Result<Goal<A>, Error> {
        self.arm_with(session, arm, baseline, None, vec![]).await
    }
    /// Commit caller receipts in the same transaction as the original arming.
    pub async fn arm_with(
        &self,
        session: &str,
        arm: Arm<A>,
        baseline: Meter,
        pending: Option<Pending>,
        mut receipts: Vec<Mutation>,
    ) -> Result<Goal<A>, Error> {
        arm.validate()?;
        let receipt_key = format!("arm/{}", arm.operation_id);
        if let Some(receipt) = self.store.read(receipt_key.clone()).await? {
            let expected = serde_json::json!({"session":session,"arm":arm});
            if receipt.data.value() != Some(&expected) {
                return Err(invalid("Operation ID belongs to another Goal request"));
            }
            let saved = self
                .read(session)
                .await?
                .ok_or_else(|| invalid("Goal is unavailable"))?;
            if saved.goal.id != arm.operation_id {
                return Err(invalid("This Goal was superseded; read the current Goal"));
            }
            return Ok(saved.goal);
        }
        let old = self.read(session).await?;
        if old
            .as_ref()
            .is_some_and(|s| !s.goal.status.terminal() || s.goal.pending.is_some())
        {
            return Err(invalid(
                "Finish or cancel the current Goal and await its execution before replacing it",
            ));
        }
        let (index_revision, index, _) = self.schedule_record().await?;
        let (goal, mutations) =
            Self::prepare_arm(session, arm, baseline, pending, old, index_revision, index)?;
        receipts.extend(mutations);
        self.store.batch(receipts).await?;
        Ok(goal)
    }
    pub fn prepare_arm(
        session: &str,
        arm: Arm<A>,
        baseline: Meter,
        pending: Option<Pending>,
        old: Option<Saved<A>>,
        index_revision: Option<u64>,
        mut index: ScheduleIndex,
    ) -> Result<(Goal<A>, Vec<Mutation>), Error> {
        arm.validate()?;
        if old
            .as_ref()
            .is_some_and(|saved| !saved.goal.status.terminal() || saved.goal.pending.is_some())
        {
            return Err(invalid("goal_current_unfinished"));
        }
        let receipt_key = format!("arm/{}", arm.operation_id);
        let goal = Goal {
            id: arm.operation_id,
            session_id: session.into(),
            status: if arm.start {
                Status::Active
            } else {
                Status::Armed
            },
            arm: arm.clone(),
            iterations: u64::from(pending.is_some()),
            baseline,
            consumed: Meter::default(),
            pending,
            created_at: now_ms(),
            updated_at: now_ms(),
            active_since: arm.start.then(now_ms),
            elapsed_ms: 0,
            retry_at: None,
            report: None,
            note: String::new(),
            authority_blocked: false,
        };
        index.update(&goal);
        let mutations = vec![
            Mutation {
                key: "schedule".into(),
                expected_revision: index_revision,
                data: Data::Present(serde_json::to_value(index).map_err(invalid)?),
            },
            Mutation {
                key: record_key(session),
                expected_revision: old.map(|v| v.revision),
                data: Data::Present(serde_json::to_value(&goal).map_err(invalid)?),
            },
            Mutation {
                key: receipt_key,
                expected_revision: None,
                data: Data::Present(serde_json::json!({"session":session,"arm":arm})),
            },
        ];
        Ok((goal, mutations))
    }
    pub async fn save(&self, saved: Saved<A>) -> Result<(), Error> {
        self.save_with(saved, vec![]).await
    }
    /// State transitions and their caller receipts share the original CAS.
    pub async fn save_with(
        &self,
        saved: Saved<A>,
        mut receipts: Vec<Mutation>,
    ) -> Result<(), Error> {
        let (revision, index, _) = self.schedule_record().await?;
        receipts.extend(Self::prepare_save(saved, revision, index)?);
        self.store.batch(receipts).await?;
        Ok(())
    }
    pub fn prepare_save(
        mut saved: Saved<A>,
        index_revision: Option<u64>,
        mut index: ScheduleIndex,
    ) -> Result<Vec<Mutation>, Error> {
        saved.goal.updated_at = now_ms();
        if saved.goal.status == Status::Active {
            if saved.goal.active_since.is_none() {
                saved.goal.active_since = Some(saved.goal.updated_at);
            }
        } else if let Some(start) = saved.goal.active_since.take() {
            saved.goal.elapsed_ms = saved
                .goal
                .elapsed_ms
                .saturating_add(saved.goal.updated_at.saturating_sub(start));
        }
        index.update(&saved.goal);
        Ok(vec![
            Mutation {
                key: "schedule".into(),
                expected_revision: index_revision,
                data: Data::Present(serde_json::to_value(index).map_err(invalid)?),
            },
            Mutation {
                key: record_key(&saved.goal.session_id),
                expected_revision: Some(saved.revision),
                data: Data::Present(serde_json::to_value(saved.goal).map_err(invalid)?),
            },
        ])
    }
    async fn schedule_record(&self) -> Result<(Option<u64>, ScheduleIndex, bool), Error> {
        let record = self.store.read("schedule".into()).await?;
        let revision = record.as_ref().map(|record| record.revision);
        if let Some(value) = record.as_ref().and_then(|record| record.data.value()) {
            let index = serde_json::from_value(value.clone()).map_err(invalid)?;
            return Ok((revision, index, false));
        }
        // Rebuild a missing derived index once from original Goal records. This
        // is not a notification fallback or a replacement authority.
        let mut index = ScheduleIndex::default();
        let mut after = None;
        loop {
            let page = self
                .store
                .scan(maka_plugin_core::storage::Scan {
                    prefix: "session/".into(),
                    after,
                })
                .await?;
            for entry in page.entries {
                let Some(value) = entry.record.data.value() else {
                    continue;
                };
                match Goal::<serde::de::IgnoredAny>::deserialize(value) {
                    Ok(goal) => index.update(&goal),
                    Err(_) => {
                        let session = entry
                            .key
                            .strip_prefix("session/")
                            .ok_or_else(|| invalid("invalid Goal record key"))?;
                        index.sessions.insert(session.to_owned(), Scheduled::Ready);
                    }
                }
            }
            after = page.next_after;
            if after.is_none() {
                break;
            }
        }
        Ok((revision, index, true))
    }
    pub async fn schedule_snapshot(&self) -> Result<(Option<u64>, ScheduleIndex), Error> {
        let (revision, index, _) = self.schedule_record().await?;
        Ok((revision, index))
    }
    pub async fn schedule(&self) -> Result<ScheduleIndex, Error> {
        let (revision, index, rebuild) = self.schedule_record().await?;
        if rebuild {
            self.store
                .batch(vec![Mutation {
                    key: "schedule".into(),
                    expected_revision: revision,
                    data: Data::Present(serde_json::to_value(&index).map_err(invalid)?),
                }])
                .await?;
        }
        Ok(index)
    }
    pub async fn sessions(&self) -> Result<Vec<Result<Saved<A>, Error>>, Error> {
        let mut result = Vec::new();
        for session in self.schedule().await?.sessions.keys() {
            result.push(match self.read(session).await {
                Ok(Some(saved)) => Ok(saved),
                Ok(None) => Err(invalid("Goal schedule points to missing source")),
                Err(error) => Err(error),
            });
        }
        Ok(result)
    }
}
