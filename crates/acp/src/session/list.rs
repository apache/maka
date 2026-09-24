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

use crate::Error;
use agent_client_protocol::schema::v2 as acp;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use maka_client::Client;
use maka_protocol::session::{
    SessionCatalogProjection, SessionCatalogQueryInput as Query,
    SessionCatalogQueryResult as ResultPage, SessionStatus,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(super) fn ensure_idle(session: &SessionCatalogProjection) -> Result<(), Error> {
    if matches!(
        session.status,
        SessionStatus::Running | SessionStatus::WaitingForUser
    ) || session
        .live_run_state
        .as_ref()
        .is_some_and(|state| !state.running_turn_ids.is_empty())
    {
        return Err("Host session has active work outside this ACP request".into());
    }
    Ok(())
}

pub(super) async fn directory(path: &Path) -> Result<PathBuf, Error> {
    if !path.is_absolute() {
        return Err("Workspace cwd must be absolute".into());
    }
    let path = tokio::fs::canonicalize(path).await?;
    if !tokio::fs::metadata(&path).await?.is_dir() {
        return Err("Workspace cwd must be a directory".into());
    }
    Ok(path)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    revision: String,
    cursor: String,
    cwd: Option<PathBuf>,
}

pub(super) async fn read(
    client: &Client,
    request: acp::ListSessionsRequest,
) -> Result<acp::ListSessionsResponse, Error> {
    let cwd = match request.cwd {
        Some(path) => Some(directory(path.as_ref()).await?),
        None => None,
    };
    let query = if let Some(cursor) = request.cursor {
        let token = cursor.to_string();
        if token.len() > 8192 {
            return Err("ACP session list cursor is too large".into());
        }
        let cursor: Cursor = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token)?)?;
        if cursor.cwd != cwd {
            return Err("ACP session list cursor belongs to another cwd filter".into());
        }
        Query::ListContinue {
            revision: cursor.revision,
            cursor: cursor.cursor,
        }
    } else {
        Query::ListStart
    };
    let ResultPage::Page {
        revision,
        sessions,
        next_cursor,
    } = client.session_catalog(query).await?
    else {
        return Err("Host session catalog changed; restart pagination".into());
    };
    let mut results = Vec::new();
    for session in sessions {
        let path = PathBuf::from(&session.workspace.host_cwd);
        if !path.is_absolute() {
            return Err("Host session workspace is not absolute".into());
        }
        if let Some(filter) = &cwd
            && &path != filter
            && tokio::fs::canonicalize(&path).await.as_ref().ok() != Some(filter)
        {
            continue;
        }
        results.push(
            acp::SessionInfo::new(session.id, acp::AbsolutePath::new(path)).title(session.name),
        );
    }
    let next_cursor = next_cursor
        .map(|cursor| {
            let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor {
                revision,
                cursor,
                cwd,
            })?);
            if encoded.len() > 8192 {
                return Err("Host session catalog cursor exceeds ACP limit".into());
            }
            Ok::<_, Error>(acp::SessionListCursor::new(encoded))
        })
        .transpose()?;
    Ok(acp::ListSessionsResponse::new(results).next_cursor(next_cursor))
}
