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

//! Mounted read resources are independent of business drafts and submissions.
//! A local token fences every delivery to one route, node and registration.
mod project;
mod region;
mod runtime;
mod source;
pub(super) use region::{input, paint};

use super::{App, Key, io::transcript as transport};
use crate::ui::{self, ReaderEffect, transcript::Transcript};
use maka_plugins::terminal_ui::{transcript as wire, view::Node};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Readers {
    mounts: BTreeMap<(Key, String), Mounted>,
    pub copy: Option<String>,
    pub notice: Option<&'static str>,
}
struct Mounted {
    binding: transport::Mount,
    root: String,
    epoch: String,
    route: Value,
    source: source::Source,
    view: Transcript,
    dirty: bool,
    good: bool,
    failed: bool,
    failure: Option<transport::Failure>,
    paging: bool,
    pending: Option<(wire::Direction, Option<String>)>,
    edge: Option<wire::Direction>,
    cadence: ui::transcript::streaming::Cadence,
}
impl Readers {
    pub fn invalidate_interaction(&mut self) {
        for mount in self.mounts.values_mut() {
            mount.view.text_selection.invalidate_geometry();
            mount.view.invalidate_scrollbar();
            if let Some(search) = &mut mount.view.search {
                search.editor.invalidate_geometry();
            }
        }
    }
    pub fn token(&self, owner: &Key, path: &str) -> Option<Uuid> {
        self.mounts
            .get(&(owner.clone(), path.into()))
            .map(|mount| mount.binding.token)
    }
    pub fn refresh(&mut self, owner: &Key) {
        for ((key, _), mount) in &mut self.mounts {
            if key == owner {
                mount.view.text_selection.invalidate_geometry();
                mount.view.invalidate_scrollbar();
                mount.binding.token = Uuid::new_v4();
                mount.source = source::Source::default();
                mount.failed = false;
                mount.failure = None;
                mount.edge = None;
                mount.cadence.flush();
                mount.dirty = false;
                mount.paging = false;
                mount.pending = None;
            }
        }
    }
    fn enforce_budget(&mut self) {
        const MAX_BYTES: usize = 256 * 1024 * 1024;
        while self
            .mounts
            .values()
            .map(|mount| mount.source.bytes() + mount.view.retained_bytes())
            .sum::<usize>()
            > MAX_BYTES
        {
            let Some(mount) = self
                .mounts
                .values_mut()
                .max_by_key(|mount| mount.source.bytes() + mount.view.retained_bytes())
            else {
                break;
            };
            let reading = mount.view.take_reading();
            mount.view = Transcript::resume(reading);
            mount.source = source::Source::default();
            mount.failure = Some(transport::Failure::Overflow);
            mount.failed = true;
            mount.dirty = false;
            mount.good = false;
        }
    }
    fn effect(&mut self, token: Uuid, effect: ReaderEffect) {
        let Some(mount) = self
            .mounts
            .values_mut()
            .find(|mount| mount.binding.token == token)
        else {
            return;
        };
        match effect {
            ReaderEffect::Copy(text) => self.copy = Some(text),
            ReaderEffect::Error(key) => self.notice = Some(key),
            ReaderEffect::Refresh => {
                mount.view.text_selection.invalidate_geometry();
                mount.view.invalidate_scrollbar();
                mount.binding.token = Uuid::new_v4();
                mount.source = source::Source::default();
                mount.failed = false;
                mount.failure = None;
                mount.edge = None;
                mount.cadence.flush();
                mount.dirty = false;
                mount.paging = false;
                mount.pending = None;
            }
            ReaderEffect::Older | ReaderEffect::Newer | ReaderEffect::Latest
                if !mount.failed && !mount.paging =>
            {
                let (direction, cursor) = match effect {
                    ReaderEffect::Older => (
                        wire::Direction::Older,
                        mount.source.older().map(str::to_owned),
                    ),
                    ReaderEffect::Newer
                        if mount.source.unseen() > 0 && mount.source.newer().is_none() =>
                    {
                        (wire::Direction::Tail, None)
                    }
                    ReaderEffect::Newer => (
                        wire::Direction::Newer,
                        mount.source.newer().map(str::to_owned),
                    ),
                    _ => (wire::Direction::Tail, None),
                };
                if direction == wire::Direction::Tail || cursor.is_some() {
                    mount.source.set_following(
                        direction != wire::Direction::Older && mount.view.following(),
                    );
                    mount.pending = Some((direction, cursor));
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests;
