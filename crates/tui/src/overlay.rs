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

//! Modal overlays. One priority order decides which layer is on top, so
//! drawing, input, dismissal and the shell's idle work cannot disagree about
//! it; every consumer matches the same enum exhaustively.
use crate::{
    app::{Action, App},
    ui::{Context, Sheet},
};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use ratatui::{
    Frame,
    layout::{Alignment, Position, Rect},
    style::Style,
    widgets::{Paragraph, Wrap},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Overlay {
    Shutdown,
    Consent,
    Theme,
    Skills,
    Attachments,
    /// Directory references rank above the session dialogs they serve.
    Reference,
    Revision,
    Recap,
    Resume,
    Branch,
    Onboarding,
    Management,
    Interactions,
    QueueEdit,
    Palette,
}

impl Overlay {
    /// What an outside click or Esc asks of this layer.
    fn dismiss(self) -> Option<Action> {
        use crate::pages::{
            attachments, branch, extensions, interactions, manage, onboarding, queue, recap,
            resume, revision, skills,
        };
        Some(match self {
            Self::Shutdown => Action::CancelQuit,
            Self::Consent => Action::Extension(extensions::Command::DismissConsent),
            Self::Theme => Action::Theme(crate::theme::editor::Command::Close),
            Self::Skills => Action::Skills(skills::Command::Close),
            Self::Attachments => Action::Attachment(attachments::Command::Close),
            Self::Reference | Self::Management => Action::Manage(manage::Command::Close),
            Self::Revision => Action::Revision(revision::Command::Close),
            Self::Recap => Action::Recap(recap::Command::Close),
            Self::Resume => Action::Resume(resume::Command::Close),
            Self::Branch => Action::Branch(branch::Command::Close),
            Self::Onboarding => Action::Onboard(onboarding::Command::Close),
            Self::Interactions => Action::Interaction(interactions::Command::Close),
            Self::QueueEdit => Action::Queue(queue::Command::Close),
            Self::Palette => return None,
        })
    }
}

impl App {
    /// The top modal layer, if any: the first open one in priority order.
    pub(crate) fn overlay(&self) -> Option<Overlay> {
        use Overlay::*;
        [
            (Shutdown, self.shutdown.prompt.is_some()),
            (Consent, self.extensions.consent_visible()),
            (Theme, self.theme.editor.is_some()),
            (Skills, self.skills.dialog.is_some()),
            (Attachments, self.attachments.dialog.is_some()),
            (Reference, self.directory_reference_active()),
            (Revision, self.revision.visible),
            (Recap, self.recap.visible),
            (Resume, self.resume.visible),
            (Branch, self.branch.visible),
            (Onboarding, self.onboarding.dialog.is_some()),
            (Management, self.management.dialog.is_some()),
            (Interactions, self.interactions.visible),
            (QueueEdit, self.queue.edit.is_some()),
            (Palette, self.palette.is_some()),
        ]
        .into_iter()
        .find_map(|(overlay, open)| open.then_some(overlay))
    }

    /// The kernel sheet presenting this overlay, for overlays migrated to it.
    fn overlay_sheet(&self, overlay: Overlay) -> Option<Sheet<Action>> {
        match overlay {
            Overlay::Shutdown => crate::shutdown::sheet(self),
            Overlay::Consent => crate::pages::extensions::consent_sheet(self),
            Overlay::Reference | Overlay::Management => crate::pages::manage::sheet(self),
            Overlay::QueueEdit => crate::pages::queue::edit::sheet(self),
            _ => None,
        }
    }

    /// Commands that need their dialog on screen (approving terms, saving a
    /// change) read this gate, which only a presented sheet opens.
    fn present(&mut self, overlay: Overlay, shown: bool) {
        match overlay {
            Overlay::Consent => self.consent_presented(shown),
            Overlay::Reference | Overlay::Management => self.management.presented(shown),
            _ => {}
        }
    }

    /// Every event except a resize belongs to the top layer; nothing beneath
    /// it sees a key or a pointer while it is open.
    pub(crate) fn overlay_input(
        &mut self,
        overlay: Overlay,
        event: Event,
    ) -> (bool, Option<Action>) {
        if let Some(sheet) = self.overlay_sheet(overlay) {
            return self.sheet_input(overlay, event, sheet.escape());
        }
        if overlay != Overlay::Shutdown
            && let Event::Mouse(mouse) = &event
            && mouse.kind == MouseEventKind::Down(MouseButton::Left)
            && self
                .modal_area
                .is_some_and(|area| !area.contains(Position::new(mouse.column, mouse.row)))
        {
            // Dismiss only the displayed overlay. Never forward this press to the page.
            if overlay == Overlay::Palette {
                self.palette = None;
            }
            self.hover = None;
            self.hover_area = None;
            self.hover_since = None;
            self.modal_area = None;
            self.hits.clear();
            return (
                true,
                overlay.dismiss().and_then(|action| self.apply(action)),
            );
        }
        match overlay {
            Overlay::Shutdown
            | Overlay::Consent
            | Overlay::Reference
            | Overlay::Management
            | Overlay::QueueEdit => unreachable!("presented as sheets"),
            Overlay::Theme => self.theme_input(event),
            Overlay::Skills => self.skills_input(event),
            Overlay::Attachments => self.attachment_input(event),
            Overlay::Revision => self.revision_input(event),
            Overlay::Recap => self.recap_input(event),
            Overlay::Resume => self.resume_input(event),
            Overlay::Branch => self.branch_input(event),
            Overlay::Onboarding => self.onboarding_input(event),
            Overlay::Interactions => self.interactions_overlay_input(event),
            Overlay::Palette => self.palette_input(event),
        }
    }

    fn sheet_input(
        &mut self,
        overlay: Overlay,
        event: Event,
        back: Option<Action>,
    ) -> (bool, Option<Action>) {
        let Some(dismiss) = overlay.dismiss() else {
            return (false, None);
        };
        // The sheet's owner takes its fields' keys, pastes and pointer first.
        let owned = match overlay {
            Overlay::Reference | Overlay::Management => self.management_sheet_input(&event),
            Overlay::QueueEdit => self.queue_edit_sheet_input(&event),
            _ => None,
        };
        if let Some(outcome) = owned {
            return outcome;
        }
        let outcome = self.layer.input(&event, dismiss, back);
        if !outcome.consumed {
            // Of the shell's chords only quitting reaches through a sheet,
            // and the quit prompt itself absorbs it.
            let quit = matches!(&event, Event::Key(key)
                if key.kind != KeyEventKind::Release
                    && key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('q'));
            return if quit && overlay != Overlay::Shutdown {
                (true, Some(Action::Quit))
            } else {
                (false, None)
            };
        }
        if matches!(event, Event::Mouse(_)) {
            // The page beneath keeps no pointer state while a sheet is up.
            self.hover = None;
            self.hover_area = None;
        }
        let action = outcome.message.and_then(|action| self.apply(action));
        (outcome.redraw || action.is_some(), action)
    }

    fn interactions_overlay_input(&mut self, event: Event) -> (bool, Option<Action>) {
        if let Event::Key(key) = &event
            && key.kind != KeyEventKind::Release
            && key.modifiers.contains(KeyModifiers::CONTROL)
            && key.code == KeyCode::Char('q')
        {
            return (true, Some(Action::Quit));
        }
        // A minimized/too-small terminal shows only a size warning, not the
        // choices. Never activate an invisible approval with a retained focus.
        if !self
            .frame_size
            .is_some_and(|(width, height)| width >= 30 && height >= 10)
        {
            if let Event::Key(key) = &event
                && key.kind != KeyEventKind::Release
                && key.code == KeyCode::Esc
            {
                return (true, Overlay::Interactions.dismiss());
            }
            return (false, None);
        }
        self.interaction_input(event)
    }
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    app: &mut App,
    overlay: Overlay,
    area: Rect,
    base: Style,
) {
    use crate::pages;
    // Open the gate while the sheet's buttons are computed, then keep it
    // only if the sheet actually fit on screen.
    app.present(overlay, true);
    if let Some(sheet) = app.overlay_sheet(overlay) {
        let context = Context {
            colors: app.theme.colors(),
            ascii: app.chrome.ascii,
            focused: true,
        };
        let shown = app.layer.render(frame, area, sheet, context);
        app.present(overlay, shown);
        match overlay {
            Overlay::Reference | Overlay::Management => pages::manage::draw_field(frame, app),
            Overlay::QueueEdit => pages::queue::edit::draw_field(frame, app),
            _ => {}
        }
        if !shown {
            crate::view::clear_overlay(frame, area);
            frame.render_widget(
                Paragraph::new(app.i18n.text("terminal-small"))
                    .alignment(Alignment::Center)
                    .wrap(Wrap { trim: false })
                    .style(base),
                area,
            );
        }
        return;
    }
    // A sub-view (a directory browser opened from a sheet) suspends the
    // sheet rather than closing it: returning focuses what opened it.
    app.layer.invalidate();
    match overlay {
        Overlay::Shutdown
        | Overlay::Consent
        | Overlay::Reference
        | Overlay::Management
        | Overlay::QueueEdit => unreachable!("presented as sheets"),
        Overlay::Theme => crate::theme::editor::draw(frame, app, area),
        Overlay::Skills => pages::skills::draw(frame, app, area, base),
        Overlay::Attachments => pages::attachments::draw(frame, app, area, base),
        Overlay::Revision => pages::revision::draw(frame, app, area, base),
        Overlay::Recap => pages::recap::draw(frame, app, area, base),
        Overlay::Resume => pages::resume::draw(frame, app, area, base),
        Overlay::Branch => pages::branch::draw(frame, app, area, base),
        Overlay::Onboarding => pages::onboarding::draw(frame, app, area, base),
        Overlay::Interactions => pages::interactions::draw(frame, app, area, base),
        Overlay::Palette => pages::commands::draw(frame, app, area, base),
    }
}
