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

use nsh_engine::{HostCall, JsonValue};
use std::{
    fs::OpenOptions,
    io::{BufWriter, Write},
    mem::{size_of, zeroed},
    path::Path,
    ptr::{null, null_mut},
    sync::{Arc, Mutex},
};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::{Controls::Dialogs::*, HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

static FROZEN: Mutex<Option<Arc<Desktop>>> = Mutex::new(None);
struct Desktop {
    id: uuid::Uuid,
    picture: Picture,
    left: i32,
    top: i32,
}
#[path = "screenshot/annotate.rs"]
mod annotate;
#[path = "screenshot/area.rs"]
mod area;
#[path = "screenshot/shapes.rs"]
mod shapes;
const COPY: usize = 101;
const SAVE: usize = 102;
const CANCEL: usize = 103;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn last_error(action: &str) -> String {
    format!("{action}: {}", std::io::Error::last_os_error())
}

pub(crate) fn capture(call: HostCall) {
    nsh_platform_windows::with_running_view(move |_| {
        std::thread::spawn(move || {
            unsafe {
                SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                windows_sys::Win32::Graphics::Dwm::DwmFlush();
            }
            match snapshot() {
                Ok((picture, left, top)) => {
                    let id = uuid::Uuid::new_v4();
                    *FROZEN.lock().unwrap() = Some(Arc::new(Desktop {
                        id,
                        picture,
                        left,
                        top,
                    }));
                    call.resolve(id.to_string().into());
                }
                Err(error) => call.reject(error),
            }
        });
    });
}

pub(crate) fn release(call: HostCall) {
    let mut frozen = FROZEN.lock().unwrap();
    if frozen
        .as_ref()
        .is_some_and(|frame| Some(frame.id.to_string().as_str()) == call.data()["id"].as_str())
    {
        *frozen = None;
    }
    call.resolve(JsonValue::Null);
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Area {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl Area {
    fn width(self) -> i32 {
        self.right - self.left
    }

    fn height(self) -> i32 {
        self.bottom - self.top
    }

    fn valid(self) -> bool {
        self.width() > 0 && self.height() > 0
    }
}

struct Picture {
    width: i32,
    height: i32,
    pixels: Vec<u8>,
}

impl Picture {
    fn info(&self) -> BITMAPINFO {
        BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: self.width,
                biHeight: -self.height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn crop(&self, area: Area) -> Self {
        let mut pixels = Vec::with_capacity(area.width() as usize * area.height() as usize * 4);
        for row in area.top..area.bottom {
            let start = (row as usize * self.width as usize + area.left as usize) * 4;
            pixels.extend_from_slice(&self.pixels[start..start + area.width() as usize * 4]);
        }
        Self {
            width: area.width(),
            height: area.height(),
            pixels,
        }
    }

    fn write_png(&self, output: impl std::io::Write) -> Result<(), String> {
        let mut encoder = png::Encoder::new(output, self.width as u32, self.height as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        let rgb: Vec<u8> = self
            .pixels
            .chunks_exact(4)
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0]])
            .collect();
        writer
            .write_image_data(&rgb)
            .map_err(|error| error.to_string())?;
        writer.finish().map_err(|error| error.to_string())
    }

    fn copy(&self, _: HWND) -> Result<(), String> {
        use clipboard_win::{Clipboard, formats, raw};
        let mut png = Vec::new();
        self.write_png(&mut png)?;
        let mut dib = vec![0u8; 40];
        dib[..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&self.width.to_le_bytes());
        dib[8..12].copy_from_slice(&self.height.to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        for row in self.pixels.rchunks_exact(self.width as usize * 4) {
            dib.extend_from_slice(row);
        }
        let format =
            raw::register_format("PNG").ok_or("Could not register PNG clipboard format")?;
        let _clipboard = Clipboard::new_attempts(10).map_err(|error| error.to_string())?;
        raw::set(format.get(), &png)
            .and_then(|_| raw::set_without_clear(formats::CF_DIB, &dib))
            .map_err(|error| error.to_string())
    }
}

fn snapshot() -> Result<(Picture, i32, i32), String> {
    // SAFETY: all GDI handles remain on this thread. The bitmap is deselected before reading
    // or deleting it, and all DCs and the bitmap are released on both success and failure.
    unsafe {
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let length = (width as usize)
            .checked_mul(height as usize)
            .and_then(|size| size.checked_mul(4))
            .filter(|size| width > 0 && height > 0 && *size <= 512 * 1024 * 1024)
            .ok_or("The desktop is too large to capture")?;
        let screen = GetDC(null_mut());
        if screen.is_null() {
            return Err(last_error("GetDC"));
        }
        let memory = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let result = (|| {
            if memory.is_null() || bitmap.is_null() {
                return Err(last_error("CreateCompatibleBitmap"));
            }
            let previous = SelectObject(memory, bitmap);
            let copied = BitBlt(
                memory,
                0,
                0,
                width,
                height,
                screen,
                left,
                top,
                SRCCOPY | CAPTUREBLT,
            );
            SelectObject(memory, previous);
            if copied == 0 {
                return Err(last_error("BitBlt"));
            }
            let mut picture = Picture {
                width,
                height,
                pixels: vec![0; length],
            };
            let mut info = picture.info();
            if GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                picture.pixels.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            ) != height
            {
                return Err(last_error("GetDIBits"));
            }
            for pixel in picture.pixels.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
            Ok((picture, left, top))
        })();
        if !bitmap.is_null() {
            DeleteObject(bitmap);
        }
        if !memory.is_null() {
            DeleteDC(memory);
        }
        ReleaseDC(null_mut(), screen);
        result
    }
}

fn show_error(window: HWND, message: &str) {
    // SAFETY: the UTF-16 buffers outlive the synchronous dialog.
    unsafe {
        MessageBoxW(
            window,
            wide(message).as_ptr(),
            wide("Maka screenshot").as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

fn save_picture(window: HWND, picture: &Picture, folder: Option<&Path>) -> Result<bool, String> {
    if let Some(folder) = folder {
        write_picture(
            &folder.join(format!("Maka-{}.png", uuid::Uuid::now_v7())),
            picture,
        )?;
        return Ok(true);
    }
    let mut filename = vec![0u16; 32768];
    let initial = wide("Maka-screenshot.png");
    filename[..initial.len()].copy_from_slice(&initial);
    let filter = wide("PNG image (*.png)\0*.png\0");
    let extension = wide("png");
    // SAFETY: all dialog string buffers outlive the synchronous call and the output buffer
    // matches nMaxFile. The chosen path is read only after a successful return.
    unsafe {
        let mut dialog: OPENFILENAMEW = zeroed();
        dialog.lStructSize = size_of::<OPENFILENAMEW>() as u32;
        dialog.hwndOwner = window;
        dialog.lpstrFilter = filter.as_ptr();
        dialog.lpstrFile = filename.as_mut_ptr();
        dialog.nMaxFile = filename.len() as u32;
        dialog.lpstrDefExt = extension.as_ptr();
        dialog.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
        if GetSaveFileNameW(&mut dialog) == 0 {
            let error = CommDlgExtendedError();
            return if error == 0 {
                Ok(false)
            } else {
                Err(format!("Save dialog: {error}"))
            };
        }
    }
    use std::os::windows::ffi::OsStringExt;
    let length = filename
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(filename.len());
    let path = std::ffi::OsString::from_wide(&filename[..length]);
    write_picture(Path::new(&path), picture)?;
    Ok(true)
}

fn write_picture(path: &Path, picture: &Picture) -> Result<(), String> {
    let temporary = path.with_file_name(format!(".maka-screenshot-{}.tmp", uuid::Uuid::new_v4()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let mut output = BufWriter::new(file);
        picture.write_png(&mut output)?;
        output.flush().map_err(|error| error.to_string())?;
        drop(output);
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

mod pin;
pub(crate) mod stage;
mod surface;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_and_png_preserve_orientation_and_colors() {
        let picture = Picture {
            width: 2,
            height: 2,
            pixels: vec![
                0, 0, 255, 255, 7, 23, 41, 255, 255, 0, 0, 255, 255, 255, 255, 255,
            ],
        };
        let cropped = picture.crop(Area {
            left: 1,
            top: 0,
            right: 2,
            bottom: 2,
        });
        assert_eq!(cropped.pixels, [7, 23, 41, 255, 255, 255, 255, 255]);
        assert_eq!(cropped.info().bmiHeader.biHeight, -2);
        let mut encoded = Vec::new();
        cropped.write_png(&mut encoded).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(encoded))
            .read_info()
            .unwrap();
        let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
        let output = reader.next_frame(&mut decoded).unwrap();
        assert_eq!((output.width, output.height), (1, 2));
        assert_eq!(
            &decoded[..output.buffer_size()],
            &[41, 23, 7, 255, 255, 255]
        );
    }
}
