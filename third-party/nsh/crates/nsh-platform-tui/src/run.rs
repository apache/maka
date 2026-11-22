use std::time::{Duration, Instant};

use ratatui_core::{backend::Backend, terminal::Terminal};

use crate::{AppView, Input};

/// An event from the standalone host's terminal transport.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum RunEvent {
    /// Input to route through the surface.
    Input(Input),
    /// The terminal area changed or the host needs a fresh frame.
    Redraw,
    /// The wait timed out; only render if the surface has work.
    Idle,
    /// End the standalone loop.
    Exit,
}

/// Runs a surface using the embedder's terminal and input transport.
///
/// `poll` waits at most its argument. Polling is bounded because crossterm
/// cannot be woken from the engine thread; idle polls never draw a frame.
/// Terminal setup and restoration belong to the host. This function uses
/// only the public surface API and stops the app on exit or transport error.
pub fn run_app<B: Backend>(
    terminal: &mut Terminal<B>,
    view: &mut AppView,
    mut poll: impl FnMut(Duration) -> Result<RunEvent, B::Error>,
) -> Result<(), B::Error> {
    const POLL_INTERVAL: Duration = Duration::from_millis(16);
    let result = (|| {
        let mut redraw = true;
        loop {
            if redraw
                || view
                    .next_frame_deadline()
                    .is_some_and(|due| due <= Instant::now())
            {
                view.draw_terminal(terminal)?;
                redraw = false;
            }
            if view.exit_requested() {
                return Ok(());
            }
            let wait = view.next_frame_deadline().map_or(POLL_INTERVAL, |due| {
                due.saturating_duration_since(Instant::now())
                    .min(POLL_INTERVAL)
            });
            let waiting = Instant::now();
            match poll(wait)? {
                RunEvent::Input(input) => {
                    view.handle(input);
                }
                RunEvent::Redraw => redraw = true,
                RunEvent::Idle => {
                    // Interrupted or filtered input may return early. Honor the remaining wait
                    // unless engine work arrived, rather than polling again in a tight loop.
                    let remaining = wait.saturating_sub(waiting.elapsed());
                    let remaining = view.next_frame_deadline().map_or(remaining, |due| {
                        remaining.min(due.saturating_duration_since(Instant::now()))
                    });
                    if !remaining.is_zero() {
                        std::thread::sleep(remaining);
                    }
                }
                RunEvent::Exit => return Ok(()),
            }
        }
    })();
    view.stop();
    result
}
