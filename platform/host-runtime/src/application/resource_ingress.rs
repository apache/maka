/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Bounded receiving custody before immutable request resources exist.
use super::*;
use maka_capabilities::call::ReadResource;
use maka_capabilities::call::ResourceEncoding;
use maka_capabilities::call::Resources;
use maka_plugin_core::contract::ResourceType;
use serde::{Deserialize, Serialize};
use std::ops::Range;

pub(super) const INPUT_WINDOW: usize = 32 * 1024 * 1024;
pub(super) const RESOURCE_WINDOW: usize = 64 * 1024 * 1024;

// Packing targets limit concurrent retained work, not a single value's extent.
pub(super) fn charge(size: usize, window: usize) -> u32 {
    u32::try_from(size.min(window)).expect("packing window fits u32")
}
pub(super) fn input_charge(input: usize, descriptors: usize) -> Result<u32> {
    let size = input
        .max(1)
        .checked_add(descriptors)
        .ok_or("Host input length overflow")?;
    Ok(charge(size, INPUT_WINDOW))
}
pub const RESOURCE_CHUNK_LIMIT: usize = 64 * 1024;

/// Inert observations; metadata and nominal types never grant access.
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResourceDescriptor {
    pub encoding: ResourceEncoding,
    pub resource: ResourceType,
    pub length: u64,
    pub metadata: Value,
}

/// The original request's capture entry point, without cloning its whole Context.
/// It preserves the same dispatch, cancellation and resource group; it grants no
/// invocation or filesystem authority.
#[derive(Clone)]
pub struct ResourceCapturer {
    dispatch: std::sync::Weak<Dispatch>,
    scope: Scope,
}
impl ResourceCapturer {
    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// Reserve existing Host budgets under this exact original request Scope.
    pub fn capture(
        &self,
        descriptors: BTreeMap<String, ResourceDescriptor>,
    ) -> Result<ResourceCapture> {
        self.dispatch
            .upgrade()
            .ok_or("Host deployment is closed")?
            .capture_resources(self.scope.clone(), descriptors)
    }
}
/// Owned local inputs or privately reserved immutable inputs. Neither variant
/// authorizes an invocation. The final Application owner still checks admission.
pub struct CallResources(ResourceInput);
enum ResourceInput {
    Local(Attachments),
    Captured(Box<Reserved>),
}
impl From<Attachments> for CallResources {
    fn from(value: Attachments) -> Self {
        Self(ResourceInput::Local(value))
    }
}
impl Default for CallResources {
    fn default() -> Self {
        Attachments::new().into()
    }
}
impl CallResources {
    pub(super) fn captured(&self) -> bool {
        matches!(self.0, ResourceInput::Captured(_))
    }
    pub(super) fn check_scope(&self, scope: &Scope) -> Result<()> {
        if let ResourceInput::Captured(capture) = &self.0
            && !Arc::ptr_eq(&capture.group, &scope.resources)
        {
            return Err("captured resources belong to another request Scope".into());
        }
        Ok(())
    }
}
// Physical values precede permits and the inert Scope ticket in drop order.
pub(super) struct Reserved {
    pub(super) attachments: Attachments,
    pub(super) bytes: OwnedSemaphorePermit,
    pub(super) resources: OwnedSemaphorePermit,
    pub(super) admitted: AttachmentSize,
    group: Arc<Resources>,
    pub(super) parent: Option<Ticket>,
}
struct Receiving {
    descriptor: ResourceDescriptor,
    buffer: Box<[u8]>,
    written: usize,
}
/// No effect has been accepted. The receiving owner must drop/drain this custody
/// before confirming server shutdown; Application::shutdown does not own it.
pub struct ResourceCapture {
    receiving: BTreeMap<String, Receiving>,
    bytes: OwnedSemaphorePermit,
    resources: OwnedSemaphorePermit,
    admitted: AttachmentSize,
    scope: Scope,
    commands: mpsc::UnboundedSender<Command>,
    parent: Option<Ticket>,
}
impl Client {
    /// Reserve the original JSON and payload budgets before allocation.
    /// Original request Scope custody covers partial reception and frozen input.
    pub fn capture_resources(
        &self,
        scope: Scope,
        descriptors: BTreeMap<String, ResourceDescriptor>,
    ) -> Result<ResourceCapture> {
        if self.snapshot().closing {
            return Err("Host resource reception is closed".into());
        }
        self.dispatch.capture_resources(scope, descriptors)
    }
}
impl Context {
    pub fn resource_capturer(&self) -> ResourceCapturer {
        ResourceCapturer {
            dispatch: self.dispatch.clone(),
            scope: self.scope.clone(),
        }
    }

