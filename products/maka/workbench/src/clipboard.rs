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

//! A user-requested clipboard read. Image bytes stay in native upload resources.

use clipboard_rs::{Clipboard, ClipboardContext, ContentFormat, common::RustImage};
use image::{ImageEncoder, codecs::png::PngEncoder};
use maka_ui_support::file::{FileSnapshot, FileSnapshotWriter};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::Arc,
};

pub(crate) enum Selection {
    Files(Vec<String>),
    Image(Arc<FileSnapshot>),
    Text(String),
    Empty,
}

/// Called only by an admitted native worker for an explicit paste gesture.
pub(crate) fn read() -> Result<Selection, String> {
    if crate::attachment_paths::is_wsl() {
        return windows_bridge();
    }
    let clipboard =
        ClipboardContext::new().map_err(|error| format!("Open system clipboard: {error}"))?;
    let formats = clipboard
        .available_formats()
        .map_err(|error| format!("Read clipboard formats: {error}"))?;
    if clipboard.has(ContentFormat::Files) {
        return clipboard
            .get_files()
            .map(Selection::Files)
            .map_err(|error| format!("Read clipboard files: {error}"));
    }
    for (format, name) in [
        ("image/png", "clipboard.png"),
        ("PNG", "clipboard.png"),
        ("public.png", "clipboard.png"),
        ("image/jpeg", "clipboard.jpg"),
        ("JPEG", "clipboard.jpg"),
        ("public.jpeg", "clipboard.jpg"),
        ("image/gif", "clipboard.gif"),
        ("public.gif", "clipboard.gif"),
        ("image/webp", "clipboard.webp"),
    ] {
        let Some(format) = formats.iter().find(|offered| offered.as_str() == format) else {
            continue;
        };
        let bytes = clipboard
            .get_buffer(format)
            .map_err(|error| format!("Read clipboard image: {error}"))?;
        let mut snapshot = image_writer(name)?;
        snapshot
            .write_all(&bytes)
            .map_err(|error| format!("Capture clipboard image: {error}"))?;
        return snapshot
            .finish()
            .map(Selection::Image)
            .map_err(|error| format!("Capture clipboard image: {error}"));
    }
    let image_available = clipboard.has(ContentFormat::Image);
    #[cfg(windows)]
    let image_available =
        image_available || clipboard_win::is_format_avail(clipboard_win::formats::CF_DIBV5);
    if image_available {
        let captured = clipboard
            .get_image()
            .and_then(|image| image.get_dynamic_image())
            .map_err(|error| format!("Read clipboard image: {error}"))?;
        let mut snapshot = image_writer("clipboard.png")?;
        PngEncoder::new(&mut snapshot)
            .write_image(
                captured.as_bytes(),
                captured.width(),
                captured.height(),
                captured.color().into(),
            )
            .map_err(|error| format!("Encode clipboard image: {error}"))?;
        return snapshot
            .finish()
            .map(Selection::Image)
            .map_err(|error| format!("Capture clipboard image: {error}"));
    }
    if clipboard.has(ContentFormat::Text) {
        return clipboard
            .get_text()
            .map(Selection::Text)
            .map_err(|error| format!("Read clipboard text: {error}"));
    }
    Ok(Selection::Empty)
}

fn image_writer(name: &str) -> Result<FileSnapshotWriter, String> {
    FileSnapshotWriter::new(name).map_err(|error| format!("Capture clipboard image: {error}"))
}

