package com.longbridge.nsh;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.ContextWrapper;
import android.os.Build;
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
     * styles: 0 default, 1 cancel, 2 destructive.
     */
    static void dialog(Mounter mounter, int dialogId, String title, String message, boolean cancelable, boolean sheet,
            String[] texts, int[] styles) {
        Activity activity = activity(mounter.context);
        if (activity == null || activity.isFinishing()) {
            answer(mounter, dialogId, -1);
            return;
        }
        boolean[] answered = {false};
        // In the appearance shown (the app's own, else the system's).
        AlertDialog.Builder b = new AlertDialog.Builder(activity, mounter.night()
                ? android.R.style.Theme_DeviceDefault_Dialog_Alert
                : android.R.style.Theme_DeviceDefault_Light_Dialog_Alert);
        if (title != null && !title.isEmpty()) b.setTitle(title);
        b.setCancelable(cancelable);
        if (sheet) {
            // The cancel option is the dismissal (a tap outside / back).
            int count = 0;
            for (int s : styles) if (s != 1) count++;
            CharSequence[] items = new CharSequence[count];
            int[] indices = new int[count];
            for (int i = 0, j = 0; i < texts.length; i++) {
                if (styles[i] == 1) continue;
                items[j] = texts[i];
                indices[j++] = i;
            }
            // A list dialog shows no message.
            if ((title == null || title.isEmpty()) && message != null) b.setTitle(message);
            b.setItems(items, (d, which) -> {
                answered[0] = true;
                answer(mounter, dialogId, indices[which]);
            });
            b.setCancelable(true);
        } else {
            if (message != null) b.setMessage(message);
            int n = texts.length;
            if (n >= 1) {
                b.setPositiveButton(texts[n - 1], (d, w) -> {
                    answered[0] = true;
                    answer(mounter, dialogId, n - 1);
                });
            }
            if (n >= 2) {
                b.setNegativeButton(texts[n - 2], (d, w) -> {
                    answered[0] = true;
                    answer(mounter, dialogId, n - 2);
                });
            }
            if (n >= 3) {
                b.setNeutralButton(texts[n - 3], (d, w) -> {
                    answered[0] = true;
                    answer(mounter, dialogId, n - 3);
                });
            }
        }
        b.setOnDismissListener(d -> {
            if (TestAgent.shownDialog == d) TestAgent.shownDialog = null;
            if (!answered[0]) {
                answered[0] = true;
                answer(mounter, dialogId, -1);
            }
        });
        TestAgent.shownDialog = b.show();
    }

    private static void answer(Mounter mounter, int dialogId, int index) {
        mounter.eventMap(1, Native.DIALOG, new String[] {"id", "index"},
                new Object[] {(double) dialogId, (double) index});
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

    /** {@code Clipboard.writeText}: a plain text clip. */
    static void setClipboard(Context context, String text) {
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) clipboard.setPrimaryClip(android.content.ClipData.newPlainText(null, text));
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
