package com.longbridge.nsh;

/**
 * Coverage for Back's release: reported once per press, whichever way the
 * window hands it over (a key-up down the focus path, the unhandled-key
 * listener, the back callback). Plain JDK, no Android APIs:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/BackRelease.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/BackReleaseTest.java
 * java -cp target/java-tests com.longbridge.nsh.BackReleaseTest
 * </pre>
 */
public final class BackReleaseTest {
    public static void main(String[] args) {
        // A key-up down the focus path is the release, as any key's.
        BackRelease back = new BackRelease();
        back.press(100);
        check("a press is held", back.held());
        check("its key-up is reported", back.up(100));
        check("the key-up ends the press", !back.held());
        check("a later callback reports nothing more", !back.take());

        // The back callback (or the unhandled-key listener) takes the release.
        back = new BackRelease();
        back.press(200);
        check("the callback's release is reported", back.take());
        check("only once", !back.take());
        check("the press is no longer held", !back.held());
        check("the cancelled key-up after it is not reported", !back.up(200));
        check("the key-up ends the press", !back.take());

        // A press the window never sent down the focus path has no release.
        back = new BackRelease();
        check("no press, no release", !back.take());
        check("a key-up whose down went elsewhere is reported", back.up(300));

        // A key-up of another press than the one released is reported.
        back = new BackRelease();
        back.press(400);
        check("released through the callback", back.take());
        check("another press's key-up is reported", back.up(401));

        // A key-up of another press (another device's, or a stale one)
        // leaves the held press held.
        back = new BackRelease();
        back.press(450);
        check("a stray key-up is reported", back.up(449));
        check("the press stays held", back.held());
        check("its own key-up is reported", back.up(450));
        check("and ends it", !back.held());

        // A fresh press after one released through the listener, whose
        // key-up never reached the focus path.
        back = new BackRelease();
        back.press(500);
        check("the listener's release", back.take());
        back.press(600);
        check("the next press is held", back.held());
        check("its release is reported", back.take());

        // Losing the window's focus forgets the press: no release later.
        back = new BackRelease();
        back.press(700);
        back.reset();
        check("no press after the focus went", !back.held());
        check("no release from the callback", !back.take());
        check("a real key-up is still reported", back.up(700));

        System.out.println("BackReleaseTest: ok");
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
