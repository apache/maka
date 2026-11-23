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

use super::{ClipboardEntry, HistoryChange, MAX_CLIPBOARD_TEXT, STANDARD};
use base64::Engine;
use clipboard_win::{Clipboard, formats, is_format_avail, raw};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, codecs::bmp::BmpDecoder};
use std::{io::Cursor, path::Path};

const MAX_BINARY: usize = 16 * 1024 * 1024;
const MAX_PIXELS_BYTES: usize = 64 * 1024 * 1024;
const TEXT: &str = "public.utf8-plain-text";
const FILES: &str = "public.file-url";
const PNG: &str = "public.png";
const PDF: &str = "com.adobe.pdf";
const ENCODED: &[(&str, &str)] = &[
    (PDF, "Portable Document Format"),
    (PDF, "application/pdf"),
    (PNG, "PNG"),
    (PNG, "image/png"),
    ("public.jpeg", "JFIF"),
    ("public.jpeg", "image/jpeg"),
    ("com.compuserve.gif", "GIF"),
    ("org.webmproject.webp", "image/webp"),
];

fn registered(name: &str) -> Result<u32, String> {
    raw::register_format(name)
        .map(|id| id.get())
        .ok_or_else(|| format!("Could not register clipboard format {name}."))
}

fn private() -> Result<bool, String> {
    for name in [
        "ExcludeClipboardContentFromMonitorProcessing",
        "Clipboard Viewer Ignore",
    ] {
        if is_format_avail(registered(name)?) {
            return Ok(true);
        }
    }
    let flag = registered("CanIncludeInClipboardHistory")?;
    let mut value = [0; 4];
    Ok(is_format_avail(flag)
        && !(raw::get(flag, &mut value) == Ok(4) && u32::from_le_bytes(value) == 1))
}

fn fits(format: u32, limit: usize) -> bool {
    raw::size(format).is_some_and(|size| size.get() <= limit)
}

enum Copy {
    Text(String),
    Files(Vec<String>),
    Encoded(&'static str, Vec<u8>),
    Dib(Vec<u8>),
}

fn snapshot() -> Result<Option<Copy>, String> {
    if private()? {
        return Ok(None);
    }
    if is_format_avail(formats::CF_HDROP) {
        if !fits(formats::CF_HDROP, 1024 * 1024) {
            return Ok(None);
        }
        let mut paths = Vec::new();
        raw::get_file_list(&mut paths).map_err(|error| error.to_string())?;
        return Ok((!paths.is_empty()).then_some(Copy::Files(paths)));
    }
    for &(kind, name) in ENCODED {
        let format = registered(name)?;
        if is_format_avail(format) && fits(format, MAX_BINARY) {
            let mut bytes = Vec::new();
            raw::get_vec(format, &mut bytes).map_err(|error| error.to_string())?;
            return Ok(Some(Copy::Encoded(kind, bytes)));
        }
    }
    for format in [formats::CF_DIB, formats::CF_DIBV5] {
        if is_format_avail(format) && fits(format, MAX_PIXELS_BYTES) {
            let mut bytes = Vec::new();
            raw::get_vec(format, &mut bytes).map_err(|error| error.to_string())?;
            return Ok(Some(Copy::Dib(bytes)));
        }
    }
    if is_format_avail(formats::CF_UNICODETEXT)
        && fits(formats::CF_UNICODETEXT, (MAX_CLIPBOARD_TEXT + 1) * 2 + 16)
    {
        let text: String =
            clipboard_win::get(formats::Unicode).map_err(|error| error.to_string())?;
        return Ok(
            (text.len() <= MAX_CLIPBOARD_TEXT && !text.trim().is_empty())
                .then_some(Copy::Text(text)),
        );
    }
    Ok(None)
}

fn encode(image: &DynamicImage, format: ImageFormat) -> image::ImageResult<Vec<u8>> {
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, format)?;
    Ok(bytes.into_inner())
}

