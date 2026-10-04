// Finishes the SVG of a diagram export: html-to-image copies every computed style property onto
// every element but those of SVG drawings; the ones an element would get anyway are left out.

const SVG_PREFIX = 'data:image/svg+xml;charset=utf-8,'

/** Properties other values are computed from: kept on the blank element compared with. */
const DEPENDED_ON = [
  'color',
  'display',
  'position',
  'float',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'outline-style',
  'column-rule-style'
]

/**
 * Removes from the inline style of `el` the declarations that do not change its computed style, then
 * from its children. `probe` is a copy of `el` in a frame with no style sheet, in the same place
 * of a copy of the tree (not rendered: computed values, not laid out ones).
 */
function compact(el: Element, probe: Element): void {
  const style = (el as Partial<ElementCSSInlineStyle>).style
  if (style?.length) {
    const inline = probe.getAttribute('style')!
    const blank = probe.ownerDocument.defaultView!.getComputedStyle(probe)
    const names = [...style]
    const same = (name: string): boolean => style.getPropertyValue(name) === blank.getPropertyValue(name)
    // The properties the others depend on, against a blank element there.
    probe.removeAttribute('style')
    const drop = names.filter((name) => DEPENDED_ON.includes(name) && same(name))
    // The others, against a blank element but for those.
    probe.setAttribute(
      'style',
      DEPENDED_ON.filter((name) => style.getPropertyValue(name))
        .map((name) => `${name}: ${style.getPropertyValue(name)}`)
        .join('; ')
    )
    drop.push(...names.filter((name) => !DEPENDED_ON.includes(name) && same(name)))
    probe.setAttribute('style', inline)
    for (const name of drop) style.removeProperty(name)
  }
  for (const child of el.children)
    compact(child, probe.appendChild(probe.ownerDocument.importNode(child, false)))
}

/** The SVG drawings in `root`, not those inside them. */
function drawings(root: Element): Element[] {
  return [...root.querySelectorAll('svg')].filter((svg) => {
    const outer = svg.parentElement?.closest('svg')
    return !outer || !root.contains(outer)
  })
}

/**
 * html-to-image copies the SVG drawings as they are, without the style the page's style sheets
 * give their elements: copies the computed style of the elements of `source` onto their copies.
 */
function styleDrawings(content: Element, source: Element): void {
  const live = drawings(source)
  drawings(content).forEach((svg, i) => {
    const from = live[i] ? [...live[i].querySelectorAll('*')] : []
    const to = [...svg.querySelectorAll('*')]
    if (from.length !== to.length || from.some((el, j) => el.localName !== to[j]?.localName)) return
    from.forEach((el, j) => {
      const computed = getComputedStyle(el)
      const style = (to[j] as SVGElement).style
      // Computed values have their variables resolved.
      for (const name of computed)
        if (!name.startsWith('--')) style.setProperty(name, computed.getPropertyValue(name))
    })
  })
}

/** The `data:` URL of `source` exported by html-to-image `toSvg`, styled and smaller. */
export function compactSvg(url: string, source: Element): string {
  if (!url.startsWith(SVG_PREFIX)) return url
  const doc = new DOMParser().parseFromString(
    decodeURIComponent(url.slice(SVG_PREFIX.length)),
    'image/svg+xml'
  )
  const content = doc.querySelector('foreignObject')
  if (!content || doc.querySelector('parsererror')) return url
  // Rendered (some browsers compute no style in a hidden frame), out of view.
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position: fixed; left: -10000px; width: 10px; height: 10px; border: 0'
  document.body.appendChild(frame)
  styleDrawings(content, source)
  try {
    const copy = frame.contentDocument!
    // Inherits the initial values, as the content of the foreignObject does.
    const root = copy.body.appendChild(copy.createElement('div'))
    root.style.display = 'none'
    for (const el of content.children) compact(el, root.appendChild(copy.importNode(el, false)))
  } finally {
    frame.remove()
  }
  return SVG_PREFIX + encodeURIComponent(new XMLSerializer().serializeToString(doc))
}

/** The `data:` URL of a PNG drawing the SVG `url` of `width` × `height`, at the screen's resolution. */
export async function svgToPng(url: string, width: number, height: number): Promise<string> {
  const img = new Image()
  img.src = url
  await img.decode()
  const canvas = document.createElement('canvas')
  // Canvases are limited to 16384 pixels a side.
  const ratio = Math.min(window.devicePixelRatio || 1, 16384 / Math.max(width, height))
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}
