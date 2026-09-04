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
    collections::HashSet,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use napi::bindgen_prelude::{Error as NapiError, Result, Status};
use napi_derive::napi;
use windows::{
    Win32::{
        Foundation::{HANDLE, RPC_E_CHANGED_MODE, VARIANT_FALSE, VARIANT_TRUE},
        System::{
            Com::{
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize,
            },
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            TaskScheduler::{
                IDailyTrigger, IExecAction, ILogonTrigger, IRegisteredTask, IRegistrationTrigger,
                ITaskFolder, ITaskService, TASK_ACTION_EXEC, TASK_CREATE_OR_UPDATE,
                TASK_INSTANCES_IGNORE_NEW, TASK_LOGON_INTERACTIVE_TOKEN, TASK_RUNLEVEL_LUA,
                TASK_STATE_DISABLED, TASK_STATE_QUEUED, TASK_STATE_READY, TASK_STATE_RUNNING,
                TASK_TRIGGER_DAILY, TASK_TRIGGER_LOGON, TASK_TRIGGER_REGISTRATION, TaskScheduler,
            },
            Threading::GetCurrentProcess,
            Variant::VARIANT,
        },
    },
    core::{BSTR, Interface, PCWSTR},
};

const ROOT_ID_BYTES: usize = 64;
const MAX_COMMAND_ARGUMENTS: usize = 64;
const MAX_ARGUMENT_BYTES: usize = 4 * 1024;
const STOP_TIMEOUT: Duration = Duration::from_secs(30);

static PROCESS_JOB: OnceLock<Mutex<Option<OwnedHandle>>> = OnceLock::new();

#[derive(Clone, Copy)]
enum Target {
    Host,
    Reconciliation,
}

#[napi(object)]
pub struct WindowsTaskStatus {
    pub installed: bool,
    pub enabled: bool,
    pub state: String,
    pub pid: Option<u32>,
    pub last_exit_code: Option<u32>,
}

#[napi]
pub fn windows_task_probe() -> Result<()> {
    scheduler().map(|_| ()).map_err(native_error)
}

#[napi]
pub fn windows_task_converge(
    root_id: String,
    target: String,
    runner_path: String,
    command: Vec<String>,
) -> Result<()> {
    let target = require_target(&root_id, &target)?;
    validate_command(&command).map_err(|_| invalid("Windows lifecycle command is invalid"))?;
    converge_task(
        &scheduler().map_err(native_error)?,
        &root_id,
        target,
        &runner_path,
        &command,
    )
    .map_err(native_error)
}

#[napi]
pub fn windows_task_verify(
    root_id: String,
    target: String,
    runner_path: String,
    command: Vec<String>,
) -> Result<()> {
    let target = require_target(&root_id, &target)?;
    validate_command(&command).map_err(|_| invalid("Windows lifecycle command is invalid"))?;
    let context = scheduler().map_err(native_error)?;
    let name = task_name(&root_id, target);
    let task =
        required_owned_task(&context.folder, &name, &root_id, target).map_err(native_error)?;
    verify_registered_definition(&task, target, &runner_path, &command, &context.user)
        .map_err(native_error)
}

#[napi]
pub fn windows_task_status(root_id: String, target: String) -> Result<WindowsTaskStatus> {
    let target = require_target(&root_id, &target)?;
    let context = scheduler().map_err(native_error)?;
    let name = task_name(&root_id, target);
    read_status(
        owned_task(&context.folder, &name, &root_id, target).map_err(native_error)?,
        target,
    )
    .map_err(native_error)
}

#[napi]
pub fn windows_task_activate(root_id: String) -> Result<()> {
    require_root_id(&root_id)?;
    let target = Target::Host;
    let context = scheduler().map_err(native_error)?;
    let name = task_name(&root_id, target);
    let task =
        required_owned_task(&context.folder, &name, &root_id, target).map_err(native_error)?;
    // SAFETY: task is a live thread-local COM interface and Run copies the empty argument.
    unsafe {
        if task.State().map_err(native_error)? != TASK_STATE_RUNNING {
            task.Run(&VARIANT::default()).map_err(native_error)?;
        }
    }
    Ok(())
}

