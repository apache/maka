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

//! Immutable deterministic treap. Bulk assembly saves only final changed nodes;
//! aggregate counts and identities never inspect old payload chunks.
use super::*;
use std::{future::Future, pin::Pin};
type Work<'a, T> = Pin<Box<dyn Future<Output = Result<T, StoreError>> + Send + 'a>>;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct MessageRef {
    pub id: String,
    pub assistant: bool,
    pub breakdown: PreparedContextBreakdown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Group {
    pub wire_id: Option<String>,
    pub wire_bytes: usize,
    pub index_bytes: usize,
    pub dependencies: Vec<String>,
    pub members: Vec<u64>,
    pub manifest: maka_agent_facts::history::media::MediaManifest,
    pub messages: Vec<MessageRef>,
    pub breakdown: PreparedContextBreakdown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Node {
    pub(super) sequence: u64,
    pub(super) content: String,
    pub(super) left: Option<String>,
    pub(super) right: Option<String>,
    count: usize,
    left_count: usize,
    group_count: usize,
    trailing_assistant: usize,
    storage_bytes: usize,
    breakdown: PreparedContextBreakdown,
}
pub(super) fn priority(sequence: u64) -> String {
    hash(&sequence.to_be_bytes())
}
pub(super) async fn node(connection: &mut SqliteConnection, id: &str) -> Result<Node, StoreError> {
    let json: String =
        sqlx::query_scalar("SELECT node_json FROM context_prepared_nodes WHERE id=?")
            .bind(id)
            .fetch_one(connection)
            .await?;
    Ok(serde_json::from_str(&json)?)
}
pub(super) async fn group(
    connection: &mut SqliteConnection,
    id: &str,
) -> Result<Group, StoreError> {
    let json: String =
        sqlx::query_scalar("SELECT group_json FROM context_prepared_groups WHERE id=?")
            .bind(id)
            .fetch_one(connection)
            .await?;
    Ok(serde_json::from_str(&json)?)
}
pub(super) async fn save_group(
    connection: &mut SqliteConnection,
    refs: &mut refs::RefBatch,
    group: &Group,
) -> Result<String, StoreError> {
    let json = encoded(group)?;
    let id = hash(json.as_bytes());
    let inserted =
        sqlx::query("INSERT OR IGNORE INTO context_prepared_groups(id,group_json) VALUES(?,?)")
            .bind(&id)
            .bind(json)
            .execute(&mut *connection)
            .await?
            .rows_affected()
            == 1;
    if inserted {
        refs.create(connection, refs::Kind::Group, &id).await?;
        if let Some(wire) = &group.wire_id {
            refs.change(connection, refs::Kind::Wire, wire, 1).await?;
        }
    }
    Ok(id)
}
pub(super) async fn totals(
    connection: &mut SqliteConnection,
    id: Option<&str>,
) -> Result<(usize, PreparedContextBreakdown), StoreError> {
    if let Some(id) = id {
        let n = node(connection, id).await?;
        Ok((n.count, n.breakdown))
    } else {
        Ok((0, PreparedContextBreakdown::default()))
    }
}
pub(super) async fn weight(
    connection: &mut SqliteConnection,
    root: Option<&str>,
) -> Result<usize, StoreError> {
    match root {
        Some(id) => {
            let node = node(connection, id).await?;
            Ok(node.storage_bytes)
        }
        None => Ok(0),
    }
}
pub(super) async fn compose(
    connection: &mut SqliteConnection,
    sequence: u64,
    content: String,
    left: Option<String>,
    right: Option<String>,
) -> Result<Node, StoreError> {
    let g = group(connection, &content).await?;
    // One metadata read per child: counts, accounting and role frontier are
    // stored together. Re-reading each child for its tail doubled path reads.
    let left_node = match left.as_deref() {
        Some(id) => Some(node(connection, id).await?),
        None => None,
    };
    let right_node = match right.as_deref() {
        Some(id) => Some(node(connection, id).await?),
        None => None,
    };
    let lc = left_node.as_ref().map_or(0, |node| node.count);
    let rc = right_node.as_ref().map_or(0, |node| node.count);
    let mut breakdown = left_node
        .as_ref()
        .map(|node| node.breakdown.clone())
        .unwrap_or_default();
    breakdown.accumulate(&g.breakdown);
    if let Some(right) = &right_node {
        breakdown.accumulate(&right.breakdown);
    }
    let group_tail = g
        .messages
        .iter()
        .rev()
        .take_while(|message| message.assistant)
        .count();
    let left_tail = left_node.as_ref().map_or(0, |node| node.trailing_assistant);
    let right_tail = right_node
        .as_ref()
        .map_or(0, |node| node.trailing_assistant);
    let tail = if right_tail < rc {
        right_tail
    } else if group_tail < g.messages.len() {
        rc + group_tail
    } else {
        rc + group_tail + left_tail
    };

    let group_bytes = encoded(&g)?
        .len()
        .saturating_add(g.index_bytes)
        .saturating_add(g.wire_bytes);
    let children_bytes = left_node
        .as_ref()
        .map_or(0, |node| node.storage_bytes)
        .saturating_add(right_node.as_ref().map_or(0, |node| node.storage_bytes));
    let mut node = Node {
        sequence,
        content,
        left,
        right,
        count: lc + g.messages.len() + rc,
        left_count: lc,
        group_count: g.messages.len(),
        trailing_assistant: tail,
        storage_bytes: 0,
        breakdown,
    };
    // Include empty groups, actual serialized manifests/member lists, ancillary
    // indexes, and a conservative allowance for keys/reference rows. The extra
    // 20 bytes cover the final decimal aggregate's serialized width.
    node.storage_bytes = group_bytes
        .saturating_add(children_bytes)
        .saturating_add(encoded(&node)?.len())
        .saturating_add(512 + 20);
    Ok(node)
}
pub(super) async fn save(
    connection: &mut SqliteConnection,
    refs: &mut refs::RefBatch,
    n: &Node,
) -> Result<String, StoreError> {
    let json = encoded(n)?;
    let id = hash(json.as_bytes());
    let inserted =
        sqlx::query("INSERT OR IGNORE INTO context_prepared_nodes(id,node_json) VALUES(?,?)")
            .bind(&id)
            .bind(json)
            .execute(&mut *connection)
            .await?
            .rows_affected()
            == 1;
    if inserted {
        refs.create(connection, refs::Kind::Node, &id).await?;
        for child in [&n.left, &n.right].into_iter().flatten() {
            refs.change(connection, refs::Kind::Node, child, 1).await?;
        }
        refs.change(connection, refs::Kind::Group, &n.content, 1)
            .await?;
    }
    Ok(id)
}
#[cfg(test)]
fn replace<'a>(
    connection: &'a mut SqliteConnection,
    refs: &'a mut refs::RefBatch,
    root: Option<String>,
    sequence: u64,
    content: String,
) -> Work<'a, String> {
    Box::pin(async move {
        let Some(root) = root else {
            let n = compose(connection, sequence, content, None, None).await?;
            return save(connection, refs, &n).await;
        };
        let mut n = node(connection, &root).await?;
        if sequence == n.sequence {
            n.content = content;
        } else if sequence < n.sequence {
            n.left = Some(replace(connection, refs, n.left, sequence, content).await?);
            let mut child = node(connection, n.left.as_deref().expect("inserted child")).await?;
            if (priority(child.sequence), child.sequence) < (priority(n.sequence), n.sequence) {
                n.left = child.right.take();
                n = compose(connection, n.sequence, n.content, n.left, n.right).await?;
                child.right = Some(save(connection, refs, &n).await?);
                let child = compose(
                    connection,
                    child.sequence,
                    child.content,
                    child.left,
                    child.right,
                )
                .await?;
                return save(connection, refs, &child).await;
            }
        } else {
            n.right = Some(replace(connection, refs, n.right, sequence, content).await?);
            let mut child = node(connection, n.right.as_deref().expect("inserted child")).await?;
            if (priority(child.sequence), child.sequence) < (priority(n.sequence), n.sequence) {
                n.right = child.left.take();
                n = compose(connection, n.sequence, n.content, n.left, n.right).await?;
                child.left = Some(save(connection, refs, &n).await?);
                let child = compose(
                    connection,
                    child.sequence,
                    child.content,
                    child.left,
                    child.right,
                )
                .await?;
                return save(connection, refs, &child).await;
            }
        }
        let n = compose(connection, n.sequence, n.content, n.left, n.right).await?;
        save(connection, refs, &n).await
    })
}
// Sequential insertion exists only as an independent test oracle. Production
// construction always uses the frozen bulk assembly.
#[cfg(test)]
pub(super) async fn insert(
    connection: &mut SqliteConnection,
    root: Option<String>,
    sequence: u64,
    content: String,
    _group: Group,
) -> Result<Option<String>, StoreError> {
    // Empty groups are retained as zero-width tombstones: old roots remain
    // valid and pagination/counts skip them without payload work.
    let mut refs = refs::RefBatch::default();
    let root = replace(connection, &mut refs, root, sequence, content).await?;
    refs.flush(connection).await?;
    Ok(Some(root))
}
// Return the canonical treap identity of the exact prefix. A partial node is
// hashed in memory; full subtrees reuse their persisted identities unchanged.
pub(super) fn prefix<'a>(
    connection: &'a mut SqliteConnection,
    root: Option<&'a str>,
    count: usize,
) -> Work<'a, Option<String>> {
    Box::pin(async move {
        if count == 0 {
            return Ok(None);
        }
        let Some(root) = root else {
            return Err(invalid("prepared prefix metadata missing"));
        };
        let mut n = node(connection, root).await?;
        if count == n.count {
            return Ok(Some(root.to_owned()));
        }
        let (left_count, left_breakdown) = totals(connection, n.left.as_deref()).await?;
        if count <= left_count {
            return prefix(connection, n.left.as_deref(), count).await;
        }
        let mut g = group(connection, &n.content).await?;
        let group_end = left_count + g.messages.len();
        if count < group_end {
            g.messages.truncate(count - left_count);
            n.group_count = g.messages.len();
            g.breakdown = PreparedContextBreakdown::default();
            for message in &g.messages {
                g.breakdown.accumulate(&message.breakdown);
            }
            n.content = hash(encoded(&g)?.as_bytes());
            n.right = None;
            n.breakdown = left_breakdown;
            n.breakdown.accumulate(&g.breakdown);
        } else {
            n.right = prefix(connection, n.right.as_deref(), count - group_end).await?;
            // Aggregate the selected right prefix without requiring a stored node.
            // The virtual right node is not persisted. Derive its aggregate by the
            // same boundary traversal over the original right subtree instead.
            let original = node(connection, root).await?;
            let right =
                take_breakdown(connection, original.right.as_deref(), count - group_end).await?;
            n.breakdown = left_breakdown;
            n.breakdown.accumulate(&g.breakdown);
            n.breakdown.accumulate(&right);
        }
        n.count = count;
        n.trailing_assistant = prefix_role_tail(connection, Some(root), count).await?;
        Ok(Some(hash(encoded(&n)?.as_bytes())))
    })
}
fn take_breakdown<'a>(
    connection: &'a mut SqliteConnection,
    root: Option<&'a str>,
    count: usize,
) -> Work<'a, PreparedContextBreakdown> {
    Box::pin(async move {
        if count == 0 {
            return Ok(PreparedContextBreakdown::default());
        }
        let n = node(
            connection,
            root.ok_or_else(|| invalid("missing prefix subtree"))?,
        )
        .await?;
        if n.count == count {
            return Ok(n.breakdown);
        }
        let (lc, mut result) = totals(connection, n.left.as_deref()).await?;
        if count <= lc {
            return take_breakdown(connection, n.left.as_deref(), count).await;
        }
        let g = group(connection, &n.content).await?;
        let included = (count - lc).min(g.messages.len());
        if included == g.messages.len() {
            result.accumulate(&g.breakdown);
        } else {
            for message in &g.messages[..included] {
                result.accumulate(&message.breakdown);
            }
        }
        if count > lc + g.messages.len() {
            result.accumulate(
                &take_breakdown(
                    connection,
                    n.right.as_deref(),
                    count - lc - g.messages.len(),
                )
                .await?,
            );
        }
        Ok(result)
    })
}

