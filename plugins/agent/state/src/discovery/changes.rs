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

//! Durable file probes, fingerprints and discovery opening watermarks.
use super::*;
use maka_agent_facts::{input::RunInput, read::SESSION_RESOURCE_PREFIX};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

const BURST_THRESHOLD: usize = 5;
const READY_CHANGE: &str = "d.owner=?1 AND d.delta_kind IS NOT NULL AND d.delta_at<=?2 AND d.probe_at IS NULL AND d.cooldown_until<=?2
    AND (d.delta_kind!='directory' OR NOT EXISTS(SELECT 1 FROM discovery_source_cursors AS f INDEXED BY discovery_cursor_pending_children
        WHERE f.owner=d.owner AND f.parent_uri=d.source_uri AND f.probe_at IS NOT NULL AND f.updated_at<=d.cooldown_until))";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum WriteKind {
    Created,
    Modified,
    Removed,
}

pub struct FileWrite {
    pub path: String,
    pub kind: WriteKind,
    pub at: UnixMillis,
}

pub struct Probe {
    pub path: String,
    pub due: UnixMillis,
    pub observed: UnixMillis,
    pub cooldown_until: UnixMillis,
}

pub enum ProbeResult {
    Stable(Fingerprint),
    RetryAt(UnixMillis),
    Missing,
    Unreadable,
}

pub struct Fingerprint {
    pub mtime: UnixMillis,
    pub hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeltaKind {
    Created,
    Modified,
    Directory,
}
impl DeltaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Modified => "modified",
            Self::Directory => "directory",
        }
    }
}

#[derive(Debug)]
pub struct Delta {
    pub path: String,
    pub kind: DeltaKind,
    pub at: UnixMillis,
}

pub struct DeltaGroup {
    pub project: PathBuf,
    pub members: Vec<Delta>,
}

#[derive(Default)]
pub struct ChangeSnapshot {
    pub groups: Vec<DeltaGroup>,
    pub cooling: Vec<(String, UnixMillis)>,
    pub omitted_deltas: usize,
}

impl ChangeSnapshot {
    pub fn into_deltas(self) -> Vec<Delta> {
        self.groups
            .into_iter()
            .flat_map(|group| group.members)
            .collect()
    }
}

pub enum CursorSelection {
    All,
    Deltas,
}

pub enum ChangeQuery {
    FirstReady,
    Opening {
        limit: usize,
        workspace: PathBuf,
        projects: BTreeSet<PathBuf>,
    },
}

impl ChangeQuery {
    pub fn opening(limit: usize, workspace: &Path) -> Self {
        Self::Opening {
            limit,
            workspace: workspace.to_owned(),
            projects: BTreeSet::new(),
        }
    }
}

