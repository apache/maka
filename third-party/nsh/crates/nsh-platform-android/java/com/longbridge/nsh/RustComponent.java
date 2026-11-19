package com.longbridge.nsh;

import android.view.View;

/**
 * {@link NshComponent} backed by a Rust {@code nsh::NativeComponent} registered
 * via {@code #[native_components(android)]}.
 */
final class RustComponent implements NshComponent {
    private final NshView host;
    private final long hostHandle;
    private final int id;
    private final View view;
    private boolean destroyed;

    RustComponent(NshView host, long hostHandle, NshComponentContext context, String name) {
        this.host = host;
        this.hostHandle = hostHandle;
        this.id = context.id();
        View created = host.handle == hostHandle
                ? Native.componentCreate(hostHandle, id, context.getContext(), name)
                : null;
        this.view = created != null ? created : new View(context.getContext());
    }

    @Override
    public View view() {
        return view;
    }

    @Override
    public void setProp(String name, Object value) {}

    @Override
    public void command(String name, Object args) {}

    void step(long seq) {
        if (!destroyed && host.handle == hostHandle && hostHandle != 0) {
            Native.componentStep(hostHandle, seq, id);
        }
    }

    @Override
    public void destroy() {
        if (destroyed) return;
        destroyed = true;
        if (host.handle == hostHandle && hostHandle != 0) {
            Native.componentDestroy(hostHandle, id);
        }
    }
}
