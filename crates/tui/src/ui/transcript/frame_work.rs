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

//! All readers in one shell frame share a finite measurement allowance.
use std::cell::Cell;

const WORK: usize = 32_768;
#[derive(Clone, Copy)]
struct Frame {
    id: u64,
    remaining: usize,
    active: bool,
}
thread_local! {
    static FRAME: Cell<Frame> = const { Cell::new(Frame { id: 0, remaining: WORK, active: false }) };
}

pub(crate) struct Guard(bool);
/// Nested public readers reuse the shell frame; standalone readers own a frame.
pub(crate) fn begin() -> Guard {
    FRAME.with(|frame| {
        let mut state = frame.get();
        if state.active {
            return Guard(false);
        }
        state.id = state.id.wrapping_add(1);
        state.remaining = WORK;
        state.active = true;
        frame.set(state);
        Guard(true)
    })
}
impl Drop for Guard {
    fn drop(&mut self) {
        if self.0 {
            FRAME.with(|frame| {
                frame.set(Frame {
                    active: false,
                    ..frame.get()
                })
            });
        }
    }
}
pub(super) fn id() -> u64 {
    FRAME.with(|frame| frame.get().id)
}
pub(super) fn allowance(minimum: usize) -> usize {
    FRAME.with(|frame| {
        let remaining = frame.get().remaining;
        if remaining < minimum {
            0
        } else {
            remaining.min(4096.max(minimum))
        }
    })
}
pub(super) fn charge(work: usize) {
    FRAME.with(|frame| {
        let state = frame.get();
        frame.set(Frame {
            remaining: state.remaining.saturating_sub(work),
            ..state
        });
    });
}
