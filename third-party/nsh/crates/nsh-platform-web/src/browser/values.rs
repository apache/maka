//! Owned browser value handles. A slot ID includes its generation; it is
//! meaningful only to this Wasm instance's browser host.
use nsh_core::{
    element::PropError,
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
        let keys = Self::checked(invoke(10, self.0, 0, 0, 0.0))?;
        let n = keys.length()?.unwrap_or(0);
        (0..n)
            .map(|i| keys.index(i).map(|v| v.as_string().unwrap_or_default()))
            .collect()
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
        let length = invoke(3, self.0, 0, 0, 0.0);
        if length.is_nan() || length == EXCEPTION as f64 {
            return None;
        }
        let n = length as usize;
        let mut bytes = vec![0; n];
        invoke(
            4,
            self.0,
            bytes.as_mut_ptr() as u32,
            bytes.len() as u32,
            0.0,
        );
        String::from_utf8(bytes).ok()
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