    /// Native producers reserve the same Host budgets before allocating bytes.
    /// Captured input remains tied to this exact request Scope, never its descriptor.
    pub fn capture_resources(
        &self,
        descriptors: BTreeMap<String, ResourceDescriptor>,
    ) -> Result<ResourceCapture> {
        self.dispatch
            .upgrade()
            .ok_or("Host deployment is closed")?
            .capture_resources(self.scope.clone(), descriptors)
    }
}
impl Dispatch {
    fn capture_resources(
        &self,
        scope: Scope,
        descriptors: BTreeMap<String, ResourceDescriptor>,
    ) -> Result<ResourceCapture> {
        if self.commands.is_closed() || scope.cancellation.is_cancelled() {
            return Err("Host resource reception is closed".into());
        }
        let mut size = 0usize;
        for (slot, descriptor) in &descriptors {
            check_slot(slot)?;
            descriptor.resource.validate().map_err(|e| e.to_string())?;
            let length =
                usize::try_from(descriptor.length).map_err(|_| "invalid resource length")?;
            size = size
                .checked_add(length)
                .ok_or("Host attachment length overflow")?;
        }
        let descriptor_size = if descriptors.is_empty() {
            0
        } else {
            json_size(&descriptors)?
        };
        // Ticket first; every subsequent local drop releases physical custody first.
        let parent = scope.resources.reserve().map_err(|e| e.to_string())?;
        let bytes = self
            .bytes
            .clone()
            .try_acquire_many_owned(charge(descriptor_size.max(1), INPUT_WINDOW))
            .map_err(|_| "Host descriptor budget exhausted")?;
        let resources = self
            .resources
            .clone()
            .try_acquire_many_owned(charge(size, RESOURCE_WINDOW))
            .map_err(|_| "Host attachment budget exhausted")?;
        let mut receiving = BTreeMap::new();
        for (name, descriptor) in descriptors {
            let length = usize::try_from(descriptor.length).expect("checked resource length");
            let mut buffer = Vec::new();
            buffer
                .try_reserve_exact(length)
                .map_err(|_| "Host resource allocation failed")?;
            buffer.resize(length, 0);
            receiving.insert(
                name,
                Receiving {
                    descriptor,
                    buffer: buffer.into_boxed_slice(),
                    written: 0,
                },
            );
        }
        Ok(ResourceCapture {
            receiving,
            admitted: AttachmentSize {
                payload: size,
                descriptors: descriptor_size,
            },
            bytes,
            resources,
            scope,
            commands: self.commands.clone(),
            parent: Some(parent),
        })
    }
}
impl ResourceCapture {
    fn check_open(&self) -> Result<()> {
        if self.commands.is_closed() || self.scope.cancellation.is_cancelled() {
            return Err("Host resource reception is closed".into());
        }
        Ok(())
    }
    /// Copy one bounded, contiguous chunk into the original fixed-size buffer.
    pub fn write(&mut self, slot: &str, offset: u64, chunk: &[u8]) -> Result<()> {
        self.check_open()?;
        if chunk.is_empty() || chunk.len() > RESOURCE_CHUNK_LIMIT {
            return Err("invalid resource chunk size".into());
        }
        let resource = self
            .receiving
            .get_mut(slot)
            .ok_or("unknown resource slot")?;
        let offset = usize::try_from(offset).map_err(|_| "invalid resource offset")?;
        let end = offset
            .checked_add(chunk.len())
            .filter(|&n| n <= resource.buffer.len())
            .ok_or("resource chunk exceeds declared length")?;
        if offset != resource.written {
            return Err("resource chunk is not contiguous".into());
        }
        resource.buffer[offset..end].copy_from_slice(chunk);
        resource.written = end;
        Ok(())
    }
    /// Moves the original buffers and reservations. No socket reader, writable
    /// alias or whole-payload copy escapes this transition.
    pub fn finish(self) -> Result<CallResources> {
        Ok(CallResources(ResourceInput::Captured(Box::new(
            self.finish_reserved()?,
        ))))
    }

    /// Freeze resources while keeping their original budgets and Scope ticket.
    /// The whole capture remains retained until its last resource is released.
    pub fn finish_resources(self) -> Result<Attachments> {
        let reserved = Arc::new(self.finish_reserved()?);
        Ok(reserved
            .attachments
            .iter()
            .map(|(slot, resource)| {
                let resource: Arc<dyn ReadResource> = Arc::new(OwnedResource {
                    resource: resource.clone(),
                    _reserved: reserved.clone(),
                });
                (slot.clone(), resource)
            })
            .collect())
    }

