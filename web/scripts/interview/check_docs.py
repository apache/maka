"""精简复习库的只读验收：数量、链接、题号、原始证据与身份。"""
from pathlib import Path
import hashlib
import json
import re
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[3] / "code" / "paused" / "interview"
BASELINE = "0698ba3"
PROTECTED_SHA = {'assets/screenshots/关天豪-BOSS直聘沟通0记录.jpg': 'fccaa896e282c9fd963f8db320e7b87e5ad4cc2d76143ab853e3605e2fb6857c', 'assets/evidence/06-检查命令结果.json': 'aa8ff6cedb95b70996b4c751492e57ceb6e964a28bf38cf6b81f66658e2d4ef3', 'assets/evidence/finalize_migration.py': 'd8413425f31756e45c392e12538a92f0808336e3c30f76cdb7fe458b32dd019c', 'assets/evidence/04-链接修复记录.json': 'cd5e310fb85eae54e7daf3bf7443c175da1569ee1058e80caea67a99e2b30649', 'assets/evidence/21-附件-review-threads-20260914.json': 'a9423fa188a106c3fc8102441cd98baf58ec0bd7328db88143730964c7e78e99', 'assets/evidence/rebuild_materials.py': 'f333d953be49c412c977a33ec9a131f75a332a47d14ddcf0371ecd23ce0e147b', 'assets/evidence/01-迁移前原始文件快照.zip': '1445217f1fd70d41a25f790b5d60051352b79534f90a92d98d5f5ac627118eed', 'assets/evidence/03-迁移映射.json': '61c889adbced6800afeae15fdca928375c4b74a88b396328ce871e5cdad6eeef', 'assets/evidence/02-迁移前Git状态.txt': 'a5238fe18762d0795c597b430c8e09e6347ac8234ea1fffeede3b5e7f8e170ad', 'assets/evidence/build_training_docs.py': '1870d6be03c4d992304ef78da1ec9b80e3a35bae33372bcc65bd617b6d929845', 'assets/evidence/05-验收结果.json': '7764a51c25677dd3e28ff7f8df18945145b99cd49b1ab70c4c5ce4289c8bda94', 'assets/evidence/migrate_materials.py': '16daba383d94bf374eb63ba880f68e01456b8a19b87d8afcf105985a6c2fb2d7', 'assets/evidence/build_study_docs.py': 'e2ca052034848a2506158c05a294aa943b2d00ca0ea8fdea79484b9f59b4fade', 'assets/evidence/21-附件-comments-ggbdpq-20260914.json': '69e9763d529c0bd445293b82f5c5f47dde43ca9914932dfdbba167d85d765831', 'assets/evidence/00-迁移前完整盘点.json': '08cbee7bcd416258acfe457d4c74ffe1c583babe50bf94feaca11e8753411f2e', 'assets/evidence/2026-10-02-公开项目与贡献核验.json': '1fbbecbfb02bae9a0b37bdb6ccc4e599762ff6b73c695d3b4212bd42add481ec', 'assets/evidence/raw-docs/20-逆向工程-简历评估与grilling决策记录-20260914.md': 'be672687e5c8914a1ca555e7e06acfd0c3caa291435aeae03cec3c2cfc914bec', 'assets/evidence/raw-docs/18-grilling决策记录-简历更新20260914.md': 'bed20eee16775d907cdc01bc51e9a7bdf4ca8cef66f657bf153c7f04b1dd3e05', 'assets/evidence/raw-docs/14-关天豪-clife-AI项目经验-草稿.md': 'e7d04ff11c0270f1308529a2331651c4bc7bbf5a92b015198e94e70ced0c3e88', 'assets/evidence/raw-docs/02-同事智能体代码精读素材.md': '366e8c618133be37519e04e2e89ec9c8fab71cd4436544e923f4e4c0f54cd3b0', 'assets/evidence/raw-docs/21-Maka开源贡献-简历评估与grilling决策记录-20260914.md': '285404c02e4f6e93434ecd503ab8c9b377d6bd71a5f3778e56ee5bffb08612b2', 'assets/evidence/raw-docs/19-李豪-Web-开发工程师-AI时代版.md': '1e53b16d91403691676041d74abc77bb0a9f0c2e17a69990f6e551665272dc77', 'assets/evidence/raw-docs/希音供应链前端项目总结-ggbdpq.md': '885f4c1349009b05c7afd93b4e374f29dfdbe8e3269657b64118a80a93a5a103', 'assets/spreadsheets/我的前端技术栈.xlsx': '670f9c4701830e8600df40254fb84655b001038f533c8c65e30b7fdbfd58acb6', 'assets/spreadsheets/05-20251130-BOSS直聘求职记录.xlsx': '6fdf0f0616650a2f84e13ba6d45e5d7ddc221c62872942bd9a7a36b1cabc4469', 'assets/spreadsheets/初级前端交接项目列表清单.xlsx': '366404b9dd8a2ef1273d69d99f8ecccf94aa0dd9691a84ed8003c8d689f71e0b', '00-事实与简历/01-关天豪-AI应用工程师-主简历.md': 'b710fd7e6acc65243793d604a88025efe13108e38f2ac742b2fffd835a329a3e', '00-事实与简历/02-关天豪-Web前端工程师-保底简历.md': '997e1dc636d1da6778b9a9ad976bd924c2f5926733e08f7432f79a88a96487a2'}
IDENTITY = {'name': '关天豪', 'experience_label': '2018 年起从事 Web 开发', 'education': {'school': '东莞理工学院', 'graduation_year': 2018, 'level': '全日制本科', 'source': '原登记表与母版；专业暂不放入简历'}, 'career': [{'company': '深圳市德奥信息技术有限公司', 'period': '2018.07 - 2022.02'}, {'company': '广州希音国际进出口有限公司', 'period': '2022.03 - 2025.10'}, {'company': '深圳市数联天下智能科技有限公司', 'period': '2026.04 - 至今'}]}


