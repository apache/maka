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

//! Where the sidebar shows: expanded beside the plate, collapsed (to a rail
//! of icons, or to nothing), or open over the plate. A state machine with
//! no GPUI; the workbench drives it from the window's width and the
//! person's commands, and draws what it says.

use settings::NarrowSidebar;

/// What the sidebar column beside the plate shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarForm {
    /// The whole sidebar, at its width.
    Expanded,
    /// A rail of its icons.
    Rail,
    /// Nothing; the plate takes the window.
    Hidden,
}

impl SidebarForm {
    /// What the sidebar collapses to under the preference `narrow`.
    pub fn collapsed(narrow: NarrowSidebar) -> Self {
        match narrow {
            NarrowSidebar::Hide => Self::Hidden,
            _ => Self::Rail,
        }
    }
}

/// Whether the sidebar is collapsed and why, whether the window is too
/// narrow for it beside the composer, and whether it lies over the plate.
///
/// A window narrowing past the breakpoint collapses the sidebar and one
/// widening past it expands it again, unless the person collapsed it
/// (the toggle, ⌘B): what they collapsed stays collapsed. The toggle
/// switches between expanded and collapsed while the window is wide;
/// while it is narrow the sidebar stays collapsed beside the plate and the
/// toggle opens the expanded sidebar over the plate, or closes it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SidebarLayout {
    collapsed: bool,
    /// The person collapsed it.
    by_person: bool,
    narrow: bool,
    overlay: bool,
}

impl SidebarLayout {
    /// The layout of a window as wide as `narrow` says, before anything
    /// else happened: collapsed when narrow.
    pub fn new(narrow: bool) -> Self {
        Self { collapsed: narrow, by_person: false, narrow, overlay: false }
    }

    /// What the column beside the plate shows, the sidebar collapsing to
    /// what `narrow` prefers.
    pub fn form(self, narrow: NarrowSidebar) -> SidebarForm {
        if self.collapsed { SidebarForm::collapsed(narrow) } else { SidebarForm::Expanded }
    }

    /// Whether the expanded sidebar shows, beside the plate or over it.
    pub fn expanded(self) -> bool {
        !self.collapsed || self.overlay
    }

    /// Whether the expanded sidebar lies over the plate.
    pub fn overlay(self) -> bool {
        self.overlay
    }

    /// Whether the window is too narrow for the expanded sidebar beside
    /// the composer.
    pub fn narrow(self) -> bool {
        self.narrow
    }

    /// The person's toggle (the button, ⌘B, the palette).
    pub fn toggle(&mut self) {
        if self.narrow && self.collapsed {
            self.overlay = !self.overlay;
            return;
        }
        self.collapsed = !self.collapsed;
        self.by_person = self.collapsed;
        self.overlay = false;
    }

    /// The person dragged the sidebar's edge past its narrowest width
    /// (`collapsed`) or out of the collapsed form. While the window is wide
    /// this is their toggle, so what they collapsed stays collapsed as the
    /// window widens; while it is narrow the sidebar stays collapsed beside
    /// the plate.
    pub fn set_collapsed_by_person(&mut self, collapsed: bool) {
        if !self.narrow && self.collapsed != collapsed {
            self.toggle();
        }
    }

    /// Closes the sidebar over the plate; `false` when it was not open.
    pub fn close_overlay(&mut self) -> bool {
        std::mem::take(&mut self.overlay)
    }

    /// The window's width crossed the breakpoint (`narrow` now).
    pub fn set_narrow(&mut self, narrow: bool) {
        if self.narrow == narrow {
            return;
        }
        self.narrow = narrow;
        self.overlay = false;
        if narrow {
            if !self.collapsed {
                self.collapsed = true;
                self.by_person = false;
            }
        } else if !self.by_person {
            self.collapsed = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ICONS: NarrowSidebar = NarrowSidebar::Icons;

    #[test]
    fn narrowing_collapses_and_widening_expands_unless_the_person_collapsed_it() {
        let mut layout = SidebarLayout::new(false);
        assert_eq!(layout.form(ICONS), SidebarForm::Expanded);
        layout.set_narrow(true);
        assert_eq!(layout.form(ICONS), SidebarForm::Rail);
        assert_eq!(layout.form(NarrowSidebar::Hide), SidebarForm::Hidden);
        layout.set_narrow(false);
        assert_eq!(layout.form(ICONS), SidebarForm::Expanded, "widening expands it");

        layout.toggle();
        assert_eq!(layout.form(ICONS), SidebarForm::Rail, "the person collapsed it");
        layout.set_narrow(true);
        layout.set_narrow(false);
        assert_eq!(layout.form(ICONS), SidebarForm::Rail, "widening leaves it collapsed");
        layout.toggle();
        assert_eq!(layout.form(ICONS), SidebarForm::Expanded);
        assert!(layout.expanded());

        let narrow = SidebarLayout::new(true);
        assert_eq!(narrow.form(ICONS), SidebarForm::Rail, "a narrow window starts collapsed");
        let mut narrow = narrow;
        narrow.set_narrow(false);
        assert_eq!(narrow.form(ICONS), SidebarForm::Expanded);
    }

    #[test]
    fn a_sidebar_collapsed_by_its_edge_stays_collapsed_as_the_window_widens() {
        let mut layout = SidebarLayout::new(false);
        layout.set_collapsed_by_person(true);
        assert_eq!(layout.form(ICONS), SidebarForm::Rail);
        layout.set_narrow(true);
        layout.set_narrow(false);
        assert_eq!(layout.form(ICONS), SidebarForm::Rail, "the person collapsed it");
        layout.set_collapsed_by_person(false);
        assert_eq!(layout.form(ICONS), SidebarForm::Expanded);
        layout.set_collapsed_by_person(false);
        assert_eq!(layout.form(ICONS), SidebarForm::Expanded, "expanded already");

        // While narrow the sidebar stays collapsed, and nothing opens over
        // the plate.
        layout.set_narrow(true);
        layout.set_collapsed_by_person(false);
        assert_eq!(layout.form(ICONS), SidebarForm::Rail);
        assert!(!layout.overlay());
    }

    #[test]
    fn while_narrow_the_toggle_opens_the_sidebar_over_the_plate() {
        let mut layout = SidebarLayout::new(true);
        assert!(!layout.expanded());
        layout.toggle();
        assert!(layout.overlay() && layout.expanded());
        assert_eq!(layout.form(ICONS), SidebarForm::Rail, "the rail stays under it");
        layout.toggle();
        assert!(!layout.overlay() && !layout.expanded(), "the toggle closes it");
        layout.toggle();
        assert!(layout.close_overlay());
        assert!(!layout.close_overlay(), "closed already");

        // Widening while it is open puts it beside the plate.
        layout.toggle();
        layout.set_narrow(false);
        assert!(!layout.overlay());
        assert_eq!(layout.form(ICONS), SidebarForm::Expanded);

        // Collapsed by the person and narrowed, it opens over the plate
        // and, closed, stays collapsed when the window widens.
        layout.toggle();
        layout.set_narrow(true);
        layout.toggle();
        assert!(layout.overlay());
        layout.close_overlay();
        layout.set_narrow(false);
        assert_eq!(layout.form(ICONS), SidebarForm::Rail);
    }
}
