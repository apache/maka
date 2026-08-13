use std::ffi::{OsStr, c_void};
use std::iter;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Security::{
    CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, DuplicateTokenEx, IsTokenRestricted, LUA_TOKEN,
    SecurityImpersonation, TOKEN_ALL_ACCESS, TOKEN_DUPLICATE, TOKEN_QUERY, TokenPrimary,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessWithTokenW, GetCurrentProcess,
    GetExitCodeProcess, GetProcessId, OpenProcessToken, PROCESS_INFORMATION, ResumeThread,
    STARTUPINFOW, TerminateProcess, WaitForSingleObject,
};

use crate::protocol::{LaunchRequest, NetworkMode};

pub fn self_probe() -> Result<u8, String> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error("OpenProcessToken(self-probe)"));
        }
        let restricted = IsTokenRestricted(token) != 0;
        CloseHandle(token);
        let mut in_job = 0;
        if IsProcessInJob(GetCurrentProcess(), null_mut(), &mut in_job) == 0 {
            return Err(last_error("IsProcessInJob"));
        }
        println!(
            "{{\"restrictedToken\":{restricted},\"inJob\":{}}}",
            in_job != 0
        );
        Ok(0)
    }
}

pub fn launch(request: &LaunchRequest) -> Result<u8, String> {
    if matches!(request.network, NetworkMode::Restricted) {
        return Err("network.restricted is not implemented by the W0 process prototype".to_owned());
    }
    if !request.read_roots.is_empty() || !request.write_roots.is_empty() {
        return Err("filesystem roots require the W0 identity/ACL prototype".to_owned());
    }

    unsafe {
        let primary = duplicate_primary_token()?;
        let restricted = create_restricted_token(primary)?;
        CloseHandle(primary);
        let job = create_kill_on_close_job()?;
        let result = create_child(request, restricted, job);
        CloseHandle(restricted);
        CloseHandle(job);
        result
    }
}

unsafe fn duplicate_primary_token() -> Result<HANDLE, String> {
    let mut current = null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut current,
        )
    } == 0
    {
        return Err(last_error("OpenProcessToken"));
    }
    let mut token = null_mut();
    let result = unsafe {
        DuplicateTokenEx(
            current,
            TOKEN_ALL_ACCESS,
            null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut token,
        )
    };
    unsafe { CloseHandle(current) };
    if result == 0 {
        return Err(last_error("DuplicateTokenEx"));
    }
    Ok(token)
}

unsafe fn create_restricted_token(primary: HANDLE) -> Result<HANDLE, String> {
    let mut restricted = null_mut();
    if unsafe {
        CreateRestrictedToken(
            primary,
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
            0,
            null(),
            0,
            null(),
            0,
            null(),
            &mut restricted,
        )
    } == 0
    {
        return Err(last_error("CreateRestrictedToken"));
    }
    Ok(restricted)
}

unsafe fn create_kill_on_close_job() -> Result<HANDLE, String> {
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(last_error("CreateJobObjectW"));
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        unsafe { CloseHandle(job) };
        return Err(last_error("SetInformationJobObject"));
    }
    Ok(job)
}

unsafe fn create_child(request: &LaunchRequest, token: HANDLE, job: HANDLE) -> Result<u8, String> {
    let mut command = quote_command(&request.executable, &request.arguments);
    let mut executable = wide(&request.executable);
    let mut cwd = wide(&request.cwd);
    let environment = environment_block(&request.environment);
    let environment_ptr = if environment.is_empty() {
        null()
    } else {
        environment.as_ptr() as *const c_void
    };
    let creation_flags = CREATE_SUSPENDED
        | if environment.is_empty() {
            0
        } else {
            CREATE_UNICODE_ENVIRONMENT
        };
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };

    let created = unsafe {
        CreateProcessWithTokenW(
            token,
            0,
            executable.as_mut_ptr(),
            command.as_mut_ptr(),
            creation_flags,
            environment_ptr,
            cwd.as_mut_ptr(),
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        return Err(last_error("CreateProcessWithTokenW"));
    }

    let result = if unsafe {
        windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(job, process.hProcess)
    } == 0
    {
        Err(last_error("AssignProcessToJobObject"))
    } else if unsafe { ResumeThread(process.hThread) } == u32::MAX {
        Err(last_error("ResumeThread"))
    } else {
        let child_restricted = unsafe { child_token_is_restricted(process.hProcess) }?;
        let child_in_job = unsafe { child_process_is_in_job(process.hProcess) }?;
        println!("{{\"restrictedToken\":{child_restricted},\"inJob\":{child_in_job}}}");
        let wait = unsafe { WaitForSingleObject(process.hProcess, 30_000) };
        if wait == WAIT_TIMEOUT {
            unsafe { TerminateProcess(process.hProcess, 124) };
            Err("child exceeded the 30 second W0 timeout".to_owned())
        } else if wait != WAIT_OBJECT_0 {
            Err(last_error("WaitForSingleObject"))
        } else {
            let mut exit_code = 1;
            if unsafe { GetExitCodeProcess(process.hProcess, &mut exit_code) } == 0 {
                Err(last_error("GetExitCodeProcess"))
            } else if exit_code > u8::MAX as u32 {
                Err(format!(
                    "child {} returned unsupported exit code {exit_code}",
                    unsafe { GetProcessId(process.hProcess) }
                ))
            } else {
                Ok(exit_code as u8)
            }
        }
    };
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    result
}

unsafe fn child_token_is_restricted(process: HANDLE) -> Result<bool, String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error("OpenProcessToken(child)"));
    }
    let result = unsafe { IsTokenRestricted(token) != 0 };
    unsafe { CloseHandle(token) };
    Ok(result)
}

unsafe fn child_process_is_in_job(process: HANDLE) -> Result<bool, String> {
    let mut in_job = 0;
    if unsafe { IsProcessInJob(process, null_mut(), &mut in_job) } == 0 {
        return Err(last_error("IsProcessInJob(child)"));
    }
    Ok(in_job != 0)
}

fn quote_command(executable: &str, arguments: &[String]) -> Vec<u16> {
    let command = iter::once(executable)
        .chain(arguments.iter().map(String::as_str))
        .map(quote_argument)
        .collect::<Vec<_>>()
        .join(" ");
    wide(&command)
}

fn quote_argument(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn environment_block(environment: &std::collections::BTreeMap<String, String>) -> Vec<u16> {
    if environment.is_empty() {
        return Vec::new();
    }
    let mut block = Vec::new();
    for (name, value) in environment {
        block.extend(OsStr::new(&format!("{name}={value}")).encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(iter::once(0))
        .collect()
}

fn last_error(operation: &str) -> String {
    format!("{operation} failed: {}", std::io::Error::last_os_error())
}
