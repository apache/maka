use rustix::termios::{self, Termios};
use std::{
    fs,
    io::{self, BufWriter, IsTerminal as _, Write as _},
    os::unix::prelude::*,
};

use crate::{event::source::UnixEventSource, Event, EventReader, WindowSize};

use super::Terminal;

const BUF_SIZE: usize = 4096;

// CREDIT: FileDescriptor stuff is mostly based on the WezTerm crate `filedescriptor` but has been
// rewritten with `rustix` instead of `libc`.
// <https://github.com/wezterm/wezterm/blob/a87358516004a652ad840bc1661bdf65ffc89b43/filedescriptor/src/unix.rs>

#[derive(Debug)]
pub enum FileDescriptor {
    /// A file descriptor owned by Termina.
    Owned(OwnedFd),

    /// A borrowed process-global file descriptor such as stdin or stdout.
    Borrowed(BorrowedFd<'static>),
}

impl AsFd for FileDescriptor {
    fn as_fd(&self) -> BorrowedFd<'_> {
        match self {
            Self::Owned(fd) => fd.as_fd(),
            Self::Borrowed(fd) => *fd,
        }
    }
}

impl FileDescriptor {
    /// The process stdin file descriptor.
    pub const STDIN: Self = Self::Borrowed(rustix::stdio::stdin());

    /// The process stdout file descriptor.
    pub const STDOUT: Self = Self::Borrowed(rustix::stdio::stdout());

    fn try_clone(&self) -> io::Result<Self> {
        let this = match self {
            Self::Owned(fd) => Self::Owned(fd.try_clone()?),
            Self::Borrowed(fd) => Self::Borrowed(*fd),
        };
        Ok(this)
    }
}

impl io::Read for FileDescriptor {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = rustix::io::read(&self, buf)?;
        Ok(read)
    }
}

impl io::Write for FileDescriptor {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = rustix::io::write(self, buf)?;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn open_pty() -> io::Result<(FileDescriptor, FileDescriptor)> {
    let read = if io::stdin().is_terminal() {
        FileDescriptor::STDIN
    } else {
        open_dev_tty()?
    };
    let write = if io::stdout().is_terminal() {
        FileDescriptor::STDOUT
    } else {
        open_dev_tty()?
    };

    // Activate non-blocking mode for the reader.
    // NOTE: this seems to make macOS consistently fail with io::ErrorKind::WouldBlock errors.
    // rustix::io::ioctl_fionbio(&read, true)?;

    Ok((read, write))
}

fn open_dev_tty() -> io::Result<FileDescriptor> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")?;
    Ok(FileDescriptor::Owned(file.into()))
}

impl From<termios::Winsize> for WindowSize {
    fn from(size: termios::Winsize) -> Self {
        Self {
            cols: size.ws_col,
            rows: size.ws_row,
            pixel_width: Some(size.ws_xpixel),
            pixel_height: Some(size.ws_ypixel),
        }
    }
}

/// Unix terminal handle.
///
/// `UnixTerminal` writes to stdout or `/dev/tty`, reads events from stdin or `/dev/tty`, and
/// restores the captured termios state when dropped.
///
/// # Implementation Notes
///
/// This type is based on [termwiz's Unix terminal], but Termina splits responsibilities
/// differently. TermWiz combines terminal dimensions, event reading, byte output, and terminal
/// state in one terminal type. Termina keeps byte output and terminal mode management here, while
/// event-source details live in `src/event/source/unix.rs`, closer to crossterm's event-source
/// shape. The implementation also uses `rustix` and has different `Drop` behavior, so it no longer
/// looks much like the original TermWiz code.
///
/// [termwiz's Unix terminal]: https://docs.rs/termwiz/latest/termwiz/terminal/index.html
#[derive(Debug)]
pub struct UnixTerminal {
    /// Shared wrapper around the reader (stdin or `/dev/tty`)
    reader: EventReader,
    /// Buffered handle to the writer (stdout or `/dev/tty`)
    write: BufWriter<FileDescriptor>,
    /// The termios of the PTY's writer detected during `Self::new`.
    original_termios: Termios,
    has_panic_hook: bool,
}

