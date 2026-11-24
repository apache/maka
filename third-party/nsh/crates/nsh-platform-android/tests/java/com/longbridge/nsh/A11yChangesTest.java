package com.longbridge.nsh;

import java.util.Locale;

/**
 * Coverage for the accessibility event a changed view sends ({@link A11yChanges}): a checked
 * or selected change of the focused view a service just clicked is a click, a new state
 * description its own content change (on every API level), a range change a state description
 * change on API 30+ and a selection before, anything else a content change that only refreshes
 * the node, and nothing for an unchanged update. Plain JDK, no Android APIs:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/A11yChanges.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/A11yChangesTest.java
 * java -cp target/java-tests com.longbridge.nsh.A11yChangesTest
 * </pre>
 *
 * States are `encode.rs`'s bits: 1 disabled, 2 selected, 4 busy, 8 checkable, 16 checked,
 * 32 mixed, 64 expandable, 128 expanded, 256 toggle button, 512 pressed, 1024 pressed mixed,
 * bits 11 to 13 the kind of current, 1 << 14 invalid.
 */
public final class A11yChangesTest {
    private static final int API_26 = 26, API_29 = 29, API_30 = 30, API_36 = 36;
    private static final int INVALID = 1 << 14;
    private static int checks;

    public static void main(String[] args) {
        // Checked and pressed changes of the focused view a service clicked are clicks, read as
        // the new state.
        expect("unchecked to checked", 8, 24, true, true, API_36, A11yChanges.CLICKED);
        expect("checked to unchecked", 24, 8, true, true, API_36, A11yChanges.CLICKED);
        expect("a switch on API 26", 8, 24, true, true, API_26, A11yChanges.CLICKED);
        expect("pressed toggle", 256, 768, true, true, API_36, A11yChanges.CLICKED);
        expect("released toggle", 768, 256, true, true, API_36, A11yChanges.CLICKED);
        expect("pressed wins over checked", 256 | 8, 256 | 24, true, true, API_36, A11yChanges.CONTENT);
        expect("checked and selected at once is one click", 8, 24 | 2, true, true, API_36, A11yChanges.CLICKED);
        // Away from the accessibility focus the node is only refreshed.
        expect("an unfocused checkbox", 8, 24, false, true, API_36, A11yChanges.CONTENT);
        expect("an unfocused tab", 0, 2, false, true, API_36, A11yChanges.CONTENT);
        // A change the app makes by itself is no click: a click ticks and stops reading.
        expect("the app checks the focused checkbox", 8, 24, true, false, API_36, A11yChanges.CONTENT);
        expect("the app selects the focused tab", 0, 2, true, false, API_36, A11yChanges.CONTENT);
        expect("the app presses the focused toggle", 256, 768, true, false, API_26, A11yChanges.CONTENT);

        // Selection names the current item: gaining it is a click, leaving it says nothing.
        expect("selected", 0, 2, true, true, API_36, A11yChanges.CLICKED);
        expect("deselected only refreshes", 2, 0, true, true, API_36, A11yChanges.CONTENT);

        // Becoming or ceasing to be checkable is not a toggle.
        expect("becoming checkable", 0, 8, true, true, API_36, A11yChanges.CONTENT);
        expect("ceasing to be checkable", 24, 0, true, true, API_36, A11yChanges.CONTENT);
        expect("checked bits without checkable", 0, 16, true, true, API_36, A11yChanges.CONTENT);
        expect("disabled only refreshes", 0, 1, true, true, API_36, A11yChanges.CONTENT);
        expect("busy only refreshes", 0, 4, true, true, API_36, A11yChanges.CONTENT);

        // Unchanged updates are silent.
        expect("unchanged checkbox", 24, 24, true, true, API_36, A11yChanges.NONE);
        expect("unchanged selected", 2, 2, true, true, API_36, A11yChanges.NONE);
        expect("unchanged expanded", 192, 192, true, true, API_36, A11yChanges.NONE);
        expect("unchanged on API 26", 24, 24, true, true, API_26, A11yChanges.NONE);

        // A new state description is read as the new state, before a click, on every level
        // (before API 30 from the node's extras, as androidx stores it).
        expect("expanded", 64, 192, true, true, API_30, A11yChanges.STATE_DESCRIPTION);
        expect("expanded on API 26", 64, 192, true, true, API_26, A11yChanges.STATE_DESCRIPTION);
        expect("expanded by the app", 64, 192, true, false, API_36, A11yChanges.STATE_DESCRIPTION);
        expect("collapsed, unfocused", 192, 64, false, false, API_36, A11yChanges.STATE_DESCRIPTION);
        expect("mixed", 8, 40, true, true, API_36, A11yChanges.STATE_DESCRIPTION);
        expect("mixed on API 26", 8, 40, true, true, API_26, A11yChanges.STATE_DESCRIPTION);
        expect("mixed toggle", 256, 1280, true, true, API_36, A11yChanges.STATE_DESCRIPTION);
        expect("mixed to checked reads the checked state", 40, 24, true, true, API_36, A11yChanges.CLICKED);
        expect("mixed to checked on API 26", 40, 24, true, true, API_26, A11yChanges.CLICKED);
        expect("current page", 0, 2 << 11, true, true, API_36, A11yChanges.STATE_DESCRIPTION);
        expect("invalid", 0, INVALID, true, true, API_36, A11yChanges.STATE_DESCRIPTION);
        expect("no longer current", 2 << 11, 0, true, true, API_36, A11yChanges.STATE_DESCRIPTION);

        // A checked change of a node with a state description changes the description: TalkBack
        // says no checked state on a click of such a node.
        expect("checked and expanded at once", 72, 216, true, true, API_36, A11yChanges.STATE_DESCRIPTION);
        expect("an expanded checkbox checked", 8 | 192, 24 | 192, true, true, API_36, A11yChanges.STATE_DESCRIPTION);
        expect("an expanded checkbox checked on API 26", 8 | 192, 24 | 192, true, true, API_26,
                A11yChanges.STATE_DESCRIPTION);
        expect("an invalid checkbox checked", 8 | INVALID, 24 | INVALID, true, true, API_36,
                A11yChanges.STATE_DESCRIPTION);
        expect("an invalid checkbox checked by the app", 8 | INVALID, 24 | INVALID, true, false, API_36,
                A11yChanges.STATE_DESCRIPTION);
        expect("an invalid toggle pressed", 256 | INVALID, 768 | INVALID, true, true, API_36,
                A11yChanges.STATE_DESCRIPTION);
        expect("mixed and expanded to checked", 8 | 32 | 192, 8 | 16 | 192, true, true, API_36,
                A11yChanges.STATE_DESCRIPTION);
        expect("a current page checkbox checked", 8 | (2 << 11), 24 | (2 << 11), true, true, API_36,
                A11yChanges.STATE_DESCRIPTION);
        // The description goes, the checked state reads alone: a click.
        expect("checked while the error goes", 8 | INVALID, 24, true, true, API_36, A11yChanges.CLICKED);
        // Selection keeps its click: TalkBack says "selected" beside a state description.
        expect("a current tab selected", 2 << 11, 2 | (2 << 11), true, true, API_36, A11yChanges.CLICKED);

        // Values: a value's text is a state description; a numeric range a state description
        // change on API 30+ (as a ProgressBar), a selection before.
        expectValue("a value's text", "3 of 10", "4 of 10", false, true, API_36, A11yChanges.STATE_DESCRIPTION);
        expectValue("a value's text on API 26", "3 of 10", "4 of 10", false, true, API_26,
                A11yChanges.STATE_DESCRIPTION);
        expectValue("a range", null, null, true, true, API_36, A11yChanges.STATE_DESCRIPTION);
        expectValue("a range on API 30", null, null, true, true, API_30, A11yChanges.STATE_DESCRIPTION);
        expectValue("a range on API 29", null, null, true, true, API_29, A11yChanges.SELECTED);
        expectValue("a range on API 26", null, null, true, true, API_26, A11yChanges.SELECTED);
        expectValue("an unfocused range", null, null, true, false, API_36, A11yChanges.CONTENT);
        expectValue("an unfocused range on API 26", null, null, true, false, API_26, A11yChanges.CONTENT);
        expectValue("an unchanged range", null, null, false, true, API_36, A11yChanges.NONE);
        check("a range needs no click",
                A11yChanges.event(0, 0, null, null, true, false, true, false, API_26) == A11yChanges.SELECTED);
        check("a value's text goes before a range",
                A11yChanges.event(0, 0, "3", "4", true, false, true, true, API_26) == A11yChanges.STATE_DESCRIPTION);
        check("a checked change goes before a range",
                A11yChanges.event(8, 24, null, null, true, false, true, true, API_36) == A11yChanges.CLICKED);

        // Anything else the node shows (a range coming or going too) only refreshes it.
        check("a new role or hint only refreshes",
                A11yChanges.event(0, 0, null, null, false, true, true, true, API_36) == A11yChanges.CONTENT);

        // The state description the node says, in its order.
        description("nothing", 0, null, false, null);
        description("a plain checked state is TalkBack's", 24, null, false, null);
        description("a plain switch is TalkBack's", 8, null, true, null);
        description("mixed", 40, null, false, "mixed");
        description("pressed mixed", 256 | 1024, null, true, "mixed");
        description("pressed wins over checked", 256 | 40, null, true, null);
        description("expanded", 192, null, false, "expanded");
        description("collapsed", 64, null, false, "collapsed");
        description("current step", 3 << 11, null, false, "current step");
        description("an unknown current", 7 << 11, null, false, null);
        description("a value's text", 0, "Medium", false, "Medium");
        description("invalid", INVALID, null, false, "invalid data");
        description("checked beside expanded", 24 | 192, null, false, "checked, expanded");
        description("not checked beside invalid", 8 | INVALID, null, false, "not checked, invalid data");
        description("a switch on beside invalid", 24 | INVALID, null, true, "on, invalid data");
        description("a toggle off beside collapsed", 256 | 64, null, true, "off, collapsed");
        description("a toggle on beside a value", 768, "Bold", true, "on, Bold");
        description("all of them", 40 | 192 | (1 << 11) | INVALID, "Medium", false,
                "mixed, expanded, current, Medium, invalid data");

        // The checked state the node exposes.
        check("not checkable", A11yChanges.checked(16) == 0);
        check("off", A11yChanges.checked(8) == 1);
        check("on", A11yChanges.checked(24) == 2);
        check("mixed", A11yChanges.checked(40) == 3);
        check("pressed wins", A11yChanges.checked(256 | 24) == 1);
        check("pressed mixed", A11yChanges.checked(256 | 1024) == 3);
        // The words follow the language: Simplified and Traditional Chinese by script or region,
        // Japanese, Korean, anything else English.
        localized("Simplified Chinese", Locale.SIMPLIFIED_CHINESE, 24 | 64 | INVALID, null, false, "已选中, 已收起, 数据无效");
        localized("Chinese by script", Locale.forLanguageTag("zh-Hant-CN"), 8 | 192, null, false, "未選取, 已展開");
        localized("Chinese in Hong Kong", Locale.forLanguageTag("zh-HK"), 768 | (2 << 11), null, true, "開啟, 目前頁面");
        localized("Japanese mixed", Locale.JAPANESE, 8 | 32, null, false, "一部選択");
        localized("Korean switch off", Locale.KOREAN, 256 | 64, null, true, "끔, 접힘");
        localized("German falls back to English", Locale.GERMAN, 64 | 128, null, false, "expanded");
        localized("no locale is English", null, INVALID, "Medium", false, "Medium, invalid data");
        localized("the core's tag", Locale.forLanguageTag("zh-Hant-TW"), 64, null, false, "已收合");

        System.out.println("A11yChangesTest: " + checks + " passed");
    }

