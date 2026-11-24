package com.longbridge.nsh;

import android.content.Context;
import android.graphics.Rect;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.FrameLayout;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * {@code nsh/base}'s {@code ContextMenu} given {@code items}, on Android: the
 * system menu ({@link SystemMenus}). The component covers the trigger
 * and takes no touches; Android has no context menu that a held finger opens
 * on its own, so {@code nsh/base} holds the timer and asks with {@code open}
 * ({@code at}: where the finger held, in the surface; none when the app
 * opened it). The menu lines up with the trigger's end (a row's, at the
 * screen's end), below its bottom, or below the held point when the bottom
 * is out of sight (a long message). JS hears {@code open}, then a chosen
 * action's {@code select} with the app's id, then {@code close};
 * {@code open} set false closes it. Asked for a menu it cannot show (gone
 * from the window, disabled, no items), it tells {@code close} at once, so
 * {@code open} does not stay set.
 */
final class ContextMenuComponent implements NshComponent {
    /** Its name ({@code nsh_core::platform::CONTEXT_MENU_COMPONENT}). */
    static final String NAME = "nsh/context-menu";

    private final Context context;
    private final NshComponentContext events;
    private final BooleanSupplier night;
    private final FrameLayout root;
    /**
     * What the menu hangs from: as wide as the trigger, no height, moved to
     * the line the menu drops from.
     */
    private final View anchor;
    private List<SystemMenus.Entry> items = new ArrayList<>();
    private String title;
    private boolean disabled;
    /** Where a finger asked for it, in the surface's points (null: none). */
    private float[] at;
    /** The menu shown (null: none). */
    private SystemMenus.Popup shown;
    /** JS asks for it shown ({@code open}). */
    private boolean wanted;

    ContextMenuComponent(Context context, NshComponentContext events, BooleanSupplier night) {
        this.context = context;
        this.events = events;
        this.night = night;
        root = new FrameLayout(context);
        root.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        anchor = new View(context);
        root.addView(anchor, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.TOP));
    }

    @Override
    public View view() {
        return root;
    }

    @Override
    public void setProp(String name, Object value) {
        switch (name) {
            case "items":
                items = SystemMenus.parse(value);
                break;
            case "title":
                title = value instanceof String ? (String) value : null;
                break;
            case "disabled":
                disabled = Boolean.TRUE.equals(value);
                break;
            case "at":
                at = point(value);
                break;
            case "open":
                // Props of one batch come in their order: `at` is set by
                // the time the menu shows (posted below).
                wanted = Boolean.TRUE.equals(value);
                if (wanted) root.post(this::show);
                else dismiss();
                break;
            default:
                break;
        }
    }

    private static float[] point(Object value) {
        if (!(value instanceof Map)) return null;
        Object x = ((Map<?, ?>) value).get("x"), y = ((Map<?, ?>) value).get("y");
        if (!(x instanceof Number) || !(y instanceof Number)) return null;
        return new float[] {((Number) x).floatValue(), ((Number) y).floatValue()};
    }

    private void show() {
        if (!wanted || shown != null) return;
        if (disabled || items.isEmpty() || !root.isAttachedToWindow()) {
            // Not shown: JS asked, so it hears the menu went.
            wanted = false;
            events.emit("close", null);
            return;
        }
        boolean held = at != null;
        anchor.setTranslationY(dropLine());
        SystemMenus.Popup popup = SystemMenus.popup(context, night.getAsBoolean(), anchor, Gravity.END, title,
                items, id -> events.emit("select", id));
        popup.setOnDismissListener(() -> {
            if (shown != popup) return;
            shown = null;
            events.emit("close", null);
        });
        shown = popup;
        if (held) root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
        popup.show();
        events.emit("open", "touch");
    }

    /**
     * The line the menu drops from, in the trigger: its bottom while that is
     * on screen, else the held point (or the bottom of what shows).
     */
    private float dropLine() {
        int height = root.getHeight();
        Rect visible = new Rect();
        if (!root.getLocalVisibleRect(visible)) return height;
        if (visible.bottom >= height) return height;
        float y = visible.bottom;
        if (at != null) {
            View surface = surface();
            int[] origin = new int[2], mine = new int[2];
            surface.getLocationOnScreen(origin);
            root.getLocationOnScreen(mine);
            float density = context.getResources().getDisplayMetrics().density;
            y = origin[1] + at[1] * density - mine[1];
        }
        return Math.max(visible.top, Math.min(y, visible.bottom));
    }

    /**
     * The view the surface's points start at: the {@link NshView} around the
     * component, else its window's root.
     */
    private View surface() {
        for (ViewParent p = root.getParent(); p != null; p = p.getParent()) {
            if (p instanceof NshView) return (View) p;
        }
        return root.getRootView();
    }

    private void dismiss() {
        SystemMenus.Popup popup = shown;
        if (popup != null) popup.dismiss();
    }

    @Override
    public void destroy() {
        wanted = false;
        SystemMenus.Popup popup = shown;
        shown = null;
        if (popup != null) popup.dismiss();
    }
}
