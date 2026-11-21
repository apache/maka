"""归档状态、相对链接、导航与验收。所有检查与恢复演练均留在本目录。"""
from pathlib import Path
from urllib.parse import unquote
import hashlib, html, json, os, re, sys, unicodedata, zipfile
from migrate_materials import ROOT, DATA, safe, write

ROWS=json.loads((DATA/'03-迁移映射.json').read_text(encoding='utf-8'))
BYOLD={x['old']:x['new'] for x in ROWS}
BYNEW={x['new']:x['old'] for x in ROWS}
EVENTS=[]
ACTIVE=['00-事实与简历','01-AI项目与Agent工程','02-传统前端基本盘','03-题库与系统设计','04-表达与模拟','05-十月求职执行']
INLINE=re.compile(r'(?P<image>!?)\[(?P<label>[^\]\n]*)\]\((?P<url><[^>\n]*>|(?:[^()\n]|\([^()\n]*\))*)\)')
REF=re.compile(r'^(\s*\[[^\]]+\]:\s*)(\S+)(.*)$',re.M)
HTML=re.compile(r'\b(href|src)\s*=\s*([\"\'])(.*?)\2',re.I)

def segments(t):
    """只转换可见Markdown，不碰围栏里的历史代码。"""
    chunks=[]; current=[]; fence=None
    for line in t.splitlines(keepends=True):
        m=re.match(r'^\s{0,3}(`{3,}|~{3,})',line)
        if m and fence is None:
            if current:chunks.append((False,''.join(current)));current=[]
            fence=m.group(1);current.append(line)
        elif m and fence and m.group(1)[0]==fence[0] and len(m.group(1))>=len(fence):
            current.append(line);chunks.append((True,''.join(current)));current=[];fence=None
        else:current.append(line)
    if current:chunks.append((fence is not None,''.join(current)))
    return chunks

def slug(s):
    s=re.sub(r'<[^>]*>','',s);s=INLINE.sub(lambda m:m['label'],s)
    s=s.strip().lower().replace('`','')
    return ''.join(c for c in s if c in '-_ ' or unicodedata.category(c)[0] in 'LN').replace(' ','-')

def anchors(t):
    result=set(re.findall(r'\bid=[\"\']([^\"\']+)',t)); seen={}
    for code,part in segments(t):
        if code:continue
        for m in re.finditer(r'^#{1,6}\s+(.+?)\s*#*$',part,re.M):
            s=slug(m[1]);n=seen.get(s,0);seen[s]=n+1
            result.add(s+(f'-{n}' if n else ''))
    return result

def split_url(raw):
    raw=raw.strip()
    if raw.startswith('<') and raw.endswith('>'):raw=raw[1:-1]
    raw=re.sub(r'\s+[\"\'].*[\"\']$','',raw)
    if re.match(r'^(https?://|//|mailto:|data:|tel:)',raw,re.I):return None
    path,sep,fragment=raw.partition('#')
    return unquote(path.split('?')[0]),unquote(fragment) if sep else ''

def resolve(file,url,old_context=False):
    parsed=split_url(url)
    if parsed is None:return None
    path,frag=parsed
    if not path:return file,frag
    origin=ROOT/BYNEW[file.relative_to(ROOT).as_posix()] if old_context and file.relative_to(ROOT).as_posix() in BYNEW else file
    if path.lower().startswith('file:///'):path=path[8:]
    p=Path(path)
    if not p.is_absolute():p=origin.parent/p
    p=p.resolve()
    if not p.is_relative_to(ROOT):return p,frag
    rel=p.relative_to(ROOT).as_posix()
    if old_context and rel in BYOLD:p=ROOT/BYOLD[rel]
    return p,frag

def archive_headers():
    snapshot=zipfile.ZipFile(DATA/'01-迁移前原始文件快照.zip')
    for x in ROWS:
        if not x['new'].endswith('.md'):continue
        p=safe(x['new']);t=snapshot.read(x['old']).decode('utf-8-sig').replace('\r\n','\n')
        # 归档顶层状态权威；原文与原元数据的逐字节版本在迁移快照中。
        t=re.sub(r'^\s*---\n.*?\n---\s*\n','',t,count=1,flags=re.S)
        t=re.sub(r'(?m)^status:\s*active\s*$',f"status: {x['status']}",t)
        replacement=x['replacement'] or 'README.md'
        dest=os.path.relpath(ROOT/replacement,p.parent).replace('\\','/')
        banner=f"---\nstatus: {x['status']}\noriginal_path: {json.dumps(x['old'],ensure_ascii=False)}\nmigration_date: 2026-09-19\n---\n\n> 归档材料：{x['reason']}。旧日期、数字与‘最新’措辞仅代表当时版本；当前使用[替代入口]({dest})。原始字节见迁移前快照。\n\n"
        # 先以旧目录解析原文引用，再添加以新目录为上下文的归档导航。
        t=transform_links(p,t,True)
        write(x['new'],banner+t)
    snapshot.close()

