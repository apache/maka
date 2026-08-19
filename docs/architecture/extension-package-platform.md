# Trusted in-process Extension platform

Maka has one Extension package format and one composition lifecycle. A
`maka.extension.json` package may contribute Tools, UI, Events, Listeners,
Services, and Host-owned Timers.

## Trust and identity

Executable Extension code is trusted in-process code. Manifest permissions and
schemas are guardrails, not a sandbox. UI documents separately run in
opaque-origin iframes with a narrow Host bridge.

The manifest `id` identifies installed package bytes. A manifest `version` is
display/package metadata, not a persistent lifecycle Revision. Installing bytes
does not activate them: the Composition Entry Tree decides where and whether a
package runs, and multiple Entries may reference one package with different
scope or configuration.

## Composition and ownership

The Entry Tree is projected into the Context/Fiber Tree. Structural Entries can
remain Entry-only. Executable Fibers own all contribution registrations, so
enable, disable, move, reconfigure, reload, and remove share one cleanup
boundary. Host runtime and Desktop UI may use separate Contexts when their
authorities differ; they are not forced into an artificial shared Fiber.

`define_package` and `manage_package` are the canonical agent-facing controls.
Product UI uses the same Runtime Host composition operations. There is no
secondary Revision/Binding controller or per-contribution activation map.

## Contribution roles

- A Tool is a model-callable operation.
- An Event is a typed dispatch contract.
- A Listener handles an Event; core Event listeners implement Hooks.
- A Service exposes typed methods through Context dependency rules.
- A Timer is a durable Host scheduler whose callback belongs to the Fiber.
- A UI contribution is a sandboxed document projected into an allowed surface.

The runtime entry exports one handler object per activation. Tool, Listener,
Service, and Timer handlers share module state and receive configuration,
cancellation, Event emission, and Service-call capabilities.

## Replacement and restart

Reload and reconfiguration stage fresh Fibers. Health checking and activation
complete before the live switch. Failure closes the candidate and preserves the
active Fiber; success switches and then retires the old Fiber.

Restart reads package bytes and the Entry Tree and reconstructs all Fibers.
Timer scheduling metadata and UI state have dedicated Host stores, but neither
is a composition authority.
