//! `nsh test --attach`: the apps tests open are the app of a development
//! session that runs already (`nsh run`, `nsh dev`), driven in the host
//! windows it shows, as they are. The session's dev server takes the steps
//! from this machine only, with the token the session keeps in its port's
//! `.attach` file (`dev_port::AttachFile`), and hands each to the host it
//! names (`nsh_dev::Attachment`); the host's test agent takes it as in
//! `nsh test --target`. Closing the app leaves it running.

use std::{
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    sync::Arc,
    time::Duration,
};

use anyhow::bail;
use nsh_dev::{
    Attachment,
    protocol::{AttachHost, HostPlatform, TestStep},
};
use nsh_testing::{Host, HostOptions, HostTarget, StartHost};

use crate::{dev_port, ui};

/// Attaches to the development session on `port` (else the one running on
/// this machine, the app `entry`'s when several run) and drives its host
/// `device` names (by its name or its platform, as `nsh run --target`
/// names it; else the one that connected last), saying which it took: what
/// opens the tests' apps there, and what `open` checks its options against.
pub(crate) fn starter(
    port: Option<u16>,
    device: Option<&str>,
    entry: &Path,
) -> anyhow::Result<(StartHost, HostTarget)> {
    let (port, attachment, hosts) = connect(port, entry)?;
    let host = choose(&hosts, device, port)?;
    ui::note(format!(
        "attached to {} (the development session on port {port})",
        host.device
    ));
    for other in hosts.iter().filter(|h| h.id != host.id) {
        let how = if other.steps {
            format!("--device \"{}\"", other.device)
        } else {
            "takes no steps".to_owned()
        };
        ui::detail(ui::dim(format!("also connected: {} ({how})", other.device)));
    }
    let mut target = HostTarget::default();
    target.name = host
        .platform
        .and_then(target_name)
        .unwrap_or("attach")
        .to_owned();
    target.sized = true;
    target.attached = true;
    let attachment = Arc::new(attachment);
    let id = host.id;
    let start: StartHost = Arc::new(move |_: &Path, _: &HostOptions| {
        Ok(Box::new(AttachedHost {
            attachment: attachment.clone(),
            id,
        }) as Box<dyn Host>)
    });
    Ok((start, target))
}

/// The host an attached test drives.
struct AttachedHost {
    attachment: Arc<Attachment>,
    /// Its connection to the session.
    id: u64,
}

impl Host for AttachedHost {
    fn step(&self, step: TestStep, timeout: Duration) -> Result<serde_json::Value, String> {
        // Closing the app quits it in a test's host: an attached session
        // leaves it running.
        if matches!(step, TestStep::Quit) {
            return Ok(serde_json::Value::Null);
        }
        self.attachment.step(self.id, step, timeout)
    }
}

/// Connects to the session on `port`, else to the one running on this
/// machine: the app `entry`'s when several run.
fn connect(port: Option<u16>, entry: &Path) -> anyhow::Result<(u16, Attachment, Vec<AttachHost>)> {
    let sessions = dev_port::attachable_sessions(port)?;
    let mut live = Vec::new();
    let mut refused = Vec::new();
    for session in sessions {
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, session.port));
        match Attachment::connect(addr, &session.token) {
            Ok((attachment, hosts)) => live.push((session, attachment, hosts)),
            // Left by a session that ended without its cleanup.
            Err(message) => refused.push((session.port, message)),
        }
    }
    if live.len() > 1 {
        let apps: Vec<_> = live
            .iter()
            .filter(|(s, ..)| s.app.as_deref().is_some_and(|a| dev_port::is_app(a, entry)))
            .map(|(s, ..)| s.port)
            .collect();
        if let [port] = apps[..] {
            live.retain(|(s, ..)| s.port == port);
        }
    }
    match live.len() {
        1 => {
            let (session, attachment, hosts) = live.remove(0);
            Ok((session.port, attachment, hosts))
        }
        0 => match (port, refused.first()) {
            (Some(port), Some((_, message))) => {
                bail!("cannot attach to the development session on port {port}: {message}")
            }
            (Some(port), None) => bail!(
                "no development session runs on port {port} on this machine: start one with `nsh \
                 run` or `nsh dev`"
            ),
            (None, _) => bail!(
                "no development session runs on this machine: start one with `nsh run` or `nsh dev`"
            ),
        },
        _ => {
            let sessions: Vec<String> = live
                .iter()
                .map(|(s, ..)| match &s.app {
                    Some(app) => format!("--attach={} ({})", s.port, ui::path(app)),
                    None => format!("--attach={}", s.port),
                })
                .collect();
            bail!(
                "several development sessions run on this machine; pick one: {}",
                sessions.join(", ")
            )
        }
    }
}

