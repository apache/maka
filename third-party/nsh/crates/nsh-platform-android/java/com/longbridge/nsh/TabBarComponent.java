package com.longbridge.nsh;

import android.content.Context;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * {@code nsh/mobile}'s {@code TabBar} on Android: Material 3's navigation bar
 * (the system's look, as {@code NavStack}'s toolbar has it), made of the
 * framework's views: each tab an icon in its active indicator over its label,
 * in the system's dynamic colors on Android 12 and later and Material's
 * baseline colors before. The app places it and shows the selected tab's
 * content; at the bottom of the window the bar reaches under the navigation
 * bar, as Material's does.
 */
final class TabBarComponent implements NshComponent {
    /** Its name ({@code nsh_core::platform::TAB_BAR_COMPONENT}). */
    static final String NAME = "nsh/tab-bar";

    /** Material 3: the bar's height, the indicator's size, the icon's and the label's. */
    private static final float BAR_DP = 80, INDICATOR_W_DP = 64, INDICATOR_H_DP = 32, ICON_DP = 24, LABEL_SP = 12;
    /** Material 3's badges: the small one's size, the large one's height and label size. */
    private static final float DOT_DP = 6, BADGE_DP = 16, BADGE_SP = 11;

    private final Context context;
    private final NshComponentContext events;
    private final BooleanSupplier night;
    private final float density;
    private final Bar bar;
    private final List<Item> items = new ArrayList<>();
    private int selected;
    /** The theme's {@code primary} (null: none): the selected tab's icon, label and indicator. */
    private Integer tint;
    /** The bottom inset the bar reaches under, in px. */
    private int inset;

    TabBarComponent(Context context, NshComponentContext events, BooleanSupplier night) {
        this.context = context;
        this.events = events;
        this.night = night;
        this.density = context.getResources().getDisplayMetrics().density;
        this.bar = new Bar(context);
        events.setSize(0, BAR_DP);
    }

    @Override
    public View view() {
        return bar;
    }

    @Override
    public void setProp(String name, Object value) {
        // `TabBar`'s own props arrive as `$items` and `$selectedIndex`.
        if (name.startsWith("$")) name = name.substring(1);
        switch (name) {
            case "items":
                setItems(value instanceof List ? (List<?>) value : null);
                break;
            case "selectedIndex":
                // Removed (or not a whole number): the first tab, the default.
                boolean whole = value instanceof Number && ((Number) value).doubleValue() == ((Number) value).intValue();
                selected = whole ? ((Number) value).intValue() : 0;
                select();
                break;
            case "tint":
                setTint(value instanceof String ? argb((String) value) : null);
                break;
            default:
                break;
        }
    }

    /** The theme's {@code primary} (null: none, the system's colors; transparent is a color). */
    private void setTint(Integer color) {
        if (java.util.Objects.equals(color, tint)) return;
        tint = color;
        paint();
    }

    /** {@code #RRGGBB} or {@code #RRGGBBAA} (the core's hex) as ARGB; null when it is neither. */
    private static Integer argb(String hex) {
        String digits = hex.startsWith("#") ? hex.substring(1) : hex;
        if (digits.length() != 6 && digits.length() != 8) return null;
        long rgba;
        try {
            rgba = Long.parseLong(digits.length() == 6 ? digits + "ff" : digits, 16);
        } catch (NumberFormatException e) {
            return null;
        }
        return (int) ((rgba >>> 8) | ((rgba & 0xff) << 24));
    }

