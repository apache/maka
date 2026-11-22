//! A VM's resource limits. Only apps embedded in another app have them,
//! and the embedding app decides them ([`HostLimits`] over
//! [`Limits::default`]); an app nsh runs on its own is the developer's own
//! code, as a native app is, and has none ([`Limits::standalone`]).

use std::{fmt, time::Duration};

/// Resource limits of one VM.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    /// QuickJS heap, in bytes (0: no limit). Running out stops the VM.
    pub memory_bytes: usize,
    /// Interpreter stack, in bytes: deep recursion becomes a `RangeError`
    /// rather than a native stack overflow. Must stay below the engine
    /// thread's stack.
    pub stack_bytes: usize,
    /// Evaluating the bundle (`Duration::MAX`: no limit).
    pub load_budget: Duration,
    /// Any other call into JS: one event (with the rendering it causes), one
    /// list bind, one timer, one frame's callbacks, the microtask drain
    /// (`Duration::MAX`: no limit).
    pub call_budget: Duration,
    /// Changes JS may make at once (the op queue's length): they are held in
    /// Rust memory, which the heap limit does not cover (`usize::MAX`: no
    /// limit).
    pub max_op_values: usize,
    /// Operations one canvas drawing may record (`usize::MAX`: no limit).
    pub max_canvas_ops: usize,
    /// Nodes the core keeps (each may have a native view, whose memory the
    /// heap limit does not cover either; `usize::MAX`: no limit).
    pub max_nodes: usize,
}

impl Limits {
    /// The limits of an app nsh runs on its own (the hosts and runners of
    /// every platform, a web package, `nsh run` without `--limits`): none
    /// but the interpreter stack's, which turns deep recursion into a
    /// `RangeError` instead of a crash of the process.
    pub fn standalone() -> Self {
        Self {
            memory_bytes: 0,
            stack_bytes: Self::default().stack_bytes,
            load_budget: Duration::MAX,
            call_budget: Duration::MAX,
            max_op_values: usize::MAX,
            max_canvas_ops: usize::MAX,
            max_nodes: usize::MAX,
        }
    }

    /// The limits of a development host's app: those an embedding app
    /// would set (`spec`, as [`HostLimits::parse`] reads it: `nsh run
    /// --limits`, which the dev server passes on), or none
    /// ([`Limits::standalone`]) without a spec.
    pub fn development(spec: Option<&str>) -> Result<Self, String> {
        match spec {
            None => Ok(Self::standalone()),
            Some(spec) => Ok(HostLimits::parse(spec)?.limits()),
        }
    }
}

/// The limits of an app embedded in a host app (`NshAppView`, `NshView`,
/// `AppView`) that sets none: a 256 MB heap, 10 s to load, 2 s per call.
impl Default for Limits {
    fn default() -> Self {
        Self {
            memory_bytes: 256 << 20,
            stack_bytes: 4 << 20,
            load_budget: Duration::from_secs(10),
            call_budget: Duration::from_secs(2),
            max_op_values: 8_000_000,
            max_canvas_ops: 1_000_000,
            max_nodes: 200_000,
        }
    }
}

/// The limits an embedding app sets for the apps it embeds (`NshLimits`
/// on iOS, `NshView.setLimits` on Android), and those `nsh run --limits`
/// runs an app with as such an app would: each one it leaves out keeps
/// its default ([`Limits::default`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HostLimits {
    /// The QuickJS heap, in bytes.
    pub memory_bytes: Option<usize>,
    /// The interpreter stack, in bytes; at most the default (4 MB), which
    /// leaves the engine thread's stack room for native frames.
    pub stack_bytes: Option<usize>,
    /// Evaluating the bundle.
    pub load_budget: Option<Duration>,
    /// Any other call into JS.
    pub call_budget: Option<Duration>,
    /// Nodes the core keeps.
    pub max_nodes: Option<usize>,
}

const KB: usize = 1 << 10;
const MB: usize = 1 << 20;
const GB: usize = 1 << 30;

impl HostLimits {
    /// The limits these give: the defaults with what is set.
    pub fn limits(&self) -> Limits {
        let defaults = Limits::default();
        Limits {
            memory_bytes: self.memory_bytes.unwrap_or(defaults.memory_bytes),
            stack_bytes: self
                .stack_bytes
                .map_or(defaults.stack_bytes, |b| b.min(defaults.stack_bytes)),
            load_budget: self.load_budget.unwrap_or(defaults.load_budget),
            call_budget: self.call_budget.unwrap_or(defaults.call_budget),
            max_nodes: self.max_nodes.unwrap_or(defaults.max_nodes),
            ..defaults
        }
    }

    /// Reads limits written as `nsh run --limits` takes them: `key=value`
    /// pairs separated by commas, of `memory` and `stack` (a size in `KB`,
    /// `MB` or `GB`), `load` and `call` (a time in `ms` or `s`) and `nodes`
    /// (a count), say `memory=128MB,call=500ms`. Each value is above zero;
    /// the empty string sets none.
    pub fn parse(spec: &str) -> Result<Self, String> {
        let mut limits = HostLimits::default();
        for pair in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let Some((key, value)) = pair.split_once('=') else {
                return Err(format!("`{pair}` is not `key=value`"));
            };
            let (key, value) = (key.trim(), value.trim());
            let set = match key {
                "memory" => limits.memory_bytes.replace(size(key, value)?).is_some(),
                "stack" => limits.stack_bytes.replace(size(key, value)?).is_some(),
                "load" => limits.load_budget.replace(time(key, value)?).is_some(),
                "call" => limits.call_budget.replace(time(key, value)?).is_some(),
                "nodes" => limits.max_nodes.replace(count(key, value)?).is_some(),
                _ => {
                    return Err(format!(
                        "unknown limit `{key}` (memory, stack, load, call or nodes)"
                    ));
                }
            };
            if set {
                return Err(format!("`{key}` is set twice"));
            }
        }
        Ok(limits)
    }
}

