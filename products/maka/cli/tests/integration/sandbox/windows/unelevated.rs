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
    os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr,
};
use windows_sys::Win32::{
    Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0},
    Security::*,
    System::Threading::*,
};

/// Run the installed backend with the Host user's identity but without its
/// administrator groups or privileges. Setup has already happened explicitly.
pub(super) fn verify(root: &Path, state: &Path, work: &Path) -> io::Result<()> {
    let mut original = ptr::null_mut();
    check(unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            &mut original,
        )
    })?;
    let original = unsafe { OwnedHandle::from_raw_handle(original) };
    let mut admin = [0u32; SECURITY_MAX_SID_SIZE as usize / 4];
    let mut length = size_of_val(&admin) as u32;
    check(unsafe {
        CreateWellKnownSid(
            WinBuiltinAdministratorsSid,
            ptr::null_mut(),
            admin.as_mut_ptr().cast(),
            &mut length,
        )
    })?;
    let disabled = SID_AND_ATTRIBUTES {
        Sid: admin.as_mut_ptr().cast(),
        Attributes: 0,
    };
    let mut restricted = ptr::null_mut();
    check(unsafe {
        CreateRestrictedToken(
            original.as_raw_handle(),
            DISABLE_MAX_PRIVILEGE,
            1,
            &disabled,
            0,
            ptr::null(),
            0,
            ptr::null(),
            &mut restricted,
        )
    })?;
    let restricted = unsafe { OwnedHandle::from_raw_handle(restricted) };
    // Elevated SSH tokens may default new objects to Administrators. Once that
    // group is disabled, the child needs a user-owned default DACL like an
    // ordinary interactive token, including access to its own process objects.
    let user = maka_event_log::root::windows::account_sid()?;
    let mut owner = ptr::null_mut();
    check(unsafe { Authorization::ConvertStringSidToSidW(wide(&user).as_ptr(), &mut owner) })?;
    let token_owner = TOKEN_OWNER { Owner: owner };
    let result = check(unsafe {
        SetTokenInformation(
            restricted.as_raw_handle(),
            TokenOwner,
            (&token_owner as *const TOKEN_OWNER).cast(),
            size_of::<TOKEN_OWNER>() as u32,
        )
    });
    unsafe {
        windows_sys::Win32::Foundation::LocalFree(owner);
    }
    result?;
    let security = wide(&format!("D:(A;;GA;;;{user})(A;;GA;;;SY)"));
    let mut descriptor = ptr::null_mut();
    check(unsafe {
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW(
            security.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    })?;
    let result = (|| {
        let (mut present, mut defaulted, mut acl) = (0, 0, ptr::null_mut());
        check(unsafe {
            GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)
        })?;
        let default = TOKEN_DEFAULT_DACL { DefaultDacl: acl };
        check(unsafe {
            SetTokenInformation(
                restricted.as_raw_handle(),
                TokenDefaultDacl,
                (&default as *const TOKEN_DEFAULT_DACL).cast(),
                size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )
        })
    })();
    unsafe {
        windows_sys::Win32::Foundation::LocalFree(descriptor);
    }
    result?;
    let mut impersonation = ptr::null_mut();
    check(unsafe {
        DuplicateToken(
            restricted.as_raw_handle(),
            SecurityImpersonation,
            &mut impersonation,
        )
    })?;
    let impersonation = unsafe { OwnedHandle::from_raw_handle(impersonation) };
    let mut member = 0;
    check(unsafe {
        CheckTokenMembership(
            impersonation.as_raw_handle(),
            admin.as_mut_ptr().cast(),
            &mut member,
        )
    })?;
    assert_eq!(
        member, 0,
        "acceptance Host token must not be an administrator"
    );
    let executable = crate::maka_executable();
    let mut command = wide(&format!(
        r#"maka sandbox run --root "{}" --policy "{}" --cwd "{}" --command "'accepted' | Set-Content unelevated""#,
        state.display(),
        root.join("policy.json").display(),
        work.display()
    ));
    let executable: Vec<_> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let system = std::env::var("SystemRoot").map_err(io::Error::other)?;
    let mut environment = Vec::new();
    for (name, value) in [
        ("SystemRoot", system),
        ("TEMP", work.to_string_lossy().into_owned()),
        ("TMP", work.to_string_lossy().into_owned()),
        (
            "USERPROFILE",
            maka_sandbox::account_home()?
                .to_string_lossy()
                .into_owned(),
        ),
    ] {
        environment.extend(wide(&format!("{name}={value}")));
    }
    environment.push(0);
    let cwd = wide(&root.to_string_lossy());
    let output_path = root.join("unelevated.log");
    let output = std::fs::File::create(&output_path)?;
    let input = std::fs::File::open("NUL")?;
    for file in [&output, &input] {
        check(unsafe {
            SetHandleInformation(
                file.as_raw_handle(),
                HANDLE_FLAG_INHERIT,
                HANDLE_FLAG_INHERIT,
            )
        })?;
    }
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        dwFlags: STARTF_USESTDHANDLES,
        hStdInput: input.as_raw_handle(),
        hStdOutput: output.as_raw_handle(),
        hStdError: output.as_raw_handle(),
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    let job = maka_sandbox::windows::ExecutionJob::create(uuid::Uuid::new_v4())?;
    check(unsafe {
        CreateProcessAsUserW(
            restricted.as_raw_handle(),
            executable.as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &startup,
            &mut process,
        )
    })?;
    let handle = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
    let thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    let result = (|| {
        for file in [&output, &input] {
            check(unsafe { SetHandleInformation(file.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) })?;
        }
        job.assign(handle.as_handle())?;
        if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        if unsafe { WaitForSingleObject(handle.as_raw_handle(), 30_000) } != WAIT_OBJECT_0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "unelevated sandbox did not exit",
            ));
        }
        let mut code = 0;
        check(unsafe { GetExitCodeProcess(handle.as_raw_handle(), &mut code) })?;
        if code != 0 {
            return Err(io::Error::other(format!(
                "unelevated CLI exited {code}: {}",
                std::fs::read_to_string(&output_path)?
            )));
        }
        assert_eq!(
            std::fs::read_to_string(work.join("unelevated"))?.trim(),
            "accepted"
        );
        Ok(())
    })();
    // Even failure before assignment must not leak a suspended acceptance child.
    if result.is_err() {
        unsafe {
            TerminateProcess(handle.as_raw_handle(), 130);
        }
    }
    drop(job);
    unsafe {
        WaitForSingleObject(handle.as_raw_handle(), 5_000);
    }
    result
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn check(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
