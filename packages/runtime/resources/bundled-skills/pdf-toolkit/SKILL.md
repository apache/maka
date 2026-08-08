---
name: PDF 工具箱
description: 需要对 PDF 做任何操作时使用——提取文本/表格、合并拆分、旋转、加密解密、填写表单、PDF 与图片互转。只要用户提到 .pdf 文件或想生成 PDF 就触发。
category: 效率工具
allowed-tools:
  - Read
  - Write
  - Bash
---

# PDF 工具箱

## 目标

为本地 PDF 文件提供一站式处理能力。所有操作都通过 `Bash` 调用 `python3` 加少量成熟的第三方库完成，脚本自包含、可直接执行。maka 市场只支持单文件 SKILL.md，因此这里不依赖任何外部脚本文件——需要运行的 python 代码全部内联在下面的工作流里，你把它写入临时 `.py` 文件后执行，或用 `python3 -c` / heredoc 运行。

## 能力清单

| 操作 | 推荐库 | 说明 |
|------|--------|------|
| 读取/提取文本 | pdfplumber | 保留版面布局逐页取文 |
| 提取表格 | pdfplumber | `extract_tables()`，可导出 Excel/CSV |
| 合并多个 PDF | pypdf | 顺序拼接为一个文件 |
| 拆分 PDF | pypdf | 按页/按范围切成多个文件 |
| 旋转页面 | pypdf | 90/180/270 度 |
| 加密/解密 | pypdf | 设置或去除打开密码 |
| 读取元数据 | pypdf | 标题、作者、页数等 |
| 填写表单 | pypdf | 写入 AcroForm 字段 |
| 生成新 PDF | reportlab | 从文本/表格排版生成 |
| PDF 转图片 | pdf2image (需 poppler) | 每页渲染为 PNG |
| 图片转 PDF | Pillow | 多张图合成一个 PDF |

## 第 0 步：依赖检测与按需安装

动手前先探测环境，缺什么装什么，避免报 `ModuleNotFoundError`。

```bash
# 探测核心库是否可用；缺失的会被打印出来
python3 - <<'PY'
import importlib
mods = {
    "pypdf": "pypdf",
    "pdfplumber": "pdfplumber",
    "reportlab": "reportlab",
    "PIL": "Pillow",
    "pdf2image": "pdf2image",
}
missing = [pip for imp, pip in mods.items() if importlib.util.find_spec(imp) is None]
print("MISSING:", " ".join(missing) if missing else "(none)")
PY
```

按当前任务只安装真正需要的包（不要一次性全装）：

```bash
# 例：只需读文本 + 合并，就装这两个
python3 -m pip install --quiet --disable-pip-version-check pypdf pdfplumber
```

各能力对应的最小依赖：

- 文本/表格提取 → `pdfplumber`
- 合并/拆分/旋转/加密/元数据/填表单 → `pypdf`
- 生成新 PDF → `reportlab`
- PDF 转图片 → `pdf2image`（另需系统 poppler：macOS `brew install poppler`，Debian/Ubuntu `apt-get install poppler-utils`）
- 图片转 PDF → `Pillow`

表格导出 Excel 时再加 `pandas openpyxl`。

如果 `pip install` 因网络失败，先降级方案：文本提取可用系统自带/易装的 `pdftotext`（poppler-utils），合并可用 `qpdf`。发现这类外部命令可用时优先用，省去装 python 库。

```bash
# 无 python 库时的兜底
pdftotext -layout input.pdf output.txt                     # 提取文本，保留版面
qpdf --empty --pages a.pdf b.pdf -- merged.pdf             # 合并
qpdf input.pdf --pages . 1-5 -- part.pdf                   # 取 1-5 页
qpdf --password=PWD --decrypt enc.pdf dec.pdf              # 解密
```

## 工作流

下面每个片段都写成可直接运行的样子。建议把脚本写到临时文件再执行，例如
`python3 /tmp/pdf_job.py`，便于传参和复用。文件路径请始终使用绝对路径。