    private void setItems(List<?> tabs) {
        bar.removeAllViews();
        items.clear();
        if (tabs != null) {
            for (int i = 0; i < tabs.size(); i++) {
                Object tab = tabs.get(i);
                Map<?, ?> fields = tab instanceof Map ? (Map<?, ?>) tab : java.util.Collections.emptyMap();
                Item item = new Item(context, i, string(fields.get("title")), string(fields.get("icon")),
                        fields.get("badge") instanceof String ? (String) fields.get("badge") : null);
                items.add(item);
                bar.addView(item, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));
            }
        }
        paint();
        select();
    }

    private static String string(Object value) {
        return value instanceof String ? (String) value : "";
    }

    /** Shows the selection: an index past the tabs selects none. */
    private void select() {
        for (Item item : items) item.setSelected(item.index == selected);
    }

    /** The colors of the appearance shown (the app's, else the system's). */
    private void paint() {
        boolean dark = night.getAsBoolean();
        bar.setBackgroundColor(color(dark ? 0xff211f26 : 0xfff3edf7, dark ? android.R.color.system_neutral1_900 : android.R.color.system_neutral1_50));
        for (Item item : items) item.paint(dark);
    }

    /**
     * Material 3's color: the system's dynamic one on Android 12 and later
     * ({@code res}), the baseline scheme's ({@code baseline}) before.
     */
    private int color(int baseline, int res) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return context.getColor(res);
        return baseline;
    }

    private int px(float dp) {
        return Math.round(dp * density);
    }

    /** The bar: the tabs side by side, equally wide. */
    private final class Bar extends LinearLayout {
        private boolean wasNight;

        Bar(Context context) {
            super(context);
            setOrientation(HORIZONTAL);
            setGravity(Gravity.TOP);
            wasNight = night.getAsBoolean();
        }

        @Override
        protected void onLayout(boolean changed, int l, int t, int r, int b) {
            super.onLayout(changed, l, t, r, b);
            // Reaching the window's bottom, the bar goes under the
            // navigation bar, taller by its inset, as Material's does.
            int bottom = 0;
            WindowInsets insets = getRootWindowInsets();
            if (insets != null && getRootView() != null) {
                int[] at = new int[2];
                getLocationInWindow(at);
                int reach = at[1] + getHeight();
                int window = getRootView().getHeight();
                int nav = navigationInset(insets);
                if (nav > 0 && reach >= window - nav) bottom = nav;
            }
            if (bottom != inset) {
                inset = bottom;
                setPadding(0, 0, 0, inset);
                events.setSize(0, BAR_DP + inset / density);
            }
        }

        @Override
        protected void onConfigurationChanged(Configuration config) {
            super.onConfigurationChanged(config);
            appearanceChanged();
        }

        @Override
        public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
            super.onInitializeAccessibilityNodeInfo(info);
            // A tab list: one row of the tabs.
            info.setCollectionInfo(AccessibilityNodeInfo.CollectionInfo.obtain(1, items.size(), false));
        }

        /** The appearance shown changed (the system's, or the app's). */
        void appearanceChanged() {
            boolean now = night.getAsBoolean();
            if (now == wasNight) return;
            wasNight = now;
            paint();
        }
    }

    private static int navigationInset(WindowInsets insets) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Insets nav = insets.getInsets(WindowInsets.Type.navigationBars());
            return nav.bottom;
        }
        return insets.getSystemWindowInsetBottom();
    }

    /** The app's appearance changed: the bar follows it. */
    void appearanceChanged() {
        bar.appearanceChanged();
    }

    /** One tab: its icon in the active indicator, its label below. */
    /**
     * What TalkBack says for a badge: its text, or for a badge with no text
     * the system's own words for it ("New notification", Material's
     * numberless badge's, in the device's language; not in the public
     * resources). Null for none.
     */
    private static String spokenBadge(String text) {
        if (text == null) return null;
        if (!text.isEmpty()) return text;
        android.content.res.Resources system = android.content.res.Resources.getSystem();
        int words = system.getIdentifier("notification_hidden_text", "string", "android");
        return words != 0 ? system.getString(words) : null;
    }

    private final class Item extends LinearLayout {
        final int index;
        final FrameLayout indicator;
        final ImageView icon;
        final TextView label;
        /** Its badge, null when it has none. */
        final TextView badge;
        final GradientDrawable pill = new GradientDrawable();
        final GradientDrawable badgePill = new GradientDrawable();

        Item(Context context, int index, String title, String iconName, String badgeText) {
            super(context);
            this.index = index;
            setOrientation(VERTICAL);
            setGravity(Gravity.CENTER_HORIZONTAL);
            setPadding(0, px(12), 0, px(16));
            setClickable(true);
            setFocusable(true);
            // TalkBack says the badge with the title, as VoiceOver reads iOS's
            // badge with the tab.
            String spoken = spokenBadge(badgeText);
            setContentDescription(spoken != null ? title + ", " + spoken : title);
            setOnClickListener(v -> {
                // The bar shows the choice at once, as the system's does;
                // the app follows it with `selectedIndex`.
                selected = this.index;
                select();
                events.emit("change", this.index);
            });

            pill.setCornerRadius(px(INDICATOR_H_DP / 2));
            indicator = new FrameLayout(context);
            icon = new ImageView(context);
            icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
            Drawable drawable = drawable(context, iconName);
            if (drawable != null) icon.setImageDrawable(drawable);
            indicator.addView(icon, new FrameLayout.LayoutParams(px(ICON_DP), px(ICON_DP), Gravity.CENTER));
            addView(indicator, new LayoutParams(px(INDICATOR_W_DP), px(INDICATOR_H_DP)));

            // Material 3's badges over the icon's top end: an empty text is
            // the small badge (a dot at the icon's corner), any other the
            // large one (a pill with the text from the icon's middle, cut
            // with an ellipsis where the indicator ends).
            if (badgeText != null) {
                badge = new TextView(context);
                badge.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                badge.setBackground(badgePill);
                FrameLayout.LayoutParams at;
                if (badgeText.isEmpty()) {
                    badgePill.setCornerRadius(px(DOT_DP / 2));
                    at = new FrameLayout.LayoutParams(px(DOT_DP), px(DOT_DP), Gravity.TOP | Gravity.START);
                    at.leftMargin = px((INDICATOR_W_DP + ICON_DP) / 2 - DOT_DP);
                    at.topMargin = px((INDICATOR_H_DP - ICON_DP) / 2);
                } else {
                    badge.setText(badgeText);
                    badge.setSingleLine(true);
                    badge.setEllipsize(android.text.TextUtils.TruncateAt.END);
                    badge.setGravity(Gravity.CENTER);
                    badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, BADGE_SP);
                    badge.setTypeface(TextLayouts.weighted(Typeface.DEFAULT, 500, false, 500, false));
                    badge.setIncludeFontPadding(false);
                    badge.setMinWidth(px(BADGE_DP));
                    badge.setMaxWidth(px(INDICATOR_W_DP / 2));
                    badge.setPadding(px(4), 0, px(4), 0);
                    badgePill.setCornerRadius(px(BADGE_DP / 2));
                    at = new FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.WRAP_CONTENT, px(BADGE_DP), Gravity.TOP | Gravity.START);
                    at.leftMargin = px(INDICATOR_W_DP / 2);
                    at.topMargin = px(2);
                }
                indicator.addView(badge, at);
            } else {
                badge = null;
            }

            label = new TextView(context);
            label.setText(title);
            label.setSingleLine(true);
            label.setEllipsize(android.text.TextUtils.TruncateAt.END);
            label.setGravity(Gravity.CENTER);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, LABEL_SP);
            label.setTypeface(TextLayouts.weighted(Typeface.DEFAULT, 400, false, 500, false));
            LayoutParams lp = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = px(4);
            addView(label, lp);
        }

        @Override
        public void setSelected(boolean on) {
            super.setSelected(on);
            indicator.setBackground(on ? pill : null);
            paint(night.getAsBoolean());
        }

        void paint(boolean dark) {
            boolean on = isSelected();
            // The theme's primary: the selected icon and label in it, over
            // an indicator of it at Material's state-layer opacity (12%).
            pill.setColor(tint != null
                    ? (tint & 0x00ffffff) | (((tint >>> 24) * 0x1f / 0xff) << 24)
                    : color(dark ? 0xff4a4458 : 0xffe8def8, dark ? android.R.color.system_accent2_700 : android.R.color.system_accent2_100));
            int iconColor = on
                    ? (tint != null ? tint : color(dark ? 0xffe8def8 : 0xff1d192b, dark ? android.R.color.system_accent2_100 : android.R.color.system_accent2_900))
                    : color(dark ? 0xffcac4d0 : 0xff49454f, dark ? android.R.color.system_neutral2_200 : android.R.color.system_neutral2_700);
            int labelColor = on
                    ? (tint != null ? tint : color(dark ? 0xffe6e0e9 : 0xff1d1b20, dark ? android.R.color.system_neutral1_100 : android.R.color.system_neutral1_900))
                    : iconColor;
            icon.setImageTintList(ColorStateList.valueOf(iconColor));
            label.setTextColor(labelColor);
            if (badge != null) {
                // Material 3's error and on-error colors.
                badgePill.setColor(dark ? 0xfff2b8b5 : 0xffb3261e);
                badge.setTextColor(dark ? 0xff601410 : 0xffffffff);
            }
            // The press ripple, bounded by the indicator's pill.
            int ripple = (iconColor & 0x00ffffff) | 0x1f000000;
            indicator.setForeground(new RippleDrawable(ColorStateList.valueOf(ripple), null, pill.getConstantState().newDrawable()));
        }

        @Override
        public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
            super.onInitializeAccessibilityNodeInfo(info);
            // A tab of a tab list, "Tab 2 of 3", selected or not.
            info.setClassName("android.widget.TabWidget");
            info.setCollectionItemInfo(AccessibilityNodeInfo.CollectionItemInfo.obtain(0, 1, index, 1, false, isSelected()));
            info.setSelected(isSelected());
        }
    }

    /**
     * Icon {@code name}: a drawable of the app ({@code res/drawable/<name>}),
     * or the system's with an {@code android:} prefix.
     */
    private static Drawable drawable(Context context, String name) {
        if (name.isEmpty()) return null;
        String pkg = context.getPackageName();
        if (name.startsWith("android:")) {
            pkg = "android";
            name = name.substring("android:".length());
        }
        int id = context.getResources().getIdentifier(name, "drawable", pkg);
        if (id == 0) {
            if (logged.add(name)) android.util.Log.w("nsh", "TabBar: no drawable is named `" + name + "`");
            return null;
        }
        try {
            return context.getDrawable(id);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static final java.util.Set<String> logged = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
}
