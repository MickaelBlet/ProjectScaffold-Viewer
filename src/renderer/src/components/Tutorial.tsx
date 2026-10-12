import { useId, type ReactNode } from 'react'
import { availableIds, getCommand, keyLabel, runCommand } from '@/commands'
import { commandIcon } from '@/shell/toolbar'
import { useDoc } from '@/store/documents'
import { useProjectStore } from '@/store/project'
import { useUiStore } from '@/store/ui'
import { Icon, type IconName } from './Icon'

interface Step {
  title: string
  icon: IconName
  text: string[]
  /** Commands to try from the step; those the host leaves out are not shown. */
  commands: string[]
}

/** The tour: one step per feature, each with the commands reaching it. */
const STEPS: Step[] = [
  {
    title: 'Welcome to ProjectScaffold',
    icon: 'help',
    text: [
      'Draw the architecture of your software: modules, their ports, the typed interfaces they exchange and the links between them.',
      'The project is saved as a YAML or JSON file that code skeleton generators read. This tour presents the main features; try each one with the buttons below.'
    ],
    commands: ['file.new', 'file.open']
  },
  {
    title: 'Modules and ports',
    icon: 'module',
    text: [
      'Modules are the building blocks; they nest in submodules. Ports (in / out) are where they communicate.',
      'Double-click a module name to rename it. Select a module to add submodules or ports to it.'
    ],
    commands: ['insert.module', 'insert.submodule', 'insert.inPort', 'insert.outPort']
  },
  {
    title: 'Links',
    icon: 'link',
    text: [
      'Drag from a port to another port to link them. A link carries an interface, and its direction follows the ports.',
      'Select a link to choose its interface, transport and options in the Inspector. Drag its bends and badges to shape it.'
    ],
    commands: ['window.inspector']
  },
  {
    title: 'Types, interfaces and constants',
    icon: 'tree',
    text: [
      'The Explorer lists every entity of the project: views, constants, types (struct, enum, union, alias…), interfaces, modules and links.',
      'Add them from the buttons of each section; select one to edit it in the Inspector, which also lists where it is used.'
    ],
    commands: ['window.explorer', 'window.inspector']
  },
  {
    title: 'Inside a module',
    icon: 'info',
    text: [
      "A module's Inspector edits its attributes, methods, bases and implemented interfaces, lifecycle, contracts and module types.",
      'Its state machine (states, transitions triggered by methods) is drawn in the State machine panel.'
    ],
    commands: ['window.inspector', 'window.stateMachine']
  },
  {
    title: 'Views and layout',
    icon: 'view',
    text: [
      'The Project view shows every module. Open a module in a view of its own to focus on its content, or make views of chosen modules.',
      'Arrange lays modules out automatically, aligns and distributes the selection; notes and frames annotate the diagram.'
    ],
    commands: ['view.global', 'view.openModule', 'view.new', 'arrange.auto', 'view.fitAll', 'insert.note']
  },
  {
    title: 'Project text',
    icon: 'code',
    text: [
      'The project text (YAML or JSON) is edited beside the diagram, both kept in sync: the element under the cursor is selected on the canvas.',
      'Completion, hover descriptions from the file schema, and the changes since the last save are shown.'
    ],
    commands: ['view.source']
  },
  {
    title: 'Problems',
    icon: 'warning',
    text: [
      'The project is checked as you edit: unknown references, mismatched interfaces, inheritance and lifecycle rules…',
      'Errors block the export, warnings do not. Click a problem to go to its place.'
    ],
    commands: ['window.problems']
  },
  {
    title: 'Dependencies',
    icon: 'package',
    text: [
      'Use other project files or IDL files: their types and interfaces become available, and their modules can be placed and linked to.',
      'Refresh dependencies when they change; renames are carried to the projects depending on them.'
    ],
    commands: ['insert.dependency', 'insert.refreshDependencies']
  },
  {
    title: 'Save and export',
    icon: 'save',
    text: [
      'Save writes the project file, with its layout in an editor section that generators ignore.',
      'Export the diagram as PNG or SVG; a workspace reopens several projects together.'
    ],
    commands: ['file.save', 'file.saveAs', 'file.exportPng', 'file.exportSvg', 'file.saveWorkspace']
  },
  {
    title: 'Find your way',
    icon: 'command',
    text: [
      'The command palette runs any command; Go to jumps to any entity; Search finds text across the project.',
      'Settings change the theme, link and port styles, the text editor and the toolbar buttons. Reopen this tour from Help › Tutorial.'
    ],
    commands: ['view.palette', 'view.goto', 'window.search', 'help.shortcuts', 'window.settings']
  }
]

function TryButton({ id }: { id: string }): ReactNode {
  const c = getCommand(id)
  const icon = commandIcon(id)
  const key = c.keys?.[0]
  return (
    <button
      type="button"
      disabled={!(c.enabled?.() ?? true)}
      title={key ? `${c.title} (${keyLabel(key)})` : c.title}
      onClick={() => runCommand(id)}
    >
      {icon && <Icon name={icon} />}
      {c.title}
      {key && <kbd>{keyLabel(key)}</kbd>}
    </button>
  )
}

/** Tour of the features, step by step: a card beside the work, so the commands it offers can be tried. */
export function Tutorial(): ReactNode {
  const index = useUiStore((s) => s.tutorialStep)
  const titleId = useId()
  // Commands enabled by the project or the selection.
  useProjectStore((s) => s.project)
  useDoc((d) => d.selection)
  if (index === null) return null
  const step = STEPS[Math.min(index, STEPS.length - 1)]!
  const go = (i: number): void => useUiStore.setState({ tutorialStep: i })
  const close = (): void => useUiStore.setState({ tutorialStep: null })
  const first = index === 0
  const last = index >= STEPS.length - 1
  return (
    <section
      className="tutorial"
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
        else if (e.key === 'ArrowLeft' && !first) go(index - 1)
        else if (e.key === 'ArrowRight' && !last) go(index + 1)
        else return
        e.stopPropagation()
      }}
    >
      <header>
        <Icon name={step.icon} />
        <h3 id={titleId}>{step.title}</h3>
        <button
          type="button"
          className="plain"
          title="Close tutorial"
          aria-label="Close tutorial"
          onClick={close}
        >
          <Icon name="x" />
        </button>
      </header>
      {step.text.map((t) => (
        <p key={t}>{t}</p>
      ))}
      <div className="tutorial-commands">
        {availableIds(step.commands).map((id) => (
          <TryButton key={id} id={id} />
        ))}
      </div>
      <footer>
        <span className="muted">
          {index + 1} / {STEPS.length}
        </span>
        <span className="tutorial-dots" aria-hidden>
          {STEPS.map((s, i) => (
            <button
              type="button"
              key={s.title}
              className={i === index ? 'on' : ''}
              tabIndex={-1}
              title={s.title}
              onClick={() => go(i)}
            />
          ))}
        </span>
        <button type="button" disabled={first} onClick={() => go(index - 1)}>
          Back
        </button>
        {last ? (
          <button type="button" className="primary" autoFocus onClick={close}>
            Done
          </button>
        ) : (
          <button type="button" className="primary" autoFocus onClick={() => go(index + 1)}>
            Next
          </button>
        )}
      </footer>
    </section>
  )
}
