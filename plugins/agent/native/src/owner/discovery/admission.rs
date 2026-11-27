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

//! Choose work before allocating a worker, opening a session, or capturing a model.
use super::*;
use maka_agent_state::discovery::activity::DiscoveryActivity;
use maka_agent_state::discovery::changes::{ChangeQuery, ChangeSnapshot};
use workspace_map::{MapPhase, WorkspaceMap};

impl DiscoveryMode {
    pub(super) fn allowance(
        &self,
        activity: &DiscoveryActivity,
        source: FireSource,
        at: UnixMillis,
    ) -> Result<TokenAllowance, UnixMillis> {
        let bypass_pacing = source == FireSource::Manual || matches!(self, Self::Onboard);
        activity.allowance(at, RUN_TOKEN_SAFETY_BREAKER, bypass_pacing)
    }
}

fn triggered_mode(source: FireSource, direction: &str, followup: bool) -> Option<DiscoveryMode> {
    match source {
        FireSource::Watch | FireSource::FileChange => Some(DiscoveryMode::FollowUp),
        _ if followup => Some(DiscoveryMode::FollowUp),
        _ if !direction.trim().is_empty() => Some(DiscoveryMode::Briefing),
        FireSource::Manual | FireSource::Schedule => None,
    }
}

fn manual_mode(map: Option<&WorkspaceMap>) -> DiscoveryMode {
    if map.is_some_and(|map| map.phase != MapPhase::Ready) {
        DiscoveryMode::Onboard
    } else {
        DiscoveryMode::FollowUp
    }
}

async fn broad_mode(
    map: Option<&WorkspaceMap>,
    deltas: impl Future<Output = Result<ChangeSnapshot, String>>,
    periodic: impl AsyncFnOnce(&WorkspaceMap) -> Result<Option<String>, String>,
) -> Result<Option<DiscoveryMode>, String> {
    if map.is_some_and(|map| map.phase != MapPhase::Ready) {
        return Ok(Some(DiscoveryMode::Onboard));
    }
    if !deltas.await?.groups.is_empty() {
        return Ok(Some(DiscoveryMode::FollowUp));
    }
    if let Some(map) = map
        && let Some(source) = periodic(map).await?
    {
        return Ok(Some(DiscoveryMode::Wander {
            sources: vec![source],
        }));
    }
    Ok(None)
}