    fn finish_reserved(self) -> Result<Reserved> {
        self.check_open()?;
        if self.receiving.values().any(|r| r.written != r.buffer.len()) {
            return Err("resource capture is incomplete".into());
        }
        for resource in self.receiving.values() {
            if resource.descriptor.encoding == ResourceEncoding::Utf8 {
                std::str::from_utf8(&resource.buffer).map_err(|_| "captured text is not UTF-8")?;
            }
        }
        let Self {
            receiving,
            bytes,
            resources,
            admitted,
            scope,
            parent,
            ..
        } = self;
        let attachments = receiving
            .into_iter()
            .map(|(name, resource)| {
                let value: Arc<dyn ReadResource> = Arc::new(Frozen {
                    descriptor: resource.descriptor,
                    buffer: resource.buffer,
                });
                (name, value)
            })
            .collect();
        Ok(Reserved {
            attachments,
            bytes,
            resources,
            admitted,
            group: scope.resources.clone(),
            parent,
        })
    }
}

struct OwnedResource {
    // Drop this reference before the reservation can release its raw resources,
    // followed by their original permits and Scope ticket. No wrapper is stored
    // in Reserved itself, so this ownership graph has no reservation cycle.
    resource: Arc<dyn ReadResource>,
    _reserved: Arc<Reserved>,
}
impl ReadResource for OwnedResource {
    fn encoding(&self) -> ResourceEncoding {
        self.resource.encoding()
    }
    fn resource_type(&self) -> ResourceType {
        self.resource.resource_type()
    }
    fn bytes(&self) -> usize {
        self.resource.bytes()
    }
    fn metadata(&self) -> Value {
        self.resource.metadata()
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>> {
        self.resource.read(range)
    }
}
struct Frozen {
    descriptor: ResourceDescriptor,
    buffer: Box<[u8]>,
}
impl ReadResource for Frozen {
    fn encoding(&self) -> ResourceEncoding {
        self.descriptor.encoding
    }
    fn resource_type(&self) -> ResourceType {
        self.descriptor.resource.clone()
    }
    fn bytes(&self) -> usize {
        self.buffer.len()
    }
    fn metadata(&self) -> Value {
        self.descriptor.metadata.clone()
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>> {
        if self.descriptor.encoding == ResourceEncoding::Utf8
            && [range.start, range.end]
                .iter()
                .any(|&offset| self.buffer.get(offset).is_some_and(|b| b & 0xc0 == 0x80))
        {
            return Err("invalid UTF-8 range".into());
        }
        self.buffer
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "resource read exceeds declared length".into())
    }
}
fn check_slot(slot: &str) -> Result<()> {
    if slot.is_empty() {
        return Err("invalid resource slot".into());
    }
    Ok(())
}
#[derive(Clone, Copy)]
pub(super) struct AttachmentSize {
    pub(super) payload: usize,
    pub(super) descriptors: usize,
}
pub(super) fn attachment_size(attachments: &Attachments) -> Result<AttachmentSize> {
    let mut payload = 0usize;
    // Include map braces, separators and the actual encoded keys.
    let mut descriptors = if attachments.is_empty() { 0 } else { 2usize };
    for (index, (slot, resource)) in attachments.iter().enumerate() {
        check_slot(slot)?;
        let nominal = resource.resource_type();
        nominal.validate().map_err(|e| e.to_string())?;
        let length = resource.bytes();
        payload = payload
            .checked_add(length)
            .ok_or("Host attachment length overflow")?;
        let descriptor = ResourceDescriptor {
            encoding: resource.encoding(),
            resource: nominal,
            length: u64::try_from(length).map_err(|_| "invalid resource length")?,
            metadata: resource.metadata(),
        };
        for size in [
            json_size(slot)?,
            1,
            usize::from(index != 0),
            json_size(&descriptor)?,
        ] {
            descriptors = descriptors
                .checked_add(size)
                .ok_or("Host descriptor length overflow")?;
        }
    }
    Ok(AttachmentSize {
        payload,
        descriptors,
    })
}
impl Dispatch {
    pub(super) fn resources(
        &self,
        value: CallResources,
        scope: &Scope,
        input_size: usize,
        parent: Option<Ticket>,
    ) -> Result<Reserved> {
        match value.0 {
            ResourceInput::Captured(mut reserved) => {
                if !Arc::ptr_eq(reserved.bytes.semaphore(), &self.bytes)
                    || !Arc::ptr_eq(reserved.resources.semaphore(), &self.resources)
                {
                    return Err("captured resources belong to another Application".into());
                }
                if parent.is_some() {
                    return Err("captured resources already own a request ticket".into());
                }
                let combined = input_charge(input_size, reserved.admitted.descriptors)?;
                let held = u32::try_from(reserved.bytes.num_permits())
                    .map_err(|_| "invalid captured input reservation")?;
                let additional = combined
                    .checked_sub(held)
                    .ok_or("invalid captured input reservation")?;
                let input = self
                    .bytes
                    .clone()
                    .try_acquire_many_owned(additional)
                    .map_err(|_| "Host input budget exhausted")?;
                reserved.bytes.merge(input);
                Ok(*reserved)
            }
            ResourceInput::Local(attachments) => {
                let mut custody = (attachments, parent);
                let size = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    attachment_size(&custody.0)
                })) {
                    Ok(result) => result?,
                    Err(_) => {
                        let error = "Host attachment descriptor panicked".to_string();
                        drop(custody.0);
                        if let Some(ticket) = custody.1.take() {
                            ticket.complete(Err(error.clone()));
                        }
                        return Err(error);
                    }
                };
                let bytes_needed = input_charge(input_size, size.descriptors)?;
                let bytes = self
                    .bytes
                    .clone()
                    .try_acquire_many_owned(bytes_needed)
                    .map_err(|_| "Host input budget exhausted")?;
                let resources = self
                    .resources
                    .clone()
                    .try_acquire_many_owned(charge(size.payload, RESOURCE_WINDOW))
                    .map_err(|_| "Host attachment budget exhausted")?;
                let (attachments, parent) = custody;
                Ok(Reserved {
                    attachments,
                    bytes,
                    resources,
                    admitted: size,
                    group: scope.resources.clone(),
                    parent,
                })
            }
        }
    }
}

