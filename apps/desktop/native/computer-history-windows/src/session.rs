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

/// WTSActive = 0, WTS_SESSIONSTATE_UNLOCK = 1 on supported Windows versions.
fn admits(state: Option<(i32, i32)>) -> bool {
    state == Some((0, 1))
}

#[cfg(windows)]
pub fn available() -> bool {
    use windows::{
        Win32::System::RemoteDesktop::{
            WTS_CURRENT_SESSION, WTSFreeMemory, WTSINFOEXW, WTSQuerySessionInformationW,
            WTSSessionInfoEx,
        },
        core::PWSTR,
    };
    unsafe {
        let mut buffer = PWSTR::null();
        let mut length = 0;
        let result = WTSQuerySessionInformationW(
            None,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut length,
        );
        let state =
            if result.is_ok() && !buffer.is_null() && length as usize >= size_of::<WTSINFOEXW>() {
                let info = &*buffer.0.cast::<WTSINFOEXW>();
                (info.Level == 1).then(|| {
                    let info = info.Data.WTSInfoExLevel1;
                    (info.SessionState.0, info.SessionFlags)
                })
            } else {
                None
            };
        if !buffer.is_null() {
            WTSFreeMemory(buffer.0.cast());
        }
        admits(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_connected_unlocked_session_is_admitted() {
        assert!(admits(Some((0, 1))));
        for state in [
            None,
            Some((0, 0)),
            Some((0, -1)),
            Some((4, 1)),
            Some((1, 1)),
        ] {
            assert!(!admits(state), "{state:?}");
        }
    }
}
