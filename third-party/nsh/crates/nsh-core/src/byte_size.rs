//! A size in bytes, as limits of what is kept (caches) are given: in
//! mebibytes or gibibytes, typed as lengths are ([`crate::geometry`]).

use std::fmt;

/// A size in bytes, made from mebibytes or gibibytes (`ByteSize::mib(256)`):
/// how much a cache keeps at most.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ByteSize(u64);

impl ByteSize {
    /// No bytes.
    pub const ZERO: ByteSize = ByteSize(0);

    /// `n` mebibytes (`n` × 2²⁰ bytes).
    pub const fn mib(n: u64) -> ByteSize {
        ByteSize(n.saturating_mul(1 << 20))
    }

    /// `n` gibibytes (`n` × 2³⁰ bytes).
    pub const fn gib(n: u64) -> ByteSize {
        ByteSize(n.saturating_mul(1 << 30))
    }

    /// The size in bytes.
    pub const fn bytes(self) -> u64 {
        self.0
    }

    /// Whether it is no bytes.
    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    /// The size in bytes, for tests and internal bookkeeping of a crate
    /// (whole mebibytes are the public way to make one).
    #[cfg(test)]
    pub(crate) const fn from_bytes(bytes: u64) -> ByteSize {
        ByteSize(bytes)
    }
}

impl fmt::Display for ByteSize {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_multiple_of(1 << 30) && self.0 > 0 {
            write!(f, "{} GiB", self.0 >> 30)
        } else if self.0.is_multiple_of(1 << 20) {
            write!(f, "{} MiB", self.0 >> 20)
        } else {
            write!(f, "{} bytes", self.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ByteSize;

    #[test]
    fn sizes_are_made_from_mebibytes() {
        assert_eq!(ByteSize::mib(256).bytes(), 256 << 20);
        assert_eq!(ByteSize::gib(2), ByteSize::mib(2048));
        assert!(ByteSize::mib(0).is_zero());
        assert_eq!(ByteSize::mib(u64::MAX).bytes(), u64::MAX);
        assert_eq!(ByteSize::mib(256).to_string(), "256 MiB");
        assert_eq!(ByteSize::gib(1).to_string(), "1 GiB");
    }
}
