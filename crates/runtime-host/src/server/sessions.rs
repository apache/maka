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

mod bundle;
pub(super) mod configuration;
pub(super) mod copy;
pub(super) mod create;
pub(super) use crate::session::model;
pub(super) mod mutation;
pub(super) mod removal;
pub(super) mod workspace;

use crate::session::SessionConfiguration;
use maka_event_log::StoreError;
use maka_event_log::sessions::SessionRecord;
use maka_protocol::OperationErrorCode;
use maka_protocol::session::*;
use maka_protocol::{Operation, OperationError, ProtocolError};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, OperationError>;

#[derive(serde::Serialize)]
#[serde(untagged)]
pub(super) enum Output {
    BundlePreviewed(maka_protocol::session::bundle::Previewed),
    BundleExported(maka_protocol::session::bundle::Exported),
    BundleImported(maka_protocol::session::bundle::Imported),
    Query(SessionCatalogQueryResult),
    Item(Box<SessionCatalogProjection>),
    Mutation(SessionUpdateResult),
    Copy(maka_protocol::session::copy::Output),
    Abandon(maka_protocol::session::copy::AbandonOutput),
    CopyReceipt(maka_protocol::session::copy::QueryResult),
    Sources(maka_protocol::session::sources::Output),
    Removed(SessionRemoveResult),
    RemovalPreview(SessionRemovePreviewResult),
    RemovalReceipt(SessionRemoveQueryResult),
}

impl Output {
    pub(super) fn refresh_catalog(&self) -> bool {
        matches!(
            self,
            Self::Item(_) | Self::Mutation(SessionUpdateResult::Committed { .. })
        )
    }
}

pub(super) use maka_protocol::session::{decode_input, decode_output, supports};

pub(super) async fn execute(
    host: &super::Host,
    operation: Operation,
    value: &Value,
) -> Result<Output> {
    let log = host.log.as_ref();
    match operation {
        Operation::SessionBundlePreview => bundle::preview(
            host,
            maka_protocol::session::bundle::decode_preview(value).map_err(invalid)?,
        )
        .await
        .map(Output::BundlePreviewed),
        Operation::SessionBundleExport => bundle::export(
            host,
            maka_protocol::session::bundle::decode_export(value).map_err(invalid)?,
        )
        .await
        .map(Output::BundleExported),
        Operation::SessionBundleImport => bundle::import(
            host,
            maka_protocol::session::bundle::decode_import(value).map_err(invalid)?,
        )
        .await
        .map(Output::BundleImported),
        Operation::SessionRemove => {
            removal::remove(host, decode_session_remove_input(value).map_err(invalid)?)
                .await
                .map(Output::Removed)
        }
        Operation::SessionRemovePreview => removal::preview(
            host,
            decode_session_remove_preview_input(value).map_err(invalid)?,
        )
        .await
        .map(Output::RemovalPreview),
        Operation::SessionRemoveQuery => removal::query(
            host,
            decode_session_remove_query_input(value).map_err(invalid)?,
        )
        .await
        .map(Output::RemovalReceipt),
        Operation::SessionSourcesQuery => {
            let input = maka_protocol::session::sources::decode_input(value).map_err(invalid)?;
            let messages = log
                .editable_turn(&input.session_id, &input.turn_id)
                .await
                .map_err(stored)?;
            if messages.is_empty()
                || log
                    .get_session::<SessionConfiguration>(&input.session_id)
                    .await
                    .map_err(stored)?
                    .is_none()
            {
                return Err(failure(
                    OperationErrorCode::NotFound,
                    "Turn source input not found",
                ));
            }
            crate::session::require_unmanaged(
                log,
                &input.session_id,
                OperationErrorCode::OperationConflict,
            )
            .await?;
            Ok(Output::Sources(maka_protocol::session::sources::Output {
                session_id: input.session_id,
                turn_id: input.turn_id,
                messages: messages.into_iter().map(Into::into).collect(),
            }))
        }
        Operation::SessionBranchCreate | Operation::SessionRevisionCreate => {
            let input =
                maka_protocol::session::copy::decode_input(operation, value).map_err(invalid)?;
            copy::create(host, input).await.map(Output::Copy)
        }
        Operation::SessionRevisionAbandon => {
            let input =
                maka_protocol::session::copy::decode_abandon_input(value).map_err(invalid)?;
            copy::abandon(host, input).await.map(Output::Abandon)
        }
        Operation::SessionCopyQuery => {
            let input = maka_protocol::session::copy::decode_query_input(value).map_err(invalid)?;
            let receipt = log
                .session_copy_receipt(&input.target_session_id)
                .await
                .map_err(stored)?;
            // Ownership and receipt are committed together. Check after reading
            // so a concurrent managed creation cannot leak its receipt.
            crate::session::require_unmanaged(
                log,
                &input.target_session_id,
                OperationErrorCode::OperationConflict,
            )
            .await?;
            if receipt
                .as_ref()
                .is_some_and(|receipt| receipt.request.target_session_id != input.target_session_id)
            {
                return Err(failure(
                    OperationErrorCode::InternalFailure,
                    "Copy receipt target mismatch",
                ));
            }
            Ok(Output::CopyReceipt(
                maka_protocol::session::copy::QueryResult { receipt },
            ))
        }
        Operation::SessionCreate => {
            let input = decode_session_create_input(value).map_err(invalid)?;
            let item = create::create(host, input.clone()).await?;
            assert_create_output_for_input(&input, &item).map_err(invalid)?;
            Ok(Output::Item(Box::new(item)))
        }
        Operation::SessionCatalogQuery => query(
            host,
            decode_session_catalog_query_input(value).map_err(invalid)?,
        )
        .await
        .map(Output::Query),
        Operation::SessionLifecycleSet => {
            let input = decode_session_lifecycle_set_input(value).map_err(invalid)?;
            crate::session::require_unmanaged(
                log,
                &input.session_id,
                OperationErrorCode::OperationConflict,
            )
            .await?;
            let _admission = host.executions.lock_admission().await;
            if input.state == SessionLifecycleState::Archived
                && host
                    .executions
                    .has_session_work(&input.session_id)
                    .await
                    .map_err(stored)?
            {
                return Err(failure(
                    OperationErrorCode::SessionBusy,
                    "Session still owns live or pending work",
                ));
            }
            let record = log
                .set_session_archived(
                    &input.session_id,
                    input.state == SessionLifecycleState::Archived,
                    super::configuration::now().map_err(super::configuration::failure)?,
                )
                .await
                .map_err(stored)?;
            let item = item(record);
            if input.state == SessionLifecycleState::Archived {
                host.capabilities
                    .registry
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .release_session(&input.session_id);
            }
            assert_lifecycle_output_for_input(&input, &item).map_err(invalid)?;
            Ok(Output::Item(Box::new(item)))
        }
        Operation::SessionMetadataUpdate => {
            mutation::metadata(log, value).await.map(Output::Mutation)
        }
        Operation::SessionReadMarkerSet => mutation::read_marker(log, value)
            .await
            .map(|item| Output::Item(Box::new(item))),
        Operation::SessionConfigurationUpdate => configuration::update(host, value)
            .await
            .map(Output::Mutation),
        Operation::SessionWorkspaceRelocate => {
            workspace::relocate(host, value).await.map(Output::Mutation)
        }
        _ => Err(failure(
            OperationErrorCode::OperationUnavailable,
            "Session operation is not installed",
        )),
    }
}

