# GPUI Fast WGPU source

This directory receives one published package, `gpui-fast-wgpu` 0.1.10, from
[the official crates.io archive](https://static.crates.io/crates/gpui-fast-wgpu/gpui-fast-wgpu-0.1.10.crate).
The archive SHA-256 is
`cac7d34083b2611b49b2f415a16aa9e33620b127a25e981f835db8fe72f07423`.
The archive's package-local lockfile is omitted. The consuming GPUI workspace
owns production resolution; standalone renderer tests resolve this package
directly, without application-specific dependency patches.
Original license, README and both published manifests are retained.

`upstream.json` records the 26 original package files and their unmodified
SHA-256 hashes. Adaptations are measured against those bytes. NSH does not
receive another GPUI core, platform workspace, application runtime or renderer.

The archive's original tests refer to assets and one shared rounded-clip
fixture outside the published package. Only those referenced fixtures are
received into `test-assets`: IBM Plex Sans Regular, Lilex Regular and Bold,
their two original OFL license texts, and `rounded_clip_fixtures.rs`. They
come byte-for-byte from the upstream Git revision
`b836dd970b26830f2124b7cf91b0e19018fd12da`, not the crate archive. The separate
`test_fixtures` inventory records each original source path, local mapping and
hash. Test include paths are redirected to these files; no fixture assertions
or test-module admission conditions are weakened.

The local production `offscreen` feature enables only the renderer's image
dependency. `WgpuHeadlessRenderer` exposes its own inherent pixel, image,
scene, adapter-information and sprite-atlas methods. The original test/bench
`PlatformHeadlessRenderer` bridge delegates its existing three methods to the
same implementation. No GPUI core feature or trait is extended.

The local `prepare_scene` API encodes drawing and its readback copy into an
owned `PreparedReadback` without submitting GPU commands. Its consuming
`submit()` runs on the embedding host's existing background executor and
returns a `SubmittedReadback` after queue submission and the mapping request.
The host must wait for that submission to return before preparing the next
scene, so shared GPU resource writes remain ordered. Readback can then overlap
preparation of later scenes. `submit_scene` delegates to
`prepare_scene(...).submit()` for callers that submit immediately.

`SubmissionTimings` retains the handoff's wall-clock boundaries:
`prepare_started`, `encode_started`, `encode_finished`, `submit_started`,
`submit_finished` and `map_requested`. Encoding timestamps belong to preparation;
submission and mapping-request timestamps come from the actual submitting
thread. These timings do not imply display presentation or a frame-rate result.

Submission does not wait for readback or allocate RGBA image storage. The ticket
holds its device, staging allocation, dimensions, mapping result and device-error
observer independently of the renderer. Its mapping
callback only sends the result; `complete` or `complete_into` performs the
existing bounded GPU wait, strips row padding and converts BGRA on the calling
background owner. The blocking image and pixel methods delegate to this same
submission/completion path; invalid destinations are rejected before submission.

The renderer reuses its GPU target and a single cached, unmapped same-size
staging allocation. Cache exchange never holds its lock through GPU work or
pixel copying. Dropped tickets, mapping failures and timeouts release the
uncached buffer's last native handle, which cancels pending or active mapping.
That native cleanup also accepts idle buffers after a failed mapping; an extra
public `unmap` on an idle buffer would instead report an error. Only successful
completion explicitly unmaps once and returns the allocation to the cache.
Cached allocations have no custom unmap-on-drop behavior. Success does not
establish terminal publication or a frame-rate guarantee. Adapter policy is
unchanged, and diagnostics distinguish a software-emulated device.

The archive omitted upstream's WGSL-validation test dev dependency; the local
manifest restores Naga at the backend's exact 30.0.1 version with `wgsl-in`.
Production uses `offscreen` without `test-support`; unit tests use
`offscreen,test-support`. Five real headless GPU regressions check background completion, color,
odd-stride, RGBA/BGRA, invalid-destination recovery, dropped-ticket recovery,
unmapped allocation reuse, target reuse and overlapping resize submissions.

## Standalone verification

From the repository root, enter the GPUI workspace to share its normal target
and cache. These commands require only official GPUI core and this single
renderer source package:

```sh
cd crates/gpui
cargo check -p nsh-gpui-terminal --lib
cargo test --manifest-path ../../third-party/gpui-wgpu/Cargo.toml \
  --features offscreen,test-support --lib headless_ \
  -- --test-threads=1 --nocapture
```

The existing GPUI Linux CI job runs the same five renderer tests explicitly:
workspace tests do not execute dependency unit tests. It installs
`mesa-vulkan-drivers` alongside `libvulkan1` from Ubuntu's repositories to
provide a CPU Vulkan device without a physical GPU or display server. A
renderer initialization error or failed pixel assertion fails the job. This
checks actual rendering and readback correctness; software rendering does
not establish hardware throughput or a frame-rate guarantee. With all
package metadata and dependencies cached, the commands also accept
`--offline`.
