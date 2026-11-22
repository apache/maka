//! Android's shared runtime supports both 4 KB and 16 KB page sizes.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // Both LOAD segments and the end of RELRO must support 16 KB pages,
        // including builds with older NDKs whose linker defaults to 4 KB.
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,common-page-size=16384");
    }
}
