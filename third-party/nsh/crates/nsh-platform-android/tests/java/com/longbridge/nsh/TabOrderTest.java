package com.longbridge.nsh;

/**
 * Coverage for Tab / Shift+Tab order: the first and last stop yield to the
 * embedding Android host instead of wrapping. Plain JDK, no Android APIs:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/TabOrder.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/TabOrderTest.java
 * java -cp target/java-tests com.longbridge.nsh.TabOrderTest
 * </pre>
 */
public final class TabOrderTest {
    public static void main(String[] args) {
        // Forward traversal advances and the last stop yields.
        check("forward from no focus starts at the first stop", TabOrder.next(-1, 3, true) == 0);
        check("forward advances one stop", TabOrder.next(0, 3, true) == 1);
        check("forward advances to the last stop", TabOrder.next(1, 3, true) == 2);
        check("forward from the last stop yields", TabOrder.next(2, 3, true) == -1);

        // Backward traversal goes back and the first stop yields.
        check("backward from no focus starts at the last stop", TabOrder.next(-1, 3, false) == 2);
        check("backward goes back one stop", TabOrder.next(2, 3, false) == 1);
        check("backward goes to the first stop", TabOrder.next(1, 3, false) == 0);
        check("backward from the first stop yields", TabOrder.next(0, 3, false) == -1);

        // One stop cannot move in either direction: both yield rather than
        // consume Tab by focusing the same stop.
        check("a single stop yields forward", TabOrder.next(0, 1, true) == -1);
        check("a single stop yields backward", TabOrder.next(0, 1, false) == -1);
        check("a single stop is the start backward", TabOrder.next(-1, 1, false) == 0);
        check("no stops yield forward", TabOrder.next(-1, 0, true) == -1);
        check("no stops yield backward", TabOrder.next(-1, 0, false) == -1);
        System.out.println("TabOrderTest: ok");
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
