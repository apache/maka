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

//! The three reads the Trace face sends, as Desktop's preload sends them
//! (`loadSessionTracePage`, `loadSessionUsageSummary` and
//! `inspector.context` in `apps/desktop/src/preload/preload.ts`), with the
//! paging of `use-session-trace.ts` (`readTracePageWindow`,
//! `readEarlierPage`).
//!
//! - The trace is read as a window of pages from the newest: the head page
//!   (`session_trace_start`), then each page before it from the last
//!   page's `nextCursor` (`session_trace_continue`), until the window holds
//!   the pages asked for or the oldest is read. A cursor seen twice, or one
//!   that names the page it was read with, would page forever: the read
//!   fails instead.
//! - The usage summary is every recorded call of the Session
//!   (`usage.query` `summary`, range all).
//! - The context snapshot is the latest settled request
//!   (`context.diagnostics.query`).

use std::sync::Arc;

use host_protocol::{
    ContextDiagnosticsQuery, ContextDiagnosticsQueryInput, ContextDiagnosticsResult,
    ExecutionInspectQuery, ExecutionInspectQueryInput, ExecutionInspectQueryResult,
    HostOperationErrorCode, SessionTracePage, UsageQuery, UsageQueryInput, UsageQueryResult,
};
use workspace::{HostRequestError, HostRequester};

use crate::model::SessionUsage;

/// Why a read failed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ReadFailure {
    /// The Host refused the operation.
    Operation { code: HostOperationErrorCode, message: Arc<str> },
    /// No connection to the Host.
    NotConnected,
    /// The connection failed.
    Transport(Arc<str>),
    /// The Host answered with a result this client does not read, or with
    /// pages that do not follow each other.
    Unexpected,
}

impl From<HostRequestError> for ReadFailure {
    fn from(error: HostRequestError) -> Self {
        match error {
            HostRequestError::NotConnected => Self::NotConnected,
            HostRequestError::Operation { code, message, .. } => Self::Operation { code, message },
            HostRequestError::Transport(message) => Self::Transport(message),
            other => Self::Transport(other.to_string().into()),
        }
    }
}

/// One page of `session`'s trace: the newest, or the one before the page
/// whose `nextCursor` is `cursor`.
pub async fn trace_page(
    requester: &HostRequester,
    session: &str,
    cursor: Option<String>,
) -> Result<SessionTracePage, ReadFailure> {
    let input = ExecutionInspectQueryInput::session_trace(session, cursor);
    match requester.request::<ExecutionInspectQuery>(&input).await? {
        ExecutionInspectQueryResult::SessionTracePage(page) if page.session_id == session => {
            Ok(page)
        }
        _ => Err(ReadFailure::Unexpected),
    }
}

/// The newest `count` pages of `session`'s trace (fewer when the trace has
/// fewer), newest first.
pub async fn trace_window(
    requester: &HostRequester,
    session: &str,
    count: usize,
) -> Result<Vec<SessionTracePage>, ReadFailure> {
    let mut pages: Vec<SessionTracePage> = Vec::new();
    let mut cursor: Option<String> = None;
    while pages.len() < count.max(1) {
        let page = trace_page(requester, session, cursor.clone()).await?;
        let next = page.next_cursor.clone();
        pages.push(page);
        let Some(next) = next else { break };
        if cursor.as_ref() == Some(&next)
            || pages[..pages.len() - 1].iter().any(|page| page.next_cursor.as_ref() == Some(&next))
        {
            return Err(ReadFailure::Unexpected);
        }
        cursor = Some(next);
    }
    Ok(pages)
}

/// The page before the window `loaded` (newest first) ends with, read from
/// `cursor`, the last page's `nextCursor`.
pub async fn earlier_page(
    requester: &HostRequester,
    session: &str,
    cursor: String,
    loaded: &[SessionTracePage],
) -> Result<SessionTracePage, ReadFailure> {
    let page = trace_page(requester, session, Some(cursor.clone())).await?;
    if let Some(next) = &page.next_cursor
        && (*next == cursor || loaded.iter().any(|page| page.next_cursor.as_ref() == Some(next)))
    {
        return Err(ReadFailure::Unexpected);
    }
    Ok(page)
}

/// Every recorded call of `session`, summed, and what the sums rest on.
pub async fn usage_summary(
    requester: &HostRequester,
    session: &str,
) -> Result<SessionUsage, ReadFailure> {
    match requester.request::<UsageQuery>(&UsageQueryInput::session_summary(session)).await? {
        UsageQueryResult::Summary { summary, provenance } => {
            Ok(SessionUsage::new(summary, provenance))
        }
        _ => Err(ReadFailure::Unexpected),
    }
}

/// What `session`'s context held at its latest settled request.
pub async fn context(
    requester: &HostRequester,
    session: &str,
) -> Result<ContextDiagnosticsResult, ReadFailure> {
    let input = ContextDiagnosticsQueryInput::new(session);
    match requester.request::<ContextDiagnosticsQuery>(&input).await? {
        ContextDiagnosticsResult::Unknown(_) => Err(ReadFailure::Unexpected),
        result => Ok(result),
    }
}