def transform_links(p,t,old):
        rel=p.relative_to(ROOT).as_posix();out=[]
        def target(raw):
            v=resolve(p,raw,old)
            if v is None:return raw,None
            dst,frag=v
            if not dst.is_relative_to(ROOT) or not dst.exists():
                return None,'outside-root' if not dst.is_relative_to(ROOT) else 'missing-file'
            if frag and dst.suffix.lower()=='.md' and frag not in anchors(dst.read_text(encoding='utf-8-sig')):
                EVENTS.append(dict(file=rel,original=raw,action='移除失效锚点，保留文件入口'))
                frag=''
            new=('#'+frag) if dst==p and frag else os.path.relpath(dst,p.parent).replace('\\','/')+('#'+frag if frag else '')
            if new!=raw:EVENTS.append(dict(file=rel,original=raw,target=new,action='按迁移映射修复引用'))
            return new,None
        def inline(m):
            url,err=target(m['url'])
            if err:
                EVENTS.append(dict(file=rel,original=m['url'],action=err+'；保留为非链接历史引用'))
                return m['label']+'（原引用待核：`'+m['url'].replace('`','')+'`）'
            return m['image']+'['+m['label']+']('+url+')'
        def reference(m):
            url,err=target(m[2])
            if err:
                EVENTS.append(dict(file=rel,original=m[2],action=err+'；引用定义转注释'))
                return '<!-- 原引用待核: '+m[0].replace('--','—')+' -->'
            return m[1]+url+m[3]
        def html_link(m):
            url,err=target(html.unescape(m[3]))
            if err:
                EVENTS.append(dict(file=rel,original=m[3],action=err+'；HTML属性改为历史记录'))
                return 'data-original-'+m[1]+'='+m[2]+m[3]+m[2]
            return m[1]+'='+m[2]+html.escape(url,quote=True)+m[2]
        for code,part in segments(t):
            if code:out.append(part);continue
            # 行内代码也是历史样例，不能把示例HTML的属性当实际链接改写。
            pieces=re.split(r'(`+[^`\n]+`+)',part)
            out.append(''.join(s if i%2 else HTML.sub(html_link,REF.sub(reference,INLINE.sub(inline,s))) for i,s in enumerate(pieces)))
        return ''.join(out)

def fix_links():
    write('assets/evidence/04-链接修复记录.json',json.dumps(EVENTS,ensure_ascii=False,indent=2))
    print('LINK REPAIRS:',len(EVENTS))

