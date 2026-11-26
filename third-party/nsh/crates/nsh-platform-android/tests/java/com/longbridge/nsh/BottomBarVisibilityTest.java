package com.longbridge.nsh;

/**
 * Coverage for {@link BottomBarVisibility}. Plain JDK, no Android APIs:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/BottomBarVisibility.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/BottomBarVisibilityTest.java
 * java -cp target/java-tests com.longbridge.nsh.BottomBarVisibilityTest
 * </pre>
 */
public final class BottomBarVisibilityTest {
    public static void main(String[] args) {
        pushesAndPopsPreserveTheAppsHiddenProp();
        appUpdatesPreserveTheVisibleStacksChoice();
        System.out.println("BottomBarVisibilityTest: ok");
    }

    private static void pushesAndPopsPreserveTheAppsHiddenProp() {
        BottomBarVisibility bar = new BottomBarVisibility();
        bar.setApp(true);
        // Ordinary push, hiding page pushed, then popped back to root.
        for (boolean hides : new boolean[] {false, true, false}) {
            bar.setNavigation(hides);
            check("app hidden keeps the bar hidden across navigation changes", bar.hidden());
        }
        bar.setApp(false);
        check("clearing app hidden reveals the bar when navigation does not hide it", !bar.hidden());
    }

    private static void appUpdatesPreserveTheVisibleStacksChoice() {
        BottomBarVisibility bar = new BottomBarVisibility();
        bar.setNavigation(true);
        bar.setApp(true);
        bar.setApp(false);
        check("clearing app hidden keeps the bar hidden while navigation hides it", bar.hidden());
        // Switching to a retained root stack replaces the navigation reason.
        bar.setNavigation(false);
        check("navigation false reveals the bar", !bar.hidden());
        bar.setNavigation(true);
        check("navigation true hides the bar again", bar.hidden());
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
