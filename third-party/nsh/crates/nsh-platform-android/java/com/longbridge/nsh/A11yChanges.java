package com.longbridge.nsh;

import java.util.Locale;
import java.util.Objects;

/**
 * What an accessibility service is told when a mounted view's accessibility (an {@link A11y}
 * from `accessibilityState` / `accessibilityValue`) changes, and the state description it
 * reads. Plain Java, no Android APIs (`A11yChangesTest` runs it on the JDK).
 *
 * <p>A service reads a delegate's state only when it queries the node, and a screen reader's
 * double tap is the app's press ({@code A11y.performAccessibilityAction} takes the click, so
 * the framework sends no {@code TYPE_VIEW_CLICKED}), its new state arriving in a later batch.
 * So the update that brings the state says what changed, as Android's own widgets do:
 *
 * <ul>
 *   <li>A new state description (mixed, expanded, current, a value's text, invalid, and with
 *       any of them the checked word) is a content change of type {@code STATE_DESCRIPTION},
 *       which TalkBack reads when the view or an ancestor has the accessibility focus, as a
 *       widget's {@code setStateDescription} sends. It goes first: TalkBack's click feedback
 *       says no checked state for a node with a state description.
 *   <li>A changed checked state (a checkbox, a switch, a toggle button's pressed) or a gained
 *       selection of the accessibility-focused view, within {@link #CLICK_MS} of a service's
 *       click on it or an ancestor, is a click ({@code TYPE_VIEW_CLICKED}): TalkBack queries
 *       the node again and reads its checked or selected state, as after a
 *       {@code CompoundButton}'s click. A change the app makes by itself is not: a click ticks,
 *       vibrates and stops reading from the top. Leaving a selection is not either: TalkBack
 *       has nothing to say for it, and a click would sound alone.
 *   <li>A changed numeric range of the focused view is a {@code STATE_DESCRIPTION} content
 *       change on API 30+, as a {@code ProgressBar} sends since then, and a selection
 *       ({@code TYPE_VIEW_SELECTED}) before, as it sent before (which the caller sends at most
 *       every {@link #SELECTED_MS}, as its {@code AccessibilityEventSender} does).
 *   <li>Anything else the node shows is a content change of an undefined type, which
 *       refreshes the service's copy of the node and says nothing.
 * </ul>
 *
 * Before API 30 the state description is the node's extras entry androidx's
 * {@code AccessibilityNodeInfoCompat} reads ({@link #STATE_DESCRIPTION_KEY}), as TalkBack reads
 * it, so the same descriptions and events hold on every API level.
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/A11yChanges.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/A11yChangesTest.java
 * java -cp target/java-tests com.longbridge.nsh.A11yChangesTest
 * </pre>
 */
final class A11yChanges {
    /** Nothing a service reads changed. */
    static final int NONE = 0;
    /** {@code TYPE_VIEW_CLICKED}. */
    static final int CLICKED = 1;
    /** {@code TYPE_VIEW_SELECTED}, sent at most every {@link #SELECTED_MS}. */
    static final int SELECTED = 2;
    /** {@code TYPE_WINDOW_CONTENT_CHANGED} with {@code CONTENT_CHANGE_TYPE_STATE_DESCRIPTION}. */
    static final int STATE_DESCRIPTION = 3;
    /** {@code TYPE_WINDOW_CONTENT_CHANGED} with {@code CONTENT_CHANGE_TYPE_UNDEFINED}. */
    static final int CONTENT = 4;

    /**
     * {@code AccessibilityEvent.CONTENT_CHANGE_TYPE_STATE_DESCRIPTION}, an API 30 constant whose
     * value androidx's {@code AccessibilityEventCompat} sends on every level.
     */
    static final int CONTENT_CHANGE_TYPE_STATE_DESCRIPTION = 0x40;
    /** The extras key of a node's state description before API 30 (androidx's). */
    static final String STATE_DESCRIPTION_KEY =
            "androidx.view.accessibility.AccessibilityNodeInfoCompat.STATE_DESCRIPTION_KEY";
    /** How long after a service's click a changed state is that click's (ms). */
    static final long CLICK_MS = 1000;
    /** The least time between two range selections before API 30 (ms), as a {@code ProgressBar}'s. */
    static final long SELECTED_MS = 200;

    /**
     * The spoken state words in one language, in this order: checked, not checked, mixed, on,
     * off, expanded, collapsed, invalid data, then `accessibilityState.current` by its kind in
     * the state's bits 11 to 13 (current, page, step, location, date, time). Keep in step with
     * `nsh-platform-ios`'s `state_words.rs`.
     */
    private static final String[] EN = {
        "checked", "not checked", "mixed", "on", "off", "expanded", "collapsed", "invalid data",
        "current", "current page", "current step", "current location", "current date", "current time",
    };
    private static final String[] ZH_HANS = {
        "已选中", "未选中", "部分选中", "开", "关", "已展开", "已收起", "数据无效",
        "当前", "当前页面", "当前步骤", "当前位置", "当前日期", "当前时间",
    };
    private static final String[] ZH_HANT = {
        "已選取", "未選取", "部分選取", "開啟", "關閉", "已展開", "已收合", "資料無效",
        "目前", "目前頁面", "目前步驟", "目前位置", "目前日期", "目前時間",
    };
    private static final String[] JA = {
        "チェックあり", "チェックなし", "一部選択", "オン", "オフ", "展開", "折りたたみ", "無効なデータ",
        "現在", "現在のページ", "現在のステップ", "現在の場所", "現在の日付", "現在の時刻",
    };
    private static final String[] KO = {
        "선택됨", "선택 안 됨", "일부 선택됨", "켬", "끔", "펼쳐짐", "접힘", "잘못된 데이터",
        "현재", "현재 페이지", "현재 단계", "현재 위치", "현재 날짜", "현재 시간",
    };
    private static final int CHECKED = 0, NOT_CHECKED = 1, MIXED = 2, ON = 3, OFF = 4,
            EXPANDED = 5, COLLAPSED = 6, INVALID = 7, CURRENT = 8;

