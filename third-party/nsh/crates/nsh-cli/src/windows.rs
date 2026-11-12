//! `nsh package --target windows`: a directory with the release runner
//! renamed after the app, its icon embedded as the executable's icon
//! resource, and the bundle next to it; and the same as a `.zip`. Needs no
//! tools: the icon is written into the copied executable with Windows'
//! resource update API. The icon also goes next to the bundle as
//! `nsh\icon.ico`, which the runner shows on its windows when the
//! executable has none (packaged off Windows) and registers for its
//! notifications; the development host gets one made the same way
//! ([`host_args`]). An installer, `<name>-setup.exe`, is compiled from the
//! directory with Inno Setup (`ISCC.exe`) when it is installed, as
//! Longbridge's desktop apps are; its script, `<name>.iss`, is written
//! either way ([`installer`]).

use std::{
    ffi::OsString,
    fs,
    io::Write as _,
    path::Path,
    process::{Command, Stdio},
};

use anyhow::Context as _;

use crate::{
    package::{AppConfig, PackageOptions},
    runtime::{self, Platform},
    ui,
};

/// The id of the icon group resource the runner's window class loads
/// (`LoadIconW(hinstance, 1)` in `nsh-platform-windows`), which Explorer
/// and the taskbar show too (the executable's first icon group).
#[cfg(windows)]
const ICON_ID: u16 = 1;

/// The sizes of the icon's images: the small and large icons at 100% to
/// 200% scaling, and Explorer's largest view.
const ICON_SIZES: [u32; 7] = [16, 20, 24, 32, 40, 48, 64];

/// A directory `<out>/<name>`: the release runner as `<name>.exe` (the
/// app's icon embedded), the bundle and assets in `nsh\` (where the runner
/// looks, next to itself), `nsh\app.json` (the window's title, the app's
/// id and appearance, which the window opens in, and the main window's
/// options); then the same as `<name>.zip`.
pub(crate) fn package(
    options: &PackageOptions<'_>,
    config: &AppConfig,
    name: &str,
    id: &str,
    built: &crate::build::Built,
) -> anyhow::Result<()> {
    let runner = runtime::file(Platform::Windows, true)?;
    // A runner built for another system would package fine and then not
    // start on Windows ("not a valid application").
    let mut magic = [0; 2];
    let is_pe = fs::File::open(&runner)
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut magic))
        .is_ok_and(|()| magic == *b"MZ");
    anyhow::ensure!(is_pe, "{} is not a Windows executable", ui::path(&runner));
    let dir = options.out.join(name);
    let step = ui::Step::start(format!("packaging {}", ui::path(&dir)));
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .with_context(|| format!("remove {} (is the app still running?)", ui::path(&dir)))?;
    }
    let resources = dir.join("nsh");
    fs::create_dir_all(&resources)?;
    let exe = dir.join(format!("{}.exe", file_stem(name)));
    fs::copy(&runner, &exe).with_context(|| format!("copy {}", runner.display()))?;
    // A Rust app has no bundle: the runner mounts its root.
    if !built.rust_root {
        fs::write(resources.join("bundle.nshc"), &built.bytecode)?;
    }
    if let Some(json) = built.capabilities_json() {
        fs::write(resources.join("capabilities.json"), json)?;
    }
    for asset in &built.assets {
        let dest = resources.join("assets").join(&asset.path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&asset.source, &dest).with_context(|| format!("copy {}", asset.path))?;
    }
    let version = config.version.as_deref().unwrap_or("1.0.0");
    let info = crate::package::desktop_app_json(config, name, id, version);
    fs::write(resources.join("app.json"), info.to_string())?;
    if let Some(icon) = config.icon(crate::package::PackageTarget::Windows) {
        let images = icon_images(icon)?;
        fs::write(resources.join("icon.ico"), icon_file(&images))?;
        set_icon(&exe, &images)
            .with_context(|| format!("embed {} in {}", icon.display(), exe.display()))?;
    }
    let archive = options.out.join(format!("{name}.zip"));
    zip_dir(&dir, name, &archive).with_context(|| format!("create {}", archive.display()))?;
    crate::updater::copy_archive(config, name, &archive, options.out)?;
    step.done(format!(
        "packaged {} and {}",
        ui::path(&dir),
        ui::path(&archive)
    ));
    installer(options.out, name, id, version, &dir, &exe)?;
    if options.run {
        Command::new(&exe)
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("launch {}", exe.display()))?;
        ui::done(format!("launched {name}"));
    }
    Ok(())
}