#[napi]
pub fn windows_task_retire(root_id: String) -> Result<()> {
    require_root_id(&root_id)?;
    let target = Target::Host;
    let context = scheduler().map_err(native_error)?;
    let name = task_name(&root_id, target);
    if let Some(task) =
        owned_task(&context.folder, &name, &root_id, target).map_err(native_error)?
    {
        stop_task(&task).map_err(native_error)?;
    }
    Ok(())
}

#[napi]
pub fn windows_task_uninstall(root_id: String, target: String) -> Result<()> {
    let target = require_target(&root_id, &target)?;
    let context = scheduler().map_err(native_error)?;
    let name = task_name(&root_id, target);
    if let Some(task) =
        owned_task(&context.folder, &name, &root_id, target).map_err(native_error)?
    {
        stop_task(&task).map_err(native_error)?;
        // SAFETY: folder is a live thread-local COM interface and DeleteTask copies the BSTR.
        unsafe {
            context
                .folder
                .DeleteTask(&BSTR::from(&name), 0)
                .map_err(native_error)?;
        }
    }
    Ok(())
}

#[napi]
pub fn own_current_process_tree() -> Result<()> {
    let slot = PROCESS_JOB.get_or_init(|| Mutex::new(None));
    let mut guard = slot
        .lock()
        .map_err(|_| NapiError::new(Status::GenericFailure, "Windows process job is poisoned"))?;
    if guard.is_some() {
        return Ok(());
    }
    // SAFETY: the owned handle remains live in PROCESS_JOB until process exit. The initialized
    // structure and information class have matching layouts, and GetCurrentProcess is valid here.
    unsafe {
        let created = CreateJobObjectW(None, PCWSTR::null()).map_err(native_error)?;
        let owned = OwnedHandle::from_raw_handle(created.0);
        let handle = HANDLE(owned.as_raw_handle());
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&raw const information).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(native_error)?;
        AssignProcessToJobObject(handle, GetCurrentProcess()).map_err(native_error)?;
        *guard = Some(owned);
    }
    Ok(())
}

struct Scheduler {
    service: ITaskService,
    folder: ITaskFolder,
    user: String,
    _apartment: ComApartment,
}

fn scheduler() -> windows::core::Result<Scheduler> {
    let apartment = ComApartment::initialize()?;
    // SAFETY: COM is initialized for this thread and all interfaces remain thread-local.
    unsafe {
        let service: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)?;
        let empty = VARIANT::default();
        service.Connect(&empty, &empty, &empty, &empty)?;
        let folder = service.GetFolder(&BSTR::from("\\"))?;
        let user = service.ConnectedUser()?.to_string();
        Ok(Scheduler {
            service,
            folder,
            user,
            _apartment: apartment,
        })
    }
}

fn converge_task(
    context: &Scheduler,
    root_id: &str,
    target: Target,
    runner_path: &str,
    command: &[String],
) -> windows::core::Result<()> {
    let name = task_name(root_id, target);
    if let Some(task) = owned_task(&context.folder, &name, root_id, target)?
        && matches!(target, Target::Host)
    {
        stop_task(&task)?;
    }
    let desired = normalized_definition(
        &context.service,
        root_id,
        target,
        runner_path,
        command,
        &context.user,
    )?;
    let empty = VARIANT::default();
    let user_id = VARIANT::from(context.user.as_str());
    // SAFETY: all COM interfaces are live on this thread and registration copies its arguments.
    unsafe {
        context.folder.RegisterTaskDefinition(
            &BSTR::from(&name),
            &desired,
            TASK_CREATE_OR_UPDATE.0,
            &user_id,
            &empty,
            TASK_LOGON_INTERACTIVE_TOKEN,
            &empty,
        )?;
    }
    Ok(())
}

fn normalized_definition(
    service: &ITaskService,
    root_id: &str,
    target: Target,
    runner_path: &str,
    command: &[String],
    user: &str,
) -> windows::core::Result<windows::Win32::System::TaskScheduler::ITaskDefinition> {
    // SAFETY: service is a live thread-local COM interface and SetXmlText copies the BSTR.
    unsafe {
        let definition = service.NewTask(0)?;
        definition.SetXmlText(&BSTR::from(render_task_xml(
            root_id,
            target,
            runner_path,
            command,
            user,
        )?))?;
        Ok(definition)
    }
}

