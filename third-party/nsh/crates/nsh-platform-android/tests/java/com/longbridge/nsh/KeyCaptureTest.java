package com.longbridge.nsh;

/**
 * Coverage for the mounted {@code captureKeys} reader and the canonical
 * shortcut key of an Android key event. Plain JDK, no Android APIs, so it
 * runs on a developer machine or in CI without a device:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/KeyCaptures.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/KeyCaptureTest.java
 * java -cp target/java-tests com.longbridge.nsh.KeyCaptureTest
 * </pre>
 *
 * The policy arrays are what {@code encode.rs} {@code key_capture} writes:
 * {@code [mode]} or {@code [Keys, count, key, modifiers, ...]}. A system
 * key (`KeyEvent.isSystem()`) is declined by every rule, even `all`, while
 * the raw notification path stays distinct.
 */
public final class KeyCaptureTest {
    public static void main(String[] args) {
        // `KeyEvent.META_*_ON`.
        int shift = 0x1, alt = 0x2, ctrl = 0x1000, meta = 0x10000;

        check("none captures nothing", !KeyCaptures.capturesAnything(policyNone()));
        check("all captures any key", KeyCaptures.matches(policyAll(), 'a', 0));
        check("all captures an unnamed key", KeyCaptures.matches(policyAll(), Integer.MIN_VALUE, 0));

        // A system key (`KeyEvent.isSystem`: Back and volume have no
        // capture id, so they reach a rule as MIN_VALUE) is declined by
        // every rule, even all. The raw observation path is separate:
        // `capturesAnything` still asks for the event.
        check("all declines an unnamed system key",
                !KeyCaptures.captured(policyAll(), Integer.MIN_VALUE, 0, true));
        check("all declines a named system key",
                !KeyCaptures.captured(policyAll(), KeyCaptures.ENTER, KeyCaptures.CTRL, true));
        check("the raw path still asks for a system key",
                KeyCaptures.capturesAnything(policyAll()));
        check("a listed key is still declined when the event is a system key",
                !KeyCaptures.captured(policy(KeyCaptures.KEYS, 1, 'a', 0), 'a', 0, true));
        check("a non-system key still follows all",
                KeyCaptures.captured(policyAll(), 'a', 0, false));
        check("a listed non-system key still matches",
                KeyCaptures.captured(policy(KeyCaptures.KEYS, 1, 'a', 0), 'a', 0, false));
        check("keys with no entries is none",
                !KeyCaptures.capturesAnything(policy(KeyCaptures.KEYS, 0)));
        check("an empty keys rule captures nothing",
                !KeyCaptures.matches(policy(KeyCaptures.KEYS, 0), 'a', 0));

        // The encoder's key ids for `a`, Shift+Left and F5.
        int[] rule = policy(KeyCaptures.KEYS, 3,
                'a', 0,
                KeyCaptures.LEFT, KeyCaptures.SHIFT,
                KeyCaptures.FUNCTION_BASE - 5, KeyCaptures.CTRL);
        check("a character matches without modifiers", KeyCaptures.matches(rule, 'a', 0));
        check("the same character needs the named modifiers",
                !KeyCaptures.matches(rule, 'a', KeyCaptures.SHIFT));
        check("a named key matches its exact modifiers",
                KeyCaptures.matches(rule, KeyCaptures.LEFT, KeyCaptures.SHIFT));
        check("a key with other modifiers does not",
                !KeyCaptures.matches(rule, KeyCaptures.LEFT, 0));
        check("a function key matches", KeyCaptures.matches(rule, KeyCaptures.FUNCTION_BASE - 5,
                KeyCaptures.CTRL));

        // The canonical shortcut key of an Android event: the layout's
        // unshifted ASCII character, else the key's US character; the raw
        // event keeps the actual Unicode separately.
        check("a plain letter", KeyCaptures.eventKey(29, 'a') == 'a');
        check("AZERTY's a on Q's key", KeyCaptures.eventKey(45, 'a') == 'a');
        check("a capital letter is canonical lower case",
                KeyCaptures.eventKey(29, 'A') == 'a');
        check("a non-US letter keeps its key's US character",
                KeyCaptures.eventKey(39, 'л') == 'k');
        check("a capital non-US letter too", KeyCaptures.eventKey(39, 'Л') == 'k');
        check("a non-US punctuation key too", KeyCaptures.eventKey(76, '÷') == '/');
        check("a shifted punctuation key is its unshifted character",
                KeyCaptures.eventKey(76, '/') == '/');
        check("space", KeyCaptures.eventKey(62, ' ') == ' ');
        check("Enter", KeyCaptures.eventKey(66, '\n') == KeyCaptures.ENTER);
        check("the keypad's Enter", KeyCaptures.eventKey(160, '\n') == KeyCaptures.ENTER);
        check("arrow left", KeyCaptures.eventKey(21, 0) == KeyCaptures.LEFT);
        check("Tab", KeyCaptures.eventKey(61, 0) == KeyCaptures.TAB);
        check("F5", KeyCaptures.eventKey(135, 0) == KeyCaptures.FUNCTION_BASE - 5);
        check("an unknown key is no capture id",
                KeyCaptures.eventKey(1000, 0) == Integer.MIN_VALUE);
        check("an unknown key stays no capture id with a printable character",
                KeyCaptures.eventKey(1000, 'x') == Integer.MIN_VALUE);
        check("a non-US key matches its US shortcut key",
                KeyCaptures.matches(policy(KeyCaptures.KEYS, 1, 'k', 0),
                        KeyCaptures.eventKey(39, 'л'), 0));

        check("modifiers use the core's wire names",
                KeyCaptures.modifiers(shift | alt | ctrl | meta) == 0b1111);
        check("caps lock is no modifier",
                KeyCaptures.modifiers(shift | 0x100000) == KeyCaptures.SHIFT);

        System.out.println("KeyCaptureTest: ok");
    }

    private static int[] policyNone() {
        return policy(KeyCaptures.NONE);
    }

    private static int[] policyAll() {
        return policy(KeyCaptures.ALL);
    }

    private static int[] policy(int mode) {
        return new int[] {mode};
    }

    private static int[] policy(int mode, int count, int... keys) {
        if (mode != KeyCaptures.KEYS) return policy(mode);
        int[] policy = new int[2 + count * 2];
        policy[0] = mode;
        policy[1] = count;
        for (int i = 0; i < count * 2; i++) policy[2 + i] = keys[i];
        return policy;
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