/// Writes `<out>/<name>.iss`, an Inno Setup script installing `dir`, and
/// compiles it to `<out>/<name>-setup.exe` with `ISCC.exe` when Inno Setup
/// is installed (a warning says how otherwise).
///
/// The installer installs for the current user, without elevation, in
/// `%LOCALAPPDATA%\Programs\<name>`, with a Start menu shortcut (carrying
/// the app id as its AppUserModelID, which the taskbar and notifications
/// use) and an entry in Installed apps that uninstalls it. Its AppId is the
/// app's id, so a newer version installs over the older one: the upgrade
/// closes the running app, replaces the files and keeps the app's data
/// (`%APPDATA%`, `%LOCALAPPDATA%\<id>`), which the uninstaller leaves too.
fn installer(
    out: &Path,
    name: &str,
    id: &str,
    version: &str,
    dir: &Path,
    exe: &Path,
) -> anyhow::Result<()> {
    let stem = file_stem(name);
    let script_path = out.join(format!("{stem}.iss"));
    let exe_name = exe
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("{stem}.exe"));
    let icon = dir.join("nsh").join("icon.ico");
    let icon_rel = Path::new(dir.file_name().unwrap_or_default())
        .join("nsh")
        .join("icon.ico");
    let script = inno_script(&InnoApp {
        name,
        id,
        version,
        // Relative to the script, which Inno Setup resolves from its own
        // directory: the script also compiles where the package was copied,
        // packaged off Windows.
        source: &dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| name.to_owned()),
        exe: &exe_name,
        setup: &format!("{stem}-setup"),
        icon: icon
            .is_file()
            .then(|| icon_rel.to_string_lossy().replace('/', "\\")),
    });
    fs::write(&script_path, script).with_context(|| format!("write {}", script_path.display()))?;
    let Some(iscc) = find_iscc() else {
        ui::warn(format!(
            "wrote {} but not the installer: install Inno Setup 6 (https://jrsoftware.org/isinfo.php, or `winget install JRSoftware.InnoSetup`) and package again, or run ISCC.exe on it",
            ui::path(&script_path)
        ));
        return Ok(());
    };
    let setup = out.join(format!("{stem}-setup.exe"));
    let step = ui::Step::start(format!("compiling {}", ui::path(&setup)));
    let output = Command::new(&iscc)
        .arg("/Q")
        .arg(format!("/O{}", out.display()))
        .arg(&script_path)
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("run {}", iscc.display()))?;
    anyhow::ensure!(
        output.status.success(),
        "Inno Setup failed on {}:\n{}{}",
        script_path.display(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    step.done(format!("built the installer {}", ui::path(&setup)));
    Ok(())
}

/// `ISCC.exe`, Inno Setup's compiler: on `PATH`, else where its installer
/// (and winget's, per user) puts it.
fn find_iscc() -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for file in ["ISCC.exe", "iscc.exe", "iscc"] {
                let candidate = dir.join(file);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    let dirs = ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"];
    dirs.iter()
        .filter_map(std::env::var_os)
        .flat_map(|base| {
            let base = std::path::PathBuf::from(base);
            [
                base.join("Inno Setup 6").join("ISCC.exe"),
                base.join("Programs").join("Inno Setup 6").join("ISCC.exe"),
            ]
        })
        .find(|p| p.is_file())
}

/// What the installer script is made of.
struct InnoApp<'a> {
    name: &'a str,
    id: &'a str,
    version: &'a str,
    /// The packaged directory, relative to the script, installed as is.
    source: &'a str,
    /// The executable's file name in it.
    exe: &'a str,
    /// The installer's file name, without `.exe`.
    setup: &'a str,
    /// The app's `.ico`, the installer's icon too.
    icon: Option<String>,
}

