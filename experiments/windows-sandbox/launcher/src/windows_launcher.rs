use std::ffi::{OsStr, c_void};
use std::iter;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{
    CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, DuplicateTokenEx, FreeSid, GetTokenInformation,
    IsTokenRestricted, LUA_TOKEN, SECURITY_CAPABILITIES, SecurityImpersonation, TOKEN_ALL_ACCESS,
    TOKEN_DUPLICATE, TOKEN_QUERY, TOKEN_USER, TokenIsAppContainer, TokenPrimary, TokenUser,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, CreateProcessW,
    CreateProcessWithTokenW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetCurrentProcess, GetExitCodeProcess, GetProcessId, InitializeProcThreadAttributeList,
    OpenProcessToken, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_INFORMATION, ResumeThread, STARTUPINFOEXW, STARTUPINFOW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

use crate::acl_ledger::with_acl_grants;
use crate::protocol::{LaunchRequest, NetworkMode};

pub fn self_probe() -> Result<u8, String> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error("OpenProcessToken(self-probe)"));
        }
        let restricted = IsTokenRestricted(token) != 0;
        let app_container = token_is_appcontainer(token)?;
        CloseHandle(token);
        let mut in_job = 0;
        if IsProcessInJob(GetCurrentProcess(), null_mut(), &mut in_job) == 0 {
            return Err(last_error("IsProcessInJob"));
        }
        println!(
            "{{\"restrictedToken\":{restricted},\"appContainer\":{app_container},\"inJob\":{}}}",
            in_job != 0,
        );
        Ok(0)
    }
}

pub fn launch(request: &LaunchRequest) -> Result<u8, String> {
    validate_unimplemented_policy(request)?;

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

pub fn launch_atomic(request: &LaunchRequest) -> Result<u8, String> {
    validate_unimplemented_policy(request)?;

    unsafe {
        let primary = duplicate_primary_token()?;
        let restricted = create_restricted_token(primary)?;
        CloseHandle(primary);
        let job = create_kill_on_close_job()?;
        let result = create_child_atomic(request, restricted, job);
        CloseHandle(restricted);
        CloseHandle(job);
        result
    }
}

pub fn launch_appcontainer(request: &LaunchRequest) -> Result<u8, String> {
    unsafe {
        let job = create_kill_on_close_job()?;
        let profile = AppContainerProfile::open()?;
        let sid = sid_string(profile.sid)?;
        let result = with_acl_grants(request, &sid, || {
            create_appcontainer_child(request, job, profile.sid)
        });
        CloseHandle(job);
        result
    }
}

pub fn appcontainer_sid_string() -> Result<String, String> {
    unsafe {
        let profile = AppContainerProfile::open()?;
        sid_string(profile.sid)
    }
}

pub fn current_user_sid_string() -> Result<String, String> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error("OpenProcessToken(current user SID)"));
        }
        let mut required = 0;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut required);
        if required == 0 {
            CloseHandle(token);
            return Err(last_error("GetTokenInformation(TokenUser size)"));
        }
        let words = (required as usize).div_ceil(size_of::<usize>());
        let mut storage = vec![0usize; words];
        if GetTokenInformation(
            token,
            TokenUser,
            storage.as_mut_ptr() as *mut c_void,
            required,
            &mut required,
        ) == 0
        {
            CloseHandle(token);
            return Err(last_error("GetTokenInformation(TokenUser)"));
        }
        CloseHandle(token);
        let user = &*(storage.as_ptr() as *const TOKEN_USER);
        sid_string(user.User.Sid)
    }
}

unsafe fn sid_string(sid: *mut c_void) -> Result<String, String> {
    let mut value = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut value) } == 0 {
        return Err(last_error("ConvertSidToStringSidW(AppContainer)"));
    }
    let length = (0..)
        .take_while(|&index| unsafe { *value.add(index) != 0 })
        .count();
    let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, length) });
    unsafe { LocalFree(value as *mut c_void) };
    Ok(result)
}

struct AppContainerProfile {
    name: Vec<u16>,
    sid: *mut c_void,
    created: bool,
}

