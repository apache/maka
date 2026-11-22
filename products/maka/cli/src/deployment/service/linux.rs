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

use super::{Deployment, HostError, Role, arguments, checked, command, label, publish};
use std::path::PathBuf;

pub(super) struct Service {
    unit: String,
    path: PathBuf,
    definition: String,
    role: Role,
}

impl Service {
    pub fn new(deployment: &Deployment, role: Role) -> Result<Self, HostError> {
        let unit = format!("{}.service", label(deployment, role));
        let home = crate::serve::home_directory()?.ok_or("missing account home")?;
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        if !config.is_absolute() {
            return Err("XDG_CONFIG_HOME must be absolute".into());
        }
        let executable = arguments(deployment, role)?.map(quote).join(" ");
        let definition = if role == Role::Updater {
            format!(
                "[Unit]\nDescription=Maka native update\n\n[Service]\nType=oneshot\nExecStart=:{executable}\nTimeoutStartSec=600\nTimeoutStopSec=45\nUMask=0077\n"
            )
        } else {
            format!(
                "[Unit]\nDescription=Maka Host\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=:{executable}\nRestart=on-failure\nRestartSec=2\nKillMode=mixed\nTimeoutStopSec=45\nUMask=0077\n\n[Install]\nWantedBy=default.target\n"
            )
        };
        Ok(Self {
            path: config.join("systemd/user").join(&unit),
            unit,
            definition,
            role,
        })
    }

    pub fn prepare(&self) -> Result<(), HostError> {
        if self.role == Role::Updater {
            self.stop()?;
            publish(&self.path, &self.definition)?;
            let timer = self.path.with_extension("timer");
            publish(
                &timer,
                "[Unit]\nDescription=Maka native update schedule\n\n[Timer]\nOnStartupSec=2min\nOnUnitInactiveSec=10min\n\n[Install]\nWantedBy=timers.target\n",
            )?;
            checked(command("systemctl", &["--user", "daemon-reload"])?)?;
            checked(command(
                "systemctl",
                &[
                    "--user",
                    "enable",
                    "--now",
                    &self.unit.replace(".service", ".timer"),
                ],
            )?)?;
            return Ok(());
        }
        // An SSH logout must not destroy a persistent user service.
        let uid = unsafe { libc::geteuid() }.to_string();
        if checked(command(
            "loginctl",
            &["show-user", &uid, "--property=Linger", "--value"],
        )?)?
        .trim()
            != "yes"
        {
            return Err(
                format!("persistent user services require lingering for user {uid}").into(),
            );
        }
        self.stop()?;
        publish(&self.path, &self.definition)?;
        checked(command("systemctl", &["--user", "daemon-reload"])?)?;
        checked(command("systemctl", &["--user", "enable", &self.unit])?)?;
        Ok(())
    }

    pub fn stop(&self) -> Result<(), HostError> {
        let loaded = checked(command(
            "systemctl",
            &[
                "--user",
                "show",
                "--property=LoadState",
                "--value",
                &self.unit,
            ],
        )?)?;
        match loaded.trim() {
            "not-found" => {}
            "loaded" | "error" | "bad-setting" => {
                // The caller holds Root: no service instance can own user work.
                checked(command("systemctl", &["--user", "stop", &self.unit])?)?;
            }
            _ => return Err("unrecognized systemd service load state".into()),
        }
        Ok(())
    }

    pub fn remove(&self) -> Result<(), HostError> {
        if self.role == Role::Updater {
            let timer = self.path.with_extension("timer");
            match timer.symlink_metadata() {
                Ok(metadata) if metadata.is_file() => {
                    checked(command(
                        "systemctl",
                        &[
                            "--user",
                            "disable",
                            "--now",
                            &self.unit.replace(".service", ".timer"),
                        ],
                    )?)?;
                    std::fs::remove_file(timer)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err("update timer is not a regular file".into()),
            }
        }
        let fragment = checked(command(
            "systemctl",
            &[
                "--user",
                "show",
                "--property=FragmentPath",
                "--value",
                &self.unit,
            ],
        )?)?;
        if !fragment.trim().is_empty() && std::path::Path::new(fragment.trim()) != self.path {
            return Err("service definition location differs; restore its original XDG_CONFIG_HOME before cleanup".into());
        }
        self.stop()?;
        match self.path.symlink_metadata() {
            Ok(metadata) if metadata.is_file() => {
                if self.role == Role::Host {
                    checked(command("systemctl", &["--user", "disable", &self.unit])?)?;
                }
                std::fs::remove_file(&self.path)?;
                std::fs::File::open(self.path.parent().ok_or("service path has no parent")?)?
                    .sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err("service definition is not a regular file".into()),
        }
        checked(command("systemctl", &["--user", "daemon-reload"])?)?;
        Ok(())
    }

    pub fn start(&self) -> Result<(), HostError> {
        checked(command(
            "systemctl",
            &["--user", "reset-failed", &self.unit],
        )?)?;
        checked(command("systemctl", &["--user", "start", &self.unit])?)?;
        Ok(())
    }

    pub fn observe(&self) -> Result<super::Observation, HostError> {
        use super::{Observation, State};
        let output = checked(command(
            "systemctl",
            &[
                "--user",
                "show",
                "--property=LoadState,ActiveState,UnitFileState,MainPID,ExecMainStatus",
                &self.unit,
            ],
        )?)?;
        let fields: std::collections::BTreeMap<_, _> = output
            .lines()
            .filter_map(|line| line.split_once('='))
            .collect();
        let field = |key| fields.get(key).copied().ok_or("incomplete systemd status");
        if field("LoadState")? == "not-found" {
            return Ok(Observation::Missing);
        }
        let state = match field("ActiveState")? {
            "active" | "reloading" => State::Running,
            "activating" => State::Starting,
            "deactivating" => State::Stopping,
            "inactive" => State::Stopped,
            "failed" => State::Failed,
            _ => return Err("unrecognized systemd activity state".into()),
        };
        Ok(Observation::Present {
            state,
            enabled: Some(matches!(
                field("UnitFileState")?,
                "enabled" | "enabled-runtime"
            )),
            pid: std::num::NonZeroU32::new(field("MainPID")?.parse()?),
            last_result: Some(field("ExecMainStatus")?.parse()?),
        })
    }
}

fn quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}