    /**
     * The state words for {@code locale}: Simplified or Traditional Chinese (by script, else
     * region TW, HK or MO), Japanese, Korean, else English.
     */
    static String[] words(Locale locale) {
        if (locale == null) return EN;
        switch (locale.getLanguage()) {
            case "zh": {
                String script = locale.getScript();
                if ("Hant".equals(script)) return ZH_HANT;
                if ("Hans".equals(script)) return ZH_HANS;
                String region = locale.getCountry();
                return "TW".equals(region) || "HK".equals(region) || "MO".equals(region) ? ZH_HANT : ZH_HANS;
            }
            case "ja": return JA;
            case "ko": return KO;
            default: return EN;
        }
    }

    private A11yChanges() {}

    /**
     * The event for a view whose state went from {@code before} to {@code after} (`encode.rs`'s
     * bits) and whose state description from {@code descriptionBefore} to
     * {@code descriptionAfter}; {@code rangeChanged} is a change of the numeric range it exposes
     * before and after, {@code nodeChanged} one of anything else the node shows (its role, hint,
     * actions, whether it has a range). {@code focused}: the view or an ancestor has the
     * accessibility focus; {@code clicked}: a service clicked it or an ancestor within
     * {@link #CLICK_MS}.
     */
    static int event(int before, int after, String descriptionBefore, String descriptionAfter,
                     boolean rangeChanged, boolean nodeChanged, boolean focused, boolean clicked, int sdk) {
        boolean descriptionChanged = !Objects.equals(descriptionBefore, descriptionAfter);
        if (before == after && !descriptionChanged && !rangeChanged && !nodeChanged) return NONE;
        if (descriptionChanged && descriptionAfter != null) return STATE_DESCRIPTION;
        if (focused) {
            if (clicked) {
                int checked = checked(after), checkedBefore = checked(before);
                if (checked != 0 && checkedBefore != 0 && checked != checkedBefore) return CLICKED;
                if ((before & 2) == 0 && (after & 2) != 0) return CLICKED;
            }
            if (rangeChanged) return sdk >= 30 ? STATE_DESCRIPTION : SELECTED;
        }
        return descriptionChanged ? STATE_DESCRIPTION : CONTENT;
    }

    /**
     * The checked state the node exposes: 0 not checkable, 1 off, 2 on, 3 mixed. A pressed state
     * wins over checked, as the node is then a toggle button.
     */
    static int checked(int state) {
        int on, mixed;
        if ((state & 256) != 0) {
            on = 512;
            mixed = 1024;
        } else if ((state & 8) != 0) {
            on = 16;
            mixed = 32;
        } else {
            return 0;
        }
        if ((state & mixed) != 0) return 3;
        return (state & on) != 0 ? 2 : 1;
    }

    /**
     * The state description of {@code state} with the value's text {@code valueText} (null
     * without one), or null when there is nothing to say. A checkable node's checked state is a
     * part only beside another one (mixed always is): TalkBack says a plain checked state itself,
     * and says none for a node with a state description, so a checked change must change the
     * description, as a {@code CompoundButton}'s does. {@code onOff}: the node is a switch or a
     * toggle button, said on or off, as TalkBack says them.
     */
    static String stateDescription(int state, String valueText, boolean onOff, Locale locale) {
        String[] w = words(locale);
        StringBuilder text = null;
        if ((state & 64) != 0) text = append(text, w[(state & 128) != 0 ? EXPANDED : COLLAPSED]);
        int current = (state >> 11) & 7;
        if (current != 0 && current <= 6) text = append(text, w[CURRENT + current - 1]);
        if (valueText != null) text = append(text, valueText);
        // TalkBack reads content invalid only with an error text: the state is read as WebKit
        // reads it.
        if ((state & (1 << 14)) != 0) text = append(text, w[INVALID]);
        int checked = checked(state);
        String word = checked == 3 ? w[MIXED]
                : checked == 0 || text == null ? null
                : checked == 2 ? w[onOff ? ON : CHECKED]
                : w[onOff ? OFF : NOT_CHECKED];
        if (word != null) text = text == null ? new StringBuilder(word) : text.insert(0, ", ").insert(0, word);
        return text == null ? null : text.toString();
    }

    private static StringBuilder append(StringBuilder text, String part) {
        if (text == null) return new StringBuilder(part);
        return text.append(", ").append(part);
    }
}
