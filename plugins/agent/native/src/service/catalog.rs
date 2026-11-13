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
use maka_agent_state::session_catalog::{Filter, Position, Record};

pub(super) async fn catalog_scope(owner: &Owner, input: &List) -> Result<CatalogScope, String> {
    let selection = match &input.scope {
        SessionListScope::All => CatalogSelection::All,
        SessionListScope::Children { session_id } => {
            owner.require_session(session_id).await?;
            CatalogSelection::Children(session_id.clone())
        }
        SessionListScope::Project { project_id } => CatalogSelection::Project(*project_id),
        SessionListScope::Workspace { session_id } => CatalogSelection::Workspace {
            session_id: session_id.clone(),
            identity: owner
                .session(session_id)
                .await?
                .configuration
                .workspace
                .identity,
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
    }
}

pub(super) async fn catalog_revision(owner: &Owner, input: &List) -> Result<String, String> {
    owner
        .canonical_catalog()?
        .revision(catalog_scope(owner, input).await?, catalog_filter(input))
        .await
        .map_err(catalog_error)
}

pub(super) async fn catalog_page(owner: &Owner, input: &List) -> Result<SessionPage, String> {
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
        });
    Ok(Session {
        parent_session_id: session.configuration.parent_session_id,
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
        updated_at: session.updated_at,
        archived: session.archived,
        pinned: session.configuration.pinned,
        has_unread: record.read_state.has_unread,
        tail_message_id: record.last_message.map(|message| message.tail_message_id),
    })
}
