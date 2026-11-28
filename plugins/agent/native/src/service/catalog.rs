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
use maka_agent_state::session_catalog::{Filter, Position, Record, SideQuestions};

pub(super) async fn catalog_scope(owner: &Owner, input: &List) -> Result<CatalogScope, String> {
    let selection = match &input.scope {
        SessionListScope::All => CatalogSelection::All,
        SessionListScope::SideQuestions { session_id } => {
            owner.require_session(session_id).await?;
            CatalogSelection::All
        }
        SessionListScope::Children { session_id } => {
            owner.require_session(session_id).await?;
            CatalogSelection::Children(session_id.clone())
        }
        SessionListScope::Project { project_id } => CatalogSelection::Project(*project_id),
        SessionListScope::Workspace { session_id } => CatalogSelection::Workspace {
            session_id: session_id.clone(),
            path: owner
                .session(session_id)
                .await?
                .configuration
                .workspace
                .path,
        },
    };
    Ok(CatalogScope::Owned {
        id_prefix: owner.prefix.clone(),
        selection,
        title_query: input.title_query.clone(),
    })
}

pub(super) fn catalog_filter(input: &List) -> Filter {
    Filter {
        base: maka_event_log::sessions::CatalogFilter {
            roots_only: input.roots_only,
            archived_only: matches!(input.filter, SessionFilter::Archived),
            include_archived: input.include_archived
                || matches!(input.filter, SessionFilter::Archived),
        },
        needs_you_only: matches!(input.filter, SessionFilter::NeedsYou),
        room: input.kind.map(|kind| kind == SessionKind::Room),
        side: match &input.scope {
            SessionListScope::SideQuestions { session_id } => SideQuestions::Of(session_id.clone()),
            _ => SideQuestions::Hidden,
        },
    }
}

pub(super) async fn catalog_revision(owner: &Owner, input: &List) -> Result<String, String> {
    owner
        .canonical_catalog()?
        .revision(catalog_scope(owner, input).await?, catalog_filter(input))
        .await
        .map_err(catalog_error)
}