def navigation():
    core=[
    ('00-事实与简历/00-个人事实基线.md','身份、任职与归属唯一入口'),
    ('00-事实与简历/01-关天豪-AI应用工程师-主简历.md','AI主简历'),
    ('00-事实与简历/02-关天豪-Web前端工程师-保底简历.md','Web保底简历'),
    ('00-事实与简历/03-自我介绍-60秒与120秒.md','自我介绍'),
    ('01-AI项目与Agent工程/00-AI项目地图.md','项目选材'),
    ('01-AI项目与Agent工程/01-美业智能体平台.md','平台职责'),
    ('01-AI项目与Agent工程/02-AI音频编辑-Node-BFF.md','Node任务链路'),
    ('01-AI项目与Agent工程/05-qoder-proxy-api.md','文本协议网关'),
    ('01-AI项目与Agent工程/07-Agentic与Context-Engineering.md','上下文与验证'),
    ('03-题库与系统设计/00-P0-必背.md','前端基础题'),
    ('03-题库与系统设计/02-AI-Agent高频追问.md','AI专项题'),
    ('04-表达与模拟/01-项目讲述库.md','口述入口'),
    ('05-十月求职执行/00-十月冲刺计划.md','十月执行计划')]
    intro='''# 十月面试宝典：AI应用 / Agent工程（Web + Node）

事实先于表达。任职日期已由本人确认；年限统一为“2018 年起从事 Web 开发”。本轮重组文档，不把旧报告当新实测，也不将学习计划升级为项目经历。

## 每日训练主线：13个入口

'''+ '\n'.join(f'{i}. [{label}]({path})' for i,(path,label) in enumerate(core,1))
    intro+='\n\n## 六个分区\n\n'+ '\n'.join(f'- [{d}](#{slug(d)})' for d in ACTIVE)
    for d in ACTIVE:
        intro+='\n\n## '+d+'\n\n'
        for p in sorted((ROOT/d).glob('*.md')):
            intro+=f'- [{p.stem}]({p.relative_to(ROOT).as_posix()})\n'
        if d=='03-题库与系统设计':intro+='- [综合模拟面试](03-题库与系统设计/04-综合模拟面试/README.md)\n'
    intro+='''
## 模板与写作约定

题目用“结论—机制—反例—本人案例—边界”；项目用“30秒—2分钟—架构—难点—追问—证据”。身份与日期只维护事实基线，数字集中到证据登记，派生简历由一致性检查约束。练习与投递记录只填真实发生的结果。

## 归档与验收

- [迁移日志](MIGRATION-LOG.md)：移动、合并、新建、待核验与验收。
- [归档索引](archive/README.md)：旧版本与证据定位，不属于每日训练。
- [待核验清单](00-事实与简历/06-待核验清单.md)：高风险信息解除条件。
- [原始附件说明](assets/README.md)：保留原始字节与私人资料边界。
- [执行方案](2026-10-面试宝典-AI方向重构与归档方案.md)：历史方案；年限示例已由本人本轮确认修订。

本地链接验收覆盖文件与章节锚点；历史外部网页仅保留来源，不把其可访问性当本轮已验证。目录外源码不在本次读取和迁移范围，项目能力核验需另行提供证据。
'''
    write('README.md',intro)
    archive='''# 归档索引

归档用于保留历史和追溯来源，不继续作为当前简历事实入口。所有活跃口径回到[个人事实基线](../00-事实与简历/00-个人事实基线.md)。

## 状态

- `superseded`：合并重写，旧版本保留。
- `historical`：带日期的历史快照。
- `reference-only`：仅供归属和证据核对。
- `needs-verification`：含个人事实、技术归属或量化疑点。
- `raw-evidence`：原始附件，内容不润色。

历史正文可能含旧日期、错误答案、敏感信息和原来的“最新/可直接复制”措辞；顶层归档状态优先，逐字节原稿在原始快照中。归档过程仅修元数据和链接，不将旧事实悄悄改成新结论。

## 逐文件迁移表

| 原路径 | 新路径 | 状态 | 原因 | 替代入口 |
|---|---|---|---|---|
'''
    for x in ROWS:
        if '/tool-state/' in x['new']:continue
        new=os.path.relpath(ROOT/x['new'],ROOT/'archive').replace('\\','/')
        repl=os.path.relpath(ROOT/(x['replacement'] or 'README.md'),ROOT/'archive').replace('\\','/')
        archive+=f"| `{x['old']}` | [{x['new']}]({new}) | `{x['status']}` | {x['reason']} | [入口]({repl}) |\n"
    archive+='\n## 工具状态与恢复副本\n\n6个原始`.mimosa`状态JSON独立保存在raw-evidence下的tool-state中，不建立知识链接；逐文件哈希保留在机器盘点与迁移映射。rollback-check为恢复演练副本，仅供机器哈希核对；工具状态、恢复副本与Python缓存由本目录.gitignore排除日常检索。\n'
    write('archive/README.md',archive)
    write('assets/README.md',r'''# 原始附件与迁移证据

原有2份业务证据JSON、3份XLSX、1份JPG和1份历史ZIP全部保留；工具状态JSON另存，未混入学习资料。附件可能含私人联系和招聘信息，不作为公开简历附件。

- evidence：原始评审JSON、迁移前盘点、原始文件快照、路径映射、链接修复与验证结果。
- spreadsheets：历史工作簿，未修改单元格。
- screenshots：原始沟通截图，未编辑图像。
- 历史简历ZIP保留在archive/历史简历/raw。

迁移前快照完整保留本次开始时磁盘上的99个文件，包括未提交的16号修改。原有删除项仅记录、不恢复。可执行文档验收：

```powershell
$env:PYTHONIOENCODING="utf-8"
python .\assets\evidence\finalize_migration.py verify
```

迁移生成脚本是本轮可复现记录，不应在手改资料后无检查重跑；日常只运行verify。事实字段先改唯一基线，再有针对性同步派生文档。
''')
    plan=safe('2026-10-面试宝典-AI方向重构与归档方案.md')
    t=plan.read_text(encoding='utf-8-sig')
    if '执行勘误（2026-09-19）' not in t:
        t=t.replace('\n','\n\n> 执行勘误（2026-09-19）：三段任职日期已获本人确认；年限采用“2018 年起从事 Web 开发”，覆盖下文历史方案中的8年+示例。实际盘点99文件/85 Markdown，执行结果见[MIGRATION-LOG](MIGRATION-LOG.md)。\n',1)
        write(plan.relative_to(ROOT),t)

