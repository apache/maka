//! This process' GPU use for the performance monitor ([`crate::fps`]): the
//! `accumulatedGPUTime` its accelerator clients report in the IO registry
//! (the counter behind Activity Monitor's GPU column, readable without
//! privileges), turned into a share of the wall clock between two readings.
//! gpui-kit's `gpui-fps` reads it the same way.
//!
//! The accelerator's own `PerformanceStatistics` is device wide (the
//! compositor and every other app would count as this one), and
//! `task_info`'s GPU field stays zero on Apple silicon.

use std::{ffi::c_char, ptr::NonNull, time::Instant};

use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFNumberType, CFRetained, CFString};
use objc2_io_kit::{
    IOIteratorNext, IOObjectRelease, IORegistryEntryCreateCFProperties,
    IORegistryEntryGetChildIterator, IOServiceGetMatchingServices, IOServiceMatching,
    io_iterator_t, io_registry_entry_t, kIOMainPortDefault, kIOReturnSuccess,
};

/// Reads the process' GPU use; `None` where there is no accelerator.
pub(crate) struct GpuProbe {
    /// How the registry tags the clients this process opened (`pid 4242,
    /// name`; the name is truncated, so only the pid is matched).
    creator: String,
    /// The previous total and when it was read.
    last: Option<(u64, Instant)>,
}

impl GpuProbe {
    pub(crate) fn new() -> Option<GpuProbe> {
        let accelerators = accelerators();
        if accelerators.is_empty() {
            return None;
        }
        for a in accelerators {
            IOObjectRelease(a);
        }
        Some(GpuProbe {
            creator: format!("pid {},", std::process::id()),
            last: None,
        })
    }

    /// GPU time over wall time since the previous call, in percent (`None`
    /// the first time, and while the process has no accelerator client).
    pub(crate) fn sample(&mut self) -> Option<f32> {
        let used = accumulated_nanoseconds(&self.creator)?;
        let now = Instant::now();
        let (previous, at) = self.last.replace((used, now))?;
        let elapsed = now.duration_since(at).as_nanos();
        if elapsed == 0 {
            return None;
        }
        // A client that goes away takes its share of the total with it.
        let busy = used.saturating_sub(previous);
        Some((busy as f64 / elapsed as f64 * 100.0) as f32)
    }
}

/// Nanoseconds every accelerator spent on this process, or `None` when it
/// owns no client that reports them.
fn accumulated_nanoseconds(creator: &str) -> Option<u64> {
    let mut plane = [0 as c_char; 128];
    for (slot, byte) in plane.iter_mut().zip(b"IOService") {
        *slot = *byte as c_char;
    }
    let mut total = None;
    for accelerator in accelerators() {
        let mut clients: io_iterator_t = 0;
        // SAFETY: the accelerator is live until it is released below; the
        // plane name and the iterator are valid out parameters.
        let result =
            unsafe { IORegistryEntryGetChildIterator(accelerator, &mut plane, &mut clients) };
        IOObjectRelease(accelerator);
        if result != kIOReturnSuccess || clients == 0 {
            continue;
        }
        loop {
            let client = IOIteratorNext(clients);
            if client == 0 {
                break;
            }
            if let Some(used) = client_nanoseconds(client, creator) {
                *total.get_or_insert(0) += used;
            }
            IOObjectRelease(client);
        }
        IOObjectRelease(clients);
    }
    total
}

/// What one client accumulated, or `None` if it belongs to another process
/// or reports no usage (Intel Macs publish no `AppUsage`).
fn client_nanoseconds(client: io_registry_entry_t, creator: &str) -> Option<u64> {
    let properties = properties(client)?;
    // SAFETY: the registry publishes the creator as a string and the usage
    // as an array of dictionaries; every borrow is taken out of
    // `properties` while it is alive.
    unsafe {
        let owner: NonNull<CFString> = value(&properties, "IOUserClientCreator")?;
        if !owner.as_ref().to_string().starts_with(creator) {
            return None;
        }
        let usage: NonNull<CFArray> = value(&properties, "AppUsage")?;
        let usage = usage.as_ref();
        let total = (0..usage.count())
            .filter_map(|index| {
                let queue = NonNull::new(usage.value_at_index(index).cast_mut())?;
                let queue: NonNull<CFDictionary> = queue.cast();
                let time: NonNull<CFNumber> = value(queue.as_ref(), "accumulatedGPUTime")?;
                integer(time.as_ref())
            })
            .sum();
        Some(total)
    }
}

/// Every registered accelerator; the caller releases them.
fn accelerators() -> Vec<io_registry_entry_t> {
    let mut accelerators = Vec::new();
    // SAFETY: the class name is a C string; the dictionary is handed to the
    // lookup below, which takes over its reference.
    let Some(matching) = (unsafe { IOServiceMatching(c"IOAccelerator".as_ptr()) }) else {
        return accelerators;
    };
    let mut iterator: io_iterator_t = 0;
    // SAFETY: the matching dictionary is a plain `CFDictionary` under its
    // mutable type; the iterator is a live out parameter.
    let result = unsafe {
        IOServiceGetMatchingServices(
            kIOMainPortDefault,
            Some(CFRetained::cast_unchecked::<CFDictionary>(matching)),
            &mut iterator,
        )
    };
    if result != kIOReturnSuccess || iterator == 0 {
        return accelerators;
    }
    loop {
        let accelerator = IOIteratorNext(iterator);
        if accelerator == 0 {
            break;
        }
        accelerators.push(accelerator);
    }
    IOObjectRelease(iterator);
    accelerators
}

/// A snapshot of one registry entry's properties.
fn properties(entry: io_registry_entry_t) -> Option<CFRetained<CFDictionary>> {
    let mut properties = std::ptr::null_mut();
    // SAFETY: the entry is live for the call; `properties` is a valid out
    // parameter.
    let result = unsafe { IORegistryEntryCreateCFProperties(entry, &mut properties, None, 0) };
    if result != kIOReturnSuccess {
        return None;
    }
    // SAFETY: on success the call returns a snapshot this task owns.
    let properties = unsafe { CFRetained::from_raw(NonNull::new(properties)?) };
    // SAFETY: a mutable dictionary is a dictionary; nothing mutates it.
    Some(unsafe { CFRetained::cast_unchecked::<CFDictionary>(properties) })
}

/// Borrows `key` out of `dictionary`.
///
/// # Safety
///
/// The value under `key` must be a `T`, and the borrow must not outlive
/// `dictionary`.
unsafe fn value<T>(dictionary: &CFDictionary, key: &str) -> Option<NonNull<T>> {
    let key = CFString::from_str(key);
    // SAFETY: the key lives for the lookup; the value is borrowed.
    let value = unsafe { dictionary.value(std::ptr::from_ref(&*key).cast()) };
    NonNull::new(value.cast_mut().cast::<T>())
}

fn integer(number: &CFNumber) -> Option<u64> {
    let mut value: i64 = 0;
    // SAFETY: the destination matches the type asked for.
    let read = unsafe {
        number.value(
            CFNumberType::SInt64Type,
            std::ptr::from_mut(&mut value).cast(),
        )
    };
    read.then(|| value.max(0) as u64)
}
