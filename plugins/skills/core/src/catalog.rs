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

use crate::SkillFailureReason;
use crate::{DiscoveredSkill, DiscoverySnapshot, fields};
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SkillPreference")]
pub struct Preference {
    pub enabled: bool,
    pub pinned: bool,
}
impl Default for Preference {
    fn default() -> Self {
        Self {
            enabled: true,
            pinned: false,
        }
    }
}
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::PathBuf,
};

/// A failed preference read is not an empty/default preference map.
#[derive(Debug)]
pub enum Preferences {
    Available(BTreeMap<String, Preference>),
    Unavailable,
}

#[derive(Debug, Default)]
pub struct HostCapabilities {
    pub tools: HashSet<String>,
    pub capabilities: HashSet<String>,
}

/// A read-only view combining one file snapshot and one authoritative preference read.
pub struct Catalog<'a> {
    pub discovery: &'a DiscoverySnapshot,
    pub preferences: &'a Preferences,
    pub host: &'a HostCapabilities,
}

#[derive(Debug)]
pub struct LoadedInstructions<'a> {
    pub skill: &'a DiscoveredSkill,
    pub relative_path: PathBuf,
    pub instructions: String,
}

impl Catalog<'_> {
    /// Fingerprint the frozen inputs used by Skill and SkillSearch. Rejected
    /// files and discovery diagnostics are UI facts, not executable catalog input.
    pub fn fingerprint(&self) -> Result<String, serde_json::Error> {
        let inventory: Vec<_> = self
            .discovery
            .inventory
            .iter()
            .map(|skill| {
                let location = &skill.location;
                (
                    &location.reference,
                    &location.id,
                    &location.path,
                    &location.discovery_root,
                    &location.scope,
                    &location.source,
                    location.precedence,
                    &skill.content_sha256,
                    &skill.document.manifest,
                    &skill.shadowed_by,
                    skill.resources.fingerprint(),
                )
            })
            .collect();
        let preferences = match self.preferences {
            Preferences::Available(values) => Some(
                values
                    .iter()
                    .map(|(id, preference)| (id, preference.enabled, preference.pinned))
                    .collect::<Vec<_>>(),
            ),
            Preferences::Unavailable => None,
        };
        let tools: BTreeSet<_> = self.host.tools.iter().collect();
        let capabilities: BTreeSet<_> = self.host.capabilities.iter().collect();
        serde_json::to_vec(&(
            "maka.skills.execution.v1",
            inventory,
            preferences,
            tools,
            capabilities,
        ))
        .map(|bytes| maka_agent_facts::artifact::content_digest(&bytes))
    }

    pub fn available(&self) -> impl Iterator<Item = &DiscoveredSkill> {
        self.discovery.inventory.iter().filter(|skill| {
            skill.shadowed_by.is_none() && self.enabled(skill) && self.compatible(skill)
        })
    }

    pub fn load(&self, request: &str) -> Result<LoadedInstructions<'_>, SkillFailureReason> {
        let request = request.trim_matches(fields::whitespace);
        if request.is_empty()
            || request
                .chars()
                .any(|c| matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'))
        {
            return Err(SkillFailureReason::InvalidName);
        }
        if matches!(self.preferences, Preferences::Unavailable) {
            return Err(SkillFailureReason::ResolutionFailed);
        }
        let key = request.to_lowercase();
        let visible = || {
            self.discovery
                .inventory
                .iter()
                .filter(|skill| skill.shadowed_by.is_none())
        };
        // Resolve the physical reference or effective name before eligibility;
        // disabling an override does not silently enable its shadowed version.
        let skill = self
            .discovery
            .inventory
            .iter()
            .find(|skill| skill.location.reference.to_lowercase() == key)
            .or_else(|| visible().find(|skill| skill.document.manifest.name.to_lowercase() == key))
            .or_else(|| visible().find(|skill| skill.location.id.to_lowercase() == key))
            .ok_or(SkillFailureReason::NotFound)?;
        if skill.shadowed_by.is_some() {
            return Err(SkillFailureReason::NotFound);
        }
        if !self.enabled(skill) {
            return Err(SkillFailureReason::Disabled);
        }
        if !self.compatible(skill) {
            return Err(SkillFailureReason::HostIncompatible);
        }
        let instructions = fields::clean(&skill.document.body);
        let relative_path = skill
            .location
            .path
            .strip_prefix(&skill.location.discovery_root)
            .map_err(|_| SkillFailureReason::ResolutionFailed)?
            .join("SKILL.md");
        Ok(LoadedInstructions {
            skill,
            relative_path,
            instructions,
        })
    }
    fn enabled(&self, skill: &DiscoveredSkill) -> bool {
        match self.preferences {
            Preferences::Available(preferences) => {
                preferences
                    .get(&skill.location.reference)
                    .copied()
                    .unwrap_or_default()
                    .enabled
            }
            Preferences::Unavailable => false,
        }
    }

    fn compatible(&self, skill: &DiscoveredSkill) -> bool {
        let attributes = &skill.document.manifest.attributes;
        attributes
            .required_tools
            .iter()
            .all(|tool| self.host.tools.contains(tool))
            && attributes
                .required_capabilities
                .iter()
                .all(|cap| self.host.capabilities.contains(cap))
    }
}

impl DiscoverySnapshot {
    pub(crate) fn resolve_precedence(&mut self) {
        let mut names = HashMap::<String, String>::new();
        for skill in &mut self.inventory {
            let name = skill.document.manifest.name.to_lowercase();
            if let Some(reference) = names.get(&name) {
                skill.shadowed_by = Some(reference.clone());
            } else {
                names.insert(name, skill.location.reference.clone());
            }
        }
    }
}
