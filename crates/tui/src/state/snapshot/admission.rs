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

use super::Snapshot;
use crate::{
    app::{App, Focus, Notice},
    navigation::Navigation,
};

#[cfg(test)]
thread_local! { static CHECKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

impl Snapshot {
    fn candidate(app: &App, navigation: Option<(&Navigation, bool, Option<Focus>)>) -> Self {
        let mut snapshot = Self::capture(app, app.checkpoint_root());
        snapshot.apps.clear();
        if let Some((navigation, leaving, preserved)) = navigation {
            snapshot.navigation = navigation.clone();
            if let crate::navigation::Route::Session(id) = &navigation.location().route {
                if !snapshot.tabs.contains(id) {
                    snapshot.tabs.push(id.clone());
                }
                snapshot
                    .drafts
                    .entry(id.clone())
                    .or_insert_with(|| crate::editor::Editor::default().save());
            }
            snapshot.pages = app.saved_pages_at(navigation.location(), leaving, preserved);
        }
        snapshot
    }
}

impl App {
    #[cfg(test)]
    pub(crate) fn admission_checks() -> usize {
        CHECKS.get()
    }
    /// Reserve the existing maximum for each retained owner. This is computed
    /// only at admission boundaries; it is not a second stored budget.
    pub(crate) fn admit_state(
        &mut self,
        navigation: Option<(&Navigation, bool, Option<Focus>)>,
        extra_kept: usize,
    ) -> bool {
        #[cfg(test)]
        CHECKS.set(CHECKS.get() + 1);
        let kept = self.apps.kept_count() + extra_kept;
        let accepted = (|| {
            if kept > crate::navigation::tabs::LIMIT {
                return None;
            }
            let snapshot = Snapshot::candidate(self, navigation);
            let bytes = super::super::store::encode(&snapshot).ok()?.len();
            let reserved = kept * crate::apps::CHECKPOINT_MAX_BYTES + kept.saturating_sub(1);
            Some(super::super::store::fits(bytes.saturating_add(reserved)))
        })() == Some(true);
        if !accepted {
            self.notice = Some(Notice::Local("state-capacity"));
        } else if matches!(self.notice, Some(Notice::Local("state-capacity"))) {
            self.notice = None;
        }
        accepted
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod pages;