### 1. 提取文本

```python
import sys, pdfplumber

src = sys.argv[1]
with pdfplumber.open(src) as doc:
    for i, page in enumerate(doc.pages, 1):
        text = page.extract_text() or ""
        print(f"===== 第 {i} 页 =====")
        print(text)
```

只要某几页可加范围判断（`enumerate` 里过滤页码）。若结果为空且文件是扫描件（图片型 PDF），文本提取会拿不到内容——此时需走 OCR，见「边界」一节。

### 2. 提取表格并导出

```python
import sys, pdfplumber, pandas as pd

src, out_xlsx = sys.argv[1], sys.argv[2]
frames = []
with pdfplumber.open(src) as doc:
    for page in doc.pages:
        for tbl in page.extract_tables():
            if tbl and len(tbl) > 1:
                frames.append(pd.DataFrame(tbl[1:], columns=tbl[0]))

if frames:
    pd.concat(frames, ignore_index=True).to_excel(out_xlsx, index=False)
    print(f"已导出 {len(frames)} 张表到 {out_xlsx}")
else:
    print("未检测到表格")
```

不想装 pandas 时，直接 `print(tbl)` 或用标准库 `csv` 写文件即可。

### 3. 合并多个 PDF

```python
import sys
from pypdf import PdfReader, PdfWriter

*inputs, output = sys.argv[1:]   # 最后一个参数是输出路径
writer = PdfWriter()
for path in inputs:
    for page in PdfReader(path).pages:
        writer.add_page(page)
with open(output, "wb") as f:
    writer.write(f)
print(f"已合并 {len(inputs)} 个文件 -> {output}")
```

### 4. 拆分 PDF

```python
import sys, os
from pypdf import PdfReader, PdfWriter

src, out_dir = sys.argv[1], sys.argv[2]
os.makedirs(out_dir, exist_ok=True)
reader = PdfReader(src)
base = os.path.splitext(os.path.basename(src))[0]
for i, page in enumerate(reader.pages, 1):
    w = PdfWriter()
    w.add_page(page)
    dst = os.path.join(out_dir, f"{base}_p{i}.pdf")
    with open(dst, "wb") as f:
        w.write(f)
print(f"共拆分为 {len(reader.pages)} 个单页文件到 {out_dir}")
```

按范围拆分时，把 `reader.pages` 换成切片（如 `reader.pages[0:5]`）并写入一个 writer。

### 5. 旋转页面

```python
import sys
from pypdf import PdfReader, PdfWriter

src, out, deg = sys.argv[1], sys.argv[2], int(sys.argv[3])  # deg: 90/180/270
reader, writer = PdfReader(src), PdfWriter()
for page in reader.pages:
    page.rotate(deg)          # 顺时针
    writer.add_page(page)
with open(out, "wb") as f:
    writer.write(f)
print(f"已将全部页面旋转 {deg} 度 -> {out}")
```

### 6. 加密 / 解密

```python
import sys
from pypdf import PdfReader, PdfWriter

# 加密：python3 job.py enc in.pdf out.pdf 用户密码
# 解密：python3 job.py dec in.pdf out.pdf 原密码
mode, src, out, pwd = sys.argv[1:5]
reader = PdfReader(src)
if mode == "dec":
    if reader.is_encrypted:
        reader.decrypt(pwd)
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
if mode == "enc":
    writer.encrypt(pwd)
with open(out, "wb") as f:
    writer.write(f)
print(f"{mode} 完成 -> {out}")
```

### 7. 读取元数据

```python
import sys
from pypdf import PdfReader

r = PdfReader(sys.argv[1])
m = r.metadata or {}
print("页数:", len(r.pages))
print("标题:", getattr(m, "title", None))
print("作者:", getattr(m, "author", None))
print("主题:", getattr(m, "subject", None))
print("创建工具:", getattr(m, "creator", None))
print("是否加密:", r.is_encrypted)
```

