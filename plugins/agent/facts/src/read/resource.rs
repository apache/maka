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

use crate::{
    archive::ToolResultAddress, attachment::ATTACHMENT_RESOURCE_PREFIX, interaction::entity_id,
    shell_result::RESOURCE_REF_PREFIX,
};

/// A Session resource locator; resolving it never grants access to its content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResourceAddress {
    Attachment(String),
    Task(String),
    ToolResult(String),
}

impl ResourceAddress {
    /// Ordinary filesystem paths have no resource address.
    pub fn parse(path: &str) -> Result<Option<Self>, &'static str> {
        if path.starts_with("archive:") || path.starts_with("maka://runtime/tool-results/") {
            return ToolResultAddress::parse(path)
                .map(|address| Some(Self::ToolResult(address.event_id().to_owned())));
        }
        for (short, full, attachment) in [
            ("attachment:", ATTACHMENT_RESOURCE_PREFIX, true),
            ("task:", RESOURCE_REF_PREFIX, false),
        ] {
            if let Some(id) = path.strip_prefix(short).or_else(|| path.strip_prefix(full)) {
                entity_id(id)?;
                return Ok(Some(if attachment {
                    Self::Attachment(id.into())
                } else {
                    Self::Task(id.into())
                }));
            }
        }
        if path.contains("://") {
            return Err("Unsupported Maka address; use a path returned by a tool");
        }
        Ok(None)
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Attachment(id) | Self::Task(id) | Self::ToolResult(id) => id,
        }
    }

    pub fn with_id(mut self, resolved: String) -> Self {
        match &mut self {
            Self::Attachment(id) | Self::Task(id) | Self::ToolResult(id) => *id = resolved,
        }
        self
    }

    pub fn canonical_path(&self) -> Result<String, &'static str> {
        match self {
            Self::Attachment(id) => {
                entity_id(id)?;
                Ok(format!("{ATTACHMENT_RESOURCE_PREFIX}{id}"))
            }
            Self::Task(id) => {
                entity_id(id)?;
                Ok(format!("{RESOURCE_REF_PREFIX}{id}"))
            }
            Self::ToolResult(id) => ToolResultAddress::event_path(id),
        }
    }
}
