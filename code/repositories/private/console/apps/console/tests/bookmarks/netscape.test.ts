import { describe, expect, it } from 'vitest'
import { parseNetscapeBookmarks } from '@/server/bookmarks/netscape'
import { duplicateKey, urlKey } from '@/server/bookmarks/url-key'

const EXPORT_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3>书签栏</H3>
    <DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000000">GitHub &amp; 学习</A>
        <DT><A HREF='https://single-quoted.com/path/' ADD_DATE="1700000001">单引号属性</A>
        <DT><A HREF="https://empty-title.com">   </A>
        <DT><A HREF="javascript:void(0)">脚本书签</A>
        <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000000">奶酪书签</H3>
        <DL><p>
            <DT><A HREF="https://a.com/x?utm=1" ADD_DATE="1700000002">A 页面</A>
            <DT><H3>子文件夹</H3>
            <DL><p>
                <DT><A HREF="https://deep.io/">深层</A>
            </DL><p>
        </DL><p>
    </DL><p>
    <DT><H3>其他书签</H3>
    <DL><p>
        <DT><A HREF="https://no-date.example/">无时间戳</A>
    </DL><p>
</DL><p>`

describe('parseNetscapeBookmarks', () => {
  const parsed = parseNetscapeBookmarks(EXPORT_HTML)

  it('解析出全部有效书签，跳过 javascript: 协议', () => {
    expect(parsed).toHaveLength(6)
    expect(parsed.map((p) => p.url)).not.toContain('javascript:void(0)')
  })

  it('深度 1 结构层（书签栏/其他书签）不进分类，深层用 / 串接', () => {
    const github = parsed.find((p) => p.url === 'https://github.com/')!
    expect(github.category).toBe('')
    const a = parsed.find((p) => p.url === 'https://a.com/x?utm=1')!
    expect(a.category).toBe('奶酪书签')
    const deep = parsed.find((p) => p.url === 'https://deep.io/')!
    expect(deep.category).toBe('奶酪书签/子文件夹')
  })

  it('ADD_DATE 秒级时间戳转 ISO；缺失为 null', () => {
    const github = parsed.find((p) => p.url === 'https://github.com/')!
    expect(github.addedAt).toBe('2023-11-14T22:13:20.000Z')
    const noDate = parsed.find((p) => p.url === 'https://no-date.example/')!
    expect(noDate.addedAt).toBeNull()
  })

  it('实体解码、单双引号属性、空标题回退 URL', () => {
    const github = parsed.find((p) => p.url === 'https://github.com/')!
    expect(github.title).toBe('GitHub & 学习')
    expect(parsed.find((p) => p.url === 'https://single-quoted.com/path/')!.title).toBe('单引号属性')
    expect(parsed.find((p) => p.url === 'https://empty-title.com')!.title).toBe('https://empty-title.com')
  })
})

describe('urlKey / duplicateKey', () => {
  it('urlKey：trim + 去尾斜杠，其余保持精确', () => {
    expect(urlKey('  https://a.com/x/  ')).toBe('https://a.com/x')
    expect(urlKey('https://a.com/')).toBe('https://a.com')
    expect(urlKey('http://a.com/x')).not.toBe(urlKey('https://a.com/x'))
    expect(urlKey('https://a.com/x?b=1')).toBe('https://a.com/x?b=1')
  })

  it('duplicateKey：忽略协议/www/查询参数/锚点，只看主机+路径', () => {
    expect(duplicateKey('http://www.a.com/x?utm=1#top')).toBe(duplicateKey('https://a.com/x/'))
    expect(duplicateKey('https://a.com/x')).not.toBe(duplicateKey('https://a.com/y'))
    expect(duplicateKey('不是URL')).toBe('raw:不是URL')
  })
})