### 8. 填写 PDF 表单

先探明表单字段名，再按名赋值。

```python
import sys
from pypdf import PdfReader

# 第一步：列出字段
fields = PdfReader(sys.argv[1]).get_fields() or {}
for name, f in fields.items():
    print(f"{name}  ({f.get('/FT')})  当前值={f.get('/V')}")
```

```python
import sys, json
from pypdf import PdfReader, PdfWriter

# 第二步：写入。data.json 形如 {"姓名":"张三","日期":"2026-07-11"}
src, out, data_json = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.loads(open(data_json, encoding="utf-8").read())
reader = PdfReader(src)
writer = PdfWriter()
writer.append(reader)
for page in writer.pages:
    writer.update_page_form_field_values(page, data)
with open(out, "wb") as f:
    writer.write(f)
print(f"已填写 {len(data)} 个字段 -> {out}")
```

复选框的值通常是 `/Yes` 或字段自带的导出值，不确定时先用第一步列出字段再赋值。

### 9. 生成新 PDF

简单文本用 canvas，多页排版用 platypus。

```python
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("/tmp/report.pdf", pagesize=A4)
styles = getSampleStyleSheet()
story = [
    Paragraph("报告标题", styles["Title"]),
    Spacer(1, 12),
    Paragraph("这里是正文内容。" * 10, styles["Normal"]),
]
doc.build(story)
print("已生成 /tmp/report.pdf")
```

注意：reportlab 内置字体不含 Unicode 上下标字符（如 ₂ ² 等），会渲染成黑块。需要上下标时用 Paragraph 的 `<sub>` / `<super>` 标签，例如 `Paragraph("H<sub>2</sub>O", styles["Normal"])`。中文若出现方块，需注册中文字体（如系统 STHeiti / 思源黑体）再用。

### 10. PDF 转图片

```python
import sys, os
from pdf2image import convert_from_path

src, out_dir = sys.argv[1], sys.argv[2]
os.makedirs(out_dir, exist_ok=True)
pages = convert_from_path(src, dpi=150)
for i, img in enumerate(pages, 1):
    img.save(os.path.join(out_dir, f"page_{i}.png"), "PNG")
print(f"已渲染 {len(pages)} 页为 PNG 到 {out_dir}")
```

`pdf2image` 依赖系统 poppler，若报错提示找不到 `pdftoppm`，先 `brew install poppler`（macOS）。

### 11. 图片转 PDF

```python
import sys
from PIL import Image

*imgs, out = sys.argv[1:]        # 最后一个是输出 pdf
frames = [Image.open(p).convert("RGB") for p in imgs]
frames[0].save(out, save_all=True, append_images=frames[1:])
print(f"已把 {len(frames)} 张图合成 -> {out}")
```

## 执行约定

1. 先 `Read` 或 `ls` 确认输入 PDF 存在、拿到绝对路径。
2. 跑第 0 步依赖检测，只安装当前任务需要的库。
3. 把对应片段写入临时 `.py`（放到系统临时目录），用 `Bash` 执行并传绝对路径参数。
4. 操作完成后向用户报告输出文件位置和关键结果（页数、导出条数等）。

## 边界

- 扫描件/图片型 PDF 提取不到文本，需要 OCR。可先用第 10 步把页面转成图片，再用 OCR（如 `pytesseract`，需系统 `tesseract`）识别；OCR 属重依赖，先跟用户确认再装。
- 不覆盖数字签名、复杂 XFA 动态表单、PDF/A 归档合规等高级场景——遇到时说明限制。
- 加密相关操作只做技术处理，不用于绕过你无权访问的受版权保护文档。
- 所有写操作输出到新文件，不原地覆盖源 PDF；确需覆盖时先明确告知用户。
- 处理超大文件（数百页）时注意内存，可分批处理。
