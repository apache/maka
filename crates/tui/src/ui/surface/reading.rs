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

use super::Surface;

fn within(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

impl<M: Clone> Surface<M> {
    /// An embedded route owns its reading state even while another route uses
    /// the same region. Move that state into its existing instance surface.
    pub(crate) fn park_region<N: Clone>(&mut self, prefix: &str, owner: &mut Surface<N>) {
        owner.use_region(prefix);
        self.move_region_offsets(prefix, owner);
        owner.focus = self.focus.take_if(|path| within(path, prefix));
        if owner.focus.is_some() {
            // A fresh child's first control may follow a long text. Resolve
            // focus quietly so revealing that control cannot skip its beginning.
            self.start = Some(super::FocusStart {
                prefix: prefix.into(),
                reveal: false,
            });
        }
        owner.invalidate();
    }

    /// Consume parked state, preserving the outer viewport and other regions.
    pub(crate) fn restore_region<N: Clone>(&mut self, prefix: &str, owner: &mut Surface<N>) {
        if let Some(start) = self.start.as_mut().filter(|start| !start.reveal)
            && owner.reading_prefix.as_deref() == Some(start.prefix.as_str())
        {
            start.prefix = prefix.into();
        }
        owner.use_region(prefix);
        owner.move_region_offsets(prefix, self);
        if let Some(focus) = owner.focus.take_if(|path| within(path, prefix))
            && self.focus.is_none()
            && self.start.as_ref().map(|start| start.prefix.as_str()) == Some(prefix)
        {
            self.focus(focus);
            self.start = None;
        }
    }

    /// The same owner can move between native wrappers or into a standalone
    /// page. Its content-relative paths move with it; shell paths stay intact.
    pub(crate) fn use_region(&mut self, prefix: &str) {
        if self.reading_prefix.as_deref() == Some(prefix) {
            return;
        }
        let Some(previous) = self.reading_prefix.replace(prefix.into()) else {
            return;
        };
        let rebase = |path: &str| format!("{prefix}{}", &path[previous.len()..]);
        let offsets: Vec<_> = self
            .offsets
            .extract_if(|path, _| within(path, &previous))
            .map(|(path, offset)| (rebase(&path), offset))
            .collect();
        self.offsets.extend(offsets);
        let splits: Vec<_> = self
            .splits
            .0
            .extract_if(|path, _| within(path, &previous))
            .map(|(path, ratio)| (rebase(&path), ratio))
            .collect();
        self.splits.0.extend(splits);
        if let Some(focus) = self.focus.as_mut().filter(|path| within(path, &previous)) {
            *focus = rebase(focus);
        }
        if let Some(start) = self
            .start
            .as_mut()
            .filter(|start| within(&start.prefix, &previous))
        {
            start.prefix = rebase(&start.prefix);
        }
        for path in self
            .recent
            .iter_mut()
            .filter(|path| within(path, &previous))
        {
            *path = rebase(path);
        }
    }

    /// If a focused contribution disappeared, resume in its nearest remaining
    /// owner instead of waiting forever for an absent child prefix.
    pub(crate) fn retain_region_focus<'a>(&mut self, prefixes: impl Iterator<Item = &'a str>) {
        let Some(start) = self.start.as_mut().filter(|start| !start.reveal) else {
            return;
        };
        if let Some(prefix) = prefixes
            .filter(|prefix| within(&start.prefix, prefix))
            .max_by_key(|prefix| prefix.len())
        {
            start.prefix = prefix.into();
        } else {
            self.start = None;
        }
    }

    fn move_region_offsets<N>(&mut self, prefix: &str, destination: &mut Surface<N>) {
        destination
            .offsets
            .extend(self.offsets.extract_if(|path, _| within(path, prefix)));
        destination
            .splits
            .0
            .extend(self.splits.0.extract_if(|path, _| within(path, prefix)));
        destination
            .recent
            .extend(self.recent.extract_if(.., |path| within(path, prefix)));
        let excess = destination.recent.len().saturating_sub(16);
        destination.recent.drain(..excess);
    }
}
