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

use crate::{
    control::{Result, is_link, validate_home},
    model::{Policy, Snapshot, no_follow, open_regular},
};
use chrono::{DateTime, Utc};
use serde_json::json;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

/// Native-only segment writer. The caller owns consent, rotation and retention.
/// Construction writes no event; boundaries must pass through append as well.
pub struct Store {
    home: PathBuf,
    segment: PathBuf,
    segment_id: String,
    started_at: DateTime<Utc>,
    events: File,
    _directories: Vec<File>,
    next_id: u64,
    event_count: u64,
    suppressed_event_count: u64,
    ended_at: Option<DateTime<Utc>>,
    failed: bool,
}

impl Store {
    pub fn new(home: &Path, now: DateTime<Utc>) -> Result<Self> {
        validate_home(home)?;
        let home_handle = directory_handle(home)?;
        let segments = home.join("segments");
        match fs::create_dir(&segments) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let segments_handle = directory_handle(&segments)?;
        let segment_id = Uuid::new_v4().to_string();
        let segment = segments.join(&segment_id);
        // Never reuse an existing segment, even in the unlikely UUID collision.
        fs::create_dir(&segment)?;
        let segment_handle = directory_handle(&segment)?;
        let events = open_regular(
            &segment.join("events.jsonl"),
            OpenOptions::new().write(true).create_new(true),
        )?;
        let mut store = Self {
            home: home.to_path_buf(),
            segment,
            segment_id,
            started_at: now,
            events,
            _directories: vec![home_handle, segments_handle, segment_handle],
            next_id: 1,
            event_count: 0,
            suppressed_event_count: 0,
            ended_at: None,
            failed: false,
        };
        store.write_metadata()?;
        Ok(store)
    }

    /// Counts producer-side denial without accepting or writing its payload.
    pub fn suppress(&mut self) -> Result<()> {
        self.require_active()?;
        self.suppressed_event_count = self
            .suppressed_event_count
            .checked_add(1)
            .ok_or("history_suppressed_count_exhausted")?;
        Ok(())
    }

    /// Ok(false) means policy/lifecycle suppression, never a storage failure.
    /// IDs include suppressed attempts so persisted IDs remain unique.
    /// Admission runs after file validation and serialization, immediately
    /// before the write. It must finish with the caller's live lifecycle fence.
    pub fn append_if(
        &mut self,
        snapshot: &Snapshot,
        kind: &str,
        policy: &Policy,
        now: DateTime<Utc>,
        admit: impl FnOnce() -> Result<bool>,
    ) -> Result<bool> {
        self.require_active()?;
        let id = self.next_id;
        if id > (1_u64 << 53) - 1 {
            return Err("history_event_id_exhausted".into());
        }
        self.next_id += 1;
        let Some(event) = policy.project(snapshot, kind, id, now) else {
            self.suppress()?;
            return Ok(false);
        };
        self.validate_files()?;
        let mut bytes = serde_json::to_vec(&event)?;
        bytes.push(b'\n');
        if !admit()? {
            self.suppress()?;
            return Ok(false);
        }
        if let Err(error) = self.events.write_all(&bytes) {
            // A failed write may have left a partial JSONL record; do not append
            // another record to that fragment or claim a clean finish.
            self.failed = true;
            return Err(error.into());
        }
        self.event_count += 1;
        Ok(true)
    }

    #[cfg(test)]
    fn append(
        &mut self,
        snapshot: &Snapshot,
        kind: &str,
        policy: &Policy,
        now: DateTime<Utc>,
    ) -> Result<bool> {
        self.append_if(snapshot, kind, policy, now, || Ok(true))
    }

    /// Synchronizes events before atomically publishing their metadata counts.
    pub fn flush(&mut self) -> Result<()> {
        if self.failed {
            return Err("history_store_failed".into());
        }
        self.validate_files()?;
        self.events.sync_all()?;
        self.write_metadata()
    }

    /// Seals this segment. The caller appends any session.ended identity first.
    /// Repeated finish calls keep the original end time.
    pub fn finish(&mut self, now: DateTime<Utc>) -> Result<()> {
        self.ended_at.get_or_insert(now);
        self.flush()
    }

    fn require_active(&self) -> Result<()> {
        if self.failed {
            Err("history_store_failed".into())
        } else if self.ended_at.is_some() {
            Err("history_store_finished".into())
        } else {
            Ok(())
        }
    }