/// The limits as [`HostLimits::parse`] reads them.
impl fmt::Display for HostLimits {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn bytes(b: usize) -> String {
            if b.is_multiple_of(MB) {
                format!("{}MB", b / MB)
            } else {
                format!("{}KB", b.div_ceil(KB))
            }
        }
        let pairs = [
            self.memory_bytes.map(|b| format!("memory={}", bytes(b))),
            self.stack_bytes.map(|b| format!("stack={}", bytes(b))),
            self.load_budget
                .map(|d| format!("load={}ms", d.as_millis())),
            self.call_budget
                .map(|d| format!("call={}ms", d.as_millis())),
            self.max_nodes.map(|n| format!("nodes={n}")),
        ];
        let pairs: Vec<String> = pairs.into_iter().flatten().collect();
        f.write_str(&pairs.join(","))
    }
}

/// `value` split into its number (above zero) and its unit.
fn number<'a>(key: &str, value: &'a str) -> Result<(usize, &'a str), String> {
    let digits = value
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(value.len());
    let n: usize = value[..digits]
        .parse()
        .map_err(|_| format!("`{key}`: `{value}` is not a number"))?;
    if n == 0 {
        return Err(format!("`{key}`: `{value}` is not above zero"));
    }
    Ok((n, value[digits..].trim()))
}

fn size(key: &str, value: &str) -> Result<usize, String> {
    let (n, unit) = number(key, value)?;
    let scale = match unit.to_ascii_uppercase().as_str() {
        "KB" => KB,
        "MB" => MB,
        "GB" => GB,
        _ => return Err(format!("`{key}`: `{value}` needs a unit: KB, MB or GB")),
    };
    n.checked_mul(scale)
        .ok_or_else(|| format!("`{key}`: `{value}` is too large"))
}

fn time(key: &str, value: &str) -> Result<Duration, String> {
    let (n, unit) = number(key, value)?;
    let ms = match unit.to_ascii_lowercase().as_str() {
        "ms" => Some(n as u64),
        "s" => (n as u64).checked_mul(1000),
        _ => return Err(format!("`{key}`: `{value}` needs a unit: ms or s")),
    };
    ms.map(Duration::from_millis)
        .ok_or_else(|| format!("`{key}`: `{value}` is too large"))
}

fn count(key: &str, value: &str) -> Result<usize, String> {
    match number(key, value)? {
        (n, "") => Ok(n),
        _ => Err(format!("`{key}`: `{value}` is not a count")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_limits_set_what_they_name_over_the_defaults() {
        let limits = HostLimits::parse("memory=128MB, call=500ms,nodes=5000").unwrap();
        assert_eq!(
            limits.limits(),
            Limits {
                memory_bytes: 128 << 20,
                call_budget: Duration::from_millis(500),
                max_nodes: 5000,
                ..Limits::default()
            }
        );
        assert_eq!(limits.to_string(), "memory=128MB,call=500ms,nodes=5000");
        assert_eq!(HostLimits::parse(&limits.to_string()), Ok(limits));
        // None set: an embedding app's defaults.
        assert_eq!(HostLimits::parse("").unwrap().limits(), Limits::default());
        let all = HostLimits::parse("memory=1gb,stack=512KB,load=5s,call=2s,nodes=1").unwrap();
        assert_eq!(
            all.to_string(),
            "memory=1024MB,stack=512KB,load=5000ms,call=2000ms,nodes=1"
        );
        // The stack stays within the engine thread's.
        let stack = HostLimits::parse("stack=64MB").unwrap().limits();
        assert_eq!(stack.stack_bytes, Limits::default().stack_bytes);
    }

    #[test]
    fn host_limits_name_what_is_wrong() {
        for (spec, error) in [
            ("memory=128", "`memory`: `128` needs a unit: KB, MB or GB"),
            ("call=2m", "`call`: `2m` needs a unit: ms or s"),
            ("nodes=10k", "`nodes`: `10k` is not a count"),
            ("load=0s", "`load`: `0s` is not above zero"),
            (
                "heap=1MB",
                "unknown limit `heap` (memory, stack, load, call or nodes)",
            ),
            ("call=1s,call=2s", "`call` is set twice"),
            ("memory", "`memory` is not `key=value`"),
            ("memory=MB", "`memory`: `MB` is not a number"),
        ] {
            assert_eq!(HostLimits::parse(spec), Err(error.to_owned()), "{spec}");
        }
    }

    #[test]
    fn standalone_apps_and_development_without_limits_have_none() {
        let none = Limits::standalone();
        assert_eq!(none.memory_bytes, 0);
        assert_eq!(none.call_budget, Duration::MAX);
        assert_eq!(none.max_nodes, usize::MAX);
        assert_eq!(none.stack_bytes, Limits::default().stack_bytes);
        assert_eq!(Limits::development(None), Ok(none));
        assert_eq!(Limits::development(Some("")), Ok(Limits::default()));
        assert!(Limits::development(Some("call=")).is_err());
    }
}
