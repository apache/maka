//! Owned browser value handles. A slot ID includes its generation; it is
//! meaningful only to this Wasm instance's browser host.
use nsh_core::{
    element::{JsPrimitive, PropError},
    js::host::{HostInput, HostList},
};

pub(super) const EXCEPTION: u32 = u32::MAX;
#[link(wasm_import_module = "nsh_browser")]
unsafe extern "C" {
    fn value(op: u32, a: u32, b: u32, c: u32, number: f64) -> f64;
}

pub(super) fn invoke(op: u32, a: u32, b: u32, c: u32, number: f64) -> f64 {
    // SAFETY: the player installs the matching import. Pointers supplied
    // by callers name live slices for this synchronous invocation only.
    unsafe { value(op, a, b, c, number) }
}

#[derive(Debug)]
pub(super) struct Value(pub u32);
impl Clone for Value {
    fn clone(&self) -> Self {
        invoke(16, self.0, 0, 0, 0.0);
        Self(self.0)
    }
}
impl Drop for Value {
    fn drop(&mut self) {
        invoke(17, self.0, 0, 0, 0.0);
    }
}
impl Value {
    pub(super) fn into_raw(self) -> u32 {
        let id = self.0;
        std::mem::forget(self);
        id
    }
    pub(super) fn borrowed(id: u32) -> Self {
        invoke(16, id, 0, 0, 0.0);
        Self(id)
    }
    pub(super) fn checked(id: f64) -> Result<Self, PropError> {
        if id as u32 == EXCEPTION {
            // Extract a message in one guarded browser operation. Reading a
            // thrown object's `message` can itself throw; never recurse here.
            let text = invoke(38, 0, 0, 0, 0.0) as u32;
            let message = if text == EXCEPTION {
                "browser value operation failed".into()
            } else {
                Self(text)
                    .as_string()
                    .unwrap_or_else(|| "browser value operation failed".into())
            };
            Err(PropError(message))
        } else {
            Ok(Self(id as u32))
        }
    }
    pub(super) fn length(&self) -> Result<Option<usize>, PropError> {
        let n = invoke(7, self.0, 0, 0, 0.0);
        if n == EXCEPTION as f64 {
            return Self::checked(n).map(|_| None);
        }
        Ok((!n.is_nan()).then_some(n as usize))
    }
    pub(super) fn kind(&self) -> u32 {
        invoke(0, self.0, 0, 0, 0.0) as u32
    }
    pub(super) fn number(n: f64) -> Self {
        Self(invoke(18, 0, 0, 0, n) as u32)
    }
    pub(super) fn string(s: &str) -> Result<Self, PropError> {
        Self::checked(invoke(19, 0, s.as_ptr() as u32, s.len() as u32, 0.0))
    }
    pub(super) fn bytes(bytes: &[u8]) -> Result<Self, PropError> {
        Self::checked(invoke(
            20,
            0,
            bytes.as_ptr() as u32,
            bytes.len() as u32,
            0.0,
        ))
    }
    pub(super) fn object() -> Result<Self, PropError> {
        Self::checked(invoke(23, 0, 0, 0, 0.0))
    }
    pub(super) fn array(items: impl IntoIterator<Item = Self>) -> Result<Self, PropError> {
        let array = Self::checked(invoke(21, 0, 0, 0, 0.0))?;
        for (i, value) in items.into_iter().enumerate() {
            Self::checked(invoke(22, array.0, i as u32, value.0, 0.0))?;
        }
        Ok(array)
    }
    pub(super) fn set(&self, key: &str, value: &Self) -> Result<(), PropError> {
        let key = Self::string(key)?;
        Self::checked(invoke(24, self.0, key.0, value.0, 0.0))?;
        Ok(())
    }
    pub(super) fn get(&self, key: &str) -> Result<Self, PropError> {
        Self::checked(invoke(
            9,
            self.0,
            key.as_ptr() as u32,
            key.len() as u32,
            0.0,
        ))
    }
    pub(super) fn index(&self, i: usize) -> Result<Self, PropError> {
        Self::checked(invoke(8, self.0, i as u32, 0, 0.0))
    }
    pub(super) fn keys(&self) -> Result<Vec<String>, PropError> {
        let joined = Self::checked(invoke(50, self.0, 0, 0, 0.0))?;
        if let Some(joined) = joined.as_string() {
            if joined.is_empty() {
                return Ok(Vec::new());
            }
            return Ok(joined.split('\0').map(str::to_owned).collect());
        }
        let keys = Self::checked(invoke(10, self.0, 0, 0, 0.0))?;
        let n = keys.length()?.unwrap_or(0);
        (0..n)
            .map(|i| keys.index(i).map(|v| v.as_string().unwrap_or_default()))
            .collect()
    }
    /// The items of the array this is (`entries`: the fields of the object
    /// this is, with their keys) as primitives, read in one call: the host
    /// packs them (see `values.js` op 49), retried once with the room it
    /// asks for. `None`: not an array.
    pub(super) fn primitives(
        &self,
        entries: bool,
    ) -> Result<Option<Vec<(String, JsPrimitive)>>, PropError> {
        let mut packed: Vec<u8> = Vec::with_capacity(512);
        let n = loop {
            let n = invoke(
                49,
                self.0,
                packed.as_mut_ptr() as u32,
                packed.capacity() as u32,
                f64::from(u8::from(entries)),
            );
            if n.is_nan() {
                return Ok(None);
            }
            if n == EXCEPTION as f64 {
                return Self::checked(n).map(|_| None);
            }
            if n >= 0.0 {
                break n as usize;
            }
            packed.reserve_exact(-n as usize);
        };
        // SAFETY: the host wrote `n` bytes, at most the capacity it was given.
        unsafe { packed.set_len(n) };
        Ok(Some(unpack(&packed, entries)))
    }
    pub(super) fn call(&self, this: &Self, args: &Self) -> Result<Self, PropError> {
        Self::checked(invoke(26, self.0, this.0, args.0, 0.0))
    }
    pub(super) fn read_bytes(&self) -> Option<Vec<u8>> {
        let n = invoke(5, self.0, 0, 0, 0.0);
        if n.is_nan() || n == EXCEPTION as f64 {
            return None;
        }
        let mut bytes = vec![0; n as usize];
        invoke(
            6,
            self.0,
            bytes.as_mut_ptr() as u32,
            bytes.len() as u32,
            0.0,
        );
        Some(bytes)
    }
}
impl HostInput for Value {
    fn is_nullish(&self) -> bool {
        self.kind() < 2
    }
    fn is_object(&self) -> bool {
        matches!(self.kind(), 5..=7)
    }
    fn as_bool(&self) -> Option<bool> {
        (self.kind() == 2).then_some(self.0 == 3)
    }
    fn as_number(&self) -> Option<f64> {
        (self.kind() == 3).then(|| invoke(2, self.0, 0, 0, 0.0))
    }
    fn as_string(&self) -> Option<String> {
        if self.kind() != 4 {
            return None;
        }
        let units = invoke(3, self.0, 0, 0, 0.0);
        if units.is_nan() || units == EXCEPTION as f64 {
            return None;
        }
        // One call encodes the string into the buffer: most text takes a
        // byte per UTF-16 unit, and none takes more than three.
        let units = units as usize;
        let mut bytes: Vec<u8> = Vec::with_capacity(units);
        loop {
            let written = invoke(
                4,
                self.0,
                bytes.as_mut_ptr() as u32,
                bytes.capacity() as u32,
                0.0,
            );
            if written >= 0.0 && written != EXCEPTION as f64 {
                // SAFETY: the host wrote `written` bytes (at most the
                // capacity it was given) into the buffer.
                unsafe { bytes.set_len(written as usize) };
                return String::from_utf8(bytes).ok();
            }
            if written != -1.0 || bytes.capacity() >= units * 3 {
                return None;
            }
            bytes.reserve_exact(units * 3);
        }
    }
    fn field(&self, key: &str) -> Option<Self> {
        self.get(key).ok()
    }
    fn as_list(&self) -> Option<Self::List> {
        (self.kind() == 5).then(|| self.clone())
    }
    type List = Self;
    fn entries(&self) -> Vec<(String, Self)> {
        self.keys()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|k| self.get(&k).ok().map(|v| (k, v)))
            .collect()
    }
    fn truthy(&self) -> bool {
        match self.kind() {
            0 | 1 => false,
            2 => self.as_bool().unwrap_or(false),
            3 => self.as_number().is_some_and(|n| n != 0.0 && !n.is_nan()),
            4 => invoke(3, self.0, 0, 0, 0.0) != 0.0,
            _ => true,
        }
    }
    fn animated_node(&self) -> Option<u32> {
        self.get("__av").ok()?.as_number().map(|v| v as u32)
    }
    fn node(&self) -> Option<u32> {
        let id = invoke(14, self.0, 0, 0, 0.0) as u32;
        (id != 0).then_some(id)
    }
}
impl HostList for Value {
    type Item = Self;
    fn len(&self) -> usize {
        self.length().ok().flatten().unwrap_or(0)
    }
    fn item(&self, index: usize) -> Option<Self> {
        self.index(index).ok()
    }
}