impl Owner {
    pub(super) async fn discovery_mode(
        &self,
        job: &Job,
        fire: &Fire<ScheduledEffect, scheduler::Approval>,
        at: UnixMillis,
        source_tools: Option<&[String]>,
    ) -> Result<Option<DiscoveryMode>, String> {
        let followup = fire
            .authorization
            .as_ref()
            .and_then(scheduler::Approval::followup_grant)
            .is_some();
        if let Some(mode) = triggered_mode(fire.source, fire.intent.body(), followup) {
            return Ok(Some(mode));
        }
        let tools = self.discovery_worker_tools(
            &job.tools.names,
            source_tools,
            fire.effect.selected_discovery_tools(),
        );
        let reads_files = self.discovery_reads_files(&tools);
        if fire.source != FireSource::Manual && !reads_files {
            return Ok(None);
        }
        let root = std::path::Path::new(&job.approval.target.workspace.path);
        let map = if reads_files && tools.iter().any(|tool| tool == WORKSPACE_MAP) {
            Some(self.scheduler.workspace_map(root).await?.1)
        } else {
            None
        };
        if fire.source == FireSource::Manual {
            return Ok(Some(manual_mode(map.as_ref())));
        }
        broad_mode(
            map.as_ref(),
            self.discovery_changes(&job.approval, at, ChangeQuery::FirstReady),
            async |map| self.due_wander_source(&job.approval, map, at).await,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_state::discovery::{DiscoveryStore, DossierUpsert};
    use serde_json::json;

    #[test]
    fn discovery_admission_grants_the_full_breaker_and_exempts_manual_and_onboard_at_every_tier() {
        const HOUR: i64 = 3_600_000;
        let last = 25 * HOUR;
        for (tokens, due) in [
            (1_999_999, last),
            (2_000_000, last + 2 * HOUR),
            (3_999_999, last + 4 * HOUR),
            (4_000_000, 48 * HOUR),
        ] {
            let activity = DiscoveryActivity {
                day: 1,
                tokens,
                last_run_at: last,
                ..Default::default()
            };
            let at = UnixMillis(last);
            let onboard = DiscoveryMode::Onboard
                .allowance(&activity, FireSource::Schedule, at)
                .unwrap();
            assert_eq!((onboard.day, onboard.tokens), (1, 1_500_000));
            for (mode, source) in [
                (DiscoveryMode::FollowUp, FireSource::FileChange),
                (DiscoveryMode::FollowUp, FireSource::Watch),
                (
                    DiscoveryMode::Wander {
                        sources: vec!["notes".into()],
                    },
                    FireSource::Schedule,
                ),
                (DiscoveryMode::Briefing, FireSource::Schedule),
            ] {
                assert_eq!(
                    mode.allowance(&activity, FireSource::Manual, at)
                        .unwrap()
                        .tokens,
                    1_500_000
                );
                if due > last {
                    assert_eq!(
                        mode.allowance(&activity, source, UnixMillis(due - 1))
                            .unwrap_err(),
                        UnixMillis(due)
                    );
                }
                assert_eq!(
                    mode.allowance(&activity, source, UnixMillis(due))
                        .unwrap()
                        .tokens,
                    1_500_000
                );
            }
        }
    }

    #[test]
    fn discovery_directed_timer_selects_briefing_and_followups_use_alert_prose() {
        let direction = "Summarize the week";
        let mode = triggered_mode(FireSource::Schedule, direction, false).unwrap();
        assert_eq!(mode, DiscoveryMode::Briefing);
        let prompt = investigation_prompt(Language::EN, &mode, direction, false, false);
        assert!(prompt.contains("4–7 natural prose paragraphs"));
        for mode in [
            triggered_mode(FireSource::Watch, direction, false),
            triggered_mode(FireSource::Schedule, direction, true),
        ] {
            let mode = mode.unwrap();
            assert_eq!(mode, DiscoveryMode::FollowUp);
            let prompt = investigation_prompt(Language::EN, &mode, direction, false, false);
            assert!(prompt.contains("2–4 natural sentences"));
        }
    }

    #[tokio::test]
    async fn discovery_hourly_gate_replays_twelve_idle_timers_and_propagates_delta_errors() {
        const HOUR: i64 = 3_600_000;
        let (_dir, root, owner) = test_store().await;
        let writer = root.data_writer().unwrap();
        let discovery = DiscoveryStore::new(writer.clone(), &owner).unwrap();
        let mut map = WorkspaceMap::default();
        let deltas = async |at| {
            discovery
                .change_snapshot(UnixMillis(at), ChangeQuery::FirstReady, |_, _| true)
                .await
                .map_err(reason)
        };
        let periodic = async |map: &WorkspaceMap, at: i64| {
            let at = UnixMillis(at);
            Ok(discovery
                .available_wander_paths(map.due_wander_paths(at.0), at)
                .await
                .map_err(reason)?
                .into_iter()
                .next()
                .map(|path| path.to_string_lossy().into_owned()))
        };
        assert_eq!(
            broad_mode(Some(&map), deltas(0), async |map| periodic(map, 0).await)
                .await
                .unwrap(),
            Some(DiscoveryMode::Onboard)
        );
        map.phase = MapPhase::Scanning;
        map.frontier.push(workspace_map::FrontierBranch {
            path: "unfinished".into(),
            reason: "Release notes".into(),
            next_probe_after: Some(13 * HOUR),
        });
        assert_eq!(
            broad_mode(Some(&map), deltas(0), async |map| periodic(map, 0).await)
                .await
                .unwrap(),
            Some(DiscoveryMode::Onboard)
        );
        map.phase = MapPhase::Ready;
        // A cursor inherited from a cold inventory carries no map deadline or file delta.
        discovery
            .save_source_cursor(
                serde_json::from_value(json!({
                    "sourceUri":"old-inventory","lastMtimeMs":0,"lastHash":null,"writeBurstCount":0,
                    "cooldownUntil":0,"lastExploredAt":0,"updatedAt":1
                }))
                .unwrap(),
                None,
            )
            .await
            .unwrap();
        let topic: DossierUpsert =
            serde_json::from_value(json!({"topic_id":"release","expected_revision":0,
            "title":"Release", "signal":"yellow","summary_md":"Waiting","priority_weight":1}))
            .unwrap();
        let initial = discovery
            .upsert_dossier(topic, UnixMillis(1))
            .await
            .unwrap();

        let input = serde_json::from_value(json!({"title":"Review","intentBody":"","maxFires":1,
            "schedule":{"kind":"interval","everySeconds":3600,"startAt":HOUR,"cadence":"after_completion"},
            "effect":{"kind":"discovery","target":{"sessionId":"bot","workspace":{"path":"/work"},"permissions":{"access":"read_only","requestPermissions":false},
                "boundaryRevision":0,"binding":{"id":Uuid::new_v4(),"permissionEpoch":0}},
                "model":{"modelId":"model","connectionId":"test"},"workerTools":"read_only"}
        })).unwrap();
        let mut plan = scheduler::Plan::create(
            "hourly".into(),
            input,
            maka_scheduler::task::Creator::User,
            "UTC".into(),
            0,
        )
        .unwrap();
        for hour in 1..=12 {
            let at = hour * HOUR;
            assert!(plan.claim(at).unwrap().is_some());
            let decision = broad_mode(Some(&map), deltas(at), async |map| periodic(map, at).await)
                .await
                .unwrap();
            assert_eq!(decision, None);
            plan.skip_pending_schedule(at).unwrap();
            writer
                .write(discovery.skip_statement(plan.task.id.clone(), false))
                .await
                .unwrap();
        }
        let due = 13 * HOUR;
        assert_eq!(
            broad_mode(Some(&map), deltas(due), async |map| periodic(map, due)
                .await)
            .await
            .unwrap(),
            Some(DiscoveryMode::Wander {
                sources: vec!["unfinished".into()]
            })
        );
        assert_eq!(plan.task.next_fire_at, Some(13 * HOUR));
        assert_eq!((plan.task.fire_count, plan.task.last_fire_at), (0, None));
        assert!(plan.task.runs.is_empty());
        let activity = discovery.plan_activity(&plan.task.id).await.unwrap();
        assert_eq!(
            (activity.skipped, activity.model_runs, activity.tokens),
            (12, 0, 0)
        );
        assert_eq!(
            discovery
                .get_dossier(initial.topic_id)
                .await
                .unwrap()
                .unwrap()
                .revision,
            initial.revision
        );
        assert_eq!(
            broad_mode(
                Some(&map),
                async { Err("delta read failed".into()) },
                async |map| periodic(map, 0).await
            )
            .await
            .unwrap_err(),
            "delta read failed"
        );
    }

    #[test]
    fn discovery_manual_check_runs_onboard_until_workspace_map_is_ready() {
        let mut map = WorkspaceMap::default();
        assert_eq!(triggered_mode(FireSource::Manual, "", false), None);
        assert_eq!(manual_mode(Some(&map)), DiscoveryMode::Onboard);
        assert_eq!(manual_mode(None), DiscoveryMode::FollowUp);
        map.phase = MapPhase::Ready;
        assert_eq!(manual_mode(Some(&map)), DiscoveryMode::FollowUp);
        assert_eq!(
            triggered_mode(FireSource::Manual, "Summarize the week", false),
            Some(DiscoveryMode::Briefing)
        );
    }
}
