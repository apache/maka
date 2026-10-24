//! Negotiated composition packets stay on the terminal FIFO. Only this
//! native owner retains an editor target; the IO owner keeps wire state.

use super::super::Presentation;
use gpui::TextInputTarget;
use nsh_gpui_terminal::TerminalPlatform;
use std::collections::VecDeque;
use termina::{
    Event,
    escape::osc::{NshTextInput, Osc},
};

#[derive(Default)]
enum Phase {
    #[default]
    Unnegotiated,
    Enabled,
    Closing,
    Closed,
}

#[derive(Default)]
pub(in crate::terminal) struct Wire {
    phase: Phase,
    controls: VecDeque<u64>,
    acknowledgements: VecDeque<(u64, bool)>,
}

impl Wire {
    /// Closing still decodes stdin until the sender confirms that forwarding
    /// is disabled. Old composition and ordinary input never reach the shell.
    pub fn consume(&mut self, event: &Event) -> bool {
        if let Event::Osc(Osc::NshTextInput(NshTextInput::Focused(context))) = event
            && self
                .acknowledgements
                .front()
                .is_some_and(|(expected, _)| expected == context)
        {
            let (_, closing) = self.acknowledgements.pop_front().unwrap();
            if closing {
                self.phase = Phase::Closed;
            }
        }
        if matches!(self.phase, Phase::Closing | Phase::Closed) {
            return true;
        }
        matches!(
            event,
            Event::Osc(Osc::NshTextInput(
                NshTextInput::Query | NshTextInput::Focus(_)
            ))
        )
    }

    fn enable(&mut self) -> bool {
        if matches!(self.phase, Phase::Unnegotiated) {
            self.phase = Phase::Enabled;
            true
        } else {
            false
        }
    }

    fn enabled(&self) -> bool {
        matches!(self.phase, Phase::Enabled)
    }

    fn focus(&mut self, context: u64) {
        if self.enabled() {
            self.controls.push_back(context);
        }
    }

    pub fn take_control(&mut self) -> Option<Vec<u8>> {
        let context = self.controls.pop_front()?;
        self.acknowledgements.push_back((context, false));
        Some(encode(NshTextInput::Focus(context)))
    }

    pub fn begin_close(&mut self) -> Option<Vec<u8>> {
        if !self.enabled() {
            return None;
        }
        self.phase = Phase::Closing;
        self.controls.clear();
        Some(encode(NshTextInput::Focus(0)))
    }

    pub fn closed(&self) -> bool {
        matches!(self.phase, Phase::Closed)
    }

    pub fn release_submitted(&mut self) {
        self.acknowledgements.push_back((0, true));
    }
}

pub(in crate::terminal) fn query() -> Vec<u8> {
    encode(NshTextInput::Query)
}

fn encode(input: NshTextInput) -> Vec<u8> {
    Osc::NshTextInput(input).to_string().into_bytes()
}

pub(super) struct Owner {
    target: Option<TextInputTarget>,
    context: u64,
    acknowledged: bool,
}

impl Owner {
    pub fn new() -> Self {
        let bytes = *uuid::Uuid::new_v4().as_bytes();
        Self {
            target: None,
            context: u64::from_le_bytes(bytes[..8].try_into().unwrap()).max(1),
            acknowledged: false,
        }
    }

    fn changed(
        &mut self,
        target: Option<TextInputTarget>,
        presentation: &Presentation,
    ) -> Result<(), String> {
        self.context = self
            .context
            .checked_add(1)
            .ok_or("terminal text-input context exhausted")?;
        self.target = target;
        self.acknowledged = false;
        self.announce(presentation);
        Ok(())
    }

    fn announce(&self, presentation: &Presentation) {
        let mut state = presentation.state.lock().unwrap();
        if let Some(inbox) = &mut state.pixels {
            inbox.text_input.focus(if self.target.is_some() {
                self.context
            } else {
                0
            });
        }
        drop(state);
        presentation.wake_driver();
    }

    pub fn sync(
        &mut self,
        platform: &TerminalPlatform,
        presentation: &Presentation,
    ) -> Result<(), String> {
        let target = platform.text_input_target();
        if target != self.target {
            self.changed(target, presentation)?;
        }
        Ok(())
    }

    /// Cancel before native focus is disabled; clearing a mark never commits it.
    pub fn blur(
        &mut self,
        platform: &TerminalPlatform,
        presentation: &Presentation,
    ) -> Result<(), String> {
        if let Some(target) = &self.target {
            if platform.text_input_target().as_ref() == Some(target) {
                platform
                    .apply_composition(target, "", "", Some(0..0), false)
                    .map_err(|e| e.to_string())?;
            }
            self.changed(None, presentation)?;
        }
        Ok(())
    }

    pub fn handle(
        &mut self,
        packet: &NshTextInput,
        platform: &TerminalPlatform,
        presentation: &Presentation,
    ) -> Result<(), String> {
        // A preceding mouse/key/callback may have changed the real editor.
        self.sync(platform, presentation)?;
        match packet {
            NshTextInput::Supported => {
                let enabled = presentation
                    .state
                    .lock()
                    .unwrap()
                    .pixels
                    .as_mut()
                    .unwrap()
                    .text_input
                    .enable();
                if enabled {
                    self.announce(presentation);
                }
            }
            NshTextInput::Focused(context) => {
                let enabled = presentation
                    .state
                    .lock()
                    .unwrap()
                    .pixels
                    .as_ref()
                    .unwrap()
                    .text_input
                    .enabled();
                if enabled && self.target.is_some() && *context == self.context {
                    self.acknowledged = true;
                }
            }
            NshTextInput::Update {
                context,
                active,
                selection,
                commit,
                preedit,
            } if self.acknowledged && context.get() == self.context => {
                if let Some(target) = &self.target {
                    // The native API rechecks this target after a partial
                    // commit; never replay a packet whose prefix was applied.
                    platform
                        .apply_composition(
                            target,
                            commit,
                            preedit,
                            Some(selection.clone()),
                            *active,
                        )
                        .map_err(|e| e.to_string())?;
                    self.sync(platform, presentation)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
