//! The web runtime split into a main module and side modules loaded when
//! an app's chunk needs them (`prune::split`).

pub(crate) use super::prune::split::split;
