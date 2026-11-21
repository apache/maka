import type {
  FamilyChild,
  FamilyChildGender,
  FamilyHousehold,
  FamilyLineage,
  FamilyTree
} from '@/features/date-playbook/domain/types'

export function createEmptyFamilyTree(): FamilyTree {
  return {
    enabled: false,
    title: '',
    motto: '',
    paternal: [],
    maternal: []
  }
}

function decode(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstMatch(html: string, pattern: RegExp): string {
  const matched = pattern.exec(html)
  return matched ? decode(matched[1]) : ''
}

function sectionHtml(html: string, headingId: string): string {
  const start = html.indexOf(`id="${headingId}"`)
  if (start < 0) return ''
  const nextSection = html.indexOf('<section', start + 1)
  return nextSection < 0 ? html.slice(start) : html.slice(start, nextSection)
}

function parseGender(className: string): FamilyChildGender {
  return className.includes('child--boy') ? 'boy' : 'girl'
}

function parseChild(chunk: string): FamilyChild {
  const className = /class="(child [^"]+)"/.exec(chunk)?.[1] || ''
  const orderText = firstMatch(chunk, /child__badge[^>]*>([\s\S]*?)<\/div>/)
  const order = Number.parseInt(orderText, 10) || 0
  const spouseRaw = firstMatch(chunk, /child__spouse[^>]*>([\s\S]*?)<\/div>/)
  const spouse = spouseRaw.replace(/^配偶[：:]/, '').trim()
  return {
    order,
    gender: parseGender(className),
    name: firstMatch(chunk, /child__name[^>]*>([\s\S]*?)<\/div>/),
    spouse: spouse || undefined,
    isSelf: className.includes('child--self') || undefined,
    grandchildren: []
  }
}

function parseHousehold(cardHtml: string, lineage: FamilyLineage, index: number): FamilyHousehold {
  const nameHtml = /family-card__name[^>]*>([\s\S]*?)<\/div>/.exec(cardHtml)?.[1] || ''
  const title = decode(nameHtml.replace(/<small>[\s\S]*?<\/small>/g, ' '))
  const relationNote = firstMatch(cardHtml, /family-card__relation[^>]*>([\s\S]*?)<\/div>/)
  const childrenStart = cardHtml.indexOf('class="children"')
  const childrenHtml = childrenStart < 0 ? '' : cardHtml.slice(childrenStart)
  const chunks = childrenHtml
    .split(/(?=<div class="(?:child |grandchild"))/)
    .filter((chunk) => /class="(?:child |grandchild")/.test(chunk))

  const children: FamilyChild[] = []
  chunks.forEach((chunk) => {
    if (chunk.includes('class="grandchild"')) {
      const label = decode(chunk)
      const last = children[children.length - 1]
      if (label && last) last.grandchildren.push({ label })
      return
    }
    children.push(parseChild(chunk))
  })

  return {
    id: `${lineage}-${index + 1}`,
    lineage,
    title,
    deceased: /已故/.test(nameHtml),
    relationNote: relationNote || undefined,
    children
  }
}

function parseLineage(html: string, headingId: string, lineage: FamilyLineage): FamilyHousehold[] {
  const section = sectionHtml(html, headingId)
  return [...section.matchAll(/<article class="family-card">([\s\S]*?)<\/article>/g)].map((matched, index) =>
    parseHousehold(matched[1], lineage, index)
  )
}

/** 把家庭关系 HTML 收成卡片数据。只保留称谓、姓名、关系，不含聊天原文。 */
export function parseFamilyTreeHtml(html: string): FamilyTree {
  const paternal = parseLineage(html, 'paternal-title', 'paternal')
  const maternal = parseLineage(html, 'maternal-title', 'maternal')
  const title = firstMatch(html, /<h1>([\s\S]*?)<\/h1>/) || firstMatch(html, /<title>([\s\S]*?)<\/title>/)
  const motto = firstMatch(html, /<header[^>]*class="hero"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/)
  const year = /\b(20\d{2})\b/.exec(firstMatch(html, /<footer[\s\S]*?>([\s\S]*?)<\/footer>/) || html)?.[1]
  const enabled = paternal.length + maternal.length > 0
  return {
    enabled,
    title: enabled ? title : '',
    motto: enabled ? motto : '',
    year,
    paternal,
    maternal
  }
}
