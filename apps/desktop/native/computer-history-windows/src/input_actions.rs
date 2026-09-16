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
    input::{
        InputBatch, InputFact, InputKind, InputMode, InputScope, MAX_PRESS_AGE, MouseButton,
        MouseGesture,
    },
    model::{Action, Snapshot},
};
use std::time::{Duration, Instant, SystemTime};

pub const ACTION_TTL: Duration = Duration::from_secs(5);
const MAX_ACTIONS: usize = 32;

pub struct QueuedAction {
    pub kind: &'static str,
    pub action: Action,
    pub received_at: SystemTime,
    observed_at: Instant,
}

#[derive(Default)]
pub struct Actions {
    down: Option<InputFact>,
    queue: Vec<QueuedAction>,
}

impl Actions {
    pub fn clear(&mut self) {
        self.down = None;
        self.queue.clear();
    }

    pub fn ingest(&mut self, batch: InputBatch, scope: InputScope, now: Instant) {
        if !scope.is_admitted() {
            self.clear();
            return;
        }
        if batch.interrupted {
            self.clear();
        }
        for fact in batch.facts {
            if fact.scope != scope || now.saturating_duration_since(fact.observed_at) > ACTION_TTL {
                self.clear();
                continue;
            }
            if scope.mode == InputMode::ObservedUia
                && matches!(
                    fact.kind,
                    InputKind::MouseDown { .. } | InputKind::MouseUp { .. }
                )
            {
                self.down = None;
                continue;
            }
            let modifiers = fact.modifiers.names().map(str::to_owned).collect();
            let (kind, action) = match fact.kind {
                InputKind::Return => (
                    "keyboard.submit",
                    Action::Keyboard {
                        key: "return".into(),
                        modifiers,
                    },
                ),
                InputKind::Shortcut { virtual_key } => {
                    let Some(key) = key_name(virtual_key) else {
                        continue;
                    };
                    ("keyboard.shortcut", Action::Keyboard { key, modifiers })
                }
                InputKind::MouseDown { .. } => {
                    self.down = Some(fact);
                    continue;
                }
                InputKind::MouseUp {
                    button,
                    x,
                    y,
                    gesture,
                } => {
                    let Some(down) = self.down.take() else {
                        continue;
                    };
                    let InputKind::MouseDown {
                        button: old,
                        x: start_x,
                        y: start_y,
                    } = down.kind
                    else {
                        continue;
                    };
                    let dx = i64::from(x) - i64::from(start_x);
                    let dy = i64::from(y) - i64::from(start_y);
                    if old != button
                        || down.scope != fact.scope
                        || fact.os_time_ms.wrapping_sub(down.os_time_ms)
                            > MAX_PRESS_AGE.as_millis() as u32
                        || fact.observed_at.saturating_duration_since(down.observed_at)
                            > MAX_PRESS_AGE
                        || gesture == MouseGesture::Disqualified
                    {
                        continue;
                    }
                    // The observer owns excursion evidence across drains. Endpoint
                    // distance alone cannot distinguish a click from an out/back drag.
                    let drag = gesture == MouseGesture::Drag;
                    if !drag && (dx.abs() > 6 || dy.abs() > 6 || dx * dx + dy * dy > 36) {
                        continue;
                    }
                    (
                        if drag {
                            "mouse.drag"
                        } else if button == MouseButton::Right {
                            "mouse.contextMenu"
                        } else {
                            "mouse.click"
                        },
                        Action::Mouse {
                            button: button.name().into(),
                            modifiers,
                        },
                    )
                }
            };
            if self.queue.len() >= MAX_ACTIONS {
                self.clear();
                break;
            }
            self.queue.push(QueuedAction {
                kind,
                action,
                received_at: fact.received_at,
                observed_at: fact.observed_at,
            });
        }
    }

    /// Offers one unexpired action observed no later than the verifier started.
    /// Only Ok(true) consumes it; false or error retains its original age.
    /// The caller must clear on source/policy loss and terminate on write errors.
    /// False also means no eligible action, so it always ends this write pass.
    pub fn persist_next(
        &mut self,
        now: Instant,
        capture_started: Instant,
        write: impl FnOnce(&QueuedAction) -> crate::control::Result<bool>,
    ) -> crate::control::Result<bool> {
        self.queue
            .retain(|action| now.saturating_duration_since(action.observed_at) <= ACTION_TTL);
        let Some(index) = self
            .queue
            .iter()
            .position(|action| action.observed_at <= capture_started)
        else {
            return Ok(false);
        };
        if !write(&self.queue[index])? {
            return Ok(false);
        }
        self.queue.remove(index);
        Ok(true)
    }

