package com.longbridge.nsh;

/**
 * Coverage for a `ref.focus()` waiting for its view to be shown
 * (`PendingFocus`). Plain JDK, no Android APIs:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/PendingFocus.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/PendingFocusTest.java
 * java -cp target/java-tests com.longbridge.nsh.PendingFocusTest
 * </pre>
 */
public final class PendingFocusTest {
    public static void main(String[] args) {
        PendingFocus p = new PendingFocus();
        check("nothing pends at first", p.id() == 0 && p.retry(true, 0) == PendingFocus.NONE);

        // A page in its push: the request waits, then focuses once shown.
        p.start(4, 1000);
        check("a hidden view waits", p.retry(false, 1016) == PendingFocus.WAIT && p.id() == 4);
        check("a shown view is focused", p.retry(true, 1300) == PendingFocus.FOCUS);
        check("focusing ends the request", p.id() == 0 && p.retry(true, 1316) == PendingFocus.NONE);

        // The latest request wins.
        p.start(4, 0);
        p.start(6, 10);
        check("a newer request replaces the older one", p.id() == 6);
        check("and is the one focused", p.retry(true, 20) == PendingFocus.FOCUS);

        // Bounded: a view never shown gives the request up.
        p.start(8, 0);
        check("waits just before the bound", p.retry(false, PendingFocus.TIMEOUT_MS - 1) == PendingFocus.WAIT);
        check("expires at the bound", p.retry(false, PendingFocus.TIMEOUT_MS) == PendingFocus.EXPIRED);
        check("expiring ends the request", p.id() == 0);
        p.start(8, 0);
        check("shown at the bound still focuses", p.retry(true, PendingFocus.TIMEOUT_MS + 5) == PendingFocus.FOCUS);

        // Cleared by a removal, a focus elsewhere or a blur.
        p.start(10, 0);
        check("clear reports the view it was for", p.clear() == 10 && p.id() == 0);
        check("clear with nothing pending reports none", p.clear() == 0);

        check("a blur of the view ends it", PendingFocus.blurs(10, 10, false));
        check("a blur of a view holding it ends it", PendingFocus.blurs(3, 10, true));
        check("Keyboard.dismiss() ends it", PendingFocus.blurs(1, 10, false));
        check("a blur of another view keeps it", !PendingFocus.blurs(12, 10, false));
        check("a blur with nothing pending ends nothing", !PendingFocus.blurs(1, 0, false));
        System.out.println("PendingFocusTest: ok");
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
