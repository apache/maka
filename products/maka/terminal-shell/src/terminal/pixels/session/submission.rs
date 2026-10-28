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

use super::super::{super::Presentation, input::Candidate};
use std::{sync::atomic::Ordering, time::Instant};

pub(super) fn submit_pending(
    presentation: &Presentation,
    background: &gpui::BackgroundExecutor,
) -> bool {
    let preparation = {
        let mut state = presentation.state.lock().unwrap();
        if state.quit || state.error.is_some() || presentation.stop.load(Ordering::Acquire) {
            return false;
        }
        let Some(preparation) = state.pixels.as_mut().unwrap().take_preparation() else {
            return false;
        };
        preparation
    };
    let presentation = presentation.clone();
    background
        .spawn(async move {
            let token = preparation.frame.token();
            let geometry = preparation.geometry;
            let attempted = preparation.pump_started.map(|_| Instant::now());
            let submitted = preparation.frame.submit();
            let gpu = submitted
                .as_ref()
                .ok()
                .and_then(|frame| preparation.pump_started.map(|_| frame.submission_timings()));
            let mut readback = None;
            let result = submitted.and_then(|frame| {
                let started = preparation.pump_started.map(|_| Instant::now());
                let result = frame.complete();
                readback = started.map(|start| (start, Instant::now()));
                result
            });
            let pixels = result.as_ref().ok().and_then(|frame| {
                preparation
                    .pump_started
                    .map(|_| (frame.pixels().len(), frame.size()))
            });
            let failed = result.is_err();
            let mut state = presentation.state.lock().unwrap();
            let cancelled = state.quit || presentation.stop.load(Ordering::Acquire);
            // A device or readback failure remains session-wide after resize.
            if let Err(error) = &result
                && !cancelled
            {
                state.error.get_or_insert_with(|| format!("{error:#}"));
            }
            let current = !cancelled
                && state.error.is_none()
                && state.pixels.as_ref().unwrap().geometry == geometry;
            let admitted = match result {
                Ok(frame) if current => {
                    let admitted = state
                        .pixels
                        .as_mut()
                        .unwrap()
                        .rendered(Candidate { frame, geometry });
                    if !admitted {
                        state
                            .error
                            .get_or_insert_with(|| "GPU readback lost its prepared frame".into());
                    }
                    admitted
                }
                _ => {
                    state.pixels.as_mut().unwrap().rendering_finished(&token);
                    false
                }
            };
            let disposition = if failed || state.error.is_some() {
                Some("error")
            } else if cancelled {
                Some("cancel")
            } else if !admitted {
                Some("resize")
            } else {
                None
            };
            if let Some(trace) = &mut state.trace {
                if let Some(gpu) = gpu {
                    for (stage, started, finished) in [
                        ("gpu_prepare", gpu.prepare_started, gpu.encode_started),
                        ("gpu_encode", gpu.encode_started, gpu.encode_finished),
                        (
                            "gpu_submission_queue",
                            gpu.encode_finished,
                            gpu.submit_started,
                        ),
                        ("gpu_submit", gpu.submit_started, gpu.submit_finished),
                        ("gpu_map_request", gpu.submit_finished, gpu.map_requested),
                    ] {
                        trace.record(&token, geometry, stage, started, finished);
                    }
                    if let Some(start) = preparation.pump_started {
                        trace.record(
                            &token,
                            geometry,
                            "native_before_gpu",
                            start,
                            gpu.prepare_started,
                        );
                        trace
                            .record(
                                &token,
                                geometry,
                                "pump_until_submission",
                                start,
                                gpu.submit_finished,
                            )
                            .outcome = if admitted { "admitted" } else { "discarded" };
                    }
                } else if let Some(start) = attempted {
                    trace
                        .record(
                            &token,
                            geometry,
                            "gpu_submission_failed",
                            start,
                            Instant::now(),
                        )
                        .outcome = "error";
                }
                if let Some((start, end)) = readback {
                    let sample = trace.record(&token, geometry, "readback", start, end);
                    sample.bytes = pixels.map(|(bytes, _)| bytes);
                    sample.outcome = if failed {
                        "error"
                    } else if !admitted {
                        "discarded"
                    } else {
                        "ok"
                    };
                    if let (Some(start), Some((bytes, size))) = (preparation.pump_started, pixels) {
                        let sample =
                            trace.record(&token, geometry, "pump_until_candidate", start, end);
                        sample.bytes = Some(bytes);
                        sample.pixel_size = Some((size.width.0, size.height.0));
                        sample.outcome = if admitted { "admitted" } else { "discarded" };
                    }
                }
                if let Some(outcome) = disposition {
                    trace.discard(&token, geometry, outcome);
                }
            }
            if let Some(wake) = &state.pixels.as_ref().unwrap().wake {
                wake.unpark();
            }
            drop(state);
            presentation.wake_driver();
        })
        .detach();
    true
}
