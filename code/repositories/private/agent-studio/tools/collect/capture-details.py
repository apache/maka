import json
import re
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent

class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.rows = []
        self.row = None
        self.cell = None
        self.cells = None
        self.header = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        self.stack.append((tag, attributes))
        if tag == 'tr' and attributes.get('data-row-key'):
            self.row = {'microAppId': attributes['data-row-key'], 'picUrl': ''}
            self.cells = []
        if self.row is not None and tag == 'td':
            self.cell = []
        if self.row is not None and tag == 'img' and not self.row['picUrl']:
            self.row['picUrl'] = attributes.get('src', '')
        if tag in ['header', 'aside', 'main']:
            print('SHELL', tag, attributes)

    def handle_data(self, text):
        if self.cell is not None and text.strip():
            self.cell.append(text.strip())

    def handle_endtag(self, tag):
        if tag == 'td' and self.cell is not None:
            self.cells.append(self.cell)
            self.cell = None
        if tag == 'tr' and self.row:
            self.row['cells'] = self.cells
            if self.cells:
                self.row.update(microAppName=self.cells[0][0], description=' '.join(self.cells[2]), modelCode=' '.join(self.cells[3]), status=1 if '已发布' in self.cells[4] else 4, runMode=4, updateDate=' '.join(self.cells[5]))
                self.rows.append(self.row)
            self.row = None
        for index in range(len(self.stack)-1, -1, -1):
            if self.stack[index][0] == tag:
                self.stack = self.stack[:index]
                break

parser = PageParser()
text = (ROOT / 'evidence/page-dom.html').read_text(encoding='utf-8')
parser.feed(text)
(ROOT / 'evidence/visible-agents.json').write_text(json.dumps(parser.rows, ensure_ascii=False, indent=2), encoding='utf-8')
print('Extracted visible rows', len(parser.rows))
print('Head', text[:2000])
index = (ROOT / 'captured/assets/js/index.B_LPe2F7.js').read_text(encoding='utf-8')
print('Module imports', re.findall(r'from["\']([^"\']+)', index)[:40])
facade = (ROOT / 'captured/assets/js/src-_hjT3BN9.js').read_text(encoding='utf-8')
for key in ['B=', 'ze=', 'qe=', 'et=', 'ot=', 'Qo=', 'Nf=', 'e.buttonPermissionList']:
    target = facade if key in facade else index
    pos = target.find(key)
    if pos >= 0:
        print(key, target[max(0,pos-150):pos+2000])
print('Endpoint strings', re.findall(r'url:`([^`]+)`',facade))
