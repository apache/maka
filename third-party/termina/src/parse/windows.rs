// CREDIT (VTE Reader): <https://github.com/wezterm/wezterm/blob/a87358516004a652ad840bc1661bdf65ffc89b43/termwiz/src/input.rs#L676-L885>
// I have dropped the legacy Console API handling however and switched to the `AsciiChar` part of
// the key record. I suspect that Termwiz may be incorrect here as the Microsoft docs say that the
// proper way to read UTF-8 is to use the `A` variant (`ReadConsoleInputA` while WezTerm uses
// `ReadConsoleInputW`) to read a byte.
//
// CREDIT (Console API):
// Most legacy input handling comes from crossterm <https://github.com/crossterm-rs/crossterm/blob/4f08595ef4477de2d504dcced24060ed9e3d582a/src/event/sys/windows/parse.rs>
// with some bits coming from crossterm-winapi <https://github.com/crossterm-rs/crossterm-winapi/blob/49bc68d73e82374224284baf0ba51ed3a29c0d81/src/structs/input.rs>
// The Windows API functions have been converted from winapi to the windows-sys crate.

use super::*;
use windows_sys::Win32::System::Console;

#[cfg(feature = "windows-legacy")]
pub use legacy::cursor_position;

/// Mode to use for reading Windows input events.
///
/// VTE mode asks the Windows console to emit virtual-terminal input and then parses those bytes
/// with [`crate::Parser`]. Legacy mode reads `INPUT_RECORD` values from the classic console API and
/// translates them directly into [`crate::Event`] values.
///
/// [`crate::PlatformTerminal`] uses [`Self::Vte`] by default. The `windows-legacy` feature must be
/// enabled to construct a terminal with a custom input reader mode.
#[derive(PartialEq, Eq, Clone, Copy, Debug)]
pub enum InputReaderMode {
    /// Read input as virtual-terminal escape sequences.
    ///
    /// This is the default mode. It matches Unix terminal input more closely and supports terminal
    /// protocol responses that arrive as escape sequences.
    Vte,

    /// Read input through the classic Windows console API.
    ///
    /// This mode is available only with the `windows-legacy` feature. It can be useful in console
    /// environments where virtual-terminal input is unavailable or unreliable.
    Legacy,
}

