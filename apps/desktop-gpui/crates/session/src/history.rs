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

//! Back and forward through the tasks and pages one window showed.

use gpui_kit::SharedString;

use crate::SidebarPage;

/// How many places each direction remembers; older entries fall off.
const MAX_ENTRIES: usize = 100;

/// What the plate showed: a task, by session id, or a page.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Place {
    Task(SharedString),
    Page(SidebarPage),
}

/// The places a window showed before and after the current one, like a
/// browser's history: showing a task or a page by any means other than
/// Back or Forward pushes the place it replaces and forgets the forward
/// entries.
///
/// A task removed from the catalog is skipped when Back or Forward reaches
/// it, through the `listed` check the caller passes. It lives as long as
/// its window and is not saved.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SessionHistory {
    back: Vec<Place>,
    forward: Vec<Place>,
}

impl SessionHistory {
    pub fn new() -> Self {
        Self::default()
    }

    /// The window moved from `previous` to another place (or to none) by
    /// a choice other than Back or Forward.
    pub fn visit(&mut self, previous: Option<Place>) {
        if let Some(previous) = previous {
            push(&mut self.back, previous);
        }
        self.forward.clear();
    }

    pub fn can_go_back(&self) -> bool {
        !self.back.is_empty()
    }

    pub fn can_go_forward(&self) -> bool {
        !self.forward.is_empty()
    }

    /// The place to show for Back: the most recent earlier one that is
    /// still `listed`. `current` becomes the first forward entry. `None`,
    /// and no change, when there is nothing to go back to.
    pub fn back(
        &mut self,
        current: Option<Place>,
        listed: impl Fn(&Place) -> bool,
    ) -> Option<Place> {
        step(&mut self.back, &mut self.forward, current, listed)
    }

    /// The place to show for Forward; the mirror of [`Self::back`].
    pub fn forward(
        &mut self,
        current: Option<Place>,
        listed: impl Fn(&Place) -> bool,
    ) -> Option<Place> {
        step(&mut self.forward, &mut self.back, current, listed)
    }
}

fn push(stack: &mut Vec<Place>, place: Place) {
    if stack.last() == Some(&place) {
        return;
    }
    stack.push(place);
    if stack.len() > MAX_ENTRIES {
        stack.remove(0);
    }
}

/// Pops the first listed entry of `from`, dropping unlisted ones on the
/// way, and pushes `current` onto `to`.
fn step(
    from: &mut Vec<Place>,
    to: &mut Vec<Place>,
    current: Option<Place>,
    listed: impl Fn(&Place) -> bool,
) -> Option<Place> {
    while let Some(place) = from.pop() {
        if listed(&place) && current.as_ref() != Some(&place) {
            if let Some(current) = current {
                push(to, current);
            }
            return Some(place);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(value: &str) -> Option<Place> {
        Some(Place::Task(value.to_owned().into()))
    }

    fn page(page: SidebarPage) -> Option<Place> {
        Some(Place::Page(page))
    }

    fn any(_: &Place) -> bool {
        true
    }

    #[test]
    fn back_and_forward_walk_the_visited_places() {
        let mut history = SessionHistory::new();
        assert!(!history.can_go_back() && !history.can_go_forward());
        // s1 is shown first, then Extensions, then s3.
        history.visit(task("s1"));
        history.visit(page(SidebarPage::Extensions));
        assert_eq!(history.back(task("s3"), any), page(SidebarPage::Extensions));
        assert_eq!(history.back(page(SidebarPage::Extensions), any), task("s1"));
        assert!(!history.can_go_back());
        assert_eq!(history.back(task("s1"), any), None, "nothing further back");
        assert_eq!(history.forward(task("s1"), any), page(SidebarPage::Extensions));
        assert_eq!(history.forward(page(SidebarPage::Extensions), any), task("s3"));
        assert!(!history.can_go_forward());
    }

    #[test]
    fn a_new_choice_forgets_the_forward_entries() {
        let mut history = SessionHistory::new();
        history.visit(task("s1"));
        assert_eq!(history.back(task("s2"), any), task("s1"));
        assert!(history.can_go_forward());
        history.visit(task("s1"));
        assert!(!history.can_go_forward());
        assert_eq!(history.back(task("s3"), any), task("s1"));
    }

    #[test]
    fn removed_tasks_are_skipped_and_repeats_collapse() {
        let mut history = SessionHistory::new();
        history.visit(task("s1"));
        history.visit(task("gone"));
        history.visit(task("gone"));
        let listed = |place: &Place| place != &Place::Task("gone".into());
        assert_eq!(history.back(task("s2"), listed), task("s1"));
        assert!(!history.can_go_back(), "the removed task was dropped");
        // Leaving "no task" pushes nothing.
        let mut history = SessionHistory::new();
        history.visit(None);
        assert!(!history.can_go_back());
    }

    #[test]
    fn each_direction_keeps_a_bounded_number_of_entries() {
        let mut history = SessionHistory::new();
        for ix in 0..(MAX_ENTRIES + 10) {
            history.visit(task(&format!("s{ix}")));
        }
        let mut steps = 0;
        let mut current = task("last");
        while let Some(previous) = history.back(current.clone(), any) {
            current = Some(previous);
            steps += 1;
        }
        assert_eq!(steps, MAX_ENTRIES);
        assert_eq!(current, task("s10"), "the oldest entries fell off");
    }
}
