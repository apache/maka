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

use clap::ValueEnum;
use maka_host_runtime::HostError;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Target {
    DarwinArm64,
    DarwinX64,
    LinuxArm64Gnu,
    LinuxX64Gnu,
    Win32X64,
}

impl Target {
    pub fn current() -> Result<Self, HostError> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => Ok(Self::DarwinArm64),
            ("macos", "x86_64") => Ok(Self::DarwinX64),
            ("linux", "aarch64") => Ok(Self::LinuxArm64Gnu),
            ("linux", "x86_64") => Ok(Self::LinuxX64Gnu),
            ("windows", "x86_64") => Ok(Self::Win32X64),
            _ => Err("native CLI distribution is unavailable for this platform".into()),
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Self::DarwinArm64 => "darwin-arm64",
            Self::DarwinX64 => "darwin-x64",
            Self::LinuxArm64Gnu => "linux-arm64-gnu",
            Self::LinuxX64Gnu => "linux-x64-gnu",
            Self::Win32X64 => "win32-x64",
        }
    }

    pub fn package_name(self) -> String {
        format!("@maka-agent/cli-{}", self.slug())
    }

    pub fn os(self) -> &'static str {
        match self {
            Self::DarwinArm64 | Self::DarwinX64 => "darwin",
            Self::LinuxArm64Gnu | Self::LinuxX64Gnu => "linux",
            Self::Win32X64 => "win32",
        }
    }

    pub fn cpu(self) -> &'static str {
        match self {
            Self::DarwinArm64 | Self::LinuxArm64Gnu => "arm64",
            _ => "x64",
        }
    }

    pub fn executable(self) -> &'static str {
        if self == Self::Win32X64 {
            "bin/maka.exe"
        } else {
            "bin/maka"
        }
    }

    // On macOS the shell runs from inside `Maka.app`, so the system shows the
    // bundle's name and icon for it.
    pub fn desktop_executable(self) -> &'static str {
        match self {
            Self::DarwinArm64 | Self::DarwinX64 => "bin/Maka.app/Contents/MacOS/maka-desktop-shell",
            Self::LinuxArm64Gnu | Self::LinuxX64Gnu => "bin/maka-desktop-shell",
            Self::Win32X64 => "bin/maka-desktop-shell.exe",
        }
    }

    /// The bundle whose complete file tree the receipt records: macOS reads
    /// more of a bundle than the members it requires.
    pub fn desktop_bundle(self) -> Option<&'static str> {
        match self {
            Self::DarwinArm64 | Self::DarwinX64 => Some("bin/Maka.app"),
            _ => None,
        }
    }

    /// Files the desktop needs besides its executable; the workbench is
    /// compiled into the executable.
    pub fn desktop_members(self) -> &'static [&'static str] {
        match self {
            Self::DarwinArm64 | Self::DarwinX64 => &[
                "bin/Maka.app/Contents/Info.plist",
                "bin/Maka.app/Contents/Resources/Maka.icns",
                "bin/Maka.app/Contents/Resources/DISCLAIMER",
                "bin/Maka.app/Contents/Resources/LICENSE",
                "bin/Maka.app/Contents/Resources/NOTICE",
                "bin/Maka.app/Contents/Resources/THIRD_PARTY_NOTICES.txt",
            ],
            _ => &[],
        }
    }

    pub fn python_worker(self) -> &'static str {
        if self == Self::Win32X64 {
            "bin/maka-python-worker.exe"
        } else {
            "bin/maka-python-worker"
        }
    }

    pub fn is_executable(self, name: &str) -> bool {
        name == self.executable()
            || name == self.python_worker()
            || name == self.desktop_executable()
            || Some(name) == self.service_executable()
    }

    pub fn service_executable(self) -> Option<&'static str> {
        (self == Self::Win32X64).then_some("bin/maka-service.exe")
    }

    // Inspect only; a downloader must never execute a foreign-target artifact.
    pub fn validate_binary(self, file: &mut File, gui: bool) -> Result<(), HostError> {
        let mut header = [0; 64];
        file.read_exact(&mut header)?;
        let valid = match self {
            Self::DarwinArm64 | Self::DarwinX64 => {
                let cpu: u32 = if self == Self::DarwinArm64 {
                    0x0100_000c
                } else {
                    0x0100_0007
                };
                header[..4] == [0xcf, 0xfa, 0xed, 0xfe]
                    && header[4..8] == cpu.to_le_bytes()
                    && header[12..16] == 2_u32.to_le_bytes()
            }
            Self::LinuxArm64Gnu | Self::LinuxX64Gnu => {
                let machine: u16 = if self == Self::LinuxArm64Gnu { 183 } else { 62 };
                header[..6] == [0x7f, b'E', b'L', b'F', 2, 1]
                    && header[18..20] == machine.to_le_bytes()
                    && matches!(u16::from_le_bytes([header[16], header[17]]), 2 | 3)
            }
            Self::Win32X64 => {
                if header[..2] != *b"MZ" {
                    false
                } else {
                    let offset = u32::from_le_bytes(header[60..64].try_into()?);
                    if !(64..=1024 * 1024).contains(&offset) {
                        return Err("native package has an invalid PE header offset".into());
                    }
                    file.seek(SeekFrom::Start(offset.into()))?;
                    let mut pe = [0; 94];
                    file.read_exact(&mut pe)?;
                    let subsystem: u16 = if gui { 2 } else { 3 };
                    pe[..4] == *b"PE\0\0"
                        && pe[4..6] == 0x8664_u16.to_le_bytes()
                        && pe[24..26] == 0x20b_u16.to_le_bytes()
                        && pe[92..94] == subsystem.to_le_bytes()
                }
            }
        };
        if !valid {
            return Err("native package executable does not match its target or subsystem".into());
        }
        Ok(())
    }
}