def require(ok, message):
    if not ok:
        raise SystemExit("FAIL: " + message)


md = sorted(p for p in ROOT.rglob("*") if p.is_file() and p.suffix.lower() == ".md" and ".git" not in p.relative_to(ROOT).parts)
require(50 <= len(md) <= 60, f"Markdown 数量 {len(md)} 超出50—60")
for rel, digest in PROTECTED_SHA.items():
    p = ROOT / rel
    require(p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest() == digest,
            f"受保护原件相对 {BASELINE} 改变或缺失：{rel}")

links = 0
for p in md:
    rel = p.relative_to(ROOT).as_posix()
    # 原始取证底稿按字节保护，其历史路径不作为现行学习链接。
    if rel.startswith("assets/evidence/raw-docs/"):
        continue
    text = p.read_text(encoding="utf-8")
    require(sum(line.startswith("```") for line in text.splitlines()) % 2 == 0,
            f"代码围栏未闭合：{rel}")
    for target in re.findall(r"\]\(([^\n)]+)\)", text):
        target = target.strip().strip("<>")
        if target.startswith("#") or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target):
            continue
        target = unquote(target.split("#", 1)[0])
        require((p.parent / target).exists(), f"失效链接：{rel} -> {target}")
        links += 1

for prefix, count, rel in [
    ("F", 8, "03-题库与系统设计/00-P0-必背.md"),
    ("A", 10, "03-题库与系统设计/02-AI-Agent高频追问.md"),
]:
    ids = re.findall(r"^##\s+(" + prefix + r"\d{2})\b", (ROOT / rel).read_text(), re.M)
    require(ids == [f"{prefix}{i:02d}" for i in range(1, count + 1)],
            f"核心题号缺失或重复：{rel}")

text = (ROOT / "00-事实与简历/00-个人事实基线.md").read_text()
current = json.loads(re.search(r"```json\n(.*?)\n```", text, re.S).group(1))
require({k: current[k] for k in IDENTITY} == IDENTITY, "身份或任职已偏离确认基线")
print(f"PASS: {len(md)} Markdown; {links} local links; 18 core questions; {len(PROTECTED_SHA)} protected files; identity unchanged.")
