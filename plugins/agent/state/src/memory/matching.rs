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

pub(super) const RESTRICTED_SQL: &str = "SELECT EXISTS(SELECT 1 FROM agent_memory_versions v WHERE v.namespace=?1 AND v.scope=?2 AND v.digest=?3 AND v.disposition IN ('corrected','suppressed') AND json(v.metadata)=json(?4) AND NOT EXISTS (SELECT 1 FROM agent_memories m JOIN agent_memory_versions current ON current.namespace=m.namespace AND current.scope=m.scope AND current.id=m.id AND current.revision=m.assertion WHERE m.namespace=v.namespace AND m.scope=v.scope AND m.id=v.id AND m.state='active' AND current.digest=v.digest AND json(current.metadata)=json(v.metadata)))";

// Preserve case, punctuation, negation, quantities and internal whitespace.
pub(super) fn digest(body: &str) -> String {
    hex::encode(Sha256::digest(body.replace("\r\n", "\n").trim().as_bytes()))
}

pub(super) fn create(
    c: &Connection,
    scope: &Scope,
    body: &str,
    metadata: &MemoryMetadata,
    operation: uuid::Uuid,
    at: i64,
) -> Result<Option<MemoryResult>, StoreError> {
    let digest = digest(body);
    let metadata = serde_json::to_string(metadata)?;
    // Restricted assertions are checked before active ones, without a Top-K limit.
    // EXISTS avoids loading an unbounded collection of matching history rows.
    let restricted: bool = c.query_row(
        RESTRICTED_SQL,
        params![scope.namespace, scope.location, digest, metadata],
        |r| r.get(0),
    )?;
    if restricted {
        return Ok(Some(MemoryResult::Suppressed));
    }
    let current: Option<(String, i64, i64)> = c.query_row(
        "SELECT m.id,m.revision,m.assertion FROM agent_memory_versions v JOIN agent_memories m ON m.namespace=v.namespace AND m.scope=v.scope AND m.id=v.id AND m.assertion=v.revision WHERE v.namespace=?1 AND v.scope=?2 AND v.digest=?3 AND v.disposition='current' AND m.state='active' AND json(v.metadata)=json(?4) ORDER BY m.id LIMIT 1",
        params![scope.namespace, scope.location, digest, metadata],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional()?;
    let Some((key, revision, assertion)) = current else {
        return Ok(None);
    };
    let source = serde_json::to_string(&MemorySource::UserOperation {
        operation_id: operation,
        observed_at: at,
    })?;
    let inserted = c.execute(
        "INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key) VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,scope,id,assertion,source_key) DO NOTHING",
        params![scope.namespace, scope.location, key, assertion, source, format!("user:{operation}")],
    )?;
    let next = revision
        .checked_add(inserted as i64)
        .ok_or_else(|| invalid("memory revision exhausted"))?;
    if inserted != 0 {
        // Explicit user confirmation upgrades automatic facts; it never unpins a fact.
        c.execute("UPDATE agent_memories SET revision=?1,mode=CASE WHEN mode='auto_recall' THEN 'user_recall' ELSE mode END WHERE namespace=?2 AND scope=?3 AND id=?4", params![next,scope.namespace,scope.location,key])?;
        c.execute(
            "UPDATE agent_memory_scopes SET revision=revision+1 WHERE namespace=? AND scope=?",
            params![scope.namespace, scope.location],
        )?;
    }
    Ok(Some(MemoryResult::EvidenceAdded {
        id: MemoryId(uuid::Uuid::parse_str(&key).map_err(|e| invalid(e.to_string()))?),
        revision: revision_value(next)?,
    }))
}