impl AppContainerProfile {
    unsafe fn open() -> Result<Self, String> {
        let name = wide("maka.sandbox.w0");
        let display_name = wide("Maka Windows Sandbox W0");
        let description = wide("Temporary AppContainer profile for Maka sandbox validation");
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                display_name.as_ptr(),
                description.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        let created = result >= 0;
        if !created {
            const HRESULT_ALREADY_EXISTS: i32 = 0x8007_00B7u32 as i32;
            if result != HRESULT_ALREADY_EXISTS {
                return Err(format!(
                    "CreateAppContainerProfile failed: HRESULT 0x{:08x}",
                    result as u32
                ));
            }
            let derived =
                unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
            if derived < 0 {
                return Err(format!(
                    "DeriveAppContainerSidFromAppContainerName failed: HRESULT 0x{:08x}",
                    derived as u32
                ));
            }
        }
        Ok(Self { name, sid, created })
    }
}

impl Drop for AppContainerProfile {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.sid);
            if self.created {
                DeleteAppContainerProfile(self.name.as_ptr());
            }
        }
    }
}

fn validate_unimplemented_policy(request: &LaunchRequest) -> Result<(), String> {
    if matches!(request.network, NetworkMode::Restricted) {
        return Err("network.restricted is not implemented by the W0 process prototype".to_owned());
    }
    if !request.read_roots.is_empty() || !request.write_roots.is_empty() {
        return Err("filesystem roots require the W0 identity/ACL prototype".to_owned());
    }
    Ok(())
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
    if result.is_err() {
        unsafe {
            TerminateProcess(process.hProcess, 1);
            WaitForSingleObject(process.hProcess, 5_000);
        }
    }
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    result
}

unsafe fn create_child_atomic(
    request: &LaunchRequest,
    token: HANDLE,
    job: HANDLE,
) -> Result<u8, String> {
    let mut command = quote_command(&request.executable, &request.arguments);
    let mut executable = wide(&request.executable);
    let mut cwd = wide(&request.cwd);
    let environment = environment_block(&request.environment);
    let environment_ptr = if environment.is_empty() {
        null()
    } else {
        environment.as_ptr() as *const c_void
    };

    let mut attribute_size = 0usize;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size) };
    if attribute_size == 0 {
        return Err(last_error("InitializeProcThreadAttributeList(size)"));
    }
    let words = attribute_size.div_ceil(size_of::<usize>());
    let mut attribute_storage = vec![0usize; words];
    let attribute_list = attribute_storage.as_mut_ptr() as *mut c_void;
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) } == 0
    {
        return Err(last_error("InitializeProcThreadAttributeList"));
    }

    let mut job_value = job;
    if unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            &mut job_value as *mut HANDLE as *const c_void,
            size_of::<HANDLE>(),
            null_mut(),
            null(),
        )
    } == 0
    {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(last_error("UpdateProcThreadAttribute(JOB_LIST)"));
    }

    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attribute_list;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    let creation_flags = CREATE_SUSPENDED
        | EXTENDED_STARTUPINFO_PRESENT
        | if environment.is_empty() {
            0
        } else {
            CREATE_UNICODE_ENVIRONMENT
        };
    let created = unsafe {
        CreateProcessAsUserW(
            token,
            executable.as_mut_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            creation_flags,
            environment_ptr,
            cwd.as_mut_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list) };
    if created == 0 {
        return Err(last_error("CreateProcessAsUserW(atomic-job)"));
    }

    let result = (|| -> Result<u8, String> {
        if unsafe { ResumeThread(process.hThread) } == u32::MAX {
            return Err(last_error("ResumeThread"));
        }
        let child_restricted = unsafe { child_token_is_restricted(process.hProcess) }?;
        let child_in_job = unsafe { child_process_is_in_job(process.hProcess) }?;
        if child_restricted && child_in_job {
            println!("{{\"restrictedToken\":true,\"inJob\":true,\"atomicJob\":true}}");
            unsafe { wait_for_child(process.hProcess) }
        } else {
            Err("atomic launch did not establish the required token and Job boundary".to_owned())
        }
    })();
    if result.is_err() {
        unsafe {
            TerminateProcess(process.hProcess, 1);
            WaitForSingleObject(process.hProcess, 5_000);
        }
    }
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    result
}

