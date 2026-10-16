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

// Exercise the production Job accounting/settlement boundary independently of
// AppContainer child-admission policy. No alternate production launch path.
use super::*;
use std::collections::BTreeMap;
use std::fs::{OpenOptions, read, write};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

const FIXTURE: &str = "windows_launcher::job_tests::process_fixture";
const ROOT: &str = "MAKA_JOB_TEST_ROOT";
const ROLE: &str = "MAKA_JOB_TEST_ROLE";

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

#[test]
fn process_fixture() {
    let Ok(root) = std::env::var(ROOT) else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let role = std::env::var(ROLE).unwrap();
    if role == "descendant" {
        assert!(unsafe { child_process_is_in_job(GetCurrentProcess()) }.unwrap());
        write(root.join("admitted"), b"in-job").unwrap();
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join("writes"))
            .unwrap();
        loop {
            file.write_all(b"tick\n").unwrap();
            file.flush().unwrap();
            thread::sleep(Duration::from_millis(30));
        }
    }
    // This probe runs without AppContainer, so access-denied specifically
    // exercises the Job's refusal to permit breakaway, not lowbox admission.
    let breakaway = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", FIXTURE])
        .env(ROLE, "descendant")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(
            CREATE_NO_WINDOW | windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB,
        )
        .spawn();
    match breakaway {
        Err(error) => assert_eq!(error.raw_os_error(), Some(5)),
        Ok(mut escaped) => {
            let _ = escaped.kill();
            let _ = escaped.wait();
            panic!("fixture escaped its Job");
        }
    }
    // Null streams make the test independent of inherited-pipe EOF evidence.
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", FIXTURE, "--nocapture"])
        .env(ROLE, "descendant")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .unwrap();
    drop(child);
    await_file(&root.join("writes"));
    write(root.join("root-ready"), b"ready").unwrap();
    if role == "root-wait" {
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }
}

fn await_file(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while read(path).map_or(true, |bytes| bytes.is_empty()) {
        assert!(
            Instant::now() < deadline,
            "fixture did not publish {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn run_settlement_case(root_exits: bool) {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("maka-job-drain-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let executable = std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut command = quote_command(
        &executable,
        &["--exact".into(), FIXTURE.into(), "--nocapture".into()],
    );
    let mut env = BTreeMap::new();
    env.insert(ROOT.into(), root.to_string_lossy().into_owned());
    env.insert(
        ROLE.into(),
        if root_exits { "root-exit" } else { "root-wait" }.into(),
    );
    let environment = environment_block(&env);
    let job = Handle(unsafe { create_kill_on_close_job() }.unwrap());
    let mut size = 0;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
    assert!(size > 0);
    let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
    let attributes = storage.as_mut_ptr() as *mut c_void;
    assert_ne!(
        unsafe { InitializeProcThreadAttributeList(attributes, 1, 0, &mut size) },
        0
    );
    let mut job_value = job.0;
    let updated = unsafe {
        UpdateProcThreadAttribute(
            attributes,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            &mut job_value as *mut HANDLE as *const c_void,
            size_of::<HANDLE>(),
            null_mut(),
            null(),
        )
    };
    if updated == 0 {
        unsafe { DeleteProcThreadAttributeList(attributes) };
        panic!("{}", last_error("fixture atomic Job binding"));
    }
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attributes;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    let created = unsafe {
        CreateProcessW(
            wide(&executable).as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            environment.as_ptr() as *const c_void,
            wide(&root.to_string_lossy()).as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attributes) };
    assert_ne!(created, 0, "{}", last_error("fixture CreateProcessW"));
    let process_handle = Handle(process.hProcess);
    let _thread_handle = Handle(process.hThread);
    await_file(&root.join("root-ready"));
    assert_eq!(read(root.join("admitted")).unwrap(), b"in-job");
    assert!(unsafe { wait_for_empty_job(job.0, Duration::from_millis(30)) }.is_err());
    let result = if root_exits {
        assert_eq!(
            unsafe { WaitForSingleObject(process_handle.0, 5_000) },
            WAIT_OBJECT_0
        );
        Ok(unsafe { child_exit_code(process_handle.0) }.unwrap())
    } else {
        assert_eq!(
            unsafe { WaitForSingleObject(process_handle.0, 0) },
            WAIT_TIMEOUT
        );
        Err("injected cancellation".to_owned())
    };
    // Same settlement function as the AppContainer producer: successful root
    // exit cannot pass while its admitted descendant remains in the Job.
    let settled = unsafe { settle_job(result, job.0, process_handle.0) };
    assert!(
        matches!(settled, Err(LaunchFailure::Settled(_))),
        "{settled:?}"
    );
    unsafe { wait_for_empty_job(job.0, Duration::ZERO) }.unwrap();
    let before = read(root.join("writes")).unwrap();
    assert!(!before.is_empty());
    thread::sleep(Duration::from_millis(150));
    assert_eq!(read(root.join("writes")).unwrap(), before);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn root_exit_drains_an_admitted_descendant_with_closed_stdio() {
    run_settlement_case(true);
}

#[test]
fn cancellation_drains_an_admitted_descendant_with_closed_stdio() {
    run_settlement_case(false);
}