impl Parser {
    pub(crate) fn decode_input_records(
        &mut self,
        records: &[Console::INPUT_RECORD],
    ) -> io::Result<()> {
        self.expire_reply_at(Instant::now())?;
        for record in records {
            match record.EventType as u32 {
                Console::KEY_EVENT => {
                    let record = unsafe { record.Event.KeyEvent };
                    match self.mode {
                        InputReaderMode::Vte => {
                            // This skips 'down's. IIRC Termwiz skips 'down's and Crossterm skips
                            // 'up's. If we skip 'up's we don't seem to get key events at all.
                            if record.bKeyDown == 0 {
                                continue;
                            }
                            let byte = unsafe { record.uChar.AsciiChar } as u8;
                            // The zero byte is sent when the input record is not VT.
                            if byte == 0 {
                                continue;
                            }
                            // `read_console_input` uses `ReadConsoleInputA` so we should treat the
                            // key code as a byte and add it to the buffer.
                            self.push_byte(byte, true)?;
                        }
                        InputReaderMode::Legacy => {
                            #[cfg(feature = "windows-legacy")]
                            if let Some(event) =
                                legacy::handle_key_event(record, &mut self.surrogate_buffer)
                            {
                                self.events.push_back(event);
                            }
                        }
                    }
                }
                Console::WINDOW_BUFFER_SIZE_EVENT => {
                    // NOTE: the `WINDOW_BUFFER_SIZE_EVENT` coordinates are one-based, even
                    // though `GetConsoleScreenBufferInfo` is zero-based.

                    use crate::{OneBased, WindowSize};
                    let record = unsafe { record.Event.WindowBufferSizeEvent };
                    let Some(rows) = OneBased::new(record.dwSize.Y as u16) else {
                        continue;
                    };
                    let Some(cols) = OneBased::new(record.dwSize.X as u16) else {
                        continue;
                    };
                    self.events.push_back(Event::WindowResized(WindowSize {
                        rows: rows.get(),
                        cols: cols.get(),
                        pixel_width: None,
                        pixel_height: None,
                    }));
                }
                Console::FOCUS_EVENT => {
                    #[cfg(feature = "windows-legacy")]
                    self.events
                        .push_back(legacy::handle_focus(unsafe { record.Event.FocusEvent }));
                }
                Console::MOUSE_EVENT => {
                    #[cfg(feature = "windows-legacy")]
                    {
                        let record = unsafe { record.Event.MouseEvent };
                        let button_state: legacy::ButtonState = record.dwButtonState.into();
                        let mouse_event =
                            legacy::handle_mouse_event(record, &self.mouse_buttons_pressed);
                        self.mouse_buttons_pressed = legacy::MouseButtonsPressed {
                            left: button_state.left_button(),
                            right: button_state.right_button(),
                            middle: button_state.middle_button(),
                        };
                        if let Some(event) = mouse_event {
                            self.events.push_back(event);
                        }
                    }
                }
                _ => (),
            }
        }
        if self.mode == InputReaderMode::Vte {
            self.process_bytes(false)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::KeyCode;

    fn key_record(byte: u8) -> Console::INPUT_RECORD {
        Console::INPUT_RECORD {
            EventType: Console::KEY_EVENT as u16,
            Event: Console::INPUT_RECORD_0 {
                KeyEvent: Console::KEY_EVENT_RECORD {
                    bKeyDown: 1,
                    wRepeatCount: 1,
                    wVirtualKeyCode: 0,
                    wVirtualScanCode: 0,
                    uChar: Console::KEY_EVENT_RECORD_0 {
                        AsciiChar: byte as i8,
                    },
                    dwControlKeyState: 0,
                },
            },
        }
    }

    #[test]
    fn vte_records_propagate_sticky_budget_errors_without_replaying_tail() {
        let mut parser = Parser::with_mode(InputReaderMode::Vte);
        parser.set_max_pending_bytes(8).unwrap();
        let records: Vec<_> = b"a\x1b[6;2;0000~z"
            .iter()
            .copied()
            .map(key_record)
            .collect();

        assert_eq!(
            parser.decode_input_records(&records).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(parser.pop(), Some(Event::Key(KeyCode::Char('a').into())));
        assert_eq!(parser.pop(), None);
        assert_eq!(
            parser
                .decode_input_records(&[key_record(b'z')])
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(parser.pop(), None);
    }
}

#[cfg(feature = "windows-legacy")]
pub(crate) mod legacy {
    use std::{io, ptr};

    use crate::event::{
        KeyCode, KeyEvent, KeyEventKind, KeyEventState, Modifiers, MouseButton, MouseEvent,
        MouseEventKind,
    };
    use crate::{Event, OneBased};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
    };

    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Console::{
        self, CAPSLOCK_ON, CONSOLE_SCREEN_BUFFER_INFO, DOUBLE_CLICK, FOCUS_EVENT_RECORD,
        FROM_LEFT_1ST_BUTTON_PRESSED, FROM_LEFT_2ND_BUTTON_PRESSED, FROM_LEFT_3RD_BUTTON_PRESSED,
        FROM_LEFT_4TH_BUTTON_PRESSED, KEY_EVENT_RECORD, LEFT_ALT_PRESSED, LEFT_CTRL_PRESSED,
        MOUSE_EVENT_RECORD, MOUSE_HWHEELED, MOUSE_MOVED, MOUSE_WHEELED, RIGHTMOST_BUTTON_PRESSED,
        RIGHT_ALT_PRESSED, RIGHT_CTRL_PRESSED, SHIFT_PRESSED,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyboardLayout, ToUnicodeEx, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE,
        VK_F1, VK_F24, VK_HOME, VK_INSERT, VK_LEFT, VK_MENU, VK_NEXT, VK_NUMPAD0, VK_NUMPAD9,
        VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_TAB, VK_UP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    enum WindowsKeyEvent {
        KeyEvent(KeyEvent),
        Surrogate(u16),
    }

    enum CharCase {
        LowerCase,
        UpperCase,
    }

    #[derive(Debug, Default)]
    pub(crate) struct MouseButtonsPressed {
        pub(crate) left: bool,
        pub(crate) right: bool,
        pub(crate) middle: bool,
    }

    /// The status of the mouse buttons.
    /// The least significant bit corresponds to the leftmost mouse button.
    /// The next least significant bit corresponds to the rightmost mouse button.
    /// The next bit indicates the next-to-leftmost mouse button.
    /// The bits then correspond left to right to the mouse buttons.
    /// A bit is 1 if the button was pressed.
    ///
    /// The state can be one of the following:
    ///
    /// ```
    /// # enum __ {
    /// Release = 0x0000,
    /// /// The leftmost mouse button.
    /// FromLeft1stButtonPressed = 0x0001,
    /// /// The second button from the left.
    /// FromLeft2ndButtonPressed = 0x0004,
    /// /// The third button from the left.
    /// FromLeft3rdButtonPressed = 0x0008,
    /// /// The fourth button from the left.
    /// FromLeft4thButtonPressed = 0x0010,
    /// /// The rightmost mouse button.
    /// RightmostButtonPressed = 0x0002,
    /// /// This button state is not recognized.
    /// Unknown = 0x0021,
    /// /// The wheel was rotated backward, toward the user.
    /// /// This is active only for `MOUSE_WHEELED` from `dwEventFlags`.
    /// Negative = 0x0020,
    /// # }
    /// ```
    ///
    /// [Ms Docs](https://docs.microsoft.com/en-us/windows/console/mouse-event-record-str#members)
    #[derive(PartialEq, Debug, Copy, Clone, Eq)]
    pub(super) struct ButtonState {
        state: i32,
    }

    impl From<u32> for ButtonState {
        #[inline]
        fn from(event: u32) -> Self {
            let state = event as i32;
            ButtonState { state }
        }
    }

    impl ButtonState {
        /// Get whether no buttons are being pressed.
        fn release_button(&self) -> bool {
            self.state == 0
        }

        /// Returns whether the left button was pressed.
        pub(super) fn left_button(&self) -> bool {
            self.state as u32 & FROM_LEFT_1ST_BUTTON_PRESSED != 0
        }

        /// Returns whether the right button was pressed.
        pub(super) fn right_button(&self) -> bool {
            self.state as u32
                & (RIGHTMOST_BUTTON_PRESSED
                    | FROM_LEFT_3RD_BUTTON_PRESSED
                    | FROM_LEFT_4TH_BUTTON_PRESSED)
                != 0
        }

        /// Returns whether the right button was pressed.
        pub(super) fn middle_button(&self) -> bool {
            self.state as u32 & FROM_LEFT_2ND_BUTTON_PRESSED != 0
        }

        /// Returns whether there is a down scroll.
        fn scroll_down(&self) -> bool {
            self.state < 0
        }

        /// Returns whether there is a up scroll.
        fn scroll_up(&self) -> bool {
            self.state > 0
        }

        /// Returns whether there is a horizontal scroll to the right.
        fn scroll_right(&self) -> bool {
            self.state > 0
        }

        /// Returns whether there is a horizontal scroll to the left.
        fn scroll_left(&self) -> bool {
            self.state < 0
        }
    }

    pub(super) fn handle_key_event(
        key_event: KEY_EVENT_RECORD,
        surrogate_buffer: &mut Option<u16>,
    ) -> Option<Event> {
        let windows_key_event = parse_key_event_record(&key_event)?;
        match windows_key_event {
            WindowsKeyEvent::KeyEvent(key_event) => {
                // Discard any buffered surrogate value if another valid key event comes before the
                // next surrogate value.
                *surrogate_buffer = None;
                Some(Event::Key(key_event))
            }
            WindowsKeyEvent::Surrogate(new_surrogate) => {
                let ch = handle_surrogate(surrogate_buffer, new_surrogate)?;
                let modifiers = handle_control_key_state(key_event.dwControlKeyState);
                let key_event = KeyEvent::new(KeyCode::Char(ch), modifiers);
                Some(Event::Key(key_event))
            }
        }
    }

    pub(super) fn handle_focus(record: FOCUS_EVENT_RECORD) -> Event {
        if record.bSetFocus > 0 {
            Event::FocusIn
        } else {
            Event::FocusOut
        }
    }

    fn parse_key_event_record(key_event: &KEY_EVENT_RECORD) -> Option<WindowsKeyEvent> {
        let modifiers = handle_control_key_state(key_event.dwControlKeyState);
        let virtual_key_code = key_event.wVirtualKeyCode as i32;

        // We normally ignore all key release events, but we will make an exception for an Alt key
        // release if it carries a u_char value, as this indicates an Alt code.
        let is_alt_code = virtual_key_code == VK_MENU as i32
            && key_event.bKeyDown != 1
            && unsafe { key_event.uChar.UnicodeChar } != 0;
        if is_alt_code {
            let utf16 = unsafe { key_event.uChar.UnicodeChar };
            match utf16 {
                surrogate @ 0xD800..=0xDFFF => {
                    return Some(WindowsKeyEvent::Surrogate(surrogate));
                }
                unicode_scalar_value => {
                    // Unwrap is safe: We tested for surrogate values above and those are the only
                    // u16 values that are invalid when directly interpreted as unicode scalar
                    // values.
                    let ch = std::char::from_u32(unicode_scalar_value as u32).unwrap();
                    let key_code = KeyCode::Char(ch);
                    let kind = if key_event.bKeyDown == 1 {
                        KeyEventKind::Press
                    } else {
                        KeyEventKind::Release
                    };
                    let key_event = KeyEvent {
                        code: key_code,
                        modifiers,
                        kind,
                        state: KeyEventState::empty(),
                    };
                    return Some(WindowsKeyEvent::KeyEvent(key_event));
                }
            }
        }

        // Don't generate events for numpad key presses when they're producing Alt codes.
        let is_numpad_numeric_key = (VK_NUMPAD0..=VK_NUMPAD9).contains(&(virtual_key_code as u16));
        let is_only_alt_modifier = modifiers.contains(Modifiers::ALT)
            && !modifiers.contains(Modifiers::SHIFT | Modifiers::CONTROL);
        if is_only_alt_modifier && is_numpad_numeric_key {
            return None;
        }

        let parse_result = match virtual_key_code as u16 {
            VK_SHIFT | VK_CONTROL | VK_MENU => None,
            VK_BACK => Some(KeyCode::Backspace),
            VK_ESCAPE => Some(KeyCode::Escape),
            VK_RETURN => Some(KeyCode::Enter),
            VK_F1..=VK_F24 => Some(KeyCode::Function((key_event.wVirtualKeyCode - 111) as u8)),
            VK_LEFT => Some(KeyCode::Left),
            VK_UP => Some(KeyCode::Up),
            VK_RIGHT => Some(KeyCode::Right),
            VK_DOWN => Some(KeyCode::Down),
            VK_PRIOR => Some(KeyCode::PageUp),
            VK_NEXT => Some(KeyCode::PageDown),
            VK_HOME => Some(KeyCode::Home),
            VK_END => Some(KeyCode::End),
            VK_DELETE => Some(KeyCode::Delete),
            VK_INSERT => Some(KeyCode::Insert),
            VK_TAB if modifiers.contains(Modifiers::SHIFT) => Some(KeyCode::BackTab),
            VK_TAB => Some(KeyCode::Tab),
            _ => {
                let utf16 = unsafe { key_event.uChar.UnicodeChar };
                match utf16 {
                    0x00..=0x1f => {
                        // Some key combinations generate either no u_char value or generate control
                        // codes. To deliver back a KeyCode::Char(...) event we want to know which
                        // character the key normally maps to on the user's keyboard layout.
                        // The keys that intentionally generate control codes (ESC, ENTER, TAB, etc.)
                        // are handled by their virtual key codes above.
                        get_char_for_key(key_event).map(KeyCode::Char)
                    }
                    surrogate @ 0xD800..=0xDFFF => {
                        return Some(WindowsKeyEvent::Surrogate(surrogate));
                    }
                    unicode_scalar_value => {
                        // Unwrap is safe: We tested for surrogate values above and those are the only
                        // u16 values that are invalid when directly interpreted as unicode scalar
                        // values.
                        let ch = std::char::from_u32(unicode_scalar_value as u32).unwrap();
                        Some(KeyCode::Char(ch))
                    }
                }
            }
        };

        if let Some(key_code) = parse_result {
            let kind = if key_event.bKeyDown == 1 {
                KeyEventKind::Press
            } else {
                KeyEventKind::Release
            };
            let key_event = KeyEvent {
                code: key_code,
                modifiers,
                kind,
                state: KeyEventState::empty(),
            };
            return Some(WindowsKeyEvent::KeyEvent(key_event));
        }

        None
    }

    fn handle_surrogate(surrogate_buffer: &mut Option<u16>, new_surrogate: u16) -> Option<char> {
        match *surrogate_buffer {
            Some(buffered_surrogate) => {
                *surrogate_buffer = None;
                std::char::decode_utf16([buffered_surrogate, new_surrogate])
                    .next()
                    .unwrap()
                    .ok()
            }
            None => {
                *surrogate_buffer = Some(new_surrogate);
                None
            }
        }
    }

    fn handle_control_key_state(state: u32) -> Modifiers {
        let mut modifier = Modifiers::empty();

        if has_state(state, SHIFT_PRESSED) {
            modifier |= Modifiers::SHIFT;
        }
        if has_state(state, LEFT_CTRL_PRESSED | RIGHT_CTRL_PRESSED) {
            modifier |= Modifiers::CONTROL;
        }
        if has_state(state, LEFT_ALT_PRESSED | RIGHT_ALT_PRESSED) {
            modifier |= Modifiers::ALT;
        }

        modifier
    }

    fn has_state(a: u32, b: u32) -> bool {
        (a & b) != 0
    }

    // Attempts to return the character for a key event accounting for the user's keyboard layout.
    // The returned character (if any) is capitalized (if applicable) based on shift and capslock state.
    // Returns None if the key doesn't map to a character or if it is a dead key.
    // We use the *currently* active keyboard layout (if it can be determined). This layout may not
    // correspond to the keyboard layout that was active when the user typed their input, since console
    // applications get their input asynchronously from the terminal. By the time a console application
    // can process a key input, the user may have changed the active layout. In this case, the character
    // returned might not correspond to what the user expects, but there is no way for a console
    // application to know what the keyboard layout actually was for a key event, so this is our best
    // effort. If a console application processes input in a timely fashion, then it is unlikely that a
    // user has time to change their keyboard layout before a key event is processed.
    fn get_char_for_key(key_event: &KEY_EVENT_RECORD) -> Option<char> {
        let virtual_key_code = key_event.wVirtualKeyCode as u32;
        let virtual_scan_code = key_event.wVirtualScanCode as u32;
        let key_state = [0u8; 256];
        let mut utf16_buf = [0u16; 16];
        let dont_change_kernel_keyboard_state = 0x4;

        // Best-effort attempt at determining the currently active keyboard layout.
        // At the time of writing, this works for a console application running in Windows Terminal, but
        // doesn't work under a Conhost terminal. For Conhost, the window handle returned by
        // GetForegroundWindow() does not appear to actually be the foreground window which has the
        // keyboard layout associated with it (or perhaps it is, but also has special protection that
        // doesn't allow us to query it).
        // When this determination fails, the returned keyboard layout handle will be null, which is an
        // acceptable input for ToUnicodeEx, as that argument is optional. In this case ToUnicodeEx
        // appears to use the keyboard layout associated with the current thread, which will be the
        // layout that was inherited when the console application started (or possibly when the current
        // thread was spawned). This is then unfortunately not updated when the user changes their
        // keyboard layout in the terminal, but it's what we get.
        let active_keyboard_layout = unsafe {
            let foreground_window = GetForegroundWindow();
            let foreground_thread =
                GetWindowThreadProcessId(foreground_window, std::ptr::null_mut());
            GetKeyboardLayout(foreground_thread)
        };

        let ret = unsafe {
            ToUnicodeEx(
                virtual_key_code,
                virtual_scan_code,
                key_state.as_ptr(),
                utf16_buf.as_mut_ptr(),
                utf16_buf.len() as i32,
                dont_change_kernel_keyboard_state,
                active_keyboard_layout,
            )
        };

        // -1 indicates a dead key.
        // 0 indicates no character for this key.
        if ret < 1 {
            return None;
        }

        let mut ch_iter = std::char::decode_utf16(utf16_buf.into_iter().take(ret as usize));
        let mut ch = ch_iter.next()?.ok()?;
        if ch_iter.next().is_some() {
            // Key doesn't map to a single char.
            return None;
        }

        let is_shift_pressed = has_state(key_event.dwControlKeyState, SHIFT_PRESSED);
        let is_capslock_on = has_state(key_event.dwControlKeyState, CAPSLOCK_ON);
        let desired_case = if is_shift_pressed ^ is_capslock_on {
            CharCase::UpperCase
        } else {
            CharCase::LowerCase
        };
        ch = try_ensure_char_case(ch, desired_case);
        Some(ch)
    }

    fn try_ensure_char_case(ch: char, desired_case: CharCase) -> char {
        match desired_case {
            CharCase::LowerCase if ch.is_uppercase() => {
                let mut iter = ch.to_lowercase();
                // Unwrap is safe; iterator yields one or more chars.
                let ch_lower = iter.next().unwrap();
                if iter.next().is_none() {
                    ch_lower
                } else {
                    ch
                }
            }
            CharCase::UpperCase if ch.is_lowercase() => {
                let mut iter = ch.to_uppercase();
                // Unwrap is safe; iterator yields one or more chars.
                let ch_upper = iter.next().unwrap();
                if iter.next().is_none() {
                    ch_upper
                } else {
                    ch
                }
            }
            _ => ch,
        }
    }

    pub(super) fn handle_mouse_event(
        mouse_event: Console::MOUSE_EVENT_RECORD,
        buttons_pressed: &MouseButtonsPressed,
    ) -> Option<Event> {
        if let Ok(Some(event)) = parse_mouse_event_record(&mouse_event, buttons_pressed) {
            return Some(Event::Mouse(event));
        }

        None
    }

    fn screen_buffer() -> CONSOLE_SCREEN_BUFFER_INFO {
        unsafe {
            let utf16: Vec<u16> = "CONOUT$\0".encode_utf16().collect();
            let utf16_ptr: *const u16 = utf16.as_ptr();

            let handle = CreateFileW(
                utf16_ptr,
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null_mut(),
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            );

            let mut buffer_info = CONSOLE_SCREEN_BUFFER_INFO::default();
            if handle != INVALID_HANDLE_VALUE {
                Console::GetConsoleScreenBufferInfo(handle, &mut buffer_info);
                // `CreateFileW` returns an owned handle; close it so each mouse event and cursor
                // query doesn't leak a `CONOUT$` handle.
                CloseHandle(handle);
            }
            buffer_info
        }
    }

    // The 'y' position of a mouse event or resize event is not relative to the window but absolute to screen buffer.
    // This means that when the mouse cursor is at the top left it will be x: 0, y: 2295 (e.g. y = number of cells counting from the absolute buffer height) instead of relative x: 0, y: 0 to the window.
    fn parse_relative_y(y: i16) -> std::io::Result<i16> {
        let window_size = screen_buffer().srWindow;
        Ok((y - window_size.Top).max(0))
    }

    pub fn cursor_position() -> io::Result<(OneBased, OneBased)> {
        let buffer = screen_buffer();
        let position = buffer.dwCursorPosition;
        Ok((
            OneBased::from_zero_based(position.X as u16),
            OneBased::from_zero_based((position.Y - buffer.srWindow.Top).max(0) as u16),
        ))
    }

    fn parse_mouse_event_record(
        event: &MOUSE_EVENT_RECORD,
        buttons_pressed: &MouseButtonsPressed,
    ) -> std::io::Result<Option<MouseEvent>> {
        let modifiers = handle_control_key_state(event.dwControlKeyState);

        let xpos = event.dwMousePosition.X as u16;
        let ypos = parse_relative_y(event.dwMousePosition.Y)? as u16;

        let button_state: ButtonState = event.dwButtonState.into();

        let kind = match event.dwEventFlags {
            0x0000 | DOUBLE_CLICK => {
                if button_state.left_button() && !buttons_pressed.left {
                    Some(MouseEventKind::Down(MouseButton::Left))
                } else if !button_state.left_button() && buttons_pressed.left {
                    Some(MouseEventKind::Up(MouseButton::Left))
                } else if button_state.right_button() && !buttons_pressed.right {
                    Some(MouseEventKind::Down(MouseButton::Right))
                } else if !button_state.right_button() && buttons_pressed.right {
                    Some(MouseEventKind::Up(MouseButton::Right))
                } else if button_state.middle_button() && !buttons_pressed.middle {
                    Some(MouseEventKind::Down(MouseButton::Middle))
                } else if !button_state.middle_button() && buttons_pressed.middle {
                    Some(MouseEventKind::Up(MouseButton::Middle))
                } else {
                    None
                }
            }
            MOUSE_MOVED => {
                let button = if button_state.right_button() {
                    MouseButton::Right
                } else if button_state.middle_button() {
                    MouseButton::Middle
                } else {
                    MouseButton::Left
                };
                if button_state.release_button() {
                    Some(MouseEventKind::Moved)
                } else {
                    Some(MouseEventKind::Drag(button))
                }
            }
            MOUSE_WHEELED => {
                // Vertical scroll
                // from https://docs.microsoft.com/en-us/windows/console/mouse-event-record-str
                // if `button_state` is negative then the wheel was rotated backward, toward the user.
                if button_state.scroll_down() {
                    Some(MouseEventKind::ScrollDown)
                } else if button_state.scroll_up() {
                    Some(MouseEventKind::ScrollUp)
                } else {
                    None
                }
            }
            MOUSE_HWHEELED => {
                if button_state.scroll_left() {
                    Some(MouseEventKind::ScrollLeft)
                } else if button_state.scroll_right() {
                    Some(MouseEventKind::ScrollRight)
                } else {
                    None
                }
            }
            _ => None,
        };

        Ok(kind.map(|kind| MouseEvent {
            kind,
            column: xpos,
            row: ypos,
            modifiers,
        }))
    }
}
