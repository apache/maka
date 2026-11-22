package com.longbridge.nsh;

import android.view.View;

/**
 * A native component the app registers for {@code nativeComponent(name, ...)}
 * in JS ({@code nsh/native}): a map, a player, any view of the app's own.
 * Register a {@link Factory} with {@link NshView#registerComponent}. Called on
 * the UI thread.
 */
public interface NshComponent {
    /**
     * Its view; it fills the box nsh lays out (decoration, frame and touches
     * are the box's).
     *
     * @return the view
     */
    View view();

    /**
     * Prop {@code name} changed. Every prop the app set comes right after
     * the component is made.
     *
     * @param name the prop
     * @param value JSON as Java objects ({@code String}, {@code Number},
     *     {@code Boolean}, {@code java.util.List}, {@code java.util.Map}), or
     *     null when removed (or JSON {@code null})
     */
    void setProp(String name, Object value);

    /**
     * Prop {@code name}, bound to an animated value, moved to {@code value}
     * (called on the frames it changes, without JS). By default it is
     * {@link #setProp} with a {@code Double}.
     *
     * @param name the prop
     * @param value the animated value
     */
    default void setAnimatedNumber(String name, double value) {
        setProp(name, value);
    }

    /**
     * Prop {@code name}, bound to an animated color, moved to {@code argb}
     * (an {@code android.graphics.Color} int). By default it is
     * {@link #setProp} with an {@code Integer}.
     *
     * @param name the prop
     * @param argb the color
     */
    default void setAnimatedColor(String name, int argb) {
        setProp(name, argb);
    }

    /**
     * JS called {@code ref.command(name, args)}.
     *
     * @param name the command
     * @param args its arguments, as for {@link #setProp}
     */
    default void command(String name, Object args) {}

    /**
     * The element is gone: removed by the app, or its app stopped
     * ({@link NshView#destroy}, or another app loaded in its place). Called
     * once; release what the component holds here.
     */
    default void destroy() {}

    /** Makes a component for each element. */
    interface Factory {
        /**
         * Makes a component.
         *
         * @param context what the component can tell its app
         * @return the component
         */
        NshComponent create(NshComponentContext context);
    }
}
