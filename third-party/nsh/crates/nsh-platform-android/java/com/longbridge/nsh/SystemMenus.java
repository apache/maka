package com.longbridge.nsh;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Outline;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.PorterDuff;
import android.graphics.Rect;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.util.LruCache;
import android.util.TypedValue;
import android.view.ContextThemeWrapper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.CompoundButton;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.RadioButton;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * The system menu of {@code nsh/base}'s {@code MenuButton} and of its
 * {@code ContextMenu} given {@code items} ({@link MenuButtonComponent},
 * {@link ContextMenuComponent}): a {@link PopupWindow} made from the items'
 * data, laid out as the Material 3 menu guidelines have it, in the colors of
 * the app's appearance. Main thread.
 *
 * <p>The rows are its own rather than {@link android.widget.PopupMenu}'s:
 * those follow the device's default theme, whose row layouts differ by
 * vendor (an icon's slot narrower than the icon, taller rows, the menu over
 * its anchor) and have no title of their own. The window, its shadow and its
 * enter and exit transitions are still the system's.
 */
final class SystemMenus {
    private SystemMenus() {}

    /** One item, as the {@code items} prop gives it ({@code nsh_base::menu_button::menu_json}). */
    static final class Entry {
        String id = "";
        String label = "";
        /** Its icon, an SVG document (null: none). */
        String svg;
        /** Checkable, checked or not (null: not checkable). */
        Boolean checked;
        boolean disabled, destructive, inline;
        /** Its own actions are one choice: radio buttons. */
        boolean singleSelection;
        final List<Entry> items = new ArrayList<>();
    }

    /** The menu on screen, which the test agent chooses from ({@link TestAgent}); null when none is. */
    static Popup open;

    /**
     * Closes the menu on screen if it was made in {@code context}, an app's: the activity its window is in goes
     * ({@link Mounter#leaveWindows}).
     */
    static void dismissOf(Context context) {
        if (open == null || open.owner != context) return;
        // At once: an exit transition would keep the window until after the activity is gone, leaking it.
        open.window.setExitTransition(null);
        open.dismiss();
    }

    /** How deep submenus nest: past it an entry's items are dropped, as on iOS. */
    private static final int MAX_DEPTH = 8;

    /** The entries of an {@code items} prop; anything but objects is skipped. */
    static List<Entry> parse(Object value) {
        return parse(value, 0);
    }

    private static List<Entry> parse(Object value, int depth) {
        List<Entry> entries = new ArrayList<>();
        if (!(value instanceof List)) return entries;
        for (Object o : (List<?>) value) {
            if (!(o instanceof Map)) continue;
            Map<?, ?> m = (Map<?, ?>) o;
            Entry e = new Entry();
            e.id = text(m.get("id"));
            e.label = text(m.get("label"));
            e.svg = m.get("svg") instanceof String ? (String) m.get("svg") : null;
            e.checked = m.get("checked") instanceof Boolean ? (Boolean) m.get("checked") : null;
            e.disabled = Boolean.TRUE.equals(m.get("disabled"));
            e.destructive = Boolean.TRUE.equals(m.get("destructive"));
            e.inline = Boolean.TRUE.equals(m.get("inline"));
            e.singleSelection = Boolean.TRUE.equals(m.get("singleSelection"));
            if (depth + 1 < MAX_DEPTH) e.items.addAll(parse(m.get("items"), depth + 1));
            entries.add(e);
        }
        return entries;
    }

    private static String text(Object o) {
        return o instanceof String ? (String) o : "";
    }

    /**
     * Where a menu anchored to {@code anchor} lines up: its end edge when the
     * anchor's middle is in the end half of the window (an overflow button at
     * the top end), its start edge otherwise.
     */
    static int gravity(View anchor) {
        int[] at = new int[2];
        anchor.getLocationInWindow(at);
        int middle = at[0] + anchor.getWidth() / 2;
        int width = anchor.getRootView().getWidth();
        boolean rtl = anchor.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL;
        boolean right = middle > width / 2;
        return right != rtl ? Gravity.END : Gravity.START;
    }

