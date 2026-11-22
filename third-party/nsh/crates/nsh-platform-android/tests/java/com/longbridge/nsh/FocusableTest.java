package com.longbridge.nsh;

/**
 * Coverage for the `focusable` stop/pointer/touch-mode rules. Plain JDK,
 * no Android APIs:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/Focusable.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/FocusableTest.java
 * java -cp target/java-tests com.longbridge.nsh.FocusableTest
 * </pre>
 */
public final class FocusableTest {
    public static void main(String[] args) {
        check("unset leaves a pressable a stop", Focusable.stop(-1, true, true));
        check("unset leaves a view taking no presses out", !Focusable.stop(-1, false, true));
        check("true makes any enabled view a stop", Focusable.stop(1, false, true));
        check("false keeps a pressable out", !Focusable.stop(0, true, true));
        check("a disabled view is never a stop", !Focusable.stop(1, true, false));
        check("a disabled pressable is not a stop", !Focusable.stop(-1, true, false));

        // Only an explicit focusable is focusable in touch mode; a default
        // pressable keeps a hardware/Tab focus stop without opting in.
        check("an explicit focusable opts into touch-mode focus", Focusable.touch(1));
        check("a default pressable does not", !Focusable.touch(-1));
        check("a non-focusable view does not", !Focusable.touch(0));

        check("only an explicit focusable takes a pointer press from a native child",
                Focusable.pointer(1, true, true));
        check("an explicit focusable takes a pointer press in touch mode",
                Focusable.pointer(1, false, true));
        check("a default press takes it outside touch mode when no native child has the focus",
                Focusable.pointer(-1, false, false));
        check("a default press never requests touch-mode focus",
                !Focusable.pointer(-1, false, true));
        check("a default press leaves it to a native child",
                !Focusable.pointer(-1, true, false));
        check("a default press leaves it to a native child in touch mode too",
                !Focusable.pointer(-1, true, true));
        check("false never takes it", !Focusable.pointer(0, false, false));
        System.out.println("FocusableTest: ok");
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
