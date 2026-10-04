// Shrinks the SVG of a diagram export: html-to-image copies every computed style property onto
// every element; the ones the element would get anyway are left out.

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

/** The `data:` URL of a diagram exported by html-to-image `toSvg`, smaller. */
export function compactSvg(url: string): string {
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