    #[cfg(test)]
    pub fn take(&mut self, now: Instant, capture_started: Instant) -> Vec<QueuedAction> {
        let mut verified = Vec::new();
        while self
            .persist_next(now, capture_started, |action| {
                verified.push(QueuedAction {
                    kind: action.kind,
                    action: action.action.clone(),
                    received_at: action.received_at,
                    observed_at: action.observed_at,
                });
                Ok(true)
            })
            .unwrap()
        {}
        verified
    }

    pub fn pending(&self) -> bool {
        !self.queue.is_empty()
    }
}

pub fn same_input_source(original: &Snapshot, fresh: &Snapshot) -> bool {
    original.input_target.is_some()
        && original.input_target == fresh.input_target
        && original.source_id == fresh.source_id
        && original.window_id == fresh.window_id
        && original.pid == fresh.pid
        && original.app_id == fresh.app_id
        && original.application_user_model_id == fresh.application_user_model_id
        && original.title == fresh.title
        && original.url == fresh.url
        && original.domains == fresh.domains
        && original.source_known
        && fresh.source_known
        && !original.secure
        && !fresh.secure
        && !original.private
        && !fresh.private
}

fn key_name(key: u32) -> Option<String> {
    Some(match key {
        0x30..=0x39 | 0x41..=0x5a => char::from_u32(key)?.to_ascii_lowercase().to_string(),
        0x70..=0x87 => format!("f{}", key - 0x70 + 1),
        0x08 => "backspace".into(),
        0x09 => "tab".into(),
        0x0d => "return".into(),
        0x1b => "escape".into(),
        0x20 => "space".into(),
        0x21 => "pageup".into(),
        0x22 => "pagedown".into(),
        0x23 => "end".into(),
        0x24 => "home".into(),
        0x25 => "left".into(),
        0x26 => "up".into(),
        0x27 => "right".into(),
        0x28 => "down".into(),
        0x2d => "insert".into(),
        0x2e => "delete".into(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        input::Modifiers,
        model::{InputTarget, UiaTarget, tests::snapshot},
    };

    fn fact(kind: InputKind, now: Instant) -> InputFact {
        InputFact {
            scope: InputScope {
                hwnd: 10,
                pid: 20,
                epoch: 30,
                focus_hwnd: 11,
                mode: InputMode::NativeChild,
                uia_lease_epoch: None,
            },
            kind,
            modifiers: Modifiers::default(),
            os_time_ms: 100,
            observed_at: now,
            received_at: SystemTime::UNIX_EPOCH,
        }
    }

    #[test]
    fn uia_ingestion_is_keyboard_only_and_requires_explicit_lease() {
        let now = Instant::now();
        for lease in [None, Some(0), Some(3)] {
            let mut input = fact(InputKind::Return, now);
            input.scope.mode = InputMode::ObservedUia;
            input.scope.focus_hwnd = input.scope.hwnd;
            input.scope.uia_lease_epoch = lease;
            let mut shortcut = input;
            shortcut.kind = InputKind::Shortcut { virtual_key: 0x41 };
            shortcut.modifiers.control = true;
            let down = InputFact {
                kind: InputKind::MouseDown {
                    button: MouseButton::Left,
                    x: 0,
                    y: 0,
                },
                ..input
            };
            let up = InputFact {
                kind: InputKind::MouseUp {
                    button: MouseButton::Left,
                    x: 0,
                    y: 0,
                    gesture: MouseGesture::Drag,
                },
                ..input
            };
            let mut actions = Actions::default();
            actions.ingest(
                InputBatch {
                    facts: vec![input, down, up, shortcut],
                    interrupted: false,
                },
                input.scope,
                now,
            );
            let result = actions.take(now, now);
            assert_eq!(
                result.iter().map(|action| action.kind).collect::<Vec<_>>(),
                if lease.is_some() {
                    vec!["keyboard.submit", "keyboard.shortcut"]
                } else {
                    vec![]
                }
            );
            assert!(actions.down.is_none());
        }
    }

    #[test]
    fn uia_lease_epoch_mismatch_discards_pending_and_undrained_actions() {
        let now = Instant::now();
        let mut input = fact(InputKind::Return, now);
        input.scope.mode = InputMode::ObservedUia;
        input.scope.uia_lease_epoch = Some(1);
        for next in [
            InputScope {
                uia_lease_epoch: None,
                ..input.scope
            },
            InputScope {
                uia_lease_epoch: Some(2),
                ..input.scope
            },
            InputScope {
                epoch: input.scope.epoch + 1,
                ..input.scope
            },
            InputScope {
                mode: InputMode::NativeChild,
                uia_lease_epoch: None,
                ..input.scope
            },
        ] {
            let mut actions = Actions::default();
            actions.ingest(
                InputBatch {
                    facts: vec![input],
                    interrupted: false,
                },
                input.scope,
                now,
            );
            assert!(actions.pending());
            actions.ingest(
                InputBatch {
                    facts: vec![input],
                    interrupted: false,
                },
                next,
                now,
            );
            assert!(
                !actions
                    .persist_next(now, now, |_| panic!("old lease action survived"))
                    .unwrap()
            );
            if next.is_admitted() {
                actions.ingest(
                    InputBatch {
                        facts: vec![InputFact {
                            scope: next,
                            ..input
                        }],
                        interrupted: false,
                    },
                    next,
                    now,
                );
                assert!(actions.persist_next(now, now, |_| Ok(true)).unwrap());
                assert!(!actions.pending());
            }
        }
    }

    #[test]
    fn modified_return_retains_shortcut_kind_key_and_modifiers() {
        let now = Instant::now();
        let mut input = fact(InputKind::Shortcut { virtual_key: 0x0d }, now);
        input.modifiers = Modifiers {
            control: true,
            shift: true,
            ..Default::default()
        };
        let mut actions = Actions::default();
        actions.ingest(
            InputBatch {
                facts: vec![input],
                interrupted: false,
            },
            input.scope,
            now,
        );
        let result = actions.take(now, now);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind, "keyboard.shortcut");
        assert_eq!(
            result[0].action,
            Action::Keyboard {
                key: "return".into(),
                modifiers: vec!["control".into(), "shift".into()],
            }
        );
    }

    #[test]
    fn clicks_require_owned_matching_down_and_up_and_do_not_invent_drags() {
        let now = Instant::now();
        let down = fact(
            InputKind::MouseDown {
                button: MouseButton::Left,
                x: 10,
                y: 20,
            },
            now,
        );
        let up = fact(
            InputKind::MouseUp {
                button: MouseButton::Left,
                x: 11,
                y: 20,
                gesture: MouseGesture::Click,
            },
            now,
        );
        let mut actions = Actions::default();
        actions.ingest(
            InputBatch {
                facts: vec![up],
                interrupted: false,
            },
            down.scope,
            now,
        );
        assert!(actions.take(now, now).is_empty());
        actions.ingest(
            InputBatch {
                facts: vec![down, up],
                interrupted: false,
            },
            down.scope,
            now,
        );
        let result = actions.take(now, now);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind, "mouse.click");
        assert_eq!(
            result[0].action,
            Action::Mouse {
                button: "left".into(),
                modifiers: vec![],
            }
        );
        assert_eq!(result[0].received_at, SystemTime::UNIX_EPOCH);
        actions.ingest(
            InputBatch {
                facts: vec![down],
                interrupted: false,
            },
            down.scope,
            now,
        );
        actions.ingest(
            InputBatch {
                facts: vec![up],
                interrupted: true,
            },
            down.scope,
            now,
        );
        assert!(actions.take(now, now).is_empty());
        let far = InputFact {
            kind: InputKind::MouseUp {
                button: MouseButton::Left,
                x: i32::MAX,
                y: i32::MIN,
                gesture: MouseGesture::Click,
            },
            ..up
        };
        actions.ingest(
            InputBatch {
                facts: vec![down, far],
                interrupted: false,
            },
            down.scope,
            now,
        );
        assert!(actions.take(now, now).is_empty());
    }

    #[test]
    fn action_expiry_overflow_and_source_change_discard_instead_of_relabel() {
        let now = Instant::now();
        let input = fact(InputKind::Return, now);
        let mut actions = Actions::default();
        actions.ingest(
            InputBatch {
                facts: vec![input],
                interrupted: false,
            },
            input.scope,
            now,
        );
        assert!(actions.pending());
        assert!(actions.take(now, now - Duration::from_millis(1)).is_empty());
        assert!(
            actions.pending(),
            "an earlier capture cannot validate later input"
        );
        assert!(
            actions
                .take(now + ACTION_TTL + Duration::from_millis(1), now)
                .is_empty()
        );
        actions.ingest(
            InputBatch {
                facts: vec![input; MAX_ACTIONS + 1],
                interrupted: false,
            },
            input.scope,
            now,
        );
        assert!(!actions.pending());
        let mut original = snapshot();
        original.input_target = Some(InputTarget {
            hwnd: 11,
            role: "AXTextField".into(),
            uia: None,
        });
        let mut fresh = original.clone();
        fresh.text = Some("changed after Return".into());
        assert!(same_input_source(&original, &fresh));
        for field in ["focus", "source", "pid", "title", "url", "secure"] {
            let mut fresh = fresh.clone();
            match field {
                "focus" => fresh.input_target.as_mut().unwrap().hwnd += 1,
                "source" => fresh.source_id = uuid::Uuid::new_v4().to_string(),
                "pid" => fresh.pid += 1,
                "title" => fresh.title.push('!'),
                "url" => fresh.url = None,
                _ => fresh.secure = true,
            }
            assert!(!same_input_source(&original, &fresh), "{field}");
        }
    }

    #[test]
    fn input_source_requires_unchanged_optional_packaged_identity() {
        let mut original = snapshot();
        original.input_target = Some(InputTarget {
            hwnd: 11,
            role: "AXTextField".into(),
            uia: None,
        });
        let aumid = "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App";
        let other = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
        for (before, after, expected) in [
            (None, None, true),
            (Some(aumid), Some(aumid), true),
            (Some(aumid), Some(other), false),
            (Some(aumid), None, false),
            (None, Some(aumid), false),
        ] {
            original.application_user_model_id = before.map(str::to_owned);
            let mut fresh = original.clone();
            fresh.application_user_model_id = after.map(str::to_owned);
            fresh.text = Some("updated content in the same native control".into());
            assert_eq!(
                same_input_source(&original, &fresh),
                expected,
                "{before:?} -> {after:?}",
            );
        }
    }

    #[test]
    fn uia_source_equality_requires_exact_element_document_host_role_and_mode() {
        let mut original = snapshot();
        original.input_target = Some(InputTarget {
            hwnd: original.window_id,
            role: "AXTextField".into(),
            uia: Some(UiaTarget {
                runtime_id: vec![42, 1],
                document_runtime_id: vec![42, 2],
            }),
        });
        let mut content_changed = original.clone();
        content_changed.text = Some("updated content in the same UIA field".into());
        content_changed.selection = None;
        assert!(same_input_source(&original, &content_changed));
        for change in ["element", "document", "host", "role", "native", "missing"] {
            let mut fresh = content_changed.clone();
            let target = fresh.input_target.as_mut().unwrap();
            match change {
                "element" => target.uia.as_mut().unwrap().runtime_id.push(3),
                "document" => target.uia.as_mut().unwrap().document_runtime_id.push(3),
                "host" => target.hwnd += 1,
                "role" => target.role = "AXDocument".into(),
                "native" => target.uia = None,
                "missing" => fresh.input_target = None,
                _ => unreachable!(),
            }
            assert!(!same_input_source(&original, &fresh), "{change}");
            assert!(!same_input_source(&fresh, &original), "{change}");
        }
    }

    #[test]
    fn content_denied_write_retries_fresh_without_replaying_committed_actions() {
        use crate::{
            model::tests::{Home, now as wall_now},
            recorder_lifecycle::{CaptureFence, EventEpochs, LiveState},
            store::Store,
        };
        let home = Home::new();
        let policy = home.policy(true);
        let mut store = Store::new(&home.0, wall_now()).unwrap();
        let now = Instant::now();
        let input = fact(InputKind::Return, now);
        let mut shortcut = fact(InputKind::Shortcut { virtual_key: 0x41 }, now);
        shortcut.modifiers.control = true;
        let mut actions = Actions::default();
        actions.ingest(
            InputBatch {
                facts: vec![input, shortcut],
                interrupted: false,
            },
            input.scope,
            now,
        );
        let mut source = snapshot();
        source.pid = input.scope.pid;
        source.window_id = input.scope.hwnd as u64;
        source.input_target = Some(InputTarget {
            hwnd: input.scope.focus_hwnd as u64,
            role: "AXTextField".into(),
            uia: None,
        });
        let epochs = EventEpochs::new();
        let fence = CaptureFence {
            target: (source.window_id as usize, source.pid),
            epochs: epochs.current(),
        };
        let sample = || LiveState {
            queue_drained: true,
            parent_alive: true,
            stopping: false,
            desktop_available: true,
            foreground: Some(fence.target),
            epochs: epochs.current(),
        };
        let mut append = |action: &QueuedAction, verifier: CaptureFence, cancel| {
            let mut payload = source.without_content();
            payload.action = Some(action.action.clone());
            store.append_if(&payload, action.kind, &policy, wall_now(), || {
                verifier.after_preparation(
                    || {
                        if cancel {
                            epochs.content_changed();
                        }
                        Ok(true)
                    },
                    sample,
                )
            })
        };
        assert!(
            !actions
                .persist_next(now, now, |action| append(action, fence, true))
                .unwrap()
        );
        assert!(actions.pending());
        let fresh = CaptureFence {
            epochs: epochs.current(),
            ..fence
        };
        let retry = now + Duration::from_millis(100);
        assert!(
            actions
                .persist_next(retry, retry, |action| {
                    assert_eq!(action.observed_at, now);
                    assert_eq!(action.received_at, input.received_at);
                    append(action, fresh, false)
                })
                .unwrap()
        );
        // The second action is denied after the first was committed.
        assert!(
            !actions
                .persist_next(retry, retry, |action| append(action, fresh, true))
                .unwrap()
        );
        let fresh = CaptureFence {
            epochs: epochs.current(),
            ..fence
        };
        assert!(
            actions
                .persist_next(retry, retry, |action| append(action, fresh, false))
                .unwrap()
        );
        assert!(
            !actions
                .persist_next(retry, retry, |_| panic!("committed action replayed"))
                .unwrap()
        );
        assert!(!actions.pending());
        let segment = std::fs::read_dir(home.0.join("segments"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let records: Vec<serde_json::Value> = std::fs::read_to_string(segment.join("events.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["kind"], "keyboard.submit");
        assert_eq!(records[1]["kind"], "keyboard.shortcut");
        assert!(
            !serde_json::to_string(&records)
                .unwrap()
                .contains(source.text.as_ref().unwrap())
        );
    }

    #[test]
    fn failed_writer_does_not_acknowledge_or_automatically_retry() {
        let now = Instant::now();
        let input = fact(InputKind::Return, now);
        let mut actions = Actions::default();
        actions.ingest(
            InputBatch {
                facts: vec![input],
                interrupted: false,
            },
            input.scope,
            now,
        );
        let mut calls = 0;
        let error = actions
            .persist_next(now, now, |_| {
                calls += 1;
                Err("storage_failed".into())
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "storage_failed");
        assert_eq!(calls, 1);
        assert!(actions.pending());
        actions.clear();
        assert!(
            !actions
                .persist_next(now, now, |_| panic!("terminated write retried"))
                .unwrap()
        );
    }

    #[test]
    fn persistence_retry_keeps_original_ttl_and_verifier_start_bound() {
        let now = Instant::now();
        let input = fact(InputKind::Return, now);
        let mut actions = Actions::default();
        actions.ingest(
            InputBatch {
                facts: vec![input],
                interrupted: false,
            },
            input.scope,
            now,
        );
        assert!(
            !actions
                .persist_next(now, now - Duration::from_nanos(1), |_| {
                    panic!("verifier predates action")
                })
                .unwrap()
        );
        assert!(actions.pending());
        assert!(
            !actions
                .persist_next(now + ACTION_TTL, now, |_| Ok(false))
                .unwrap()
        );
        assert!(actions.pending(), "inclusive TTL boundary changed");
        assert!(
            !actions
                .persist_next(now + ACTION_TTL + Duration::from_nanos(1), now, |_| {
                    panic!("retry renewed the original fact")
                })
                .unwrap()
        );
        assert!(!actions.pending());
    }

    #[test]
    fn interrupted_or_mismatched_scope_cannot_retry_a_queued_action() {
        for interrupted in [true, false] {
            let now = Instant::now();
            let input = fact(InputKind::Return, now);
            let mut actions = Actions::default();
            actions.ingest(
                InputBatch {
                    facts: vec![input],
                    interrupted: false,
                },
                input.scope,
                now,
            );
            assert!(!actions.persist_next(now, now, |_| Ok(false)).unwrap());
            actions.ingest(
                InputBatch {
                    facts: if interrupted { vec![] } else { vec![input] },
                    interrupted,
                },
                InputScope {
                    epoch: input.scope.epoch + 1,
                    ..input.scope
                },
                now,
            );
            assert!(
                !actions
                    .persist_next(now, now, |_| panic!("revoked action survived"))
                    .unwrap()
            );
            assert!(!actions.pending());
        }
    }
}