fn owned_task(
    folder: &ITaskFolder,
    name: &str,
    root_id: &str,
    target: Target,
) -> windows::core::Result<Option<IRegisteredTask>> {
    // SAFETY: folder is a live thread-local COM interface and GetTask copies the BSTR.
    unsafe {
        match folder.GetTask(&BSTR::from(name)) {
            Ok(task) => {
                assert_owned(&task, root_id, target)?;
                Ok(Some(task))
            }
            Err(error) if error.code().0 as u32 == 0x80070002 => Ok(None),
            Err(error) => Err(error),
        }
    }
}

fn verify_registered_definition(
    task: &IRegisteredTask,
    target: Target,
    runner_path: &str,
    command: &[String],
    user: &str,
) -> windows::core::Result<()> {
    // SAFETY: every interface is obtained from this thread's live registered-task definition;
    // all out pointers refer to initialized local values for the duration of each call.
    unsafe {
        let expected_command = task_action_command(target, runner_path, command)?;
        let definition = task.Definition()?;

        let actions = definition.Actions()?;
        let mut action_count = 0;
        actions.Count(&mut action_count)?;
        let action = actions.get_Item(1)?;
        let mut action_type = TASK_ACTION_EXEC;
        action.Type(&mut action_type)?;
        let executable: IExecAction = action.cast()?;
        let mut path = BSTR::new();
        let mut arguments = BSTR::new();
        executable.Path(&mut path)?;
        executable.Arguments(&mut arguments)?;

        let principal = definition.Principal()?;
        let mut principal_user = BSTR::new();
        let mut logon_type = TASK_LOGON_INTERACTIVE_TOKEN;
        let mut run_level = TASK_RUNLEVEL_LUA;
        principal.UserId(&mut principal_user)?;
        principal.LogonType(&mut logon_type)?;
        principal.RunLevel(&mut run_level)?;

        let settings = definition.Settings()?;
        let mut instances = TASK_INSTANCES_IGNORE_NEW;
        let mut allow_demand = VARIANT_FALSE;
        let mut allow_hard_terminate = VARIANT_FALSE;
        let mut disallow_battery_start = VARIANT_TRUE;
        let mut enabled = VARIANT_FALSE;
        let mut network_required = VARIANT_TRUE;
        let mut start_when_available = VARIANT_FALSE;
        let mut stop_on_battery = VARIANT_TRUE;
        let mut execution_limit = BSTR::new();
        let mut restart_interval = BSTR::new();
        let mut restart_count = 0;
        settings.MultipleInstances(&mut instances)?;
        settings.AllowDemandStart(&mut allow_demand)?;
        settings.AllowHardTerminate(&mut allow_hard_terminate)?;
        settings.DisallowStartIfOnBatteries(&mut disallow_battery_start)?;
        settings.Enabled(&mut enabled)?;
        settings.ExecutionTimeLimit(&mut execution_limit)?;
        settings.RunOnlyIfNetworkAvailable(&mut network_required)?;
        settings.StartWhenAvailable(&mut start_when_available)?;
        settings.StopIfGoingOnBatteries(&mut stop_on_battery)?;
        settings.RestartInterval(&mut restart_interval)?;
        settings.RestartCount(&mut restart_count)?;

        let triggers = definition.Triggers()?;
        let mut trigger_count = 0;
        triggers.Count(&mut trigger_count)?;
        let triggers_match = match target {
            Target::Host if trigger_count == 1 => {
                let trigger = triggers.get_Item(1)?;
                let mut trigger_type = TASK_TRIGGER_LOGON;
                let mut trigger_enabled = VARIANT_FALSE;
                trigger.Type(&mut trigger_type)?;
                trigger.Enabled(&mut trigger_enabled)?;
                let logon: ILogonTrigger = trigger.cast()?;
                let mut trigger_user = BSTR::new();
                logon.UserId(&mut trigger_user)?;
                trigger_type == TASK_TRIGGER_LOGON
                    && trigger_enabled == VARIANT_TRUE
                    && same_windows_user(&trigger_user.to_string(), user)
            }
            Target::Reconciliation if trigger_count == 2 => {
                let registration = triggers.get_Item(1)?;
                let daily = triggers.get_Item(2)?;
                let mut registration_type = TASK_TRIGGER_REGISTRATION;
                let mut daily_type = TASK_TRIGGER_DAILY;
                let mut registration_enabled = VARIANT_FALSE;
                let mut daily_enabled = VARIANT_FALSE;
                registration.Type(&mut registration_type)?;
                registration.Enabled(&mut registration_enabled)?;
                daily.Type(&mut daily_type)?;
                daily.Enabled(&mut daily_enabled)?;
                let registration: IRegistrationTrigger = registration.cast()?;
                let daily: IDailyTrigger = daily.cast()?;
                let mut delay = BSTR::new();
                let mut random_delay = BSTR::new();
                let mut start_boundary = BSTR::new();
                let mut days = 0;
                registration.Delay(&mut delay)?;
                daily.RandomDelay(&mut random_delay)?;
                daily.StartBoundary(&mut start_boundary)?;
                daily.DaysInterval(&mut days)?;
                registration_type == TASK_TRIGGER_REGISTRATION
                    && daily_type == TASK_TRIGGER_DAILY
                    && registration_enabled == VARIANT_TRUE
                    && daily_enabled == VARIANT_TRUE
                    && delay == "PT15M"
                    && random_delay == "PT1H"
                    && start_boundary == "2000-01-01T03:00:00"
                    && days == 1
            }
            _ => false,
        };

        if action_count != 1
            || action_type != TASK_ACTION_EXEC
            || path != expected_command[0]
            || arguments != command_line(&expected_command[1..])
            || !same_windows_user(&principal_user.to_string(), user)
            || logon_type != TASK_LOGON_INTERACTIVE_TOKEN
            || run_level != TASK_RUNLEVEL_LUA
            || instances != TASK_INSTANCES_IGNORE_NEW
            || allow_demand != VARIANT_TRUE
            || allow_hard_terminate != VARIANT_TRUE
            || disallow_battery_start != VARIANT_FALSE
            || enabled != VARIANT_TRUE
            || execution_limit != "PT0S"
            || network_required != VARIANT_FALSE
            || start_when_available != VARIANT_TRUE
            || stop_on_battery != VARIANT_FALSE
            || !restart_interval.to_string().is_empty()
            || restart_count != 0
            || !triggers_match
        {
            return Err(invalid_task_definition());
        }
    }
    Ok(())
}

