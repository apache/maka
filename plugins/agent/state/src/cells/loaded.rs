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

use super::*;
use maka_agent_facts::{artifact::ToolReturn, tool_output::ToolOutput};
use rusqlite::params;
use serde::Deserialize;
#[derive(Deserialize)]
struct ReturnedSearch {
    output: ToolOutput,
    is_error: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchResult {
    activated: BTreeSet<String>,
}
pub(crate) fn apply_tools_loaded(
    c: &Connection,
    session: &str,
    recorded: &RecordedFact,
    changes: &[Change],
) -> Result<(), StoreError> {
    let Fact::ToolsLoaded { tool, names } = &recorded.fact else {
        return Ok(());
    };
    let accepted=changes.iter().filter(|change|matches!(&change.fact,Fact::ToolResultAccepted{tool:key,outcome:AcceptedResult::Succeeded,..} if key==tool)).count();
    if accepted != 1 {
        return Err(invalid(
            "loaded tools require the exact same-batch successful tool acceptance",
        ));
    }
    let body: String = c.query_row(
        "SELECT body FROM agent_tools WHERE run=? AND key=?",
        params![recorded.run.to_string(), crate::fold::tool_key(tool)],
        |r| r.get(0),
    )?;
    let source: crate::fold::Tool = serde_json::from_str(&body)?;
    if source.call.name != "tool_search" {
        return Err(invalid("only accepted tool discovery can activate tools"));
    }
    let returned = source
        .local_returned
        .ok_or_else(|| invalid("tool discovery has no original local return"))?;
    let bytes = crate::sql::owned_content(c, recorded.run, &returned.result)?;
    let original: ToolReturn<ReturnedSearch> = serde_json::from_slice(&bytes)?;
    original.validate().map_err(invalid)?;
    if original.body.is_error || returned.is_error {
        return Err(invalid("failed discovery cannot activate tools"));
    }
    let ToolOutput::Json(value) = original.body.output else {
        return Err(invalid("discovery result is not canonical JSON"));
    };
    let activated: SearchResult = serde_json::from_value(value)?;
    if activated.activated != *names || names.iter().any(|n| n.is_empty() || n.len() > 128) {
        return Err(invalid(
            "loaded tools differ from exact original discovery result",
        ));
    }
    sql::merge_loaded(c, session, recorded.id, names)
}