#[cfg(test)]
mod owned_resource_tests {
    use super::*;

    struct Fixture {
        capture: ResourceCapture,
        bytes: Arc<Semaphore>,
        resources: Arc<Semaphore>,
        scope: Scope,
        _receiver: mpsc::UnboundedReceiver<Command>,
    }
    fn fixture() -> Fixture {
        let scope = maka_capabilities::call::Issuer::default()
            .issue(
                maka_capabilities::call::Identity::Remote {
                    request_id: Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .unwrap();
        let bytes = Arc::new(Semaphore::new(8));
        let resources = Arc::new(Semaphore::new(8));
        let (commands, receiver) = mpsc::unbounded_channel();
        let receiving = [("first", vec![1u8, 2]), ("second", vec![3u8, 4])]
            .into_iter()
            .map(|(slot, buffer)| {
                (
                    slot.into(),
                    Receiving {
                        descriptor: ResourceDescriptor {
                            encoding: ResourceEncoding::Bytes,
                            resource: maka_plugin_core::contract::binary_resource_type(),
                            length: buffer.len() as u64,
                            metadata: Value::Null,
                        },
                        written: buffer.len(),
                        buffer: buffer.into_boxed_slice(),
                    },
                )
            })
            .collect();
        let parent = scope.resources.reserve().unwrap();
        let capture = ResourceCapture {
            receiving,
            bytes: bytes.clone().try_acquire_many_owned(3).unwrap(),
            resources: resources.clone().try_acquire_many_owned(4).unwrap(),
            admitted: AttachmentSize {
                payload: 4,
                descriptors: 3,
            },
            scope: scope.clone(),
            commands,
            parent: Some(parent),
        };
        Fixture {
            capture,
            bytes,
            resources,
            scope,
            _receiver: receiver,
        }
    }

    #[tokio::test]
    async fn owned_resources_hold_the_original_permits_and_scope_until_last_release() {
        let Fixture {
            capture,
            bytes,
            resources,
            scope,
            _receiver,
        } = fixture();
        let mut owned = capture.finish_resources().unwrap();
        assert_eq!(owned["first"].read(0..2).unwrap(), [1, 2]);
        assert_eq!(owned["second"].read(0..2).unwrap(), [3, 4]);
        assert!(owned["first"].read(0..3).is_err());
        assert_eq!(owned["first"].encoding(), ResourceEncoding::Bytes);
        assert_eq!(
            owned["first"].resource_type(),
            maka_plugin_core::contract::binary_resource_type()
        );
        assert_eq!(owned["first"].metadata(), Value::Null);
        assert_eq!(
            (bytes.available_permits(), resources.available_permits()),
            (5, 4)
        );
        assert!(!scope.resources.is_idle());
        drop(owned.remove("first").unwrap());
        assert_eq!(
            (bytes.available_permits(), resources.available_permits()),
            (5, 4)
        );
        let mut settlement = Box::pin(scope.resources.settle());
        std::future::poll_fn(|context| {
            assert!(std::future::Future::poll(settlement.as_mut(), context).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        let last = owned.remove("second").unwrap();
        drop(owned);
        assert_eq!(
            (bytes.available_permits(), resources.available_permits()),
            (5, 4)
        );
        drop(last);
        settlement.await.unwrap();
        assert_eq!(
            (bytes.available_permits(), resources.available_permits()),
            (8, 8)
        );
        assert!(scope.resources.is_idle());
    }
}
