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

//! Executable dynamic-export configuration for `maka` and `maka-service`.
//!
//! Restricting exports on Darwin eliminates ~300k unreferenced Rust/Swift
//! symbols from the Mach-O dyld export trie while preserving (and rooting
//! against `-dead_strip`) the exact Node-API / libuv host ABI expected by
//! native `.node` addons loaded through `deno_napi`.
//!
//! Synchronized with `deno_napi 0.191.0` (`generated_symbol_exports_list_*.def`).

use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

const NAPI_HOST_SYMBOLS: &[&str] = &[
    "node_api_create_syntax_error",
    "napi_make_callback",
    "napi_has_named_property",
    "napi_async_destroy",
    "napi_coerce_to_object",
    "napi_get_arraybuffer_info",
    "napi_detach_arraybuffer",
    "napi_get_undefined",
    "napi_reference_unref",
    "napi_fatal_error",
    "napi_open_callback_scope",
    "napi_close_callback_scope",
    "napi_get_value_uint32",
    "napi_create_function",
    "napi_create_arraybuffer",
    "napi_get_value_int64",
    "napi_get_all_property_names",
    "napi_resolve_deferred",
    "napi_is_detached_arraybuffer",
    "napi_create_string_utf8",
    "napi_create_threadsafe_function",
    "node_api_throw_syntax_error",
    "napi_create_bigint_int64",
    "napi_wrap",
    "napi_set_property",
    "napi_get_value_bigint_int64",
    "napi_open_handle_scope",
    "napi_create_error",
    "napi_create_buffer",
    "napi_cancel_async_work",
    "napi_is_exception_pending",
    "napi_acquire_threadsafe_function",
    "napi_create_external",
    "napi_get_threadsafe_function_context",
    "napi_get_null",
    "napi_create_string_utf16",
    "node_api_create_external_string_utf16",
    "napi_get_value_bigint_uint64",
    "napi_module_register",
    "node_module_register",
    "napi_is_typedarray",
    "napi_create_external_buffer",
    "napi_get_new_target",
    "napi_get_instance_data",
    "napi_close_handle_scope",
    "napi_get_value_string_utf16",
    "napi_get_property_names",
    "napi_is_arraybuffer",
    "napi_get_cb_info",
    "napi_define_properties",
    "napi_add_env_cleanup_hook",
    "node_api_get_module_file_name",
    "napi_get_node_version",
    "napi_create_int64",
    "napi_create_double",
    "napi_get_and_clear_last_exception",
    "napi_create_reference",
    "napi_get_typedarray_info",
    "napi_call_threadsafe_function",
    "napi_get_last_error_info",
    "napi_create_array_with_length",
    "napi_coerce_to_number",
    "napi_get_global",
    "napi_is_error",
    "napi_set_instance_data",
    "napi_create_typedarray",
    "napi_throw_type_error",
    "napi_has_property",
    "napi_get_value_external",
    "napi_create_range_error",
    "napi_typeof",
    "napi_ref_threadsafe_function",
    "napi_create_bigint_uint64",
    "napi_get_prototype",
    "napi_adjust_external_memory",
    "napi_release_threadsafe_function",
    "napi_delete_async_work",
    "napi_create_string_latin1",
    "node_api_create_external_string_latin1",
    "napi_is_array",
    "napi_unref_threadsafe_function",
    "napi_throw_error",
    "napi_has_own_property",
    "napi_get_reference_value",
    "napi_remove_env_cleanup_hook",
    "napi_get_value_string_utf8",
    "napi_is_promise",
    "napi_get_boolean",
    "napi_run_script",
    "napi_get_element",
    "napi_get_named_property",
    "napi_get_buffer_info",
    "napi_get_value_bool",
    "napi_reference_ref",
    "napi_create_object",
    "node_api_create_object_with_properties",
    "node_api_create_object_with_named_properties",
    "napi_create_promise",
    "napi_create_int32",
    "napi_escape_handle",
    "napi_open_escapable_handle_scope",
    "napi_throw",
    "napi_get_value_double",
    "napi_set_named_property",
    "napi_call_function",
    "napi_create_date",
    "napi_object_freeze",
    "napi_get_uv_event_loop",
    "napi_get_value_string_latin1",
    "napi_reject_deferred",
    "napi_add_finalizer",
    "napi_create_array",
    "napi_delete_reference",
    "napi_get_date_value",
    "napi_create_dataview",
    "napi_get_version",
    "napi_define_class",
    "napi_is_date",
    "napi_remove_wrap",
    "napi_delete_property",
    "napi_instanceof",
    "napi_create_buffer_copy",
    "node_api_create_buffer_from_arraybuffer",
    "napi_delete_element",
    "napi_object_seal",
    "napi_queue_async_work",
    "napi_get_value_bigint_words",
    "napi_is_buffer",
    "napi_get_array_length",
    "napi_get_property",
    "napi_new_instance",
    "napi_set_element",
    "napi_create_bigint_words",
    "napi_strict_equals",
    "napi_is_dataview",
    "napi_close_escapable_handle_scope",
    "napi_get_dataview_info",
    "napi_get_value_int32",
    "napi_unwrap",
    "napi_throw_range_error",
    "napi_coerce_to_bool",
    "napi_create_uint32",
    "napi_has_element",
    "napi_create_external_arraybuffer",
    "napi_create_symbol",
    "node_api_symbol_for",
    "napi_coerce_to_string",
    "napi_create_type_error",
    "napi_fatal_exception",
    "napi_create_async_work",
    "napi_async_init",
    "node_api_create_property_key_latin1",
    "node_api_create_property_key_utf8",
    "node_api_create_property_key_utf16",
    "napi_type_tag_object",
    "napi_check_object_type_tag",
    "node_api_post_finalizer",
    "napi_add_async_cleanup_hook",
    "napi_remove_async_cleanup_hook",
    "uv_mutex_init",
    "uv_mutex_lock",
    "uv_mutex_unlock",
    "uv_mutex_destroy",
    "uv_async_init",
    "uv_async_send",
    "uv_check_init",
    "uv_check_start",
    "uv_check_stop",
    "uv_close",
    "uv_default_loop",
    "uv_hrtime",
    "uv_idle_init",
    "uv_idle_start",
    "uv_idle_stop",
    "uv_is_active",
    "uv_is_closing",
    "uv_os_getpid",
    "uv_poll_init",
    "uv_poll_init_socket",
    "uv_poll_start",
    "uv_poll_stop",
    "uv_queue_work",
    "uv_ref",
    "uv_unref",
    "uv_has_ref",
    "uv_handle_set_data",
    "uv_handle_get_data",
    "uv_handle_get_loop",
    "uv_handle_get_type",
    "uv_handle_size",
    "uv_cpu_info",
    "uv_free_cpu_info",
    "uv_timer_init",
    "uv_timer_start",
    "uv_timer_stop",
    "uv_timer_set_repeat",
    "uv_timer_get_repeat",
    "uv_timer_again",
    "uv_thread_create",
    "uv_thread_join",
    "uv_thread_self",
    "uv_thread_equal",
    "uv_sem_init",
    "uv_sem_destroy",
    "uv_sem_post",
    "uv_sem_wait",
    "uv_sem_trywait",
    "uv_cond_init",
    "uv_cond_destroy",
    "uv_cond_signal",
    "uv_cond_broadcast",
    "uv_cond_wait",
    "uv_cond_timedwait",
    "uv_strerror",
];

