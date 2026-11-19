//! Offscreen canvas renders in the core ([`crate::canvas::render`]): each
//! request is checked, sent to the platform ([`Command::RenderCanvas`]) and
//! answered once by its reply ([`crate::EventKind::CanvasImage`]) or its
//! deadline ([`render::TIMEOUT`]).
//!
//! Request ids are unique in the process, not per core: a platform may
//! still answer a render a replaced core (a hot reload's) asked for, and
//! that answer must not settle a new core's request of the same number.

use std::{
    rc::Rc,
    sync::atomic::{AtomicU32, Ordering},
};

use rustc_hash::FxHashMap;

use super::Core;
use crate::{
    Command, EventPayload,
    canvas::render::{self, RenderRequest},
    element::{
        JsError, codes,
        task::{self, Action, AnswerSlot, Task},
    },
};

type Slot = AnswerSlot<Result<Vec<u8>, JsError>>;

/// A rendered image as JS gets it: a `Blob` of its type.
struct ImageBlob(crate::ImageData, &'static str);

impl crate::element::Ret for ImageBlob {
    fn ts_type(_types: &mut crate::element::TsTypes) -> String {
        "Blob".into()
    }

    fn into_js<'a>(
        self,
        host: &'a dyn crate::element::JsHost,
    ) -> Result<crate::element::JsOwned<'a>, crate::element::PropError> {
        Ok(crate::element::JsOwned::new(
            host,
            host.new_blob(&self.0, self.1)?,
        ))
    }
}

struct Pending {
    answer: Slot,
    _deadline: Task<()>,
}

#[derive(Default)]
pub(super) struct Renders {
    pending: FxHashMap<u32, Pending>,
}

impl Renders {
    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

/// The next request id, never 0.
fn next_id() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    loop {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        if id != 0 {
            return id;
        }
    }
}

impl<M: crate::TextEngine> Core<M> {
    /// `OffscreenCanvas`'s `convertToBlob`: settles JS promise `call` with
    /// the image's bytes or the failure.
    pub(super) fn start_js_canvas_render(&mut self, call: u32, request: RenderRequest) {
        use crate::element::{Answer, IntoThrown, ToJs};
        let (answer, slot) = Answer::new();
        let mime = request.format.mime();
        self.start_canvas_render(request, slot);
        let executor = Rc::downgrade(&self.components.executor);
        task::spawn_raw(
            &self.components.executor,
            crate::ROOT_ID,
            Box::pin(async move {
                let result = answer
                    .await
                    .map(|bytes| {
                        Box::new(ImageBlob(crate::ImageData::new(bytes), mime)) as Box<dyn ToJs>
                    })
                    .map_err(IntoThrown::into_thrown);
                if let Some(executor) = executor.upgrade() {
                    executor.act(Action::Return(call, result));
                }
            }),
        );
    }

    /// Checks `request` and sends it to the platform; `answer` gets the
    /// image or why there is none. Its images pass the same check an
    /// on-screen canvas drawing's do (`Core::check_canvas_images`): a
    /// source the app may not load is dropped before the platform sees it.
    pub(super) fn start_canvas_render(&mut self, mut request: RenderRequest, answer: Slot) {
        let env = &self.components.environment;
        if !env.canvas_render {
            answer.borrow_mut().deliver(Err(render::error(
                codes::UNAVAILABLE,
                "this platform renders no offscreen canvases",
            )));
            return;
        }
        let scale = request.scale.unwrap_or(env.pixel_ratio.max(1.0));
        let (width, height) = match render::pixel_size(request.size, scale) {
            Ok(size) => size,
            Err(error) => {
                answer.borrow_mut().deliver(Err(error));
                return;
            }
        };
        if self.components.canvas_renders.pending.len() >= render::MAX_PENDING {
            answer.borrow_mut().deliver(Err(render::error(
                codes::QUOTA_EXCEEDED,
                "too many offscreen canvas renders at once",
            )));
            return;
        }
        self.check_canvas_images(&mut request.drawing);
        let id = next_id();
        let deadline = task::act_after(
            &self.components.executor,
            crate::ROOT_ID,
            render::TIMEOUT,
            Action::CanvasRenderTimeout(id),
        );
        self.components.canvas_renders.pending.insert(
            id,
            Pending {
                answer,
                _deadline: deadline,
            },
        );
        self.commands.push((
            crate::ROOT_ID,
            Command::RenderCanvas {
                id,
                drawing: std::sync::Arc::new(request.drawing),
                width,
                height,
                scale,
                format: request.format,
            },
        ));
    }

    /// The platform's reply to a [`Command::RenderCanvas`].
    pub(super) fn answer_canvas_render(&mut self, payload: &EventPayload) -> bool {
        let EventPayload::CanvasImage { id, result } = payload else {
            return false;
        };
        if let Some(pending) = self.components.canvas_renders.pending.remove(id) {
            pending
                .answer
                .borrow_mut()
                .deliver(result.clone().map_err(render::RenderFailure::into_error));
        }
        true
    }

    /// A render the platform has not answered in time fails; its answer,
    /// if it ever comes, is dropped.
    pub(super) fn timeout_canvas_render(&mut self, id: u32) {
        if let Some(pending) = self.components.canvas_renders.pending.remove(&id) {
            pending.answer.borrow_mut().deliver(Err(render::error(
                codes::TIMED_OUT,
                "the platform did not render the offscreen canvas in time",
            )));
        }
    }
}