pub(super) async fn seek(
    connection: &mut SqliteConnection,
    root: Option<&str>,
    offset: usize,
) -> Result<(u64, usize, Group), StoreError> {
    let mut walk = GroupWalk::at(connection, root, offset).await?;
    walk.next(connection)
        .await?
        .ok_or_else(|| invalid("prepared message offset is outside its root"))
}

/// Read-only traversal projection. Unknown persisted fields are skipped, so
/// wire paging never allocates/deserializes per-bucket accounting metadata.
#[derive(Deserialize)]
struct WalkNode {
    sequence: u64,
    content: String,
    left: Option<String>,
    right: Option<String>,
    count: usize,
    left_count: usize,
    group_count: usize,
}

/// A page retains only the search frontier. Successive groups visit each node
/// once, rather than re-seeking from the root (and decoding all ancestor groups).
pub(super) struct GroupWalk {
    stack: Vec<(WalkNode, usize)>,
    #[cfg(test)]
    pub nodes_read: usize,
}
impl GroupWalk {
    pub async fn at<C>(
        connection: &mut C,
        root: Option<&str>,
        offset: usize,
    ) -> Result<Self, StoreError>
    where
        for<'c> &'c mut C: sqlx::Executor<'c, Database = sqlx::Sqlite>,
    {
        let mut walk = Self {
            stack: Vec::new(),
            #[cfg(test)]
            nodes_read: 0,
        };
        let mut current = root.map(str::to_owned);
        let mut base = 0;
        while let Some(id) = current {
            let n = walk.load(connection, &id).await?;
            if offset >= base + n.count {
                break;
            }
            let group_base = base + n.left_count;
            if offset < group_base {
                current = n.left.clone();
                walk.stack.push((n, base));
            } else if offset < group_base + n.group_count {
                walk.stack.push((n, base));
                break;
            } else {
                base = group_base + n.group_count;
                current = n.right;
            }
        }
        Ok(walk)
    }
    async fn load<C>(&mut self, connection: &mut C, id: &str) -> Result<WalkNode, StoreError>
    where
        for<'c> &'c mut C: sqlx::Executor<'c, Database = sqlx::Sqlite>,
    {
        #[cfg(test)]
        {
            self.nodes_read += 1;
        }
        let json: String =
            sqlx::query_scalar("SELECT node_json FROM context_prepared_nodes WHERE id=?")
                .bind(id)
                .fetch_one(&mut *connection)
                .await?;
        Ok(serde_json::from_str(&json)?)
    }
    pub async fn next_descriptor<C>(
        &mut self,
        connection: &mut C,
    ) -> Result<Option<(u64, usize, String, usize)>, StoreError>
    where
        for<'c> &'c mut C: sqlx::Executor<'c, Database = sqlx::Sqlite>,
    {
        while let Some((n, base)) = self.stack.pop() {
            let group_base = base + n.left_count;
            let mut current = n.right.clone();
            let right_base = group_base + n.group_count;
            while let Some(id) = current {
                let child = self.load(connection, &id).await?;
                if child.count == 0 {
                    break;
                }
                current = child.left.clone();
                self.stack.push((child, right_base));
            }
            if n.group_count > 0 {
                return Ok(Some((n.sequence, group_base, n.content, n.group_count)));
            }
        }
        Ok(None)
    }
    pub async fn next(
        &mut self,
        connection: &mut SqliteConnection,
    ) -> Result<Option<(u64, usize, Group)>, StoreError> {
        match self.next_descriptor(connection).await? {
            Some((sequence, base, content, _)) => {
                Ok(Some((sequence, base, group(connection, &content).await?)))
            }
            None => Ok(None),
        }
    }
}
pub(super) async fn find(
    connection: &mut SqliteConnection,
    root: Option<&str>,
    sequence: u64,
) -> Result<Group, StoreError> {
    let mut current = root.map(str::to_owned);
    while let Some(id) = current {
        let n = node(connection, &id).await?;
        if sequence == n.sequence {
            return group(connection, &n.content).await;
        }
        current = if sequence < n.sequence {
            n.left
        } else {
            n.right
        };
    }
    Err(invalid("prepared group is outside its root"))
}

