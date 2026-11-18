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

pub(super) const RESTORED: &str = "EXISTS (SELECT 1 FROM agent_memory_relations restored JOIN agent_memories active ON active.namespace=restored.namespace AND active.scope=restored.scope AND active.id=restored.target JOIN agent_memory_versions current ON current.namespace=active.namespace AND current.scope=active.scope AND current.id=active.id AND current.revision=active.assertion JOIN agent_memory_matches authorized ON authorized.namespace=active.namespace AND authorized.scope=active.scope AND authorized.id=active.id AND authorized.assertion=restored.target_assertion AND authorized.digest=current.digest WHERE restored.namespace=v.namespace AND restored.scope=v.scope AND restored.id=v.id AND restored.assertion=v.revision AND restored.kind='restored' AND active.state='active' AND json(current.metadata)=json(v.metadata))";
// Digest hits must drive the joins, not a scan of all current or restricted versions.
pub(super) fn restricted_sql() -> String {
    format!(
        "SELECT t.id,t.assertion FROM agent_memory_matches t CROSS JOIN agent_memory_versions v ON v.namespace=t.namespace AND v.scope=t.scope AND v.id=t.id AND v.revision=t.assertion WHERE t.namespace=?1 AND t.scope=?2 AND t.digest=?3 AND v.disposition IN ('corrected','suppressed') AND json(v.metadata)=json(?4) AND NOT EXISTS (SELECT 1 FROM agent_memories m JOIN agent_memory_versions current ON current.namespace=m.namespace AND current.scope=m.scope AND current.id=m.id AND current.revision=m.assertion WHERE m.namespace=v.namespace AND m.scope=v.scope AND m.id=v.id AND m.state='active' AND EXISTS (SELECT 1 FROM agent_memory_matches restored WHERE restored.namespace=v.namespace AND restored.scope=v.scope AND restored.id=v.id AND restored.assertion=v.revision AND restored.digest=current.digest) AND json(current.metadata)=json(v.metadata)) AND NOT ({RESTORED}) LIMIT 1"
    )
}
pub(super) const CURRENT_SQL: &str = "SELECT m.id,m.revision,m.assertion FROM agent_memory_matches t CROSS JOIN agent_memory_versions v ON v.namespace=t.namespace AND v.scope=t.scope AND v.id=t.id AND v.revision=t.assertion CROSS JOIN agent_memories m ON m.namespace=v.namespace AND m.scope=v.scope AND m.id=v.id AND m.assertion=v.revision WHERE t.namespace=?1 AND t.scope=?2 AND t.digest=?3 AND v.disposition='current' AND m.state='active' AND json(v.metadata)=json(?4) ORDER BY m.id LIMIT 1";

pub(super) const EQUIVALENT_HISTORY: &str = "WITH RECURSIVE equivalent(id,assertion) AS (
 SELECT t.id,t.assertion FROM agent_memory_matches t JOIN agent_memory_versions v ON v.namespace=t.namespace AND v.scope=t.scope AND v.id=t.id AND v.revision=t.assertion WHERE t.namespace=?1 AND t.scope=?2 AND t.id=?3 AND t.digest=?4 AND json(v.metadata)=json(?5)
 UNION SELECT r.id,r.assertion FROM agent_memory_relations r JOIN equivalent e ON r.target=e.id AND r.target_assertion=e.assertion WHERE r.namespace=?1 AND r.scope=?2 AND r.kind IN ('equivalent','restored')
 UNION SELECT r.target,r.target_assertion FROM agent_memory_relations r JOIN equivalent e ON r.id=e.id AND r.assertion=e.assertion WHERE r.namespace=?1 AND r.scope=?2 AND r.kind IN ('equivalent','restored'))";

pub(super) fn restored(
    c: &Connection,
    scope: &Scope,
    id: &MemoryId,
    assertion: MemoryRevision,
) -> Result<bool, StoreError> {
    Ok(c.query_row(&format!("SELECT {RESTORED} FROM agent_memory_versions v WHERE v.namespace=? AND v.scope=? AND v.id=? AND v.revision=?"), params![scope.namespace,scope.location,id.0.to_string(),assertion.0 as i64], |r| r.get(0))?)
}

pub(super) fn restricted(
    c: &Connection,
    scope: &Scope,
    body: &str,
    metadata: &MemoryMetadata,
) -> Result<Option<(MemoryId, MemoryRevision)>, StoreError> {
    let row: Option<(String, i64)> = c
        .query_row(
            &restricted_sql(),
            params![
                scope.namespace,
                scope.location,
                digest(body),
                serde_json::to_string(metadata)?
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(id, revision)| {
        Ok((
            MemoryId(uuid::Uuid::parse_str(&id).map_err(|e| invalid(e.to_string()))?),
            revision_value(revision)?,
        ))
    })
    .transpose()
}

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
    // Restricted assertions take precedence without a Top-K limit.
    if restricted(c, scope, body, metadata)?.is_some() {
        return Ok(Some(MemoryResult::Suppressed));
    }
    let digest = digest(body);
    let metadata = serde_json::to_string(metadata)?;
    let current: Option<(String, i64, i64)> = c
        .query_row(
            CURRENT_SQL,
            params![scope.namespace, scope.location, digest, metadata],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
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
