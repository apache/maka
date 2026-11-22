//! The drawings [`crate::element::svg`]s show, parsed once per source and
//! kept in the decoded images' budget (`docs/dev/images.md`): an entry is
//! leased while an element shows it and shared by every size, as it is
//! vector.

use std::sync::{Arc, LazyLock};

use crate::{
    canvas::Drawing,
    image::{
        ImageData, Lease, MemoryCache,
        loader::{Context, Location, Priority, loader},
    },
};

/// The drawings by source key.
fn drawings() -> &'static MemoryCache<String, Arc<Drawing>> {
    static DRAWINGS: LazyLock<MemoryCache<String, Arc<Drawing>>> =
        LazyLock::new(|| MemoryCache::new(crate::image::budget()));
    &DRAWINGS
}

/// The drawing of `location` here and now: in memory, or parsed from the
/// bytes it carries (inline markup).
pub(crate) fn now(location: &Location) -> Option<(Arc<Drawing>, Lease)> {
    let key = location.key();
    if let Some(hit) = drawings().get(&key) {
        return Some(hit);
    }
    match location {
        Location::Memory(_, bytes) => Some(parsed(key, bytes)),
        _ => None,
    }
}

/// Loads the drawing of `location` through `context` (its bytes through the
/// shared loader, parsed on a decode thread); dropping the future gives up
/// the load. One that fails draws nothing.
pub(crate) fn load(
    location: Location,
    context: Context,
) -> impl Future<Output = (Arc<Drawing>, Lease)> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let key = location.key();
    let ticket = loader().read(
        location,
        &context,
        Priority::Visible,
        None,
        Box::new(move |bytes| {
            loader()
                .decode(Priority::Visible, move || {
                    let shown = match bytes {
                        // Another element may have parsed it meanwhile.
                        Ok(bytes) => drawings().get(&key).unwrap_or_else(|| parsed(key, &bytes)),
                        Err(e) => {
                            log::warn!("svg: {e}");
                            (Arc::default(), Lease::none())
                        }
                    };
                    let _ = tx.send(shown);
                })
                .detach();
        }),
    );
    async move {
        let _ticket = ticket;
        rx.await.unwrap_or_else(|_| (Arc::default(), Lease::none()))
    }
}

/// Parses `bytes` and keeps the drawing as `key`'s.
fn parsed(key: String, bytes: &ImageData) -> (Arc<Drawing>, Lease) {
    let drawing = std::str::from_utf8(bytes)
        .map_err(|_| super::Error::Invalid("not UTF-8 text".into()))
        .and_then(super::drawing);
    let drawing = Arc::new(drawing.unwrap_or_else(|e| {
        log::warn!("svg: {e}");
        Drawing::default()
    }));
    let lease = drawings().insert(key, drawing.clone(), cost(&drawing));
    (drawing, lease)
}

/// What a drawing costs, estimated from its operations (each with its share
/// of path data).
fn cost(drawing: &Drawing) -> usize {
    256 + drawing.ops.len() * 2 * std::mem::size_of::<crate::canvas::CanvasOp>()
}
