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

//! Per-plan daily weighted usage, charged to the UTC day of worker admission.
use super::*;

const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;
pub const DAILY_WEIGHTED_TOKENS: u64 = 4_000_000;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct TokenAllowance {
    pub day: i64,
    pub tokens: u64,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCharge {
    Admitted(u64),
    /// The worker was removed before its usage could be recovered.
    Unobserved(u64),
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct DiscoveryActivity {
    pub day: i64,
    pub tokens: u64,
    #[serde(default)]
    pub last_run_at: i64,
    pub skipped: u64,
    pub deferred: u64,
    pub model_runs: u64,
    pub revised: u64,
    pub notified: u64,
}

impl DiscoveryActivity {
    pub fn allowance(
        &self,
        at: UnixMillis,
        run_limit: u64,
        bypass_pacing: bool,
    ) -> Result<TokenAllowance, UnixMillis> {
        let day = at.0.div_euclid(DAY_MS).max(self.day);
        if !bypass_pacing && day == self.day {
            let midnight = day.saturating_add(1).saturating_mul(DAY_MS);
            if self.tokens >= DAILY_WEIGHTED_TOKENS {
                return Err(UnixMillis(midnight));
            }
            let min_interval = if self.tokens >= DAILY_WEIGHTED_TOKENS * 4 / 5 {
                4 * HOUR_MS
            } else if self.tokens >= DAILY_WEIGHTED_TOKENS / 2 {
                2 * HOUR_MS
            } else {
                0
            };
            let next_allowed = self.last_run_at.saturating_add(min_interval).min(midnight);
            if min_interval > 0 && self.last_run_at > 0 && at.0 < next_allowed {
                return Err(UnixMillis(next_allowed));
            }
        }
        Ok(TokenAllowance {
            day,
            tokens: run_limit,
        })
    }
}

fn key(plan: &str) -> String {
    format!("activity:{plan}")
}

fn read(c: &Connection, owner: &str, key: &str) -> Result<DiscoveryActivity, StoreError> {
    let raw: Option<String> = c
        .query_row(
            "SELECT value_json FROM plugin_data WHERE package_id=?1 AND scope_id=?2 AND key=?3",
            params![REVISION_PACKAGE, owner, key],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    Ok(raw
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or_default())
}

pub(super) fn update(
    c: &Connection,
    owner: &str,
    plan: &str,
    f: impl FnOnce(&mut DiscoveryActivity),
) -> Result<(), StoreError> {
    let key = key(plan);
    let mut activity = read(c, owner, &key)?;
    f(&mut activity);
    c.execute(
        "INSERT INTO plugin_data(package_id, scope_id, key, revision, value_json)
         VALUES (?1, ?2, ?3, 1, ?4) ON CONFLICT(package_id, scope_id, key) DO UPDATE SET
         revision=revision+1, value_json=excluded.value_json",
        params![
            REVISION_PACKAGE,
            owner,
            key,
            serde_json::to_string(&activity)?
        ],
    )?;
    Ok(())
}

impl DiscoveryStore {
    pub async fn plan_activity(&self, plan: &str) -> Result<DiscoveryActivity, StoreError> {
        let key = key(plan);
        self.read(move |c, owner| read(c, owner, &key)).await
    }

    pub fn skip_statement(
        &self,
        plan: String,
        deferred: bool,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.mutation(false, move |c, owner| {
            update(c, owner, &plan, |activity| {
                if deferred {
                    activity.deferred += 1;
                } else {
                    activity.skipped += 1;
                }
            })
        })
    }

    pub fn charge_statement(
        &self,
        plan: String,
        allowance: Option<TokenAllowance>,
        at: UnixMillis,
        charge: Option<ModelCharge>,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.mutation(false, move |c, owner| {
            let Some(charge) = charge else {
                return Ok(());
            };
            update(c, owner, &plan, |activity| {
                let day =
                    allowance.map_or_else(|| at.0.div_euclid(DAY_MS).max(activity.day), |a| a.day);
                let tokens = match charge {
                    ModelCharge::Admitted(tokens) => {
                        activity.model_runs += 1;
                        tokens
                    }
                    ModelCharge::Unobserved(tokens) => tokens,
                };
                // A late settlement still counts as a run. Its admission-day charge
                // must not spill into a newer bucket or move a cooldown backwards.
                if day < activity.day {
                    return;
                }
                let settled_at = at.0.max(day.saturating_mul(DAY_MS));
                if day > activity.day {
                    activity.day = day;
                    activity.tokens = tokens;
                    activity.last_run_at = settled_at;
                } else {
                    activity.tokens = activity.tokens.saturating_add(tokens);
                    activity.last_run_at = activity.last_run_at.max(settled_at);
                }
            })
        })
    }
}