fn bounded(decoder: impl ImageDecoder) -> Option<DynamicImage> {
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > (MAX_PIXELS_BYTES / 4) as u64
        || decoder.total_bytes() > MAX_PIXELS_BYTES as u64
    {
        return None;
    }
    DynamicImage::from_decoder(decoder).ok()
}

fn decode(bytes: &[u8]) -> Option<DynamicImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_PIXELS_BYTES as u64);
    reader.limits(limits);
    bounded(reader.into_decoder().ok()?)
}

fn entry(copy: Copy) -> Option<ClipboardEntry> {
    let mut paths = Vec::new();
    let mut picture = None;
    let (format, data) = match copy {
        Copy::Text(text) => (TEXT, text),
        Copy::Files(files) => {
            paths = files;
            (FILES, String::new())
        }
        Copy::Encoded(kind, bytes) => {
            if kind != PDF {
                picture = decode(&bytes);
            }
            (kind, STANDARD.encode(bytes))
        }
        Copy::Dib(bytes) => {
            let image = bounded(BmpDecoder::new_without_file_header(Cursor::new(bytes)).ok()?)?;
            let png = encode(&image, ImageFormat::Png).ok()?;
            if png.len() > MAX_BINARY {
                return None;
            }
            picture = Some(image);
            (PNG, STANDARD.encode(png))
        }
    };
    let preview = |side: u32| {
        let image = picture.as_ref()?;
        let thumb = image.thumbnail(side.min(image.width()), side.min(image.height()));
        Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(encode(&thumb, ImageFormat::Png).ok()?)
        ))
    };
    Some(ClipboardEntry {
        format: format.into(),
        data,
        paths,
        thumbnail: preview(40),
        preview: preview(640),
        dimensions: picture
            .as_ref()
            .map(|image| format!("{} × {}", image.width(), image.height())),
    })
}

pub(super) fn read(seen: Option<f64>) -> Result<HistoryChange, String> {
    let sequence = || raw::seq_num().map_or(0.0, |value| f64::from(value.get()));
    let change = sequence();
    let empty = |change| HistoryChange {
        change,
        entry: None,
    };
    let Some(previous) = seen else {
        return Ok(empty(change));
    };
    if previous == change {
        return Ok(empty(change));
    }
    let Ok(board) = Clipboard::new() else {
        return Ok(empty(previous));
    };
    let copy = snapshot()?;
    let change = sequence();
    drop(board);
    Ok(HistoryChange {
        change,
        entry: copy.and_then(entry),
    })
}