/// The Inno Setup script of `app`.
fn inno_script(app: &InnoApp<'_>) -> String {
    // In directive values and section parameters, `{` starts a constant and
    // `"` ends a quoted string.
    fn esc(value: &str) -> String {
        value.replace('{', "{{").replace('"', "\"\"")
    }
    let name = esc(app.name);
    let dir_name = esc(&file_stem(app.name));
    let id = esc(app.id);
    let exe = esc(app.exe);
    let mut s = String::new();
    s.push_str("; Made by `nsh package --target windows`; compile with Inno Setup 6 (ISCC.exe).\n");
    s.push_str("[Setup]\n");
    s.push_str(&format!("AppId={id}\n"));
    s.push_str(&format!("AppName={name}\n"));
    s.push_str(&format!("AppVersion={}\n", esc(app.version)));
    s.push_str(&format!("AppVerName={name} {}\n", esc(app.version)));
    s.push_str(&format!("DefaultDirName={{autopf}}\\{dir_name}\n"));
    s.push_str(&format!("DefaultGroupName={name}\n"));
    s.push_str("DisableProgramGroupPage=yes\n");
    s.push_str("DisableDirPage=auto\n");
    s.push_str("PrivilegesRequired=lowest\n");
    s.push_str("ArchitecturesAllowed=x64compatible\n");
    s.push_str("ArchitecturesInstallIn64BitMode=x64compatible\n");
    s.push_str("MinVersion=10.0.17763\n");
    s.push_str(&format!("OutputBaseFilename={}\n", esc(app.setup)));
    s.push_str("Compression=lzma2\nSolidCompression=yes\nWizardStyle=modern\n");
    s.push_str("CloseApplications=force\n");
    s.push_str(&format!("UninstallDisplayIcon={{app}}\\{exe}\n"));
    s.push_str(&format!("UninstallDisplayName={name}\n"));
    if let Some(icon) = &app.icon {
        s.push_str(&format!("SetupIconFile={}\n", esc(icon)));
    }
    s.push_str("\n[Tasks]\n");
    s.push_str("Name: \"desktopicon\"; Description: \"{cm:CreateDesktopIcon}\"; GroupDescription: \"{cm:AdditionalIcons}\"; Flags: unchecked\n");
    s.push_str("\n[InstallDelete]\n");
    // The bundle and assets of the previous version go: a file it had and
    // this one has not must not stay.
    s.push_str("Type: filesandordirs; Name: \"{app}\\nsh\"\n");
    s.push_str("\n[Files]\n");
    s.push_str(&format!(
        "Source: \"{}\\*\"; DestDir: \"{{app}}\"; Flags: ignoreversion recursesubdirs createallsubdirs\n",
        esc(app.source)
    ));
    s.push_str("\n[Icons]\n");
    s.push_str(&format!(
        "Name: \"{{autoprograms}}\\{dir_name}\"; Filename: \"{{app}}\\{exe}\"; AppUserModelID: \"{id}\"\n"
    ));
    s.push_str(&format!(
        "Name: \"{{autodesktop}}\\{dir_name}\"; Filename: \"{{app}}\\{exe}\"; AppUserModelID: \"{id}\"; Tasks: desktopicon\n"
    ));
    s.push_str("\n[Run]\n");
    s.push_str(&format!(
        "Filename: \"{{app}}\\{exe}\"; Description: \"{{cm:LaunchProgram,{}}}\"; Flags: nowait postinstall skipifsilent\n",
        // Inside a constant, `%` escapes: `%2c` a comma, `%7b` `%7d` braces.
        app.name
            .replace('%', "%25")
            .replace(',', "%2c")
            .replace('{', "%7b")
            .replace('}', "%7d")
            .replace('"', "\"\"")
    ));
    s
}

