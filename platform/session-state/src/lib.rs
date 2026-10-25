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

//! Host-lifetime scratch and discovery state. Disk owns idle sessions and staged
//! writes; four fixed SQLite caches bound residency independently of session count.
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("session state I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("session state database: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("session state JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session state is retired")]
    Retired,
    #[error("session state unavailable: {0}")]
    Unavailable(String),
}
pub type Result<T> = std::result::Result<T, Error>;

struct Partition {
    db: Connection,
    failure: Option<String>,
}
struct Inner {
    partitions: [Mutex<Partition>; 4],
    // Connections close before their directory is removed.
    _directory: tempfile::TempDir,
}
#[derive(Clone)]
pub struct Backend(Arc<Inner>);
#[derive(Clone)]
pub struct Session {
    backend: Backend,
    id: String,
    partition: usize,
}
pub struct Snapshot {
    session: Session,
    id: i64,
}

const SCHEMA: &str = "
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=OFF;
PRAGMA cache_size=-1024;
PRAGMA mmap_size=0;
PRAGMA temp_store=FILE;
CREATE TABLE sessions(id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, retired INTEGER NOT NULL DEFAULT 0);
CREATE TABLE snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, revision INTEGER NOT NULL, committed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX snapshot_revision ON snapshots(session, revision);
CREATE TABLE versions(session TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, end_revision INTEGER, value BLOB NOT NULL, PRIMARY KEY(session,key,revision)) WITHOUT ROWID;
CREATE INDEX obsolete_versions ON versions(session,end_revision) WHERE end_revision IS NOT NULL;
CREATE TABLE pending(snapshot INTEGER NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY(snapshot,key)) WITHOUT ROWID;
CREATE TABLE loaded(session TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(session,name)) WITHOUT ROWID;
";

impl Backend {
    pub fn temporary() -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let mut partitions = Vec::new();
        for index in 0..4 {
            let db = Connection::open(directory.path().join(format!("{index}.sqlite")))?;
            db.execute_batch(SCHEMA)?;
            partitions.push(Mutex::new(Partition { db, failure: None }));
        }
        Ok(Self(Arc::new(Inner {
            partitions: partitions.try_into().ok().expect("four partitions"),
            _directory: directory,
        })))
    }

    /// A stable identity; obtaining a handle never resurrects a retired session.
    pub fn session(&self, id: &str) -> Session {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        id.hash(&mut hash);
        Session {
            backend: self.clone(),
            id: id.into(),
            partition: hash.finish() as usize % 4,
        }
    }
}