/// What op 49 packed: a little-endian u32 count, then per value (after its
/// key, for entries) a tag (0 other, 1 false, 2 true, 3 number, 4 string,
/// 5 date) and its payload (f64; a u32 length and UTF-8).
fn unpack(packed: &[u8], entries: bool) -> Vec<(String, JsPrimitive)> {
    let mut at = 0;
    let u32_at = |at: &mut usize| {
        let n = u32::from_le_bytes(packed[*at..*at + 4].try_into().unwrap_or_default());
        *at += 4;
        n as usize
    };
    let count = u32_at(&mut at);
    let text = |at: &mut usize, len: usize| {
        let s = String::from_utf8_lossy(&packed[*at..*at + len]).into_owned();
        *at += len;
        s
    };
    let float = |at: &mut usize| {
        let n = f64::from_le_bytes(packed[*at..*at + 8].try_into().unwrap_or_default());
        *at += 8;
        n
    };
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let key = if entries {
            let len = u32_at(&mut at);
            text(&mut at, len)
        } else {
            String::new()
        };
        let tag = packed[at];
        at += 1;
        let value = match tag {
            1 => JsPrimitive::Bool(false),
            2 => JsPrimitive::Bool(true),
            3 => JsPrimitive::Number(float(&mut at)),
            4 => {
                let len = u32_at(&mut at);
                JsPrimitive::String(text(&mut at, len))
            }
            5 => JsPrimitive::Date(float(&mut at)),
            _ => JsPrimitive::Other,
        };
        out.push((key, value));
    }
    out
}
