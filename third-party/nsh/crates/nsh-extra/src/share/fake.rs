//! The share sheet of headless runs (`nsh test`): the fake
//! `"nsh-extra/share"` ([`nsh_core::fake`]), which the headless driver
//! installs before the app starts. Until a test answers, there is no share
//! sheet: `Share.available()` resolves `false` and a share fails with
//! `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, as on a platform without one. A
//! test calls it by name (TS `app.fake("nsh-extra/share", method, args)`,
//! Rust `Headless::call_fake`):
//!
//! - `answer` `[{ action, target }]`: the platform shows a share sheet from
//!   now on, and the user answers every share with it: `"shared"` (to
//!   `target`, if given) or `"dismissed"`.
//! - `hold` `[]`: the platform shows a share sheet from now on, and the
//!   user leaves each open: the next share answers it as dismissed.
//! - `shares` `[]`: what the app shared, in order, past the checks:
//!   `[{ title, text, url, files, anchored }]` (`null` for what was not
//!   given; `files` their real paths; `anchored` whether the sheet points
//!   at a view of the app's, its `anchor`).
//!
//! The website's `Share` section documents the methods for apps.

use std::sync::{Arc, Mutex, MutexGuard};

use nsh_core::{JsonValue, fake::Fake};

use super::{Reply, ShareOutcome, ShareSheet};

/// The name tests call the fake by.
pub(crate) const NAME: &str = "nsh-extra/share";

/// How the fake user answers.
#[derive(Debug, Clone, Default, PartialEq)]
enum Answer {
    /// There is no share sheet.
    #[default]
    None,
    /// Every share is answered so.
    With(ShareOutcome),
    /// Every share stays open.
    Hold,
}

#[derive(Default)]
struct Sheets {
    answer: Answer,
    /// What the app shared, in order.
    shared: Vec<ShareSheet>,
}

/// The fake share sheet the test answers.
#[derive(Clone, Default)]
pub(crate) struct FakeShare(Arc<Mutex<Sheets>>);

impl FakeShare {
    fn sheets(&self) -> MutexGuard<'_, Sheets> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether the platform shows a share sheet (the test answered).
    pub(super) fn available(&self) -> bool {
        self.sheets().answer != Answer::None
    }

    /// Records `sheet` and answers it as the test said. A sheet the user
    /// leaves open never ends, as a platform's sheet stays up until it is
    /// closed: only the next share answers it.
    pub(super) async fn show(&self, sheet: ShareSheet, reply: Reply) {
        let answer = {
            let mut sheets = self.sheets();
            if sheets.answer == Answer::None {
                drop(sheets);
                return super::none::show(sheet, reply);
            }
            sheets.shared.push(sheet);
            sheets.answer.clone()
        };
        match answer {
            Answer::With(outcome) => {
                reply.send(Ok(outcome));
            }
            Answer::Hold => std::future::pending::<()>().await,
            Answer::None => {}
        }
    }

    fn shared(&self) -> JsonValue {
        let text = |value: &Option<String>| JsonValue::from(value.clone());
        JsonValue::Array(
            self.sheets()
                .shared
                .iter()
                .map(|sheet| {
                    JsonValue::from_iter([
                        ("title", text(&sheet.title)),
                        ("text", text(&sheet.text)),
                        ("url", text(&sheet.url)),
                        ("files", JsonValue::from(sheet.files.clone())),
                        ("anchored", JsonValue::Bool(sheet.anchor.is_some())),
                    ])
                })
                .collect(),
        )
    }
}

/// The outcome an `answer` argument names.
fn outcome(arg: Option<&JsonValue>) -> Result<ShareOutcome, String> {
    let object = arg
        .and_then(JsonValue::as_object)
        .ok_or("the answer must be an object: { action, target }")?;
    let target = match object.get("target") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(target)) => Some(target.clone()),
        Some(_) => return Err("`target` must be a string".into()),
    };
    match object.get("action").and_then(JsonValue::as_str) {
        Some("shared") => Ok(ShareOutcome::shared(target)),
        Some("dismissed") => Ok(ShareOutcome::dismissed()),
        _ => Err("`action` must be \"shared\" or \"dismissed\"".into()),
    }
}

impl Fake for FakeShare {
    fn install(&self) {
        // A new app: what an earlier one shared and was answered is gone.
        *self.sheets() = Sheets::default();
        super::set_backend(Some(self.clone()));
    }

    fn call(&self, method: &str, args: &[JsonValue]) -> Result<JsonValue, String> {
        match method {
            "answer" => {
                self.sheets().answer = Answer::With(outcome(args.first())?);
                Ok(JsonValue::Null)
            }
            "hold" => {
                self.sheets().answer = Answer::Hold;
                Ok(JsonValue::Null)
            }
            "shares" => Ok(self.shared()),
            _ => Err(format!(
                "the fake {NAME:?} has no method {method:?} (answer, hold, shares)"
            )),
        }
    }
}
