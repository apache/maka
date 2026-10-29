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

#[test]
fn desktop_reports_an_invalid_root_without_starting_a_host() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root is a file");
    std::fs::write(&root, b"not a directory").unwrap();
    let expected = std::fs::create_dir_all(&root).unwrap_err().to_string();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_maka"))
        .args(["desktop", "--root"])
        .arg(&root)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains(&expected), "{stderr}");
    assert_eq!(std::fs::read(&root).unwrap(), b"not a directory");
}

#[test]
fn finite_host_command_reports_an_invalid_root_in_observer_and_worker() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root is a file");
    std::fs::write(&root, b"not a directory").unwrap();
    for worker in [false, true] {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_maka"));
        if worker {
            command.arg("--operation-worker");
        }
        let output = command
            .args(["host", "init", "--root"])
            .arg(&root)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(1), "worker={worker}: {stderr}");
        assert!(!stderr.trim().is_empty());
        assert_eq!(std::fs::read(&root).unwrap(), b"not a directory");
    }
}