async fn query(
    host: &super::Host,
    input: SessionCatalogQueryInput,
) -> Result<SessionCatalogQueryResult> {
    let log = host.log.as_ref();
    if let SessionCatalogQueryInput::Get { session_id } = &input {
        let session = match log.get_session(session_id).await.map_err(stored)? {
            Some(record) => Some(Box::new(catalog_item(host, record).await?)),
            None => None,
        };
        return Ok(SessionCatalogQueryResult::Session { session });
    }
    let (revision, cursor) = match &input {
        SessionCatalogQueryInput::ListContinue { revision, cursor }
        | SessionCatalogQueryInput::PendingContinue { revision, cursor } => {
            (Some(revision.as_str()), Some(cursor.as_str()))
        }
        _ => (None, None),
    };
    let pending = matches!(
        input,
        SessionCatalogQueryInput::PendingStart | SessionCatalogQueryInput::PendingContinue { .. }
    );
    let result = if pending {
        log.scoped_sessions::<SessionConfiguration>(
            maka_event_log::sessions::CatalogScope::PendingInteractions,
            revision,
            cursor,
            true,
        )
        .await
    } else {
        log.list_sessions::<SessionConfiguration>(revision, cursor, 32)
            .await
    };
    let mut page = match result {
        Ok(page) => page,
        Err(StoreError::RevisionConflict { expected, actual }) => {
            return Ok(SessionCatalogQueryResult::RevisionChanged {
                expected_revision: expected,
                actual_revision: actual,
            });
        }
        Err(error) => return Err(stored(error)),
    };
    let mut sessions = Vec::new();
    for record in page.sessions {
        let id = record.id.clone();
        sessions.push(catalog_item(host, record).await?);
        let candidate =
            json!({"kind":"page","revision":page.revision,"sessions":sessions,"nextCursor":id});
        if candidate.to_string().len() > 48 * 1024 {
            sessions.pop();
            if sessions.is_empty() {
                return Err(failure(
                    OperationErrorCode::InternalFailure,
                    "Session item exceeds catalog page budget",
                ));
            }
            page.next_cursor = sessions.last().map(|item| item.id.clone());
            break;
        }
    }
    Ok(SessionCatalogQueryResult::Page {
        revision: page.revision,
        sessions,
        next_cursor: page.next_cursor,
    })
}

async fn catalog_item(
    host: &super::Host,
    record: SessionRecord<SessionConfiguration>,
) -> Result<SessionCatalogProjection> {
    let native_input = host
        .executions
        .native_input_availability(&record.id, &record.configuration)
        .await?;
    let mut item = item(record);
    item.native_input = native_input;
    Ok(item)
}

fn item(record: SessionRecord<SessionConfiguration>) -> SessionCatalogProjection {
    crate::session::catalog_projection(record)
}

fn invalid(error: ProtocolError) -> OperationError {
    failure(OperationErrorCode::InvalidRequest, &error.message)
}

fn failure(code: OperationErrorCode, message: &str) -> OperationError {
    OperationError {
        code,
        message: message.chars().take(1024).collect(),
    }
}

pub(super) fn stored(error: StoreError) -> OperationError {
    let code = match &error {
        StoreError::SessionConflict | StoreError::SessionRetired => {
            OperationErrorCode::OperationConflict
        }
        StoreError::SessionNotFound => OperationErrorCode::NotFound,
        StoreError::SessionBusy => OperationErrorCode::SessionBusy,
        StoreError::CommitUnknown(_) | StoreError::OperationUnknown => {
            OperationErrorCode::CommitOutcomeUnknown
        }
        _ => OperationErrorCode::PersistenceFailed,
    };
    failure(code, &error.to_string())
}
