//! Composition packets share the physical-input FIFO. Only the native owner
//! retains an editor admission; the IO owner negotiates one subscription.

use super::super::Presentation;
use gpui::TextInputTarget;
use nsh_gpui_terminal::TerminalPlatform;
use std::{collections::VecDeque, num::NonZeroU64};
use termina::{
    Event,
    escape::osc::{NshTextInput, Osc},
};

#[derive(Default)]
enum Phase {
    #[default]
    Unnegotiated,
    Enabling,
    Ready,
    Closing {
        submitted: bool,
    },
    Closed,
}

pub(in crate::terminal) struct Wire {
    nonce: NonZeroU64,
    phase: Phase,
    controls: VecDeque<NshTextInput>,
}

impl Default for Wire {
    fn default() -> Self {
        let bytes = *uuid::Uuid::new_v4().as_bytes();
        Self {
            nonce: NonZeroU64::new(u64::from_le_bytes(bytes[..8].try_into().unwrap()).max(1))
                .unwrap(),
            phase: Phase::default(),
            controls: VecDeque::new(),
        }
    }
}

impl Wire {
    /// Admission happens while reading the FIFO: a snapshot preceding ready(E)
    /// must not become admissible just because the UI drains it afterward.
    /// Closing continues decoding until disabled(E), consuming further input.
    pub fn consume(&mut self, event: &Event) -> bool {
        let Event::Osc(Osc::NshTextInput(packet)) = event else {
            return matches!(self.phase, Phase::Closing { .. } | Phase::Closed);
        };
        match packet {
            NshTextInput::Supported if matches!(self.phase, Phase::Unnegotiated) => {
                self.phase = Phase::Enabling;
                self.controls.push_back(NshTextInput::Enable(self.nonce));
            }
            NshTextInput::Ready(nonce)
                if *nonce == self.nonce && matches!(self.phase, Phase::Enabling) =>
            {
                self.phase = Phase::Ready;
            }
            NshTextInput::Disabled(nonce)
                if *nonce == self.nonce
                    && matches!(self.phase, Phase::Closing { submitted: true }) =>
            {
                self.phase = Phase::Closed;
            }
            NshTextInput::Update { .. } => return !self.ready(),
            _ => {}
        }
        true
    }

    fn ready(&self) -> bool {
        matches!(self.phase, Phase::Ready)
    }

    pub(super) fn ready_nonce(&self) -> Option<NonZeroU64> {
        self.ready().then_some(self.nonce)
    }

    fn cancel(&mut self, composition: NonZeroU64) {
        if self.ready() {
            self.controls.push_back(NshTextInput::Cancel(composition));
        }
    }

    pub fn take_control(&mut self) -> Option<Vec<u8>> {
        self.controls.pop_front().map(encode)
    }

    pub fn begin_close(&mut self) -> Option<Vec<u8>> {
        if !matches!(self.phase, Phase::Enabling | Phase::Ready) {
            return None;
        }
        self.phase = Phase::Closing { submitted: false };
        self.controls.clear();
        Some(encode(NshTextInput::Disable(self.nonce)))
    }

    pub fn closed(&self) -> bool {
        matches!(self.phase, Phase::Closed)
    }

    pub fn release_submitted(&mut self) {
        self.phase = Phase::Closing { submitted: true };
    }

    /// If blocked output prevented queuing disable(E), retain it before the
    /// final reset. This best-effort path does not imply an acknowledgement.
    pub fn pending_release(&self) -> Option<Vec<u8>> {
        matches!(self.phase, Phase::Closing { submitted: false })
            .then(|| encode(NshTextInput::Disable(self.nonce)))
    }
}

pub(in crate::terminal) fn query() -> Vec<u8> {
    encode(NshTextInput::Query)
}

fn encode(input: NshTextInput) -> Vec<u8> {
    Osc::NshTextInput(input).to_string().into_bytes()
}

struct Composition {
    id: NonZeroU64,
    target: TextInputTarget,
}

#[derive(Default)]
pub(super) struct Owner {
    high_water: u64,
    active: Option<Composition>,
}

impl Owner {
    pub fn new() -> Self {
        Self::default()
    }

    fn cancel_source(composition: NonZeroU64, presentation: &Presentation) {
        let mut state = presentation.state.lock().unwrap();
        if let Some(inbox) = &mut state.pixels {
            inbox.text_input.cancel(composition);
        }
        drop(state);
        presentation.wake_driver();
    }

    pub fn sync(
        &mut self,
        platform: &TerminalPlatform,
        presentation: &Presentation,
    ) -> Result<(), String> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| platform.text_input_target().as_ref() != Some(&active.target))
        {
            self.blur(platform, presentation)?;
        }
        Ok(())
    }

    /// Clear only the admitted editor's temporary mark, never committing it or
    /// touching another editor. A revoked native admission has already blurred.
    pub fn blur(
        &mut self,
        platform: &TerminalPlatform,
        presentation: &Presentation,
    ) -> Result<(), String> {
        if let Some(active) = self.active.take() {
            let result = if platform.text_input_target().as_ref() == Some(&active.target) {
                platform
                    .apply_composition(&active.target, "", "", Some(0..0), false)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            } else {
                Ok(())
            };
            Self::cancel_source(active.id, presentation);
            result?;
        }
        Ok(())
    }

    pub fn handle(
        &mut self,
        packet: &NshTextInput,
        platform: &TerminalPlatform,
        presentation: &Presentation,
    ) -> Result<(), String> {
        // A preceding mouse/key/callback may have revoked the editor admission.
        self.sync(platform, presentation)?;
        let NshTextInput::Update {
            composition,
            active,
            selection,
            commit,
            preedit,
        } = packet
        else {
            return Ok(());
        };
        if !presentation
            .state
            .lock()
            .unwrap()
            .pixels
            .as_ref()
            .is_some_and(|inbox| inbox.text_input.ready())
        {
            return Ok(());
        }
        if composition.get() > self.high_water {
            self.blur(platform, presentation)?;
            self.high_water = composition.get();
            // Cancel callbacks may change focus; bind the new source lifetime
            // only once to the actual admission after those callbacks.
            let Some(target) = platform.text_input_target() else {
                Self::cancel_source(*composition, presentation);
                return Ok(());
            };
            self.active = Some(Composition {
                id: *composition,
                target,
            });
        }
        let Some(current) = self
            .active
            .as_ref()
            .filter(|current| current.id == *composition)
        else {
            return Ok(());
        };
        // The native API rechecks admission after a committed prefix. Never
        // retry a packet whose prefix may already have been applied.
        let applied = platform
            .apply_composition(
                &current.target,
                commit,
                preedit,
                Some(selection.clone()),
                *active,
            )
            .map_err(|e| e.to_string())?;
        if !applied {
            self.blur(platform, presentation)?;
        } else if !*active {
            self.active = None;
        } else {
            self.sync(platform, presentation)?;
        }
        Ok(())
    }
}
