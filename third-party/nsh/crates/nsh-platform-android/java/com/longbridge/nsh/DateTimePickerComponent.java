package com.longbridge.nsh;

import android.app.DatePickerDialog;
import android.app.TimePickerDialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.text.format.DateFormat;
import android.util.TypedValue;
import android.view.ContextThemeWrapper;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.DatePicker;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * {@code nsh/mobile}'s {@code DateTimePicker} on Android: the value in a field
 * (a day and a time of day are two, as iOS's compact picker shows them), in
 * the formats of the app's text language and the user's 12- or 24-hour clock.
 * A press opens the framework's {@link DatePickerDialog} or
 * {@link TimePickerDialog}; the picked value shows at once and is reported as
 * {@code change} with its fields ({@code year}, {@code month}, {@code day},
 * {@code hour}, {@code minute}). The app owns the value. The dialogs' own
 * words (their buttons, month and day names, the date dialog's header) are in
 * that language too.
 */
final class DateTimePickerComponent implements NshComponent {
    /** Its name ({@code nsh_core::platform::DATE_TIME_PICKER_COMPONENT}). */
    static final String NAME = "nsh/date-time-picker";

    /** Material 3's small shape and body text; the fields' padding and gap. */
    private static final float CORNER_DP = 8, TEXT_SP = 16, PAD_H_DP = 12, PAD_V_DP = 8, GAP_DP = 8;

    private final Context context;
    private final NshComponentContext events;
    private final BooleanSupplier night;
    /** The language of the app's text ({@link Mounter#textLocale}; null: the system's). */
    private final Supplier<Locale> textLocale;
    private final float density;
    private final Row row;
    private final Field dateField, timeField;
    private String mode = "date";
    /** The value shown: its day ({@code month} 1 to 12) and time of day. */
    private int year, month, day, hour, minute;
    /** The bounds (null: none), as their fields. */
    private Map<?, ?> min, max;
    private int minuteInterval = 1;
    private boolean disabled;
    /** What screen readers say with each field's value (null: the value alone). */
    private String label;

    DateTimePickerComponent(Context context, NshComponentContext events, BooleanSupplier night,
            Supplier<Locale> textLocale) {
        this.context = context;
        this.events = events;
        this.night = night;
        this.textLocale = textLocale;
        this.density = context.getResources().getDisplayMetrics().density;
        this.row = new Row(context);
        this.dateField = new Field(context);
        this.timeField = new Field(context);
        dateField.setOnClickListener(v -> pickDate());
        timeField.setOnClickListener(v -> pickTime());
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        gap.setMarginStart(px(GAP_DP));
        row.addView(dateField);
        row.addView(timeField, gap);
        showNow();
        paint();
        show();
    }

    @Override
    public View view() {
        return row;
    }

    @Override
    public void setProp(String name, Object value) {
        switch (name) {
            case "mode":
                mode = value instanceof String ? (String) value : "date";
                break;
            case "value":
                // None shows the present, as the system's pickers do.
                showNow();
                if (value instanceof Map) take((Map<?, ?>) value);
                break;
            case "min":
                min = value instanceof Map ? (Map<?, ?>) value : null;
                break;
            case "max":
                max = value instanceof Map ? (Map<?, ?>) value : null;
                break;
            case "minuteInterval":
                minuteInterval = value instanceof Number ? Math.max(1, ((Number) value).intValue()) : 1;
                break;
            case "disabled":
                disabled = Boolean.TRUE.equals(value);
                break;
            case "accessibilityLabel":
                label = value instanceof String ? (String) value : null;
                break;
            default:
                return;
        }
        show();
    }

    private void showNow() {
        Calendar now = Calendar.getInstance();
        year = now.get(Calendar.YEAR);
        month = now.get(Calendar.MONTH) + 1;
        day = now.get(Calendar.DAY_OF_MONTH);
        hour = now.get(Calendar.HOUR_OF_DAY);
        minute = now.get(Calendar.MINUTE);
    }

    /** The fields {@code value} has: a day, a time of day or both. */
    private void take(Map<?, ?> value) {
        if (value.get("year") instanceof Number) {
            year = number(value, "year");
            month = number(value, "month");
            day = number(value, "day");
        }
        if (value.get("hour") instanceof Number) {
            hour = number(value, "hour");
            minute = number(value, "minute");
        }
    }

    private static int number(Map<?, ?> fields, String name) {
        Object v = fields.get(name);
        return v instanceof Number ? ((Number) v).intValue() : 0;
    }

    private boolean hasDate() {
        return !"time".equals(mode);
    }

    private boolean hasTime() {
        return !"date".equals(mode);
    }

    /** Shows the value in the app's language and the user's clock, and the fields the mode has. */
    private void show() {
        Calendar at = Calendar.getInstance();
        at.clear();
        at.set(year, month - 1, day, hour, minute);
        dateField.setText(dateFormat().format(at.getTime()));
        timeField.setText(timeFormat().format(at.getTime()));
        // TalkBack reads a field's description in place of its text: the name, then the value.
        for (Field field : new Field[] {dateField, timeField}) {
            field.setContentDescription(label == null ? null : label + ", " + field.getText());
        }
        dateField.setVisibility(hasDate() ? View.VISIBLE : View.GONE);
        timeField.setVisibility(hasTime() ? View.VISIBLE : View.GONE);
        // A time of day alone takes no gap before it.
        LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) timeField.getLayoutParams();
        params.setMarginStart(hasDate() ? px(GAP_DP) : 0);
        timeField.setLayoutParams(params);
        for (Field field : new Field[] {dateField, timeField}) {
            field.setEnabled(!disabled);
            field.setAlpha(disabled ? 0.38f : 1f);
        }
        row.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
        events.setSize(row.getMeasuredWidth() / density, row.getMeasuredHeight() / density);
    }

    /**
     * The day's format: the system's medium one, in the language of the app's
     * text. {@link DateFormat#getMediumDateFormat} would take the field's
     * context's, the activity's, which is the system's.
     */
    private java.text.DateFormat dateFormat() {
        Locale locale = textLocale.get();
        if (locale == null) return DateFormat.getMediumDateFormat(context);
        return java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM, locale);
    }

    /**
     * The time of day's format: {@link DateFormat#getTimeFormat}'s pattern in
     * the language of the app's text, while the 12- or 24-hour clock stays the
     * user's setting, as the time dialog's does.
     */
    private java.text.DateFormat timeFormat() {
        Locale locale = textLocale.get();
        if (locale == null) return DateFormat.getTimeFormat(context);
        String skeleton = DateFormat.is24HourFormat(context) ? "Hm" : "hm";
        return new SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, skeleton), locale);
    }

    /** The language of the app's text changed ({@link Mounter#textLocale}): the fields show the value in it. */
    void textLocaleChanged() {
        show();
    }

    /** The dialogs' theme: the appearance shown (the app's, else the system's). */
    private int dialogTheme() {
        return night.getAsBoolean()
                ? android.R.style.Theme_DeviceDefault_Dialog_Alert
                : android.R.style.Theme_DeviceDefault_Light_Dialog_Alert;
    }

    /**
     * What the dialogs are made in: the framework's dialogs take their words
     * from the context's resources, the system's language, while an app that
     * shows itself in another one ({@code setLocale}, its translations) has
     * the rest of its text in that, as the screen reader's state words are.
     * The direction stays the window's, which the dialog's views lay out in.
     */
    private Context dialogContext() {
        Locale locale = textLocale.get();
        if (locale == null) return context;
        Configuration config = new Configuration(context.getResources().getConfiguration());
        int direction = config.screenLayout & Configuration.SCREENLAYOUT_LAYOUTDIR_MASK;
        config.setLocale(locale);
        config.screenLayout = (config.screenLayout & ~Configuration.SCREENLAYOUT_LAYOUTDIR_MASK) | direction;
        // A wrapper, not createConfigurationContext: the dialog's window needs
        // the activity's window manager (its token) that the wrapper hands on.
        ContextThemeWrapper localized = new ContextThemeWrapper(context, dialogTheme());
        localized.applyOverrideConfiguration(config);
        return localized;
    }

    /** The date or time dialog shown, else null. */
    private android.app.Dialog shown;

    /** Shows {@code dialog}, the one shown until it goes. */
    private void present(android.app.Dialog dialog) {
        dialog.setOnDismissListener(d -> {
            if (shown == d) shown = null;
        });
        shown = dialog;
        dialog.show();
    }

    /**
     * Closes the dialog shown, without a pick, as a press outside it does: its window is the activity's, which goes
     * ({@link Mounter#leaveWindows}).
     */
    void closeDialog() {
        android.app.Dialog dialog = shown;
        shown = null;
        if (dialog != null) dialog.dismiss();
    }

    private void pickDate() {
        if (disabled) return;
        DatePickerDialog dialog = new DatePickerDialog(dialogContext(), dialogTheme(), (picker, y, m, d) -> {
            year = y;
            month = m + 1;
            day = d;
            picked();
        }, year, month - 1, day);
        // The bounds' days: a bound's time of day limits the time dialog.
        if (min != null && min.get("year") instanceof Number) {
            dialog.getDatePicker().setMinDate(millis(min, 0, 0));
        }
        if (max != null && max.get("year") instanceof Number) {
            dialog.getDatePicker().setMaxDate(millis(max, 23, 59));
        }
        if (textLocale.get() != null) {
            // The calendar picker formats its header (the picked day, its year) in the
            // process's default language, read when it is made, while its other words
            // come from its context. A configuration change sets the header's language
            // from the configuration: handing the picker the one it was made in (the
            // app's language) formats the header in that, the process's default untouched.
            DatePicker picker = dialog.getDatePicker();
            picker.dispatchConfigurationChanged(picker.getContext().getResources().getConfiguration());
        }
        present(dialog);
    }

    private void pickTime() {
        if (disabled) return;
        present(new TimePickerDialog(dialogContext(), dialogTheme(), (picker, h, m) -> {
            hour = h;
            // The dialog offers every minute: a pick between steps takes the
            // step before it.
            minute = m - m % minuteInterval;
            picked();
        }, hour, minute, DateFormat.is24HourFormat(context)));
    }

    /** The user picked: the value moves into the bounds, shows and is reported. */
    private void picked() {
        clamp();
        show();
        Map<String, Object> fields = new HashMap<>();
        fields.put("year", year);
        fields.put("month", month);
        fields.put("day", day);
        fields.put("hour", hour);
        fields.put("minute", minute);
        events.emit("change", fields);
    }

    /**
     * Keeps the value within {@code min} and {@code max}, as iOS's picker does:
     * the time dialog takes no bounds, and a day at a bound may have a time of
     * day past it.
     */
    private void clamp() {
        long at = key(year, month, day, hour, minute);
        if (min != null && at < bound(min)) take(min);
        else if (max != null && at > bound(max)) take(max);
    }

    /** A bound as a comparable number, its missing fields the value's. */
    private long bound(Map<?, ?> fields) {
        boolean date = fields.get("year") instanceof Number;
        boolean time = fields.get("hour") instanceof Number;
        return key(
                date ? number(fields, "year") : year,
                date ? number(fields, "month") : month,
                date ? number(fields, "day") : day,
                time ? number(fields, "hour") : hour,
                time ? number(fields, "minute") : minute);
    }

    private static long key(int year, int month, int day, int hour, int minute) {
        return ((((long) year * 13 + month) * 32 + day) * 24 + hour) * 60 + minute;
    }

    /** The day of {@code fields} at {@code hour}:{@code minute}, local time, in ms. */
    private static long millis(Map<?, ?> fields, int hour, int minute) {
        Calendar at = Calendar.getInstance();
        at.clear();
        at.set(number(fields, "year"), number(fields, "month") - 1, number(fields, "day"), hour, minute);
        return at.getTimeInMillis();
    }

    /** The colors of the appearance shown: Material 3's surface container and text. */
    private void paint() {
        boolean dark = night.getAsBoolean();
        int fill = color(dark ? 0xff36343b : 0xffe6e0e9,
                dark ? android.R.color.system_neutral1_800 : android.R.color.system_neutral1_100);
        int text = color(dark ? 0xffe6e0e9 : 0xff1d1b20,
                dark ? android.R.color.system_neutral1_100 : android.R.color.system_neutral1_900);
        for (Field field : new Field[] {dateField, timeField}) field.paint(fill, text, dark);
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

    /** The app's appearance changed: the fields follow it. */
    void appearanceChanged() {
        row.appearanceChanged();
    }

    /** The fields side by side. */
    private final class Row extends LinearLayout {
        private boolean wasNight;

        Row(Context context) {
            super(context);
            setOrientation(HORIZONTAL);
            setGravity(Gravity.CENTER_VERTICAL);
            wasNight = night.getAsBoolean();
        }

        @Override
        protected void onConfigurationChanged(Configuration config) {
            super.onConfigurationChanged(config);
            appearanceChanged();
            // A size in sp is resolved when it is set: a font scale changed since takes
            // setting it again, before `show` measures the fields.
            dateField.setTextSize(TypedValue.COMPLEX_UNIT_SP, TEXT_SP);
            timeField.setTextSize(TypedValue.COMPLEX_UNIT_SP, TEXT_SP);
            // The user's formats or clock may have changed with it.
            show();
        }

        void appearanceChanged() {
            boolean now = night.getAsBoolean();
            if (now == wasNight) return;
            wasNight = now;
            paint();
        }
    }

    /** One field: the value in a filled shape, pressed as a button. */
    private final class Field extends TextView {
        private final GradientDrawable shape = new GradientDrawable();

        Field(Context context) {
            super(context);
            setTextSize(TypedValue.COMPLEX_UNIT_SP, TEXT_SP);
            setGravity(Gravity.CENTER);
            setSingleLine();
            setPadding(px(PAD_H_DP), px(PAD_V_DP), px(PAD_H_DP), px(PAD_V_DP));
            shape.setCornerRadius(px(CORNER_DP));
            setBackground(shape);
            setClickable(true);
            setFocusable(true);
        }

        void paint(int fill, int text, boolean dark) {
            shape.setColor(fill);
            setTextColor(text);
            GradientDrawable mask = new GradientDrawable();
            mask.setCornerRadius(px(CORNER_DP));
            mask.setColor(0xffffffff);
            setForeground(new RippleDrawable(
                    ColorStateList.valueOf(dark ? 0x29ffffff : 0x1f000000), null, mask));
        }

        @Override
        public CharSequence getAccessibilityClassName() {
            return Button.class.getName();
        }
    }
}
