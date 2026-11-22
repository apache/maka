// CREDIT: This module is mostly based on crossterm's `event-read` example with minor
// modifications to adapt to the termina API.
// <https://github.com/crossterm-rs/crossterm/blob/36d95b26a26e64b0f8c12edfe11f410a6d56a812/examples/event-read.rs>
use std::{
    env,
    io::{self, Write as _},
    time::Duration,
};

#[cfg(windows)]
use termina::windows;
use termina::{
    escape::csi::{self, KittyKeyboardFlags},
    event::{KeyCode, KeyEvent},
    Event, PlatformTerminal, Terminal, WindowSize,
};

const HELP: &str = r#"Blocking read()
 - Keyboard, mouse, focus and terminal resize events enabled
 - Hit "c" to print current cursor position
 - Use Esc to quit
"#;

macro_rules! decset {
    ($mode:ident) => {
        csi::Csi::Mode(csi::Mode::SetDecPrivateMode(csi::DecPrivateMode::Code(
            csi::DecPrivateModeCode::$mode,
        )))
    };
}
macro_rules! decreset {
    ($mode:ident) => {
        csi::Csi::Mode(csi::Mode::ResetDecPrivateMode(csi::DecPrivateMode::Code(
            csi::DecPrivateModeCode::$mode,
        )))
    };
}

fn main() -> io::Result<()> {
    println!("{HELP}");

    let args: Vec<_> = env::args().collect();
    let windows_legacy = cfg!(windows) && args.iter().any(|a| a == "--windows-legacy");

    #[cfg(windows)]
    let mut terminal = PlatformTerminal::with_mode(if windows_legacy {
        windows::InputReaderMode::Legacy
    } else {
        windows::InputReaderMode::Vte
    })?;
    #[cfg(not(windows))]
    let mut terminal = PlatformTerminal::new()?;

    terminal.enter_raw_mode()?;

    let keyboard_flags = if windows_legacy {
        // Enabling the kitty keyboard protocol in a supported terminal
        // while using the legacy console API will result in incorrect key codes
        // for some key combinations.
        "".to_string()
    } else {
        csi::Csi::Keyboard(csi::Keyboard::PushFlags(
            KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES
                | KittyKeyboardFlags::REPORT_ALTERNATE_KEYS,
        ))
        .to_string()
    };
    write!(
        terminal,
        "{}{}{}{}{}{}{}{}",
        keyboard_flags,
        decset!(FocusTracking),
        decset!(BracketedPaste),
        decset!(MouseTracking),
        decset!(ButtonEventMouse),
        decset!(AnyEventMouse),
        decset!(RXVTMouse),
        decset!(SGRMouse),
    )?;
    terminal.flush()?;

    let mut size = terminal.get_dimensions()?;
    loop {
        let event = terminal.read(|event| !event.is_escape())?;

        println!("Event: {event:?}\r");

        match event {
            Event::Key(KeyEvent {
                code: KeyCode::Escape,
                ..
            }) => break,
            Event::Key(KeyEvent {
                code: KeyCode::Char('c'),
                ..
            }) => {
                if windows_legacy {
                    #[cfg(windows)]
                    {
                        let (line, col) = termina::windows::cursor_position()?;
                        println!(
                            "Cursor position: {:?}\r",
                            (line.get_zero_based(), col.get_zero_based())
                        );
                    }
                } else {
                    write!(
                        terminal,
                        "{}",
                        csi::Csi::Cursor(csi::Cursor::RequestActivePositionReport),
                    )?;
                    terminal.flush()?;
                    let filter = |event: &Event| {
                        matches!(
                            event,
                            Event::Csi(csi::Csi::Cursor(csi::Cursor::ActivePositionReport { .. }))
                        )
                    };
                    if terminal.poll(filter, Some(Duration::from_millis(50)))? {
                        let Event::Csi(csi::Csi::Cursor(csi::Cursor::ActivePositionReport {
                            line,
                            col,
                        })) = terminal.read(filter)?
                        else {
                            unreachable!()
                        };
                        println!(
                            "Cursor position: {:?}\r",
                            (line.get_zero_based(), col.get_zero_based())
                        );
                    } else {
                        eprintln!("Failed to read the cursor position within 50msec\r");
                    }
                }
            }
            Event::WindowResized(dimensions) => {
                let new_size = flush_resize_events(&terminal, dimensions);
                println!("Resize from {size:?} to {new_size:?}\r");
                size = new_size;
            }
            _ => (),
        }
    }

    let keyboard_flags = if windows_legacy {
        "".to_string()
    } else {
        csi::Csi::Keyboard(csi::Keyboard::PopFlags(1)).to_string()
    };
    write!(
        terminal,
        "{}{}{}{}{}{}{}{}",
        keyboard_flags,
        decreset!(FocusTracking),
        decreset!(BracketedPaste),
        decreset!(MouseTracking),
        decreset!(ButtonEventMouse),
        decreset!(AnyEventMouse),
        decreset!(RXVTMouse),
        decreset!(SGRMouse),
    )?;

    Ok(())
}

fn flush_resize_events(terminal: &PlatformTerminal, original_size: WindowSize) -> WindowSize {
    let mut size = original_size;
    let filter = |event: &Event| matches!(event, Event::WindowResized { .. });
    while let Ok(true) = terminal.poll(filter, Some(Duration::from_millis(50))) {
        if let Ok(Event::WindowResized(dimensions)) = terminal.read(filter) {
            size = dimensions;
        }
    }
    size
}
