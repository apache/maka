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
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

pub(crate) fn lookup(
    db: &Connection,
    source: &Source,
    agent: Uuid,
) -> Result<Option<Binding>, StoreError> {
    let row: Option<(String, String, String)> = db.query_row(
        "SELECT b.source_json,s.session_id,s.agent_id FROM checkpoint_repository_sources b JOIN checkpoint_repository_sessions s USING(session_id) WHERE source_key=?",
        [source.key()?], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional()?;
    row.map(|(original, session, owner)| {
        if serde_json::from_str::<Source>(&original)? != *source || owner != agent.to_string() {
            return Err(invalid("checkpoint source ownership differs"));
        }
        Ok(Binding {
            source: source.clone(),
            identity: SessionIdentity {
                session: Uuid::parse_str(&session).map_err(|e| invalid(e.to_string()))?,
                agent,
            },
        })
    })
    .transpose()
}

pub(crate) fn bind(
    tx: &Transaction<'_>,
    source: &Source,
    agent: Uuid,
) -> Result<Binding, StoreError> {
    if agent.is_nil() {
        return Err(invalid("checkpoint agent identity is nil"));
    }
    if let Some(binding) = lookup(tx, source, agent)? {
        return Ok(binding);
    }
    let identity = SessionIdentity {
        session: Uuid::new_v4(),
        agent,
    };
    tx.execute(
        "INSERT INTO checkpoint_repository_sessions VALUES(?,?)",
        params![identity.session.to_string(), agent.to_string()],
    )?;
    tx.execute(
        "INSERT INTO checkpoint_repository_sources VALUES(?,?,?)",
        params![
            source.key()?,
            serde_json::to_string(source)?,
            identity.session.to_string()
        ],
    )?;
    Ok(Binding {
        source: source.clone(),
        identity,
    })
}

pub(crate) fn binding_for(
    db: &Connection,
    identity: &SessionIdentity,
) -> Result<Option<Binding>, StoreError> {
    let row: Option<(String,String)> = db.query_row("SELECT s.agent_id,b.source_json FROM checkpoint_repository_sessions s JOIN checkpoint_repository_sources b USING(session_id) WHERE s.session_id=?", [identity.session.to_string()], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(agent, source)| {
        if agent != identity.agent.to_string() {
            return Err(invalid("checkpoint Session agent binding differs"));
        }
        Ok(Binding {
            identity: identity.clone(),
            source: serde_json::from_str(&source)?,
        })
    })
    .transpose()
}
pub(crate) fn head(
    db: &Connection,
    identity: &SessionIdentity,
) -> Result<Option<BoundHead>, StoreError> {
    let Some(binding) = binding_for(db, identity)? else {
        return Ok(None);
    };
    let json: Option<String> = db
        .query_row(
            "SELECT head_json FROM checkpoint_repository_heads WHERE session_id=?",
            [identity.session.to_string()],
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

pub(crate) fn receipt(
    db: &Connection,
    request: &Commit,
) -> Result<Option<CommitReceipt>, StoreError> {
    let key = request.key()?;
    if lookup(db, &request.binding.source, request.binding.identity.agent)?.as_ref()
        != Some(&request.binding)
    {
        return Err(invalid(
            "checkpoint source has no matching logical Session binding",
        ));
    }
    let row: Option<(String,String)> = db.query_row("SELECT request_json,receipt_json FROM checkpoint_repository_receipts WHERE operation_key=?", [key], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(original, receipt)| {
        if serde_json::from_str::<Commit>(&original)? != *request {
            return Err(invalid("checkpoint commit identity conflict"));
        }
        serde_json::from_str(&receipt).map_err(Into::into)
    })
    .transpose()
}
pub(crate) fn commit(db: &Connection, request: &Commit) -> Result<CommitReceipt, StoreError> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    if let Some(receipt) = receipt(&tx, request)? {
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
        tx.execute(
            "INSERT INTO checkpoint_repository_heads VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET head_json=excluded.head_json",
            params![request.binding.identity.session.to_string(), serde_json::to_string(&head)?],
        )?;
        CommitReceipt::Published { head }
    };
    record_receipt(&tx, request, &receipt)?;
    tx.commit().map_err(StoreError::CommitUnknown)?;
    Ok(receipt)
}

pub(crate) fn record_receipt(
    tx: &Transaction<'_>,
    request: &Commit,
    receipt: &CommitReceipt,
) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO checkpoint_repository_receipts VALUES(?,?,?)",
        params![
            request.key()?,
            serde_json::to_string(request)?,
            serde_json::to_string(receipt)?
        ],
    )?;
    Ok(())
}