    /**
     * A menu of {@code entries} below {@code anchor}, lined up with its
     * {@code gravity} edge, with {@code title} first when there is one; a
     * chosen action calls {@code select} with its id, then closes the menu.
     * The caller shows it and hears its dismissal.
     */
    static Popup popup(Context context, boolean night, View anchor, int gravity, String title, List<Entry> entries,
            Consumer<String> select) {
        return new Popup(context, night, anchor, gravity, title, entries, select);
    }

    // Material 3's menu measures, in dp (sp for text).
    private static final int MIN_WIDTH = 112, MAX_WIDTH = 280;
    /** The widest a title makes the menu: past it, it takes a second line. */
    private static final int TITLE_WIDTH = 200;
    private static final int ROW_HEIGHT = 48, PADDING = 12, ICON = 20, GAP = 12, LIST_PADDING = 8;
    private static final int CORNER = 12, ELEVATION = 8;
    /** Between the anchor and the menu, and the menu and the window's edges. */
    private static final int OFFSET = 4, MARGIN = 8;
    private static final int LABEL_SP = 16, TITLE_SP = 14;
    /** Material's disabled content: 38%. */
    private static final float DISABLED_ALPHA = 0.38f;

    /** The menu's colors in one appearance. */
    private static final class Palette {
        final int container, text, secondary, error, divider, ripple;

        Palette(boolean night) {
            container = night ? 0xff2b2930 : 0xffffffff;
            text = night ? 0xffe6e0e9 : 0xff1d1b20;
            secondary = night ? 0xffcac4d0 : 0xff49454f;
            error = night ? 0xfff2b8b5 : 0xffb3261e;
            divider = night ? 0x1fffffff : 0x1f000000;
            // The pressed state layer: 10% of the content color.
            ripple = (text & 0x00ffffff) | 0x1a000000;
        }
    }

    /**
     * One menu on screen: a window of rows, one level at a time; a submenu
     * shows its items in place of its menu's, under its label.
     */
    static final class Popup {
        /** The context it was made in: its app's. */
        private final Context owner;
        private final Context context;
        private final Palette palette;
        private final float density;
        private final View anchor;
        private final int gravity;
        private final Consumer<String> select;
        private final PopupWindow window;
        private final FrameLayout root;
        private final LinearLayout list;
        /** The item rows of the level shown, for the reader's positions. */
        private int rowCount;
        private Runnable onDismiss;

