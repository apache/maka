use std::ffi::{OsStr, c_void};
use std::iter;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Security::{
    CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, DuplicateTokenEx, IsTokenRestricted,
    SecurityImpersonation, TOKEN_ALL_ACCESS, TOKEN_DUPLICATE, TOKEN_QUERY, TokenPrimary,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessWithTokenW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
    GetExitCodeProcess, GetProcessId, INFINITE, InitializeProcThreadAttributeList,
    OpenProcessToken, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, ResumeThread,
    STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
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
            DISABLE_MAX_PRIVILEGE,
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
    let mut cwd = wide(&request.cwd);
    let environment = environment_block(&request.environment);
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    let mut attribute_bytes = 0;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_bytes) };
    let mut attribute_storage = vec![0_u8; attribute_bytes];
    startup.lpAttributeList = attribute_storage.as_mut_ptr().cast();
    if unsafe {
        InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &mut attribute_bytes)
    } == 0
    {
        return Err(last_error("InitializeProcThreadAttributeList"));
    }
    let mut job_attribute = job;
    if unsafe {
        UpdateProcThreadAttribute(
            startup.lpAttributeList,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            (&mut job_attribute as *mut HANDLE).cast(),
            size_of::<HANDLE>(),
            null_mut(),
            null_mut(),
        )
    } == 0
    {
        unsafe { DeleteProcThreadAttributeList(startup.lpAttributeList) };
        return Err(last_error("UpdateProcThreadAttribute(JOB_LIST)"));
    }
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };

    let created = unsafe {
        CreateProcessWithTokenW(
            token,
            0,
            null(),
            command.as_mut_ptr(),
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr() as *const c_void,
            cwd.as_mut_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(startup.lpAttributeList) };
    if created == 0 {
        return Err(last_error("CreateProcessWithTokenW"));
    }

    let result = if unsafe { ResumeThread(process.hThread) } == u32::MAX {
        Err(last_error("ResumeThread"))
    } else {
        unsafe { WaitForSingleObject(process.hProcess, INFINITE) };
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
    };
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    result
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
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn environment_block(environment: &std::collections::BTreeMap<String, String>) -> Vec<u16> {
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
