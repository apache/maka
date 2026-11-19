package com.longbridge.nsh;

/**
 * Coverage for keyboard ancestry precedence: a portaled view's
 * {@code key_parent} override must beat the native Insert parent, so an
 * Overlay inserted at the root still reaches its real logical ancestors.
 * Plain JDK:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/KeyAncestry.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/KeyAncestryTest.java
 * java -cp target/java-tests com.longbridge.nsh.KeyAncestryTest
 * </pre>
 */
public final class KeyAncestryTest {
    public static void main(String[] args) {
        check("a portal's override wins over its Insert parent",
                KeyAncestry.parent(7, -1, 1) == 7);
        check("an override wins over a hosted parent too",
                KeyAncestry.parent(7, 3, 1) == 7);
        check("without an override a hosted parent wins",
                KeyAncestry.parent(-1, 3, 1) == 3);
        check("an ordinary view uses its Insert parent",
                KeyAncestry.parent(-1, -1, 2) == 2);
        check("no parent is none", KeyAncestry.parent(-1, -1, -1) == -1);
        // Two overlays inserted under the same root reach different logical
        // ancestors, so an unrelated sibling portal is not captured.
        int first = KeyAncestry.parent(4, -1, 1);
        int second = KeyAncestry.parent(5, -1, 1);
        check("sibling portals keep distinct logical ancestors", first != second);
        System.out.println("KeyAncestryTest: ok");
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
