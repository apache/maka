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

use super::wire::{Kind, Row};
use crate::{Error, jsonl, transcript::identity};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Parent {
    Node(String),
    Root(u64),
}
struct Node {
    line: u64,
    parent: Parent,
    prompt: bool,
}
#[derive(Default)]
pub(super) struct Index {
    nodes: BTreeMap<String, Node>,
    dropped: BTreeSet<String>,
    root: u64,
}
impl Index {
    pub fn accept(&mut self, row: &Row<'_>, line: &jsonl::Line<'_>) -> Result<(), Error> {
        if let Some(id) = &row.uuid {
            identity(id)?;
            if self.nodes.contains_key(id) {
                return Ok(());
            }
        }
        // Separate compaction roots; logicalParentUuid is not a parent link.
        if row.compacted() {
            self.root = line.number;
        }
        let Some(id) = &row.uuid else { return Ok(()) };
        let parent = match &row.parent_uuid {
            Some(parent) => {
                identity(parent)?;
                Parent::Node(parent.clone())
            }
            None => Parent::Root(self.root),
        };
        let prompt = row.kind == Kind::User && !row.is_meta && !row.is_compact_summary && {
            let message = row.message(line)?;
            !message.content.has_results()
                && !message.content.instructions()
                && !super::wire::synthetic(&message.content.text())
        };
        self.nodes.insert(
            id.clone(),
            Node {
                line: line.number,
                parent,
                prompt,
            },
        );
        Ok(())
    }

    pub fn resolve(mut self) -> Self {
        let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        let mut latest: BTreeMap<&Parent, (&str, u64)> = BTreeMap::new();
        let mut withdrawn = Vec::new();
        for (id, node) in &self.nodes {
            if let Parent::Node(parent) = &node.parent {
                children.entry(parent).or_default().push(id);
            }
            if node.prompt {
                match latest.entry(&node.parent) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert((id, node.line));
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        if entry.get().1 < node.line {
                            withdrawn.push(entry.get().0);
                            entry.insert((id, node.line));
                        } else {
                            withdrawn.push(id);
                        }
                    }
                }
            }
        }
        while let Some(id) = withdrawn.pop() {
            if self.dropped.insert(id.to_owned())
                && let Some(children) = children.get(id)
            {
                withdrawn.extend(children);
            }
        }
        self
    }
    pub fn keep(&self, row: &Row<'_>, line: u64) -> bool {
        self.keep_id(row.uuid.as_deref(), line)
    }
    pub(super) fn keep_id(&self, id: Option<&str>, line: u64) -> bool {
        id.is_none_or(|id| {
            self.nodes.get(id).is_some_and(|node| node.line == line) && !self.dropped.contains(id)
        })
    }
}
