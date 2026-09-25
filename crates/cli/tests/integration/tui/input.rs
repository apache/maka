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

use super::*;

#[test]
fn simultaneous_resize_and_input_do_not_wait_for_another_key() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("not-created");
    std::fs::write(&missing, "not a directory").unwrap();
    let mut tui = Pty::spawn(&["--root", missing.to_str().unwrap()]);
    tui.wait_for("connection failed");
    for size in [(55, 28), (120, 40), (80, 24), (100, 32)] {
        // Pause only this isolated child to queue SIGWINCH and a key together.
        // No sleeps or second input may rescue a lost readiness notification.
        let pid = tui.child.id() as libc::pid_t;
        assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid, &mut status, libc::WUNTRACED) },
            pid
        );
        assert!(libc::WIFSTOPPED(status));
        tui.resize(size.0, size.1);
        tui.send(b"\x10");
        assert_eq!(unsafe { libc::kill(pid, libc::SIGCONT) }, 0);
        tui.wait_for("Search commands…");
        tui.send(b"\x1b");
        tui.wait_until(|screen| !screen.contains("Search commands…"));
    }
    tui.send(b"\x11");
    tui.finish();
}
