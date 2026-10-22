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

use std::io::{Read, Write};
use std::path::Path;
use std::ptr::null;
use std::sync::Arc;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent};

use crate::acl_ledger::LaunchFailure;
use crate::protocol::LaunchRequest;
use crate::windows_launcher::launch_appcontainer_settled;

// An event is waitable just like the owner process handle in the existing
// launcher. The reader retains its handle until EOF/cancellation, avoiding a
// close/reuse race if npm finishes before the control stream closes.
struct Cancellation(usize);
impl Drop for Cancellation {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0 as HANDLE) };
    }
}

pub fn run(request: &LaunchRequest, report_path: &Path) -> Result<u8, String> {
    request.validate()?;
    // Open the private report before starting any child. AppContainer receives
    // grants only to the runtime/staging roots, never this control directory.
    let mut report = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report_path)
        .map_err(|error| format!("create producer report: {error}"))?;
    let event = unsafe { CreateEventW(null(), 1, 0, null()) };
    if event.is_null() {
        return Err("create producer cancellation event failed".to_owned());
    }
    let event = Arc::new(Cancellation(event as usize));
    let reader_event = Arc::clone(&event);
    std::thread::spawn(move || {
        let mut byte = [0_u8];
        // EOF also signals owner death; no PID lookup or PID reuse window.
        let _ = std::io::stdin().read(&mut byte);
        unsafe { SetEvent(reader_event.0 as HANDLE) };
    });
    let result = launch_appcontainer_settled(request, Some(event.0 as HANDLE), true);
    let outcome = match result {
        Ok(code) => serde_json::json!({"settled": true, "exitCode": code, "failed": code != 0}),
        Err(LaunchFailure::Settled(message)) => {
            eprintln!("producer supervision failed: {message}");
            serde_json::json!({"settled": true, "exitCode": null, "failed": true})
        }
        Err(LaunchFailure::Unsettled(message)) => {
            eprintln!("producer supervision unsettled: {message}");
            serde_json::json!({"settled": false})
        }
    };
    // Detailed native/child output is not copied into the control contract.
    serde_json::to_writer(&mut report, &outcome).map_err(|error| error.to_string())?;
    report.flush().map_err(|error| error.to_string())?;
    Ok(0)
}

/// Real-platform negative probe, analogous to the launcher's existing boundary
/// probes. It is only meaningful when invoked inside the producer Job.
pub fn breakaway_probe() -> Result<u8, String> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, GetCurrentProcess,
    };
    let mut in_job = 0;
    if unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) } == 0
        || in_job == 0
    {
        return Err("breakaway probe must run inside a Job".to_owned());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let result = std::process::Command::new(executable)
        .arg("--self-probe")
        .creation_flags(CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW)
        .spawn();
    match result {
        Err(error) if error.raw_os_error() == Some(5) => {
            println!("{{\"breakawayDenied\":true}}");
            Ok(0)
        }
        Err(error) => Err(format!("unexpected breakaway probe failure: {error}")),
        Ok(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
            Err("producer escaped its Job".to_owned())
        }
    }
}
