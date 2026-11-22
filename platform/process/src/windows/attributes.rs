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

use super::checked;
use std::{io, marker::PhantomData, mem::size_of, ptr};
use windows_sys::Win32::{Foundation::HANDLE, System::Threading::*};

/// Borrows the exact inheritance and Job lists through CreateProcess.
pub(crate) struct Attributes<'a> {
    storage: Vec<usize>,
    _inputs: PhantomData<&'a [HANDLE]>,
}

impl<'a> Attributes<'a> {
    pub fn stdio(handles: &'a [HANDLE], jobs: &'a [HANDLE]) -> io::Result<Self> {
        let count = 1 + u32::from(!jobs.is_empty());
        let mut bytes = 0;
        // SAFETY: documented size query; then aligned, sufficiently sized storage.
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        unsafe {
            checked(InitializeProcThreadAttributeList(
                storage.as_mut_ptr().cast(),
                count,
                0,
                &mut bytes,
            ))?;
        }
        let mut attributes = Self {
            storage,
            _inputs: PhantomData,
        };
        // SAFETY: caller-owned arrays are borrowed for the lifetime of the list.
        unsafe {
            checked(UpdateProcThreadAttribute(
                attributes.as_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                ptr::null_mut(),
                ptr::null(),
            ))?;
            if !jobs.is_empty() {
                checked(UpdateProcThreadAttribute(
                    attributes.as_ptr(),
                    0,
                    PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                    jobs.as_ptr().cast(),
                    size_of_val(jobs),
                    ptr::null_mut(),
                    ptr::null(),
                ))?;
            }
        }
        Ok(attributes)
    }

    pub fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
}

impl Drop for Attributes<'_> {
    fn drop(&mut self) {
        // SAFETY: only successfully initialized lists construct this owner.
        unsafe {
            DeleteProcThreadAttributeList(self.as_ptr());
        }
    }
}
