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

use crate::{Access, Error, invalid, repository::digest};
use maka_agent_facts::execution::BehaviorId;
use maka_agent_ports::session::catalog::List;
use maka_agent_ports::session::catalog::Queries;
use maka_agent_ports::session::catalog::Summary;
use maka_capabilities::authorization::Target;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub reference: String,
    pub summary: Summary,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidates {
    pub revision: String,
    pub entries: Vec<Candidate>,
    pub truncated: bool,
}

/// Discovery needs read consent. Seeing a candidate does not grant execution on it.
pub async fn discover(
    access: &Access,
    queries: &Arc<dyn Queries>,
    coordinator: &str,
) -> Result<Candidates, Error> {
    let authorized = access.open(&Target::Profile).await?;
    let result = async {
        let mut input = List::default();
        let mut entries = Vec::new();
        loop {
            let page = queries.list(authorized.call.scope(), input).await?;
            for summary in page.entries {
                let session = &summary.session;
                if session.session_id != coordinator
                    && session.behavior == BehaviorId::default()
                    && !summary
                        .labels
                        .iter()
                        .any(|label| label == "mode:side_conversation")
                {
                    entries.push(summary);
                    if entries.len() == 17 {
                        break;
                    }
                }
            }
            if entries.len() == 17 || page.next_cursor.is_none() {
                break;
            }
            input = List {
                include_archived: false,
                revision: Some(page.revision),
                cursor: page.next_cursor,
            };
        }
        let truncated = entries.len() > 16;
        entries.truncate(16);
        // Bind choices to the exact bounded surface, not an unrelated catalog mutation.
        let revision = digest(&entries)?;
        let entries = entries
            .into_iter()
            .enumerate()
            .map(|(index, summary)| Candidate {
                reference: format!("c{}", index + 1),
                summary,
            })
            .collect();
        Ok(Candidates {
            revision,
            entries,
            truncated,
        })
    }
    .await;
    authorized.call.finish().await.map_err(invalid)?;
    result
}