fn same_windows_user(observed: &str, connected: &str) -> bool {
    let observed = observed
        .rsplit_once('\\')
        .map_or(observed, |(_, user)| user);
    let connected = connected
        .rsplit_once('\\')
        .map_or(connected, |(_, user)| user);
    !observed.is_empty() && observed.eq_ignore_ascii_case(connected)
}

fn invalid_task_definition() -> windows::core::Error {
    windows::core::Error::new(
        windows::core::HRESULT(0x8007000D_u32 as i32),
        "The Windows scheduled task does not match its managed deployment",
    )
}

fn required_owned_task(
    folder: &ITaskFolder,
    name: &str,
    root_id: &str,
    target: Target,
) -> windows::core::Result<IRegisteredTask> {
    owned_task(folder, name, root_id, target)?.ok_or_else(|| {
        windows::core::Error::new(
            windows::core::HRESULT(0x80070002_u32 as i32),
            "The Windows scheduled task is not installed",
        )
    })
}

fn assert_owned(
    task: &IRegisteredTask,
    root_id: &str,
    target: Target,
) -> windows::core::Result<()> {
    // SAFETY: every interface is obtained from this thread's live registered task.
    let description = unsafe {
        let definition = task.Definition()?;
        let registration = definition.RegistrationInfo()?;
        let mut description = BSTR::new();
        registration.Description(&mut description)?;
        description
    };
    if description != ownership_marker(root_id, target) {
        return Err(windows::core::Error::new(
            windows::core::HRESULT(0x80070005_u32 as i32),
            "Refusing to modify a scheduled task not owned by Maka",
        ));
    }
    Ok(())
}

