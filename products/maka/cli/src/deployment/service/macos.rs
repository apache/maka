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

use super::{Deployment, HostError, Role, arguments, checked, command, label, publish, xml};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

pub(super) struct Service {
    uid: String,
    label: String,
    target: String,
    path: PathBuf,
    /// The service definition around its program arguments.
    definition: (String, String),
    arguments: Vec<String>,
    /// The Host's executable, run under its own identity; see
    /// `host_identity`.
    host: Option<PathBuf>,
    capture: Option<maka_host_runtime::logs::Source>,
}

struct Instance {
    pid: Option<libc::pid_t>,
    last_result: i64,
}

impl Service {
    pub fn new(deployment: &Deployment, role: Role) -> Result<Self, HostError> {
        let uid = unsafe { libc::geteuid() }.to_string();
        let label = label(deployment, role);
        let home = crate::serve::home_directory()?.ok_or("missing account home")?;
        let path = home
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist"));
        let arguments = arguments(deployment, role)?.map(str::to_owned).to_vec();
        let host = (role == Role::Host).then(|| deployment.executable.clone());
        let capture = if role == Role::Host {
            Some(maka_host_runtime::logs::Source::for_root(
                &deployment.root_id,
                &maka_event_log::root::RootNamespaces::for_current_account()?,
            )?)
        } else {
            None
        };
        let log = match &capture {
            Some(source) => source.path().to_owned(),
            None => super::super::directory(&deployment.root_id)?.join("update.stderr.log"),
        };
        let log = xml(log.to_str().ok_or("service log path must be UTF-8")?);
        let definition = if role == Role::Updater {
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array>\0</array><key>StartInterval</key><integer>600</integer><key>RunAtLoad</key><true/><key>Umask</key><integer>63</integer><key>StandardErrorPath</key><string>{log}</string></dict></plist>\n"
            )
        } else {
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array>\0</array><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>2</integer><key>ExitTimeOut</key><integer>45</integer><key>Umask</key><integer>63</integer><key>StandardErrorPath</key><string>{log}</string></dict></plist>\n"
            )
        };
        Ok(Self {
            target: format!("gui/{uid}/{label}"),
            uid,
            label,
            path,
            definition: definition
                .split_once('\0')
                .map(|(head, tail)| (head.to_owned(), tail.to_owned()))
                .ok_or("service definition lost its arguments")?,
            arguments,
            host,
            capture,
        })
    }

    fn in_user_domain(&self, args: &[&str]) -> Result<String, HostError> {
        let mut command_args = vec!["asuser", &self.uid, "/bin/launchctl"];
        command_args.extend_from_slice(args);
        checked(command("/bin/launchctl", &command_args)?)
    }

    pub fn prepare(&self) -> Result<(), HostError> {
        self.stop()?;
        if let Some(source) = &self.capture {
            drop(source.open_capture()?);
        }
        // Installing the Host's identity happens here, not when a service
        // is only observed, stopped or removed.
        let shell = self
            .host
            .as_deref()
            .map(super::super::host_identity::shell)
            .transpose()?
            .flatten()
            .map(|shell| {
                shell
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "Host identity path must be UTF-8")
            })
            .transpose()?;
        let arguments = shell
            .iter()
            .chain(&self.arguments)
            .map(|argument| format!("<string>{}</string>", xml(argument)))
            .collect::<String>();
        let (head, tail) = &self.definition;
        publish(&self.path, &format!("{head}{arguments}{tail}"))?;
        checked(command("/bin/launchctl", &["enable", &self.target])?)?;
        checked(command(
            "/bin/launchctl",
            &[
                "bootstrap",
                &format!("gui/{}", self.uid),
                self.path.to_str().ok_or("service path must be UTF-8")?,
            ],
        )?)?;
        Ok(())
    }

    fn require_domain(&self) -> Result<(), HostError> {
        if self.in_user_domain(&["managername"])?.trim() != "Aqua"
            || self.in_user_domain(&["manageruid"])?.trim() != self.uid
        {
            return Err("the account GUI launchd domain is unavailable".into());
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<(), HostError> {
        self.require_domain()?;
        // Unlike print's diagnostic format, list's three columns are documented.
        if let Some(instance) = self.instance()? {
            // Root is held, so even a racing automatic launch cannot execute work.
            checked(command("/bin/launchctl", &["bootout", &self.target])?)?;
            // bootout can return before launchd removes the old registration.
            // Do not race bootstrap against that asynchronous teardown.
            let deadline = Instant::now() + Duration::from_secs(45);
            while self.instance()?.is_some() || instance.pid.is_some_and(process_exists) {
                if Instant::now() >= deadline {
                    return Err("launchd service did not finish unloading".into());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        Ok(())
    }

    pub fn remove(&self) -> Result<(), HostError> {
        self.stop()?;
        match self.path.symlink_metadata() {
            Ok(metadata) if metadata.is_file() => {
                std::fs::remove_file(&self.path)?;
                std::fs::File::open(self.path.parent().ok_or("service path has no parent")?)?
                    .sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err("service definition is not a regular file".into()),
        }
        Ok(())
    }

    fn instance(&self) -> Result<Option<Instance>, HostError> {
        for line in self.in_user_domain(&["list"])?.lines() {
            let columns: Vec<_> = line.split_whitespace().collect();
            if columns.len() == 3 && columns[2] == self.label {
                let pid = match columns[0] {
                    "-" => None,
                    pid => Some(
                        pid.parse::<libc::pid_t>()
                            .ok()
                            .filter(|pid| *pid > 0)
                            .ok_or("invalid launchd service PID")?,
                    ),
                };
                return Ok(Some(Instance {
                    pid,
                    last_result: columns[1].parse()?,
                }));
            }
        }
        Ok(None)
    }

    pub fn start(&self) -> Result<(), HostError> {
        // No -k: an implicitly launched instance must never be killed.
        checked(command("/bin/launchctl", &["kickstart", &self.target])?)?;
        Ok(())
    }

    pub fn observe(&self) -> Result<super::Observation, HostError> {
        use super::{Observation, State};
        self.require_domain()?;
        if let Some(instance) = self.instance()? {
            return Ok(Observation::Present {
                state: if instance.pid.is_some() {
                    State::Running
                } else if instance.last_result == 0 {
                    State::Stopped
                } else {
                    State::Failed
                },
                enabled: None,
                pid: instance
                    .pid
                    .and_then(|pid| std::num::NonZeroU32::new(pid as u32)),
                last_result: Some(instance.last_result),
            });
        }
        match self.path.symlink_metadata() {
            Ok(metadata) if metadata.is_file() => Ok(Observation::Present {
                state: State::Stopped,
                enabled: None,
                pid: None,
                last_result: None,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Observation::Missing),
            Err(error) => Err(error.into()),
            Ok(_) => Err("service definition is not a regular file".into()),
        }
    }
}

fn process_exists(pid: libc::pid_t) -> bool {
    // Signal zero only observes existence; it never signals a potentially reused PID.
    let exists = unsafe { libc::kill(pid, 0) == 0 };
    exists || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}