fn project_for(
    path: &Path,
    kind: DeltaKind,
    workspace: &Path,
    projects: &BTreeSet<PathBuf>,
) -> PathBuf {
    if let Some(project) = path.ancestors().find(|p| projects.contains(*p)) {
        return project.to_owned();
    }
    let dir = if kind == DeltaKind::Directory {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    match dir.strip_prefix(workspace) {
        Ok(rel) => rel
            .iter()
            .next()
            .map_or_else(|| workspace.to_owned(), |child| workspace.join(child)),
        Err(_) => dir.to_owned(),
    }
}

pub enum OpeningSources {
    FollowUp {
        files: Vec<Delta>,
        sessions: Vec<(String, UnixMillis)>,
    },
    Wander(Vec<String>),
    None,
}

pub struct IndexedDossier {
    pub topic_id: TopicId,
    pub title: String,
    pub signal: DossierSignal,
    pub revision: u64,
    pub window_at: Option<UnixMillis>,
}

impl DiscoveryStore {
    pub async fn session_explored_at(
        &self,
        session_ids: &[String],
    ) -> Result<BTreeMap<String, i64>, StoreError> {
        if session_ids.is_empty() {
            return Ok(BTreeMap::new());
        }
        let ids = serde_json::to_string(session_ids)?;
        self.read(move |c, owner| {
            let mut rows = c.prepare_cached(
                "SELECT id.value, cursor.last_explored_at FROM json_each(?2) id
                 CROSS JOIN discovery_source_cursors cursor
                 WHERE cursor.owner=?1 AND cursor.source_uri=(?3 || id.value)",
            )?;
            Ok(rows
                .query_map(params![owner, ids, SESSION_RESOURCE_PREFIX], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?
                .collect::<Result<_, _>>()?)
        })
        .await
    }

    /// A Bot's own reports and other deliveries can be newer than its last human turn.
    pub async fn latest_session_user_message_at(
        &self,
        session_id: &str,
    ) -> Result<Option<UnixMillis>, StoreError> {
        let session_id = session_id.to_owned();
        self.read(move |c, owner| {
            let mut stmt = c.prepare_cached(
                "SELECT f.at, json_extract(b.payload,'$.input')
                 FROM agent_catalog_runs k INDEXED BY agent_catalog_latest_run
                 JOIN agent_facts f ON f.sequence=k.admission_sequence
                 JOIN agent_run_specs s ON s.run=k.run
                 JOIN contents b ON b.id=s.spec_content_id
                 WHERE k.owner=?1 AND k.session=?2 ORDER BY k.admission_sequence DESC LIMIT 20",
            )?;
            let mut rows = stmt.query(params![owner, session_id])?;
            while let Some(row) = rows.next()? {
                if let RunInput::Message {
                    source_messages, ..
                } = crate::sql::decode(c, &json(row, 1)?)?
                    && source_messages.iter().any(|m| m.message.origin.is_none())
                {
                    return Ok(Some(UnixMillis(row.get(0)?)));
                }
            }
            Ok(None)
        })
        .await
    }

    pub async fn observe_writes(
        &self,
        writes: Vec<FileWrite>,
        debounce_ms: i64,
        window_ms: i64,
        cooldown_ms: i64,
    ) -> Result<(), StoreError> {
        self.data.write(self.mutation(false, move |c, owner| {
            let mut directories = BTreeMap::<&str, Vec<i64>>::new();
            let mut files = BTreeMap::<&str, (WriteKind,i64)>::new();
            for write in &writes {
                let path = write.path.as_str();
                if write.kind != WriteKind::Removed {
                    let parent = Path::new(path).parent().and_then(Path::to_str)
                        .ok_or_else(|| crate::store::invalid("discovery path has no parent"))?;
                    directories.entry(parent).or_default().push(write.at.0);
                }
                let (kind,at) = files.entry(path).or_insert((write.kind,write.at.0));
                if *kind != WriteKind::Created || write.kind != WriteKind::Modified {
                    *kind=write.kind;
                }
                *at=(*at).max(write.at.0);
            }
            let mut probe = c.prepare_cached(
                "INSERT INTO discovery_source_cursors(owner,source_uri,parent_uri,updated_at,probe_at,probe_created)
                 VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(owner,source_uri) DO UPDATE SET
                     parent_uri=excluded.parent_uri, updated_at=max(updated_at+1,excluded.updated_at),
                     probe_at=max(coalesce(probe_at,0),excluded.probe_at),
                     probe_created=probe_created OR excluded.probe_created"
            )?;
            let mut removed = c.prepare_cached(
                "UPDATE discovery_source_cursors SET probe_at=?3,updated_at=max(updated_at+1,?4)
                 WHERE owner=?1 AND source_uri=?2 AND parent_uri IS NOT NULL"
            )?;
            for (path,(kind,at)) in files {
                let due=at+debounce_ms;
                if kind == WriteKind::Removed {
                    removed.execute(params![owner,path,due,at])?;
                } else {
                    let parent=Path::new(path).parent().and_then(Path::to_str).expect("validated write");
                    probe.execute(params![owner,path,parent,at,due,kind==WriteKind::Created])?;
                }
            }
            for (dir,times) in directories {
                update_directory(c,owner,dir,times,window_ms,cooldown_ms)?;
            }
            Ok(())
        })).await
    }

    pub async fn due_probes(&self, at: UnixMillis, limit: u32) -> Result<Vec<Probe>, StoreError> {
        self.read(move |c, owner| {
            let mut stmt = c.prepare_cached(
                "SELECT f.source_uri,f.probe_at,f.updated_at,d.cooldown_until FROM discovery_source_cursors f
                 JOIN discovery_source_cursors d ON d.owner=f.owner AND d.source_uri=f.parent_uri
                 WHERE f.owner=?1 AND f.probe_at<=?2 ORDER BY f.probe_at,f.source_uri LIMIT ?3",
            )?;
            Ok(stmt
                .query_map(params![owner, at.0, limit], |r| {
                    Ok(Probe {
                        path: r.get(0)?,
                        due: UnixMillis(r.get(1)?),
                        observed: UnixMillis(r.get(2)?),
                        cooldown_until: UnixMillis(r.get(3)?),
                    })
                })?
                .collect::<Result<_, _>>()?)
        })
        .await
    }

    pub async fn finish_probes(&self, probes: Vec<(Probe, ProbeResult)>) -> Result<(), StoreError> {
        self.data
            .write(self.mutation(false, move |c, owner| {
                for (probe, result) in probes {
                    apply_probe(c, owner, probe, result)?;
                }
                Ok(())
            }))
            .await
    }

    pub async fn next_change_deadline(&self, at: UnixMillis) -> Result<Option<i64>, StoreError> {
        self.read(move |c,owner| Ok(c.query_row(
            "SELECT min(t) FROM (SELECT min(probe_at) t FROM discovery_source_cursors WHERE owner=?1 AND probe_at IS NOT NULL
             UNION ALL SELECT min(cooldown_until) FROM discovery_source_cursors INDEXED BY discovery_cursor_cooldowns WHERE owner=?1 AND cooldown_until>0 AND cooldown_until>?2 AND delta_kind='directory'
             UNION ALL SELECT min(delta_at) FROM discovery_source_cursors WHERE owner=?1 AND delta_kind IS NOT NULL AND delta_at>?2)",
            params![owner,at.0], |r| r.get(0))?)).await
    }

    pub async fn has_ready_changes(&self, at: UnixMillis) -> Result<bool, StoreError> {
        self.read(move |c, owner| {
            Ok(c.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM discovery_source_cursors AS d INDEXED BY discovery_cursor_deltas WHERE {READY_CHANGE})"),
                params![owner, at.0],
                |r| r.get(0),
            )?)
        })
        .await
    }

    pub async fn change_snapshot(
        &self,
        at: UnixMillis,
        query: ChangeQuery,
        mut allowed: impl FnMut(&Path, DeltaKind) -> bool + Send + 'static,
    ) -> Result<ChangeSnapshot, StoreError> {
        self.read(move |c, owner| {
            let mut snapshot = ChangeSnapshot::default();
            let mut stmt = c.prepare_cached(&format!(
                "SELECT source_uri,delta_kind,delta_at FROM discovery_source_cursors AS d INDEXED BY discovery_cursor_deltas
                 WHERE {READY_CHANGE} ORDER BY delta_at DESC,source_uri"))?;
            let mut rows = stmt.query(params![owner, at.0])?;
            let mut indices = BTreeMap::new();
            while let Some(r) = rows.next()? {
                let uri = r.get_ref(0)?.as_str().map_err(rusqlite::Error::from)?;
                let path = Path::new(uri);
                let kind = vocabulary(r, 1)?;
                if !allowed(path, kind) { continue; }
                let delta = || -> rusqlite::Result<Delta> {
                    Ok(Delta { path: uri.to_owned(), kind, at: UnixMillis(r.get(2)?) })
                };
                let ChangeQuery::Opening { limit, workspace, projects } = &query else {
                    snapshot.groups.push(DeltaGroup { project: path.to_owned(), members: vec![delta()?] });
                    return Ok(snapshot);
                };
                let project = project_for(path, kind, workspace, projects);
                let index = if let Some(index) = indices.get(&project) { *index }
                    else if indices.len() < *limit {
                        let index = snapshot.groups.len();
                        indices.insert(project.clone(), index);
                        snapshot.groups.push(DeltaGroup { project, members: Vec::new() });
                        index
                    } else { snapshot.omitted_deltas += 1; continue; };
                snapshot.groups[index].members.push(delta()?);
            }
            let ChangeQuery::Opening { limit, .. } = query else { return Ok(snapshot); };
            let mut stmt = c.prepare_cached("SELECT source_uri,cooldown_until FROM discovery_source_cursors INDEXED BY discovery_cursor_cooldowns
                WHERE owner=?1 AND cooldown_until>0 AND cooldown_until>?2 ORDER BY cooldown_until DESC")?;
            let mut rows = stmt.query(params![owner, at.0])?;
            while snapshot.cooling.len() < limit && let Some(r) = rows.next()? {
                let path = r.get_ref(0)?.as_str().map_err(rusqlite::Error::from)?;
                if allowed(Path::new(path), DeltaKind::Directory) {
                    snapshot.cooling.push((path.to_owned(), UnixMillis(r.get(1)?)));
                }
            }
            Ok(snapshot)
        }).await
    }

    /// A new write between snapshot and job creation must survive acknowledgement.
    pub fn acknowledge_changes(
        &self,
        deltas: Vec<Delta>,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.record_opening(
            OpeningSources::FollowUp {
                files: deltas,
                sessions: Vec::new(),
            },
            UnixMillis(0),
        )
    }

    /// Preserve map priority and look up only those paths whose map deadlines are due.
    pub async fn available_wander_paths(
        &self,
        candidates: Vec<(PathBuf, UnixMillis)>,
        at: UnixMillis,
    ) -> Result<Vec<PathBuf>, StoreError> {
        self.read(move |c, owner| {
            let mut stmt = c.prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM discovery_source_cursors WHERE owner=?1 AND source_uri=?2
                 AND (probe_at IS NOT NULL OR cooldown_until>?3 OR (last_explored_at>0 AND last_explored_at>?4)))",
            )?;
            let mut available = Vec::new();
            for (path, cutoff) in candidates {
                let uri = path.to_str().ok_or_else(|| crate::store::invalid("invalid discovery source path"))?;
                let busy: bool = stmt.query_row(params![owner, uri, at.0, cutoff.0], |r| r.get(0))?;
                if !busy { available.push(path); }
            }
            Ok(available)
        }).await
    }

    pub async fn prune_cursors_matching(
        &self,
        selection: CursorSelection,
        mut should_remove: impl FnMut(&Path) -> bool + Send + 'static,
    ) -> Result<usize, StoreError> {
        let stale = self.read(move |c,owner| {
            let sql = match selection {
                CursorSelection::All => "SELECT source_uri,updated_at,delta_at FROM discovery_source_cursors WHERE owner=?1",
                CursorSelection::Deltas => "SELECT source_uri,updated_at,delta_at FROM discovery_source_cursors INDEXED BY discovery_cursor_deltas WHERE owner=?1 AND delta_kind IS NOT NULL",
            };
            let mut stmt = c.prepare_cached(sql)?;
            let mut rows = stmt.query([owner])?;
            let mut stale = Vec::new();
            while let Some(row) = rows.next()? {
                let path = row.get_ref(0)?.as_str().map_err(rusqlite::Error::from)?;
                if !path.starts_with(SESSION_RESOURCE_PREFIX) && should_remove(Path::new(path)) {
                    stale.push((path.to_owned(),row.get::<_,i64>(1)?,row.get::<_,Option<i64>>(2)?));
                }
            }
            Ok(stale)
        }).await?;
        if stale.is_empty() {
            return Ok(0);
        }
        self.data.write(self.mutation(false,move |c,owner| {
            let mut stmt=c.prepare_cached("DELETE FROM discovery_source_cursors WHERE owner=?1 AND source_uri=?2 AND updated_at=?3 AND delta_at IS ?4")?;
            let mut removed=0;
            for (path,version,delta) in stale { removed+=stmt.execute(params![owner,path,version,delta])?; }
            Ok(removed)
        })).await
    }

    /// Commit with the frozen opening so recovery consumes neither a second slot nor a second sample.
    pub fn record_opening(
        &self,
        sources: OpeningSources,
        at: UnixMillis,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.mutation(false, move |c, owner| {
            match sources {
                OpeningSources::FollowUp { files, sessions } => {
                    let mut stmt = c.prepare_cached(
                        "UPDATE discovery_source_cursors SET delta_kind=NULL,delta_at=NULL,
                        last_explored_at=max(last_explored_at,?3,?5),
                        updated_at=CASE WHEN probe_at IS NULL THEN max(updated_at+1,?3,?5) ELSE updated_at END
                        WHERE owner=?1 AND source_uri=?2 AND delta_at=?3 AND delta_kind=?4",
                    )?;
                    for delta in files {
                        stmt.execute(params![owner, delta.path, delta.at.0, delta.kind.as_str(), at.0])?;
                    }
                    let mut session = c.prepare_cached(
                        "INSERT INTO discovery_source_cursors(owner,source_uri,last_explored_at,updated_at)
                         SELECT ?1,?2 || ?3,?4,?5 WHERE NOT EXISTS(
                             SELECT 1 FROM session_retirements WHERE session_id=?3 AND remove_session=1)
                         ON CONFLICT(owner,source_uri) DO UPDATE SET
                         last_explored_at=max(last_explored_at,excluded.last_explored_at),
                         updated_at=max(updated_at+1,excluded.updated_at)",
                    )?;
                    for (id, activity_at) in sessions {
                        session.execute(params![owner, SESSION_RESOURCE_PREFIX, id, activity_at.0, at.0])?;
                    }
                }
                OpeningSources::Wander(paths) => {
                    let mut stmt = c.prepare_cached("INSERT INTO discovery_source_cursors(owner,source_uri,last_explored_at,updated_at)
                        VALUES (?1,?2,?3,?3) ON CONFLICT(owner,source_uri) DO UPDATE SET
                        last_explored_at=max(last_explored_at,?3),
                        updated_at=CASE WHEN probe_at IS NULL THEN max(updated_at+1,?3) ELSE updated_at END
                        WHERE last_explored_at<?3")?;
                    for path in paths { stmt.execute(params![owner, path, at.0])?; }
                }
                OpeningSources::None => (),
            }
            Ok(())
        })
    }

    pub async fn active_dossier_index(
        &self,
        limit: u32,
    ) -> Result<Vec<IndexedDossier>, StoreError> {
        self.read(move |c,owner| {
            let mut stmt = c.prepare_cached("SELECT topic_id,substr(title,1,100),revision,window_at FROM discovery_dossiers
                WHERE owner=?1 AND signal=?2 ORDER BY priority_weight DESC,last_material_change_at DESC,topic_id LIMIT ?3")?;
            let mut rows = Vec::new();
            for signal in [DossierSignal::Red,DossierSignal::Yellow,DossierSignal::Green] {
                rows.extend(stmt.query_map(params![owner,signal.as_str(),limit-rows.len() as u32], |r| Ok(IndexedDossier {
                    topic_id: TopicId(r.get(0)?), title:r.get(1)?, signal, revision:unsigned(r,2)?,window_at:optional_time(r,3)?
                }))?.collect::<Result<Vec<_>,_>>()?);
                if rows.len() == limit as usize { break; }
            }
            Ok(rows)
        }).await
    }
}

fn update_directory(
    c: &Connection,
    owner: &str,
    dir: &str,
    times: Vec<i64>,
    window_ms: i64,
    cooldown_ms: i64,
) -> Result<(), StoreError> {
    let (mut recent,mut until): (Vec<i64>,i64) = c.query_row(
        "SELECT burst_times_json,cooldown_until FROM discovery_source_cursors WHERE owner=?1 AND source_uri=?2",
        params![owner,dir], |r| Ok((json(r,0)?,r.get(1)?)),
    ).optional()?.unwrap_or_default();
    let mut entered = false;
    // The latest five event times are sufficient to decide the threshold at any write rate.
    for at in times {
        recent.retain(|t| *t >= at - window_ms);
        if recent.len() == BURST_THRESHOLD {
            recent.remove(0);
        }
        recent.push(at);
        if until > at || recent.len() == BURST_THRESHOLD {
            entered |= until <= at;
            until = until.max(at + cooldown_ms);
        }
    }
    let at = recent.last().expect("directory has a write");
    c.execute(
        "INSERT INTO discovery_source_cursors(owner,source_uri,write_burst_count,burst_times_json,cooldown_until,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(owner,source_uri) DO UPDATE SET
             write_burst_count=excluded.write_burst_count,burst_times_json=excluded.burst_times_json,
             cooldown_until=excluded.cooldown_until,updated_at=max(updated_at+1,excluded.updated_at)",
        params![owner,dir,recent.len() as u32,serde_json::to_string(&recent)?,until,at],
    )?;
    if entered {
        let pending = c.execute(
            "UPDATE discovery_source_cursors SET delta_kind=NULL,delta_at=NULL
             WHERE owner=?1 AND parent_uri=?2 AND delta_kind IS NOT NULL",
            params![owner, dir],
        )?;
        if pending > 0 {
            directory_delta(c, owner, dir, *at)?;
        }
    }
    Ok(())
}

fn apply_probe(
    c: &Connection,
    owner: &str,
    probe: Probe,
    result: ProbeResult,
) -> Result<(), StoreError> {
    let key = params![owner, probe.path, probe.due.0, probe.observed.0];
    let fp = match result {
        ProbeResult::Stable(fp) => fp,
        ProbeResult::Missing => {
            c.execute("DELETE FROM discovery_source_cursors WHERE owner=?1 AND source_uri=?2 AND probe_at=?3 AND updated_at=?4",key)?;
            return Ok(());
        }
        ProbeResult::Unreadable => {
            c.execute("UPDATE discovery_source_cursors SET probe_at=NULL,probe_created=0,delta_kind=NULL,delta_at=NULL
                WHERE owner=?1 AND source_uri=?2 AND probe_at=?3 AND updated_at=?4",key)?;
            return Ok(());
        }
        ProbeResult::RetryAt(due) => {
            c.execute("UPDATE discovery_source_cursors SET probe_at=?5 WHERE owner=?1 AND source_uri=?2 AND probe_at=?3 AND updated_at=?4",
                params![owner,probe.path,probe.due.0,probe.observed.0,due.0])?;
            return Ok(());
        }
    };
    let row = c.query_row("SELECT f.parent_uri, f.probe_created, f.last_hash, d.cooldown_until
        FROM discovery_source_cursors f JOIN discovery_source_cursors d ON d.owner=f.owner AND d.source_uri=f.parent_uri
        WHERE f.owner=?1 AND f.source_uri=?2 AND f.probe_at=?3 AND f.updated_at=?4",key,|r| {
        Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,i64>(3)?))
    }).optional()?;
    let Some((dir, created, prior_hash, until)) = row else {
        return Ok(());
    };
    let at = probe.observed.0;
    let created = created && prior_hash.is_none();
    let changed = prior_hash.as_ref() != Some(&fp.hash);
    let file_delta = changed && (until == 0 || at > until);
    c.execute("UPDATE discovery_source_cursors SET probe_at=NULL,probe_created=0,last_mtime_ms=?3,last_hash=?4,
        delta_kind=CASE WHEN ?5 THEN CASE WHEN ?6 OR delta_kind='created' THEN 'created' ELSE 'modified' END ELSE delta_kind END,
        delta_at=CASE WHEN ?5 THEN max(coalesce(delta_at,0)+1,?7) ELSE delta_at END,updated_at=updated_at+1
        WHERE owner=?1 AND source_uri=?2",params![owner,probe.path,fp.mtime.0,fp.hash,file_delta,created,at])?;
    if changed && !file_delta {
        directory_delta(c, owner, &dir, at)?;
    }
    Ok(())
}

fn directory_delta(c: &Connection, owner: &str, dir: &str, at: i64) -> Result<(), StoreError> {
    c.execute("UPDATE discovery_source_cursors SET delta_kind='directory',delta_at=max(coalesce(delta_at,0)+1,?3)
        WHERE owner=?1 AND source_uri=?2",params![owner,dir,at])?;
    Ok(())
}
