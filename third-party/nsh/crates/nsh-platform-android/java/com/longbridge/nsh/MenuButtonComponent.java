package com.longbridge.nsh;

import android.content.Context;
import android.os.Build;
import android.view.View;
import android.view.ViewParent;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.BooleanSupplier;

/**
 * {@code nsh/base}'s {@code MenuButton} on Android: a transparent button over
 * the app's content whose tap (or TalkBack's activation, or Enter on it)
 * opens the system menu below the content at once, without asking
 * JS ({@link SystemMenus}). A chosen action emits {@code select} with the
 * app's id. The button is what TalkBack reaches (named by
 * {@code accessibilityLabel}, with {@code accessibilityHint} describing its
 * action): the content under it is drawn, not read twice
 * ({@link Box#addChildrenForAccessibility}).
 */
final class MenuButtonComponent implements NshComponent {
    /** Its name ({@code nsh_core::platform::MENU_BUTTON_COMPONENT}). */
    static final String NAME = "nsh/menu-button";

    private final Context context;
    private final NshComponentContext events;
    private final BooleanSupplier night;
    private final View button;
    private List<SystemMenus.Entry> items = new ArrayList<>();
    private String title;
    private String accessibilityHint;
    /** The menu shown (null: none). */
    private SystemMenus.Popup shown;

    MenuButtonComponent(Context context, NshComponentContext events, BooleanSupplier night) {
        this.context = context;
        this.events = events;
        this.night = night;
        button = new View(context) {
            @Override
            public CharSequence getAccessibilityClassName() {
                return Button.class.getName();
            }

            @Override
            public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(info);
                if (Build.VERSION.SDK_INT >= 26) info.setHintText(accessibilityHint);
            }
        };
        button.setClickable(true);
        button.setFocusable(true);
        button.setOnClickListener(v -> show());
    }

    @Override
    public View view() {
        return button;
    }

    @Override
    public void setProp(String name, Object value) {
        switch (name) {
            case "items":
                // New items change the menu the next time it opens.
                items = SystemMenus.parse(value);
                break;
            case "title":
                title = value instanceof String ? (String) value : null;
                break;
            case "disabled":
                button.setEnabled(!Boolean.TRUE.equals(value));
                break;
            case "accessibilityLabel":
                button.setContentDescription(value instanceof String ? (String) value : null);
                break;
            case "accessibilityHint": {
                String hint = value instanceof String ? (String) value : null;
                if (!Objects.equals(accessibilityHint, hint)) {
                    accessibilityHint = hint;
                    // Refresh TalkBack's cached node after a bound hint changes.
                    ViewParent parent = button.getParent();
                    if (parent != null) {
                        parent.notifySubtreeAccessibilityStateChanged(button, button,
                                AccessibilityEvent.CONTENT_CHANGE_TYPE_UNDEFINED);
                    }
                }
                break;
            }
            default:
                break;
        }
    }

    private void show() {
        if (shown != null || items.isEmpty() || !button.isAttachedToWindow()) return;
        SystemMenus.Popup popup = SystemMenus.popup(context, night.getAsBoolean(), button,
                SystemMenus.gravity(button), title, items, id -> events.emit("select", id));
        popup.setOnDismissListener(() -> {
            if (shown == popup) shown = null;
        });
        shown = popup;
        popup.show();
    }

    @Override
    public void destroy() {
        SystemMenus.Popup popup = shown;
        shown = null;
        if (popup != null) popup.dismiss();
    }
}
