//! NSH #2750: when a Rust class's async work starts, as JS sees it.
//! `async fn` (today: its body runs at the next executor run) against a
//! `this: Instance<Self>` method returning `Later<T>` (its body runs in
//! the JS call, the work after it as a task).

use std::time::Duration;

use nsh_core::{element::Registry, prelude::*};

use crate::rust_classes::{shown, start};

#[class]
pub(crate) struct Loader {
    loading: bool,
    starts: u32,
}

#[class]
impl Loader {
    pub(crate) fn new() -> Self {
        Loader {
            loading: false,
            starts: 0,
        }
    }

    #[getter]
    pub(crate) fn loading(&self) -> bool {
        self.loading
    }

    #[getter]
    pub(crate) fn starts(&self) -> u32 {
        self.starts
    }

    /// Today's shape: the body (and so `loading = true`) runs later.
    pub(crate) async fn load_async(this: Instance<Self>, ms: u32) -> Result<u32, String> {
        let n = this.with_mut(|l| {
            if l.loading {
                return Err("busy".to_owned());
            }
            l.loading = true;
            l.starts += 1;
            Ok(l.starts)
        })?;
        timer(Duration::from_millis(ms.into())).await;
        this.with_mut(|l| l.loading = false);
        Ok(n)
    }

    /// One method, eager: the guard and `loading = true` run in the JS
    /// call; the wait and the reset run as a core task.
    pub(crate) fn load(this: Instance<Self>, ms: u32, fail: bool) -> Result<Later<u32>, JsError> {
        let n = this.with_mut(|l| {
            if l.loading {
                return Err(JsError::Error("busy".into()));
            }
            l.loading = true;
            l.starts += 1;
            Ok(l.starts)
        })?;
        Ok(Later::new(async move {
            timer(Duration::from_millis(ms.into())).await;
            this.with_mut(|l| l.loading = false);
            if fail {
                Err("failed".to_owned())
            } else {
                Ok(n)
            }
        }))
    }
}

fn registry() -> Registry {
    let mut r = Registry::ui_set("test/loader");
    r.class::<Loader>();
    r
}

const APP: &str = r#"import { mount, signal, Text } from "nsh";
import { Loader } from "test/loader";

const shown = signal("waiting");
const settled = async (p) => { try { return String(await p); } catch (e) { return `${e.constructor.name}: ${e.message}`; } };
setTimeout(async () => {
  const lines = [];
  // async fn: nothing has run when the call returns, nor after a microtask.
  const a = new Loader();
  const p1 = a.loadAsync(5);
  const sync1 = a.loading;
  await Promise.resolve();
  const micro1 = a.loading;
  const p2 = a.loadAsync(5);
  lines.push(`async sync=${sync1} micro=${micro1} r1=${await settled(p1)} r2=${await settled(p2)} starts=${a.starts}`);
  // Later: the guard runs in the call; a double click is refused at once.
  const b = new Loader();
  const q1 = b.load(5, false);
  const sync2 = b.loading;
  const q2 = b.load(5, false);
  lines.push(`later sync=${sync2} r1=${await settled(q1)} r2=${await settled(q2)} after=${b.loading} starts=${b.starts}`);
  // Error path: the reset runs, the promise rejects.
  const c = new Loader();
  const e1 = await settled(c.load(1, true));
  lines.push(`error ${e1} after=${c.loading}`);
  // Disposed while the task waits: both shapes reject the same way.
  const d = new Loader();
  const w = d.load(5, false);
  d.dispose();
  const e = new Loader();
  const v = e.loadAsync(5);
  e.dispose();
  lines.push(`disposed later=${await settled(w)} async=${await settled(v)}`);
  shown.set(`done ${lines.join("|")}`);
}, 0);

mount(() => <Text>{shown()}</Text>);
"#;

#[test]
fn async_fn_starts_late_and_later_starts_in_the_call() {
    let (_engine, rx) = start(APP, vec![registry()]);
    let got = shown(&rx, "done");
    assert_eq!(
        got,
        "done async sync=false micro=false r1=1 r2=Error: busy starts=1|\
         later sync=true r1=1 r2=Error: busy after=false starts=1|\
         error Error: failed after=false|disposed later=Error: Loader is disposed async=Error: Loader is disposed"
    );
}