impl Session {
    fn access<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut partition = self.backend.0.partitions[self.partition]
            .lock()
            .map_err(|_| Error::Unavailable("partition lock poisoned".into()))?;
        if let Some(error) = &partition.failure {
            return Err(Error::Unavailable(error.clone()));
        }
        f(&mut partition.db)
    }

    fn live(&self, db: &Connection) -> Result<()> {
        db.execute("INSERT OR IGNORE INTO sessions(id) VALUES(?)", [&self.id])?;
        let retired: bool = db.query_row(
            "SELECT retired FROM sessions WHERE id=?",
            [&self.id],
            |row| row.get(0),
        )?;
        if retired { Err(Error::Retired) } else { Ok(()) }
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        self.access(|db| {
            self.live(db)?;
            db.execute("INSERT INTO snapshots(session,revision) SELECT id,revision FROM sessions WHERE id=?", [&self.id])?;
            Ok(Snapshot { session: self.clone(), id: db.last_insert_rowid() })
        })
    }

    pub fn retire(&self) -> Result<()> {
        self.access(|db| {
            let tx = db.transaction()?;
            tx.execute("INSERT INTO sessions(id,retired) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET retired=1", [&self.id])?;
            tx.execute("DELETE FROM pending WHERE snapshot IN (SELECT id FROM snapshots WHERE session=?)", [&self.id])?;
            tx.execute("DELETE FROM snapshots WHERE session=?", [&self.id])?;
            tx.execute("DELETE FROM versions WHERE session=?", [&self.id])?;
            tx.execute("DELETE FROM loaded WHERE session=?", [&self.id])?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn loaded(&self) -> Result<BTreeSet<String>> {
        self.access(|db| {
            self.live(db)?;
            Ok(db
                .prepare("SELECT name FROM loaded WHERE session=?")?
                .query_map([&self.id], |row| row.get(0))?
                .collect::<std::result::Result<_, _>>()?)
        })
    }

    pub fn update_loaded(&self, update: impl FnOnce(&mut BTreeSet<String>)) -> Result<()> {
        self.access(|db| {
            self.live(db)?;
            let tx = db.transaction()?;
            let mut names = tx
                .prepare("SELECT name FROM loaded WHERE session=?")?
                .query_map([&self.id], |row| row.get(0))?
                .collect::<std::result::Result<BTreeSet<String>, _>>()?;
            update(&mut names);
            tx.execute("DELETE FROM loaded WHERE session=?", [&self.id])?;
            for name in names {
                tx.execute("INSERT INTO loaded VALUES(?,?)", params![self.id, name])?;
            }
            tx.commit()?;
            Ok(())
        })
    }
}

// Without INDEXED BY, SQLite can prefer the primary key and scan every live
// key in this session. Collection must visit only obsolete-version candidates;
// make that access path a query contract rather than a statistics-dependent hint.
const COLLECT_SQL: &str = "
    DELETE FROM versions INDEXED BY obsolete_versions
    WHERE session=? AND end_revision IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM snapshots
        WHERE snapshots.session=versions.session
          AND snapshots.revision>=versions.revision
          AND snapshots.revision<versions.end_revision
          AND NOT EXISTS (
            SELECT 1 FROM pending
            WHERE pending.snapshot=snapshots.id AND pending.key=versions.key
          )
      )";

fn collect(db: &Connection, session: &str) -> Result<()> {
    // Keep exactly versions visible to an actual snapshot, not every version
    // newer than the oldest snapshot. No read transaction spans cell execution.
    db.execute(COLLECT_SQL, [session])?;
    Ok(())
}

impl Snapshot {
    pub fn load(&self, key: &str) -> Result<Option<Value>> {
        let bytes: Option<Vec<u8>> = self.session.access(|db| {
            self.session.live(db)?;
            Ok(db.query_row(
                "SELECT value FROM (
                    SELECT 0 AS priority,value FROM pending WHERE snapshot=?1 AND key=?2
                    UNION ALL
                    SELECT 1 AS priority,value FROM versions WHERE session=?3 AND key=?2
                        AND revision<=(SELECT revision FROM snapshots WHERE id=?1)
                        AND (end_revision IS NULL OR end_revision>(SELECT revision FROM snapshots WHERE id=?1))
                ) ORDER BY priority LIMIT 1",
                params![self.id,key,self.session.id], |row| row.get(0),
            ).optional()?)
        })?;
        // Decode outside the partition lock. These bytes were serialized from
        // an accepted Value; language-specific depth limits belong to the bridge.
        bytes
            .map(|bytes| {
                let mut decoder = serde_json::Deserializer::from_slice(&bytes);
                decoder.disable_recursion_limit();
                let value = Value::deserialize(&mut decoder)?;
                decoder.end()?;
                Ok(value)
            })
            .transpose()
    }

    pub fn store(&self, key: &str, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        self.session.access(|db| {
            self.session.live(db)?;
            let committed: bool = db.query_row("SELECT committed FROM snapshots WHERE id=?", [self.id], |row| row.get(0))?;
            if committed { return Err(Error::Unavailable("snapshot already committed".into())); }
            db.execute("INSERT INTO pending VALUES(?,?,?) ON CONFLICT(snapshot,key) DO UPDATE SET value=excluded.value", params![self.id,key,bytes])?;
            Ok(())
        })
    }

    /// Publish only after successful canonical tool settlement. The complete
    /// write set is atomic; unrelated concurrent writes are never overwritten.
    pub fn commit(&self) -> Result<()> {
        self.session.access(|db| {
            self.session.live(db)?;
            let tx = db.transaction()?;
            let committed: bool = tx.query_row("SELECT committed FROM snapshots WHERE id=?", [self.id], |row| row.get(0))?;
            if committed { return Ok(()); }
            tx.execute("UPDATE snapshots SET committed=1 WHERE id=?", [self.id])?;
            tx.execute("UPDATE sessions SET revision=revision+1 WHERE id=?", [&self.session.id])?;
            let revision: i64 = tx.query_row("SELECT revision FROM sessions WHERE id=?", [&self.session.id], |row| row.get(0))?;
            tx.execute("UPDATE versions SET end_revision=? WHERE session=? AND end_revision IS NULL AND key IN (SELECT key FROM pending WHERE snapshot=?)", params![revision,self.session.id,self.id])?;
            tx.execute("INSERT INTO versions(session,key,revision,value) SELECT ?,key,?,value FROM pending WHERE snapshot=?", params![self.session.id,revision,self.id])?;
            collect(&tx, &self.session.id)?;
            tx.commit()?;
            Ok(())
        })
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        let result = self.session.access(|db| {
            let tx = db.transaction()?;
            tx.execute("DELETE FROM pending WHERE snapshot=?", [self.id])?;
            tx.execute("DELETE FROM snapshots WHERE id=?", [self.id])?;
            collect(&tx, &self.session.id)?;
            tx.commit()?;
            Ok(())
        });
        // Drop cannot return an I/O failure. Fail subsequent use closed rather
        // than silently hiding a leaked lease or uncollected staging state.
        if let Err(error) = result
            && let Ok(mut partition) =
                self.session.backend.0.partitions[self.session.partition].lock()
        {
            partition.failure = Some(error.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn collecting_one_obsolete_version_does_not_scan_live_keys() {
        use rusqlite::StatementStatus;

        let mut measurements = Vec::new();
        for live_keys in [1_000, 10_000, 100_000] {
            let session = Backend::temporary().unwrap().session("gc-scaling");
            let steps = session
                .access(|db| {
                    // Build the same on-disk layout as committed cells, without
                    // measuring fixture creation or issuing thousands of commits.
                    db.execute(
                        "WITH RECURSIVE keys(n) AS (
                        SELECT 0 UNION ALL SELECT n+1 FROM keys WHERE n+1<?1
                    ) INSERT INTO versions(session,key,revision,value)
                      SELECT ?2,printf('%08d',n),1,x'30' FROM keys",
                        params![live_keys, session.id],
                    )?;
                    db.execute(
                        "INSERT INTO versions(session,key,revision,end_revision,value)
                     VALUES(?,'00000000',0,1,x'30')",
                        [&session.id],
                    )?;
                    let mut statement = db.prepare(COLLECT_SQL)?;
                    assert_eq!(statement.execute([&session.id])?, 1);
                    let steps = statement.get_status(StatementStatus::VmStep);
                    assert_eq!(
                        db.query_row(
                            "SELECT count(*) FROM versions WHERE session=?",
                            [&session.id],
                            |row| row.get::<_, i64>(0),
                        )?,
                        live_keys
                    );
                    Ok(steps)
                })
                .unwrap();
            measurements.push((live_keys, steps));
        }
        eprintln!("GC VM steps (live keys, one obsolete version): {measurements:?}");
        for (_, steps) in &measurements {
            assert!(*steps <= 256, "GC scanned live keys: {measurements:?}");
        }
        let baseline = measurements[0].1;
        assert!(
            measurements
                .iter()
                .all(|(_, steps)| (*steps - baseline).abs() <= 32),
            "GC work grew with live key count: {measurements:?}"
        );
    }

    #[test]
    fn snapshots_read_own_writes_and_publish_only_changed_keys() {
        let backend = Backend::temporary().unwrap();
        let session = backend.session("s");
        let seed = session.snapshot().unwrap();
        seed.store("a", &json!(1)).unwrap();
        seed.commit().unwrap();
        drop(seed);
        let first = session.snapshot().unwrap();
        let second = session.snapshot().unwrap();
        second.store("a", &json!(2)).unwrap();
        second.store("b", &json!(3)).unwrap();
        second.commit().unwrap();
        assert_eq!(first.load("a").unwrap(), Some(json!(1)));
        assert_eq!(first.load("b").unwrap(), None);
        first.store("a", &json!(4)).unwrap();
        assert_eq!(first.load("a").unwrap(), Some(json!(4)));
        first.commit().unwrap();
        first.commit().unwrap();
        let latest = session.snapshot().unwrap();
        assert_eq!(latest.load("a").unwrap(), Some(json!(4)));
        assert_eq!(latest.load("b").unwrap(), Some(json!(3)));
        let abandoned = session.snapshot().unwrap();
        abandoned.store("a", &json!(99)).unwrap();
        drop(abandoned);
        assert_eq!(
            session.snapshot().unwrap().load("a").unwrap(),
            Some(json!(4))
        );
    }

    #[test]
    fn old_snapshot_does_not_pin_intermediate_versions() {
        let session = Backend::temporary().unwrap().session("s");
        let seed = session.snapshot().unwrap();
        seed.store("key", &json!(0)).unwrap();
        seed.commit().unwrap();
        drop(seed);
        let old = session.snapshot().unwrap();
        for index in 1..10_001 {
            let cell = session.snapshot().unwrap();
            cell.store("key", &json!(index)).unwrap();
            cell.commit().unwrap();
        }
        assert_eq!(old.load("key").unwrap(), Some(json!(0)));
        let count = || {
            session
                .access(|db| {
                    Ok(db.query_row("SELECT count(*) FROM versions", [], |r| r.get::<_, i64>(0))?)
                })
                .unwrap()
        };
        assert_eq!(count(), 2);
        drop(old);
        assert_eq!(count(), 1);
    }

    #[test]
    fn retirement_fences_existing_and_new_handles_without_reusing_leases() {
        let backend = Backend::temporary().unwrap();
        let session = backend.session("retired");
        let unused_handle = backend.session("retired");
        let old = session.snapshot().unwrap();
        old.store("key", &json!(1)).unwrap();
        session.retire().unwrap();
        assert!(matches!(unused_handle.snapshot(), Err(Error::Retired)));
        assert!(matches!(old.commit(), Err(Error::Retired)));
        assert!(matches!(old.load("key"), Err(Error::Retired)));
        assert!(matches!(
            backend.session("retired").snapshot(),
            Err(Error::Retired)
        ));
        // Another session in the same partition must not lose its new lease.
        let other = (0..100)
            .map(|n| backend.session(&format!("other-{n}")))
            .find(|s| s.partition == session.partition)
            .unwrap();
        let live = other.snapshot().unwrap();
        live.store("key", &json!(2)).unwrap();
        drop(old);
        live.commit().unwrap();
        assert_eq!(
            other.snapshot().unwrap().load("key").unwrap(),
            Some(json!(2))
        );
    }

    #[test]
    fn idle_state_is_on_disk_and_discovery_handles_share_authority() {
        let backend = Backend::temporary().unwrap();
        for index in 0..256 {
            let session = backend.session(&format!("s-{index}"));
            let cell = session.snapshot().unwrap();
            cell.store("answer", &json!(index)).unwrap();
            cell.commit().unwrap();
            session
                .update_loaded(|names| {
                    names.insert("search".into());
                })
                .unwrap();
        }
        let session = backend.session("s-100");
        assert_eq!(
            session.snapshot().unwrap().load("answer").unwrap(),
            Some(json!(100))
        );
        assert_eq!(session.loaded().unwrap(), BTreeSet::from(["search".into()]));
        backend
            .session("s-100")
            .update_loaded(BTreeSet::clear)
            .unwrap();
        assert!(session.loaded().unwrap().is_empty());
        for partition in &backend.0.partitions {
            let partition = partition.lock().unwrap();
            assert_eq!(
                partition
                    .db
                    .query_row("PRAGMA cache_size", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                -1024
            );
            assert_eq!(
                partition
                    .db
                    .query_row("SELECT count(*) FROM snapshots", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                partition
                    .db
                    .query_row("SELECT count(*) FROM pending", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn concurrent_cells_merge_distinct_keys_and_order_same_key_by_commit() {
        let session = Backend::temporary().unwrap().session("parallel");
        let first = session.snapshot().unwrap();
        let second = session.snapshot().unwrap();
        let (committed, ready) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                first.store("left", &json!(1)).unwrap();
                first.store("same", &json!("first")).unwrap();
                first.commit().unwrap();
                committed.send(()).unwrap();
            });
            scope.spawn(move || {
                second.store("right", &json!(2)).unwrap();
                second.store("same", &json!("second")).unwrap();
                ready.recv().unwrap();
                assert_eq!(second.load("left").unwrap(), None);
                second.commit().unwrap();
            });
        });
        let final_state = session.snapshot().unwrap();
        assert_eq!(final_state.load("left").unwrap(), Some(json!(1)));
        assert_eq!(final_state.load("right").unwrap(), Some(json!(2)));
        assert_eq!(final_state.load("same").unwrap(), Some(json!("second")));
    }

    #[test]
    fn large_idle_keys_and_cancelled_staging_leave_no_resident_sessions_or_leases() {
        let backend = Backend::temporary().unwrap();
        let large = json!("x".repeat(128 * 1024));
        for index in 0..128 {
            let session = backend.session(&format!("large-{index}"));
            let snapshot = session.snapshot().unwrap();
            snapshot.store("large", &large).unwrap();
            snapshot.commit().unwrap();
            let cancelled = session.snapshot().unwrap();
            cancelled.store("large", &json!("unpublished")).unwrap();
            cancelled.store("cancelled", &large).unwrap();
            drop(cancelled);
        }
        // All 16 MiB is queryable after every Session/Snapshot handle was dropped.
        // Inner has only four partitions and a directory: no per-session Rust map.
        for index in [0, 63, 127] {
            let snapshot = backend
                .session(&format!("large-{index}"))
                .snapshot()
                .unwrap();
            assert_eq!(snapshot.load("large").unwrap(), Some(large.clone()));
            assert_eq!(snapshot.load("cancelled").unwrap(), None);
        }
        for partition in &backend.0.partitions {
            let partition = partition.lock().unwrap();
            for table in ["snapshots", "pending"] {
                assert_eq!(
                    partition
                        .db
                        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                            .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
            }
        }
    }

    #[test]
    fn storage_failure_is_not_a_missing_key() {
        let session = Backend::temporary().unwrap().session("failure");
        let snapshot = session.snapshot().unwrap();
        session
            .access(|db| {
                db.execute("DROP TABLE versions", [])?;
                Ok(())
            })
            .unwrap();
        assert!(matches!(snapshot.load("missing"), Err(Error::Sql(_))));
        drop(snapshot);
        assert!(matches!(session.snapshot(), Err(Error::Unavailable(_))));
    }
}
