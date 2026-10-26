//! What a Rust crate can export to TSX (`examples/rust-exports`): a
//! component ([`Gauge`]), a module of functions ([`Ledger`]) and a class
//! ([`Account`]). `App.tsx` imports all three from `rust-exports/native`,
//! the specifier of the set below (`nsh.json` `"rust": "native"`), and
//! their TypeScript declarations are generated from these types into
//! `.nsh/types/rust-exports/native.d.ts`.

mod account;
mod gauge;
mod ledger;

use nsh_core::prelude::*;

pub use crate::{
    account::Account,
    gauge::{Gauge, GaugeElement, GaugeEvent, GaugeProps, gauge},
    ledger::Ledger,
};

/// The crate's UI set: what `App.tsx` imports from `rust-exports/native`.
#[native_module("rust-exports/native")]
fn native(registry: &mut Registry) {
    registry
        .register::<Gauge>()
        .module::<Ledger>()
        .class::<Account>();
}
