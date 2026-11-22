//! HTTP requests made by `fetch`, as handed to the platform's network stack.

pub use nsh_core::platform::{FetchEvent, FetchOp, HttpBody, HttpHead, HttpRequest};

/// Identifies a request between JS and the network stack.
pub type RequestId = u32;

/// What JS asked of its requests since the last
/// [`crate::Host::take_network`], in order.
#[derive(Debug, Default)]
pub struct NetworkQueue {
    /// Operations, by request.
    pub ops: Vec<(RequestId, FetchOp)>,
}

impl NetworkQueue {
    /// True if there is nothing to do.
    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}