/// `name` without what Windows does not allow in file names.
fn file_stem(name: &str) -> String {
    let stem: String = name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        .collect();
    // Nor may a name end in a dot or a space.
    let stem = stem.trim_end_matches(['.', ' ']).trim_start();
    if stem.is_empty() {
        "App".to_owned()
    } else {
        stem.to_owned()
    }
}

/// The development host's arguments for the app `entry`: its name
/// (`--name`) and its icon (`--icon`), `nsh.json` `"icon"` made an `.ico`
/// in `work` (`.nsh`). A broken icon
/// warns and leaves the host's.
pub(crate) fn host_args(entry: &Path, work: &Path) -> Vec<OsString> {
    let config = crate::package::read_config(entry).unwrap_or_default();
    let (name, _) = crate::package::name_and_id(entry, &config);
    let mut args = vec!["--name".into(), name.into()];
    if let Some(icon) = config.icon(crate::package::PackageTarget::Windows) {
        let ico = work.join("windows").join("icon.ico");
        match host_icon(icon, &ico) {
            Ok(()) => args.extend(["--icon".into(), ico.into_os_string()]),
            Err(err) => ui::warn(format!("the app's icon: {err:#}")),
        }
    }
    args
}

/// Writes the currently selected `icon` as the `.ico` file `ico`.
fn host_icon(icon: &Path, ico: &Path) -> anyhow::Result<()> {
    // Source timestamps cannot identify the selected image: switching to an
    // older file (or restoring one) must also update the host's icon.
    let images = icon_images(icon)?;
    if let Some(dir) = ico.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(ico, icon_file(&images)).with_context(|| format!("write {}", ico.display()))
}

/// One image of an icon: its size and its data as an `RT_ICON` resource
/// and an `.ico` file hold it (a DIB, or a PNG for 256 pixels).
struct IconImage {
    size: u32,
    data: Vec<u8>,
}

/// The images of the app's icon, from its PNG: DIBs in [`ICON_SIZES`],
/// which every version of Windows reads, and a 256-pixel PNG.
fn icon_images(icon: &Path) -> anyhow::Result<Vec<IconImage>> {
    use image::imageops::FilterType;

    let source = image::open(icon).with_context(|| format!("read {}", icon.display()))?;
    let mut images = Vec::with_capacity(ICON_SIZES.len() + 1);
    for size in ICON_SIZES {
        let rgba = source
            .resize_exact(size, size, FilterType::Lanczos3)
            .into_rgba8();
        images.push(IconImage {
            size,
            data: dib(&rgba),
        });
    }
    let large = source.resize_exact(256, 256, FilterType::Lanczos3);
    let mut png = Vec::new();
    large
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .context("encode the icon")?;
    images.push(IconImage {
        size: 256,
        data: png,
    });
    Ok(images)
}

/// An icon image as a DIB: a `BITMAPINFOHEADER` of twice the height (the
/// color image and the mask), the 32-bit BGRA rows bottom up, then the
/// 1-bit mask, all zeros (with 32 bits, the alpha channel decides).
fn dib(rgba: &image::RgbaImage) -> Vec<u8> {
    let (width, height) = rgba.dimensions();
    let mask_row = width.div_ceil(32) * 4;
    let mut data = Vec::with_capacity((40 + width * height * 4 + mask_row * height) as usize);
    data.extend_from_slice(&40u32.to_le_bytes());
    data.extend_from_slice(&(width as i32).to_le_bytes());
    data.extend_from_slice(&(height as i32 * 2).to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes()); // planes
    data.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    data.extend_from_slice(&[0; 24]); // BI_RGB, sizes, resolutions, palette
    for y in (0..height).rev() {
        for x in 0..width {
            let [r, g, b, a] = rgba.get_pixel(x, y).0;
            data.extend_from_slice(&[b, g, r, a]);
        }
    }
    data.resize(data.len() + (mask_row * height) as usize, 0);
    data
}

