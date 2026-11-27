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

use super::StartMenuApplication;
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, KF_FLAG_DEFAULT,
    SEE_MASK_INVOKEIDLIST, SEE_MASK_NOASYNC, SHCreateItemFromRelativeName, SHELLEXECUTEINFOW,
    SHGetIDListFromObject, SHGetKnownFolderItem, SICHINT_CANONICAL, SIGDN, SIGDN_NORMALDISPLAY,
    SIGDN_PARENTRELATIVEPARSING, ShellExecuteExW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{HSTRING, Result};

mod running;

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: with_folder initialized COM on this thread before creating the guard.
        unsafe { CoUninitialize() };
    }
}

fn with_folder<T>(work: impl FnOnce(&IShellItem) -> Result<T>) -> std::result::Result<T, String> {
    // SAFETY: COM and all shell interfaces stay on this blocking worker thread.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| error.to_string())?;
    let _apartment = Apartment;
    unsafe { SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None) }
        .and_then(|folder| work(&folder))
        .map_err(|error| format!("Windows Applications folder: {error}"))
}

fn display_name(item: &IShellItem, kind: SIGDN) -> Result<String> {
    // SAFETY: the shell returns a terminated string owned by the COM task allocator.
    unsafe {
        let name = item.GetDisplayName(kind)?;
        let text = name.to_string();
        CoTaskMemFree(Some(name.0.cast()));
        Ok(text?)
    }
}

pub(super) fn applications() -> std::result::Result<Vec<StartMenuApplication>, String> {
    with_folder(|folder| {
        // SAFETY: the enumerator and its items are used in the folder's apartment.
        let items: IEnumShellItems = unsafe { folder.BindToHandler(None, &BHID_EnumItems)? };
        let mut found = Vec::new();
        loop {
            let mut next = [None];
            unsafe { items.Next(&mut next, None)? };
            let [Some(item)] = next else { break };
            if let (Ok(id), Ok(name)) = (
                display_name(&item, SIGDN_PARENTRELATIVEPARSING),
                display_name(&item, SIGDN_NORMALDISPLAY),
            ) {
                found.push(StartMenuApplication { id, name });
            }
        }
        Ok(found)
    })
}

fn resolve(folder: &IShellItem, id: &str) -> Result<IShellItem> {
    use windows::Win32::Foundation::E_INVALIDARG;
    if id.is_empty() || id.contains('\0') {
        return Err(E_INVALIDARG.into());
    }
    // SAFETY: the parsing name lives through the call. Only direct AppsFolder children may launch.
    unsafe {
        let item: IShellItem = SHCreateItemFromRelativeName(folder, &HSTRING::from(id), None)?;
        if folder.Compare(&item.GetParent()?, SICHINT_CANONICAL.0 as u32)? != 0 {
            return Err(E_INVALIDARG.into());
        }
        Ok(item)
    }
}

pub(super) fn icon_png(id: &str) -> std::result::Result<Vec<u8>, String> {
    use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
    use windows::Win32::Foundation::{E_UNEXPECTED, SIZE};
    use windows::Win32::Graphics::Gdi::{DeleteObject, HPALETTE};
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICImagingFactory,
        WICBitmapInterpolationModeFant, WICBitmapUsePremultipliedAlpha, WICConvertBitmapSource,
    };
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SIIGBF_ICONONLY};
    use windows::core::Interface;

    const SIDE: i32 = 40;
    let (width, height, pixels) = with_folder(|folder| {
        let item: IShellItemImageFactory = resolve(folder, id)?.cast()?;
        // SAFETY: WIC copies the shell-owned pixels before we release the returned GDI bitmap.
        unsafe {
            let imaging: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let handle = item.GetImage(SIZE { cx: SIDE, cy: SIDE }, SIIGBF_ICONONLY)?;
            let bitmap = imaging.CreateBitmapFromHBITMAP(
                handle,
                HPALETTE::default(),
                WICBitmapUsePremultipliedAlpha,
            );
            let _ = DeleteObject(handle.into());
            let source = WICConvertBitmapSource(&GUID_WICPixelFormat32bppRGBA, &bitmap?)?;
            let (mut width, mut height) = (0, 0);
            source.GetSize(&mut width, &mut height)?;
            if width == 0 || height == 0 {
                return Err(E_UNEXPECTED.into());
            }
            let longest = width.max(height);
            let source = if longest > SIDE as u32 {
                let scale = |size: u32| {
                    ((u64::from(size) * SIDE as u64 / u64::from(longest)) as u32).max(1)
                };
                (width, height) = (scale(width), scale(height));
                let scaler = imaging.CreateBitmapScaler()?;
                scaler.Initialize(&source, width, height, WICBitmapInterpolationModeFant)?;
                scaler.cast()?
            } else {
                source
            };
            let mut pixels = vec![0; (width * height * 4) as usize];
            source.CopyPixels(std::ptr::null(), width * 4, &mut pixels)?;
            Ok((width, height, pixels))
        }
    })?;
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(&pixels, width, height, ExtendedColorType::Rgba8)
        .map_err(|error| error.to_string())?;
    Ok(png)
}

pub(super) fn open(id: &str) -> std::result::Result<(), String> {
    with_folder(|folder| {
        let item = resolve(folder, id)?;
        // SAFETY: the absolute PIDL stays live through synchronous shell dispatch.
        unsafe {
            let pidl = SHGetIDListFromObject(&item)?;
            let mut info = SHELLEXECUTEINFOW {
                cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
                fMask: SEE_MASK_INVOKEIDLIST | SEE_MASK_NOASYNC,
                lpIDList: pidl.cast(),
                nShow: SW_SHOWNORMAL.0,
                ..Default::default()
            };
            let result = ShellExecuteExW(&mut info);
            CoTaskMemFree(Some(pidl.cast()));
            result
        }
    })
}

