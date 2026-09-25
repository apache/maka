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

pub(in crate::apps) fn paint<M: Clone>(
    frame: &mut ratatui::Frame<'_>,
    readers: &mut Readers,
    surface: &mut ui::Surface<M>,
    context: ui::Context,
    i18n: &crate::i18n::I18n,
    motion: Option<std::time::Instant>,
) -> Option<std::time::Duration> {
    let mut wake = None;
    let now = std::time::Instant::now();
    for mount in readers.mounts.values_mut() {
        let Some(_area) = surface
            .transcript_area(mount.binding.token)
            .filter(|area| !area.is_empty())
        else {
            continue;
        };
        mount.view.motion(motion);
        mount.view.selection_scroll(now);
        let mut applied_edge = None;
        if mount.dirty && !mount.view.text_selection.dragging() && mount.cadence.wait(now).is_none()
        {
            let anchor = mount.view.first_visible();
            project::sync(
                &mount.source,
                &mut mount.view,
                i18n,
                mount.good && mount.edge.is_none(),
            );
            if anchor.as_ref().is_some_and(|key| !mount.view.contains(key)) {
                if mount.edge == Some(wire::Direction::Older) {
                    mount.view.latest();
                } else if mount.edge == Some(wire::Direction::Newer) {
                    mount.view.first();
                }
            }
            mount.dirty = false;
            mount.good = true;
            mount.cadence.rendered(now);
            applied_edge = mount.edge.take();
        }
        mount.view.unseen |= mount.source.unseen() > 0;
        if mount.failed
            || mount.source.phase() != source::Phase::Ready && mount.source.blocks().is_empty()
        {
            let label = if mount.failure == Some(transport::Failure::Stopped) {
                i18n.text("transcript-failed")
            } else if mount.failed {
                format!(
                    "{} · Ctrl+R {}",
                    i18n.text(
                        if mount.source.error() == Some(&source::Error::ResourceLimit)
                            || mount.failure == Some(transport::Failure::Overflow)
                        {
                            "transcript-buffer-full"
                        } else if mount.failure == Some(transport::Failure::Invalidated) {
                            "transcript-expired"
                        } else {
                            "transcript-failed"
                        }
                    ),
                    i18n.text("extensions-refresh")
                )
            } else {
                i18n.text("extensions-loading")
            };
            surface.transcript_notice(frame, mount.binding.token, &label, context.colors);
            if !mount.good {
                mount.view.text_selection.invalidate_geometry();
                mount.view.invalidate_scrollbar();
                continue;
            }
        }
        if surface
            .paint_transcript(frame, mount.binding.token, &mut mount.view, context, true)
            .is_err()
        {
            mount.failed = true;
        }
        if applied_edge == Some(wire::Direction::Older) {
            mount.view.pause();
        }
        let waits = [
            mount.view.motion_wait(),
            (mount.dirty && !mount.view.text_selection.dragging())
                .then(|| mount.cadence.wait(now))
                .flatten(),
            mount.view.selection_wait(now),
            mount
                .view
                .timing_visible()
                .then_some(std::time::Duration::from_secs(1)),
        ];
        for wait in waits.into_iter().flatten() {
            wake = Some(wake.map_or(wait, |previous: std::time::Duration| previous.min(wait)));
        }
    }
    readers.enforce_budget();
    wake
}

pub(in crate::apps) fn input<M: Clone>(
    readers: &mut Readers,
    surface: &mut ui::Surface<M>,
    event: &crossterm::event::Event,
    keyboard: bool,
    ascii: bool,
) -> Option<bool> {
    let mut effect = None;
    let mut consumed = None;
    for mount in readers.mounts.values_mut() {
        if surface.transcript_area(mount.binding.token).is_none() {
            continue;
        }
        let outcome =
            surface.transcript_input(mount.binding.token, &mut mount.view, event, keyboard, ascii);
        if outcome.consumed {
            consumed = Some(outcome.redraw);
            effect = outcome.message.map(|effect| (mount.binding.token, effect));
            break;
        }
    }
    if let Some((token, effect)) = effect {
        readers.effect(token, effect);
    }
    consumed
}