impl UnixTerminal {
    /// Opens the Unix terminal for input and output.
    ///
    /// If stdin or stdout is not a terminal, Termina opens `/dev/tty` for that side. The original
    /// termios state is captured so [`Terminal::enter_cooked_mode`] and `Drop` can restore it.
    pub fn new() -> io::Result<Self> {
        let (read, write) = open_pty()?;
        let source = UnixEventSource::new(read, write.try_clone()?)?;
        let original_termios = termios::tcgetattr(&write)?;
        let reader = EventReader::new(source);

        Ok(Self {
            reader,
            write: BufWriter::with_capacity(BUF_SIZE, write),
            original_termios,
            has_panic_hook: false,
        })
    }
}

impl Terminal for UnixTerminal {
    fn enter_raw_mode(&mut self) -> io::Result<()> {
        let mut termios = termios::tcgetattr(self.write.get_ref())?;
        termios.make_raw();
        termios::tcsetattr(
            self.write.get_ref(),
            termios::OptionalActions::Now,
            &termios,
        )?;

        Ok(())
    }

    fn enter_cooked_mode(&mut self) -> io::Result<()> {
        termios::tcsetattr(
            self.write.get_ref(),
            termios::OptionalActions::Now,
            &self.original_termios,
        )?;
        Ok(())
    }

    fn get_dimensions(&self) -> io::Result<WindowSize> {
        let winsize = termios::tcgetwinsize(self.write.get_ref())?;
        let mut size: WindowSize = winsize.into();
        // Over a serial connection for example, the ioctl may quietly fail by returning zeroed
        // rows and columns. Fall back to reading LINES/COLUMNS.
        // <https://github.com/vim/vim/blob/b88f9e4a04ce9fb70abb7cdae17688aa4f49c8c9/src/os_unix.c#L4349-L4370>
        if size.cols == 0 || size.rows == 0 {
            if let Some(rows) = std::env::var("LINES")
                .ok()
                .and_then(|l| l.parse::<u16>().ok())
            {
                size.rows = rows;
            }
            if let Some(cols) = std::env::var("COLUMNS")
                .ok()
                .and_then(|c| c.parse::<u16>().ok())
            {
                size.cols = cols;
            }
        }
        if size.cols == 0 || size.rows == 0 {
            Err(io::Error::new(
                io::ErrorKind::Other,
                "cannot read non-zero cols/rows from ioctl or COLUMNS/LINES environment variables",
            ))
        } else {
            Ok(size)
        }
    }

    fn event_reader(&self) -> EventReader {
        self.reader.clone()
    }

    fn poll<F: Fn(&Event) -> bool>(
        &self,
        filter: F,
        timeout: Option<std::time::Duration>,
    ) -> io::Result<bool> {
        self.reader.poll(timeout, filter)
    }

    fn read<F: Fn(&Event) -> bool>(&self, filter: F) -> io::Result<Event> {
        self.reader.read(filter)
    }

    fn set_panic_hook(&mut self, f: impl Fn(&mut FileDescriptor) + Send + Sync + 'static) {
        let original_termios = self.original_termios.clone();
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Ok((_read, mut write)) = open_pty() {
                f(&mut write);
                let _ = termios::tcsetattr(write, termios::OptionalActions::Now, &original_termios);
            }
            hook(info);
        }));
        self.has_panic_hook = true;
    }
}

impl Drop for UnixTerminal {
    fn drop(&mut self) {
        if !self.has_panic_hook || !std::thread::panicking() {
            let _ = self.flush();
            let _ = self.enter_cooked_mode();
        }
    }
}

impl io::Write for UnixTerminal {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.write.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.write.flush()
    }
}
