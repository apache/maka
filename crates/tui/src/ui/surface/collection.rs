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
use crate::ui::collection::Control;

pub(super) struct Drag<M> {
    control: Control<M>,
    start: Option<Position>,
    moved: bool,
    valid: bool,
}
impl<M: Clone> Surface<M> {
    pub(super) fn cancel_collection(&mut self) {
        if let Some(drag) = self.collection_drag.take() {
            drag.control.state().cancel();
        }
    }
    pub(super) fn collection_input(&mut self, event: &Event) -> Option<Outcome<M>> {
        if matches!(event, Event::Resize(..) | Event::FocusLost) {
            self.cancel_collection();
            return None;
        }
        if let Some(drag) = &self.collection_drag {
            let valid = self.committed.as_ref().is_some_and(|frame| {
                frame.items.iter().any(|item| {
                    item.enabled
                        && match (&item.on, &drag.control) {
                            (
                                On::Collection(Control::Item { state, item, .. }),
                                Control::Item {
                                    state: owner,
                                    item: original,
                                    ..
                                },
                            ) => state.same(owner) && item == original,
                            _ => false,
                        }
                })
            });
            let stale = matches!(&drag.control, Control::Item { state, commit: Some(_), .. } if state.preview().is_none());
            if !valid || stale {
                self.cancel_collection();
                return Some(Outcome::handled(true));
            }
        }
        if let Event::Key(key) = event
            && key.kind == KeyEventKind::Release
        {
            return None;
        }
        if let Event::Key(key) = event
            && self.collection_drag.is_some()
        {
            if key.code == KeyCode::Esc {
                self.cancel_collection();
                return Some(Outcome::handled(true));
            }
            if key.code == KeyCode::Tab || key.code == KeyCode::BackTab {
                self.cancel_collection();
                return None;
            }
            if matches!(
                key.code,
                KeyCode::Left | KeyCode::Right | KeyCode::Up | KeyCode::Down
            ) {
                let drag = self.collection_drag.as_mut().unwrap();
                drag.control.state().step(key.code);
                drag.moved = true;
                return Some(Outcome::handled(true));
            }
            if key.code == KeyCode::Enter {
                let drag = self.collection_drag.take().unwrap();
                return Some(Self::finish_collection(drag));
            }
        }
        if let Event::Mouse(mouse) = event {
            if mouse.kind == MouseEventKind::Moved && self.collection_drag.is_some() {
                self.cancel_collection();
                return Some(Outcome::handled(true));
            }
            let point = Position::new(mouse.column, mouse.row);
            if self.collection_drag.is_some()
                && matches!(
                    mouse.kind,
                    MouseEventKind::Drag(MouseButton::Left) | MouseEventKind::Up(MouseButton::Left)
                )
            {
                let state = self
                    .collection_drag
                    .as_ref()
                    .unwrap()
                    .control
                    .state()
                    .clone();
                let target = self.committed.as_ref().and_then(|frame| {
                    frame.items.iter().rev().find_map(|item| {
                        if !item.enabled || !item.rect.contains(point) {
                            return None;
                        }
                        match &item.on {
                            On::Collection(control) if state.same(control.state()) => {
                                Some(control.clone())
                            }
                            _ => None,
                        }
                    })
                });
                let drag = self.collection_drag.as_mut().unwrap();
                drag.moved |= drag.start != Some(point);
                drag.valid = target.is_some();
                if drag.moved {
                    match target {
                        Some(Control::Destination { group, .. }) => state.target(&group, ""),
                        Some(Control::Item { item, .. }) => {
                            if let Some(entry) =
                                state.visible().iter().find(|entry| entry.key == item)
                            {
                                state.target(&entry.group, &item);
                            }
                        }
                        _ => drag.valid = false,
                    }
                }
                if mouse.kind == MouseEventKind::Up(MouseButton::Left) {
                    let drag = self.collection_drag.take().unwrap();
                    return Some(Self::finish_collection(drag));
                }
                return Some(Outcome::handled(true));
            }
            if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                let (owner, control) =
                    self.committed
                        .as_ref()?
                        .items
                        .iter()
                        .rev()
                        .find_map(|item| {
                            if !item.enabled || !item.rect.contains(point) {
                                return None;
                            }
                            match &item.on {
                                On::Collection(control) => Some((item.id.clone(), control.clone())),
                                _ => None,
                            }
                        })?;
                if matches!(control, Control::Destination { .. }) {
                    return Some(Outcome::handled(true));
                }
                self.set_focus(owner);
                if let Control::Item {
                    state,
                    item,
                    commit,
                    ..
                } = &control
                {
                    if commit.is_some() {
                        state.begin(item);
                    }
                    self.collection_drag = Some(Drag {
                        control,
                        start: Some(point),
                        moved: false,
                        valid: true,
                    });
                }
                return Some(Outcome::handled(true));
            }
            return None;
        }
        let (_owner, control) = self.committed.as_ref()?.items.iter().find_map(|item| {
            if !item.enabled || Some(&item.id) != self.focus.as_ref() {
                return None;
            }
            match &item.on {
                On::Collection(control) => Some((item.id.clone(), control.clone())),
                _ => None,
            }
        })?;
        match &control {
            Control::Query { state, .. } => state.edit(event).map(Outcome::handled),
            Control::Item {
                state,
                item,
                select,
                commit,
            } => {
                let Event::Key(key) = event else {
                    return None;
                };
                if key.modifiers.intersects(
                    KeyModifiers::CONTROL
                        | KeyModifiers::ALT
                        | KeyModifiers::SUPER
                        | KeyModifiers::META,
                ) {
                    return None;
                }
                match key.code {
                    KeyCode::Enter => Some(if state.select(item) {
                        Outcome::emit(select.clone())
                    } else {
                        Outcome::handled(true)
                    }),
                    KeyCode::Char(' ') if commit.is_some() => {
                        state.begin(item);
                        self.collection_drag = Some(Drag {
                            control,
                            start: None,
                            moved: true,
                            valid: true,
                        });
                        Some(Outcome::handled(true))
                    }
                    _ => None,
                }
            }
            Control::Destination { .. } => None,
        }
    }
    fn finish_collection(drag: Drag<M>) -> Outcome<M> {
        let Control::Item {
            state,
            item,
            select,
            commit,
        } = drag.control
        else {
            return Outcome::handled(true);
        };
        if !drag.valid {
            state.cancel();
            return Outcome::handled(true);
        }
        if !drag.moved {
            state.cancel();
            return if state.select(&item) {
                Outcome::emit(select)
            } else {
                Outcome::handled(true)
            };
        }
        if let Some(commit) = commit
            && state.commit()
        {
            Outcome::emit(commit)
        } else {
            state.cancel();
            Outcome::handled(true)
        }
    }
}
