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

//! What a side chat asks of the Host to make its fork and to dispose of
//! it, as Maka Desktop does: the boundary from the source's Turns
//! (`listSessionTurns`, `latestSettledTurnId`), `session.branch.create`
//! with the source's revision and the retry on a revision conflict
//! (`copySession` in apps/desktop/src/main/runtime-host-client.ts), the
//! create replayed before a removal whose create may still be in flight
//! (`resumeSessionCopy`, packages/storage/src/session-copy-cleanup.ts), and
//! a removal that stops the fork's runs first (`dismissCompanionCopy`):
//! `session.remove` refuses a Session with an active root Turn.

use std::time::Duration;

use gpui_kit::BackgroundExecutor;
use host_protocol::{
    HostOperationErrorCode, SessionBranchCreate, SessionCatalogItem, SessionCatalogProjection,
    SessionCatalogQuery, SessionCatalogQueryInput, SessionCatalogQueryResult,
    SessionConversationCopyInput, SessionConversationCopyResult, SessionRemove, SessionRemoveInput,
    SessionRemoveResult, SessionTurnsQuery, SessionTurnsQueryInput, TurnQuery, TurnQueryInput,
    TurnStop, TurnStopInput, latest_completed_turn,
};
use workspace::{HostRequestError, HostRequester};

use super::ledger::{ForkEntry, ForkPhase};

/// Desktop's `MAX_OPTIMISTIC_ATTEMPTS`: creates sent at a revision the
/// source had moved past, before giving up.
const CREATE_ATTEMPTS: usize = 3;

/// Removals of a fork tried before giving up for now: a revision that
/// moved, or a run that has not ended yet after its stop.
const REMOVE_ATTEMPTS: u32 = 4;

/// The wait before the removal after `attempt` refused because a run had
/// not ended: 250 ms, doubling.
fn busy_delay(attempt: u32) -> Duration {
    Duration::from_millis(250 << attempt.min(4))
}

/// Pages of Turns read before giving up on a source.
const TURN_PAGES: usize = 64;

/// Why a fork could not be made, as the side chat says it (Desktop's
/// `CompanionErrorCode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ForkError {
    /// Reading the source, the ledger, or the create failed
    /// (`fork_setup_failed`).
    SetupFailed,
    /// `session_busy`: a linked child of the source runs
    /// (`fork_source_busy`).
    SourceBusy,
    /// `operation_unavailable`: the source's context cannot be copied yet
    /// (`fork_unsupported`).
    Unsupported,
    /// The permission mode picked before the fork could not be set on it,
    /// so nothing was sent (Desktop's `respondFailed`).
    Respond,
}

/// A create that did not give a fork.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CreateFailure {
    /// The Host made nothing: the ledger entry can go.
    Refused(ForkError),
    /// `operation_conflict`, which the Host raises before it makes anything
    /// (`SessionRevisionCoordinator#copy`): the target's id is another
    /// request's (a Session there is not this fork, never to be removed),
    /// or the source is not one to copy this way. The same request would
    /// meet it again: the entry goes, and the next send names a new target.
    Conflict,
    /// The Host may have made it: the entry stays, and the next attempt
    /// sends the same request (same target, same boundary), which resolves
    /// to the fork if it exists.
    Unknown(ForkError),
}

impl CreateFailure {
    /// What the side chat says.
    pub(crate) fn error(self) -> ForkError {
        match self {
            Self::Refused(error) | Self::Unknown(error) => error,
            Self::Conflict => ForkError::SetupFailed,
        }
    }
}

/// What a create sent again before a removal found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Replayed {
    /// The fork is there, or no create of it can still commit: it is
    /// removed.
    Remove,
    /// `operation_conflict`: nothing was made for the entry, and a Session
    /// at its target is not its fork: settled with no removal.
    NothingMade,
}

