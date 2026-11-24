package com.longbridge.nsh;

import java.lang.reflect.Array;
import java.util.Map;

/**
 * Which intents of the app's activity {@link Notifications} hands to the handler of the notifications NSH did not
 * show ({@code notifications.rs}), and their extras as JSON. Plain JDK, no Android APIs, so its test runs without a
 * device ({@code tests/java/com/longbridge/nsh/ForeignIntentsTest.java}).
 *
 * <p>Android has no record of which notification opened an activity: a push service's SDK, or other code of the app,
 * shows a notification whose press opens the app's launch activity (or the SDK's own activity, which opens it) with the
 * payload as extras. So a press is an intent with extras that no other meaning claims: see {@link #isPress}.
 */
final class ForeignIntents {
    /** {@code Intent.ACTION_MAIN}: the launch intent, which presses open with extras. */
    static final String ACTION_MAIN = "android.intent.action.MAIN";
    /** {@code Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY}: the user opened the task again from Recents. */
    static final int FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY = 0x00100000;

    private ForeignIntents() {}

    /**
     * Whether an intent with {@code action}, {@code flags} and extras named {@code keys} may be a press of a
     * notification NSH did not show:
     *
     * <ul>
     *   <li>It is not the one Recents opens the task with again, which repeats the intent the task started with.
     *   <li>Its action is none (an intent naming the activity), {@code ACTION_MAIN} (the launch intent) or the app's
     *       or an SDK's own; the system's other actions mean something else ({@code ACTION_VIEW} is a link, which
     *       {@code NshView.handleUrlSchemeIntent} hands to the app, {@code ACTION_SEND} a share).
     *   <li>It carries extras other than NSH's own ({@link #own}): a plain launch has none.
     * </ul>
     */
    static boolean isPress(String action, int flags, Iterable<String> keys) {
        if ((flags & FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false;
        if (action != null && !action.equals(ACTION_MAIN) && action.startsWith("android.")) return false;
        if (keys == null) return false;
        for (String key : keys) {
            if (key != null && !own(key)) return true;
        }
        return false;
    }

    /**
     * Whether {@code key} is an extra of NSH's own, which is not a notification's: its own presses' and the
     * development tools' ({@code nsh.env.*} of {@code nsh run}).
     */
    static boolean own(String key) {
        return key.startsWith("com.longbridge.nsh.") || key.startsWith("nsh.");
    }

    /**
     * {@code value} as JSON: strings and characters, numbers, booleans, arrays, lists and maps (a {@code Bundle} the
     * caller made one of, with string keys; other keys are left out) keep their values. Other values (byte arrays,
     * which are data, parcelables, non-finite numbers) are {@code null}, so one such value does not lose the rest.
     */
    static String json(Object value) {
        StringBuilder out = new StringBuilder();
        write(out, value);
        return out.toString();
    }

    private static void write(StringBuilder out, Object value) {
        if (value instanceof CharSequence || value instanceof Character) {
            string(out, value.toString());
        } else if (value instanceof Boolean) {
            out.append(value);
        } else if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long) {
            out.append(((Number) value).longValue());
        } else if (value instanceof Float || value instanceof Double) {
            double d = ((Number) value).doubleValue();
            // Float's own digits: 0.1f is 0.1, not the double nearest it.
            if (Double.isNaN(d) || Double.isInfinite(d)) out.append("null");
            else out.append(value);
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!(entry.getKey() instanceof String)) continue;
                if (!first) out.append(',');
                first = false;
                string(out, (String) entry.getKey());
                out.append(':');
                write(out, entry.getValue());
            }
            out.append('}');
        } else if (value instanceof Iterable) {
            out.append('[');
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) out.append(',');
                first = false;
                write(out, item);
            }
            out.append(']');
        } else if (value instanceof char[]) {
            string(out, new String((char[]) value));
        } else if (value != null && value.getClass().isArray() && !(value instanceof byte[])) {
            out.append('[');
            for (int i = 0, n = Array.getLength(value); i < n; i++) {
                if (i > 0) out.append(',');
                write(out, Array.get(value, i));
            }
            out.append(']');
        } else {
            out.append("null");
        }
    }

    private static void string(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        out.append('"');
    }
}