pub(super) fn write(entry: ClipboardEntry) -> Result<(), String> {
    let open = || Clipboard::new_attempts(10).map_err(|error| format!("Open clipboard: {error}"));
    match entry.format.as_str() {
        TEXT if entry.data.len() <= MAX_CLIPBOARD_TEXT && !entry.data.contains('\0') => {
            let _board = open()?;
            raw::set_string(&entry.data)
        }
        FILES => {
            if entry.paths.is_empty()
                || entry
                    .paths
                    .iter()
                    .any(|path| !Path::new(path).is_absolute() || !Path::new(path).exists())
            {
                return Err("A copied file is no longer available.".into());
            }
            let _board = open()?;
            raw::set_file_list_with(&entry.paths, clipboard_win::options::DoClear)
        }
        kind if ENCODED.iter().any(|&(format, _)| format == kind) => {
            if entry.data.len() > MAX_BINARY.div_ceil(3) * 4 {
                return Err("Clipboard item is too large.".into());
            }
            let bytes = STANDARD
                .decode(entry.data)
                .map_err(|error| error.to_string())?;
            if bytes.is_empty() || bytes.len() > MAX_BINARY {
                return Err("Invalid clipboard item size.".into());
            }
            let bmp = (kind != PDF)
                .then(|| decode(&bytes))
                .flatten()
                .and_then(|image| encode(&image, ImageFormat::Bmp).ok());
            let formats = ENCODED
                .iter()
                .filter(|&&(format, _)| format == kind)
                .map(|&(_, name)| registered(name))
                .collect::<Result<Vec<_>, _>>()?;
            let _board = open()?;
            raw::set(formats[0], &bytes).map_err(|error| error.to_string())?;
            for &alias in &formats[1..] {
                raw::set_without_clear(alias, &bytes).map_err(|error| error.to_string())?;
            }
            if let Some(bmp) = bmp {
                raw::set_without_clear(formats::CF_DIB, &bmp[14..])
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        _ => return Err("Unsupported clipboard item.".into()),
    }
    .map_err(|error| format!("Restore clipboard: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::StationsAndDesktops::{
        CreateDesktopW, CreateWindowStationW, SetProcessWindowStation, SetThreadDesktop,
    };

    #[test]
    fn isolated_windows_history_round_trip() {
        const CHILD: &str = "MAKA_TEST_CLIPBOARD_STATION";
        if std::env::var_os(CHILD).is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    std::thread::current().name().unwrap(),
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        }
        let name: Vec<u16> = format!("MakaTest-{}\0", std::process::id())
            .encode_utf16()
            .collect();
        // SAFETY: only the child uses this private station and desktop; both names are terminated
        // and the handles remain live until the isolated test process exits.
        unsafe {
            let station = CreateWindowStationW(name.as_ptr(), 0, 0x10000000, std::ptr::null());
            assert!(!station.is_null() && SetProcessWindowStation(station) != 0);
            let desktop = CreateDesktopW(
                name.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                0x10000000,
                std::ptr::null(),
            );
            assert!(!desktop.is_null() && SetThreadDesktop(desktop) != 0);
        }
        let text = "你好 Maka";
        write(entry(Copy::Text(text.into())).unwrap()).unwrap();
        assert!(read(None).unwrap().entry.is_none());
        let copied = read(Some(-1.0)).unwrap();
        assert_eq!(copied.entry.unwrap().data, text);
        assert!(read(Some(copied.change)).unwrap().entry.is_none());
        for (name, flag) in [
            ("CanIncludeInClipboardHistory", 0u32),
            ("ExcludeClipboardContentFromMonitorProcessing", 1),
        ] {
            let board = Clipboard::new().unwrap();
            raw::set_string(text).unwrap();
            raw::set_without_clear(registered(name).unwrap(), &flag.to_le_bytes()).unwrap();
            drop(board);
            assert!(read(Some(-1.0)).unwrap().entry.is_none());
        }
        let temp = tempfile::tempdir().unwrap();
        let paths: Vec<_> = ["文 件.pdf", "b.png"]
            .map(|name| {
                let path = temp.path().join(name);
                std::fs::write(&path, []).unwrap();
                path.to_str().unwrap().to_owned()
            })
            .into();
        write(entry(Copy::Files(paths.clone())).unwrap()).unwrap();
        assert_eq!(read(Some(-1.0)).unwrap().entry.unwrap().paths, paths);
        let bitmap = encode(&DynamicImage::new_rgb8(8, 5), ImageFormat::Bmp).unwrap();
        clipboard_win::set_clipboard(formats::RawData(formats::CF_DIB), &bitmap[14..]).unwrap();
        let copied = read(Some(-1.0)).unwrap().entry.unwrap();
        assert_eq!(copied.dimensions.as_deref(), Some("8 × 5"));
        assert!(copied.thumbnail.is_some() && copied.preview.is_some());
        let png = copied.data.clone();
        write(copied).unwrap();
        assert!(is_format_avail(formats::CF_DIB));
        assert_eq!(read(Some(-1.0)).unwrap().entry.unwrap().data, png);
        write(entry(Copy::Encoded(PDF, b"%PDF-1.4".to_vec())).unwrap()).unwrap();
        assert_eq!(read(Some(-1.0)).unwrap().entry.unwrap().format, PDF);
    }
}
