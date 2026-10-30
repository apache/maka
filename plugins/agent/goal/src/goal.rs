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
use maka_capabilities::storage::Data;
use maka_capabilities::storage::Mutation;
use maka_capabilities::storage::Record;
use maka_capabilities::storage::Store;
use maka_capabilities::storage::StoreError;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] StoreError),
    #[error(transparent)]
    Authority(#[from] maka_capabilities::authorization::CommandError),
    #[error(transparent)]
    Resource(#[from] maka_agent_facts::tools::ToolError),
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
    pub max_iterations: u32,
    pub token_budget: Option<u64>,
    #[serde(default)]
    pub start: bool,
}
impl<A> Arm<A> {
    pub fn validate(&self) -> Result<(), Error> {
        if self.objective.trim().is_empty()
            || self.objective.len() > 8192
            || !(1..=100).contains(&self.max_iterations)
            || self
                .token_budget
                .is_some_and(|n| n == 0 || n > 1_000_000_000)
        {
            return Err(invalid(
                "Use an objective of 1–8192 bytes, 1–100 iterations and a positive token threshold up to 1 billion",
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
    Waiting,
    Achieved,
    Impossible,
    Cancelled,
    CancellationUnknown,
    MaxIterations,
    BudgetLimited,
    BudgetUnknown,
    Blocked,
}
impl Status {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Achieved
                | Self::Impossible
                | Self::Cancelled
                | Self::CancellationUnknown
                | Self::MaxIterations
                | Self::BudgetLimited
                | Self::BudgetUnknown
        )
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
    Waiting,
    Impossible,
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "GoalReport")]
pub struct Report {
    pub status: ReportKind,
    pub note: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Pending {
    pub request: Submit,
    pub dispatched: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal<A = Id> {
    pub id: Uuid,
    pub session_id: String,
    pub arm: Arm<A>,
    pub status: Status,
    pub iterations: u32,
    pub baseline: Meter,
    pub consumed: Meter,
    pub pending: Option<Pending>,
    pub last_operation_id: Option<String>,
    pub report: Option<Report>,
    pub note: String,
    pub authority_blocked: bool,
}
impl<A> Goal<A> {
    pub fn keeps_host_awake(&self) -> bool {
        !self.authority_blocked
            && (self.status == Status::Active
                || (self.status == Status::Cancelled && self.pending.is_some()))
    }

    pub fn control(&mut self, action: Control) -> Result<(), Error> {
        match action {
            Control::Pause if !self.status.terminal() => {
                self.status = Status::Paused;
                self.note = (match self.arm.language {
                    Language::En => "Paused by user; accepted execution may finish",
                    Language::ZhCn => "用户已暂停；已接纳的执行可能继续完成",
                    Language::ZhTw => "使用者已暫停；已接納的執行可能繼續完成",
                })
                .into();
            }
            Control::Resume
                if matches!(
                    self.status,
                    Status::Armed | Status::Paused | Status::Waiting | Status::Blocked
                ) =>
            {
                self.status = Status::Active;
                self.report = None;
                self.note = (match self.arm.language {
                    Language::En => "Resumed by user",
                    Language::ZhCn => "用户已恢复",
                    Language::ZhTw => "使用者已恢復",
                })
                .into();
            }
            Control::Cancel
                if !self.status.terminal()
                    || matches!(self.status, Status::Cancelled | Status::CancellationUnknown) =>
            {
                self.status = Status::Cancelled;
                self.report = None;
                self.note = (match self.arm.language { Language::En => "Cancellation requested; a committed dispatch may still be admitted before exact cancellation settles", Language::ZhCn => "已请求取消；精确取消确认前，已提交的派发仍可能被接纳", Language::ZhTw => "已請求取消；精確取消確認前，已提交的派發仍可能被接納" })
                    .into();
            }
            Control::Complete if !self.status.terminal() && self.pending.is_none() => {
                self.status = Status::Achieved;
                self.note = (match self.arm.language {
                    Language::En => "Marked complete by user",
                    Language::ZhCn => "用户标记为完成",
                    Language::ZhTw => "使用者標記為完成",
                })
                .into();
            }
            _ => return Err(invalid("Control is not valid in the current Goal state")),
        }
        Ok(())
    }
    pub fn settled(
        &mut self,
        outcome: maka_agent_facts::event::InvocationOutcome,
        usage: Result<Meter, String>,
    ) {
        self.last_operation_id = self
            .pending
            .take()
            .map(|pending| pending.request.operation_id);
        if matches!(self.status, Status::Cancelled | Status::CancellationUnknown) {
            self.status = Status::Cancelled;
            self.note = (match self.arm.language {
                Language::En => "Cancellation settled; the accepted execution is no longer running",
                Language::ZhCn => "取消已确认；已接纳的执行不再运行",
                Language::ZhTw => "取消已確認；已接納的執行不再執行",
            })
            .into();
        }
        if self.status == Status::Active {
            match outcome {
                maka_agent_facts::event::InvocationOutcome::Completed => {
                    if let Some(report) = self.report.take() {
                        self.note = report.note;
                        self.status = match report.status {
                            ReportKind::Progress => Status::Active,
                            ReportKind::Achieved => Status::Achieved,
                            ReportKind::Waiting => Status::Waiting,
                            ReportKind::Impossible => Status::Impossible,
                        };
                    }
                }
                _ => {
                    self.status = Status::Blocked;
                    self.note = (match self.arm.language { Language::En => "Goal execution did not complete normally; inspect the Session before resuming", Language::ZhCn => "目标执行未正常完成；恢复前检查会话", Language::ZhTw => "目標執行未正常完成；恢復前檢查工作階段" })
                        .into();
                }
            }
        }
        match usage {
            Ok(total) => self.meter(total),
            Err(_) => {
                if self.status == Status::Active {
                    self.status = if self.arm.token_budget.is_some() {
                        Status::BudgetUnknown
                    } else {
                        Status::Blocked
                    };
                }
                self.note.push_str(match self.arm.language {
                    Language::En => {
                        " Usage could not be refreshed; no further iteration was scheduled."
                    }
                    Language::ZhCn => " 无法刷新用量；未安排后续迭代。",
                    Language::ZhTw => " 無法重新整理用量；未安排後續迭代。",
                });
            }
        }
    }
    pub fn handoff_paused(&mut self) {
        self.last_operation_id = self
            .pending
            .take()
            .map(|pending| pending.request.operation_id);
        self.report = None;
        if matches!(self.status, Status::Cancelled | Status::CancellationUnknown) {
            self.status = Status::Cancelled;
            self.note = (match self.arm.language { Language::En => "Goal cancellation recorded; Host handoff is sealed and no continuation was scheduled", Language::ZhCn => "已记录目标取消；Host 交接已封存，未安排继续执行", Language::ZhTw => "已記錄目標取消；Host 交接已封存，未安排繼續執行" }).into();
        } else {
            self.status = Status::Blocked;
            self.note = (match self.arm.language { Language::En => "Host handoff is paused. Resume it through Session controls, then explicitly resume the Goal; no automatic continuation was submitted.", Language::ZhCn => "Host 交接已暂停。先通过会话控件恢复，再明确恢复目标；未提交自动继续请求。", Language::ZhTw => "Host 交接已暫停。先透過工作階段控制項恢復，再明確恢復目標；未提交自動繼續請求。" })
                .into();
        }
    }
    pub fn reserve(&mut self) -> Result<(), Error> {
        if self.status != Status::Active || self.pending.is_some() {
            return Err(invalid("Goal is not ready to continue"));
        }
        if self.iterations >= self.arm.max_iterations {
            self.status = Status::MaxIterations;
            self.note = (match self.arm.language {
                Language::En => "Iteration limit reached",
                Language::ZhCn => "已达迭代上限",
                Language::ZhTw => "已達迭代上限",
            })
            .into();
            return Ok(());
        }
        self.iterations += 1;
        self.report = None;
        let content = match self.arm.language {
            Language::En => format!(
                "Continue this explicitly authorized goal (iteration {} of {}):\n{}\n\nGoalStatus records iteration progress or changes goal status; an answer alone does not mark achievement. A configured token budget is a retrospective scheduling threshold, not a hard request limit. Previous checkpoint: {}",
                self.iterations, self.arm.max_iterations, self.arm.objective, self.note
            ),
            Language::ZhCn => format!(
                "继续此已明确授权的目标（第 {} 次，共 {} 次迭代）：\n{}\n\nGoalStatus 记录迭代进度或改变目标状态；普通回答不会将目标标记为完成。配置的 token 预算是事后调度阈值，不是单次请求的硬限制。上次检查点：{}",
                self.iterations, self.arm.max_iterations, self.arm.objective, self.note
            ),
            Language::ZhTw => format!(
                "繼續此已明確授權的目標（第 {} 次，共 {} 次迭代）：\n{}\n\nGoalStatus 記錄迭代進度或改變目標狀態；一般回答不會將目標標記為完成。設定的 token 預算是事後排程門檻，不是單次請求的硬限制。上次檢查點：{}",
                self.iterations, self.arm.max_iterations, self.arm.objective, self.note
            ),
        };
        self.pending = Some(Pending {
            dispatched: false,
            request: Submit {
                operation_id: format!("goal-{}-{}", self.id, self.iterations),
                session_id: self.session_id.clone(),
                orchestration_mode: None,
                content: content.into(),
            },
        });
        Ok(())
    }
    pub fn meter(&mut self, total: Meter) {
        self.consumed = Meter {
            known: total.known.saturating_sub(self.baseline.known),
            missing: total.missing.saturating_sub(self.baseline.missing),
        };
        if let Some(limit) = self.arm.token_budget
            && self.status == Status::Active
        {
            if total.known < self.baseline.known
                || total.missing < self.baseline.missing
                || self.consumed.missing > 0
            {
                self.status = Status::BudgetUnknown;
                self.note = (match self.arm.language {
                    Language::En => "Token usage is incomplete; continuation stopped",
                    Language::ZhCn => "Token 用量不完整；已停止继续执行",
                    Language::ZhTw => "Token 用量不完整；已停止繼續執行",
                })
                .into();
            } else if self.consumed.known >= limit {
                self.status = Status::BudgetLimited;
                self.note = (match self.arm.language {
                    Language::En => "Observed token threshold reached",
                    Language::ZhCn => "已达观测到的 token 阈值",
                    Language::ZhTw => "已達觀測到的 token 門檻",
                })
                .into();
            }
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
fn key(session: &str) -> String {
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
        self.store.read(key(session)).await?.map(decode).transpose()
    }
    pub async fn arm(&self, session: &str, arm: Arm<A>, baseline: Meter) -> Result<Goal<A>, Error> {
        self.arm_with(session, arm, baseline, vec![]).await
    }
    /// Commit caller receipts in the same transaction as the original arming.
    pub async fn arm_with(
        &self,
        session: &str,
        arm: Arm<A>,
        baseline: Meter,
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
        let goal = Goal {
            id: arm.operation_id,
            session_id: session.into(),
            status: if arm.start {
                Status::Active
            } else {
                Status::Armed
            },
            arm: arm.clone(),
            iterations: 0,
            baseline,
            consumed: Meter::default(),
            pending: None,
            last_operation_id: None,
            report: None,
            note: String::new(),
            authority_blocked: false,
        };
        receipts.extend([
            Mutation {
                key: key(session),
                expected_revision: old.map(|v| v.revision),
                data: Data::Present(serde_json::to_value(&goal).map_err(invalid)?),
            },
            Mutation {
                key: receipt_key,
                expected_revision: None,
                data: Data::Present(serde_json::json!({"session":session,"arm":arm})),
            },
        ]);
        self.store.batch(receipts).await?;
        Ok(goal)
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
        receipts.push(Mutation {
            key: key(&saved.goal.session_id),
            expected_revision: Some(saved.revision),
            data: Data::Present(serde_json::to_value(saved.goal).map_err(invalid)?),
        });
        self.store.batch(receipts).await?;
        Ok(())
    }
    pub async fn sessions(&self) -> Result<Vec<Saved<A>>, Error> {
        let mut result = vec![];
        let mut after = None;
        loop {
            let page = self
                .store
                .scan(maka_capabilities::storage::Scan {
                    prefix: "session/".into(),
                    after,
                })
                .await?;
            for entry in page.entries {
                let saved = decode(entry.record)?;
                if !saved.goal.authority_blocked
                    && (saved.goal.status == Status::Active || saved.goal.pending.is_some())
                {
                    result.push(saved);
                }
            }
            after = page.next_after;
            if after.is_none() {
                return Ok(result);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use maka_capabilities::storage;
    use std::{
        collections::BTreeMap,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };
    use uuid::Uuid;
    #[derive(Default)]
    struct Store(Mutex<BTreeMap<String, storage::Record>>, AtomicBool);
    impl storage::Store for Store {
        fn read(
            &self,
            key: String,
        ) -> BoxFuture<'_, Result<Option<storage::Record>, storage::StoreError>> {
            Box::pin(async move { Ok(self.0.lock().unwrap().get(&key).cloned()) })
        }
        fn scan(
            &self,
            _: storage::Scan,
        ) -> BoxFuture<'_, Result<storage::Page, storage::StoreError>> {
            Box::pin(async {
                Ok(storage::Page {
                    entries: self
                        .0
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|(key, _)| key.starts_with("session/"))
                        .map(|(key, record)| storage::Entry {
                            key: key.clone(),
                            record: record.clone(),
                        })
                        .collect(),
                    next_after: None,
                })
            })
        }
        fn batch(
            &self,
            mutations: Vec<storage::Mutation>,
        ) -> BoxFuture<'_, Result<Vec<storage::Record>, storage::StoreError>> {
            Box::pin(async move {
                let mut records = self.0.lock().unwrap();
                for m in &mutations {
                    let actual = records.get(&m.key).map(|r| r.revision);
                    if actual != m.expected_revision {
                        return Err(storage::StoreError::Conflict {
                            expected: format!("{:?}", m.expected_revision),
                            actual: format!("{actual:?}"),
                        });
                    }
                }
                let committed: Vec<_> = mutations
                    .into_iter()
                    .map(|m| {
                        let r = storage::Record {
                            revision: m.expected_revision.unwrap_or(0) + 1,
                            data: m.data,
                        };
                        records.insert(m.key, r.clone());
                        r
                    })
                    .collect();
                if self.1.swap(false, Ordering::SeqCst) {
                    return Err(storage::StoreError::OutcomeUnknown(
                        "reply lost after commit".into(),
                    ));
                }
                Ok(committed)
            })
        }
    }

    fn arm() -> Arm {
        Arm {
            language: Language::En,
            operation_id: Uuid::new_v4(),
            objective: "Verify the feature".into(),
            grant: maka_capabilities::authorization::Id(Uuid::new_v4()),
            max_iterations: 2,
            token_budget: Some(100),
            start: true,
        }
    }
    #[tokio::test]
    async fn business_receipt_commits_atomically_with_goal_and_conflicts_leave_neither_effect() {
        let store = Arc::new(Store::default());
        let repo = Repository::new(store.clone());
        let receipt = |key: &str| storage::Mutation {
            key: key.into(),
            expected_revision: None,
            data: storage::Data::Present(serde_json::json!({"committed":true})),
        };
        store.1.store(true, Ordering::SeqCst);
        assert!(matches!(
            repo.arm_with(
                "session",
                arm(),
                Meter::default(),
                vec![receipt("create-receipt")]
            )
            .await,
            Err(Error::Storage(storage::StoreError::OutcomeUnknown(_)))
        ));
        assert!(store.0.lock().unwrap().contains_key("create-receipt"));
        let mut saved = repo.read("session").await.unwrap().unwrap();
        saved.goal.control(Control::Pause).unwrap();
        let stale = saved.clone();
        store.1.store(true, Ordering::SeqCst);
        assert!(matches!(
            repo.save_with(saved, vec![receipt("pause-receipt")]).await,
            Err(Error::Storage(storage::StoreError::OutcomeUnknown(_)))
        ));
        assert!(store.0.lock().unwrap().contains_key("pause-receipt"));
        assert_eq!(
            repo.read("session").await.unwrap().unwrap().goal.status,
            Status::Paused
        );
        assert!(matches!(
            repo.save_with(stale, vec![receipt("stale-receipt")]).await,
            Err(Error::Storage(storage::StoreError::Conflict { .. }))
        ));
        assert!(!store.0.lock().unwrap().contains_key("stale-receipt"));
    }

    #[tokio::test]
    async fn arm_retry_preserves_baseline_and_cannot_replace_or_resurrect_a_goal() {
        let store = Arc::new(Store::default());
        let repo = Repository::new(store.clone());
        let request = arm();
        let goal = repo
            .arm(
                "session",
                request.clone(),
                Meter {
                    known: 10,
                    missing: 0,
                },
            )
            .await
            .unwrap();
        let retry = repo
            .arm(
                "session",
                request.clone(),
                Meter {
                    known: 99,
                    missing: 0,
                },
            )
            .await
            .unwrap();
        assert_eq!(retry.baseline.known, 10);
        assert_eq!(retry.id, goal.id);
        let mut different = request.clone();
        different.objective = "different".into();
        assert!(
            repo.arm("session", different, Meter::default())
                .await
                .is_err()
        );
        assert!(repo.arm("session", arm(), Meter::default()).await.is_err());
        let mut saved = repo.read("session").await.unwrap().unwrap();
        saved.goal.status = Status::Achieved;
        repo.save(saved).await.unwrap();
        let new = repo.arm("session", arm(), Meter::default()).await.unwrap();
        assert!(
            repo.arm("session", request, Meter::default())
                .await
                .is_err()
        );
        assert_eq!(repo.read("session").await.unwrap().unwrap().goal.id, new.id);
    }
    #[tokio::test]
    async fn iteration_reservations_are_bounded_and_budget_missing_fails_closed() {
        let repo = Repository::new(Arc::new(Store::default()));
        let mut goal = repo
            .arm(
                "session",
                arm(),
                Meter {
                    known: 10,
                    missing: 1,
                },
            )
            .await
            .unwrap();
        goal.reserve().unwrap();
        let first = goal.pending.take().unwrap();
        goal.reserve().unwrap();
        let second = goal.pending.take().unwrap();
        assert_ne!(first.request.operation_id, second.request.operation_id);
        goal.reserve().unwrap();
        assert_eq!(goal.status, Status::MaxIterations);
        assert!(goal.pending.is_none());
        assert_eq!(goal.iterations, 2);
        goal.status = Status::Active;
        goal.meter(Meter {
            known: 109,
            missing: 1,
        });
        assert_eq!(goal.status, Status::Active);
        goal.meter(Meter {
            known: 110,
            missing: 1,
        });
        assert_eq!(goal.status, Status::BudgetLimited);
        goal.status = Status::Active;
        goal.meter(Meter {
            known: 11,
            missing: 2,
        });
        assert_eq!(goal.status, Status::BudgetUnknown);
    }

    #[tokio::test]
    async fn terminal_controls_and_usage_failure_cannot_rewrite_execution_facts() {
        let repo = Repository::new(Arc::new(Store::default()));
        let mut goal = repo.arm("session", arm(), Meter::default()).await.unwrap();
        goal.reserve().unwrap();
        goal.report = Some(Report {
            status: ReportKind::Achieved,
            note: "Evidence verified".into(),
        });
        goal.settled(
            maka_agent_facts::event::InvocationOutcome::Completed,
            Err("usage unavailable".into()),
        );
        assert_eq!(goal.status, Status::Achieved);
        assert!(goal.pending.is_none());
        for action in [
            Control::Cancel,
            Control::Complete,
            Control::Pause,
            Control::Resume,
        ] {
            assert!(goal.control(action).is_err());
            assert_eq!(goal.status, Status::Achieved);
        }
        goal.status = Status::Active;
        goal.reserve().unwrap();
        goal.settled(
            maka_agent_facts::event::InvocationOutcome::Completed,
            Err("usage unavailable".into()),
        );
        assert_eq!(goal.status, Status::BudgetUnknown);
        assert!(goal.pending.is_none());
    }
    #[tokio::test]
    async fn sealed_handoff_and_unknown_cancellation_do_not_pin_background_work() {
        let repo = Repository::new(Arc::new(Store::default()));
        repo.arm("session", arm(), Meter::default()).await.unwrap();
        let mut saved = repo.read("session").await.unwrap().unwrap();
        saved.goal.reserve().unwrap();
        let operation = saved
            .goal
            .pending
            .as_ref()
            .unwrap()
            .request
            .operation_id
            .clone();
        saved.goal.handoff_paused();
        assert_eq!(
            saved.goal.last_operation_id.as_deref(),
            Some(operation.as_str())
        );
        repo.save(saved).await.unwrap();
        assert!(repo.sessions().await.unwrap().is_empty());
        let mut saved = repo.read("session").await.unwrap().unwrap();
        saved.goal.status = Status::Active;
        saved.goal.reserve().unwrap();
        saved.goal.status = Status::CancellationUnknown;
        saved.goal.pending.as_mut().unwrap().dispatched = true;
        repo.save(saved).await.unwrap();
        let sessions = repo.sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].goal.session_id, "session");
        assert!(!sessions[0].goal.keeps_host_awake());

        let mut saved = repo.read("session").await.unwrap().unwrap();
        saved.goal.status = Status::Paused;
        for dispatched in [false, true] {
            saved.goal.pending.as_mut().unwrap().dispatched = dispatched;
            assert!(!saved.goal.keeps_host_awake());
        }
        saved.goal.control(Control::Resume).unwrap();
        assert!(saved.goal.keeps_host_awake());
    }
}
