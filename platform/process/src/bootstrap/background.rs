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

use crate::{
    shell::command::{quote, wide},
    windows::{checked, owned},
};
use std::{io, mem::size_of, path::Path, ptr};
use windows_sys::Win32::System::Threading::*;

/// Start a trusted one-shot helper without inherited handles, streams or a
/// console. The helper owns its recovery and lifetime; this is not a command
/// execution API. Redirecting stdio with std::process::Command is insufficient:
/// other inheritable pipe handles could otherwise keep the caller's EOF open.
pub fn background(executable: &Path, args: &[&str]) -> io::Result<()> {
    if !executable.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "helper executable must be absolute",
        ));
    }
    let path = executable
        .to_str()
        .ok_or_else(|| io::Error::other("helper executable must be UTF-8"))?;
    let application = wide(executable)?;
    let line = std::iter::once(path)
        .chain(args.iter().copied())
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let mut line = wide(Path::new(&line))?;
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        dwFlags: STARTF_USESTDHANDLES,
        // Invalid standard handles deliberately prevent implicit console or
        // redirected-stream inheritance. This helper has no interactive I/O.
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: initialized buffers outlive CreateProcessW; no handle inheritance.
    unsafe {
        checked(CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            CREATE_NO_WINDOW,
            ptr::null(),
            ptr::null(),
            &startup,
            &mut process,
        ))?;
    }
    let _process = owned(process.hProcess)?;
    let _thread = owned(process.hThread)?;
    Ok(())
}