def verify():
    errors=[];local=0;external=0;mdcount=0
    for p in ROOT.rglob('*.md'):
        if 'rollback-check' in p.parts:continue
        mdcount+=1;t=p.read_text(encoding='utf-8-sig')
        for code,part in segments(t):
            if code:continue
            part=re.sub(r'`+[^`\n]+`+','',part)
            urls=[m['url'] for m in INLINE.finditer(part)]+[m[2] for m in REF.finditer(part)]+[html.unescape(m[3]) for m in HTML.finditer(part) if not part[max(0,m.start()-14):m.start()].endswith('data-original-')]
            for u in urls:
                v=resolve(p,u)
                if v is None:external+=1;continue
                local+=1;dst,frag=v
                if not dst.is_relative_to(ROOT) or not dst.exists():errors.append(f'{p.relative_to(ROOT)} -> {u}')
                elif frag and dst.suffix.lower()=='.md' and frag not in anchors(dst.read_text(encoding='utf-8-sig')):errors.append(f'anchor: {p.relative_to(ROOT)} -> {u}')
    originals=json.loads((DATA/'00-迁移前完整盘点.json').read_text(encoding='utf-8'))
    with zipfile.ZipFile(DATA/'01-迁移前原始文件快照.zip') as z:
        for x in originals:
            if hashlib.sha256(z.read(x['path'])).hexdigest()!=x['sha256']:errors.append('snapshot hash:'+x['path'])
    raw=0
    for x in ROWS:
        p=safe(x['new'])
        if not p.is_file():errors.append('missing migrated:'+x['new']);continue
        if p.suffix.lower()!='.md':
            raw+=1
            if hashlib.sha256(p.read_bytes()).hexdigest()!=x['sha256']:errors.append('raw hash:'+x['new'])
        elif not re.search(r'^status: (superseded|historical|reference-only|needs-verification)\s*$',p.read_text(encoding='utf-8')[:500],re.M):errors.append('archive status:'+x['new'])
    facts=safe('00-事实与简历/00-个人事实基线.md').read_text(encoding='utf-8')
    data=json.loads(re.search(r'```json\n(.*?)\n```',facts,re.S).group(1))
    for name in ('01-关天豪-AI应用工程师-主简历.md','02-关天豪-Web前端工程师-保底简历.md'):
        t=safe('00-事实与简历/'+name).read_text(encoding='utf-8')
        if data['experience_label'] not in t:errors.append('experience:'+name)
        for c in data['career']:
            section=re.search(r'^### '+re.escape(c['company'])+r'\s*\n(.*?)(?=^##|\Z)',t,re.M|re.S)
            if section is None or c['period'] not in section[1]:errors.append('career:'+name+':'+c['company'])
        if re.search(r'7\s*年经验|8\s*年\+|2025\s*年\s*11|2025\.11|\d+\s*%',t):errors.append('stale resume claim:'+name)
    for d in ACTIVE:
        for p in (ROOT/d).rglob('*.md'):
            t=p.read_text(encoding='utf-8')
            if not re.search(r'^status: active$',t[:300],re.M):errors.append('active metadata:'+str(p))
            if re.search(r'(?:qoder_pat|qpa_|pt-)[A-Za-z0-9_-]{20,}',t):errors.append('credential pattern:'+str(p))
            if any(ord(c)<32 and c not in '\n\r\t' for c in t):errors.append('control character:'+str(p))
    # 最小回归检查：历史代码不改写、外链识别和新旧目录映射。
    sample=safe('archive/历史复习资料/01-索引与记录/02-建立面试题复习索引.md')
    resolved=resolve(sample,'../02-高频清单/01-P0-必背题目.md',True)
    assert resolved[0]==safe(BYOLD['02-高频清单/01-P0-必背题目.md'])
    code='`<link rel="dns-prefetch" href="//example.com">`'
    assert transform_links(sample,code,True)==code
    assert split_url('//example.com') is None
    # 副本恢复测试：所有文件写入本目录内专用副本，逐字节读取复核，不触及当前材料。
    restore=ROOT/'archive/raw-evidence/rollback-check'
    with zipfile.ZipFile(DATA/'01-迁移前原始文件快照.zip') as z:
        for x in originals:
            dst=(restore/x['path']).resolve()
            assert dst.is_relative_to(restore.resolve())
            dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(z.read(x['path']))
            if hashlib.sha256(dst.read_bytes()).hexdigest()!=x['sha256']:errors.append('restore:'+x['path'])
    result={'status':'PASS' if not errors else 'FAIL','original_files':len(originals),'original_markdown':sum(x['path'].endswith('.md') for x in originals),'moved':len(ROWS),'git_mv':sum(x['method']=='git mv' for x in ROWS),'raw_hashes_passed':raw,'markdown_reopened':mdcount,'local_links_checked':local,'external_links_preserved_not_live_checked':external,'restored_copy_files':len(originals),'restore_location':'archive/raw-evidence/rollback-check','errors':errors}
    write('assets/evidence/05-验收结果.json',json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return not errors

def log():
    r=json.loads((DATA/'05-验收结果.json').read_text(encoding='utf-8')) if (DATA/'05-验收结果.json').exists() else {}
    events=json.loads((DATA/'04-链接修复记录.json').read_text(encoding='utf-8')) if (DATA/'04-链接修复记录.json').exists() else []
    newdocs=[p for d in ACTIVE for p in (ROOT/d).rglob('*.md')]
    s='''# MIGRATION-LOG：十月AI方向重构

执行日期：2026-09-19。根目录：`E:\\guahub\\docs\\temp\\面试宝典`。仅修改该目录及git mv所需仓库索引，本次助手未执行提交或推送。

## 决策与事实

- 先完整读取85份Markdown正文，盘点99个文件与SHA-256；随后检查正文主题、归属、数字与引用，不按文件名直接判定事实。
- 用户本轮明确确认：德奥2018.07—2022.02、希音2022.03—2025.10、数联天下2026.04—至今。年限选择“2018 年起从事 Web 开发”，不使用8年+示例。
- 16号作为AI简历母版，13号提供Web简历模板；联系方式与左右栏排版沿母版，旧原文均归档，原始字节在快照中。
- 原始履历中的百分比、带人职责、PromptFlow、混合项目来源、qoder最新工具闭环、PR当前状态等进入待核验。
- 本轮未读取目录外项目源码，也未重跑业务项目测试。知识性纠正参考React、MDN与web.dev官方文档，来源链接在对应主题页。

## 初始状态与例外

- 16号存在用户/上一轮未提交修改，快照和迁移均保留其工作区字节。
- 两份PDF及根目录旧希音总结在本轮前已是Git删除状态；不恢复、不计入本次删除。实际存在于09目录的希音总结按未跟踪文件迁移。
- 6个`.mimosa`状态JSON独立迁到工具状态区，不进入知识导航；迁移后只清除经确认无文件的旧目录壳，不删除原始文件，不执行递归删除。
- 恢复演练副本从assets/evidence以git mv移入archive/raw-evidence/rollback-check；它是本轮新增审计副本，不计入97个原文件迁移数。.gitignore排除机器副本、工具状态与Python缓存的日常检索。
- git mv首次因索引锁写权限失败；取得所需执行授权后完成。已跟踪文件使用git mv，原先未跟踪/忽略文件使用受边界检查的原生rename。
- 本轮盘点脚本首次显示输出遇到控制台编码问题，原始快照与盘点已写成功；随后用UTF-8重新读取展示并完成验收。

## 移动与归档

'''+f"迁移{len(ROWS)}个文件：{sum(x['method']=='git mv' for x in ROWS)}个git mv，{sum(x['method']!='git mv' for x in ROWS)}个原生rename。逐项旧路径、新路径、状态、原因与替代入口见[归档迁移表](archive/README.md)，精确操作方式见[机器映射](assets/evidence/03-迁移映射.json)。\n\n"
    s+='''## 合并关系

| 新区 | 来源 | 处理 |
|---|---|---|
| 事实与简历 | 13/14/16/18、用户本轮确认、同事归属素材 | 单一事实源、两版简历、证据与待核验分离 |
| AI项目 | 平台亮点、14/16/17/18/20/21、学习地图 | 按职责建立项目卡；旧17号重复标题不带入新图表 |
| 前端基本盘 | 领域题、传统项目总结、技术问答 | 提炼通用原理与有来源项目，PLM等归属疑点退出实绩 |
| 题库 | P0/P1/AI30题、05技术问答、综合方案 | 重写35+20+30题、4设计题、5套模拟，示例与实绩分开 |
| 表达 | 旧话术、22/23、自我介绍、反问 | 去重复、去绝对化、按职责表达，不复用待证比例 |
| 求职执行 | 旧复盘、投递模板、学习地图 | 建十月计划与空记录；旧市场表只归档 |

## 新建活跃文档

'''
    for p in sorted(newdocs):s+=f'- [{p.relative_to(ROOT).as_posix()}]({p.relative_to(ROOT).as_posix()})\n'
    s+='\n## 逐文件内容盘点\n\n'
    original=json.loads((DATA/'00-迁移前完整盘点.json').read_text(encoding='utf-8'))
    s+='每份Markdown已完整解码，原始正文在快照；以下列正文标题摘要，完整章节与风险行号见[盘点JSON](assets/evidence/00-迁移前完整盘点.json)。\n\n'
    s+='| 原文件 | 行数 | 正文主题摘录 |\n|---|---:|---|\n'
    for x in original:
        if 'chars' not in x:continue
        topics=' / '.join(h['text'].lstrip('# ') for h in x['headings'][:3]).replace('|','/')
        s+=f"| `{x['path']}` | {x['lines']} | {topics or '散文/记录型正文'} |\n"
    s+='\n## 链接处理\n\n'
    s+=f'按旧上下文和迁移映射重写本地链接，共记录{len(events)}处引用调整，逐项保留原目标和新目标。原本缺失且无可靠目标时才降为非点击历史说明，不伪造目标。详见[修复记录](assets/evidence/04-链接修复记录.json)。外部HTTP链接不逐一联网验活；代码块与行内代码保持为原始示例。\n'
    s+=r'''
## 验证与恢复

```powershell
$env:PYTHONIOENCODING="utf-8"
python .\assets\evidence\finalize_migration.py verify
git -c core.autocrlf=false -c core.quotepath=false diff --check -- .
git -c core.autocrlf=false -c core.quotepath=false diff --cached --check -- .
```

'''+f"最近文档验收：`{r.get('status','待执行')}`；原始快照{r.get('original_files',0)}文件、迁移{r.get('moved',0)}文件、原始非Markdown哈希{r.get('raw_hashes_passed',0)}项、本地链接{r.get('local_links_checked',0)}项、恢复副本{r.get('restored_copy_files',0)}文件。完整结果见[验收JSON](assets/evidence/05-验收结果.json)。\n"
    s+='''
原始快照位于assets/evidence/01-迁移前原始文件快照.zip。恢复演练已在archive/raw-evidence/rollback-check内展开，并逐个核对99个SHA-256，未覆盖重构后的文件。恢复副本属于机器审计区，不进入知识检索。整目录恢复需先保存后续新改动：根据映射逆向移动，再从快照恢复原有字节；新生成资料保留为另一版本。不要使用全仓reset或直接覆盖当前工作区。Git索引的回退应仅针对迁移清单中的路径，保留本轮前的删除项与用户修改。

三条验收命令的实际输入、工作目录、标准输出、错误输出与退出码见[检查命令记录](assets/evidence/06-检查命令结果.json)。命令记录不代表目录外业务项目已通过测试。

## 待核验与后续

[待核验清单](00-事实与简历/06-待核验清单.md)列明每项解除条件。更新事实先改基线，更新数字先改证据登记，再同步派生材料。副本与原始快照是审计资产，不进入每日训练。
'''
    write('MIGRATION-LOG.md',s)

if __name__=='__main__':
    phase=sys.argv[1] if len(sys.argv)>1 else 'finalize'
    if phase=='verify':sys.exit(0 if verify() else 1)
    elif phase=='log':log()
    else:
        archive_headers();navigation();log();fix_links();log()
        sys.exit(0 if verify() else 1)
