package com.longbridge.nsh;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.text.SpannableString;
import android.text.style.ForegroundColorSpan;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

/** System UI driven from JS: the status bar, alerts and action sheets. */
final class SystemUi {
    private SystemUi() {}

    static Activity activity(Context context) {
        while (context instanceof ContextWrapper) {
            if (context instanceof Activity) return (Activity) context;
            context = ((ContextWrapper) context).getBaseContext();
        }
        return null;
    }

    /**
     * The status bar of the activity's window. style: 0 default (follows
     * the appearance: {@code night}, the app's or the system's), 1 light
     * content, 2 dark content.
     */
    static void statusBar(Context context, int style, boolean hidden, boolean night) {
        Activity activity = activity(context);
        if (activity == null) return;
        statusBar(activity.getWindow(), style, hidden, night);
    }

    /**
     * The status bar while {@code window} is on top: the activity's, or an
     * open dialog's own window (which the bar follows while it is up).
     */
    @SuppressWarnings("deprecation")
    static void statusBar(Window window, int style, boolean hidden, boolean night) {
        if (window == null) return;
        boolean darkIcons = style == 2 || (style == 0 && !night);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = window.getInsetsController();
            if (c == null) return;
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
            c.setSystemBarsAppearance(darkIcons ? light : 0, light);
            if (hidden) {
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsets.Type.statusBars());
            } else {
                c.show(WindowInsets.Type.statusBars());
            }
        } else {
            View decor = window.getDecorView();
            int flags = decor.getSystemUiVisibility();
            flags = darkIcons ? flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            flags = hidden ? flags | View.SYSTEM_UI_FLAG_FULLSCREEN : flags & ~View.SYSTEM_UI_FLAG_FULLSCREEN;
            decor.setSystemUiVisibility(flags);
        }
    }

    /**
     * An alert, or with {@code sheet} a list of actions. Answers with
     * {@link Native#DIALOG}: the button index, or -1 when dismissed.
     * Alerts map buttons as React Native does: the last is positive, the
     * one before negative, the one before that neutral (three at most).
     * styles: 0 default, 1 cancel, 2 destructive. Drawn in the app's colors
     * ({@link Mounter#dialogColors}) where it has them. An alert with
     * {@code input} has a text field starting with it, its text answered as
     * {@code value}: the IME's action presses the last default button, and
     * while a {@code required} field is empty only cancel buttons are enabled.
     */
    static void dialog(Mounter mounter, int dialogId, String title, String message, boolean cancelable, boolean sheet,
            String[] texts, int[] styles, String input, String placeholder, boolean selectAll, boolean required) {
        Activity activity = activity(mounter.context);
        if (activity == null || activity.isFinishing()) {
            answer(mounter, dialogId, -1, null);
            return;
        }
        boolean[] answered = {false};
        // In the appearance shown (the app's own, else the system's).
        AlertDialog.Builder b = new AlertDialog.Builder(activity, mounter.night()
                ? android.R.style.Theme_DeviceDefault_Dialog_Alert
                : android.R.style.Theme_DeviceDefault_Light_Dialog_Alert);
        int[] colors = mounter.dialogColors;
        int at = mounter.night() ? 1 : 0;
        int surface = colors[at], titleColor = colors[2 + at], messageColor = colors[4 + at];
        int buttonColor = colors[6 + at], destructive = colors[8 + at];
        if (title != null && !title.isEmpty()) b.setTitle(colored(title, titleColor));
        b.setCancelable(cancelable);
        final android.widget.EditText field = sheet || input == null
                ? null
                : textField(b, activity, input, placeholder, selectAll, titleColor, messageColor);
        if (sheet) {
            // The cancel option is the dismissal (a tap outside / back).
            int count = 0;
            for (int s : styles) if (s != 1) count++;
            CharSequence[] items = new CharSequence[count];
            int[] indices = new int[count];
            for (int i = 0, j = 0; i < texts.length; i++) {
                if (styles[i] == 1) continue;
                items[j] = colored(texts[i], styles[i] == 2 && destructive != 0 ? destructive : titleColor);
                indices[j++] = i;
            }
            // A list dialog shows no message.
            if ((title == null || title.isEmpty()) && message != null) b.setTitle(colored(message, titleColor));
            b.setItems(items, (d, which) -> {
                answered[0] = true;
                answer(mounter, dialogId, indices[which], null);
            });
            b.setCancelable(true);
        } else {
            if (message != null) b.setMessage(colored(message, messageColor));
            int n = texts.length;
            if (n >= 1) {
                b.setPositiveButton(texts[n - 1], (d, w) -> {
                    answered[0] = true;
                    answer(mounter, dialogId, n - 1, field);
                });
            }
            if (n >= 2) {
                b.setNegativeButton(texts[n - 2], (d, w) -> {
                    answered[0] = true;
                    answer(mounter, dialogId, n - 2, field);
                });
            }
            if (n >= 3) {
                b.setNeutralButton(texts[n - 3], (d, w) -> {
                    answered[0] = true;
                    answer(mounter, dialogId, n - 3, field);
                });
            }
        }
        b.setOnDismissListener(d -> {
            if (TestAgent.shownDialog == d) TestAgent.shownDialog = null;
            if (mounter.dialogs.get(dialogId) == d) mounter.dialogs.remove(dialogId);
            if (!answered[0]) {
                answered[0] = true;
                answer(mounter, dialogId, -1, field);
            }
        });
        AlertDialog shown = b.create();
        if (field != null && shown.getWindow() != null) {
            // The field has the focus as it shows: bring the keyboard up with it.
            shown.getWindow().setSoftInputMode(
                    android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        }
        shown.show();
        TestAgent.shownDialog = shown;
        mounter.dialogs.put(dialogId, shown);
        if (surface != 0 && shown.getWindow() != null) {
            // The theme's shape (corners, insets), filled with the app's color.
            Drawable background = shown.getWindow().getDecorView().getBackground();
            if (background != null) background.mutate().setTint(surface);
        }
        if (!sheet) {
            // Positive is the last button, negative the one before, neutral the one before that.
            int[] which = {AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL};
            for (int k = 0; k < Math.min(texts.length, 3); k++) {
                android.widget.Button button = shown.getButton(which[k]);
                int color = styles[texts.length - 1 - k] == 2 && destructive != 0 ? destructive : buttonColor;
                if (button != null && color != 0) button.setTextColor(color);
            }
        }
        if (field != null) followTextField(shown, field, styles, required);
    }

    /**
     * The text field of an alert ({@link #dialog}), set as {@code b}'s view with the theme's dialog padding, its
     * text {@code input} and its caret after it unless {@code selectAll}.
     */
    private static android.widget.EditText textField(AlertDialog.Builder b, Activity activity, String input,
            String placeholder, boolean selectAll, int textColor, int hintColor) {
        android.content.Context context = b.getContext();
        android.widget.EditText field = new android.widget.EditText(context);
        field.setSingleLine(true);
        field.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        field.setText(input);
        if (placeholder != null) field.setHint(placeholder);
        if (textColor != 0) field.setTextColor(textColor);
        if (hintColor != 0) field.setHintTextColor(hintColor);
        field.setSelectAllOnFocus(selectAll);
        if (!selectAll) field.setSelection(input.length());
        // The theme's inset of the dialog's content (?android:dialogPreferredPadding).
        android.util.TypedValue inset = new android.util.TypedValue();
        int side = context.getTheme().resolveAttribute(android.R.attr.dialogPreferredPadding, inset, true)
                ? android.util.TypedValue.complexToDimensionPixelSize(inset.data,
                        activity.getResources().getDisplayMetrics())
                : 0;
        android.widget.FrameLayout box = new android.widget.FrameLayout(context);
        box.setPadding(side, 0, side, 0);
        box.addView(field, new android.widget.FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT));
        b.setView(box);
        field.requestFocus();
        return field;
    }

    /**
     * Wires the text field of the alert {@code shown}: the IME's action presses its last default button (the
     * alert's default action) while enabled; a {@code required} field enables only the cancel buttons while empty.
     */
    private static void followTextField(AlertDialog shown, android.widget.EditText field, int[] styles,
            boolean required) {
        int n = styles.length;
        // The button of index n - 1 - k is which[k] (see dialog).
        int[] which = {AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL};
        // The k of the last default button (BUTTON_* are negative: no sentinel among them).
        int preferred = -1;
        for (int k = 0; k < Math.min(n, 3) && preferred < 0; k++) if (styles[n - 1 - k] == 0) preferred = k;
        final int submit = preferred;
        field.setOnEditorActionListener((v, action, event) -> {
            boolean enter = action == android.view.inputmethod.EditorInfo.IME_ACTION_DONE
                    || (event != null && event.getKeyCode() == android.view.KeyEvent.KEYCODE_ENTER
                            && event.getAction() == android.view.KeyEvent.ACTION_DOWN);
            if (!enter) return false;
            android.widget.Button button = submit >= 0 ? shown.getButton(which[submit]) : null;
            if (button != null && button.isEnabled()) button.performClick();
            return true;
        });
        if (!required) return;
        Runnable enable = () -> {
            boolean empty = field.getText().length() == 0;
            for (int k = 0; k < Math.min(n, 3); k++) {
                android.widget.Button button = shown.getButton(which[k]);
                if (button == null) continue;
                boolean enabled = !empty || styles[n - 1 - k] == 1;
                button.setEnabled(enabled);
                // The app's button color is a plain color, without the theme's disabled state.
                button.setAlpha(enabled ? 1f : 0.38f);
            }
        };
        enable.run();
        field.addTextChangedListener(new android.text.TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {}

            @Override
            public void afterTextChanged(android.text.Editable s) {
                enable.run();
            }
        });
    }

    /**
     * Takes back the alert {@link #dialog} showed as {@code dialogId}: the core answered it already, so the
     * dismissal it reports goes unheard.
     */
    static void closeDialog(Mounter mounter, int dialogId) {
        AlertDialog shown = mounter.dialogs.get(dialogId);
        if (shown == null) return;
        mounter.dialogs.remove(dialogId);
        shown.dismiss();
    }

    /** {@code text} in {@code color} (0: the theme's). */
    private static CharSequence colored(String text, int color) {
        if (color == 0) return text;
        SpannableString s = new SpannableString(text);
        s.setSpan(new ForegroundColorSpan(color), 0, s.length(), 0);
        return s;
    }

    /** Answers dialog {@code dialogId} with button {@code index} (-1: none) and the text of its {@code field}. */
    private static void answer(Mounter mounter, int dialogId, int index, android.widget.EditText field) {
        if (field == null) {
            mounter.eventMap(1, Native.DIALOG, new String[] {"id", "index"},
                    new Object[] {(double) dialogId, (double) index});
            return;
        }
        mounter.eventMap(1, Native.DIALOG, new String[] {"id", "index", "value"},
                new Object[] {(double) dialogId, (double) index, field.getText().toString()});
    }

    /**
     * {@code openUrl}: opens {@code url} with the app Android resolves for it ({@code Intent.ACTION_VIEW}), from the
     * view's activity (a new task from any other context). Whether an app took it: false when none handles the scheme.
     */
    static boolean openUrl(Context context, String url) {
        android.content.Intent intent = new android.content.Intent(
                android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
        Activity activity = activity(context);
        if (activity == null) intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            (activity != null ? activity : context).startActivity(intent);
            return true;
        } catch (android.content.ActivityNotFoundException | SecurityException e) {
            return false;
        }
    }

    /**
     * {@code AppSettings.open}: opens the app's page in the system's settings (App info,
     * {@code Settings.ACTION_APPLICATION_DETAILS_SETTINGS} for {@code package:<the app's package>}), where the user
     * turns back on a permission they denied. From the view's activity, as {@link #openUrl} opens a URL (a new task
     * from any other context, as the system needs). Whether the system opened it.
     */
    static boolean openAppSettings(Context context) {
        android.content.Intent intent = new android.content.Intent(
                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                android.net.Uri.fromParts("package", context.getPackageName(), null));
        Activity activity = activity(context);
        if (activity == null) intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            (activity != null ? activity : context).startActivity(intent);
            return true;
        } catch (android.content.ActivityNotFoundException | SecurityException e) {
            return false;
        }
    }

    /**
     * {@code openPath}: opens the file at {@code path} with the app Android resolves for it, as a
     * {@code content:} URI the app's {@link FilesProvider} serves (a {@code file:} URI would not
     * leave the app). Whether an app took it: false when there is no regular file, the provider
     * will not serve it, or none handles it.
     */
    static boolean openPath(Context context, String path) {
        java.io.File file = new java.io.File(path);
        android.net.Uri uri = FilesProvider.uriFor(context, file);
        // Share the provider's root check with URI creation: a file the
        // provider would refuse must fail here, not after the viewer has
        // already been launched (the caller could not handle that failure).
        if (uri == null || !file.isFile()) return false;
        android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
        intent.setDataAndType(uri, FilesProvider.typeOf(context, file));
        intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Activity activity = activity(context);
        if (activity == null) intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            (activity != null ? activity : context).startActivity(intent);
            return true;
        } catch (android.content.ActivityNotFoundException | SecurityException e) {
            return false;
        }
    }

    /** {@code Clipboard.writeText}: a plain text clip. */
    static void setClipboard(Context context, String text) {
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) clipboard.setPrimaryClip(android.content.ClipData.newPlainText(null, text));
    }

    /** {@code Clipboard.write}: a clip of text with its HTML, which apps that read formatting paste. */
    static void setClipboardHtml(Context context, String text, String html) {
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) clipboard.setPrimaryClip(android.content.ClipData.newHtmlText(null, text, html));
    }

    /**
     * {@code Clipboard.readText} / {@code hasText}: the clip's text, null when it holds none;
     * with {@code hasOnly} "" for text, without reading the clip (its description says).
     * Android 10+ only lets the focused app read it: null otherwise.
     */
    static String readClipboard(Context context, boolean hasOnly) {
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null || !clipboard.hasPrimaryClip()) return null;
        if (hasOnly) {
            android.content.ClipDescription d = clipboard.getPrimaryClipDescription();
            boolean text = d != null
                    && (d.hasMimeType(android.content.ClipDescription.MIMETYPE_TEXT_PLAIN)
                            || d.hasMimeType(android.content.ClipDescription.MIMETYPE_TEXT_HTML));
            return text ? "" : null;
        }
        android.content.ClipData clip = clipboard.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return null;
        CharSequence text = clip.getItemAt(0).coerceToText(context);
        return text != null && text.length() > 0 ? text.toString() : null;
    }
}
