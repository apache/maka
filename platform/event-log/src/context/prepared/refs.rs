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

//! Reference counts are coalesced within one accepted SQL transaction phase.
use super::{StoreError, invalid};
use sqlx::SqliteConnection;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Kind {
    Group,
    Node,
    Wire,
}
impl Kind {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Group => "group",
            Self::Node => "node",
            Self::Wire => "wire",
        }
    }
}
#[derive(Debug)]
enum Entry {
    Live { baseline: Option<i64>, count: i64 },
    Deleted { baseline: Option<i64> },
}
#[derive(Default, Debug)]
pub(super) struct RefBatch {
    entries: BTreeMap<(Kind, String), Entry>,
}
impl RefBatch {
    async fn load(
        &mut self,
        db: &mut SqliteConnection,
        kind: Kind,
        id: &str,
        allow_missing: bool,
    ) -> Result<&mut Entry, StoreError> {
        use std::collections::btree_map::Entry as MapEntry;
        match self.entries.entry((kind, id.to_owned())) {
            MapEntry::Occupied(entry) => Ok(entry.into_mut()),
            MapEntry::Vacant(entry) => {
                let baseline: Option<i64> = sqlx::query_scalar(
                    "SELECT refs FROM context_prepared_refs WHERE kind=? AND id=?",
                )
                .bind(kind.name())
                .bind(id)
                .fetch_optional(db)
                .await?;
                if baseline.is_none() && !allow_missing {
                    return Err(invalid("prepared reference is missing"));
                }
                Ok(entry.insert(Entry::Live {
                    baseline,
                    count: baseline.unwrap_or(0),
                }))
            }
        }
    }
    /// Register only an object whose immutable INSERT actually succeeded.
    pub(super) async fn create(
        &mut self,
        db: &mut SqliteConnection,
        kind: Kind,
        id: &str,
    ) -> Result<(), StoreError> {
        if matches!(self.load(db, kind, id, true).await?, Entry::Deleted { .. }) {
            return Err(invalid("prepared reference was already collected"));
        }
        Ok(())
    }
    pub(super) async fn change(
        &mut self,
        db: &mut SqliteConnection,
        kind: Kind,
        id: &str,
        delta: i64,
    ) -> Result<i64, StoreError> {
        let Entry::Live { count, .. } = self.load(db, kind, id, delta > 0).await? else {
            return Err(invalid("prepared reference was already collected"));
        };
        *count = count
            .checked_add(delta)
            .filter(|count| *count >= 0)
            .ok_or_else(|| invalid("prepared reference count is invalid"))?;
        Ok(*count)
    }
    pub(super) async fn count(
        &mut self,
        db: &mut SqliteConnection,
        kind: Kind,
        id: &str,
    ) -> Result<i64, StoreError> {
        match self.load(db, kind, id, false).await? {
            Entry::Live { count, .. } => Ok(*count),
            Entry::Deleted { .. } => Err(invalid("prepared reference was already collected")),
        }
    }
    pub(super) async fn remove(
        &mut self,
        db: &mut SqliteConnection,
        kind: Kind,
        id: &str,
    ) -> Result<(), StoreError> {
        let entry = self.load(db, kind, id, false).await?;
        match entry {
            Entry::Live { baseline, count: 0 } => {
                *entry = Entry::Deleted {
                    baseline: *baseline,
                };
                Ok(())
            }
            Entry::Live { .. } => Err(invalid("prepared object still has owners")),
            Entry::Deleted { .. } => Err(invalid("prepared reference was already collected")),
        }
    }
    pub(super) fn is_deleted(&self, kind: Kind, id: &str) -> bool {
        matches!(
            self.entries.get(&(kind, id.to_owned())),
            Some(Entry::Deleted { .. })
        )
    }
    /// Flush before commit or before consulting the SQL zero-reference index.
    pub(super) async fn flush(&mut self, db: &mut SqliteConnection) -> Result<(), StoreError> {
        for ((kind, id), entry) in &self.entries {
            let affected = match entry {
                Entry::Live {
                    baseline: None,
                    count,
                } => sqlx::query("INSERT INTO context_prepared_refs(kind,id,refs) VALUES(?,?,?)")
                    .bind(kind.name())
                    .bind(id)
                    .bind(count)
                    .execute(&mut *db)
                    .await?
                    .rows_affected(),
                Entry::Live {
                    baseline: Some(before),
                    count,
                } if before != count => {
                    sqlx::query("UPDATE context_prepared_refs SET refs=? WHERE kind=? AND id=?")
                        .bind(count)
                        .bind(kind.name())
                        .bind(id)
                        .execute(&mut *db)
                        .await?
                        .rows_affected()
                }
                Entry::Deleted { baseline: Some(_) } => {
                    sqlx::query("DELETE FROM context_prepared_refs WHERE kind=? AND id=?")
                        .bind(kind.name())
                        .bind(id)
                        .execute(&mut *db)
                        .await?
                        .rows_affected()
                }
                _ => continue,
            };
            if affected != 1 {
                return Err(invalid("prepared reference changed outside its owner"));
            }
        }
        self.entries.clear();
        Ok(())
    }
}