/// The catalog projection of `session_id`, or `None` when the Host has no
/// such Session.
pub(crate) async fn catalog_get(
    requester: &HostRequester,
    session_id: &str,
) -> Result<Option<SessionCatalogProjection>, HostRequestError> {
    let input = SessionCatalogQueryInput::Get { session_id: session_id.to_owned() };
    match requester.request::<SessionCatalogQuery>(&input).await? {
        SessionCatalogQueryResult::Session {
            session: Some(SessionCatalogItem::Session(session)),
        } => Ok(Some(*session)),
        SessionCatalogQueryResult::Session { session: None } => Ok(None),
        _ => Err(HostRequestError::Transport(
            "session.catalog.query answered without the session".into(),
        )),
    }
}

/// The source's latest completed Turn, from every page of its Turns:
/// where a side chat's fork copies it through; `None` (an empty fork) when
/// no Turn of it completed.
pub(crate) async fn read_boundary(
    requester: &HostRequester,
    source: &str,
) -> Result<Option<String>, HostRequestError> {
    let mut input = SessionTurnsQueryInput::first(source);
    let mut contributions = Vec::new();
    for _ in 0..TURN_PAGES {
        let page = requester.request::<SessionTurnsQuery>(&input).await?;
        contributions.extend(page.contributions.iter().cloned());
        match input.after(&page) {
            Some(next) => input = next,
            None => return Ok(latest_completed_turn(&contributions)),
        }
    }
    Err(HostRequestError::Transport("the source has too many pages of Turns".into()))
}

/// Creates the fork `input` names, sending it again at the revision the
/// Host names while the source moves on.
pub(crate) async fn create(
    requester: &HostRequester,
    input: SessionConversationCopyInput,
) -> Result<SessionCatalogProjection, CreateFailure> {
    let mut input = input;
    for _ in 0..CREATE_ATTEMPTS {
        log::info!(
            "side chat: session.branch.create {} from {} through {:?} at revision {}",
            input.target_session_id,
            input.source_session_id,
            input.source_turn_id,
            input.expected_source_revision
        );
        match requester.request::<SessionBranchCreate>(&input).await {
            Ok(SessionConversationCopyResult::Committed {
                session: SessionCatalogItem::Session(session),
            }) if session.id == input.target_session_id => return Ok(*session),
            Ok(SessionConversationCopyResult::SourceRevisionConflict {
                actual_revision, ..
            }) => {
                input = input.at_revision(actual_revision);
            }
            Ok(other) => {
                log::warn!("side chat: session.branch.create answered {other:?}");
                return Err(CreateFailure::Unknown(ForkError::SetupFailed));
            }
            Err(HostRequestError::Operation { code, message, .. }) => {
                log::warn!("side chat: session.branch.create refused ({code}): {message}");
                return Err(match code {
                    HostOperationErrorCode::SessionBusy => {
                        CreateFailure::Refused(ForkError::SourceBusy)
                    }
                    HostOperationErrorCode::OperationUnavailable => {
                        CreateFailure::Refused(ForkError::Unsupported)
                    }
                    HostOperationErrorCode::OperationConflict => CreateFailure::Conflict,
                    HostOperationErrorCode::NotFound
                    | HostOperationErrorCode::InvalidRequest
                    | HostOperationErrorCode::HostNotReady
                    | HostOperationErrorCode::HostDraining => {
                        CreateFailure::Refused(ForkError::SetupFailed)
                    }
                    _ => CreateFailure::Unknown(ForkError::SetupFailed),
                });
            }
            Err(error) => {
                log::warn!("side chat: session.branch.create failed: {error}");
                return Err(match error {
                    HostRequestError::NotConnected => {
                        CreateFailure::Refused(ForkError::SetupFailed)
                    }
                    _ => CreateFailure::Unknown(ForkError::SetupFailed),
                });
            }
        }
    }
    // Every attempt met a revision the source had moved past: nothing made.
    Err(CreateFailure::Refused(ForkError::SetupFailed))
}

