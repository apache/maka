use rquickjs::{CaughtError, Ctx};

/// A JS exception or engine error, rendered to a message with stack.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct JsError {
    /// Message, including the JS stack when available.
    pub message: String,
    /// The exception was `null`: what QuickJS leaves when it could not
    /// even make its "out of memory" error.
    pub(crate) null: bool,
}

impl JsError {
    pub(crate) fn caught(err: CaughtError<'_>) -> Self {
        let null = matches!(&err, CaughtError::Value(v) if v.is_null());
        Self {
            message: err.to_string(),
            null,
        }
    }

    /// An error with `message`.
    pub(crate) fn new(message: String) -> Self {
        Self {
            message,
            null: false,
        }
    }

    pub(crate) fn from_engine(cx: &Ctx<'_>, err: rquickjs::Error) -> Self {
        Self::caught(CaughtError::from_error(cx, err))
    }
}

impl From<rquickjs::Error> for JsError {
    fn from(err: rquickjs::Error) -> Self {
        Self::new(err.to_string())
    }
}
