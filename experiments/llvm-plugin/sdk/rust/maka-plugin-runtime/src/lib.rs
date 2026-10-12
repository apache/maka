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

#![no_std]

use core::sync::atomic::{AtomicU32, Ordering};

const HEAP_SIZE: usize = 64 * 1024;
static mut HEAP: [u8; HEAP_SIZE] = [0; HEAP_SIZE];
static NEXT: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Copy)]
pub struct Response {
    ptr: u32,
    len: u32,
}

pub fn response(bytes: &[u8]) -> Response {
    let ptr = alloc(bytes.len() as u32);
    if ptr == 0 && !bytes.is_empty() {
        return Response { ptr: 0, len: 0 };
    }
    unsafe {
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
    }
    Response {
        ptr,
        len: bytes.len() as u32,
    }
}

pub fn pack(response: Response) -> u64 {
    ((response.ptr as u64) << 32) | response.len as u64
}

#[macro_export]
macro_rules! export_plugin {
    ($manifest:expr, $invoke:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn maka_plugin_manifest_ptr() -> u32 {
            $manifest.as_ptr() as usize as u32
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn maka_plugin_manifest_len() -> u32 {
            $manifest.len() as u32
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn maka_plugin_alloc(size: u32) -> u32 {
            $crate::alloc(size)
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn maka_plugin_free(_ptr: u32, _size: u32) {}

        #[unsafe(no_mangle)]
        pub extern "C" fn maka_plugin_invoke(ptr: u32, len: u32) -> u64 {
            let input = unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) };
            $crate::pack($invoke(input))
        }
    };
}

pub fn alloc(size: u32) -> u32 {
    let aligned = match size.checked_add(7).map(|value| value & !7) {
        Some(value) => value,
        None => return 0,
    };
    let offset = match NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        current.checked_add(aligned).and_then(|next| {
            let next_usize = usize::try_from(next).ok()?;
            (next_usize <= HEAP_SIZE).then_some(next)
        })
    }) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    let base = core::ptr::addr_of!(HEAP) as usize as u32;
    base.saturating_add(offset)
}
