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

use deno_core::{extension, op2};
use deno_error::JsErrorBox;

extension!(
    maka_automation_node_host,
    ops = [
        op_bootstrap_color_depth,
        op_create_worker,
        op_current_thread_cpu_usage
    ],
    lazy_loaded_esm = ["ext:runtime/98_global_scope_shared.js" = {
        source =
            "export const windowOrWorkerGlobalScope = { console: { value: globalThis.console } };"
    },],
    // Deno’s VM context ops expect a context in the CLI startup snapshot.
    middleware = |op| match op.name {
        "op_vm_create_context" | "op_vm_create_context_without_contextify" => {
            op.with_implementation_from(&op_automation_vm_context())
        }
        _ => op,
    },
);

#[op2(fast)]
fn op_bootstrap_color_depth() -> i32 {
    1
}

#[op2(nofast)]
fn op_create_worker() -> Result<(), JsErrorBox> {
    Err(JsErrorBox::generic(
        "Creating workers is unavailable in the embedded automation runtime",
    ))
}

#[op2(nofast)]
fn op_automation_vm_context() -> Result<(), JsErrorBox> {
    Err(JsErrorBox::generic(
        "Creating node:vm contexts is unavailable in the embedded automation runtime",
    ))
}

#[op2(fast)]
fn op_current_thread_cpu_usage(#[buffer] out: &mut [f64]) -> Result<(), JsErrorBox> {
    if let [user, system, ..] = out {
        (*user, *system) = thread_cpu_usage().map_err(JsErrorBox::from_err)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn thread_cpu_usage() -> std::io::Result<(f64, f64)> {
    let mut usage = std::mem::MaybeUninit::<libc::thread_basic_info>::uninit();
    let mut count = libc::THREAD_BASIC_INFO_COUNT;
    // SAFETY: This borrows the current pthread's Mach port. thread_info initializes usage on success.
    let status = unsafe {
        libc::thread_info(
            libc::pthread_mach_thread_np(libc::pthread_self()),
            libc::THREAD_BASIC_INFO as u32,
            usage.as_mut_ptr().cast(),
            &mut count,
        )
    };
    if status != libc::KERN_SUCCESS {
        return Err(std::io::Error::other(format!(
            "thread_info: Mach error {status}"
        )));
    }
    let usage = unsafe { usage.assume_init() };
    let micros = |value: libc::time_value_t| {
        f64::from(value.seconds) * 1_000_000.0 + f64::from(value.microseconds)
    };
    Ok((micros(usage.user_time), micros(usage.system_time)))
}

#[cfg(target_os = "linux")]
fn thread_cpu_usage() -> std::io::Result<(f64, f64)> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage initializes usage on success.
    if unsafe { libc::getrusage(libc::RUSAGE_THREAD, usage.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let usage = unsafe { usage.assume_init() };
    let micros = |value: libc::timeval| (value.tv_sec as f64) * 1_000_000.0 + value.tv_usec as f64;
    Ok((micros(usage.ru_utime), micros(usage.ru_stime)))
}

#[cfg(windows)]
fn thread_cpu_usage() -> std::io::Result<(f64, f64)> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadTimes};

    let mut created = std::mem::MaybeUninit::<FILETIME>::uninit();
    let mut exited = std::mem::MaybeUninit::<FILETIME>::uninit();
    let mut system = std::mem::MaybeUninit::<FILETIME>::uninit();
    let mut user = std::mem::MaybeUninit::<FILETIME>::uninit();
    // SAFETY: GetThreadTimes initializes the four time values on success.
    if unsafe {
        GetThreadTimes(
            GetCurrentThread(),
            created.as_mut_ptr(),
            exited.as_mut_ptr(),
            system.as_mut_ptr(),
            user.as_mut_ptr(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let micros = |value: FILETIME| {
        ((u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)) as f64 / 10.0
    };
    Ok(unsafe { (micros(user.assume_init()), micros(system.assume_init())) })
}
