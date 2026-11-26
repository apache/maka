package com.longbridge.nsh;

/**
 * Coverage for a touch outside a system menu: a tap closes it on its
 * release, a touch the system takes (a back swipe) leaves it open. Plain
 * JDK, no Android APIs:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/MenuOutsideTouch.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/MenuOutsideTouchTest.java
 * java -cp target/java-tests com.longbridge.nsh.MenuOutsideTouchTest
 * </pre>
 */
public final class MenuOutsideTouchTest {
    private static final int MOVE = 2, POINTER_DOWN = 5;

    public static void main(String[] args) {
        // A tap outside closes the menu when it lifts, not when it lands.
        MenuOutsideTouch touch = new MenuOutsideTouch();
        check("an outside press is taken, the menu stays",
                touch.on(MenuOutsideTouch.ACTION_DOWN, true) == MenuOutsideTouch.TAKE);
        check("its moves are taken", touch.on(MOVE, true) == MenuOutsideTouch.TAKE);
        check("its release closes the menu", touch.on(MenuOutsideTouch.ACTION_UP, true) == MenuOutsideTouch.DISMISS);

        // A release over the menu still ends a touch that started outside.
        touch = new MenuOutsideTouch();
        touch.on(MenuOutsideTouch.ACTION_DOWN, true);
        check("a press outside moved over the menu is still taken", touch.on(MOVE, false) == MenuOutsideTouch.TAKE);
        check("its release closes the menu", touch.on(MenuOutsideTouch.ACTION_UP, false) == MenuOutsideTouch.DISMISS);

        // A back swipe: the system cancels the touch, then sends back.
        touch = new MenuOutsideTouch();
        touch.on(MenuOutsideTouch.ACTION_DOWN, true);
        touch.on(MOVE, true);
        check("a cancelled outside touch is taken, the menu stays",
                touch.on(MenuOutsideTouch.ACTION_CANCEL, true) == MenuOutsideTouch.TAKE);
        check("the next press inside is the menu's", touch.on(MenuOutsideTouch.ACTION_DOWN, false) == MenuOutsideTouch.PASS);

        // Touches on the menu are the menu's.
        touch = new MenuOutsideTouch();
        check("a press on the menu passes", touch.on(MenuOutsideTouch.ACTION_DOWN, false) == MenuOutsideTouch.PASS);
        check("its moves pass", touch.on(MOVE, false) == MenuOutsideTouch.PASS);
        check("a second finger outside during it passes", touch.on(POINTER_DOWN, true) == MenuOutsideTouch.PASS);
        check("its release passes", touch.on(MenuOutsideTouch.ACTION_UP, false) == MenuOutsideTouch.PASS);
        check("a release with no press passes", touch.on(MenuOutsideTouch.ACTION_UP, true) == MenuOutsideTouch.PASS);
        touch.on(MenuOutsideTouch.ACTION_DOWN, false);
        check("a cancelled touch on the menu passes",
                touch.on(MenuOutsideTouch.ACTION_CANCEL, false) == MenuOutsideTouch.PASS);

        // A finished outside touch leaves nothing behind.
        touch = new MenuOutsideTouch();
        touch.on(MenuOutsideTouch.ACTION_DOWN, true);
        touch.on(MenuOutsideTouch.ACTION_UP, true);
        check("a later move passes", touch.on(MOVE, true) == MenuOutsideTouch.PASS);

        System.out.println("MenuOutsideTouchTest: ok");
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