// A fixed script, never shell-interpolated paths or image data. A single type
// byte precedes UTF-8 metadata/text or the original encoded PNG stream.
const WINDOWS_READ: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$clipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
$output = [Console]::OpenStandardOutput()
if ($null -eq $clipboard) {
    $output.WriteByte(69)
} elseif ($clipboard.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
    $paths = @($clipboard.GetData([System.Windows.Forms.DataFormats]::FileDrop))
    $output.WriteByte(70)
    [Console]::Write((ConvertTo-Json -Compress -InputObject $paths))
} elseif ($clipboard.GetDataPresent('PNG')) {
    $png = $clipboard.GetData('PNG')
    $output.WriteByte(73)
    if ($png -is [System.IO.Stream]) {
        try {
            if ($png.CanSeek) { $png.Position = 0 }
            $png.CopyTo($output)
        } finally { $png.Dispose() }
    } elseif ($png -is [byte[]]) {
        $output.Write($png, 0, $png.Length)
    } else {
        throw 'The clipboard PNG format did not contain encoded image bytes'
    }
} elseif ($clipboard.GetDataPresent([System.Windows.Forms.DataFormats]::Bitmap)) {
    $image = $clipboard.GetData([System.Windows.Forms.DataFormats]::Bitmap)
    try {
        $output.WriteByte(73)
        $image.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $image.Dispose() }
} elseif ($clipboard.GetDataPresent([System.Windows.Forms.DataFormats]::UnicodeText)) {
    $output.WriteByte(84)
    [Console]::Write([string]$clipboard.GetData([System.Windows.Forms.DataFormats]::UnicodeText))
} else {
    $output.WriteByte(69)
}
$output.Flush()
"#;

fn windows_bridge() -> Result<Selection, String> {
    let mut process = ClipboardProcess(
        Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                WINDOWS_READ,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Start Windows clipboard reader: {error}"))?,
    );
    let output = process.0.stdout.take().expect("piped clipboard output");
    let mut errors = process
        .0
        .stderr
        .take()
        .expect("piped clipboard diagnostics");
    std::thread::scope(|scope| {
        let diagnostics = scope.spawn(move || {
            let mut text = String::new();
            errors.read_to_string(&mut text).map(|_| text)
        });
        let selected = read_windows_stream(BufReader::new(output));
        if selected.is_err() {
            let _ = process.0.kill();
        }
        let status = process
            .0
            .wait()
            .map_err(|error| format!("Wait for Windows clipboard reader: {error}"))?;
        let diagnostics = diagnostics
            .join()
            .map_err(|_| "Windows clipboard diagnostic reader failed".to_owned())?
            .map_err(|error| format!("Read Windows clipboard diagnostics: {error}"))?;
        if !status.success() {
            return Err(match selected {
                Err(error) if !diagnostics.trim().is_empty() => {
                    format!("{error}: {}", diagnostics.trim())
                }
                Err(error) => error,
                Ok(_) => format!("Read Windows clipboard: {}", diagnostics.trim()),
            });
        }
        selected
    })
}

fn read_windows_stream(mut output: impl BufRead) -> Result<Selection, String> {
    let mut kind = [0];
    output
        .read_exact(&mut kind)
        .map_err(|error| format!("Read Windows clipboard result: {error}"))?;
    match kind[0] {
        b'F' => serde_json::from_reader(output)
            .map(Selection::Files)
            .map_err(|error| format!("Read Windows clipboard file list: {error}")),
        b'I' => {
            let mut snapshot = image_writer("clipboard.png")?;
            std::io::copy(&mut output, &mut snapshot)
                .map_err(|error| format!("Capture Windows clipboard image: {error}"))?;
            snapshot
                .finish()
                .map(Selection::Image)
                .map_err(|error| format!("Capture Windows clipboard image: {error}"))
        }
        b'T' => {
            let mut text = String::new();
            output
                .read_to_string(&mut text)
                .map_err(|error| format!("Read Windows clipboard text: {error}"))?;
            Ok(Selection::Text(text))
        }
        b'E' => Ok(Selection::Empty),
        _ => Err("Windows clipboard reader returned an unknown content type".into()),
    }
}

struct ClipboardProcess(Child);

impl Drop for ClipboardProcess {
    fn drop(&mut self) {
        if self.0.try_wait().is_ok_and(|status| status.is_some()) {
            return;
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