fn read_status(
    task: Option<IRegisteredTask>,
    target: Target,
) -> windows::core::Result<WindowsTaskStatus> {
    let Some(task) = task else {
        return Ok(WindowsTaskStatus {
            installed: false,
            enabled: false,
            state: "not_installed".to_owned(),
            pid: None,
            last_exit_code: None,
        });
    };
    // SAFETY: task and instances are live thread-local COM interfaces.
    let (state, instances) = unsafe { (task.State()?, task.GetInstances(0)?) };
    let count = unsafe { instances.Count()? };
    if count > 1 {
        return Err(windows::core::Error::new(
            windows::core::HRESULT(0x8007000D_u32 as i32),
            "The Windows scheduled task has multiple running instances",
        ));
    }
    let engine_pid = if count == 1 {
        Some(unsafe { instances.get_Item(&VARIANT::from(1_i32))?.EnginePID()? })
    } else {
        None
    };
    let pid = match (target, engine_pid) {
        (Target::Host, Some(wrapper_pid)) => direct_child_pid(wrapper_pid)?,
        (_, pid) => pid,
    };
    let enabled = unsafe { task.Enabled()? } != VARIANT_FALSE;
    Ok(WindowsTaskStatus {
        installed: true,
        enabled,
        state: if state == TASK_STATE_RUNNING && matches!(target, Target::Host) && pid.is_none() {
            "starting"
        } else if state == TASK_STATE_RUNNING {
            "running"
        } else if state == TASK_STATE_QUEUED {
            "starting"
        } else if state == TASK_STATE_READY || state == TASK_STATE_DISABLED {
            "stopped"
        } else {
            "failed"
        }
        .to_owned(),
        pid,
        last_exit_code: Some(unsafe { task.LastTaskResult()? } as u32),
    })
}

fn direct_child_pid(parent_pid: u32) -> windows::core::Result<Option<u32>> {
    direct_child_pid_in_snapshot(parent_pid, &process_snapshot()?)
}

fn process_snapshot() -> windows::core::Result<Vec<PROCESSENTRY32W>> {
    // SAFETY: the snapshot handle is converted immediately to OwnedHandle, and the initialized
    // PROCESSENTRY32W layout matches the ToolHelp API contract.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?;
        let snapshot = OwnedHandle::from_raw_handle(snapshot.0);
        let handle = HANDLE(snapshot.as_raw_handle());
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        Process32FirstW(handle, &raw mut entry)?;
        let mut processes = Vec::new();
        loop {
            processes.push(entry);
            match Process32NextW(handle, &raw mut entry) {
                Ok(()) => {}
                Err(error) if error.code().0 as u32 == 0x80070012 => break,
                Err(error) => return Err(error),
            }
        }
        Ok(processes)
    }
}

fn direct_child_pid_in_snapshot(
    parent_pid: u32,
    processes: &[PROCESSENTRY32W],
) -> windows::core::Result<Option<u32>> {
    let parent_name = processes
        .iter()
        .find(|process| process.th32ProcessID == parent_pid)
        .map(|process| process_name(&process.szExeFile))
        .ok_or_else(|| {
            windows::core::Error::new(
                windows::core::HRESULT(0x80070002_u32 as i32),
                "The Windows Runtime Host supervisor process is not available",
            )
        })?;
    let mut child = None;
    for process in processes {
        if process.th32ParentProcessID == parent_pid
            && process_name(&process.szExeFile).eq_ignore_ascii_case(&parent_name)
            && child.replace(process.th32ProcessID).is_some()
        {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x8007000D_u32 as i32),
                "The Windows Runtime Host supervisor has multiple direct children",
            ));
        }
    }
    Ok(child)
}

fn process_name(value: &[u16]) -> String {
    String::from_utf16_lossy(
        &value[..value
            .iter()
            .position(|part| *part == 0)
            .unwrap_or(value.len())],
    )
}

