/** HTML -> markdown for job descriptions (cheerio DOM). Mirrors the extension's markdown.js. */
import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'table', 'tr', 'ul', 'ol', 'dl', 'dd', 'dt', 'hr'])
const HEADING: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'button', 'iframe', 'template', 'icon', 'img'])

type Ctx = { listDepth: number; listType: string | null; counters: Record<number, number> }

function walk(node: AnyNode, out: string[], ctx: Ctx): void {
  if (node.type === 'text') {
    const t = (node as { data: string }).data.replace(/\s+/g, ' ')
    if (t) out.push(t)
    return
  }
  if (node.type !== 'tag') return
  const el = node as { name: string; children: AnyNode[] }
  const tag = el.name.toLowerCase()
  if (SKIP.has(tag)) return
  const kids = el.children || []
  if (tag === 'br') return void out.push('\n')
  if (tag === 'hr') return void out.push('\n\n---\n\n')
  if (HEADING[tag]) {
    out.push('\n\n' + '#'.repeat(HEADING[tag]) + ' ')
    for (const c of kids) walk(c, out, ctx)
    out.push('\n\n')
    return
  }
  if (tag === 'li') {
    const depth = ctx.listDepth || 0
    const indent = '  '.repeat(Math.max(0, depth - 1))
    let marker = '- '
    if (ctx.listType === 'ol') {
      ctx.counters[depth] = (ctx.counters[depth] || 0) + 1
      marker = ctx.counters[depth] + '. '
    }
    out.push('\n' + indent + marker)
    for (const c of kids) walk(c, out, ctx)
    return
  }
  if (tag === 'ul' || tag === 'ol') {
    const prev = { listDepth: ctx.listDepth, listType: ctx.listType }
    ctx.listDepth = prev.listDepth + 1
    ctx.listType = tag
    ctx.counters[ctx.listDepth] = 0
    out.push('\n')
    for (const c of kids) walk(c, out, ctx)
    out.push('\n')
    ctx.listDepth = prev.listDepth
    ctx.listType = prev.listType
    return
  }
  if (tag === 'strong' || tag === 'b') {
    const inner: string[] = []
    for (const c of kids) walk(c, inner, ctx)
    const s = inner.join('').trim()
    if (s) out.push('**' + s + '**')
    return
  }
  if (tag === 'em' || tag === 'i') {
    const inner: string[] = []
    for (const c of kids) walk(c, inner, ctx)
    const s = inner.join('').trim()
    if (s) out.push('_' + s + '_')
    return
  }
  if (BLOCK.has(tag)) {
    out.push('\n')
    for (const c of kids) walk(c, out, ctx)
    out.push('\n')
    return
  }
  for (const c of kids) walk(c, out, ctx)
}

export function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html, null, false)
  const out: string[] = []
  const ctx: Ctx = { listDepth: 0, listType: null, counters: {} }
  for (const n of $.root().contents().toArray()) walk(n, out, ctx)
  return out
    .join('')
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/^ +| +$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
