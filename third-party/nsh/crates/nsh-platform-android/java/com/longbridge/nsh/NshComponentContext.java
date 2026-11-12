package com.longbridge.nsh;

/**
 * What a component gets from its app: the context to make its views with, and
 * a way to tell the app its events and its own size. Any thread.
 */
public final class NshComponentContext {
    private final NshView view;
    private final int id;

    NshComponentContext(NshView view, int id) {
        this.view = view;
        this.id = id;
    }

    /**
     * The context of the {@link NshView} the component is in (its activity's):
     * for the component's views, resources and system services. Its
     * {@code getApplicationContext()} is the one to keep in what outlives the
     * component.
     *
     * @return the context
     */
    public android.content.Context getContext() {
        return view.getContext();
    }

    /**
     * Emits {@code event}: the JS handler {@code on<Event>} gets {@code data}.
     *
     * @param event the event
     * @param data JSON as Java objects (see {@link NshComponent#setProp}), or null
     */
    public void emit(String event, Object data) {
        long handle = view.handle;
        if (handle != 0) Native.componentEvent(handle, id, event, data == null ? null : Json.stringify(data));
    }

    /**
     * The component's own size, used where its style leaves a dimension open.
     *
     * @param width in dp
     * @param height in dp
     */
    public void setSize(float width, float height) {
        long handle = view.handle;
        if (handle != 0) Native.componentSize(handle, id, width, height);
    }
}
