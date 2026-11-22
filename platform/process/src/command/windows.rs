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

use super::Prepared;
use crate::shell::command::{quote, wide};
use std::{
    collections::BTreeMap,
    io,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsHandle, AsRawHandle},
    },
    path::Path,
    ptr,
};
use windows_sys::Win32::System::Threading::*;

struct Buffers {
    pub executable: Vec<u16>,
    pub cwd: Vec<u16>,
    pub line: Vec<u16>,
    pub environment: Vec<u16>,
}
impl Prepared {
    fn windows(&self) -> io::Result<Buffers> {
        let plan = &self.0;
        if !plan.executable.is_absolute() || !plan.cwd.is_absolute() {
            return Err(io::Error::other(
                "process requires captured absolute executable and cwd",
            ));
        }
        let executable = wide(dunce::simplified(&plan.executable))?;
        let cwd = wide(dunce::simplified(plan.cwd.captured()))?;
        let executable_arg = dunce::simplified(&plan.executable)
            .to_str()
            .map(|path| quote(&path.replace('/', "\\")))
            .ok_or_else(|| io::Error::other("process executable must be UTF-8"))?;
        let arguments = std::iter::once(Ok(executable_arg))
            .chain(plan.args.iter().map(super::Argument::command_line))
            .collect::<io::Result<Vec<_>>>()?
            .join(" ");
        let line = wide(Path::new(&arguments))?;
        let mut sorted = BTreeMap::new();
        for (key, value) in &plan.environment {
            if key.is_empty()
                || key.encode_wide().any(|c| c == 0)
                || value.encode_wide().any(|c| c == 0)
            {
                return Err(io::Error::other("invalid process environment"));
            }
            sorted.insert(key.to_string_lossy().to_uppercase(), (key, value));
        }
        let mut environment = Vec::new();
        for (key, value) in sorted.into_values() {
            environment.extend(key.encode_wide());
            environment.push('=' as u16);
            environment.extend(value.encode_wide());
            environment.push(0);
        }
        if environment.is_empty() {
            environment.push(0);
        }
        environment.push(0);
        Ok(Buffers {
            executable,
            cwd,
            line,
            environment,
        })
    }

    pub(crate) fn windows_command_line(&self) -> io::Result<std::ffi::OsString> {
        let buffers = self.windows()?;
        Ok(std::ffi::OsString::from_wide(
            &buffers.line[..buffers.line.len() - 1],
        ))
    }

    /// # Safety
    /// Startup attributes and any inherited handles must remain valid for this
    /// call. A Job-list attribute must establish ownership before user code runs.
    pub(crate) unsafe fn spawn_windows(
        &self,
        startup: &STARTUPINFOEXW,
        inherit: bool,
        flags: u32,
    ) -> io::Result<PROCESS_INFORMATION> {
        let mut buffers = self.windows()?;
        let mut process = PROCESS_INFORMATION::default();
        let flags = flags | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
        let result = unsafe {
            match &self.0.write_token {
                Some(token) => CreateProcessAsUserW(
                    token.as_handle().as_raw_handle(),
                    buffers.executable.as_ptr(),
                    buffers.line.as_mut_ptr(),
                    ptr::null(),
                    ptr::null(),
                    inherit.into(),
                    flags,
                    buffers.environment.as_ptr().cast(),
                    buffers.cwd.as_ptr(),
                    &startup.StartupInfo,
                    &mut process,
                ),
                None => CreateProcessW(
                    buffers.executable.as_ptr(),
                    buffers.line.as_mut_ptr(),
                    ptr::null(),
                    ptr::null(),
                    inherit.into(),
                    flags,
                    buffers.environment.as_ptr().cast(),
                    buffers.cwd.as_ptr(),
                    &startup.StartupInfo,
                    &mut process,
                ),
            }
        };
        // A failed restricted launch is final, never retried with CreateProcessW.
        crate::windows::checked(result)?;
        Ok(process)
    }
}