unsafe fn create_appcontainer_child(
    request: &LaunchRequest,
    job: HANDLE,
    app_container_sid: *mut c_void,
) -> Result<u8, String> {
    let mut command = quote_command(&request.executable, &request.arguments);
    let executable = wide(&request.executable);
    let cwd = wide(&request.cwd);
    let environment = environment_block(&request.environment);
    let environment_ptr = if environment.is_empty() {
        null()
    } else {
        environment.as_ptr() as *const c_void
    };

    let mut attribute_size = 0usize;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut attribute_size) };
    if attribute_size == 0 {
        return Err(last_error(
            "InitializeProcThreadAttributeList(appcontainer size)",
        ));
    }
    let words = attribute_size.div_ceil(size_of::<usize>());
    let mut attribute_storage = vec![0usize; words];
    let attribute_list = attribute_storage.as_mut_ptr() as *mut c_void;
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 2, 0, &mut attribute_size) } == 0
    {
        return Err(last_error(
            "InitializeProcThreadAttributeList(appcontainer)",
        ));
    }

    let mut job_value = job;
    let mut capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: app_container_sid,
        Capabilities: null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let attributes = (|| -> Result<(), String> {
        if unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                &mut job_value as *mut HANDLE as *const c_void,
                size_of::<HANDLE>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error(
                "UpdateProcThreadAttribute(APP_CONTAINER_JOB_LIST)",
            ));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                &mut capabilities as *mut SECURITY_CAPABILITIES as *const c_void,
                size_of::<SECURITY_CAPABILITIES>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error(
                "UpdateProcThreadAttribute(SECURITY_CAPABILITIES)",
            ));
        }
        Ok(())
    })();
    if let Err(error) = attributes {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(error);
    }

    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attribute_list;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    let creation_flags = CREATE_SUSPENDED
        | EXTENDED_STARTUPINFO_PRESENT
        | if environment.is_empty() {
            0
        } else {
            CREATE_UNICODE_ENVIRONMENT
        };
    let created = unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            creation_flags,
            environment_ptr,
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list) };
    if created == 0 {
        return Err(last_error("CreateProcessW(appcontainer atomic-job)"));
    }

    let result = (|| -> Result<u8, String> {
        if unsafe { ResumeThread(process.hThread) } == u32::MAX {
            return Err(last_error("ResumeThread(appcontainer)"));
        }
        let child_app_container = unsafe { child_token_is_appcontainer(process.hProcess) }?;
        let child_in_job = unsafe { child_process_is_in_job(process.hProcess) }?;
        if child_app_container && child_in_job {
            println!("{{\"appContainer\":true,\"inJob\":true,\"atomicJob\":true}}");
            unsafe { wait_for_child(process.hProcess) }
        } else {
            Err(
                "AppContainer launch did not establish the required token and Job boundary"
                    .to_owned(),
            )
        }
    })();
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    result
}

unsafe fn wait_for_child(process: HANDLE) -> Result<u8, String> {
    let wait = unsafe { WaitForSingleObject(process, 30_000) };
    if wait == WAIT_TIMEOUT {
        unsafe { TerminateProcess(process, 124) };
        return Err("child exceeded the 30 second W0 timeout".to_owned());
    }
    if wait != WAIT_OBJECT_0 {
        return Err(last_error("WaitForSingleObject"));
    }
    let mut exit_code = 1;
    if unsafe { GetExitCodeProcess(process, &mut exit_code) } == 0 {
        return Err(last_error("GetExitCodeProcess"));
    }
    if exit_code > u8::MAX as u32 {
        return Err(format!(
            "child {} returned unsupported exit code {exit_code}",
            unsafe { GetProcessId(process) }
        ));
    }
    Ok(exit_code as u8)
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

unsafe fn child_token_is_appcontainer(process: HANDLE) -> Result<bool, String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error("OpenProcessToken(appcontainer child)"));
    }
    let result = unsafe { token_is_appcontainer(token) };
    unsafe { CloseHandle(token) };
    result
}

unsafe fn token_is_appcontainer(token: HANDLE) -> Result<bool, String> {
    let mut value = 0u32;
    let mut returned = 0u32;
    if unsafe {
        GetTokenInformation(
            token,
            TokenIsAppContainer,
            &mut value as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(last_error("GetTokenInformation(TokenIsAppContainer)"));
    }
    Ok(value != 0)
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
