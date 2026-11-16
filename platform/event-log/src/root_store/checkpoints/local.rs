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
use crate::checkpoints::repository::{
    Binding, BoundHead, Commit, CommitReceipt, SessionIdentity, SessionRepository, Source,
    VerifiedCheckpoint, sql,
};
use crate::connection::BoxFuture;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use uuid::Uuid;

pub(super) struct Local {
    pub(super) log: EventLog,
    pub(super) identity: String,
}
impl SessionRepository for Local {
    fn identity(&self) -> &str {
        &self.identity
    }
    fn object_store_identity(&self) -> &str {
        &self.identity
    }
    fn lookup(
        &self,
        source: Source,
        agent: Uuid,
    ) -> BoxFuture<'_, Result<Option<Binding>, StoreError>> {
        Box::pin(
            self.log
                .connection
                .read(move |db| sql::lookup(db, &source, agent)),
        )
    }
    fn bind(&self, source: Source, agent: Uuid) -> BoxFuture<'_, Result<Binding, StoreError>> {
        Box::pin(self.log.connection.run(move |db| bind(db, &source, agent)))
    }
    fn read_head(
        &self,
        identity: SessionIdentity,
    ) -> BoxFuture<'_, Result<Option<BoundHead>, StoreError>> {
        Box::pin(self.log.connection.read(move |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Deferred)?;
            head(&tx, &identity)
        }))
    }
    fn receipt(&self, request: Commit) -> BoxFuture<'_, Result<Option<CommitReceipt>, StoreError>> {
        Box::pin(
            self.log
                .connection
                .read(move |db| sql::receipt(db, &request)),
        )
    }
    fn commit(
        &self,
        request: Commit,
        verified: VerifiedCheckpoint,
    ) -> BoxFuture<'_, Result<CommitReceipt, StoreError>> {
        let identity = self.identity.clone();
        Box::pin(self.log.connection.run(move |db| {
            verified.validate(&identity, &request)?;
            commit(db, &request)
        }))
    }
}

fn bind(db: &Connection, source: &Source, agent: Uuid) -> Result<Binding, StoreError> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?)",
        [&source.session],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(StoreError::SessionNotFound);
    }
    validate_scope(&tx, &source.scope, &source.session)?;
    tx.execute(
        "INSERT INTO history_checkpoint_bindings VALUES(?,?) ON CONFLICT(session_id) DO NOTHING",
        params![source.session, serde_json::to_string(&source.scope)?],
    )?;
    let binding = sql::bind(&tx, source, agent)?;
    tx.commit().map_err(StoreError::CommitUnknown)?;
    Ok(binding)
}
fn head(db: &Connection, identity: &SessionIdentity) -> Result<Option<BoundHead>, StoreError> {
    let Some(binding) = sql::binding_for(db, identity)? else {
        return Ok(None);
    };
    let json: Option<String> = db
        .query_row(
            "SELECT head_json FROM history_checkpoint_heads WHERE session_id=?",
            [&binding.source.session],
            |r| r.get(0),
        )
        .optional()?;
    json.map(|json| {
        Ok(BoundHead {
            binding,
            head: serde_json::from_str(&json)?,
        })
    })
    .transpose()
}
fn commit(db: &Connection, request: &Commit) -> Result<CommitReceipt, StoreError> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    if let Some(receipt) = sql::receipt(&tx, request)? {
        return Ok(receipt);
    }
    let actual = head(&tx, &request.binding.identity)?.map(|h| h.head.revision);
    let receipt = if actual != request.expected_revision {
        CommitReceipt::Conflict { actual }
    } else {
        let head = Head {
            revision: Revision(Uuid::new_v4()),
            manifest: request.manifest.clone(),
        };
        tx.execute("INSERT INTO history_checkpoint_heads VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET head_json=excluded.head_json", params![request.binding.source.session, serde_json::to_string(&head)?])?;
        CommitReceipt::Published { head }
    };
    sql::record_receipt(&tx, request, &receipt)?;
    tx.commit().map_err(StoreError::CommitUnknown)?;
    Ok(receipt)
}

pub(super) fn validate_scope(
    db: &Connection,
    scope: &Scope,
    session: &str,
) -> Result<(), StoreError> {
    let bound: Option<String> = db
        .query_row(
            "SELECT scope_json FROM history_checkpoint_bindings WHERE session_id=?",
            [session],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(bound) = bound
        && serde_json::from_str::<Scope>(&bound)? != *scope
    {
        return Err(invalid("checkpoint local scope differs"));
    }
    Ok(())
}

pub(super) fn reserve_source(
    db: &Connection,
    scope: &Scope,
    session: &str,
) -> Result<(), StoreError> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    validate_scope(&tx, scope, session)?;
    tx.execute(
        "INSERT INTO history_checkpoint_bindings VALUES(?,?) ON CONFLICT(session_id) DO NOTHING",
        params![session, serde_json::to_string(scope)?],
    )?;
    tx.commit().map_err(StoreError::CommitUnknown)
}
pub(super) fn legacy_head(
    db: &Connection,
    scope: &Scope,
    session: &str,
    local: bool,
) -> Result<Option<Head>, StoreError> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Deferred)?;
    validate_scope(&tx, scope, session)?;
    let head: Option<String> = if local {
        tx.query_row(
            "SELECT head_json FROM history_checkpoint_heads WHERE session_id=?",
            [session],
            |r| r.get(0),
        )
        .optional()?
    } else {
        None
    };
    head.map(|json| serde_json::from_str(&json).map_err(StoreError::from))
        .transpose()
}
