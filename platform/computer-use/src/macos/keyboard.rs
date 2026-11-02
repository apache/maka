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

//! The Raw app keyboard path; event construction remains in Cua.

pub(super) mod aliases;

use super::focus::Resource;
use crate::NativeMonitorPermit;
use maka_agent_facts::tools::ToolError;
use platform_macos::input::{
    native_keyboard::{
        NativeKeyPair, NativeKeyPress, NativeKeyboardError, NativeKeyboardLayout,
        NativeKeyboardSource, prepare_press_keys, prepare_text_from_layout,
    },
    native_move::{FocusActivationWindow, PreparedNativeEvent},
};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub(crate) enum Input {
    PressKey(String),
    TypeText(String),
}

impl std::fmt::Debug for Input {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::PressKey(_) => "PressKey([redacted])",
            Self::TypeText(_) => "TypeText([redacted])",
        })
    }
}

pub(super) enum Preparation {
    Finished,
    NeedLayout(PendingText),
}

/// This entire value stays on the Controller's CF owner across the metadata hop.
pub(super) struct PendingText {
    source: NativeKeyboardSource,
    text: String,
    gap: Duration,
    focus: Arc<Resource>,
    cancellation: CancellationToken,
    permit: Option<Box<dyn NativeMonitorPermit>>,
}

impl PendingText {
    pub(super) fn uses_resource(&self, resource: &Arc<Resource>) -> bool {
        Arc::ptr_eq(&self.focus, resource)
    }

    pub(super) fn finish(
        mut self,
        pid: i32,
        layout: Option<NativeKeyboardLayout>,
    ) -> Result<(), ToolError> {
        let result = (|| {
            check_admission(&self.focus, &self.cancellation)?;
            let layout = layout.ok_or_else(|| {
                aliases::SynthesizedEventError::FailedToTranslateKeyCodes.into_tool_error()
            })?;
            let pairs = prepare_text_from_layout(&self.source, &self.text, &layout)
                .map_err(native_error)?;
            send_pairs(pid, Some(self.gap), pairs, &self.focus, &self.cancellation)
        })();
        let permit = self
            .permit
            .take()
            .expect("keyboard preparation owns one permit");
        drop(self);
        settle(permit, &result);
        result
    }

    pub(super) fn cancel(mut self) {
        // No key plan has been dispatched. Releasing this source is the actual
        // terminal result of the fixed preparation; the action's refusal is
        // returned separately, without poisoning the persistent monitor gate.
        let permit = self
            .permit
            .take()
            .expect("keyboard preparation owns one permit");
        drop(self);
        permit.complete(Ok(()));
    }
}

pub(super) fn begin(
    pid: i32,
    bundle: Option<&str>,
    input: Input,
    focus: Arc<Resource>,
    cancellation: CancellationToken,
    window: impl FnOnce() -> Option<FocusActivationWindow>,
) -> Result<Preparation, ToolError> {
    let mut permit = Some(focus.input_permit()?);
    let result = (|| {
        check_admission(&focus, &cancellation)?;
        focus.enforce_with_window(window)?;
        match input {
            Input::PressKey(text) => {
                let presses = aliases::parse_keys(&text)?
                    .into_iter()
                    .map(|press| NativeKeyPress {
                        key_code: press.key_code,
                        modifiers: press.modifiers,
                        characters: None,
                    })
                    .collect::<Vec<_>>();
                let pairs = prepare_press_keys(&presses).map_err(native_error)?;
                send_pairs(pid, None, pairs, &focus, &cancellation)?;
                Ok(Preparation::Finished)
            }
            Input::TypeText(text) => {
                // Create HID state before requesting the main-thread layout snapshot.
                let source = NativeKeyboardSource::new().map_err(native_error)?;
                let gap = if bundle == Some("com.apple.ScreenContinuity") {
                    Duration::from_micros(250)
                } else {
                    Duration::from_millis(5)
                };
                Ok(Preparation::NeedLayout(PendingText {
                    source,
                    text,
                    gap,
                    focus,
                    cancellation,
                    permit: permit.take(),
                }))
            }
        }
    })();
    if let Some(permit) = permit {
        let terminal = result.as_ref().map(|_| ()).map_err(Clone::clone);
        settle(permit, &terminal);
    }
    result
}

