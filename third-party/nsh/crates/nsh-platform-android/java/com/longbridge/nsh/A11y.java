package com.longbridge.nsh;

import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewParent;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction;
import java.util.Arrays;
import java.util.Objects;

/**
 * Accessibility of one view, from the app's properties
 * (`accessibilityLabel`, `accessibilityRole`, `accessibilityState`...),
 * applied through an accessibility delegate.
 */
final class A11y extends View.AccessibilityDelegate {
    /** Class names reported for roles, in `encode.rs` `role_index` order. */
    private static final String[] CLASS_NAMES = {
        null, "android.widget.Button", "android.widget.Button", "android.widget.EditText",
        "android.widget.ImageView", "android.widget.ImageButton", "android.inputmethodservice.Keyboard$Key",
        "android.widget.TextView", "android.widget.SeekBar", "android.view.View", "android.view.View",
        "android.view.View", "android.widget.CheckBox", "android.widget.Spinner", "android.view.View",
        "android.view.View", "android.view.View", "android.widget.ProgressBar", "android.widget.RadioButton",
        "android.widget.RadioGroup", "android.view.View", "android.widget.SpinButton", "android.widget.Switch",
        "android.view.View", "android.widget.TabWidget", "android.view.View", "android.widget.Toolbar",
        "android.widget.AbsListView", "android.widget.GridView",
        "android.widget.GridView", "android.view.View", "android.view.View", "android.view.View", "android.view.View",
        "android.widget.ListView", "android.view.View", "android.view.View", "android.view.View",
        "android.view.View", "android.view.View", "android.view.View", "android.view.View", "android.view.View",
        "android.view.View", "android.view.View",
    };
    /** Spoken role descriptions for roles without a widget class. */
    private static final String[] ROLE_DESCRIPTIONS = {
        null, null, "link", null, null, null, null, null, null, null, "summary", "alert", null, null, "menu",
        "menu bar", "menu item", null, null, null, "scroll bar", null, null, "tab", "tab list", "timer", null,
        null, null, null, "row", "cell", "column header", "row group", null, "option", null, "region",
        "navigation", "tree", "tree item", "menu item", "menu item", "dialog", "alert dialog",
    };
    private static final int ROLE_ADJUSTABLE = 8;
    private static final int ROLE_HEADER = 9;
    private static final int ROLE_SWITCH = 22;
    /** Ids of custom actions (outside the framework's action ids). */
    private static final int CUSTOM_ACTION_BASE = 0x3f000000;

    final Mounter mounter;
    final int id;
    int accessible = -1;
    String label, hint, testId;
    int role;
    int state;
    boolean hasValue;
    float min = Float.NaN, max = Float.NaN, now = Float.NaN;
    String valueText;
    boolean hidden;
    int liveRegion;
    String[] actionNames = new String[0];
    String[] actionLabels = new String[0];
    /** The view's pending range selection before API 30, carried from the delegate this one replaces. */
    private SelectedSender selectedSender;

    A11y(Mounter mounter, int id) {
        this.mounter = mounter;
        this.id = id;
    }

    /** Applies the view-level settings (the rest happens per query). */
    void apply(View v) {
        v.setAccessibilityDelegate(this);
        if (hidden) {
            v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        } else if (accessible == 0) {
            v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        } else if (accessible == 1 || label != null) {
            v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        } else {
            v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
        }
        if (Build.VERSION.SDK_INT >= 28) v.setScreenReaderFocusable(accessible == 1);
        v.setContentDescription(label);
        v.setAccessibilityLiveRegion(liveRegion == 2 ? View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE
                : liveRegion == 1 ? View.ACCESSIBILITY_LIVE_REGION_POLITE : View.ACCESSIBILITY_LIVE_REGION_NONE);
        if (Build.VERSION.SDK_INT >= 28) v.setAccessibilityHeading(role == ROLE_HEADER);
    }

