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

use super::{surface::Surface, *};

const RESET: usize = 110;

struct Pin {
    folder: Option<std::path::PathBuf>,
    labels: Labels,
    picture: std::rc::Rc<Picture>,
    surface: Surface,
    scale: f64,
    opacity: u8,
    drag: Option<(POINT, RECT)>,
}

#[derive(serde::Deserialize)]
pub(super) struct Labels {
    title: String,
    copy: String,
    save: String,
    close: String,
}

pub(super) fn open(
    picture: Picture,
    position: POINT,
    labels: Labels,
    folder: Option<std::path::PathBuf>,
) -> Result<(), String> {
    let (ready, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("maka-screenshot-pin".into())
        .spawn(move || {
            if let Err(error) = run(picture, position, labels, folder, &ready) {
                let _ = ready.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
    receiver.recv().map_err(|error| error.to_string())?
}

impl Pin {
    unsafe fn resize(pointer: *mut Self, window: HWND, scale: f64) {
        let scale = scale.clamp(0.1, 4.0);
        // SAFETY: the pin HWND belongs to this thread; dimensions remain positive and bounded.
        unsafe {
            (*pointer).scale = scale;
            let picture = (*pointer).picture.clone();
            SetWindowPos(
                window,
                null_mut(),
                0,
                0,
                (picture.width as f64 * scale).round().max(1.0) as i32,
                (picture.height as f64 * scale).round().max(1.0) as i32,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            InvalidateRect(window, null(), 0);
        }
    }

    unsafe fn command(pointer: *mut Self, window: HWND, command: usize) {
        let picture = unsafe { (*pointer).picture.clone() };
        let result = match command {
            COPY => picture.copy(window),
            SAVE => {
                // SAFETY: the pin is live on its UI thread; release the borrow before the modal dialog.
                let folder = unsafe { (*pointer).folder.clone() };
                save_picture(window, &picture, folder.as_deref()).map(|_| ())
            }
            RESET => {
                unsafe {
                    Self::resize(pointer, window, 1.0);
                }
                Ok(())
            }
            CANCEL => {
                // SAFETY: only this pin is destroyed, without affecting the capture UI or other pins.
                unsafe {
                    DestroyWindow(window);
                }
                Ok(())
            }
            _ => Ok(()),
        };
        if let Err(error) = result {
            show_error(window, &error);
        }
    }
}

unsafe extern "system" fn procedure(
    window: HWND,
    message: u32,
    parameter: WPARAM,
    data: LPARAM,
) -> LRESULT {
    // SAFETY: run owns the Pin Box until its HWND is destroyed and its private loop exits.
    unsafe {
        match message {
            WM_NCCREATE => {
                SetWindowLongPtrW(
                    window,
                    GWLP_USERDATA,
                    (*(data as *const CREATESTRUCTW)).lpCreateParams as isize,
                );
                return 1;
            }
            WM_ERASEBKGND => return 1,
            WM_CLOSE => {
                DestroyWindow(window);
                return 0;
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                return 0;
            }
            WM_NCDESTROY => {
                SetWindowLongPtrW(window, GWLP_USERDATA, 0);
                return DefWindowProcW(window, message, parameter, data);
            }
            _ => {}
        }
        let pointer = GetWindowLongPtrW(window, GWLP_USERDATA) as *mut Pin;
        if pointer.is_null() {
            return DefWindowProcW(window, message, parameter, data);
        }
        match message {
            WM_PAINT => {
                let mut paint: PAINTSTRUCT = zeroed();
                let dc = BeginPaint(window, &mut paint);
                let mut rect = RECT::default();
                GetClientRect(window, &mut rect);
                SetStretchBltMode(dc, HALFTONE);
                SetBrushOrgEx(dc, 0, 0, null_mut());
                StretchBlt(
                    dc,
                    0,
                    0,
                    rect.right,
                    rect.bottom,
                    (*pointer).surface.dc,
                    0,
                    0,
                    (&(*pointer).picture).width,
                    (&(*pointer).picture).height,
                    SRCCOPY,
                );
                EndPaint(window, &paint);
                return 0;
            }
            WM_LBUTTONDOWN => {
                let mut cursor = POINT::default();
                let mut rect = RECT::default();
                GetCursorPos(&mut cursor);
                GetWindowRect(window, &mut rect);
                (*pointer).drag = Some((cursor, rect));
                SetCapture(window);
                return 0;
            }
            WM_MOUSEMOVE => {
                if let Some((start, rect)) = (*pointer).drag {
                    let mut cursor = POINT::default();
                    GetCursorPos(&mut cursor);
                    SetWindowPos(
                        window,
                        null_mut(),
                        rect.left + cursor.x - start.x,
                        rect.top + cursor.y - start.y,
                        0,
                        0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
                return 0;
            }
            WM_LBUTTONUP => {
                (*pointer).drag = None;
                ReleaseCapture();
                return 0;
            }
            WM_CAPTURECHANGED => {
                (*pointer).drag = None;
                return 0;
            }
            WM_LBUTTONDBLCLK => {
                Pin::resize(pointer, window, 1.0);
                return 0;
            }
            WM_MOUSEWHEEL => {
                let delta = (parameter >> 16) as u16 as i16;
                if GetKeyState(VK_CONTROL as i32) < 0 {
                    (*pointer).opacity = ((*pointer).opacity as i32
                        + if delta > 0 { 16 } else { -16 })
                    .clamp(48, 255) as u8;
                    SetLayeredWindowAttributes(window, 0, (*pointer).opacity, LWA_ALPHA);
                } else {
                    Pin::resize(
                        pointer,
                        window,
                        (*pointer).scale * if delta > 0 { 1.1 } else { 1.0 / 1.1 },
                    );
                }
                return 0;
            }
            WM_RBUTTONUP => {
                let menu = CreatePopupMenu();
                if menu.is_null() {
                    show_error(window, &last_error("CreatePopupMenu"));
                    return 0;
                }
                let labels = &(*pointer).labels;
                for (command, label) in [
                    (COPY, format!("{}\tCtrl+C", labels.copy)),
                    (SAVE, format!("{}\tCtrl+S", labels.save)),
                    (RESET, "100%\tCtrl+0".into()),
                    (CANCEL, format!("{}\tEsc", labels.close)),
                ] {
                    AppendMenuW(menu, MF_STRING, command, wide(&label).as_ptr());
                }
                let mut cursor = POINT::default();
                GetCursorPos(&mut cursor);
                SetForegroundWindow(window);
                let command = TrackPopupMenu(
                    menu,
                    TPM_RETURNCMD | TPM_RIGHTBUTTON,
                    cursor.x,
                    cursor.y,
                    0,
                    window,
                    null(),
                );
                DestroyMenu(menu);
                if command != 0 {
                    Pin::command(pointer, window, command as usize);
                }
                return 0;
            }
            WM_KEYDOWN => {
                let control = GetKeyState(VK_CONTROL as i32) < 0;
                match parameter as u16 {
                    VK_ESCAPE => Pin::command(pointer, window, CANCEL),
                    0x43 if control => Pin::command(pointer, window, COPY),
                    0x53 if control => Pin::command(pointer, window, SAVE),
                    0x30 if control => Pin::command(pointer, window, RESET),
                    _ => {}
                }
                return 0;
            }
            WM_SIZE => {
                InvalidateRect(window, null(), 0);
                return 0;
            }
            _ => {}
        }
        DefWindowProcW(window, message, parameter, data)
    }
}

fn run(
    picture: Picture,
    position: POINT,
    labels: Labels,
    folder: Option<std::path::PathBuf>,
    ready: &std::sync::mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    // SAFETY: the independent UI thread owns the picture, its DIB and all window resources.
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let mut pin = Box::new(Pin {
            folder,
            labels,
            surface: Surface::new(&picture)?,
            picture: std::rc::Rc::new(picture),
            scale: 1.0,
            opacity: 255,
            drag: None,
        });
        let class = wide("MakaScreenshotPin");
        let instance = GetModuleHandleW(null());
        let definition = WNDCLASSW {
            style: CS_DBLCLKS,
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            hCursor: LoadCursorW(null_mut(), IDC_SIZEALL),
            lpszClassName: class.as_ptr(),
            ..zeroed()
        };
        if RegisterClassW(&definition) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
            return Err(last_error("Register pin class"));
        }
        let window = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
            class.as_ptr(),
            wide(&pin.labels.title).as_ptr(),
            WS_POPUP,
            position.x,
            position.y,
            pin.picture.width,
            pin.picture.height,
            null_mut(),
            null_mut(),
            instance,
            (&mut *pin as *mut Pin).cast(),
        );
        if window.is_null() {
            return Err(last_error("Create pin window"));
        }
        SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA);
        ShowWindow(window, SW_SHOW);
        SetForegroundWindow(window);
        SetFocus(window);
        let _ = ready.send(Ok(()));
        let mut message: MSG = zeroed();
        loop {
            let status = GetMessageW(&mut message, null_mut(), 0, 0);
            if status == 0 {
                break;
            }
            if status == -1 {
                DestroyWindow(window);
                show_error(null_mut(), &last_error("Pin message loop"));
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        Ok(())
    }
}
