//! The words VoiceOver speaks for the states UIKit has no trait for
//! (checked, mixed, expanded, current, invalid), which go in the element's
//! `accessibilityValue`: in the language the app's text shows in, which the
//! core sends with `Command::TextLocale` (its selected language, the app's
//! `setLocale` or the embedding app's included; English until it says
//! otherwise, as the core's own starts). Keep in step with
//! `nsh-platform-android`'s `A11yChanges.java`.

/// The spoken state words of one language.
pub(crate) struct StateWords {
    pub checked: &'static str,
    pub not_checked: &'static str,
    pub mixed: &'static str,
    pub expanded: &'static str,
    pub collapsed: &'static str,
    pub invalid: &'static str,
    /// `current` by kind: true, page, step, location, date, time.
    pub current: [&'static str; 6],
}

const EN: StateWords = StateWords {
    checked: "checked",
    not_checked: "not checked",
    mixed: "mixed",
    expanded: "expanded",
    collapsed: "collapsed",
    invalid: "invalid data",
    current: [
        "current",
        "current page",
        "current step",
        "current location",
        "current date",
        "current time",
    ],
};

const ZH_HANS: StateWords = StateWords {
    checked: "已选中",
    not_checked: "未选中",
    mixed: "部分选中",
    expanded: "已展开",
    collapsed: "已收起",
    invalid: "数据无效",
    current: [
        "当前",
        "当前页面",
        "当前步骤",
        "当前位置",
        "当前日期",
        "当前时间",
    ],
};

const ZH_HANT: StateWords = StateWords {
    checked: "已選取",
    not_checked: "未選取",
    mixed: "部分選取",
    expanded: "已展開",
    collapsed: "已收合",
    invalid: "資料無效",
    current: [
        "目前",
        "目前頁面",
        "目前步驟",
        "目前位置",
        "目前日期",
        "目前時間",
    ],
};

const JA: StateWords = StateWords {
    checked: "チェックあり",
    not_checked: "チェックなし",
    mixed: "一部選択",
    expanded: "展開",
    collapsed: "折りたたみ",
    invalid: "無効なデータ",
    current: [
        "現在",
        "現在のページ",
        "現在のステップ",
        "現在の場所",
        "現在の日付",
        "現在の時刻",
    ],
};

const KO: StateWords = StateWords {
    checked: "선택됨",
    not_checked: "선택 안 됨",
    mixed: "일부 선택됨",
    expanded: "펼쳐짐",
    collapsed: "접힘",
    invalid: "잘못된 데이터",
    current: [
        "현재",
        "현재 페이지",
        "현재 단계",
        "현재 위치",
        "현재 날짜",
        "현재 시간",
    ],
};

/// The words for the BCP 47 `tag`: Simplified or Traditional Chinese (by
/// script, else region TW, HK or MO), Japanese, Korean, else English.
pub(crate) fn for_language(tag: &str) -> &'static StateWords {
    let mut subtags = tag.split(['-', '_']);
    let language = subtags.next().unwrap_or_default().to_ascii_lowercase();
    match language.as_str() {
        "zh" => {
            let mut hant = false;
            for subtag in subtags {
                match subtag.to_ascii_lowercase().as_str() {
                    "hans" => return &ZH_HANS,
                    "hant" => return &ZH_HANT,
                    "tw" | "hk" | "mo" => hant = true,
                    _ => {}
                }
            }
            if hant { &ZH_HANT } else { &ZH_HANS }
        }
        "ja" => &JA,
        "ko" => &KO,
        _ => &EN,
    }
}

/// The words before the core names a language: English.
pub(crate) const DEFAULT: &StateWords = &EN;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_language() {
        assert_eq!(for_language("en-US").checked, "checked");
        assert_eq!(for_language("zh-Hans-CN").expanded, "已展开");
        assert_eq!(for_language("zh-CN").invalid, "数据无效");
        assert_eq!(for_language("zh-Hant-CN").collapsed, "已收合");
        assert_eq!(for_language("zh-TW").checked, "已選取");
        assert_eq!(for_language("zh_HK").current[1], "目前頁面");
        assert_eq!(for_language("ja-JP").mixed, "一部選択");
        assert_eq!(for_language("ko").not_checked, "선택 안 됨");
        assert_eq!(for_language("de-CH").expanded, "expanded");
        assert_eq!(for_language("").expanded, "expanded");
    }
}
