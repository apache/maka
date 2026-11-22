# Reading Virtual Terminal sequences from the Windows Console

Since the addition of [ConPTY](https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/), it is now possible to interact with the Windows Console API with escape sequences like a *NIX PTY. There aren't many good examples on doing this though. This doc will show code snippets for reading VT sequences from the Windows Console.

This doc assumes you have Rust experience, especially with calling into system APIs, for example the `libc`, `rustix` or `windows-sys` crates. In this doc I will gloss over all error handling. To reference how these system calls are handled in Termina see `src/terminal/windows.rs` and `src/event/source/windows.rs`.

### Opening handles

The first step is opening the input and output Console handles.

```rust
use std::{io, fs};

fn open_pty() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let input = fs::OpenOptions::new().read(true).write(true).open("CONIN$")?.into();
    let output = fs::OpenOptions::new().read(true).write(true).open("CONOUT$")?.into();
    Ok((input, output))
}
```

### Setting code pages

Then we want to set the "code pages" (encodings) that we will speak to/from these handles using the `SetConsoleCP` and `SetConsoleOutputCP` functions from the Windows Console API. When "speaking VT" we want this encoding to be UTF-8 so we use the `CP_UTF8` code page ID.

```rust
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::{Globalization::CP_UTF8, System::Console}

unsafe { Console::SetConsoleCP(input.as_raw_handle(), CP_UTF8) };
unsafe { Console::SetConsoleOutputCP(output.as_raw_handle(), CP_UTF8) };
```

### Setting console modes

Then we have to alter the [console modes](https://learn.microsoft.com/en-us/windows/console/high-level-console-modes) of the handles. This is somewhat similar to [termios(3)](https://www.man7.org/linux/man-pages/man3/termios.3.html) in *NIX which is used to set raw or cooked modes. There are a few flags we want to enable/disable off the bat.

```rust
use windows_sys::Win32::System::Console;

let mut original_input_mode = 0;
let mut original_output_mode = 0;

unsafe {
    Console::GetConsoleMode(input.as_raw_handle(), &mut original_input_mode);
    Console::GetConsoleMode(output.as_raw_handle(), &mut original_output_mode);
}

let desired_input_mode = original_input_mode | Console::ENABLE_VIRTUAL_TERMINAL_INPUT;
let desired_output_mode = original_output_mode
    | Console::ENABLE_VIRTUAL_TERMINAL_PROCESSING
    | Console::DISABLE_NEWLINE_AUTO_RETURN;

unsafe {
    Console::SetConsoleMode(input.as_raw_handle(), desired_input_mode);
    Console::SetConsoleMode(output.as_raw_handle(), desired_output_mode);
}
```

Now we've done what the Microsoft docs say: we've instructed our input and output handles to speak UTF-8 encoded VT. This is all the setup we need and now we can talk about reading and writing our input and output handles.

### Writing VT

Writing escape sequences is fairly straightforward. We'll add a bit of machinery around the `OwnedHandle` used for the output so we can implement the `std::io::Write` trait and use `write!` in the future.

```rust
use windows_sys::Win32::Storage::FileSystem::WriteFile;
use std::ptr;

struct OutputHandle {
    handle: OwnedHandle,
}

impl io::Write for OutputHandle {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut num_written = 0;
        if unsafe {
            WriteFile(
                self.handle.as_raw_handle(),
                buf.as_ptr(),
                buf.len() as u32,
                &mut num_written,
                ptr::null_mut();
            )
        } == 0 {
            Err(io::Error::last_error())
        } else {
            Ok(num_written as usize)
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
```

Now we can write escape sequences like so:

```rust
let output = OutputHandle { handle: output };
write!(output, "\x1b[32mHello, world!\x1b[0m");
```

So this works just like how you'd interact with a *NIX PTY: you write the UTF-8 encoded VT bytes to the output file/device.

### Reading VT

Reading is trickier. We could similarly use `ReadFile` or `ReadConsole` on the `CONIN$` handle but the Microsoft docs have a [note about this](https://learn.microsoft.com/en-us/windows/console/classic-vs-vt#exceptions-for-using-windows-console-apis):

> Applications that must be aware of window size changes will still need to use `ReadConsoleInput` to receive them interleaved with key events as `ReadConsole` alone will discard them.

`ReadConsoleInput` would otherwise be considered legacy: it's what you would use to read events before ConPTY. We need it though if we want to receive resizing events. Using `ReadConsole` or `ReadFile` would cause these events to be discarded. So how does this work exactly then?

```rust
use windows_sys::Win32::System::Console::{
    GetNumberOfConsoleInputEvents, KEY_EVENT, INPUT_RECORD, ReadConsoleInputA,
    WINDOW_BUFFER_SIZE_EVENT,
};
use std::mem;

let mut capacity = 128;
let mut records = Vec::with_capacity(capacity);
let zeroed: INPUT_RECORD = unsafe { mem::zeroed() };
records.resize(capacity, zeroed);
let mut num_read = 0;
unsafe {
    ReadConsoleInputA(output.handle.as_raw_handle(), records.as_mut_ptr(), new_to_read, &mut num_read);
    records.set_len(num_read as usize);
}

let mut buffer = Vec::new();
for record in records {
    match record.EventType as u32 {
        KEY_EVENT => {
            let record = unsafe { record.Event.KeyEvent };
            if record.bKeyDown == 0 {
                continue;
            }
            buffer.push(unsafe { record.uChar.AsciiChar } as u8);
        }
        WINDOW_BUFFER_SIZE_EVENT => {
            let record = unsafe { record.Event.WindowBufferSizeEvent };
            // NOTE: Unix sizes are one-indexed. We `+ 1` to normalize to that convention.
            let rows = (record.dwSize.Y + 1) as u16;
            let cols = (record.dwSize.X + 1) as u16;
            todo!("resized to ({rows}, {cols})");
        }
        _ => (),
    }
}
```

First we check the number of available records with `GetNumberOfConsoleInputEvents` and then fill a buffer of [`INPUT_RECORD`](https://learn.microsoft.com/en-us/windows/console/input-record-str)s with `ReadConsoleInputA`. The [Microsoft docs say](https://learn.microsoft.com/en-us/windows/console/classic-vs-vt#unicode) that `ReadConsoleInputA` is the way to receive UTF-8 encoded text after we've enabled `CP_UTF8`:

> UTF-8 support in the console can be utilized via the `A` variant of Console APIs against console handles after setting the codepage to `65001` or `CP_UTF8` with the `SetConsoleOutputCP` and `SetConsoleCP` methods, as appropriate.

In that buffer of input records be care about two events: key events and window resizes. For [`KEY_EVENT_RECORD`](https://learn.microsoft.com/en-us/windows/console/key-event-record-str)s we don't actually care about the virtual key codes. We would if we were reading with the legacy Console API but since we've enabled VT processing on the input, we can expect that the key event record is actually just a byte that we should add to our input buffer. For example if we type the character 'a' then we can expect that the byte 97 arrives as this `record.uChar.AsciiChar`.

That's the story for reading. Now the input buffer can be parsed the same as the bytes read from a *NIX PTY device.