pub(super) async fn content_id(
    connection: &mut SqliteConnection,
    root: Option<&str>,
    sequence: u64,
) -> Result<String, StoreError> {
    let mut current = root.map(str::to_owned);
    while let Some(id) = current {
        let n = node(connection, &id).await?;
        if sequence == n.sequence {
            return Ok(n.content);
        }
        current = if sequence < n.sequence {
            n.left
        } else {
            n.right
        };
    }
    Err(invalid("prepared group is outside its root"))
}
/// Ordered keyset enumeration includes zero-width tombstones. Each seek keeps
/// only one candidate, independent of tree height and historical group count.
pub(super) async fn sequences(
    connection: &mut SqliteConnection,
    root: Option<&str>,
    after: i64,
    limit: usize,
) -> Result<Vec<u64>, StoreError> {
    let mut result = Vec::new();
    let mut after = after;
    for _ in 0..limit.min(64) {
        let mut current = root.map(str::to_owned);
        let mut candidate = None;
        while let Some(id) = current {
            let n = node(connection, &id).await?;
            if n.sequence as i64 > after {
                candidate = Some(n.sequence);
                current = n.left;
            } else {
                current = n.right;
            }
        }
        let Some(sequence) = candidate else {
            break;
        };
        result.push(sequence);
        after = sequence as i64;
    }
    Ok(result)
}

