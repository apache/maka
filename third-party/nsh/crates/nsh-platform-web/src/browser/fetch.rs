//! `fetch` routed through the engine's network, for a test session: the
//! test's routes answer what the app asks (`open(..., { network })`) and
//! record it (`app.requests()`), as nsh-js' fetch does for QuickJS. The
//! realm builds its requests and responses with the browser's own classes
//! (`testing.js`); only the request's parts cross, and the engine's events
//! come back to its listener.
use std::cell::{Cell, RefCell};

use nsh_core::{
    element::PropError,
    js::host::HostInput,
    platform::{FetchEvent, FetchOp, HttpBody, HttpRequest},
};

use super::{timers::report, values::Value};

#[derive(Default)]
pub(super) struct Fetches {
    next: Cell<u32>,
    /// What JS asked since the engine last took it, in order.
    queue: RefCell<Vec<(u32, FetchOp)>>,
    /// `testing.js`' receiver of the engine's events.
    listener: RefCell<Option<Value>>,
}

impl Fetches {
    pub(super) fn call(&self, op: u32, args: &Value) -> Result<Value, PropError> {
        match op {
            1007 => {
                *self.listener.borrow_mut() = Some(args.index(0)?);
                Ok(Value(0))
            }
            1008 => {
                let method = args.index(0)?.as_string().unwrap_or_default();
                let url = args
                    .index(1)?
                    .as_string()
                    .ok_or_else(|| PropError("fetch: a URL".into()))?;
                let list = args.index(2)?;
                let headers = (0..list.length()?.unwrap_or(0))
                    .map(|i| {
                        let pair = list.index(i)?;
                        Ok((
                            pair.index(0)?.as_string().unwrap_or_default(),
                            pair.index(1)?.as_string().unwrap_or_default(),
                        ))
                    })
                    .collect::<Result<Vec<_>, PropError>>()?;
                let body = match args.index(3)?.read_bytes() {
                    Some(bytes) if !bytes.is_empty() => HttpBody::Bytes(bytes),
                    _ => HttpBody::Empty,
                };
                let follow_redirects = args.index(4)?.truthy();
                let id = self.next.get().wrapping_add(1).max(1);
                self.next.set(id);
                let mut request = HttpRequest::new(method, url);
                request.headers = headers;
                request.body = body;
                request.follow_redirects = follow_redirects;
                self.queue.borrow_mut().push((id, FetchOp::Start(request)));
                Ok(Value::number(id.into()))
            }
            1009 => {
                let id = args.index(0)?.as_number().unwrap_or(0.0) as u32;
                let mut queue = self.queue.borrow_mut();
                // Not handed to the network yet: it never starts.
                let queued = queue
                    .iter()
                    .any(|(r, op)| *r == id && matches!(op, FetchOp::Start(_)));
                if queued {
                    queue.retain(|(r, _)| *r != id);
                } else {
                    queue.push((id, FetchOp::Cancel));
                }
                Ok(Value(0))
            }
            _ => Err(PropError("unknown fetch operation".into())),
        }
    }

    pub(super) fn take(&self, out: &mut Vec<(u32, FetchOp)>) {
        out.append(&mut self.queue.borrow_mut());
    }

    /// Tells the listener what happened to request `id`: `[id, 0, status,
    /// statusText, url, redirected, [[name, value], …]]` for the head,
    /// `[id, 1, bytes]` for body data, `[id, 2]` at its end and `[id, 3,
    /// message]` when it failed (`[id, 4, message, url]` when the
    /// capabilities refused it: [`Self::refused`]).
    pub(super) fn event(&self, id: u32, event: FetchEvent) {
        let Some(listener) = self.listener.borrow().clone() else {
            return;
        };
        let args = (|| {
            let id = Value::number(id.into());
            Value::array(match event {
                // Bodies are sent whole: never asked for in chunks.
                FetchEvent::BodyWanted => return Ok(None),
                FetchEvent::Head(head) => vec![
                    id,
                    Value::number(0.0),
                    Value::number(head.status.into()),
                    Value::string(&head.status_text)?,
                    Value::string(&head.url)?,
                    Value(if head.redirected { 3 } else { 2 }),
                    Value::array(
                        head.headers
                            .iter()
                            .map(|(name, value)| {
                                Value::array([Value::string(name)?, Value::string(value)?])
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                    )?,
                ],
                FetchEvent::Data(bytes) => vec![id, Value::number(1.0), Value::bytes(&bytes)?],
                FetchEvent::End => vec![id, Value::number(2.0)],
                FetchEvent::Failed(message) => {
                    vec![id, Value::number(3.0), Value::string(&message)?]
                }
            })
            .map(Some)
        })();
        match args {
            Ok(Some(args)) => report(listener.call(&Value(0), &args)),
            Ok(None) => {}
            Err(error) => report(Err(error)),
        }
    }

    /// Tells the listener that the capabilities refused request `id`:
    /// `[id, 4, message, url]`.
    pub(super) fn refused(&self, id: u32, message: &str, url: &str) {
        let Some(listener) = self.listener.borrow().clone() else {
            return;
        };
        let args = (|| {
            Value::array([
                Value::number(id.into()),
                Value::number(4.0),
                Value::string(message)?,
                Value::string(url)?,
            ])
        })();
        match args {
            Ok(args) => report(listener.call(&Value(0), &args)),
            Err(error) => report(Err(error)),
        }
    }

    /// Forgets the listener and what was not taken (the app stops).
    pub(super) fn clear(&self) {
        self.listener.borrow_mut().take();
        self.queue.borrow_mut().clear();
    }
}
