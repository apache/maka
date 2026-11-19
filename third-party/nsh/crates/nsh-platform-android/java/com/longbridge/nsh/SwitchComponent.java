package com.longbridge.nsh;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.view.View;
import android.widget.Switch;
import java.util.function.BooleanSupplier;

/**
 * {@code nsh/mobile}'s {@code Switch} on Android: the framework's
 * {@link Switch} (its touch, drag, motion, keyboard and TalkBack: "switch,
 * on") with Material 3's track and thumb, in the system's dynamic colors on
 * Android 12 and later and Material's baseline colors before; the theme's
 * {@code primary}, when the app has one, is the track's color while on. The
 * app owns the value: the user's flip is reported as {@code change} with the
 * value it asks for, and the switch shows the value the app passes back.
 */
final class SwitchComponent implements NshComponent {
    /** Its name ({@code nsh_core::platform::SWITCH_COMPONENT}). */
    static final String NAME = "nsh/switch";

    /** Material 3: the track's size and the thumb's, off, on and pressed; the outline's width. */
    private static final float TRACK_W_DP = 52, TRACK_H_DP = 32, THUMB_OFF_DP = 16, THUMB_ON_DP = 24,
            THUMB_PRESSED_DP = 28, OUTLINE_DP = 2;

    private final Context context;
    private final NshComponentContext events;
    private final BooleanSupplier night;
    private final float density;
    private final Control control;
    private final Track track = new Track();
    private final Thumb thumb = new Thumb();
    /** The theme's {@code primary} (null: none, the system's colors). */
    private Integer tint;
    /** The style's {@code accentColor}, over {@code tint} (null: none). */
    private Integer accent;
    /** Material 3's colors in the appearance shown. */
    private int primary, onPrimary, outline, container;
    /** The app's value ({@code checked}), which a {@code revision} shows again. */
    private boolean appOn;
    /** The app's value is being shown: no {@code change} for it. */
    private boolean applying;

    SwitchComponent(Context context, NshComponentContext events, BooleanSupplier night) {
        this.context = context;
        this.events = events;
        this.night = night;
        this.density = context.getResources().getDisplayMetrics().density;
        this.control = new Control(context);
        control.setThumbDrawable(thumb);
        control.setTrackDrawable(track);
        control.setShowText(false);
        control.setSwitchMinWidth(px(TRACK_W_DP));
        control.setSwitchPadding(0);
        control.setPadding(0, 0, 0, 0);
        control.setMinHeight(0);
        control.setMinWidth(0);
        control.setMinimumHeight(0);
        control.setMinimumWidth(0);
        control.setOnCheckedChangeListener((view, checked) -> {
            if (!applying) events.emit("change", checked);
        });
        paint();
        control.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
        events.setSize(control.getMeasuredWidth() / density, control.getMeasuredHeight() / density);
    }

    @Override
    public View view() {
        return control;
    }

    @Override
    public void setProp(String name, Object value) {
        switch (name) {
            case "checked":
                appOn = Boolean.TRUE.equals(value);
                show();
                break;
            case "revision":
                // A flip the app has heard: a value it kept moves the switch back.
                show();
                break;
            case "disabled":
                boolean disabled = Boolean.TRUE.equals(value);
                control.setEnabled(!disabled);
                // Material 3's disabled switch: the whole control at 38%.
                control.setAlpha(disabled ? 0.38f : 1f);
                break;
            case "accessibilityLabel":
                control.setContentDescription(value instanceof String ? (String) value : null);
                break;
            case "tint":
                Integer color = value instanceof String ? argb((String) value) : null;
                if (java.util.Objects.equals(color, tint)) return;
                tint = color;
                paint();
                break;
            case "accentColor":
                Integer accentColor = value instanceof String ? argb((String) value) : null;
                if (java.util.Objects.equals(accentColor, accent)) return;
                accent = accentColor;
                paint();
                break;
            default:
                break;
        }
    }

