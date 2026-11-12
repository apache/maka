use std::io::{self, Write};

use ratatui_core::{
    backend::{Backend, ClearType, WindowSize},
    buffer::Cell,
    layout::{Position, Size},
};

use super::SharedOutput;

/// A terminal backend that counts Cells only while its AppView monitor is
/// enabled, and draws the Cells of the text inside a view with an `href`
/// (a `Link`'s) as OSC 8 hyperlinks (`crate::link`).
#[non_exhaustive]
pub struct MeasuredBackend<B> {
    pub(crate) inner: B,
    pub(crate) output: SharedOutput,
}

impl<B: Default> Default for MeasuredBackend<B> {
    fn default() -> Self {
        Self {
            inner: B::default(),
            output: Default::default(),
        }
    }
}

impl<B> MeasuredBackend<B> {
    /// The wrapped backend, for buffer inspection and transport configuration.
    pub fn inner(&self) -> &B {
        &self.inner
    }
    /// The wrapped backend, for resizing an in-memory terminal.
    pub fn inner_mut(&mut self) -> &mut B {
        &mut self.inner
    }
}

impl<B: Backend> Backend for MeasuredBackend<B> {
    type Error = B::Error;
    fn draw<'a, I>(&mut self, content: I) -> Result<(), Self::Error>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        let links = self.output.links.borrow();
        if !links.is_empty() {
            // The diff decided which Cells to draw from their plain
            // symbols; only what is written for a linked one changes.
            let content: Vec<_> = content.collect();
            let wrapped: Vec<_> = content
                .iter()
                .map(|&(x, y, cell)| links.get(&(x, y)).map(|open| crate::link::wrap(cell, open)))
                .collect();
            let content = content
                .iter()
                .zip(&wrapped)
                .map(|(&(x, y, cell), wrapped)| (x, y, wrapped.as_ref().unwrap_or(cell)));
            return if self.output.enabled.get() {
                let mut cells = 0;
                self.inner.draw(content.inspect(|_| cells += 1))?;
                self.output
                    .cells
                    .set(Some(self.output.cells.get().unwrap_or(0) + cells));
                Ok(())
            } else {
                self.inner.draw(content)
            };
        }
        drop(links);
        if !self.output.enabled.get() {
            return self.inner.draw(content);
        }
        let mut cells = 0;
        self.inner.draw(content.inspect(|_| cells += 1))?;
        self.output
            .cells
            .set(Some(self.output.cells.get().unwrap_or(0) + cells));
        Ok(())
    }
    fn append_lines(&mut self, n: u16) -> Result<(), Self::Error> {
        self.inner.append_lines(n)
    }
    fn hide_cursor(&mut self) -> Result<(), Self::Error> {
        self.inner.hide_cursor()
    }
    fn show_cursor(&mut self) -> Result<(), Self::Error> {
        self.inner.show_cursor()
    }
    fn get_cursor_position(&mut self) -> Result<Position, Self::Error> {
        self.inner.get_cursor_position()
    }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> Result<(), Self::Error> {
        self.inner.set_cursor_position(position)
    }
    fn clear(&mut self) -> Result<(), Self::Error> {
        self.inner.clear()
    }
    fn clear_region(&mut self, clear_type: ClearType) -> Result<(), Self::Error> {
        self.inner.clear_region(clear_type)
    }
    fn size(&self) -> Result<Size, Self::Error> {
        self.inner.size()
    }
    fn window_size(&mut self) -> Result<WindowSize, Self::Error> {
        self.inner.window_size()
    }
    fn flush(&mut self) -> Result<(), Self::Error> {
        self.inner.flush()
    }
}

/// Counts bytes accepted by a writer only while its AppView monitor is enabled.
#[non_exhaustive]
pub struct MeasuredWriter<W> {
    pub(crate) inner: W,
    pub(crate) output: SharedOutput,
}

impl<W: Default> Default for MeasuredWriter<W> {
    fn default() -> Self {
        Self {
            inner: W::default(),
            output: Default::default(),
        }
    }
}

impl<W: Write> Write for MeasuredWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(bytes)?;
        if self.output.enabled.get() {
            self.output
                .bytes
                .set(Some(self.output.bytes.get().unwrap_or(0) + written as u64));
        }
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
