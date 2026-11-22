//! Runs the Rust application directly on the machine's native backend.

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use nsh_platform_linux as platform;
#[cfg(target_os = "macos")]
use nsh_platform_macos as platform;
#[cfg(target_os = "windows")]
use nsh_platform_windows as platform;

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn main() -> impl std::process::Termination {
    env_logger::init();
    let gallery = gallery_native::registry();
    let assets = asset_directory(&gallery).expect("copy the gallery's registered assets");
    platform::set_ui_sets(vec![nsh_base::registry(), gallery]);
    let theme = nsh_base::Theme::from_json(include_str!("../../theme.json"))
        .expect("the gallery theme is valid");
    // nsh.json's id: the window's and where the app keeps its data.
    let app_id = "com.longbridge.nsh.galleryrs";
    platform::run_app(
        platform::AppSource::Rust(
            platform::Root::of::<gallery_native::Gallery>()
                .tokens(theme.into_tokens())
                .app_id(app_id),
        ),
        platform::AppOptions {
            title: "Rust Gallery".to_owned(),
            asset_base: Some(platform::AssetBase::Directory(assets)),
            app_id: app_id.to_owned(),
            size: (1200, 800),
            ..Default::default()
        },
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!(
    "Run this binary on macOS, Windows or Linux; use nsh run for iOS, Android and the web."
);

// Registered asset URIs keep the layout the development hosts serve them in.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn asset_directory(registry: &nsh_core::element::Registry) -> std::io::Result<std::path::PathBuf> {
    let executable = std::env::current_exe()?;
    let base = executable
        .parent()
        .expect("the executable has a directory")
        .join("gallery-rs-assets");
    for file in registry.asset_files() {
        let destination = base.join(file.path());
        std::fs::create_dir_all(
            destination
                .parent()
                .expect("an asset has a parent directory"),
        )?;
        std::fs::copy(file.source, destination)?;
    }
    Ok(base)
}