/// An `.ico` file of `images`: an `ICONDIR`, an `ICONDIRENTRY` per image
/// (the group resource's entries, with the image's offset in the file in
/// place of its resource id), then the images.
fn icon_file(images: &[IconImage]) -> Vec<u8> {
    let header = 6 + 16 * images.len();
    let size = header + images.iter().map(|i| i.data.len()).sum::<usize>();
    let mut file = Vec::with_capacity(size);
    file.extend_from_slice(&0u16.to_le_bytes());
    file.extend_from_slice(&1u16.to_le_bytes()); // icons
    file.extend_from_slice(&(images.len() as u16).to_le_bytes());
    let mut offset = header;
    for image in images {
        // 0 stands for 256.
        let side = if image.size >= 256 {
            0
        } else {
            image.size as u8
        };
        file.extend_from_slice(&[side, side, 0, 0]);
        file.extend_from_slice(&1u16.to_le_bytes()); // planes
        file.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
        file.extend_from_slice(&(image.data.len() as u32).to_le_bytes());
        file.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += image.data.len();
    }
    for image in images {
        file.extend_from_slice(&image.data);
    }
    file
}

/// The `RT_GROUP_ICON` resource of `images`, whose `RT_ICON` resources
/// have ids 1, 2, ...: a `GRPICONDIR` and a `GRPICONDIRENTRY` per image.
#[cfg(any(windows, test))]
fn icon_group(images: &[IconImage]) -> Vec<u8> {
    let mut group = Vec::with_capacity(6 + 14 * images.len());
    group.extend_from_slice(&0u16.to_le_bytes());
    group.extend_from_slice(&1u16.to_le_bytes()); // icons
    group.extend_from_slice(&(images.len() as u16).to_le_bytes());
    for (index, image) in images.iter().enumerate() {
        // 0 stands for 256.
        let side = if image.size >= 256 {
            0
        } else {
            image.size as u8
        };
        group.extend_from_slice(&[side, side, 0, 0]);
        group.extend_from_slice(&1u16.to_le_bytes()); // planes
        group.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
        group.extend_from_slice(&(image.data.len() as u32).to_le_bytes());
        group.extend_from_slice(&(index as u16 + 1).to_le_bytes());
    }
    group
}