    fn validate_files(&self) -> Result<()> {
        validate_home(&self.home)?;
        for path in [self.home.join("segments"), self.segment.clone()] {
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_dir() || is_link(&metadata) {
                return Err("history_segment_must_be_a_real_directory".into());
            }
        }
        let events = fs::symlink_metadata(self.segment.join("events.jsonl"))?;
        if !events.is_file() || is_link(&events) {
            return Err("history_file_must_be_regular".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let opened = self.events.metadata()?;
            if events.dev() != opened.dev() || events.ino() != opened.ino() {
                return Err("history_events_replaced".into());
            }
        }
        match fs::symlink_metadata(self.segment.join("metadata.json")) {
            Ok(metadata) if !metadata.is_file() || is_link(&metadata) => {
                Err("history_file_must_be_regular".into())
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    fn write_metadata(&mut self) -> Result<()> {
        self.validate_files()?;
        let metadata = json!({
            "id": self.segment_id,
            // Main resolves files inside the segment; no absolute history path
            // needs to cross a native status or renderer boundary.
            "eventsPath": "events.jsonl",
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "endReason": self.ended_at.map(|_| "finished"),
            "eventCount": self.event_count,
            "suppressedEventCount": self.suppressed_event_count,
        });
        let temporary = self
            .segment
            .join(format!(".metadata-{}.tmp", Uuid::new_v4()));
        let mut file = open_regular(&temporary, OpenOptions::new().write(true).create_new(true))?;
        file.write_all(&serde_json::to_vec(&metadata)?)?;
        file.sync_all()?;
        drop(file);
        self.validate_files()?;
        fs::rename(temporary, self.segment.join("metadata.json"))?;
        Ok(())
    }
}

fn directory_handle(path: &Path) -> Result<File> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("history_segment_must_be_a_real_directory".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    no_follow(&mut options);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // BACKUP_SEMANTICS | OPEN_REPARSE_POINT; allow child writes, not rename.
        options.custom_flags(0x0220_0000).share_mode(0x0000_0003);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("history_segment_must_be_a_real_directory".into());
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::tests::{Home, now, snapshot};
    use serde_json::Value;

    fn records(store: &Store) -> Vec<Value> {
        fs::read_to_string(store.segment.join("events.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn metadata(store: &Store) -> Value {
        serde_json::from_slice(&fs::read(store.segment.join("metadata.json")).unwrap()).unwrap()
    }

    #[test]
    fn final_write_fence_rejects_aba_eof_pause_and_backlog_during_preparation() {
        use crate::{
            control::{Control, State},
            recorder_lifecycle::{CaptureFence, EventEpochs, LiveState, drain_events},
        };
        use std::cell::Cell;

        for change in [
            "window_aba",
            "content_aba",
            "eof",
            "parent",
            "pause",
            "backlog",
        ] {
            let home = Home::new();
            let policy = home.policy(true);
            let mut store = Store::new(&home.0, now()).unwrap();
            let original = snapshot();
            let epochs = EventEpochs::new();
            let fence = CaptureFence {
                target: (original.window_id as usize, original.pid),
                epochs: epochs.current(),
            };
            let stopped = Cell::new(false);
            let alive = Cell::new(true);
            let queued = Cell::new(0);
            let control_path = home.0.join("control.json");
            fs::write(&control_path, r#"{"state":"running","revision":"before"}"#).unwrap();
            let control = Control::load(&home.0).unwrap();
            let written = store
                .append_if(&original, "ui.changed", &policy, now(), || {
                    fence.after_preparation(
                        || {
                            // Inject at preparation, not at the Boolean assertion:
                            // the production fence must sample again after this.
                            match change {
                                "window_aba" | "content_aba" => queued.set(2),
                                "eof" => stopped.set(true),
                                "parent" => alive.set(false),
                                "pause" => fs::write(
                                    &control_path,
                                    r#"{"state":"paused","revision":"after"}"#,
                                )?,
                                "backlog" => queued.set(257),
                                _ => unreachable!(),
                            }
                            let current = Control::load(&home.0)?;
                            Ok(current.state == State::Running
                                && current.revision == control.revision)
                        },
                        || {
                            let queue_drained = drain_events(
                                || {
                                    if queued.get() == 0 {
                                        return false;
                                    }
                                    queued.set(queued.get() - 1);
                                    match change {
                                        "window_aba" => epochs.window_changed(),
                                        "content_aba" => epochs.content_changed(),
                                        _ => {}
                                    }
                                    true
                                },
                                256,
                            );
                            LiveState {
                                queue_drained,
                                parent_alive: alive.get(),
                                stopping: stopped.get(),
                                foreground: Some(fence.target),
                                desktop_available: true,
                                epochs: epochs.current(),
                            }
                        },
                    )
                })
                .unwrap();
            assert!(!written, "{change}");
            assert!(records(&store).is_empty(), "{change}");
            assert_eq!(store.suppressed_event_count, 1);
            // Denial does not advance a retained baseline or poison the writer.
            assert!(
                store
                    .append(&original, "ui.changed", &policy, now())
                    .unwrap()
            );
            assert_eq!(records(&store).len(), 1);
        }
    }

    #[test]
    fn invalid_storage_never_runs_final_admission_and_admission_errors_never_write() {
        let home = Home::new();
        let policy = home.policy(true);
        let mut store = Store::new(&home.0, now()).unwrap();
        fs::remove_file(store.segment.join("metadata.json")).unwrap();
        fs::create_dir(store.segment.join("metadata.json")).unwrap();
        assert!(
            store
                .append_if(&snapshot(), "ui.changed", &policy, now(), || {
                    panic!("file validation must complete before final admission")
                })
                .is_err()
        );
        fs::remove_dir(store.segment.join("metadata.json")).unwrap();
        assert!(
            store
                .append_if(&snapshot(), "ui.changed", &policy, now(), || {
                    Err("unreadable_control".into())
                })
                .is_err()
        );
        assert!(records(&store).is_empty());
        assert!(!store.failed);
    }

    #[test]
    fn constructor_has_no_events_and_segments_have_independent_uuid_identity() {
        let home = Home::new();
        let first = Store::new(&home.0, now()).unwrap();
        let second = Store::new(&home.0, now()).unwrap();
        assert_ne!(first.segment_id, second.segment_id);
        assert!(Uuid::parse_str(&first.segment_id).is_ok());
        assert!(records(&first).is_empty());
        assert!(records(&second).is_empty());
        assert_eq!(metadata(&first)["eventCount"], 0);
        assert_eq!(metadata(&first)["suppressedEventCount"], 0);
        assert_eq!(metadata(&first)["eventsPath"], "events.jsonl");
        assert!(
            !metadata(&first)
                .to_string()
                .contains(home.0.to_str().unwrap())
        );
    }

    #[test]
    fn actual_jsonl_writes_apply_current_policy_and_flush_complete_counts() {
        let home = Home::new();
        let text = home.policy(true);
        let metadata_only = home.policy(false);
        let mut store = Store::new(&home.0, now()).unwrap();
        let original = snapshot();
        assert!(store.append(&original, "ui.changed", &text, now()).unwrap());
        assert!(
            store
                .append(&original, "ui.changed", &metadata_only, now())
                .unwrap()
        );
        let mut blocked = original.clone();
        blocked.secure = true;
        assert!(!store.append(&blocked, "ui.changed", &text, now()).unwrap());
        blocked.secure = false;
        blocked.private = true;
        assert!(
            !store
                .append(&blocked, "ui.changed", &metadata_only, now())
                .unwrap()
        );
        blocked.private = false;
        blocked.source_known = false;
        assert!(!store.append(&blocked, "ui.changed", &text, now()).unwrap());
        assert!(
            store
                .append(&original, "window.changed", &metadata_only, now())
                .unwrap()
        );
        store.flush().unwrap();
        let events = records(&store);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["ax"]["text"], original.text.unwrap());
        assert_eq!(events[1]["contentState"], "metadataOnly");
        assert!(events[1].get("ax").is_none());
        assert_eq!(events[2]["id"], 6);
        assert_eq!(store.event_count, 3);
        assert_eq!(store.suppressed_event_count, 3);
        assert_eq!(metadata(&store)["eventCount"], 3);
        assert_eq!(metadata(&store)["suppressedEventCount"], 3);
        assert!(!store.segment.join("suppressed.jsonl").exists());
    }

    #[test]
    fn boundaries_and_finish_do_not_retain_context_and_finish_seals_the_writer() {
        let home = Home::new();
        let policy = home.policy(true);
        let mut store = Store::new(&home.0, now()).unwrap();
        let mut original = snapshot();
        original.secure = true;
        for kind in ["session.started", "session.ended"] {
            assert!(store.append(&original, kind, &policy, now()).unwrap());
        }
        let end = now() + chrono::Duration::minutes(10);
        store.finish(end).unwrap();
        store.finish(end + chrono::Duration::seconds(2)).unwrap();
        assert!(
            store
                .append(&original, "session.started", &policy, end)
                .is_err()
        );
        for event in records(&store) {
            assert_eq!(event.as_object().unwrap().len(), 3);
            assert!(event.get("id").is_some());
            assert!(event.get("kind").is_some());
            assert!(event.get("timestamp").is_some());
        }
        let meta = metadata(&store);
        assert_eq!(meta["endReason"], "finished");
        assert_eq!(meta["eventCount"], 2);
        assert_eq!(meta["endedAt"], serde_json::to_value(end).unwrap());
        assert!(fs::read_dir(&store.segment).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
    }

    #[test]
    fn old_segments_are_never_pruned_by_native_rotation_or_finish() {
        let home = Home::new();
        let past = now() - chrono::Duration::days(30);
        let mut old = Store::new(&home.0, past).unwrap();
        old.finish(past).unwrap();
        let old_metadata = fs::read(old.segment.join("metadata.json")).unwrap();
        let mut current = Store::new(&home.0, now()).unwrap();
        current.flush().unwrap();
        current.finish(now()).unwrap();
        assert_eq!(
            fs::read(old.segment.join("metadata.json")).unwrap(),
            old_metadata
        );
        assert!(old.segment.join("events.jsonl").exists());
    }

    #[test]
    fn directories_cannot_be_used_as_policy_or_output_files() {
        let home = Home::new();
        let policy = home.policy(false);
        let mut store = Store::new(&home.0, now()).unwrap();
        fs::remove_file(store.segment.join("metadata.json")).unwrap();
        fs::create_dir(store.segment.join("metadata.json")).unwrap();
        assert!(
            store
                .append(&snapshot(), "ui.changed", &policy, now())
                .is_err()
        );
        assert!(store.flush().is_err());
        assert!(records(&store).is_empty());
        assert!(Store::new(Path::new("relative-home"), now()).is_err());
        let other = Home::new();
        fs::write(other.0.join("segments"), "untouched").unwrap();
        assert!(Store::new(&other.0, now()).is_err());
        assert_eq!(
            fs::read_to_string(other.0.join("segments")).unwrap(),
            "untouched"
        );
    }

    #[test]
    fn producer_denials_flush_without_events_and_stop_after_finish() {
        let home = Home::new();
        let mut store = Store::new(&home.0, now()).unwrap();
        store.suppress().unwrap();
        store.suppress().unwrap();
        store.flush().unwrap();
        assert!(records(&store).is_empty());
        assert_eq!(metadata(&store)["eventCount"], 0);
        assert_eq!(metadata(&store)["suppressedEventCount"], 2);
        store.finish(now()).unwrap();
        assert!(store.suppress().is_err());
        assert_eq!(metadata(&store)["suppressedEventCount"], 2);
    }

    #[cfg(unix)]
    #[test]
    fn links_never_redirect_config_segments_or_active_files() {
        use std::os::unix::fs::symlink;
        let home = Home::new();
        let outside = Home::new();
        let outside_policy = outside.policy(true);
        assert!(outside_policy.capture_text);
        symlink(outside.0.join("config.json"), home.0.join("config.json")).unwrap();
        assert!(Policy::load(&home.0).is_err());
        symlink(&outside.0, home.0.join("segments")).unwrap();
        assert!(Store::new(&home.0, now()).is_err());
        assert!(!outside.0.join("events.jsonl").exists());
        fs::remove_file(home.0.join("segments")).unwrap();
        fs::remove_file(home.0.join("config.json")).unwrap();
        let policy = home.policy(true);
        let mut store = Store::new(&home.0, now()).unwrap();
        let canary = outside.0.join("canary");
        fs::write(&canary, "never touch").unwrap();
        fs::remove_file(store.segment.join("metadata.json")).unwrap();
        symlink(&canary, store.segment.join("metadata.json")).unwrap();
        assert!(store.flush().is_err());
        assert_eq!(fs::read_to_string(&canary).unwrap(), "never touch");
        fs::remove_file(store.segment.join("metadata.json")).unwrap();
        fs::remove_file(store.segment.join("events.jsonl")).unwrap();
        symlink(&canary, store.segment.join("events.jsonl")).unwrap();
        assert!(
            store
                .append(&snapshot(), "ui.changed", &policy, now())
                .is_err()
        );
        assert_eq!(fs::read_to_string(&canary).unwrap(), "never touch");
        fs::remove_file(store.segment.join("events.jsonl")).unwrap();
        fs::write(store.segment.join("events.jsonl"), "replacement").unwrap();
        assert!(
            store
                .append(&snapshot(), "ui.changed", &policy, now())
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(store.segment.join("events.jsonl")).unwrap(),
            "replacement"
        );
    }

    #[cfg(windows)]
    #[test]
    fn junction_segments_are_rejected_without_touching_the_target() {
        let home = Home::new();
        let outside = Home::new();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(home.0.join("segments"))
            .arg(&outside.0)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(Store::new(&home.0, now()).is_err());
        assert!(fs::read_dir(&outside.0).unwrap().next().is_none());
        fs::remove_dir(home.0.join("segments")).unwrap();
    }
}