/// Sends the create of `entry` again, at the source's current revision, so
/// a create still in flight on the Host resolves (the Host runs one
/// request per target at a time, and the same input answers with the fork
/// it committed) before the fork is removed: removing first could miss a
/// fork that commits right after. A source that is gone, or whose context
/// cannot be copied, can make no fork now.
pub(crate) async fn replay_create(
    requester: &HostRequester,
    entry: &ForkEntry,
) -> Result<Replayed, HostRequestError> {
    let Some(source) = catalog_get(requester, &entry.source_session_id).await? else {
        return Ok(Replayed::Remove);
    };
    let input = SessionConversationCopyInput::side_conversation(
        entry.source_session_id.clone(),
        entry.target_session_id.clone(),
        entry.source_turn_id.clone(),
        source.revision,
    );
    match create(requester, input).await {
        Ok(_) | Err(CreateFailure::Refused(ForkError::Unsupported | ForkError::SetupFailed)) => {
            Ok(Replayed::Remove)
        }
        Err(CreateFailure::Conflict) => Ok(Replayed::NothingMade),
        Err(CreateFailure::Refused(ForkError::SourceBusy | ForkError::Respond))
        | Err(CreateFailure::Unknown(_)) => {
            Err(HostRequestError::Transport("the fork's create did not settle".into()))
        }
    }
}

/// Removes the fork `session_id`: stops what runs in it (the Host refuses
/// to remove a Session with an active root Turn), then `session.remove` at
/// its revision. A fork that is not there is removed.
pub(crate) async fn remove(
    requester: &HostRequester,
    session_id: &str,
    executor: &BackgroundExecutor,
) -> Result<(), HostRequestError> {
    let mut last = None;
    for attempt in 0..REMOVE_ATTEMPTS {
        let Some(fork) = catalog_get(requester, session_id).await? else {
            log::info!("side chat: fork {session_id} is gone");
            return Ok(());
        };
        stop_runs(requester, &fork).await;
        let input = SessionRemoveInput::new(session_id, fork.revision);
        match requester.request::<SessionRemove>(&input).await {
            Ok(SessionRemoveResult::Removed { .. }) => {
                log::info!("side chat: fork {session_id} removed");
                return Ok(());
            }
            Ok(SessionRemoveResult::RevisionConflict { .. }) => {}
            Ok(_) => {
                return Err(HostRequestError::Transport(
                    "session.remove answered with an unknown result".into(),
                ));
            }
            Err(HostRequestError::Operation { code: HostOperationErrorCode::NotFound, .. }) => {
                return Ok(());
            }
            Err(
                error @ HostRequestError::Operation {
                    code: HostOperationErrorCode::SessionBusy,
                    ..
                },
            ) => {
                last = Some(error);
                executor.timer(busy_delay(attempt)).await;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last.unwrap_or_else(|| HostRequestError::Transport("the fork kept changing".into())))
}

/// Stops every Turn the catalog says runs in `fork`; a stop that fails is
/// left to the removal, which then says the fork is busy.
async fn stop_runs(requester: &HostRequester, fork: &SessionCatalogProjection) {
    let running = fork.live_run_state.iter().flat_map(|state| state.running_turn_ids.iter());
    for turn_id in running {
        let query = TurnQueryInput::new(fork.id.clone(), turn_id.clone());
        let Ok(turn) = requester.request::<TurnQuery>(&query).await else { continue };
        if turn.status.is_terminal() {
            continue;
        }
        let stop = TurnStopInput::new(fork.id.clone(), turn.turn_id, turn.run_id);
        log::info!("side chat: stopping turn {turn_id} of fork {}", fork.id);
        if let Err(error) = requester.request::<TurnStop>(&stop).await {
            log::warn!("side chat: turn.stop failed: {error}");
        }
    }
}

/// Settles `entry`: replays its create when it may still be in flight,
/// then removes the fork, unless the replay shows none was made for it.
pub(crate) async fn settle(
    requester: &HostRequester,
    entry: &ForkEntry,
    executor: &BackgroundExecutor,
) -> Result<(), HostRequestError> {
    if entry.phase == ForkPhase::Creating
        && replay_create(requester, entry).await? == Replayed::NothingMade
    {
        log::info!("side chat: fork {} was never made", entry.target_session_id);
        return Ok(());
    }
    remove(requester, &entry.target_session_id, executor).await
}
