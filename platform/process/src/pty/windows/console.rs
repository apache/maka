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

use maka_plugin_core::terminal::TerminalSize;
use std::{fs::File, io, os::windows::io::AsRawHandle};
use windows_sys::Win32::System::Console::*;

pub(crate) struct Console(pub HPCON);
impl Console {
    pub fn new(size: TerminalSize, input: &File, output: &File) -> io::Result<Self> {
        let mut handle = 0;
        // SAFETY: synchronous pipe peers are owned and live through creation.
        check(unsafe {
            CreatePseudoConsole(
                coord(size),
                input.as_raw_handle(),
                output.as_raw_handle(),
                0,
                &mut handle,
            )
        })?;
        Ok(Self(handle))
    }

    pub fn resize(&self, size: TerminalSize) -> io::Result<()> {
        // SAFETY: only the owning child can resize or consume this handle.
        check(unsafe { ResizePseudoConsole(self.0, coord(size)) })
    }
}

impl Drop for Console {
    fn drop(&mut self) {
        // Normal closure is on a blocking worker while the caller drains output.
        // Startup/Drop fallbacks disconnect output first.
        unsafe {
            ClosePseudoConsole(self.0);
        }
    }
}

fn coord(size: TerminalSize) -> COORD {
    COORD {
        X: size.cols() as i16,
        Y: size.rows() as i16,
    }
}

fn check(result: i32) -> io::Result<()> {
    if result < 0 {
        Err(io::Error::other(format!(
            "ConPTY HRESULT 0x{:08x}",
            result as u32
        )))
    } else {
        Ok(())
    }
}