    /**
     * Tells accessibility services what changed since {@code before}, the delegate this one
     * replaces on {@code v} ({@link A11yChanges} picks the event). Called once this one is
     * installed: a service answers the event by querying the node, which must be the new one.
     * A first mount, an unchanged update, a hidden element, a view not shown and a device
     * without a running service send nothing.
     */
    void changed(View v, A11y before) {
        if (before == null) return;
        if (before.selectedSender != null && before.selectedSender.view == v) selectedSender = before.selectedSender;
        if (hidden || before.hidden) return;
        // Sending while no service runs throws on the main thread; most updates come without one.
        AccessibilityManager manager = mounter.host.accessibility();
        if (manager == null || !manager.isEnabled()) return;
        boolean range = hasRange(), rangeBefore = before.hasRange();
        boolean rangeChanged = range && rangeBefore && (Float.compare(min, before.min) != 0
                || Float.compare(max, before.max) != 0 || Float.compare(now, before.now) != 0);
        boolean nodeChanged = range != rangeBefore || role != before.role || !Objects.equals(hint, before.hint)
                || !Objects.equals(testId, before.testId) || !Arrays.equals(actionNames, before.actionNames)
                || !Arrays.equals(actionLabels, before.actionLabels);
        // The state descriptions differ only if one of these does (the role picks on / off).
        boolean described = state != before.state || role != before.role
                || !Objects.equals(shownValueText(), before.shownValueText());
        // Most updates change nothing of this: leave them without allocating.
        if (!described && !rangeChanged && !nodeChanged) return;
        if (!v.isShown()) return;
        boolean focused = focused(v);
        boolean clicked = focused && mounter.accessibilityClicked != null
                && SystemClock.uptimeMillis() - mounter.accessibilityClickedAt <= A11yChanges.CLICK_MS
                && within(v, mounter.accessibilityClicked);
        int event = A11yChanges.event(before.state, state, described ? before.stateDescription() : null,
                described ? stateDescription() : null, rangeChanged, nodeChanged, focused, clicked,
                Build.VERSION.SDK_INT);
        switch (event) {
            case A11yChanges.CLICKED:
                // One click per click of the service's.
                mounter.accessibilityClicked = null;
                v.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_CLICKED);
                break;
            case A11yChanges.SELECTED:
                if (selectedSender == null) selectedSender = new SelectedSender(v);
                v.removeCallbacks(selectedSender);
                v.postDelayed(selectedSender, A11yChanges.SELECTED_MS);
                break;
            case A11yChanges.STATE_DESCRIPTION:
                // Sent at once, as `View.setStateDescription` sends it: merged with other views'
                // changes it would come from their common ancestor, which has no focus.
                sendContentChange(v, A11yChanges.CONTENT_CHANGE_TYPE_STATE_DESCRIPTION);
                break;
            case A11yChanges.CONTENT: {
                // Only a refresh: the framework merges these, at most one every 100 ms.
                ViewParent parent = v.getParent();
                if (parent != null) {
                    parent.notifySubtreeAccessibilityStateChanged(v, v,
                            AccessibilityEvent.CONTENT_CHANGE_TYPE_UNDEFINED);
                }
                break;
            }
            default:
                break;
        }
    }

    /**
     * Sends a content change of {@code types}, a plain int: API 30's state description type is
     * sent on every level, as androidx sends it.
     */
    private static void sendContentChange(View v, int types) {
        AccessibilityEvent e = AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
        e.setContentChangeTypes(types);
        v.sendAccessibilityEventUnchecked(e);
    }

    /** Whether {@code v} or an ancestor has the accessibility focus, as TalkBack checks. */
    private static boolean focused(View v) {
        for (View at = v; ; ) {
            if (at.isAccessibilityFocused()) return true;
            ViewParent parent = at.getParent();
            if (!(parent instanceof View)) return false;
            at = (View) parent;
        }
    }

    /** Whether {@code v} is {@code ancestor} or inside it. */
    private static boolean within(View v, View ancestor) {
        for (View at = v; ; ) {
            if (at == ancestor) return true;
            ViewParent parent = at.getParent();
            if (!(parent instanceof View)) return false;
            at = (View) parent;
        }
    }

    /**
     * A range's {@code TYPE_VIEW_SELECTED} before API 30, posted to send at most one every
     * {@link A11yChanges#SELECTED_MS}, as a {@code ProgressBar}'s {@code AccessibilityEventSender}
     * does. Kept across the view's delegates.
     */
    private static final class SelectedSender implements Runnable {
        final View view;

        SelectedSender(View view) {
            this.view = view;
        }

        @Override
        public void run() {
            // `sendAccessibilityEvent` sends nothing without a running service.
            if (view.isShown()) view.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_SELECTED);
        }
    }

    /**
     * The view's events carry what its node says (the widget class, enabled, checked, a range's
     * position), as a widget's do. TalkBack reads a click's state from the node it queries again,
     * the event's class picks how it treats some events (a progress bar's or a seek bar's).
     */
    @Override
    public void onInitializeAccessibilityEvent(View host, AccessibilityEvent event) {
        super.onInitializeAccessibilityEvent(host, event);
        String className = className();
        if (className != null) event.setClassName(className);
        if ((state & 1) != 0) event.setEnabled(false);
        if ((state & 256) != 0) event.setChecked((state & 512) != 0);
        else if ((state & 8) != 0) event.setChecked((state & 16) != 0);
        if (hasRange() && max > min) {
            // `ProgressBar`'s item count and index, in hundredths of the range.
            event.setItemCount(100);
            event.setCurrentItemIndex(Math.max(0, Math.min(100, Math.round((now - min) / (max - min) * 100))));
        }
    }

    @Override
    public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(host, info);
        String className = className();
        if (className != null) info.setClassName(className);
        String description = role < ROLE_DESCRIPTIONS.length ? ROLE_DESCRIPTIONS[role] : null;
        if (description != null && Build.VERSION.SDK_INT >= 30) {
            info.getExtras().putCharSequence("AccessibilityNodeInfo.roleDescription", description);
        }
        if (hint != null && Build.VERSION.SDK_INT >= 26) info.setHintText(hint);
        if (testId != null) info.setViewIdResourceName(testId);
        if ((state & 1) != 0) info.setEnabled(false);
        if ((state & 2) != 0) info.setSelected(true);
        // ARIA's `aria-invalid`: the content does not pass the app's checks.
        if ((state & (1 << 14)) != 0) info.setContentInvalid(true);
        if ((state & 8) != 0) {
            info.setCheckable(true);
            info.setChecked((state & 16) != 0);
        }
        if ((state & 256) != 0) {
            // A toggle button (`accessibilityState.pressed`), read as on or off.
            info.setCheckable(true);
            info.setChecked((state & 512) != 0);
        }
        if ((state & 64) != 0) {
            info.addAction((state & 128) != 0 ? AccessibilityAction.ACTION_COLLAPSE : AccessibilityAction.ACTION_EXPAND);
        }
        if (hasRange()) {
            info.setRangeInfo(AccessibilityNodeInfo.RangeInfo.obtain(
                    AccessibilityNodeInfo.RangeInfo.RANGE_TYPE_FLOAT, min, max, now));
        }
        String stateText = stateDescription();
        if (stateText != null) {
            // Before API 30 the extras entry androidx's node compat reads, as TalkBack reads it.
            if (Build.VERSION.SDK_INT >= 30) info.setStateDescription(stateText);
            else info.getExtras().putCharSequence(A11yChanges.STATE_DESCRIPTION_KEY, stateText);
        }
        if (role == ROLE_ADJUSTABLE || has("increment")) info.addAction(AccessibilityAction.ACTION_SCROLL_FORWARD);
        if (role == ROLE_ADJUSTABLE || has("decrement")) info.addAction(AccessibilityAction.ACTION_SCROLL_BACKWARD);
        if (has("activate") || mounter.wants(id, Native.PRESS)) {
            info.addAction(AccessibilityAction.ACTION_CLICK);
            info.setClickable(true);
        }
        if (has("longpress") || mounter.wants(id, Native.LONG_PRESS)) {
            info.addAction(AccessibilityAction.ACTION_LONG_CLICK);
            info.setLongClickable(true);
        }
        for (int i = 0; i < actionNames.length; i++) {
            if (isStandard(actionNames[i])) continue;
            String l = actionLabels[i] != null ? actionLabels[i] : actionNames[i];
            info.addAction(new AccessibilityAction(CUSTOM_ACTION_BASE + i, l));
        }
    }

    @Override
    public boolean performAccessibilityAction(View host, int action, Bundle args) {
        if (action >= CUSTOM_ACTION_BASE && action < CUSTOM_ACTION_BASE + actionNames.length) {
            report(actionNames[action - CUSTOM_ACTION_BASE]);
            return true;
        }
        if (action == AccessibilityNodeInfo.ACTION_CLICK && has("activate")) {
            clickedBy(host);
            report("activate");
            return true;
        }
        if (action == AccessibilityNodeInfo.ACTION_CLICK && mounter.wants(id, Native.PRESS)) {
            clickedBy(host);
            mounter.event(id, Native.PRESS);
            return true;
        }
        if (action == AccessibilityNodeInfo.ACTION_LONG_CLICK) {
            if (has("longpress")) {
                report("longpress");
                return true;
            }
            if (mounter.wants(id, Native.LONG_PRESS)) {
                mounter.event(id, Native.LONG_PRESS);
                return true;
            }
        }
        if (action == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD && has("increment")) {
            report("increment");
            return true;
        }
        if (action == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD && has("decrement")) {
            report("decrement");
            return true;
        }
        if ((action == AccessibilityNodeInfo.ACTION_EXPAND || action == AccessibilityNodeInfo.ACTION_COLLAPSE)
                && has(action == AccessibilityNodeInfo.ACTION_EXPAND ? "expand" : "collapse")) {
            report(action == AccessibilityNodeInfo.ACTION_EXPAND ? "expand" : "collapse");
            return true;
        }
        return super.performAccessibilityAction(host, action, args);
    }

    /**
     * Notes a service's click the delegate takes (the framework sends no click event for it):
     * the state it changes in a later batch is that click's ({@link #changed}).
     */
    private void clickedBy(View host) {
        mounter.accessibilityClicked = host;
        mounter.accessibilityClickedAt = SystemClock.uptimeMillis();
    }

    /** The widget class the node and its events report: a toggle button's, or its role's. */
    private String className() {
        if ((state & 256) != 0) return "android.widget.ToggleButton";
        return role < CLASS_NAMES.length ? CLASS_NAMES[role] : null;
    }

    /** Whether the value is a numeric range the node exposes (a value's text is said instead). */
    private boolean hasRange() {
        return hasValue && valueText == null && !Float.isNaN(now) && !Float.isNaN(min) && !Float.isNaN(max);
    }

    private String shownValueText() {
        return hasValue ? valueText : null;
    }

    /** What the node says of its state: mixed, expanded, current, the value's text, invalid, and the checked word with them. */
    private String stateDescription() {
        // In the language the app's text shows in, as the rest the service reads.
        return A11yChanges.stateDescription(state, shownValueText(), (state & 256) != 0 || role == ROLE_SWITCH,
                mounter.textLocale);
    }

    /**
     * The language of the state words changed ({@link Mounter#textLocale}): a service refreshes
     * its copy of {@code v}'s node when it has a state description, saying nothing (the next read
     * has the new words).
     */
    void wordsChanged(View v) {
        if (hidden || !v.isShown() || stateDescription() == null) return;
        ViewParent parent = v.getParent();
        if (parent != null) {
            parent.notifySubtreeAccessibilityStateChanged(v, v, AccessibilityEvent.CONTENT_CHANGE_TYPE_UNDEFINED);
        }
    }

    private boolean has(String name) {
        for (String n : actionNames) {
            if (n.equals(name)) return true;
        }
        return false;
    }

    private static boolean isStandard(String name) {
        switch (name) {
            case "activate":
            case "increment":
            case "decrement":
            case "longpress":
            case "expand":
            case "collapse":
            case "magicTap":
            case "escape":
                return true;
            default:
                return false;
        }
    }

    private void report(String name) {
        mounter.event(id, Native.ACCESSIBILITY_ACTION, name, 0, 0, 0);
    }
}
