//! What `nsh test --trace` prints of a batch: a line per mount item, the
//! same for a headless engine's batches and a host's (which its agent
//! sends to the test, `nsh_dev::protocol::ClientMessage::Trace`).

use nsh_core::{MountBatch, MountItem};

/// The lines of `batch`'s items, as `--trace` prints them under the step
/// they came in.
pub(crate) fn item_lines(batch: &MountBatch) -> Vec<String> {
    batch
        .items
        .iter()
        .map(|item| match item {
            MountItem::Text {
                id, text, content, ..
            } => format!(
                "Text {{ id: {id}, text: {:?}, content: {}x{} @ {},{} }}",
                text.text,
                content.size.width.0,
                content.size.height.0,
                content.origin.x.0,
                content.origin.y.0
            ),
            MountItem::Frame { id, frame } => format!(
                "Frame {{ id: {id}, x: {}, y: {}, w: {}, h: {} }}",
                frame.origin.x.0, frame.origin.y.0, frame.size.width.0, frame.size.height.0
            ),
            other => format!("{other:?}"),
        })
        .collect()
}

/// Prints the lines `items` of a batch that came in step `step`: a line
/// naming the step and the number of items, then one line per item.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn print_items(out: &mut dyn std::io::Write, step: &str, items: &[String]) {
    // A closed output (`| head`) ends nothing: the run goes on unseen.
    let _ = writeln!(out, "── {step}: {} items", items.len());
    for item in items {
        let _ = writeln!(out, "   {item}");
    }
    let _ = out.flush();
}
