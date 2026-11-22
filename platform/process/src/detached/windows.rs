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
    windows::{attributes::Attributes, checked, owned, pipe, try_wait_process, wait_process},
};
use std::{
    fs::{File, OpenOptions},
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, OwnedHandle},
    path::Path,
    process::ExitStatus,
    ptr,
};
use tokio::net::windows::named_pipe::NamedPipeServer;
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE_FLAG_INHERIT, SetHandleInformation,
    },
    System::Threading::*,
};

pub struct Child {
    process: OwnedHandle,
    pub stdin: Option<NamedPipeServer>,
}

impl Child {
    /// Signal only this owned process; the caller must still observe its exit.
    pub fn start_kill(&mut self) -> io::Result<()> {
        if self.try_wait()?.is_some() {
            return Ok(());
        }
        // SAFETY: the handle pins the exact spawned process, not a recycled PID.
        let result = unsafe { checked(TerminateProcess(self.process.as_raw_handle(), 1)) };
        if result.is_err() && self.try_wait()?.is_some() {
            return Ok(());
        }
        result
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        try_wait_process(&self.process)
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        drop(self.stdin.take());
        wait_process(&self.process).await
    }
}

pub async fn spawn(executable: &Path, args: &[&str], stderr: Option<File>) -> io::Result<Child> {
    if !executable.is_absolute() {
        return Err(io::Error::other("detached executable must be absolute"));
    }
    let path = executable
        .to_str()
        .ok_or_else(|| io::Error::other("executable must be UTF-8"))?;
    let application = wide(executable)?;
    let arguments = std::iter::once(path)
        .chain(args.iter().copied())
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let mut line = wide(Path::new(&arguments))?;
    let (stdin, reader) = pipe::pty_input().await?;
    let null = OpenOptions::new().read(true).write(true).open("NUL")?;
    // Duplicate rather than change inheritance on the caller's capture handle.
    let mut duplicate = ptr::null_mut();
    // SAFETY: the selected owned file and current process remain live through duplication.
    unsafe {
        checked(DuplicateHandle(
            GetCurrentProcess(),
            stderr.as_ref().unwrap_or(&null).as_raw_handle(),
            GetCurrentProcess(),
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        ))?;
    }
    let capture = owned(duplicate)?;
    let handles = [
        reader.as_raw_handle(),
        null.as_raw_handle(),
        capture.as_raw_handle(),
    ];
    // SAFETY: owned pipe/NUL handles, inherited only through the explicit list.
    for handle in handles {
        unsafe {
            checked(SetHandleInformation(
                handle,
                HANDLE_FLAG_INHERIT,
                HANDLE_FLAG_INHERIT,
            ))?;
        }
    }
    let mut attributes = Attributes::stdio(&handles, &[])?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes.as_ptr();
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: all buffers/handles outlive this call; environment and cwd inherit.
    // Breakaway denied by an enclosing Job is an error, never a coupled fallback.
    unsafe {
        checked(CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | DETACHED_PROCESS
                | CREATE_NEW_PROCESS_GROUP
                | CREATE_BREAKAWAY_FROM_JOB,
            ptr::null(),
            ptr::null(),
            &startup.StartupInfo,
            &mut process,
        ))?;
    }
    let process_handle = owned(process.hProcess)?;
    let _thread = owned(process.hThread)?;
    Ok(Child {
        process: process_handle,
        stdin: Some(stdin),
    })
}
