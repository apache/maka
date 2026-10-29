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

use nsh_platform_windows::windows::{
    Win32::{
        Foundation::ERROR_CANCELLED,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH},
    },
    core::HRESULT,
};

pub(crate) fn choose() -> Result<Option<String>, String> {
    // SAFETY: the blocking worker owns its COM apartment and dialog; the
    // shell-allocated path is released before the apartment is uninitialized.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| error.to_string())?;
        let result = (|| -> Result<Option<String>, String> {
            let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| error.to_string())?;
            let options = dialog.GetOptions().map_err(|error| error.to_string())?;
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM)
                .map_err(|error| error.to_string())?;
            if let Err(error) = dialog.Show(None) {
                return if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                    Ok(None)
                } else {
                    Err(error.to_string())
                };
            }
            let item = dialog.GetResult().map_err(|error| error.to_string())?;
            let path = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|error| error.to_string())?;
            let text = path.to_string().map_err(|error| error.to_string());
            CoTaskMemFree(Some(path.0 as *const _));
            text.map(Some)
        })();
        CoUninitialize();
        result
    }
}
