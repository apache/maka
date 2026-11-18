package com.longbridge.nsh;

/**
 * The mounted {@code captureKeys} rules of one view, as
 * {@code encode.rs} {@code key_capture} writes them, and the canonical
 * shortcut key of an Android {@code KeyEvent} to match them with.
 *
 * <p>A rule is the same canonical shortcut keystroke the app's shortcuts
 * use ({@code keymap.rs} {@code keystroke}): a printable ASCII character on
 * the key's layout (letters lower case), else the Android key code's US
 * key (39/{@code 'л'} is {@code k}), else a named key, with the exact
 * modifiers. {@code none} captures nothing, {@code all} every key, and
 * {@code keys} the listed ones. State is a flat {@code int[]}: mode, and
 * for {@code keys} the count and each key's id and modifiers.
 * {@code keymap.rs} {@code capture_key} and {@code capture_modifiers} write
 * it; this class is the reader, kept in step by {@code KeyCaptureTest}.
 *
 * <p>A rule never captures a system key ({@code KeyEvent.isSystem()}: Back,
 * Home, volume, media, camera, call, ...), not even {@code all}: the OS
 * keeps those defaults. That is only the consumption decision: the raw
 * {@code onKeyDown} / {@code onKeyUp} observation is unaffected, and the
 * event reports {@code defaultPrevented: false} for them.
 */
final class KeyCaptures {
    static final int NONE = 0;
    static final int ALL = 1;
    static final int KEYS = 2;

    /** Modifier bits, in `keymap.rs` `capture_modifiers` order. */
    static final int CTRL = 1, ALT = 2, SHIFT = 4, CMD = 8;

    /** `keymap.rs` `capture_key`: the negative ids of named keys. */
    static final int ENTER = -1, ESCAPE = -2, TAB = -3, BACKSPACE = -4, DELETE = -5,
            INSERT = -6, UP = -7, DOWN = -8, LEFT = -9, RIGHT = -10, HOME = -11, END = -12,
            PAGE_UP = -13, PAGE_DOWN = -14;
    /** {@code -100 - n}. */
    static final int FUNCTION_BASE = -100;

    private KeyCaptures() {}

    /** Whether {@code policy} captures any key at all. */
    static boolean capturesAnything(int[] policy) {
        if (policy == null || policy.length == 0) return false;
        return policy[0] == ALL || (policy[0] == KEYS && policy.length > 1 && policy[1] > 0);
    }

    /**
     * Whether {@code policy} matches the key {@code key} with
     * {@code modifiers}, the system-key rule aside ({@link #captured}).
     */
    static boolean matches(int[] policy, int key, int modifiers) {
        if (policy == null || policy.length == 0) return false;
        if (policy[0] == ALL) return true;
        if (policy[0] != KEYS || policy.length < 2) return false;
        int count = policy[1];
        for (int i = 0; i < count; i++) {
            int at = 2 + i * 2;
            if (at + 1 >= policy.length) return false;
            if (policy[at] == key && policy[at + 1] == modifiers) return true;
        }
        return false;
    }

    /**
     * Whether {@code policy} consumes the key event: a system key
     * ({@code KeyEvent.isSystem()}: Back, Home, volume, media, camera,
     * call, ...) is never captured, not even by {@code all}, so Android
     * keeps its own default; every other key follows {@link #matches}. The
     * raw notification is a separate decision: a listener still hears the
     * system key ({@code Mounter.keyListens} is unchanged) with
     * {@code defaultPrevented: false}.
     */
    static boolean captured(int[] policy, int key, int modifiers, boolean system) {
        return !system && matches(policy, key, modifiers);
    }

    /** `KeyEvent.META_*_ON`. */
    static final int META_SHIFT_ON = 0x1, META_ALT_ON = 0x2, META_CTRL_ON = 0x1000,
            META_META_ON = 0x10000;

    /** The core's modifiers (`keymap::Modifiers`) for Android's meta state. */
    static int modifiers(int meta) {
        int modifiers = 0;
        if ((meta & META_CTRL_ON) != 0) modifiers |= CTRL;
        if ((meta & META_ALT_ON) != 0) modifiers |= ALT;
        if ((meta & META_SHIFT_ON) != 0) modifiers |= SHIFT;
        if ((meta & META_META_ON) != 0) modifiers |= CMD;
        return modifiers;
    }

    /**
     * The canonical key of key code {@code code} and its unshifted
     * character {@code unicode} ({@code KeyEvent.getUnicodeChar(0)}): a
     * printable ASCII layout character (letters lower case), else the US
     * key of the Android code, else a named key. {@code keymap.rs}
     * {@code keystroke} makes the same choice for the app's shortcuts: a
     * non-ASCII character on a known key keeps that key's US character
     * (39/'л' is `k`), and an unknown code has no shortcut stroke. The raw
     * event still reports the actual Unicode character.
     */
    static int eventKey(int code, int unicode) {
        int us = usKey(code);
        if (us == Integer.MIN_VALUE) return us;
        if (us >= 0 && us != ' ') {
            if (unicode > 0x20 && unicode < 0x7f) {
                return unicode >= 'A' && unicode <= 'Z' ? unicode + ('a' - 'A') : unicode;
            }
            return us;
        }
        return us;
    }

    /** The US-layout character of Android key code {@code code}, or a named key id; `MIN_VALUE` for none. */
    private static int usKey(int code) {
        if (code >= 7 && code <= 16) return (int) '0' + (code - 7);
        if (code >= 29 && code <= 54) return (int) 'a' + (code - 29);
        if (code >= 144 && code <= 153) return (int) '0' + (code - 144);
        switch (code) {
            case 55: return (int) ',';
            case 56: return (int) '.';
            case 61: return TAB;
            case 62: return (int) ' ';
            case 66:
            case 160: return ENTER;
            case 67: return BACKSPACE;
            case 68: return (int) '`';
            case 69: return (int) '-';
            case 70: return (int) '=';
            case 71: return (int) '[';
            case 72: return (int) ']';
            case 73: return (int) '\\';
            case 74: return (int) ';';
            case 75: return (int) '\'';
            case 76: return (int) '/';
            case 92: return PAGE_UP;
            case 93: return PAGE_DOWN;
            case 111: return ESCAPE;
            case 112: return DELETE;
            case 122: return HOME;
            case 123: return END;
            case 124: return INSERT;
            case 19: return UP;
            case 20: return DOWN;
            case 21: return LEFT;
            case 22: return RIGHT;
            case 131: return FUNCTION_BASE - 1;
            case 132: return FUNCTION_BASE - 2;
            case 133: return FUNCTION_BASE - 3;
            case 134: return FUNCTION_BASE - 4;
            case 135: return FUNCTION_BASE - 5;
            case 136: return FUNCTION_BASE - 6;
            case 137: return FUNCTION_BASE - 7;
            case 138: return FUNCTION_BASE - 8;
            case 139: return FUNCTION_BASE - 9;
            case 140: return FUNCTION_BASE - 10;
            case 141: return FUNCTION_BASE - 11;
            case 142: return FUNCTION_BASE - 12;
            default: return Integer.MIN_VALUE;
        }
    }
}
