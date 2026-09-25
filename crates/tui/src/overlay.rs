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
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{
    Frame,
    layout::{Alignment, Rect},
    style::Style,
    widgets::{Paragraph, Wrap},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Overlay {
    Shutdown,
    Consent,
    Confirm,
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
    Help,
}

impl Overlay {
    /// What an outside click or Esc asks of this layer.
    fn dismiss(self, app: &App) -> Action {
        use crate::pages::{
            attachments, branch, interactions, manage, onboarding, queue, recap, resume, revision,
            skills,
        };
        match self {
            Self::Shutdown => Action::CancelQuit,
            Self::Consent | Self::Confirm => app.apps.dismissal(),
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
            Self::Palette => Action::ClosePalette,
            Self::Help => Action::CloseHelp,
        }
    }
}

impl App {
    /// The top modal layer, if any: the first open one in priority order.
    pub(crate) fn overlay(&self) -> Option<Overlay> {
        use Overlay::*;
        [
            (Shutdown, self.shutdown.prompt.is_some()),
            (Consent, self.apps.consent_visible()),
            (Confirm, self.apps.confirm_visible()),
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
            (Help, self.help),
        ]
        .into_iter()
        .find_map(|(overlay, open)| open.then_some(overlay))
    }

    /// The kernel sheet presenting this overlay; none while its state is
    /// still being set up.
    fn overlay_sheet(&self, overlay: Overlay) -> Option<Sheet<Action>> {
        match overlay {
            Overlay::Shutdown => crate::shutdown::sheet(self),
            Overlay::Consent => crate::apps::consent_sheet(self),
            Overlay::Confirm => crate::apps::confirm_sheet(self),
            Overlay::Reference | Overlay::Management => crate::pages::manage::sheet(self),
            Overlay::QueueEdit => crate::pages::queue::edit::sheet(self),
            Overlay::Resume => crate::pages::resume::sheet(self),
            Overlay::Recap => crate::pages::recap::sheet(self),
            Overlay::Branch => crate::pages::branch::sheet(self),
            Overlay::Skills => crate::pages::skills::sheet(self),
            Overlay::Theme => crate::theme::editor::sheet(self),
            Overlay::Onboarding => crate::pages::onboarding::sheet(self),
            Overlay::Attachments => crate::pages::attachments::sheet(self),
            Overlay::Revision => crate::pages::revision::sheet(self),
            Overlay::Interactions => crate::pages::interactions::sheet(self),
            Overlay::Palette => crate::pages::commands::sheet(self),
            Overlay::Help => Some(crate::pages::help::sheet(self)),
        }
    }

    /// Commands that need their dialog on screen (approving terms, saving a
    /// change) read this gate, which only a presented sheet opens.
    fn present(&mut self, overlay: Overlay, shown: bool) {
        match overlay {
            Overlay::Consent => self.consent_presented(shown),
            Overlay::Reference | Overlay::Management => self.management.presented(shown),
            Overlay::Resume => self.resume.presented(shown),
            Overlay::Recap => self.recap.presented(shown),
            Overlay::Branch => self.branch.presented(shown),
            Overlay::Skills => {
                if let Some(dialog) = &mut self.skills.dialog {
                    dialog.visible = shown;
                }
            }
            Overlay::Theme => {
                if let Some(editor) = &mut self.theme.editor {
                    editor.visible = shown;
                }
            }
            Overlay::Onboarding => {
                if let Some(form) = &mut self.onboarding.dialog {
                    form.visible = shown;
                }
            }
            Overlay::Attachments => self.attachments.presented(shown),
            Overlay::Revision => self.revision.presented(shown),
            Overlay::Interactions => self.interactions.presented(shown),
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
        match self.overlay_sheet(overlay) {
            Some(sheet) => self.sheet_input(overlay, event, sheet.escape()),
            None => (false, None),
        }
    }

    fn sheet_input(
        &mut self,
        overlay: Overlay,
        event: Event,
        back: Option<Action>,
    ) -> (bool, Option<Action>) {
        let dismiss = overlay.dismiss(self);
        // The sheet's owner takes its fields' keys, pastes and pointer first,
        // unless a chooser is open over them.
        let owned = match overlay {
            _ if self.layer.captures() => None,
            Overlay::Reference | Overlay::Management => self.management_sheet_input(&event),
            Overlay::QueueEdit => self.queue_edit_sheet_input(&event),
            Overlay::Skills => self.skills_sheet_input(&event),
            Overlay::Theme => self.theme_sheet_input(&event),
            Overlay::Onboarding => self.onboarding_sheet_input(&event),
            Overlay::Attachments => self.attachment_sheet_input(&event),
            Overlay::Revision => self.revision_sheet_input(&event),
            Overlay::Interactions => self.interaction_sheet_input(&event),
            Overlay::Palette => self.palette_sheet_input(&event),
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
        let action = outcome.message.and_then(|action| {
            // A launcher closes as it launches.
            if overlay == Overlay::Palette {
                self.palette = None;
            }
            self.apply(action)
        });
        (outcome.redraw || action.is_some(), action)
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
        // The theme editor previews its colors on the page behind; the sheet
        // keeps the ones it opened with, so its controls stay readable.
        let colors = match (&app.theme.editor, overlay) {
            (Some(editor), Overlay::Theme) => editor.chrome,
            _ => app.theme.colors(),
        };
        let context = Context {
            colors,
            ascii: app.chrome.ascii,
            focused: true,
        };
        let shown = app.layer.render(frame, area, sheet, context);
        app.present(overlay, shown);
        match overlay {
            Overlay::Reference | Overlay::Management => pages::manage::draw_field(frame, app),
            Overlay::QueueEdit => pages::queue::edit::draw_field(frame, app),
            Overlay::Theme => crate::theme::editor::draw_field(frame, app),
            Overlay::Onboarding => pages::onboarding::draw_field(frame, app),
            Overlay::Attachments => pages::attachments::draw_field(frame, app),
            Overlay::Revision => pages::revision::draw_field(frame, app),
            Overlay::Interactions => pages::interactions::draw_field(frame, app),
            Overlay::Palette => pages::commands::draw_field(frame, app),
            _ => {}
        }
        app.layer.repaint_chooser(frame, context);
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
    // Nothing to present yet; no stale geometry stays clickable.
    app.layer.invalidate();
}