fn settle(permit: Box<dyn NativeMonitorPermit>, result: &Result<(), ToolError>) {
    // Key syntax/layout refusals belong to the action result. Only unresolved
    // native cleanup fails the persistent monitor lifetime.
    let terminal = match result {
        Err(error @ ToolError::CleanupUnconfirmed(_)) => Err(error.clone()),
        _ => Ok(()),
    };
    permit.complete(terminal);
}

fn send_pairs(
    pid: i32,
    gap: Option<Duration>,
    pairs: Vec<NativeKeyPair>,
    focus: &Resource,
    cancellation: &CancellationToken,
) -> Result<(), ToolError> {
    let mut sender = Sender {
        pid,
        gap,
        posted: false,
    };
    for pair in pairs {
        if let Err(error) = check_admission(focus, cancellation) {
            return Err(if sender.posted { unknown(error) } else { error });
        }
        sender.pair(pair)?;
    }
    Ok(())
}

fn native_error(error: NativeKeyboardError) -> ToolError {
    let failure = match error {
        NativeKeyboardError::EventSourceUnavailable => {
            aliases::SynthesizedEventError::FailedToCreateSource
        }
        NativeKeyboardError::EventUnavailable => aliases::SynthesizedEventError::InvalidParameter,
        NativeKeyboardError::InputSourceUnavailable
        | NativeKeyboardError::LayoutUnavailable
        | NativeKeyboardError::LayoutBytesUnavailable => {
            aliases::SynthesizedEventError::FailedToTranslateKeyCodes
        }
        other => return failed(other),
    };
    failure.into_tool_error()
}

struct Sender {
    pid: i32,
    gap: Option<Duration>,
    posted: bool,
}

impl Sender {
    fn post(&mut self, event: PreparedNativeEvent) -> Result<(), ToolError> {
        event.timestamp_and_post(self.pid).map_err(|error| {
            if self.posted {
                unknown(error)
            } else {
                failed(error)
            }
        })?;
        self.posted = true;
        // The optional delay applies after every event, including the
        // final flags-restore event. Raw pressKey supplies no delay.
        if let Some(gap) = self.gap {
            std::thread::sleep(gap);
        }
        Ok(())
    }

    fn pair(&mut self, pair: NativeKeyPair) -> Result<(), ToolError> {
        let NativeKeyPair { down, up } = pair;
        let mut down_posted = 0;
        let mut primary = None;
        for event in down {
            match self.post(event) {
                Ok(()) => down_posted += 1,
                Err(error) => {
                    primary = Some(error);
                    break;
                }
            }
        }
        // A pair contains flagsChanged then keyDown. If only flagsChanged
        // posted, restore those flags without inventing a keyUp witness.
        let skip_up = usize::from(down_posted < 2);
        let mut cleanup = Vec::new();
        if down_posted != 0 {
            for event in up.into_iter().skip(skip_up) {
                if let Err(error) = self.post(event) {
                    cleanup.push(error.to_string());
                }
            }
        }
        if !cleanup.is_empty() {
            let detail = cleanup.join("; ");
            return Err(ToolError::CleanupUnconfirmed(match primary {
                Some(error) => format!("{error}; native keyboard release: {detail}"),
                None => format!("native keyboard release: {detail}"),
            }));
        }
        match primary {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn check_admission(focus: &Resource, cancellation: &CancellationToken) -> Result<(), ToolError> {
    if cancellation.is_cancelled() || focus.is_sealed() {
        Err(failed(
            "Computer Use cancelled before native keyboard dispatch",
        ))
    } else {
        Ok(())
    }
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
fn unknown(error: impl std::fmt::Display) -> ToolError {
    ToolError::OutcomeUnknown(error.to_string())
}
