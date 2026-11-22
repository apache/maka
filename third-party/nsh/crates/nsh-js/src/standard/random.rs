//! Entropy for portable cryptography comes from the browser's Web Crypto.

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn __nsh_random_fill(ptr: *mut u8, len: usize) -> i32;
}

// getrandom's custom backend is shared by its 0.3 and 0.4 releases. Only
// success is relied on: browser entropy failure becomes a generic error.
#[unsafe(no_mangle)]
unsafe extern "Rust" fn __getrandom_v03_custom(
    ptr: *mut u8,
    len: usize,
) -> Result<(), getrandom_stdlib::Error> {
    // SAFETY: getrandom provides a writable range of exactly `len` bytes;
    // the browser fills that range synchronously before returning.
    if unsafe { __nsh_random_fill(ptr, len) } == 0 {
        Ok(())
    } else {
        Err(getrandom_stdlib::Error::UNSUPPORTED)
    }
}
