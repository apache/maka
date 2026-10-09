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

//! In-flight request bookkeeping shared by [`crate::Connection`] and its pump.
//!
//! Mirrors `#pendingRequests` / `#retiredRequests` in
//! `RuntimeHostConnectionImpl` (`packages/runtime-host/src/client/connection.ts`):
//! a request that timed out is retired rather than forgotten, so its late
//! response is dropped quietly and its domain slot is released only when the
//! Host has actually finished with it. Any other unmatched response is a
//! protocol violation.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_lock::SemaphoreGuardArc;
use host_protocol::{Outcome, ResponseFrame};

/// One slot of the client-side in-flight budget. Held until the Host answers.
pub(crate) type DomainSlot = Option<SemaphoreGuardArc>;

#[derive(Debug, Default)]
pub(crate) struct RequestTable {
    state: Mutex<TableState>,
}

#[derive(Debug, Default)]
struct TableState {
    pending: HashMap<String, Pending>,
    retired: HashMap<String, Retired>,
    /// `Some` once the connection has ended; the text says why.
    closed: Option<Arc<str>>,
}

#[derive(Debug)]
struct Pending {
    operation: String,
    reply: async_channel::Sender<Outcome>,
    _slot: DomainSlot,
}

#[derive(Debug)]
struct Retired {
    operation: String,
    _slot: DomainSlot,
}

/// Why a response could not be routed.
#[derive(Debug)]
pub(crate) enum RouteError {
    Unmatched { request_id: String },
    OperationMismatch { request_id: String },
}

impl RequestTable {
    fn lock(&self) -> MutexGuard<'_, TableState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a request. Fails with the close reason if the connection
    /// has already ended.
    pub(crate) fn insert(
        &self,
        request_id: String,
        operation: &str,
        reply: async_channel::Sender<Outcome>,
        slot: DomainSlot,
    ) -> Result<(), Arc<str>> {
        let mut state = self.lock();
        if let Some(reason) = &state.closed {
            return Err(reason.clone());
        }
        state
            .pending
            .insert(request_id, Pending { operation: operation.to_owned(), reply, _slot: slot });
        Ok(())
    }

    /// Forgets a request that was never written to the Host.
    pub(crate) fn remove(&self, request_id: &str) {
        self.lock().pending.remove(request_id);
    }

    /// Moves a timed-out request aside so its late response is accepted.
    pub(crate) fn retire(&self, request_id: &str) {
        let mut state = self.lock();
        if let Some(pending) = state.pending.remove(request_id) {
            state.retired.insert(
                request_id.to_owned(),
                Retired { operation: pending.operation, _slot: pending._slot },
            );
        }
    }

    /// Delivers a response to its waiting request.
    pub(crate) fn route(&self, response: ResponseFrame) -> Result<(), RouteError> {
        let mut state = self.lock();
        let pending_matches = state
            .pending
            .get(&response.request_id)
            .map(|pending| pending.operation == response.operation);
        match pending_matches {
            Some(true) => {
                let pending = state.pending.remove(&response.request_id);
                drop(state);
                if let Some(pending) = pending {
                    // The caller may have stopped waiting; that is not an error.
                    let _ = pending.reply.try_send(response.outcome);
                }
                return Ok(());
            }
            Some(false) => {
                return Err(RouteError::OperationMismatch { request_id: response.request_id });
            }
            None => {}
        }
        match state.retired.get(&response.request_id) {
            Some(retired) if retired.operation == response.operation => {
                state.retired.remove(&response.request_id);
                Ok(())
            }
            Some(_) => Err(RouteError::OperationMismatch { request_id: response.request_id }),
            None => Err(RouteError::Unmatched { request_id: response.request_id }),
        }
    }

    /// Ends the table: every waiting request fails with `reason`.
    pub(crate) fn close(&self, reason: Arc<str>) {
        let mut state = self.lock();
        if state.closed.is_none() {
            state.closed = Some(reason);
        }
        // Dropping the reply senders wakes every waiter with a closed channel.
        state.pending.clear();
        state.retired.clear();
    }

    /// The reason the connection ended, if it has.
    pub(crate) fn close_reason(&self) -> Option<Arc<str>> {
        self.lock().closed.clone()
    }

    #[cfg(test)]
    pub(crate) fn counts(&self) -> (usize, usize) {
        let state = self.lock();
        (state.pending.len(), state.retired.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn table_with(
        request_id: &str,
        operation: &str,
    ) -> (RequestTable, async_channel::Receiver<Outcome>) {
        let table = RequestTable::default();
        let (tx, rx) = async_channel::bounded(1);
        table.insert(request_id.into(), operation, tx, None).expect("open table");
        (table, rx)
    }

    #[test]
    fn routes_a_response_to_its_request() {
        let (table, rx) = table_with("r1", "host.status");
        table.route(ResponseFrame::ok("r1", "host.status", json!({}))).expect("routed");
        assert_eq!(rx.try_recv().expect("reply"), Outcome::Ok(json!({})));
        assert_eq!(table.counts(), (0, 0));
    }

    #[test]
    fn rejects_unmatched_and_mismatched_responses() {
        let (table, _rx) = table_with("r1", "host.status");
        assert!(matches!(
            table.route(ResponseFrame::ok("r2", "host.status", json!({}))),
            Err(RouteError::Unmatched { .. })
        ));
        assert!(matches!(
            table.route(ResponseFrame::ok("r1", "session.catalog.query", json!({}))),
            Err(RouteError::OperationMismatch { .. })
        ));
    }

    #[test]
    fn retired_requests_absorb_their_late_response_once() {
        let (table, _rx) = table_with("r1", "host.status");
        table.retire("r1");
        assert_eq!(table.counts(), (0, 1));
        table
            .route(ResponseFrame::ok("r1", "host.status", json!({})))
            .expect("late response is absorbed");
        assert_eq!(table.counts(), (0, 0));
        assert!(table.route(ResponseFrame::ok("r1", "host.status", json!({}))).is_err());
    }

    #[test]
    fn close_fails_waiters_and_rejects_new_requests() {
        let (table, rx) = table_with("r1", "host.status");
        table.close("gone".into());
        assert!(rx.try_recv().is_err());
        assert!(rx.is_closed());
        let (tx, _rx) = async_channel::bounded(1);
        let rejected = table.insert("r2".into(), "host.status", tx, None);
        assert_eq!(rejected.err().as_deref(), Some("gone"));
        assert_eq!(table.close_reason().as_deref(), Some("gone"));
    }
}