pub(crate) fn configure() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));

    match target_os.as_str() {
        "macos" => {
            let mut list = String::new();
            for sym in NAPI_HOST_SYMBOLS {
                writeln!(&mut list, "_{sym}").expect("format macOS export symbol");
            }
            let path = out_dir.join("napi_exports_macos.def");
            fs::write(&path, list).expect("write macOS N-API export list");
            println!(
                "cargo:rustc-link-arg-bin=maka=-Wl,-exported_symbols_list,{}",
                path.display()
            );
            println!("cargo:rustc-link-arg-bin=maka-service=-Wl,-no_exported_symbols");
        }
        "linux" => {
            // cargo-zigbuild (zig cc) rejects --undefined and
            // --export-dynamic-symbol-list and drops --version-script for
            // executables. A linker script passed via -Wl,-T,<path> with
            // -Wl,--export-dynamic works across zig cc (lld), rust-lld,
            // and GNU ld (BFD): EXTERN(...) roots unreferenced .rcgu.o
            // members from libdeno_napi.rlib before --gc-sections,
            // SECTIONS { .napi_dummy : {} } INSERT AFTER .text; augments the
            // default script instead of replacing it on GNU ld (an empty
            // SECTIONS {} triggers a GNU ld BFD PIE link error, while an empty
            // output section is omitted from the final ELF), and VERSION
            // exports only the N-API host ABI instead of dumping every linked
            // global into .dynsym.
            let mut script = String::from("EXTERN(\n");
            for sym in NAPI_HOST_SYMBOLS {
                writeln!(&mut script, "  {sym}").expect("format Linux EXTERN symbol");
            }
            script.push_str(
                ")\nSECTIONS { .napi_dummy : {} }\nINSERT AFTER .text;\nVERSION {\n  {\n    global:\n",
            );
            for sym in NAPI_HOST_SYMBOLS {
                writeln!(&mut script, "      {sym};").expect("format Linux VERSION symbol");
            }
            script.push_str("    local:\n      *;\n  };\n}\n");
            let path = out_dir.join("napi_exports_linux.ld");
            fs::write(&path, script).expect("write Linux N-API linker script");
            println!("cargo:rustc-link-arg-bin=maka=-Wl,--export-dynamic");
            println!("cargo:rustc-link-arg-bin=maka=-Wl,-T,{}", path.display());
        }
        "windows" if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") => {
            let mut def = String::from("LIBRARY\nEXPORTS\n");
            for sym in NAPI_HOST_SYMBOLS {
                writeln!(&mut def, "  {sym}").expect("format Windows export symbol");
            }
            let path = out_dir.join("napi_exports_windows.def");
            fs::write(&path, def).expect("write Windows N-API export list");
            println!("cargo:rustc-link-arg-bin=maka=/DEF:{}", path.display());
        }
        _ => {}
    }
}
