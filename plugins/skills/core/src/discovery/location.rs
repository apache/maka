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

use crate::{SkillScope, SkillSource};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Standard user/project configuration locations, ordered from highest precedence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "ConfigurationLocation")]
pub enum LocationId {
    #[serde(rename = "project:maka")]
    ProjectMaka,
    #[serde(rename = "project:agents")]
    ProjectAgents,
    #[serde(rename = "user:maka")]
    UserMaka,
    #[serde(rename = "user:agents")]
    UserAgents,
}
impl LocationId {
    pub const ALL: [Self; 4] = [
        Self::ProjectMaka,
        Self::ProjectAgents,
        Self::UserMaka,
        Self::UserAgents,
    ];
    pub fn configuration_directory(self) -> &'static str {
        match self {
            Self::ProjectMaka | Self::UserMaka => ".maka",
            Self::ProjectAgents | Self::UserAgents => ".agents",
        }
    }

    pub fn reference(self) -> &'static str {
        match self {
            Self::ProjectMaka => "project:maka",
            Self::ProjectAgents => "project:agents",
            Self::UserMaka => "user:maka",
            Self::UserAgents => "user:agents",
        }
    }
    pub fn directory(self) -> &'static str {
        match self {
            Self::ProjectMaka | Self::UserMaka => ".maka/skills",
            Self::ProjectAgents | Self::UserAgents => ".agents/skills",
        }
    }
    pub fn scope(self) -> SkillScope {
        match self {
            Self::ProjectMaka | Self::ProjectAgents => SkillScope::Project,
            Self::UserMaka | Self::UserAgents => SkillScope::User,
        }
    }
    pub fn source(self) -> SkillSource {
        match self {
            Self::ProjectMaka | Self::UserMaka => SkillSource::Maka,
            Self::ProjectAgents | Self::UserAgents => SkillSource::Agents,
        }
    }
}
