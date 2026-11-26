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

use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
    sync::OnceLock,
};
use windows_sys::Win32::System::{
    JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    },
    Threading::GetCurrentProcess,
};

// Statics are not dropped by Rust at shutdown. The OS closes this handle when
// the Host exits, terminating descendants without killing the Host during Drop.
static OWNER: OnceLock<io::Result<OwnedHandle>> = OnceLock::new();

pub(super) fn detach_private_desktop_console() -> io::Result<bool> {
    use windows_sys::Win32::System::Console::{
        FreeConsole, GetConsoleProcessList, GetConsoleWindow,
    };

    // SAFETY: the process list has one writable slot. A larger count means
    // another process (such as the invoking shell) shares this console.
    unsafe {
        if GetConsoleWindow().is_null() {
            return Ok(false);
        }
        let mut process = 0;
        match GetConsoleProcessList(&mut process, 1) {
            0 => Err(io::Error::last_os_error()),
            1 if FreeConsole() == 0 => Err(io::Error::last_os_error()),
            1 => Ok(true),
            _ => Ok(false),
        }
    }
}

pub(super) fn own_process_tree() -> io::Result<()> {
    OWNER
        .get_or_init(create)
        .as_ref()
        .map(|_| ())
        .map_err(|error| io::Error::new(error.kind(), error.to_string()))
}

fn create() -> io::Result<OwnedHandle> {
    // SAFETY: an anonymous non-inheritable Job; every native argument is either
    // a live owned handle or correctly sized initialized input.
    unsafe {
        let handle = CreateJobObjectW(ptr::null(), ptr::null());
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = OwnedHandle::from_raw_handle(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // The Host job owns ordinary descendants. A task supervisor explicitly
        // requests breakaway to finish its original closure proof after Host loss.
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        if SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
            || AssignProcessToJobObject(job.as_raw_handle(), GetCurrentProcess()) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, Read, Write},
        os::windows::process::CommandExt,
        process::{Command, Stdio},
    };
    use windows_sys::Win32::{
        Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{
            CREATE_NO_WINDOW, OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            TerminateProcess, WaitForSingleObject,
        },
    };

    #[test]
    fn desktop_releases_only_its_private_console() {
        use windows_sys::Win32::System::{
            Console::GetConsoleWindow, Threading::CREATE_NEW_CONSOLE,
        };

        const ROLE: &str = "MAKA_TEST_DESKTOP_CONSOLE";
        let child = |role: &str, flags| {
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "windows::tests::desktop_releases_only_its_private_console",
                ])
                .env(ROLE, role)
                .creation_flags(flags)
                .status()
                .unwrap()
                .success()
        };
        match std::env::var(ROLE).as_deref() {
            Ok("private") => {
                assert!(child("shared", 0));
                assert!(detach_private_desktop_console().unwrap());
                assert!(unsafe { GetConsoleWindow() }.is_null());
            }
            Ok("shared") => {
                assert!(!detach_private_desktop_console().unwrap());
                assert!(!unsafe { GetConsoleWindow() }.is_null());
            }
            Ok("windowless") => assert!(!detach_private_desktop_console().unwrap()),
            _ => {
                assert!(child("private", CREATE_NEW_CONSOLE));
                assert!(child("windowless", CREATE_NO_WINDOW));
            }
        }
    }

    #[test]
    fn process_exit_reaps_descendants_without_changing_success_status() {
        const CHILD: &str = "MAKA_SERVICE_JOB_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            own_process_tree().unwrap();
            #[expect(
                clippy::zombie_processes,
                reason = "the descendant must outlive this process to verify Job cleanup"
            )]
            let child = Command::new("ping.exe")
                .args(["-n", "300", "127.0.0.1"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            println!("MAKA_JOB_PID={}", child.id());
            io::stdout().flush().unwrap();
            // The parent captures a handle before exit, so PID reuse cannot
            // turn the descendant cleanup assertion into a false success.
            io::stdin().read_exact(&mut [0]).unwrap();
            return;
        }
        let mut host = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "windows::tests::process_exit_reaps_descendants_without_changing_success_status",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = io::BufReader::new(host.stdout.take().unwrap());
        let pid = output
            .by_ref()
            .lines()
            .map(Result::unwrap)
            .find_map(|line| {
                line.split_once("MAKA_JOB_PID=")
                    .map(|(_, pid)| pid.parse::<u32>().unwrap())
            })
            .expect("child did not publish its descendant");
        // SAFETY: this is the exact test descendant, held through verification
        // and failure cleanup so a recycled PID can never be terminated.
        let descendant = unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid);
            assert!(!handle.is_null(), "{}", io::Error::last_os_error());
            OwnedHandle::from_raw_handle(handle)
        };
        assert_eq!(
            unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) },
            WAIT_TIMEOUT
        );
        host.stdin.take().unwrap().write_all(&[1]).unwrap();
        assert!(host.wait().unwrap().success());
        let ended = unsafe { WaitForSingleObject(descendant.as_raw_handle(), 5000) };
        if ended != WAIT_OBJECT_0 {
            // A failing cleanup test must not itself leave its process running.
            unsafe {
                TerminateProcess(descendant.as_raw_handle(), 1);
                WaitForSingleObject(descendant.as_raw_handle(), 5000);
            }
        }
        assert_eq!(ended, WAIT_OBJECT_0);
    }
}
