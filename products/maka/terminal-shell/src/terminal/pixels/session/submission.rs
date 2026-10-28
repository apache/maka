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
            let result = preparation.frame.submit();
            let mut state = presentation.state.lock().unwrap();
            match result {
                Ok(frame) => {
                    let gpu = preparation.pump_started.map(|_| frame.submission_timings());
                    let admitted = state.pixels.as_mut().unwrap().submitted(Candidate {
                        frame,
                        geometry,
                        pump_started: preparation.pump_started,
                    });
                    if !admitted && !state.quit && !presentation.stop.load(Ordering::Acquire) {
                        state
                            .error
                            .get_or_insert_with(|| "GPU submission lost its prepared frame".into());
                    }
                    if let (Some(gpu), Some(trace)) = (gpu, &mut state.trace) {
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
                            let sample = trace.record(
                                &token,
                                geometry,
                                "pump_until_submission",
                                start,
                                gpu.submit_finished,
                            );
                            sample.outcome = if admitted { "admitted" } else { "discarded" };
                        }
                    }
                }
                Err(error) => {
                    state.pixels.as_mut().unwrap().submission_failed(&token);
                    let cancelled = state.quit || presentation.stop.load(Ordering::Acquire);
                    if !cancelled {
                        state.error.get_or_insert_with(|| error.to_string());
                    }
                    if let (Some(start), Some(trace)) = (attempted, &mut state.trace) {
                        trace
                            .record(
                                &token,
                                geometry,
                                "gpu_submission_failed",
                                start,
                                Instant::now(),
                            )
                            .outcome = "error";
                        trace.discard(&token, geometry, if cancelled { "cancel" } else { "error" });
                    }
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
