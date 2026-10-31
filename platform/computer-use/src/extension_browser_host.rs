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

//! Maka browser extension-host bootstrap, before CLI logging or async startup.

/// Select explicit connector setup or the exact installed extension-host origin.
pub fn bootstrap() -> Option<std::process::ExitCode> {
    #[cfg(feature = "native-desktop")]
    {
        if let Some(exit) = crate::host_handoff::bootstrap() {
            return Some(exit);
        }
        cua_driver_core::browser::extension_process::bootstrap_installed()
    }
    #[cfg(not(feature = "native-desktop"))]
    {
        let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
        let extension = arguments
            .first()
            .and_then(|arg| arg.to_str())
            .is_some_and(|arg| arg.starts_with("chrome-extension://"));
        let setup = arguments.first().and_then(|arg| arg.to_str()) == Some("browser")
            && matches!(
                arguments.get(1).and_then(|arg| arg.to_str()),
                Some("install" | "uninstall" | "extension" | "restore")
            );
        if extension || setup {
            eprintln!("Maka browser connector requires a build with native-desktop enabled");
            Some(std::process::ExitCode::FAILURE)
        } else {
            None
        }
    }
}