/// Writes `images` into the executable `exe` as icon group [`ICON_ID`].
#[cfg(windows)]
fn set_icon(exe: &Path, images: &[IconImage]) -> anyhow::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;

    use windows_sys::Win32::{
        Foundation::{FALSE, TRUE},
        System::LibraryLoader::{BeginUpdateResourceW, EndUpdateResourceW, UpdateResourceW},
    };

    // `MAKEINTRESOURCE`: small integers in place of names.
    const RT_ICON: u16 = 3;
    const RT_GROUP_ICON: u16 = 14;
    // LANG_NEUTRAL, SUBLANG_NEUTRAL: the one the loader falls back to.
    const LANGUAGE: u16 = 0;

    let path: Vec<u16> = exe.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: `path` is a NUL-terminated wide string; the handle is ended
    // below on every path.
    let update = unsafe { BeginUpdateResourceW(path.as_ptr(), FALSE) };
    if update.is_null() {
        return Err(std::io::Error::last_os_error()).context("BeginUpdateResourceW");
    }
    let resource = |kind: u16, id: u16, data: &[u8]| {
        // SAFETY: integer resource types and names (`MAKEINTRESOURCE`), and
        // `data` alive for the call, which copies it.
        let ok = unsafe {
            UpdateResourceW(
                update,
                kind as usize as *const u16,
                id as usize as *const u16,
                LANGUAGE,
                data.as_ptr().cast(),
                data.len() as u32,
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    };
    let mut result = Ok(());
    for (index, image) in images.iter().enumerate() {
        result = result.and_then(|()| resource(RT_ICON, index as u16 + 1, &image.data));
    }
    result = result.and_then(|()| resource(RT_GROUP_ICON, ICON_ID, &icon_group(images)));
    let discard = if result.is_ok() { FALSE } else { TRUE };
    // SAFETY: the handle from `BeginUpdateResourceW`, ended once.
    let ended = unsafe { EndUpdateResourceW(update, discard) } != 0;
    result.context("UpdateResourceW")?;
    if !ended {
        return Err(std::io::Error::last_os_error()).context("EndUpdateResourceW");
    }
    Ok(())
}

/// Off Windows there is no API to write the resources: Explorer shows the
/// executable with the default icon, and its windows show `nsh\icon.ico`.
#[cfg(not(windows))]
fn set_icon(exe: &Path, _images: &[IconImage]) -> anyhow::Result<()> {
    ui::warn(format!(
        "{} has the default icon in Explorer: icons are embedded when packaging on Windows (its windows and notifications show the app's)",
        ui::path(exe)
    ));
    Ok(())
}

/// Zips `dir` into `archive`, its entries under `<root>/`.
fn zip_dir(dir: &Path, root: &str, archive: &Path) -> anyhow::Result<()> {
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    let _ = fs::remove_file(archive);
    let mut zip = ZipWriter::new(fs::File::create(archive)?);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut pending = vec![(dir.to_path_buf(), root.to_owned())];
    while let Some((dir, prefix)) = pending.pop() {
        zip.add_directory(format!("{prefix}/"), options)?;
        let mut entries: Vec<_> = fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
        // The same archive for the same files.
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
            if entry.file_type()?.is_dir() {
                pending.push((entry.path(), name));
            } else {
                zip.start_file(name, options)?;
                zip.write_all(&fs::read(entry.path())?)?;
            }
        }
    }
    zip.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installer_scripts_install_per_user_and_upgrade_by_id() {
        let script = inno_script(&InnoApp {
            name: "Hopper {Lab}",
            id: "com.example.hopper",
            version: "1.2.0",
            source: "Hopper {Lab}",
            exe: "Hopper {Lab}.exe",
            setup: "Hopper {Lab}-setup",
            icon: None,
        });
        assert!(script.contains("AppId=com.example.hopper\n"));
        assert!(script.contains("AppName=Hopper {{Lab}\n"));
        assert!(script.contains("PrivilegesRequired=lowest\n"));
        assert!(script.contains(r"DefaultDirName={autopf}\Hopper {{Lab}"));
        assert!(script.contains(r#"Source: "Hopper {{Lab}\*""#));
        assert!(script.contains(r#"AppUserModelID: "com.example.hopper""#));
        assert!(script.contains(r#"Type: filesandordirs; Name: "{app}\nsh""#));
        assert!(script.contains("{cm:LaunchProgram,Hopper %7bLab%7d}"));
        assert!(!script.contains("SetupIconFile"));
    }

    #[test]
    fn file_names_drop_what_windows_forbids() {
        assert_eq!(file_stem("Hopper Lab"), "Hopper Lab");
        assert_eq!(file_stem("A/B: C?"), "AB C");
        assert_eq!(file_stem("Dots..."), "Dots");
        assert_eq!(file_stem("<>"), "App");
    }

    #[test]
    fn icon_groups_list_their_images() {
        let images = [
            IconImage {
                size: 16,
                data: vec![0; 10],
            },
            IconImage {
                size: 256,
                data: vec![0; 300],
            },
        ];
        let group = icon_group(&images);
        assert_eq!(group.len(), 6 + 14 * 2);
        assert_eq!(&group[..6], &[0, 0, 1, 0, 2, 0]);
        assert_eq!(&group[6..10], &[16, 16, 0, 0]);
        assert_eq!(&group[14..18], &10u32.to_le_bytes());
        assert_eq!(&group[18..20], &1u16.to_le_bytes());
        // 256 is written as 0.
        assert_eq!(&group[20..24], &[0, 0, 0, 0]);
        assert_eq!(&group[28..32], &300u32.to_le_bytes());
        assert_eq!(&group[32..34], &2u16.to_le_bytes());
    }

    #[test]
    fn icon_files_point_at_their_images() {
        let images = [
            IconImage {
                size: 16,
                data: vec![1; 10],
            },
            IconImage {
                size: 256,
                data: vec![2; 300],
            },
        ];
        let file = icon_file(&images);
        let header = 6 + 16 * 2;
        assert_eq!(file.len(), header + 10 + 300);
        assert_eq!(&file[..6], &[0, 0, 1, 0, 2, 0]);
        assert_eq!(&file[6..10], &[16, 16, 0, 0]);
        assert_eq!(&file[14..18], &10u32.to_le_bytes());
        assert_eq!(&file[18..22], &(header as u32).to_le_bytes());
        // 256 is written as 0.
        assert_eq!(&file[22..26], &[0, 0, 0, 0]);
        assert_eq!(&file[34..38], &((header + 10) as u32).to_le_bytes());
        assert_eq!(file[header], 1);
        assert_eq!(file[header + 10], 2);
    }

    #[test]
    fn dibs_hold_the_image_and_its_mask() {
        let image = image::RgbaImage::from_pixel(16, 16, image::Rgba([1, 2, 3, 4]));
        let data = dib(&image);
        // Header, 16×16 BGRA, 16 mask rows of 4 bytes.
        assert_eq!(data.len(), 40 + 16 * 16 * 4 + 16 * 4);
        assert_eq!(&data[8..12], &32i32.to_le_bytes());
        assert_eq!(&data[40..44], &[3, 2, 1, 4]);
    }

    #[test]
    fn host_icon_changes_when_the_config_selects_an_older_file() {
        let dir = std::env::temp_dir().join(format!("nsh-icon-switch-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let red = dir.join("red.png");
        let blue = dir.join("blue.png");
        image::RgbaImage::from_pixel(32, 32, image::Rgba([255, 0, 0, 255]))
            .save(&red)
            .unwrap();
        image::RgbaImage::from_pixel(32, 32, image::Rgba([0, 0, 255, 255]))
            .save(&blue)
            .unwrap();
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        for source in [&red, &blue] {
            fs::File::options()
                .write(true)
                .open(source)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(old))
                .unwrap();
        }
        let ico = dir.join("icon.ico");
        host_icon(&red, &ico).unwrap();
        let first = fs::read(&ico).unwrap();
        host_icon(&blue, &ico).unwrap();
        let second = fs::read(&ico).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert!(
            first != second,
            "selecting a different existing icon must regenerate the ICO"
        );
    }

    #[test]
    fn zips_hold_the_directory_under_its_name() {
        let dir = std::env::temp_dir().join(format!("nsh-zip-{}", std::process::id()));
        let app = dir.join("Demo");
        fs::create_dir_all(app.join("nsh/assets")).unwrap();
        fs::write(app.join("Demo.exe"), b"binary").unwrap();
        fs::write(app.join("nsh/bundle.nshc"), b"code").unwrap();
        let archive = dir.join("Demo.zip");
        zip_dir(&app, "Demo", &archive).unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(&archive).unwrap()).unwrap();
        let mut names: Vec<String> = zip
            .file_names()
            .map(|name| name.unwrap().into_owned())
            .collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "Demo/",
                "Demo/Demo.exe",
                "Demo/nsh/",
                "Demo/nsh/assets/",
                "Demo/nsh/bundle.nshc"
            ]
        );
        let mut code = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("Demo/nsh/bundle.nshc").unwrap(), &mut code)
            .unwrap();
        assert_eq!(code, "code");
        fs::remove_dir_all(&dir).unwrap();
    }
}
