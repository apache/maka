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

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null;

    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{CreateNamedPipeW, PIPE_WAIT};

    use crate::broker_pipe::serve_once;
    use crate::windows_launcher::current_user_sid_string;

    #[test]
    fn refuses_to_serve_on_a_squatted_pipe_name() {
        let name = format!(r"\\.\pipe\maka-sandbox-squat-{}", std::process::id());
        let name_wide: Vec<u16> = OsStr::new(&name)
            .encode_wide()
            .chain(iter::once(0))
            .collect();
        // A same-user squatter that allows additional instances: without
        // FILE_FLAG_FIRST_PIPE_INSTANCE the broker's own create would succeed
        // as a second instance and the squatter could race the client.
        let squatter = unsafe {
            CreateNamedPipeW(
                name_wide.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_WAIT,
                2,
                1024,
                1024,
                5_000,
                null(),
            )
        };
        assert!(
            squatter != INVALID_HANDLE_VALUE,
            "squatter pipe create failed"
        );

        let sid = current_user_sid_string().expect("current user SID");
        let digest = "0".repeat(64);
        let result = serve_once(&name, &sid, &digest);
        unsafe { CloseHandle(squatter) };

        let error = result.expect_err("a squatted pipe name must not be served");
        assert!(
            error.contains("CreateNamedPipeW"),
            "unexpected error: {error}"
        );
    }
}