        Popup(Context context, boolean night, View anchor, int gravity, String title, List<Entry> entries,
                Consumer<String> select) {
            this.owner = context;
            this.context = new ContextThemeWrapper(context,
                    night ? android.R.style.Theme_Material : android.R.style.Theme_Material_Light);
            this.palette = new Palette(night);
            this.density = context.getResources().getDisplayMetrics().density;
            this.anchor = anchor;
            this.gravity = gravity;
            this.select = select;

            // The list popup's style: its enter and exit transitions, below
            // the anchor rather than over it.
            window = new PopupWindow(this.context, null, 0, night
                    ? android.R.style.Widget_Material_ListPopupWindow
                    : android.R.style.Widget_Material_Light_ListPopupWindow);
            GradientDrawable background = new GradientDrawable();
            background.setColor(palette.container);
            background.setCornerRadius(dp(CORNER));
            window.setBackgroundDrawable(background);
            window.setElevation(dp(ELEVATION));
            window.setOverlapAnchor(false);
            window.setFocusable(true);
            // Touch-modal, so the touches outside come to the menu too: a
            // tap there closes it on release, a back swipe leaves it to the
            // back the swipe sends (MenuOutsideTouch).
            window.setOutsideTouchable(false);
            MenuOutsideTouch outside = new MenuOutsideTouch();
            window.setTouchInterceptor((view, event) -> {
                float x = event.getX(), y = event.getY();
                boolean out = x < 0 || y < 0 || x >= view.getWidth() || y >= view.getHeight();
                switch (outside.on(event.getActionMasked(), out)) {
                    case MenuOutsideTouch.DISMISS:
                        window.dismiss();
                        return true;
                    case MenuOutsideTouch.TAKE:
                        return true;
                    default:
                        return false;
                }
            });
            window.setInputMethodMode(PopupWindow.INPUT_METHOD_NOT_NEEDED);
            window.setOnDismissListener(() -> {
                if (open == this) open = null;
                if (onDismiss != null) onDismiss.run();
            });

            list = new LinearLayout(this.context) {
                @Override
                public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
                    super.onInitializeAccessibilityNodeInfo(info);
                    info.setCollectionInfo(AccessibilityNodeInfo.CollectionInfo.obtain(rowCount, 1, false));
                }
            };
            list.setOrientation(LinearLayout.VERTICAL);
            list.setPadding(0, dp(LIST_PADDING), 0, dp(LIST_PADDING));
            ScrollView scroll = new ScrollView(this.context);
            scroll.addView(list, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT));
            root = new FrameLayout(this.context);
            root.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
            // Pressed rows stay inside the rounded corners.
            root.setOutlineProvider(new ViewOutlineProvider() {
                @Override
                public void getOutline(View view, Outline outline) {
                    outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), dp(CORNER));
                }
            });
            root.setClipToOutline(true);
            window.setContentView(root);
            fill(title, entries, false);
        }

        /** Called once the menu goes, however it went. */
        void setOnDismissListener(Runnable listener) {
            onDismiss = listener;
        }

        void show() {
            place(false);
            open = this;
        }

        void dismiss() {
            window.dismiss();
        }

        /** The root of the menu's window, where its touches and keys go. */
        View windowRoot() {
            return root.getRootView();
        }

        /** The row of the level shown labelled {@code label}; null when it has none. */
        View row(String label) {
            for (int i = 0; i < list.getChildCount(); i++) {
                View child = list.getChildAt(i);
                CharSequence name = child.getContentDescription();
                if (child.isClickable() && name != null && label.contentEquals(name)) return child;
            }
            return null;
        }

        /** The labels of the level's rows, in their order. */
        List<String> labels() {
            List<String> labels = new ArrayList<>();
            for (int i = 0; i < list.getChildCount(); i++) {
                View child = list.getChildAt(i);
                if (child.isClickable()) labels.add(String.valueOf(child.getContentDescription()));
            }
            return labels;
        }

        private int dp(float value) {
            return Math.round(value * density);
        }

        /**
         * Sizes the window to the level shown and puts it below the anchor:
         * as wide as its widest row within Material's bounds, no taller than
         * the room on the anchor's roomier side, {@link #MARGIN} from the
         * window's edges.
         */
        private void place(boolean shown) {
            Rect frame = new Rect();
            anchor.getWindowVisibleDisplayFrame(frame);
            int margin = dp(MARGIN);
            int widest = Math.max(dp(MIN_WIDTH), frame.width() - 2 * margin);
            int maxWidth = Math.min(dp(MAX_WIDTH), widest);
            int natural = 0;
            int unspecified = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED);
            for (int i = 0; i < list.getChildCount(); i++) {
                View child = list.getChildAt(i);
                child.measure(unspecified, unspecified);
                int w = child.getMeasuredWidth();
                natural = Math.max(natural, child instanceof TextView ? Math.min(w, dp(TITLE_WIDTH)) : w);
            }
            int width = Math.max(Math.min(dp(MIN_WIDTH), maxWidth), Math.min(natural, maxWidth));
            root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), unspecified);
            int offset = dp(OFFSET);
            int room = window.getMaxAvailableHeight(anchor, offset) - margin;
            int height = Math.max(dp(ROW_HEIGHT), Math.min(root.getMeasuredHeight(), room));

            int edge = Gravity.getAbsoluteGravity(gravity, anchor.getLayoutDirection())
                    & Gravity.HORIZONTAL_GRAVITY_MASK;
            int[] at = new int[2];
            anchor.getLocationOnScreen(at);
            int left = edge == Gravity.RIGHT ? at[0] + anchor.getWidth() - width : at[0];
            int x = Math.max(frame.left + margin, Math.min(left, frame.right - margin - width));
            int xoff = x - left;
            window.setWidth(width);
            window.setHeight(height);
            if (shown) window.update(anchor, xoff, offset, width, height);
            else window.showAsDropDown(anchor, xoff, offset, edge == Gravity.RIGHT ? Gravity.RIGHT : Gravity.LEFT);
        }

        /**
         * Shows a level: {@code title} (a submenu's label) first, then its
         * entries, an inline section's items between dividers. Checkable
         * items are independent checks, as on iOS, unless the level or
         * section is marked as one choice ({@code single}): then its
         * actions are radio buttons.
         */
        private void fill(String title, List<Entry> entries, boolean single) {
            list.removeAllViews();
            rowCount = 0;
            boolean icons = hasIcon(entries);
            if (title != null && !title.isEmpty()) list.addView(header(title));
            boolean afterSection = false;
            for (Entry e : entries) {
                if (e.inline && !e.items.isEmpty()) {
                    if (rowCount > 0) list.addView(divider());
                    if (!e.label.isEmpty()) list.addView(header(e.label));
                    for (Entry item : e.items) list.addView(row(item, e.singleSelection, icons));
                    afterSection = true;
                } else {
                    if (afterSection) {
                        list.addView(divider());
                        afterSection = false;
                    }
                    list.addView(row(e, single, icons));
                }
            }
        }

        /** A submenu chosen: its items in place of the menu's. */
        private void open(Entry e) {
            fill(e.label, e.items, e.singleSelection);
            place(true);
            // The reader goes on at the submenu's label.
            View first = list.getChildAt(0);
            if (first != null) {
                first.post(() -> first.performAccessibilityAction(
                        AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null));
            }
        }

        /** Whether a row of the level has an icon: then every row keeps its place. */
        private static boolean hasIcon(List<Entry> entries) {
            for (Entry e : entries) {
                if (e.svg != null && !e.svg.isEmpty()) return true;
                if (e.inline && hasIcon(e.items)) return true;
            }
            return false;
        }

        /** A title (the menu's, a submenu's or a section's): secondary, smaller, two lines at most. */
        private TextView header(String title) {
            TextView view = new TextView(context);
            view.setText(title);
            view.setTextSize(TypedValue.COMPLEX_UNIT_SP, TITLE_SP);
            view.setTextColor(palette.secondary);
            view.setMaxLines(2);
            view.setEllipsize(TextUtils.TruncateAt.END);
            view.setPadding(dp(PADDING), dp(4), dp(PADDING), dp(8));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) view.setAccessibilityHeading(true);
            return view;
        }

        private View divider() {
            View view = new View(context);
            view.setBackgroundColor(palette.divider);
            LinearLayout.LayoutParams params =
                    new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(1)));
            params.setMargins(0, dp(LIST_PADDING), 0, dp(LIST_PADDING));
            view.setLayoutParams(params);
            return view;
        }

        /**
         * An item's row: its icon (or the icon's place, {@code icons}), its
         * label, and a check, a radio button or a submenu's chevron at the
         * end; in the error color when it is destructive.
         */
        private View row(Entry e, boolean single, boolean icons) {
            boolean submenu = !e.items.isEmpty();
            boolean radio = !submenu && single;
            boolean check = !submenu && !single && e.checked != null;
            boolean checked = Boolean.TRUE.equals(e.checked);
            int color = e.destructive ? palette.error : palette.text;
            int position = rowCount++;

            LinearLayout row = new LinearLayout(context) {
                @Override
                public CharSequence getAccessibilityClassName() {
                    if (radio) return RadioButton.class.getName();
                    if (check) return CheckBox.class.getName();
                    return Button.class.getName();
                }

                @Override
                public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
                    super.onInitializeAccessibilityNodeInfo(info);
                    if (radio || check) {
                        info.setCheckable(true);
                        info.setChecked(checked);
                    }
                    info.setCollectionItemInfo(
                            AccessibilityNodeInfo.CollectionItemInfo.obtain(position, 1, 0, 1, false));
                }
            };
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setMinimumHeight(dp(ROW_HEIGHT));
            row.setPadding(dp(PADDING), 0, dp(PADDING), 0);
            row.setBackground(new RippleDrawable(ColorStateList.valueOf(palette.ripple), null,
                    new ColorDrawable(0xffffffff)));
            row.setContentDescription(e.label);
            row.setEnabled(!e.disabled);
            row.setClickable(true);
            row.setFocusable(true);
            row.setOnClickListener(v -> {
                if (submenu) {
                    open(e);
                } else {
                    select.accept(e.id);
                    window.dismiss();
                }
            });
            float alpha = e.disabled ? DISABLED_ALPHA : 1f;

            if (icons) {
                ImageView icon = new ImageView(context);
                Drawable drawable = icon(e, color);
                if (drawable != null) icon.setImageDrawable(drawable);
                icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
                icon.setAlpha(alpha);
                icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(ICON), dp(ICON));
                params.setMarginEnd(dp(GAP));
                row.addView(icon, params);
            }

            TextView label = new TextView(context);
            label.setText(e.label);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, LABEL_SP);
            label.setTextColor(color);
            label.setSingleLine(true);
            label.setEllipsize(TextUtils.TruncateAt.END);
            label.setAlpha(alpha);
            label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            row.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

            View end = null;
            if (submenu) {
                ImageView chevron = new ImageView(context);
                chevron.setImageDrawable(new Chevron(palette.secondary, dp(1.5f)));
                end = chevron;
                row.addView(chevron, endParams(dp(ICON)));
            } else if (radio || check) {
                CompoundButton button = radio ? new RadioButton(context) : new CheckBox(context);
                button.setChecked(checked);
                button.jumpDrawablesToCurrentState();
                button.setButtonTintList(ColorStateList.valueOf(palette.text));
                button.setBackground(null);
                button.setClickable(false);
                button.setFocusable(false);
                end = button;
                row.addView(button, endParams(ViewGroup.LayoutParams.WRAP_CONTENT));
            }
            if (end != null) {
                end.setAlpha(alpha);
                end.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            }
            return row;
        }

        private LinearLayout.LayoutParams endParams(int size) {
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(size, size);
            params.setMarginStart(dp(GAP));
            return params;
        }

        /** An item's SVG icon in {@code color}; null without one or when it does not draw. */
        private Drawable icon(Entry e, int color) {
            if (e.svg == null || e.svg.isEmpty()) return null;
            Bitmap bitmap = bitmap(e.svg, dp(ICON));
            if (bitmap == null) return null;
            BitmapDrawable d = new BitmapDrawable(context.getResources(), bitmap);
            d.setTint(color);
            d.setTintMode(PorterDuff.Mode.SRC_IN);
            return d;
        }
    }

    /** A submenu's chevron, pointing to the end (mirrored right to left). */
    private static final class Chevron extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();

        Chevron(int color, float stroke) {
            paint.setColor(color);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(stroke);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
        }

        @Override
        public void draw(Canvas canvas) {
            Rect b = getBounds();
            float s = Math.min(b.width(), b.height());
            float cx = b.exactCenterX(), cy = b.exactCenterY();
            float dx = s * 0.125f, dy = s * 0.25f;
            if (getLayoutDirection() == View.LAYOUT_DIRECTION_RTL) dx = -dx;
            path.rewind();
            path.moveTo(cx - dx, cy - dy);
            path.lineTo(cx + dx, cy);
            path.lineTo(cx - dx, cy + dy);
            canvas.drawPath(path, paint);
        }

        @Override
        public boolean isAutoMirrored() {
            return true;
        }

        @Override
        public void setAlpha(int alpha) {
            paint.setAlpha(alpha);
        }

        @Override
        public void setColorFilter(ColorFilter filter) {
            paint.setColorFilter(filter);
        }

        @Override
        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }

    /** Rasterized icons by document and size: a menu reopened draws the same ones. */
    private static final LruCache<String, Bitmap> BITMAPS = new LruCache<>(64);

    /**
     * The SVG {@code svg} drawn with its shorter side {@code px} pixels long;
     * null when it is no SVG or SVGs are not built in.
     */
    private static Bitmap bitmap(String svg, int px) {
        String key = px + ":" + svg;
        Bitmap cached = BITMAPS.get(key);
        if (cached != null) return cached;
        int[] size = new int[4];
        byte[] pixels;
        try {
            float density = android.content.res.Resources.getSystem().getDisplayMetrics().density;
            pixels = Native.svg(svg.getBytes(java.nio.charset.StandardCharsets.UTF_8), px, density, size,
                    new float[2]);
        } catch (RuntimeException | LinkageError e) {
            return null;
        }
        if (pixels == null || size[0] <= 0 || size[1] <= 0) return null;
        Bitmap bitmap = Bitmap.createBitmap(size[0], size[1], Bitmap.Config.ARGB_8888);
        bitmap.copyPixelsFromBuffer(java.nio.ByteBuffer.wrap(pixels));
        BITMAPS.put(key, bitmap);
        return bitmap;
    }
}
