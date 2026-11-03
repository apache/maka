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

mod captured;
mod conpty;
mod foreground;
mod protocol;
mod pty;
mod sandbox;
mod terminal;
mod windows_foreground;
mod windows_restricted;

#[cfg(windows)]
fn git_bash() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("MAKA_TEST_GIT_BASH") {
        let path = std::path::PathBuf::from(path);
        assert!(
            path.is_file(),
            "MAKA_TEST_GIT_BASH does not identify a file: {}",
            path.display()
        );
        return path;
    }
    let candidates = [
        std::env::var_os("USERPROFILE").map(|root| {
            std::path::PathBuf::from(root).join(r"scoop\apps\git\current\bin\bash.exe")
        }),
        std::env::var_os("ProgramFiles")
            .map(|root| std::path::PathBuf::from(root).join(r"Git\bin\bash.exe")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .expect("Git Bash is required; set MAKA_TEST_GIT_BASH to its bash.exe")
}
