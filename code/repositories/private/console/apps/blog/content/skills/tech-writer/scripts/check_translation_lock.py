#!/usr/bin/env python3
"""发布前锁版检查：术语一致性、专名核对、标题层级与结构完整性。"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

MANDATORY_NAMES = [
    "Anthropic",
    "Claude",
    "Claude.ai",
    "Claude Code",
    "Claude Agent SDK",
]

FORBIDDEN_PATTERNS = {
    "非法列表符号": re.compile(r"^\s*[•·]\s+", re.MULTILINE),
    "专名大小写漂移: Claude.AI": re.compile(r"\bClaude\.AI\b"),
    "专名写法漂移: Claude AI": re.compile(r"\bClaude AI\b"),
    "拼写漂移: anthropic": re.compile(r"\banthropic\b"),
    "拼写漂移: claude": re.compile(r"\bclaude\b"),
}

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
CHAPTER_RE = re.compile(r"^##\s+第\s*\d+\s*章")
APPENDIX_RE = re.compile(r"^##\s+附录\s+[A-Z]")
SECTION_TERM_LOG_RE = re.compile(r"^###\s+本节术语变更记录")


@dataclass
class CheckResult:
    errors: list[str]
    warnings: list[str]


def heading_level_checks(lines: list[str]) -> list[str]:
    errors: list[str] = []
    prev_level = 0
    for idx, line in enumerate(lines, 1):
        match = HEADING_RE.match(line)
        if not match:
            continue
        current_level = len(match.group(1))
        if prev_level and current_level > prev_level + 1:
            errors.append(f"L{idx}: 标题层级跳级（H{prev_level} -> H{current_level}）")
        prev_level = current_level
    return errors


def section_term_log_checks(lines: list[str]) -> list[str]:
    """每个 ## 章节（附录除外）前必须存在“本节术语变更记录”。"""
    errors: list[str] = []
    h2_positions: list[tuple[int, str]] = []

    for idx, line in enumerate(lines, 1):
        if line.startswith("## "):
            h2_positions.append((idx, line.strip()))

    for i, (start_line, title) in enumerate(h2_positions):
        if APPENDIX_RE.match(title):
            continue
        end_line = h2_positions[i + 1][0] if i + 1 < len(h2_positions) else len(lines) + 1
        block = lines[start_line:end_line - 1]
        if not any(SECTION_TERM_LOG_RE.match(x) for x in block):
            errors.append(f"L{start_line}: 章节缺少“本节术语变更记录” -> {title}")

    return errors


def run_checks(text: str) -> CheckResult:
    lines = text.splitlines()
    errors: list[str] = []
    warnings: list[str] = []

    # 1) 禁用模式
    for label, pattern in FORBIDDEN_PATTERNS.items():
        for match in pattern.finditer(text):
            line_no = text.count("\n", 0, match.start()) + 1
            errors.append(f"L{line_no}: {label}")

    # 2) 标题层级
    errors.extend(heading_level_checks(lines))

    # 3) 章节日志完整性
    errors.extend(section_term_log_checks(lines))

    # 4) 结构存在性
    if not any(CHAPTER_RE.match(line.strip()) for line in lines):
        warnings.append("未检测到“## 第 N 章”标题")
    if not any(APPENDIX_RE.match(line.strip()) for line in lines):
        warnings.append("未检测到“## 附录 X”标题")
    if "术语与专名一致性表" not in text:
        warnings.append("未检测到“术语与专名一致性表”")
    if "句式与风格统一约定" not in text:
        warnings.append("未检测到“句式与风格统一约定”")

    # 5) 专名存在性（提示级）
    for name in MANDATORY_NAMES:
        if name not in text:
            warnings.append(f"未检测到专名：{name}")

    return CheckResult(errors=errors, warnings=warnings)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: check_translation_lock.py <markdown-file>")
        return 2

    file_path = Path(sys.argv[1])
    if not file_path.exists():
        print(f"[ERROR] 文件不存在: {file_path}")
        return 2

    text = file_path.read_text(encoding="utf-8")
    result = run_checks(text)

    if result.errors:
        print("[LOCK CHECK] 未通过")
        print("\n".join(f"- {item}" for item in result.errors))
        if result.warnings:
            print("[警告]")
            print("\n".join(f"- {item}" for item in result.warnings))
        return 1

    print("[LOCK CHECK] 通过")
    if result.warnings:
        print("[警告]")
        print("\n".join(f"- {item}" for item in result.warnings))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
