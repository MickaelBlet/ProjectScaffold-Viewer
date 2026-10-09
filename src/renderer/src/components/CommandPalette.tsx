// Ctrl+Shift+P: commands ('>' prefix). Ctrl+P: go to a module, type, interface, constant, link, dependency
// (and the types, interfaces, constants and modules it brings), view, template or generated file.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { commands, keyLabel, runCommand } from '@/commands'
import { codegenFiles } from '@/generationFiles'
import { formatValue } from '@/model/defaults'
import { fuzzyFilter } from '@/model/fuzzy'
import { modulePaths } from '@/model/project'
import { GLOBAL_VIEW, type Id } from '@/model/types'
import { activeDoc } from '@/store/documents'
import { getProject } from '@/store/project'
import { storage } from '@/storage'
import { useUiStore, type PickEntry } from '@/store/ui'
import { navigate } from '@/actions'
import { openView } from '@/shell/controllers'
import { openTextFile } from '@/textFileOps'
import { LANGUAGE_BADGES, languageOf } from './codeLanguages'
import { Icon } from './Icon'

interface Entry extends PickEntry {
  keys?: string
}

const RECENT_KEY = 'project-scaffold:recent-commands'

function recentCommands(): string[] {
  try {
    return JSON.parse(storage.getItem(RECENT_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function remember(id: string): void {
  storage.setItem(RECENT_KEY, JSON.stringify([id, ...recentCommands().filter((x) => x !== id)].slice(0, 8)))
}

function commandEntries(): Entry[] {
  const recent = recentCommands()
  const list = commands
    .filter((c) => !c.hidden && (c.enabled?.() ?? true))
    .map((c) => ({
      key: c.id,
      label: `${c.category}: ${c.title}`,
      keys: c.keys?.[0] ? keyLabel(c.keys[0]) : undefined,
      kind: c.checked?.() ? <Icon name="check" /> : '',
      run: () => {
        remember(c.id)
        runCommand(c.id)
      }
    }))
  // Recently used first when there is no query.
  return list.sort((a, b) => {
    const ra = recent.indexOf(a.key)
    const rb = recent.indexOf(b.key)
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
  })
}

function entityEntries(): Entry[] {
  const p = getProject()
  const paths = modulePaths(p)
  const deps = new Map(p.dependencies.map((d) => [d.id, d.name]))
  // A dependency's entities by qualified name, so that its name finds them.
  const named = (e: { name: string; dependency?: Id }): string =>
    e.dependency ? `${deps.get(e.dependency) ?? '?'}.${e.name}` : e.name
  return [
    ...p.modules.map((m) => ({
      key: m.id,
      label: paths.get(m.id) ?? m.name,
      detail: `module · ${m.ports.length} ports`,
      kind: 'M',
      run: () => navigate({ kind: 'module', id: m.id })
    })),
    ...p.types.map((t) => ({
      key: t.id,
      label: named(t),
      detail: t.kind,
      kind: 'T',
      run: () => navigate({ kind: 'type', id: t.id })
    })),
    ...p.interfaces.map((i) => ({
      key: i.id,
      label: named(i),
      detail: `interface · ${i.messages.length} messages`,
      kind: 'I',
      run: () => navigate({ kind: 'interface', id: i.id })
    })),
    ...p.consts.map((c) => ({
      key: c.id,
      label: named(c),
      detail: `constant · ${formatValue(c.value)}`,
      kind: 'C',
      // A dependency's constants show with it in the Inspector.
      run: () =>
        navigate(c.dependency ? { kind: 'dependency', id: c.dependency } : { kind: 'const', id: c.id })
    })),
    ...p.links.map((l) => ({
      key: l.id,
      label: l.name,
      detail: 'link',
      kind: 'L',
      run: () => navigate({ kind: 'link', id: l.id })
    })),
    ...p.dependencies.flatMap((d) => [
      {
        key: d.id,
        label: d.name,
        detail: `dependency · ${d.file}`,
        kind: 'D',
        run: () => navigate({ kind: 'dependency', id: d.id })
      },
      ...d.modules.map((m) => ({
        key: m.id,
        label: `${d.name}.${m.path}`,
        detail: 'imported module',
        kind: 'M',
        run: () => navigate({ kind: 'module', id: m.id })
      }))
    ]),
    { key: GLOBAL_VIEW, label: 'Project', detail: 'view', kind: 'V', run: () => openView(GLOBAL_VIEW) },
    ...p.views.map((v) => ({
      key: v.id,
      label: v.name,
      detail: 'view',
      kind: 'V',
      run: () => openView(v.id)
    }))
  ]
}

/** Templates and generated files of the active document. */
async function codegenEntries(): Promise<Entry[]> {
  return (await codegenFiles(activeDoc())).map(({ ref, name, kind }) => {
    const { id } = languageOf(name)
    return {
      key: `${ref.source}:${ref.path}`,
      label: name,
      detail: kind,
      kind: <span className={`file-badge file-${id}`}>{LANGUAGE_BADGES[id]}</span>,
      run: () => void openTextFile(ref)
    }
  })
}

function Highlight({ text, positions }: { text: string; positions: number[] }): ReactNode {
  const set = new Set(positions)
  return <>{[...text].map((ch, i) => (set.has(i) ? <b key={i}>{ch}</b> : ch))}</>
}

export function CommandPalette(): ReactNode {
  const palette = useUiStore((s) => s.palette)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const listId = useId()
  const optionId = (i: number): string => `${listId}-${i}`
  // Each opening (or quick pick replacing the list) starts from its own query.
  const [shown, setShown] = useState(palette)
  if (palette !== shown) {
    setShown(palette)
    if (palette) {
      setQuery(palette.query)
      setActive(0)
    }
  }

  const pickList = palette?.pick
  const isCommands = !pickList && query.startsWith('>')
  // Read on each opening (the folders may have changed), listed after the entities once read.
  const [files, setFiles] = useState<Entry[]>([])
  const goTo = !!palette && !pickList
  useEffect(() => {
    if (!goTo) return
    let current = true
    void codegenEntries().then((e) => current && setFiles(e))
    return () => {
      current = false
      setFiles([])
    }
  }, [goTo])
  const entries = useMemo(
    (): Entry[] =>
      !palette
        ? []
        : pickList
          ? pickList.entries
          : isCommands
            ? commandEntries()
            : [...entityEntries(), ...files],
    [palette, pickList, isCommands, files]
  )
  const results = useMemo(
    () => fuzzyFilter(isCommands ? query.slice(1) : query, entries, (e) => e.label).slice(0, 60),
    [entries, query, isCommands]
  )

  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!palette) return null
  const close = (): void => useUiStore.setState({ palette: null })
  const pick = (e: Entry | undefined): void => {
    close()
    e?.run()
  }

  const placeholder = pickList
    ? pickList.placeholder
    : isCommands
      ? 'Type a command'
      : 'Go to module, type, interface, constant, link, dependency, view, file — ">" for commands'

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={placeholder}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          role="combobox"
          aria-label={placeholder}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results[active] ? optionId(active) : undefined}
          value={query}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1))
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
            else if (e.key === 'Enter') pick(results[active]?.item)
            else return
            e.preventDefault()
          }}
        />
        <ul ref={list} id={listId} role="listbox">
          {results.map(({ item, match }, i) => (
            <li
              key={item.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(item)}
            >
              <span className="palette-kind">{item.kind}</span>
              <span className="palette-label">
                <Highlight text={item.label} positions={match.positions} />
              </span>
              {item.detail && <small>{item.detail}</small>}
              {item.keys && <kbd>{item.keys}</kbd>}
            </li>
          ))}
          {!results.length && (
            <li className="empty" role="presentation">
              No match
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}
