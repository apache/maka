/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Interface copy of the Appearance page's app icon and custom pet
//! sections. Same rules as the parent module.
//!
//! Every string is Maka Desktop's (`sections.appIcon`, `appearance.appIcon*`,
//! `sections.pets`, and `pets` in
//! apps/desktop/src/renderer/locales/settings-preferences-copy.ts), where
//! Desktop shows its failures in toasts that this client writes as the
//! section's status line (what failed, then why).

use super::Locale;

texts! {
    // The app icon section.
    APP_ICON = "App icon", "应用图标", "應用圖示";
    APP_ICON_HELP =
        "The Maka icon shown in the dock, taskbar, and app switcher. Changes apply immediately.",
        "Dock、任务栏和切换器里显示的 Maka 图标；切换会立即生效。",
        "Dock、工作列和切換器裡顯示的 Maka 圖示；切換會立即生效。";
    APP_ICON_SPLIT = "Use a different icon in dark mode", "浅色和深色用不同图标", "淺色與深色模式使用不同圖示";
    APP_ICON_SPLIT_HELP =
        "When off, one icon is used in both appearances.",
        "关闭时两种外观共用一个图标。",
        "關閉時，兩種外觀會共用同一個圖示。";
    APP_ICON_TARGET_LIGHT = "Light", "浅色", "淺色";
    APP_ICON_TARGET_DARK = "Dark", "深色", "深色";
    APP_ICON_CUSTOM = "Imported icon", "导入的图标", "匯入的圖示";
    APP_ICON_CUSTOM_HELP = "An image you imported", "你自己导入的图片", "你自己匯入的圖片";
    APP_ICON_IMPORT = "Import icon…", "导入图标…", "匯入圖示…";
    APP_ICON_IMPORTING = "Importing…", "正在导入…", "正在匯入…";
    APP_ICON_IMPORT_HELP =
        "A square PNG works best. Leave about 10% transparent margin so it sits the same size as other apps in the dock.",
        "方形 PNG 最好；四周留约 10% 透明边，Dock 里才会和其它应用一样大。",
        "方形 PNG 最好；四周留約 10% 透明邊，Dock 裡才會和其它應用一樣大。";
    APP_ICON_REMOVE = "Remove", "删除", "刪除";
    APP_ICON_IMPORT_ERROR = "Could not import the icon", "导入图标失败", "匯入圖示失敗";
    APP_ICON_REMOVE_FAILED = "Could not remove the icon", "删除图标失败", "刪除圖示失敗";
    APP_ICON_SELECT_FAILED = "Could not switch the icon", "切换图标失败", "切換圖示失敗";
    // Why an import failed (`appIconImportFailed`).
    APP_ICON_TOO_LARGE =
        "That file is too large; pick a smaller image",
        "文件太大，换一张小一点的图片",
        "檔案太大，換一張小一點的圖片";
    APP_ICON_TOO_MANY_PIXELS =
        "That image is too large; 4096×4096 is the maximum",
        "图片尺寸太大，最多 4096×4096",
        "圖片尺寸太大，最多 4096×4096";
    APP_ICON_UNSUPPORTED_FORMAT =
        "Only PNG and JPEG are supported",
        "只支持 PNG 和 JPEG",
        "只支援 PNG 和 JPEG";
    APP_ICON_UNREADABLE =
        "No image could be read from that file",
        "这个文件读不出图像",
        "這個檔案讀不出影像";
    APP_ICON_TOO_SMALL =
        "That image is too small; 128×128 is the minimum",
        "图片太小，至少需要 128×128",
        "圖片太小，至少需要 128×128";
    APP_ICON_WRITE_FAILED = "Could not store the imported icon", "无法保存导入的图标", "無法儲存匯入的圖示";

    // The icon groups (`appIconGroups`).
    GROUP_MASCOT = "Mascot", "拟人", "擬人";
    GROUP_BLUE = "Blues", "蓝色系", "藍色系";
    GROUP_CONTRAST = "Black & white", "黑白", "黑白";
    GROUP_PENCIL = "Pencil", "铅笔", "鉛筆";
    GROUP_MOUNTAIN = "Mountain", "高山", "高山";
    GROUP_DARK = "Dark", "深色", "深色";
    GROUP_NEON = "Neon", "霓虹", "霓虹";
    GROUP_MUTED = "Muted", "莫兰迪", "柔和";
    GROUP_WARM = "Warm", "暖色", "暖色";
    GROUP_NATURE = "Nature", "自然", "自然";
    GROUP_METAL = "Metal", "金属", "金屬";
    GROUP_HIGH_CONTRAST = "High contrast", "高对比", "高對比";
    GROUP_CUSTOM = "Imported", "自定义", "自訂";

    // Each shipped icon's name and line (`appIconLabels`, `appIconHelp`).
    ICON_DEFAULT = "Classic", "经典", "經典";
    ICON_DEFAULT_HELP = "The default Maka mark", "Maka 默认品牌图标", "Maka 預設品牌圖示";
    ICON_MONO = "Monochrome", "单色", "單色";
    ICON_MONO_HELP = "Grayscale, for a quieter dock", "灰阶版本，Dock 里更安静", "灰階版本，Dock 裡更安靜";
    ICON_SKY = "Sky", "原色天蓝", "原色天藍";
    ICON_SKY_HELP = "The geometric M mark in brand blue", "几何 M 标，品牌蓝", "幾何 M 標，品牌藍";
    ICON_CYAN = "Cyan", "青蓝", "青藍";
    ICON_CYAN_HELP = "Blue leaning to cyan", "偏青的蓝", "偏青的藍";
    ICON_ICE = "Ice", "冰蓝渐变", "冰藍漸變";
    ICON_ICE_HELP = "A pale-to-deep blue gradient", "由浅到深的蓝色渐变", "由淺到深的藍色漸變";
    ICON_PALE_INVERTED = "Inverted", "淡底深标", "淡底深標";
    ICON_PALE_INVERTED_HELP = "A deep blue mark on a pale field", "淡蓝底配深蓝标", "淡藍底配深藍標";
    ICON_INK = "Ink", "墨黑", "墨黑";
    ICON_INK_HELP = "White on black, the highest contrast", "黑底白标，对比最强", "黑底白標，對比最強";
    ICON_PAPER = "Paper", "纸白", "紙白";
    ICON_PAPER_HELP = "Black on white", "白底黑标", "白底黑標";
    ICON_GRAPHITE = "Graphite", "石墨", "石墨";
    ICON_GRAPHITE_HELP = "Black on white with a grey tip", "白底黑标，笔尖为灰", "白底黑標，筆尖為灰";
    ICON_PENCIL_KRAFT = "Pencil, kraft", "铅笔・牛皮纸", "鉛筆・牛皮紙";
    ICON_PENCIL_KRAFT_HELP = "The pencil reading, on kraft paper", "铅笔意象，牛皮纸底", "鉛筆意象，牛皮紙底";
    ICON_PENCIL_SKY = "Pencil, sky", "铅笔・天蓝", "鉛筆・天藍";
    ICON_PENCIL_SKY_HELP = "The pencil reading, on sky blue", "铅笔意象，天蓝底", "鉛筆意象，天藍底";
    ICON_PENCIL_NAVY = "Pencil, navy", "铅笔・深蓝", "鉛筆・深藍";
    ICON_PENCIL_NAVY_HELP = "The pencil reading, on deep navy", "铅笔意象，深蓝底", "鉛筆意象，深藍底";
    ICON_ALPINE = "Alpine", "晴空雪山", "晴空雪山";
    ICON_ALPINE_HELP = "A snow-capped peak under clear sky", "雪顶山峰，晴空底", "雪頂山峰，晴空底";
    ICON_DUSK = "Dusk", "黄昏", "黃昏";
    ICON_DUSK_HELP = "A snow-capped peak at dusk", "雪顶山峰，黄昏底", "雪頂山峰，黃昏底";
    ICON_NIGHT = "Night", "夜山", "夜山";
    ICON_NIGHT_HELP = "A snow-capped peak at night", "雪顶山峰，夜色底", "雪頂山峰，夜色底";
    ICON_FOREST = "Forest", "苍绿", "蒼綠";
    ICON_FOREST_HELP = "A snow-capped peak in green", "雪顶山峰，苍绿底", "綠色背景上的雪頂山峰";
    ICON_MIDNIGHT = "Midnight", "午夜蓝", "午夜藍";
    // The English lines of Midnight, Carbon and Hazard are shorter than
    // Desktop's, which wrap to three lines on a card at 1512 wide.
    ICON_MIDNIGHT_HELP =
        "Bright on deep navy; clear on a dark Dock",
        // The Chinese lines are its siblings' pattern, shorter than
        // Desktop's (…在深色 Dock 上仍保有清楚輪廓), so the card's line
        // fits one line at 1512 wide (review round 16).
        "深蓝底配亮蓝标",
        "深藍底搭配亮藍標誌";
    ICON_CARBON = "Carbon", "OLED 纯黑", "OLED 純黑";
    ICON_CARBON_HELP =
        "True black; OLED shows only the mark",
        "纯黑底，OLED 上只剩标",
        // As zh-Hans, so it fits one line (review round 16).
        "純黑底，OLED 上只剩標誌";
    ICON_SLATE = "Slate", "石板", "石板灰";
    ICON_SLATE_HELP = "Pale grey on cool slate", "冷灰底配浅灰标", "冷色石板灰底搭配淺灰標誌";
    ICON_OBSIDIAN = "Obsidian", "曜石", "黑曜石";
    ICON_OBSIDIAN_HELP = "Lilac on a violet-black gradient", "紫黑渐变底配淡紫标", "紫黑漸層底搭配淡紫標誌";
    ICON_NEON_CYAN = "Neon cyan", "荧光青", "霓虹青";
    ICON_NEON_CYAN_HELP = "Electric cyan on near-black", "近黑底配荧光青", "近黑底搭配霓虹青";
    ICON_MATRIX = "Phosphor", "磷绿", "磷光綠";
    ICON_MATRIX_HELP = "The green of a phosphor terminal", "终端显示器的磷光绿", "終端機螢幕的磷光綠";
    ICON_MAGENTA = "Magenta", "品红", "洋紅";
    ICON_MAGENTA_HELP = "Hot pink on deep violet", "深紫底配品红", "深紫底搭配洋紅";
    ICON_AMBER_CRT = "Amber CRT", "琥珀 CRT", "琥珀 CRT";
    ICON_AMBER_CRT_HELP = "The amber of an early terminal", "早期终端的琥珀色", "早期終端機的琥珀色";
    ICON_CLAY = "Clay", "陶土", "陶土";
    ICON_CLAY_HELP = "Muted terracotta", "低饱和的陶土色", "低飽和陶土色";
    ICON_SAGE = "Sage", "鼠尾草", "鼠尾草";
    ICON_SAGE_HELP = "Muted grey-green", "低饱和的灰绿", "低飽和灰綠色";
    ICON_DUST = "Dust", "灰粉", "灰粉";
    ICON_DUST_HELP = "Muted dusty rose", "低饱和的灰粉", "低飽和灰粉色";
    ICON_FOG = "Fog", "雾蓝", "霧藍";
    ICON_FOG_HELP = "Muted blue-grey", "低饱和的灰蓝", "低飽和灰藍色";
    ICON_SUNSET = "Sunset", "日落", "日落";
    ICON_SUNSET_HELP = "An orange-to-pink diagonal", "橙到粉的斜向渐变", "橘色到粉色的斜向漸層";
    ICON_AMBER = "Amber", "琥珀", "琥珀";
    ICON_AMBER_HELP = "A dark mark on amber", "琥珀底配深褐标", "琥珀底搭配深褐標誌";
    ICON_TERRACOTTA = "Terracotta", "赤陶", "赤陶";
    ICON_TERRACOTTA_HELP = "A brick-red gradient", "砖红渐变", "磚紅漸層";
    ICON_OCEAN = "Ocean", "深海", "深海";
    ICON_OCEAN_HELP = "A deep teal gradient", "深青绿渐变", "深青綠漸層";
    ICON_MOSS = "Moss", "苔原", "苔原";
    ICON_MOSS_HELP = "A deep moss gradient", "深苔绿渐变", "深苔綠漸層";
    ICON_DESERT = "Desert", "沙漠", "沙漠";
    ICON_DESERT_HELP = "A dark mark on desert sand", "沙色渐变配深褐标", "沙色漸層搭配深褐標誌";
    ICON_GLACIER = "Glacier", "冰川", "冰河";
    ICON_GLACIER_HELP = "A pale glacial blue", "极浅的冰蓝渐变", "極淺的冰河藍漸層";
    ICON_GOLD = "Gold", "鎏金", "鎏金";
    ICON_GOLD_HELP = "The mark itself carries a gold gradient", "标本身带金色渐变", "標誌帶有金色漸層";
    ICON_CHROME = "Chrome", "铬", "鉻";
    ICON_CHROME_HELP = "The mark itself carries a silver gradient", "标本身带银色渐变", "標誌帶有銀色漸層";
    ICON_MONO_BLACK = "Mono black", "单色・黑", "單色・黑";
    ICON_MONO_BLACK_HELP = "Black on pure white; prints in one colour", "纯白底黑标，可单色打印", "純白底黑標，可單色列印";
    ICON_MONO_WHITE = "Mono white", "单色・白", "單色・白";
    ICON_MONO_WHITE_HELP = "White on pure black", "纯黑底白标", "純黑底白色標誌";
    ICON_HAZARD = "Hazard", "黑黄", "黑黃";
    // zh-Hant as zh-Hans, so it fits one line (review round 16).
    ICON_HAZARD_HELP = "Yellow on black; the highest contrast", "黑底黄标，这组里对比最高", "黑底黃標，本組對比最高";

    // The custom pet section.
    PETS = "Custom pets", "自定义宠物", "自訂寵物";
    PETS_HELP =
        "Manage PetPacks you import yourself. Maka does not bundle or enable any pet by default.",
        "管理你自己导入的 PetPack。Maka 不预装、也不默认启用任何宠物。",
        "管理你自己匯入的 PetPack。Maka 不預裝、也不預設啟用任何寵物。";
    PET_IMPORT = "Import PetPack", "导入 PetPack", "匯入 PetPack";
    PET_IMPORTING = "Importing…", "正在导入…", "正在匯入…";
    PET_LOADING = "Loading custom pets…", "正在载入自定义宠物…", "正在載入自訂寵物…";
    PET_STATUS = "Desktop pet", "桌面宠物", "桌面寵物";
    PET_ACTIVE = "Currently using: {name}", "当前使用：{name}", "目前使用：{name}";
    PET_DISABLED = "Off", "已关闭", "已關閉";
    PET_DISABLE = "Turn off pet", "关闭宠物", "關閉寵物";
    PET_EMPTY = "No pets imported yet", "还没有导入宠物", "還沒有匯入寵物";
    PET_EMPTY_HELP =
        "Choose a local folder containing pet.json and a sprite sheet.",
        "选择一个包含 pet.json 和精灵图的本地文件夹。",
        "選擇一個包含 pet.json 和精靈圖的本地資料夾。";
    PET_SELECTED = "In use", "正在使用", "正在使用";
    PET_SELECT = "Use", "使用", "使用";
    PET_SELECTING = "Switching…", "正在切换…", "正在切換…";
    PET_REMOVE = "Remove", "删除", "刪除";
    PET_REMOVING = "Removing…", "正在删除…", "正在刪除…";
    PET_REMOVE_TITLE = "Remove “{name}”?", "删除“{name}”？", "刪除“{name}”？";
    PET_REMOVE_DESCRIPTION =
        "This removes Maka’s local copy of the pet pack and cannot be undone. The original folder is not affected.",
        "这会删除 Maka 本地保存的该宠物包，且无法撤销。原始文件夹不会受影响。",
        "這會刪除 Maka 本地儲存的該寵物包，且無法撤銷。原始資料夾不會受影響。";
    PET_LOAD_FAILED = "Could not load custom pets", "无法载入自定义宠物", "無法載入自訂寵物";
    PET_IMPORT_FAILED = "Could not import pet", "导入宠物失败", "匯入寵物失敗";
    PET_SELECT_FAILED = "Could not switch pet", "切换宠物失败", "切換寵物失敗";
    PET_REMOVE_FAILED = "Could not remove pet", "删除宠物失败", "刪除寵物失敗";
    // Why an import failed (`importErrors`).
    PET_INVALID_DIRECTORY = "The selected folder is invalid.", "所选文件夹无效。", "所選資料夾無效。";
    PET_INVALID_MANIFEST =
        "pet.json does not match the maka.pet/v1 format.",
        "pet.json 不符合 maka.pet/v1 格式。",
        "pet.json 不符合 maka.pet/v1 格式。";
    PET_INVALID_ASSET =
        "The sprite sheet is missing, invalid, or outside the supported limits.",
        "精灵图缺失、无效或超出限制。",
        "精靈圖缺失、無效或超出限制。";
    PET_ALREADY_INSTALLED =
        "A pet with the same ID is already installed.",
        "已经导入了相同 ID 的宠物。",
        "已經匯入了相同 ID 的寵物。";
    PET_READ_FAILED = "The selected folder could not be read.", "无法读取所选文件夹。", "無法讀取所選資料夾。";
    // Why a switch or a removal failed (`selectErrors`, `removeErrors`).
    PET_NOT_FOUND =
        "That pet is no longer in the local library.",
        "该宠物已不在本地宠物库中。",
        "該寵物已不在本地寵物庫中。";
    PET_LIBRARY_UNREADABLE = "The pet library could not be read.", "无法读取宠物库。", "無法讀取寵物庫。";
    PET_PACK_NOT_REMOVED =
        "The local pet pack could not be removed.",
        "无法删除本地宠物包。",
        "無法刪除本機寵物包。";
}

/// The status row's line while `name` is the pet in use.
pub fn active_pet(locale: Locale, name: &str) -> String {
    PET_ACTIVE.fill(locale, &[("name", name)])
}

/// The removal question's title.
pub fn remove_pet_title(locale: Locale, name: &str) -> String {
    PET_REMOVE_TITLE.fill(locale, &[("name", name)])
}
