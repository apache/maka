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

use super::{Error, Progress, StepStatus, identifier, invalid, text};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub title: String,
    pub overview: Option<String>,
    #[schemars(length(min = 1, max = 50))]
    pub steps: Vec<Step>,
    #[serde(default)]
    #[schemars(length(max = 20))]
    pub risks: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Step {
    #[schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9_-]+$"))]
    pub id: String,
    #[schemars(length(min = 1, max = 30))]
    pub title: String,
    pub description: String,
    #[serde(default)]
    #[schemars(length(max = 50))]
    pub files: Vec<String>,
    pub complexity: Option<Complexity>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Complexity {
    Low,
    Medium,
    High,
}

impl Artifact {
    pub fn validate(&self) -> Result<(), Error> {
        text(&self.title, 16 * 1024)?;
        if let Some(overview) = &self.overview {
            text(overview, 16 * 1024)?;
        }
        if self.steps.is_empty() || self.steps.len() > 50 || self.risks.len() > 20 {
            return Err(invalid("Plan requires 1–50 steps and at most 20 risks"));
        }
        let mut ids = BTreeSet::new();
        for step in &self.steps {
            identifier(&step.id)?;
            text(&step.title, 120)?;
            text(&step.description, 16 * 1024)?;
            if step.title.chars().count() > 30 || !ids.insert(&step.id) || step.files.len() > 50 {
                return Err(invalid(
                    "invalid Plan step title, duplicate id, or too many files",
                ));
            }
            for file in &step.files {
                text(file, 16 * 1024)?;
            }
        }
        for risk in &self.risks {
            text(risk, 16 * 1024)?;
        }
        // Reserve room for progress and the execution request in the 64 KiB
        // public submit contract, including JSON escaping rather than just text.
        if serde_json::to_vec(self).map_err(invalid)?.len() > 40 * 1024 {
            return Err(invalid("Plan artifact exceeds 40 KiB"));
        }
        Ok(())
    }

    pub(super) fn progress(&self, steps: &[Progress]) -> Result<(), Error> {
        let expected: BTreeSet<_> = self.steps.iter().map(|s| &s.id).collect();
        let actual: BTreeSet<_> = steps.iter().map(|s| &s.id).collect();
        if steps.len() != self.steps.len()
            || expected != actual
            || steps
                .iter()
                .filter(|s| s.status == StepStatus::InProgress)
                .count()
                > 1
        {
            return Err(invalid(
                "include every Plan step exactly once, at most one in progress",
            ));
        }
        for step in steps {
            if let Some(note) = &step.note {
                text(note, 1024)?;
            }
        }
        if serde_json::to_vec(steps).map_err(invalid)?.len() > 12 * 1024 {
            return Err(invalid("Plan progress exceeds 12 KiB"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{Command, Phase, Snapshot};

    #[test]
    fn bounded_artifacts_survive_request_freezing_and_reject_ambiguous_progress() {
        let mut artifact = Artifact {
            title: "界".repeat(30),
            overview: None,
            steps: (0..50)
                .map(|i| Step {
                    id: format!("step_{i}"),
                    title: "界".repeat(30),
                    description: "\"\\\n".repeat(90),
                    files: vec![],
                    complexity: None,
                })
                .collect(),
            risks: vec![],
        };
        let mut snapshot = Snapshot::default();
        snapshot
            .apply(
                &Command::Propose {
                    turn_id: "turn".into(),
                    artifact: artifact.clone(),
                },
                "propose",
                "session",
                1,
            )
            .unwrap();
        snapshot
            .apply(
                &Command::Approve {
                    grant: maka_plugins::authorization::Id(uuid::Uuid::from_u128(1)),
                    proposal_id: snapshot.proposal.as_ref().unwrap().id.clone(),
                    proposal_revision: 1,
                    behavior: Default::default(),
                },
                "approve",
                "session",
                2,
            )
            .unwrap();
        let execution = snapshot.execution.as_ref().unwrap();
        assert!(matches!(execution.phase, Phase::AwaitingAdmission));
        execution.request.validate().unwrap();
        let mut progress = execution.steps.clone();
        progress[1].id = progress[0].id.clone();
        assert!(artifact.progress(&progress).is_err());
        progress = execution.steps.clone();
        progress[0].status = StepStatus::InProgress;
        progress[1].status = StepStatus::InProgress;
        assert!(artifact.progress(&progress).is_err());
        for step in &mut artifact.steps {
            step.description = "界".repeat(600);
        }
        assert!(
            artifact.validate().is_err(),
            "aggregate UTF-8 budget must apply before approval"
        );
    }
}