pub(super) async fn catalog_page(
    owner: &Owner,
    input: &List,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<SessionPage, String> {
    let (revision, position) = match &input.position {
        crate::contract::SessionPosition::Start => (None, Position::Start),
        crate::contract::SessionPosition::At { cursor } => (None, Position::At(cursor.clone())),
        crate::contract::SessionPosition::After { revision, cursor } => {
            (Some(revision.clone()), Position::After(cursor.clone()))
        }
        crate::contract::SessionPosition::Before { revision, cursor } => {
            (Some(revision.clone()), Position::Before(cursor.clone()))
        }
    };
    if matches!(&position, Position::At(cursor) | Position::After(cursor) | Position::Before(cursor) if !owner.owns(cursor))
    {
        return Err("agent_cursor_invalid".into());
    }
    let reverse = matches!(position, Position::Before(_));
    let page = owner
        .canonical_catalog()?
        .with_cancellation(stop.clone())
        .page(
            catalog_scope(owner, input).await?,
            revision,
            position,
            catalog_filter(input),
            32,
        )
        .await
        .map_err(catalog_error)?;
    let sessions = page
        .sessions
        .into_iter()
        .map(|record| summary(owner, record))
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = SessionPage {
        revision: page.revision,
        sessions,
        needs_you_count: page.pending_session_count,
        before: page.previous_cursor,
        after: page.next_cursor,
    };
    while !maka_workspace_support::fits(&result) && result.sessions.len() > 1 {
        if reverse {
            result.sessions.remove(0);
            result.before = result.sessions.first().map(|session| session.id.clone());
        } else {
            result.sessions.pop();
            result.after = result.sessions.last().map(|session| session.id.clone());
        }
    }
    Ok(result)
}

fn catalog_error(error: maka_event_log::StoreError) -> String {
    match error {
        maka_event_log::StoreError::RevisionConflict { .. } => "agent_catalog_changed".into(),
        error => format!("agent_catalog_unavailable: {error}"),
    }
}

pub(crate) fn summary(owner: &Owner, record: Record) -> Result<Session, String> {
    summary_for(&owner.data_source, record)
}

pub(crate) fn summary_for(data_source: &DataSource, record: Record) -> Result<Session, String> {
    let SessionRecord {
        id,
        revision,
        created_at,
        updated_at,
        archived,
        configuration,
        workspace_binding,
        configuration_digest,
    } = record.metadata;
    let session = resolve_session(SessionRecord {
        id,
        revision,
        created_at,
        updated_at,
        archived,
        workspace_binding,
        configuration_digest,
        configuration: serde_json::from_value::<StoredSessionConfiguration>(configuration)
            .map_err(|error| format!("agent_session_configuration_invalid: {error}"))?,
    })?;
    let activity = if record.status.pending_interaction_since.is_some() {
        SessionActivity::Waiting
    } else if record.status.working {
        SessionActivity::Working
    } else {
        SessionActivity::Idle
    };
    let branch = record
        .lineage
        .as_ref()
        .and_then(|lineage| lineage.branch())
        .map(|origin| SessionBranch {
            session_id: origin.parent_session_id.clone(),
            position: origin.position.clone(),
            side: origin.side,
        });
    let discovery_worker = session.configuration.discovery_worker || record.legacy_discovery_worker;
    Ok(Session {
        kind: if record.is_room {
            SessionKind::Room
        } else {
            SessionKind::Agent
        },
        discovery_worker,
        discovery_run: discovery_worker.then(|| DiscoveryRunStatus {
            started_at: session.created_at,
            terminal: record.status.latest.and_then(|r| r.terminal),
        }),
        incognito: session.configuration.incognito,
        parent_session_id: session.configuration.parent_session_id,
        ancestor_ids: record.ancestor_ids,
        parent_title: record.parent_title,
        branch,
        backend: session.configuration.backend,
        applied_preset: session.configuration.applied_preset,
        tools: session.configuration.tools,
        data_source: Box::new(data_source.clone()),
        permissions: session.configuration.permissions,
        boundary_revision: session.configuration.boundary_revision,
        binding: session.configuration.binding,
        activity,
        id: session.id,
        revision: session.revision,
        title: session.configuration.title,
        labels: session.configuration.labels,
        workspace: session.configuration.workspace,
        created_at: session.created_at,
        updated_at: session.updated_at,
        archived: session.archived,
        pinned: session.configuration.pinned,
        has_unread: record.read_state.has_unread,
        has_active_children: record.has_active_children,
        tail_message_id: record.last_message.map(|message| message.tail_message_id),
    })
}

pub(super) const CATALOG_REFRESH_MIN_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(150);

pub(super) async fn wait_for_catalog_refresh(
    changes: &mut tokio::sync::watch::Receiver<()>,
    physical: &mut tokio::sync::watch::Receiver<()>,
    physical_changed: &mut bool,
    cancellation: &tokio_util::sync::CancellationToken,
    throttle_until: Option<tokio::time::Instant>,
) -> Result<(), String> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err("agent_observation_cancelled".into()),
        result = changes.changed() => result.map_err(|_| "agent_observation_closed")?,
        result = physical.changed() => {
            result.map_err(|_| "agent_observation_closed")?;
            *physical_changed = true;
        }
    }
    if let Some(deadline) = throttle_until {
        let now = tokio::time::Instant::now();
        if deadline > now {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err("agent_observation_cancelled".into()),
                _ = tokio::time::sleep_until(deadline) => {}
            }
            if changes.has_changed().is_err() || physical.has_changed().is_err() {
                return Err("agent_observation_closed".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};
    use tokio::sync::watch;
    use tokio::time::{Duration, Instant};
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn refresh_wait_returns_immediately_when_throttle_elapsed() {
        let (tx, mut changes) = watch::channel(());
        let (_ptx, mut physical) = watch::channel(());
        let mut physical_changed = false;
        let cancel = CancellationToken::new();

        let deadline = Instant::now();
        tx.send_replace(());

        let mut fut = pin!(wait_for_catalog_refresh(
            &mut changes,
            &mut physical,
            &mut physical_changed,
            &cancel,
            Some(deadline),
        ));
        let mut cx = Context::from_waker(Waker::noop());
        assert_eq!(fut.as_mut().poll(&mut cx), Poll::Ready(Ok(())));
    }

    #[tokio::test]
    async fn refresh_wait_coalesces_burst_until_trailing_deadline() {
        let (tx, mut changes) = watch::channel(());
        let (ptx, mut physical) = watch::channel(());
        let mut physical_changed = false;
        let cancel = CancellationToken::new();

        let deadline = Instant::now() + Duration::from_millis(80);
        tx.send_replace(());

        {
            let mut fut = pin!(wait_for_catalog_refresh(
                &mut changes,
                &mut physical,
                &mut physical_changed,
                &cancel,
                Some(deadline),
            ));
            let mut cx = Context::from_waker(Waker::noop());
            assert!(fut.as_mut().poll(&mut cx).is_pending());

            tx.send_replace(());
            ptx.send_replace(());
            assert!(fut.as_mut().poll(&mut cx).is_pending());

            tokio::time::timeout(Duration::from_secs(2), fut)
                .await
                .unwrap()
                .unwrap();
        }
        assert!(Instant::now() >= deadline);
        physical_changed |= physical.borrow_and_update().has_changed();
        assert!(physical_changed);
    }

    #[tokio::test]
    async fn refresh_wait_cancels_immediately_during_throttle() {
        let (tx, mut changes) = watch::channel(());
        let (_ptx, mut physical) = watch::channel(());
        let mut physical_changed = false;
        let cancel = CancellationToken::new();

        let deadline = Instant::now() + Duration::from_secs(60);
        tx.send_replace(());

        let mut fut = pin!(wait_for_catalog_refresh(
            &mut changes,
            &mut physical,
            &mut physical_changed,
            &cancel,
            Some(deadline),
        ));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(fut.as_mut().poll(&mut cx).is_pending());

        cancel.cancel();
        let err = tokio::time::timeout(Duration::from_secs(2), fut)
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(err, "agent_observation_cancelled");
    }

    #[tokio::test]
    async fn refresh_wait_reports_closed_when_sender_drops_during_throttle() {
        let (tx, mut changes) = watch::channel(());
        let (_ptx, mut physical) = watch::channel(());
        let mut physical_changed = false;
        let cancel = CancellationToken::new();

        let deadline = Instant::now() + Duration::from_millis(40);
        tx.send_replace(());

        let mut fut = pin!(wait_for_catalog_refresh(
            &mut changes,
            &mut physical,
            &mut physical_changed,
            &cancel,
            Some(deadline),
        ));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(fut.as_mut().poll(&mut cx).is_pending());

        drop(tx);
        let err = tokio::time::timeout(Duration::from_secs(2), fut)
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(err, "agent_observation_closed");
    }
}