    /** Shows the app's value; the value it already shows (the user's flip the app took) moves nothing. */
    private void show() {
        if (control.isChecked() == appOn) return;
        applying = true;
        control.setChecked(appOn);
        applying = false;
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

    /** Material 3's colors in the appearance shown, with the style's {@code accentColor}, else the theme's {@code primary}, over the system's. */
    private void paint() {
        boolean dark = night.getAsBoolean();
        Integer on = accent != null ? accent : tint;
        if (on != null) {
            primary = on;
            // The thumb on it: light on a dark color, dark on a light one.
            onPrimary = Color.luminance(on) > 0.5f ? 0xff1d1b20 : 0xffffffff;
        } else {
            primary = color(dark ? 0xffd0bcff : 0xff6750a4,
                    dark ? android.R.color.system_accent1_200 : android.R.color.system_accent1_600);
            onPrimary = color(dark ? 0xff381e72 : 0xffffffff,
                    dark ? android.R.color.system_accent1_800 : android.R.color.system_accent1_0);
        }
        outline = color(dark ? 0xff938f99 : 0xff79747e,
                dark ? android.R.color.system_neutral2_400 : android.R.color.system_neutral2_500);
        container = color(dark ? 0xff36343b : 0xffe6e0e9,
                dark ? android.R.color.system_neutral1_800 : android.R.color.system_neutral1_100);
        control.invalidate();
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

    /** The app's appearance changed: the colors follow it. */
    void appearanceChanged() {
        control.appearanceChanged();
    }

    /**
     * How far the thumb is along the track: 0 off, 1 on, in between while it
     * is dragged or moves, so its size and the colors follow it.
     */
    private float position() {
        Rect t = track.getBounds(), b = thumb.getBounds();
        int travel = t.width() - b.width();
        if (travel <= 0) return control.isChecked() ? 1f : 0f;
        float along = Math.max(0f, Math.min(1f, (b.left - t.left) / (float) travel));
        // Right to left, the framework moves the thumb from the end to the start.
        return control.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL ? 1f - along : along;
    }

    private static int blend(int from, int to, float at) {
        int a = Math.round(Color.alpha(from) + (Color.alpha(to) - Color.alpha(from)) * at);
        int r = Math.round(Color.red(from) + (Color.red(to) - Color.red(from)) * at);
        int g = Math.round(Color.green(from) + (Color.green(to) - Color.green(from)) * at);
        int b = Math.round(Color.blue(from) + (Color.blue(to) - Color.blue(from)) * at);
        return Color.argb(a, r, g, b);
    }

    /** The framework's switch, following the app's appearance. */
    private final class Control extends Switch {
        private boolean wasNight;

        Control(Context context) {
            super(context);
            wasNight = night.getAsBoolean();
        }

        @Override
        protected void onConfigurationChanged(Configuration config) {
            super.onConfigurationChanged(config);
            appearanceChanged();
            // The system's dynamic colors may have changed with it.
            paint();
        }

        void appearanceChanged() {
            boolean now = night.getAsBoolean();
            if (now == wasNight) return;
            wasNight = now;
            paint();
        }
    }

    /** Material 3's track: a pill, outlined while off, filled with {@code primary} while on. */
    private final class Track extends Drawable {
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF shape = new RectF();

        Track() {
            stroke.setStyle(Paint.Style.STROKE);
        }

        @Override
        public int getIntrinsicWidth() {
            return px(TRACK_W_DP);
        }

        @Override
        public int getIntrinsicHeight() {
            return px(TRACK_H_DP);
        }

        @Override
        public void draw(Canvas canvas) {
            Rect b = getBounds();
            float at = position();
            float radius = b.height() / 2f;
            shape.set(b);
            fill.setColor(blend(container, primary, at));
            canvas.drawRoundRect(shape, radius, radius, fill);
            if (at < 1f) {
                float width = OUTLINE_DP * density;
                stroke.setStrokeWidth(width);
                stroke.setColor(blend(outline, primary, at));
                shape.inset(width / 2, width / 2);
                canvas.drawRoundRect(shape, radius - width / 2, radius - width / 2, stroke);
            }
        }

        @Override
        public void setAlpha(int alpha) {}

        @Override
        public void setColorFilter(ColorFilter filter) {}

        @Override
        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }

    /**
     * Material 3's thumb: a circle that grows as it moves on and while it is
     * held, in the outline's color while off and {@code onPrimary} while on.
     * Its bounds are half the track (the framework moves them along it); the
     * circle sits where Material puts it.
     */
    private final class Thumb extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private boolean pressed;

        @Override
        public boolean isStateful() {
            return true;
        }

        @Override
        protected boolean onStateChange(int[] state) {
            boolean now = false;
            for (int s : state) if (s == android.R.attr.state_pressed) now = true;
            if (now == pressed) return false;
            pressed = now;
            invalidateSelf();
            return true;
        }

        @Override
        public int getIntrinsicWidth() {
            return px(TRACK_W_DP / 2);
        }

        @Override
        public int getIntrinsicHeight() {
            return px(TRACK_H_DP);
        }

        @Override
        public void draw(Canvas canvas) {
            Rect b = getBounds();
            float at = position();
            float diameter = pressed ? THUMB_PRESSED_DP : THUMB_OFF_DP + (THUMB_ON_DP - THUMB_OFF_DP) * at;
            // Off, the circle's center is the track's height / 2 from its
            // start; on, as far from its end.
            float half = TRACK_H_DP / 2;
            float fromStart = half + ((TRACK_W_DP / 2 - half) - half) * at;
            float cx = b.left + fromStart * density;
            if (control.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL) {
                cx = b.right - fromStart * density;
            }
            paint.setColor(blend(outline, onPrimary, at));
            canvas.drawCircle(cx, b.exactCenterY(), diameter * density / 2, paint);
        }

        @Override
        public void setAlpha(int alpha) {}

        @Override
        public void setColorFilter(ColorFilter filter) {}

        @Override
        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }
}
