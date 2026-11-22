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

use super::{Deployment, HostError, Role, arguments, label, xml};
use std::time::{Duration, Instant};
use windows::{
    Win32::{
        Foundation::{RPC_E_CHANGED_MODE, VARIANT_BOOL},
        System::{
            Com::{
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize,
            },
            TaskScheduler::{
                IRegisteredTask, ITaskFolder, ITaskService, TASK_CREATE_OR_UPDATE,
                TASK_LOGON_INTERACTIVE_TOKEN, TASK_STATE_DISABLED, TASK_STATE_QUEUED,
                TASK_STATE_READY, TASK_STATE_RUNNING, TaskScheduler,
            },
            Variant::VARIANT,
        },
    },
    core::BSTR,
};

pub(super) struct Service {
    folder: ITaskFolder,
    scheduler: ITaskService,
    name: String,
    user: String,
    definition: String,
    // COM interfaces must be released before their thread's apartment.
    _apartment: Apartment,
}

impl Service {
    pub fn new(deployment: &Deployment, role: Role) -> Result<Self, HostError> {
        let apartment = Apartment::open()?;
        // SAFETY: initialization and every interface stay on this blocking worker.
        let (scheduler, folder, user) = unsafe {
            let scheduler: ITaskService =
                CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)?;
            let empty = VARIANT::default();
            scheduler.Connect(&empty, &empty, &empty, &empty)?;
            let folder = scheduler.GetFolder(&BSTR::from("\\"))?;
            let domain = scheduler.ConnectedDomain()?.to_string();
            let account = scheduler.ConnectedUser()?.to_string();
            let user = if domain.is_empty() {
                account
            } else {
                format!("{domain}\\{account}")
            };
            (scheduler, folder, user)
        };
        let name = label(deployment, role);
        let args = arguments(deployment, role)?;
        let executable = if role == Role::Updater {
            let windowless = super::super::package::windowless(&deployment.executable)?;
            xml(windowless
                .to_str()
                .ok_or("service executable must be UTF-8")?)
        } else {
            xml(args[0])
        };
        let args = xml(&args[1..]
            .iter()
            .map(|arg| quote(arg))
            .collect::<Vec<_>>()
            .join(" "));
        let principal = xml(&user);
        let trigger = if role == Role::Updater {
            "<CalendarTrigger><Repetition><Interval>PT10M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2000-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>".to_owned()
        } else {
            format!(
                "<LogonTrigger><Enabled>true</Enabled><UserId>{principal}</UserId></LogonTrigger>"
            )
        };
        let lifetime = if role == Role::Updater {
            "<ExecutionTimeLimit>PT10M</ExecutionTimeLimit>"
        } else {
            "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure>"
        };
        let definition = format!(
            concat!(
                "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
                "<Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
                "<RegistrationInfo><Description>{name}</Description></RegistrationInfo>",
                "<Triggers>{trigger}</Triggers>",
                "<Principals><Principal id=\"Maka\"><UserId>{principal}</UserId><LogonType>InteractiveToken</LogonType>",
                "<RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
                "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
                "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
                "<AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable>",
                "<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
                "<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>",
                "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled>",
                "{lifetime}</Settings>",
                "<Actions Context=\"Maka\"><Exec><Command>{executable}</Command><Arguments>{args}</Arguments></Exec></Actions></Task>"
            ),
            name = name,
            principal = principal,
            trigger = trigger,
            lifetime = lifetime,
            executable = executable,
            args = args
        );
        Ok(Self {
            folder,
            scheduler,
            name,
            user,
            definition,
            _apartment: apartment,
        })
    }

    pub fn prepare(&self) -> Result<(), HostError> {
        self.stop()?;
        // SAFETY: these COM interfaces are confined to their initialized thread.
        unsafe {
            let definition = self.scheduler.NewTask(0)?;
            definition.SetXmlText(&BSTR::from(&self.definition))?;
            let empty = VARIANT::default();
            self.folder.RegisterTaskDefinition(
                &BSTR::from(&self.name),
                &definition,
                TASK_CREATE_OR_UPDATE.0,
                &VARIANT::from(self.user.as_str()),
                &empty,
                TASK_LOGON_INTERACTIVE_TOKEN,
                &empty,
            )?;
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<(), HostError> {
        // Root is held by the caller; no instance can be executing user work.
        // SAFETY: these COM interfaces are confined to their initialized thread.
        unsafe {
            if let Some(task) = self.task()?
                && task.GetInstances(0)?.Count()? != 0
            {
                task.Stop(0)?;
                let deadline = Instant::now() + Duration::from_secs(45);
                while task.GetInstances(0)?.Count()? != 0 {
                    if Instant::now() >= deadline {
                        return Err("scheduled task did not stop".into());
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        }
        Ok(())
    }

    pub fn remove(&self) -> Result<(), HostError> {
        let Some(task) = self.task()? else {
            return Ok(());
        };
        // SAFETY: the owned task stays on this COM thread. Disabling first
        // prevents login/restart triggers from racing the final drain/delete.
        unsafe {
            task.SetEnabled(VARIANT_BOOL(0))?;
            if task.State()? != TASK_STATE_DISABLED {
                task.Stop(0)?;
                let deadline = Instant::now() + Duration::from_secs(45);
                while task.State()? != TASK_STATE_DISABLED {
                    if Instant::now() >= deadline {
                        return Err("scheduled task did not finish disabling".into());
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
            self.folder.DeleteTask(&BSTR::from(&self.name), 0)?;
        }
        Ok(())
    }

    pub fn observe(&self) -> Result<super::Observation, HostError> {
        use super::{Observation, State};
        let Some(task) = self.task()? else {
            return Ok(Observation::Missing);
        };
        // SAFETY: observation stays on this object's COM apartment thread.
        unsafe {
            let last_result = if task.LastRunTime()? > 0.0 {
                Some(i64::from(task.LastTaskResult()?))
            } else {
                None
            };
            let state = match task.State()? {
                TASK_STATE_RUNNING => State::Running,
                TASK_STATE_QUEUED => State::Starting,
                // LastTaskResult also contains successful scheduler statuses
                // such as user termination; it is not a process exit code.
                TASK_STATE_READY | TASK_STATE_DISABLED => State::Stopped,
                _ => return Err("unrecognized scheduled task state".into()),
            };
            Ok(Observation::Present {
                state,
                enabled: Some(task.Enabled()?.as_bool()),
                // Task engine PID is not the Host PID; only the live handshake
                // and diagnostics identify the actual execution owner.
                pid: None,
                last_result,
            })
        }
    }

    fn task(&self) -> Result<Option<IRegisteredTask>, HostError> {
        // SAFETY: retrieval and ownership validation share this COM apartment.
        unsafe {
            match self.folder.GetTask(&BSTR::from(&self.name)) {
                Ok(task) => {
                    let mut description = BSTR::new();
                    task.Definition()?
                        .RegistrationInfo()?
                        .Description(&mut description)?;
                    if description != self.name.as_str() {
                        return Err("scheduled task ownership marker differs".into());
                    }
                    Ok(Some(task))
                }
                Err(error) if error.code().0 as u32 == 0x80070002 => Ok(None),
                Err(error) => Err(error.into()),
            }
        }
    }

    pub fn start(&self) -> Result<(), HostError> {
        // SAFETY: registration has completed on this same COM thread.
        unsafe {
            self.folder
                .GetTask(&BSTR::from(&self.name))?
                .Run(&VARIANT::default())?;
        }
        Ok(())
    }
}

fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' {
            slashes += 1;
        } else {
            result.extend(std::iter::repeat_n(
                '\\',
                if character == '"' {
                    slashes * 2 + 1
                } else {
                    slashes
                },
            ));
            slashes = 0;
            result.push(character);
        }
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

struct Apartment(bool);

impl Apartment {
    fn open() -> windows::core::Result<Self> {
        // SAFETY: balanced on this thread, including the already-initialized case.
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result == RPC_E_CHANGED_MODE {
            Ok(Self(false))
        } else {
            result.ok()?;
            Ok(Self(true))
        }
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: paired with successful initialization on this thread.
            unsafe { CoUninitialize() };
        }
    }
}