fn wait_until_task_stopped(task: &IRegisteredTask) -> windows::core::Result<()> {
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        // SAFETY: task and the returned collection are live thread-local COM interfaces.
        if unsafe { task.GetInstances(0)?.Count()? } == 0 {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(windows::core::Error::new(
        windows::core::HRESULT(0x800705B4_u32 as i32),
        "The Windows scheduled task did not stop",
    ))
}

fn task_owned_process_ids(task: &IRegisteredTask) -> windows::core::Result<HashSet<u32>> {
    // SAFETY: task, instances, and the returned collection are live thread-local COM interfaces.
    let instances = unsafe { task.GetInstances(0)? };
    let count = unsafe { instances.Count()? };
    let processes = process_snapshot()?;
    let mut owned = HashSet::new();
    for index in 1..=count {
        let wrapper_pid = unsafe { instances.get_Item(&VARIANT::from(index))?.EnginePID()? };
        if let Some(host_pid) = direct_child_pid_in_snapshot(wrapper_pid, &processes)? {
            owned.insert(host_pid);
        }
    }
    loop {
        let before = owned.len();
        for process in &processes {
            if owned.contains(&process.th32ParentProcessID) {
                owned.insert(process.th32ProcessID);
            }
        }
        if owned.len() == before {
            return Ok(owned);
        }
    }
}

fn wait_until_processes_exit(process_ids: &HashSet<u32>) -> windows::core::Result<()> {
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if process_snapshot()?
            .iter()
            .all(|process| !process_ids.contains(&process.th32ProcessID))
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(windows::core::Error::new(
        windows::core::HRESULT(0x800705B4_u32 as i32),
        "The Windows Runtime Host process tree did not stop",
    ))
}

fn stop_task(task: &IRegisteredTask) -> windows::core::Result<()> {
    // SAFETY: task and the returned collection are live thread-local COM interfaces.
    if unsafe { task.GetInstances(0)?.Count()? } > 0 {
        let process_ids = task_owned_process_ids(task)?;
        unsafe { task.Stop(0)? };
        wait_until_task_stopped(task)?;
        wait_until_processes_exit(&process_ids)?;
    }
    Ok(())
}

fn render_task_xml(
    root_id: &str,
    target: Target,
    runner_path: &str,
    command: &[String],
    user: &str,
) -> windows::core::Result<String> {
    let marker = ownership_marker(root_id, target);
    let trigger = match target {
        Target::Host => format!(
            "<LogonTrigger><Enabled>true</Enabled><UserId>{}</UserId></LogonTrigger>",
            xml_escape(user)
        ),
        Target::Reconciliation => concat!(
            "<RegistrationTrigger><Enabled>true</Enabled><Delay>PT15M</Delay></RegistrationTrigger>",
            "<CalendarTrigger><StartBoundary>2000-01-01T03:00:00</StartBoundary>",
            "<Enabled>true</Enabled><RandomDelay>PT1H</RandomDelay>",
            "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>"
        )
        .to_owned(),
    };
    let action_command = task_action_command(target, runner_path, command)?;
    let arguments = command_line(&action_command[1..]);
    Ok(format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
            "<Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
            "<RegistrationInfo><Description>{marker}</Description></RegistrationInfo>",
            "<Triggers>{trigger}</Triggers>",
            "<Principals><Principal id=\"Maka\"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType>",
            "<RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
            "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
            "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
            "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
            "<AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable>",
            "<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
            "<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>",
            "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden>",
            "<RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>",
            "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>",
            "<Actions Context=\"Maka\"><Exec><Command>{executable}</Command>",
            "<Arguments>{arguments}</Arguments></Exec></Actions></Task>"
        ),
        marker = marker,
        trigger = trigger,
        executable = xml_escape(&action_command[0]),
        arguments = xml_escape(&arguments),
        user = xml_escape(user),
    ))
}

