//! A linkable runtime (feature `linkable`) keeps its symbols and
//! relocations (`--emit-relocs`), so `nsh package` can drop what an app
//! does not use (`nsh-cli` `web/prune.rs`) without a linker of its own.

fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32")
        && std::env::var_os("CARGO_FEATURE_LINKABLE").is_some()
    {
        println!("cargo:rustc-link-arg-cdylib=--emit-relocs");
    }
}
