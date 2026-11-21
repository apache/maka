/**
 * Netscape 书签文件（浏览器"导出书签"HTML）解析器：零依赖，正则词法 + 文件夹栈。
 * Chrome/Edge/Firefox 导出的书签 HTML 都是该格式的方言。
 */

export interface ParsedBookmark {
  title: string
  url: string
  /** 原文件夹路径（剥掉结构层后用 / 串接），如 "奶酪书签/子文件夹"；书签栏顶层直接放的书签为 '' */
  category: string
  /** 导出文件里的 ADD_DATE（ISO）；缺失或非法时为 null，由导入服务回填 now */
  addedAt: string | null
}

const TOKEN_RE = /<a\s+([^>]*)>([^<]*)<\/a>|<h3[^>]*>([^<]*)<\/h3>|<dl[^>]*>?|<\/dl[^>]*>/gi

/** 属性形如 name="v" / name='v' / name=v，一次扫完建小写键 map */
const ATTR_RE = /([a-zA-Z_][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g

/** 容错的实体解码：数值型先解，命名型后解；&amp; 放最后避免双重解码 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function readAttrs(attrs: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of attrs.matchAll(ATTR_RE)) {
    map.set(m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''))
  }
  return map
}

/** 栈底两层是结构（根 DL + 书签栏/其他书签），用户的文件夹从第三层起，用 / 串接成分类 */
function categoryOf(stack: string[]): string {
  return stack.slice(2).filter(Boolean).join('/')
}

/** 书签不该进管理器的协议：脚本书签与 Firefox 内部 place: 调用 */
const SKIP_URL_RE = /^(javascript:|place:|data:)/i

export function parseNetscapeBookmarks(html: string): ParsedBookmark[] {
  const out: ParsedBookmark[] = []
  const stack: string[] = [] // DL 栈；元素为认领到的 H3 名（匿名层为 ''）
  let pending: string | null = null // 最近一个 <H3> 名，等后续 <DL> 认领
  for (const m of html.matchAll(TOKEN_RE)) {
    if (m[3] !== undefined) {
      pending = decodeEntities(m[3]).trim()
    } else if (m[1] !== undefined) {
      const attrs = readAttrs(m[1])
      const url = (attrs.get('href') ?? '').trim()
      if (!url || SKIP_URL_RE.test(url)) continue
      let addedAt: string | null = null
      const raw = attrs.get('add_date')
      if (raw) {
        const n = Number(raw)
        // 标准是秒级时间戳；个别工具导毫秒，按量级判
        if (Number.isFinite(n) && n > 0) {
          addedAt = new Date(n > 1e12 ? n : n * 1000).toISOString()
        }
      }
      // 空标题（导出常见）回退为 URL
      const title = decodeEntities(m[2]).trim() || url
      out.push({ title, url, category: categoryOf(stack), addedAt })
    } else if (m[0].charAt(1) === '/') {
      stack.pop()
      pending = null
    } else {
      stack.push(pending ?? '')
      pending = null
    }
  }
  return out
}