fn task_action_command(
    target: Target,
    runner_path: &str,
    command: &[String],
) -> windows::core::Result<Vec<String>> {
    if !Path::new(runner_path).is_absolute()
        || runner_path.contains('%')
        || command[0].contains('%')
        || (matches!(target, Target::Host)
            && (command.len() < 4 || command[2] != "runtime-host" || command[3] != "serve"))
    {
        return Err(invalid_windows_request());
    }
    let mode = match target {
        Target::Host => "--supervise",
        Target::Reconciliation => "--once",
    };
    let mut projected = vec![command[0].clone(), runner_path.to_owned(), mode.to_owned()];
    projected.extend(
        command
            .iter()
            .map(|argument| base64_url(argument.as_bytes())),
    );
    if command_line(&projected[1..]).encode_utf16().count() >= 32_767 {
        return Err(invalid_windows_request());
    }
    Ok(projected)
}

fn base64_url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        encoded.push(ALPHABET[(first >> 2) as usize] as char);
        encoded.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            encoded.push(ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            encoded.push(ALPHABET[(third & 0x3f) as usize] as char);
        }
    }
    encoded
}

fn ownership_marker(root_id: &str, target: Target) -> String {
    format!(
        "maka-runtime-host/windows-task/v1/{root_id}/{}",
        match target {
            Target::Host => "host",
            Target::Reconciliation => "reconciliation",
        }
    )
}

fn task_name(root_id: &str, target: Target) -> String {
    format!(
        "Maka-RuntimeHost-{root_id}{}",
        match target {
            Target::Host => "",
            Target::Reconciliation => "-Reconciliation",
        }
    )
}

fn validate_root_id(root_id: &str) -> std::result::Result<(), ()> {
    if root_id.len() == ROOT_ID_BYTES
        && root_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(())
    }
}

fn require_target(root_id: &str, target: &str) -> Result<Target> {
    require_root_id(root_id)?;
    match target {
        "host" => Ok(Target::Host),
        "reconciliation" => Ok(Target::Reconciliation),
        _ => Err(invalid("Windows lifecycle task target is invalid")),
    }
}

fn require_root_id(root_id: &str) -> Result<()> {
    validate_root_id(root_id).map_err(|_| invalid("Windows lifecycle Root ID is invalid"))
}

fn validate_command(command: &[String]) -> std::result::Result<(), ()> {
    if command.is_empty()
        || command.len() > MAX_COMMAND_ARGUMENTS
        || !Path::new(&command[0]).is_absolute()
        || command.iter().any(|argument| {
            argument.is_empty()
                || argument.len() > MAX_ARGUMENT_BYTES
                || argument.chars().any(char::is_control)
        })
    {
        return Err(());
    }
    let utf16_length = command_line(command).encode_utf16().count();
    if utf16_length >= 32_767 {
        return Err(());
    }
    Ok(())
}

fn command_line(arguments: &[String]) -> String {
    arguments
        .iter()
        .map(|argument| quote_windows_argument(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_windows_argument(argument: &str) -> String {
    if !argument.is_empty()
        && !argument
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return argument.to_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
        } else if character == '"' {
            quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
            quoted.push('"');
            backslashes = 0;
        } else {
            quoted.push_str(&"\\".repeat(backslashes));
            quoted.push(character);
            backslashes = 0;
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

struct ComApartment {
    uninitialize: bool,
}

impl ComApartment {
    fn initialize() -> windows::core::Result<Self> {
        // SAFETY: balances successful initialization on this thread in Drop.
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result.is_ok() {
            Ok(Self { uninitialize: true })
        } else if result == RPC_E_CHANGED_MODE {
            Ok(Self {
                uninitialize: false,
            })
        } else {
            result.ok()?;
            unreachable!()
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.uninitialize {
            // SAFETY: paired with this thread's successful CoInitializeEx call.
            unsafe { CoUninitialize() };
        }
    }
}

fn invalid(message: &str) -> NapiError {
    NapiError::new(Status::InvalidArg, message)
}

fn invalid_windows_request() -> windows::core::Error {
    windows::core::Error::new(
        windows::core::HRESULT(0x80070057_u32 as i32),
        "Windows lifecycle request is invalid",
    )
}

fn native_error(error: impl std::fmt::Display) -> NapiError {
    NapiError::new(Status::GenericFailure, error.to_string())
}
