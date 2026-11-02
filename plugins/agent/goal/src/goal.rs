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
pub enum Pending {
    Existing {
        invocation: maka_agent_facts::event::Invocation,
    },
    Dispatch {
        request: Submit,
        dispatched: bool,
    },
}
impl Pending {
    pub fn invocation(&self) -> maka_agent_facts::event::Invocation {
        match self {
            Self::Existing { invocation } => invocation.clone(),
            Self::Dispatch { request, .. } => {
                use sha2::{Digest, Sha256};
                let id = hex::encode(Sha256::digest(request.operation_id.as_bytes()));
                maka_agent_facts::event::Invocation {
                    session_id: request.session_id.clone(),
                    turn_id: format!("t_{id}"),
                    run_id: format!("r_{id}"),
                    invocation_id: format!("i_{id}"),
                }
            }
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
        outcome: maka_agent_facts::event::InvocationOutcome,
        usage: Result<Meter, String>,
    ) {
        self.pending = None;
        if let maka_agent_facts::event::InvocationOutcome::Failed {
            model_failure: Some(cause),
            ..
        } = &outcome
        {
            use maka_agent_facts::model::error::{ModelFailureCause, ProviderFailureReason};
            self.retry_at = match cause {
                ModelFailureCause::Provider {
                    retry_at_unix_ms, ..
                } => retry_at_unix_ms.filter(|deadline| *deadline > now_ms()),
                _ => None,
            };
            if self.status == Status::Active
                && self.retry_at.is_none()
                && matches!(
                    cause,
                    ModelFailureCause::Http {
                        status: 401 | 403 | 404
                    } | ModelFailureCause::Provider {
                        reason: ProviderFailureReason::QuotaExhausted,
                        ..
                    }
                )
            {
                self.status = Status::Paused;
                self.authority_blocked = true;
                self.note = match self.arm.language {
                    Language::En => "Check the model connection or available quota, then resume the Goal. You can also choose another model.",
                    Language::ZhCn => "请检查模型连接或剩余额度，再继续目标，也可以选择其他模型。",
                    Language::ZhTw => "請檢查模型連線或剩餘額度，再繼續目標，也可以選擇其他模型。",
                }.into();
            }
        }
        if self.status == Status::Active
            && matches!(&outcome, maka_agent_facts::event::InvocationOutcome::Failed { class, .. } if class == "message_prerequisite_changed")
        {
            self.pause_for_settings();
        }
        if let Ok(total) = usage {
            self.meter(total);
        }
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
                "Continue this explicitly authorized goal (iteration {}):\n{}\n\nGoalStatus records iteration progress or changes goal status; an answer alone does not mark achievement. A configured token budget is a retrospective scheduling threshold, not a hard request limit. Previous checkpoint: {}",
                self.iterations, self.arm.objective, self.note
            ),
            Language::ZhCn => format!(
                "继续此已明确授权的目标（第 {} 次迭代）：\n{}\n\nGoalStatus 记录迭代进度或改变目标状态；普通回答不会将目标标记为完成。配置的 token 预算是事后调度阈值，不是单次请求的硬限制。上次检查点：{}",
                self.iterations, self.arm.objective, self.note
            ),
            Language::ZhTw => format!(
                "繼續此已明確授權的目標（第 {} 次迭代）：\n{}\n\nGoalStatus 記錄迭代進度或改變目標狀態；一般回答不會將目標標記為完成。設定的 token 預算是事後排程門檻，不是單次請求的硬限制。上次檢查點：{}",
                self.iterations, self.arm.objective, self.note
            ),
        };
        self.pending = Some(Pending::Dispatch {
            dispatched: false,
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
        if let Some(limit) = self.arm.token_budget
            && self.status == Status::Active
            && self.consumed.known >= limit
        {
            self.status = Status::BudgetLimited;
            self.note = (match self.arm.language {
                Language::En => "Token budget reached",
                Language::ZhCn => "已达 Token 预算",
                Language::ZhTw => "已達 Token 預算",
            })
            .into();
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
        mut saved: Saved<A>,
        mut receipts: Vec<Mutation>,
    ) -> Result<(), Error> {
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
                if (saved.goal.status == Status::Active && !saved.goal.authority_blocked)
                    || saved.goal.pending.is_some()
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
                None,
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
    async fn incomplete_usage_does_not_stop_progress_and_budget_can_be_raised() {
        let repo = Repository::new(Arc::new(Store::default()));
        let mut goal = repo.arm("session", arm(), Meter::default()).await.unwrap();
        for _ in 0..101 {
            goal.reserve().unwrap();
            goal.settled(
                maka_agent_facts::event::InvocationOutcome::Completed,
                Ok(Meter {
                    known: 20,
                    missing: 1,
                }),
            );
        }
        assert_eq!(goal.iterations, 101);
        assert_eq!(goal.status, Status::Active);
        assert_eq!(
            goal.consumed,
            Meter {
                known: 20,
                missing: 1
            }
        );
        goal.meter(Meter {
            known: 100,
            missing: 1,
        });
        assert_eq!(goal.status, Status::BudgetLimited);
        goal.arm.token_budget = Some(200);
        goal.control(Control::Resume).unwrap();
        goal.reserve().unwrap();
        assert_eq!(goal.status, Status::Active);
        assert_eq!(goal.iterations, 102);
    }
    #[tokio::test]
    async fn failed_execution_and_usage_observation_do_not_block_the_goal() {
        let repo = Repository::new(Arc::new(Store::default()));
        let mut goal = repo.arm("session", arm(), Meter::default()).await.unwrap();
        goal.reserve().unwrap();
        goal.settled(
            maka_agent_facts::event::InvocationOutcome::Failed {
                class: "network".into(),
                message: Some("connection reset".into()),
                model_failure: None,
            },
            Err("temporary database error".into()),
        );
        goal.reserve().unwrap();
        assert_eq!(goal.iterations, 2);
        goal.report(Report {
            status: ReportKind::Achieved,
            note: "Verified the result".into(),
        });
        goal.settled(
            maka_agent_facts::event::InvocationOutcome::Completed,
            Err("usage unavailable".into()),
        );
        assert_eq!(goal.status, Status::Achieved);
        assert_eq!(goal.note, "Verified the result");
        assert!(goal.control(Control::Resume).is_err());
    }
}