/// The host of `hosts` that `device` names, else the one that connected last
/// of those taking steps.
fn choose<'a>(
    hosts: &'a [AttachHost],
    device: Option<&str>,
    port: u16,
) -> anyhow::Result<&'a AttachHost> {
    if hosts.is_empty() {
        bail!("no host is connected to the development session on port {port}");
    }
    let listed = || {
        hosts
            .iter()
            .map(|h| format!("\"{}\"", h.device))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let host = match device {
        Some(name) => named(hosts, name).ok_or_else(|| {
            anyhow::anyhow!(
                "no host {name:?} is connected to the development session on port {port}: \
                     {}",
                listed()
            )
        })?,
        None => match hosts.iter().rev().find(|h| h.steps) {
            Some(host) => host,
            None => hosts.last().expect("a host"),
        },
    };
    if !host.steps {
        bail!(
            "{} takes no steps outside a test session: its host keeps no model of the app there \
             (connected: {})",
            host.device,
            listed()
        );
    }
    Ok(host)
}

/// The host of `hosts` `name` names, the one that connected last of those
/// it names: by its device name, else its platform as `nsh run --target`
/// names it, else a part of its device name in any case.
fn named<'a>(hosts: &'a [AttachHost], name: &str) -> Option<&'a AttachHost> {
    let lower = name.to_lowercase();
    let find = |names: &dyn Fn(&AttachHost) -> bool| hosts.iter().rev().find(|h| names(h));
    find(&|h| h.device == name)
        .or_else(|| find(&|h| h.platform.and_then(target_name) == Some(name)))
        .or_else(|| find(&|h| h.device.to_lowercase().contains(&lower)))
}

/// `platform`'s name as `nsh run --target` gives it.
fn target_name(platform: HostPlatform) -> Option<&'static str> {
    Some(match platform {
        HostPlatform::MacCatalyst => "catalyst",
        HostPlatform::IosSimulator | HostPlatform::Ios => "ios",
        HostPlatform::Android => "android",
        HostPlatform::Linux => "linux",
        HostPlatform::MacOs => "macos",
        HostPlatform::Windows => "windows",
        HostPlatform::Web => "web",
        HostPlatform::Gpui => "gpui",
        HostPlatform::Tui => "tui",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(id: u64, device: &str, platform: HostPlatform, steps: bool) -> AttachHost {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "device": device,
            "platform": platform,
            "steps": steps,
        }))
        .unwrap()
    }

    #[test]
    fn the_host_that_connected_last_is_driven_unless_one_is_named() {
        let hosts = [
            host(1, "GPUI (macOS)", HostPlatform::Gpui, true),
            host(2, "macOS", HostPlatform::MacOs, true),
            host(3, "Chrome", HostPlatform::Web, false),
        ];
        assert_eq!(choose(&hosts, None, 8790).unwrap().id, 2);
        assert_eq!(choose(&hosts, Some("gpui"), 8790).unwrap().id, 1);
        assert_eq!(choose(&hosts, Some("GPUI (macOS)"), 8790).unwrap().id, 1);
        // A platform before a part of a name: "macos" is in GPUI's name too.
        let later = [hosts[1].clone(), hosts[0].clone()];
        assert_eq!(choose(&later, Some("macos"), 8790).unwrap().id, 2);
        assert_eq!(choose(&later, None, 8790).unwrap().id, 1);
        let error = choose(&hosts, Some("web"), 8790).unwrap_err().to_string();
        assert!(
            error.starts_with("Chrome takes no steps outside a test session"),
            "{error}"
        );
        let error = choose(&hosts, Some("android"), 8790)
            .unwrap_err()
            .to_string();
        assert!(error.contains("no host \"android\""), "{error}");
        assert!(choose(&[], None, 8790).is_err());
    }
}
