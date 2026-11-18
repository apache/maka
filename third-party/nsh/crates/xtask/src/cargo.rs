//! The cargo commands xtask starts, each by the cargo that runs xtask.
//!
//! Cargo passes no `--locked` on to the cargo processes a command starts
//! (no environment variable carries it), so `cargo --locked xtask dist`
//! alone still lets every nested build resolve dependencies again and
//! write the lock file it finds. Above all `crates/gpui/Cargo.lock`: the
//! GPUI backend is a workspace of its own, whose lock the outer cargo never
//! reads, and a stale one would be rewritten and the GPUI host shipped
//! from versions no committed lock records. So the tasks' builds say
//! `--locked` themselves ([`command`]) and fail on a stale lock instead.
//! The root workspace's lock is current by the time they run: the outer
//! `cargo run -p xtask` has resolved that same workspace.

use std::{env, process::Command};

/// `cargo <subcommand> --locked`: what the tasks build (the distribution,
/// the Android, iOS and web runtimes), so that it is made from the
/// versions the lock files record or not at all. `--locked` follows the
/// subcommand, which every cargo command takes it after (`metadata`,
/// `rustc` and `clippy` too), before any `--` that hands the rest on.
pub(crate) fn command(subcommand: &str) -> Command {
    let mut cmd = unlocked(subcommand);
    cmd.arg("--locked");
    cmd
}

/// `cargo <subcommand>`, free to update the lock file: only where that is
/// the point, the development loop's rebuilds (`cargo run`, after the
/// developer edits a manifest) and nsh-compat's run on a copy of this
/// workspace's lock, which lacks nsh-compat's own packages.
pub(crate) fn unlocked(subcommand: &str) -> Command {
    let mut cmd = Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
    cmd.arg(subcommand);
    cmd
}

#[cfg(test)]
mod tests {
    use super::{command, unlocked};

    #[test]
    fn locked_follows_the_subcommand_before_any_double_dash() {
        for subcommand in ["build", "rustc", "clippy", "metadata"] {
            let mut cmd = command(subcommand);
            cmd.args(["-p", "nsh-cli", "--", "-D", "warnings"]);
            let args: Vec<_> = cmd.get_args().collect();
            assert_eq!(
                args,
                [
                    subcommand, "--locked", "-p", "nsh-cli", "--", "-D", "warnings"
                ]
            );
        }
    }

    #[test]
    fn the_development_loop_may_update_the_lock() {
        let cmd = unlocked("build");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, ["build"]);
    }
}