fn string_property(
    item: &IShellItem,
    key: &windows::Win32::Foundation::PROPERTYKEY,
) -> Result<Option<String>> {
    use windows::Win32::Foundation::{ERROR_NOT_FOUND, TYPE_E_ELEMENTNOTFOUND};
    use windows::Win32::UI::Shell::IShellItem2;
    use windows::core::Interface;
    let item: IShellItem2 = item.cast()?;
    // SAFETY: GetString returns a COM-allocated terminated string for this shell property.
    let value = match unsafe { item.GetString(key) } {
        Ok(value) => value,
        Err(error)
            if error.code() == TYPE_E_ELEMENTNOTFOUND
                || error.code() == ERROR_NOT_FOUND.to_hresult() =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let text = unsafe { value.to_string() };
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    Ok(Some(text?).filter(|text| !text.is_empty()))
}

fn file_path(item: &IShellItem) -> Result<Option<String>> {
    use windows::Win32::Storage::EnhancedStorage::PKEY_Link_TargetParsingPath;
    Ok(string_property(item, &PKEY_Link_TargetParsingPath)?
        .filter(|path| std::path::Path::new(path).is_absolute()))
}

fn targets(id: &str) -> std::result::Result<(Option<String>, Option<running::Instance>), String> {
    use windows::Win32::Storage::EnhancedStorage::PKEY_Link_Arguments;
    use windows::Win32::Storage::EnhancedStorage::PKEY_Link_TargetParsingPath;
    let (target, arguments) = with_folder(|folder| {
        let item = resolve(folder, id)?;
        Ok((
            string_property(&item, &PKEY_Link_TargetParsingPath)?,
            string_property(&item, &PKEY_Link_Arguments)?,
        ))
    })?;
    let identity = running::Identity::for_target(id, target.as_deref(), arguments.as_deref())?;
    let instance = match identity {
        Some(identity) => running::find(identity)?,
        None => None,
    };
    let path = target.filter(|path| std::path::Path::new(path).is_absolute());
    Ok((path, instance))
}

pub(super) fn actions(id: &str) -> std::result::Result<super::StartMenuActions, String> {
    let (path, instance) = targets(id)?;
    let instance = instance.map(|app| app.token);
    Ok(super::StartMenuActions { path, instance })
}

pub(super) fn act(id: &str, action: &str, token: Option<&str>) -> std::result::Result<(), String> {
    use windows::Win32::UI::Shell::{SHCreateItemFromParsingName, SHOpenFolderAndSelectItems};
    let action = match action {
        "minimize" => running::Action::Minimize,
        "restart" => running::Action::Restart,
        "quit" => running::Action::Quit,
        "forceQuit" => running::Action::ForceQuit,
        "reveal" => {
            return with_folder(|folder| {
                let item = resolve(folder, id)?;
                let target = match file_path(&item)? {
                    Some(path) => unsafe {
                        SHCreateItemFromParsingName(&HSTRING::from(path), None)?
                    },
                    None => item,
                };
                // SAFETY: with zero children the shell selects the item identified by the absolute PIDL.
                unsafe {
                    let pidl = SHGetIDListFromObject(&target)?;
                    let result = SHOpenFolderAndSelectItems(pidl, None, 0);
                    CoTaskMemFree(Some(pidl.cast()));
                    result
                }
            });
        }
        _ => return Err("Unknown Windows application action".into()),
    };
    let instance = targets(id)?
        .1
        .filter(|app| Some(app.token.as_str()) == token)
        .ok_or("The selected application instance is no longer available.")?;
    instance.act(action)?;
    if action == running::Action::Restart {
        open(id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_standalone_executables_and_packaged_apps_have_process_actions() {
        use running::Identity;
        let executable = std::env::current_exe().unwrap();
        let path = executable.to_str().unwrap();
        let package = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
        assert!(matches!(
            Identity::for_target("Microsoft.AutoGenerated.{guid}", Some(path), None).unwrap(),
            Some(Identity::Executable(_))
        ));
        assert!(matches!(
            Identity::for_target(package, None, None).unwrap(),
            Some(Identity::AppId(_))
        ));
        for (id, target, args) in [
            (package, Some(path), Some("/7")),
            (package, None, Some("/7")),
            (package, Some(r"C:\\Windows\\eventvwr.msc"), None),
            (package, Some("https://example.org"), None),
            ("https://example.org", None, None),
            ("Microsoft.AutoGenerated.{guid}", None, None),
        ] {
            assert!(Identity::for_target(id, target, args).unwrap().is_none());
        }
    }

    #[test]
    fn start_menu_search_results_resolve_to_named_applications() {
        let apps = applications().unwrap();
        assert!(!apps.is_empty());
        let icon = apps
            .iter()
            .find_map(|app| icon_png(&app.id).ok())
            .expect("an installed application has an icon");
        let decoded = image::load_from_memory_with_format(&icon, image::ImageFormat::Png).unwrap();
        assert!((1..=40).contains(&decoded.width()) && (1..=40).contains(&decoded.height()));
        with_folder(|folder| {
            for app in &apps {
                let item = resolve(folder, &app.id)?;
                assert!(!app.name.is_empty());
                assert_eq!(display_name(&item, SIGDN_NORMALDISPLAY)?, app.name);
                if let Some(path) = file_path(&item)? {
                    assert!(std::path::Path::new(&path).is_absolute());
                }
            }
            assert!(resolve(folder, "shell:Desktop").is_err());
            Ok(())
        })
        .unwrap();
        assert!(act(&apps[0].id, "restart", Some("stale-instance")).is_err());
    }
}