    private static void expect(String what, int before, int after, boolean focused, boolean clicked, int sdk,
                               int wanted) {
        String from = A11yChanges.stateDescription(before, null, false, Locale.ENGLISH);
        String to = A11yChanges.stateDescription(after, null, false, Locale.ENGLISH);
        int got = A11yChanges.event(before, after, from, to, false, false, focused, clicked, sdk);
        check(what + ": expected " + wanted + ", got " + got, got == wanted);
    }

    private static void expectValue(String what, String textBefore, String textAfter, boolean rangeChanged,
                                    boolean focused, int sdk, int wanted) {
        int got = A11yChanges.event(0, 0, A11yChanges.stateDescription(0, textBefore, false, Locale.ENGLISH),
                A11yChanges.stateDescription(0, textAfter, false, Locale.ENGLISH), rangeChanged, false, focused, true, sdk);
        check(what + ": expected " + wanted + ", got " + got, got == wanted);
    }

    private static void description(String what, int state, String valueText, boolean onOff, String wanted) {
        String got = A11yChanges.stateDescription(state, valueText, onOff, Locale.ENGLISH);
        check(what + ": expected " + wanted + ", got " + got, java.util.Objects.equals(got, wanted));
    }

    private static void localized(String what, Locale locale, int state, String valueText, boolean onOff, String wanted) {
        String got = A11yChanges.stateDescription(state, valueText, onOff, locale);
        check(what + ": expected " + wanted + ", got " + got, java.util.Objects.equals(got, wanted));
    }

    private static void check(String what, boolean ok) {
        checks++;
        if (!ok) throw new AssertionError(what);
    }
}