// Find the previous rendered cluster which straddles a changed semantic
// position. Zero-width tombstones are skipped; no old payload is visited.
pub(super) async fn covering(
    connection: &mut SqliteConnection,
    root: Option<&str>,
    sequence: u64,
) -> Result<Option<Group>, StoreError> {
    let mut bound = sequence;
    loop {
        let mut current = root.map(str::to_owned);
        let mut candidate = None;
        while let Some(id) = current {
            let n = node(connection, &id).await?;
            if n.sequence <= bound {
                candidate = Some((n.sequence, n.content));
                current = n.right;
            } else {
                current = n.left;
            }
        }
        let Some((position, content)) = candidate else {
            return Ok(None);
        };
        let group = group(connection, &content).await?;
        if let Some(last) = group.members.last() {
            return Ok((*last >= sequence).then_some(group));
        }
        let Some(previous) = position.checked_sub(1) else {
            return Ok(None);
        };
        bound = previous;
    }
}

// Return the message offset and content address of an exact group in this root.
pub(super) async fn location(
    connection: &mut SqliteConnection,
    root: Option<&str>,
    sequence: u64,
) -> Result<Option<(usize, String)>, StoreError> {
    let mut current = root.map(str::to_owned);
    let mut base = 0usize;
    while let Some(id) = current {
        let n = node(connection, &id).await?;
        let lc = n.left_count;
        if sequence == n.sequence {
            return Ok(Some((base + lc, n.content)));
        }
        if sequence < n.sequence {
            current = n.left;
        } else {
            base += lc + n.group_count;
            current = n.right;
        }
    }
    Ok(None)
}
pub(super) async fn before_role_tail(
    connection: &mut SqliteConnection,
    root: Option<&str>,
    sequence: u64,
) -> Result<(usize, usize), StoreError> {
    let (count, _) = location(connection, root, sequence)
        .await?
        .ok_or_else(|| invalid("prepared dependency group missing"))?;
    Ok((count, prefix_role_tail(connection, root, count).await?))
}
fn prefix_role_tail<'a>(
    connection: &'a mut SqliteConnection,
    root: Option<&'a str>,
    count: usize,
) -> Work<'a, usize> {
    Box::pin(async move {
        if count == 0 {
            return Ok(0);
        }
        let n = node(
            connection,
            root.ok_or_else(|| invalid("missing role prefix"))?,
        )
        .await?;
        if count == n.count {
            return Ok(n.trailing_assistant);
        }
        let (lc, _) = totals(connection, n.left.as_deref()).await?;
        if count <= lc {
            return prefix_role_tail(connection, n.left.as_deref(), count).await;
        }
        let g = group(connection, &n.content).await?;
        let included = (count - lc).min(g.messages.len());
        let gt = g.messages[..included]
            .iter()
            .rev()
            .take_while(|message| message.assistant)
            .count();
        let right_count = count - lc - included;
        let rt = prefix_role_tail(connection, n.right.as_deref(), right_count).await?;
        if rt < right_count {
            return Ok(rt);
        }
        if gt < included {
            return Ok(rt + gt);
        }
        let lt = match n.left.as_deref() {
            Some(id) => node(connection, id).await?.trailing_assistant,
            None => 0,
        };
        Ok(rt + gt + lt)
    })
}

pub(super) fn next_nonassistant<'a>(
    connection: &'a mut SqliteConnection,
    root: Option<&'a str>,
    after: u64,
) -> Work<'a, Option<u64>> {
    Box::pin(async move {
        let Some(id) = root else {
            return Ok(None);
        };
        let n = node(connection, id).await?;
        if n.count == n.trailing_assistant {
            return Ok(None);
        }
        if n.sequence <= after {
            return next_nonassistant(connection, n.right.as_deref(), after).await;
        }
        if let Some(found) = next_nonassistant(connection, n.left.as_deref(), after).await? {
            return Ok(Some(found));
        }
        if group(connection, &n.content)
            .await?
            .messages
            .iter()
            .any(|message| !message.assistant)
        {
            return Ok(Some(n.sequence));
        }
        next_nonassistant(connection, n.right.as_deref(), after).await
    })
}
