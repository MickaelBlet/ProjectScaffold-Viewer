//! Tour of the features, step by step: a card beside the work, so the commands it offers can be
//! tried. Port of `Tutorial.tsx`.

pub struct Step {
    pub title: &'static str,
    pub text: &'static [&'static str],
    pub commands: &'static [&'static str],
}

pub const STEPS: &[Step] = &[
    Step {
        title: "Welcome to ProjectScaffold",
        text: &[
            "Draw the architecture of your software: modules, their ports, the typed interfaces they exchange and the links between them.",
            "The project is saved as a YAML or JSON file that code skeleton generators read. This tour presents the main features; try each one with the buttons below.",
        ],
        commands: &["file.new", "file.open"],
    },
    Step {
        title: "Modules and ports",
        text: &[
            "Modules are the building blocks; they nest in submodules. Ports (in / out) are where they communicate.",
            "Double-click a module name to rename it. Select a module to add submodules or ports to it.",
        ],
        commands: &[
            "insert.module",
            "insert.submodule",
            "insert.inPort",
            "insert.outPort",
        ],
    },
    Step {
        title: "Links",
        text: &[
            "Drag from a port to another port to link them. A link carries an interface, and its direction follows the ports.",
            "Select a link to choose its interface, transport and options in the Inspector. Drag its bends and badges to shape it.",
        ],
        commands: &["window.inspector"],
    },
    Step {
        title: "Types, interfaces and constants",
        text: &[
            "The Explorer lists every entity of the project: views, constants, types (struct, enum, union, alias…), interfaces, modules and links.",
            "Add them from the buttons of each section; select one to edit it in the Inspector, which also lists where it is used.",
        ],
        commands: &["window.explorer", "window.inspector"],
    },
    Step {
        title: "Inside a module",
        text: &[
            "A module's Inspector edits its attributes, methods, bases and implemented interfaces, lifecycle, contracts and module types.",
            "Its state machine (states, transitions triggered by methods) is drawn in the State machine panel.",
        ],
        commands: &["window.inspector", "window.stateMachine"],
    },
    Step {
        title: "Views and layout",
        text: &[
            "The Project view shows every module. Open a module in a view of its own to focus on its content, or make views of chosen modules.",
            "Arrange lays modules out automatically, aligns and distributes the selection; notes and frames annotate the diagram.",
        ],
        commands: &[
            "view.global",
            "view.openModule",
            "view.new",
            "arrange.auto",
            "view.fitAll",
            "insert.note",
        ],
    },
    Step {
        title: "Project text",
        text: &[
            "The project text (YAML or JSON) is edited beside the diagram, both kept in sync: the element under the cursor is selected on the canvas.",
            "Completion, hover descriptions from the file schema, and the changes since the last save are shown.",
        ],
        commands: &["view.source"],
    },
    Step {
        title: "Problems",
        text: &[
            "The project is checked as you edit: unknown references, mismatched interfaces, inheritance and lifecycle rules…",
            "Errors block the export, warnings do not. Click a problem to go to its place.",
        ],
        commands: &["window.problems"],
    },
    Step {
        title: "Dependencies",
        text: &[
            "Use other project files or IDL files: their types and interfaces become available, and their modules can be placed and linked to.",
            "Refresh dependencies when they change; renames are carried to the projects depending on them.",
        ],
        commands: &["insert.dependency", "insert.refreshDependencies"],
    },
    Step {
        title: "Save and export",
        text: &[
            "Save writes the project file, with its layout in an editor section that generators ignore.",
            "Export the diagram as PNG or SVG; a workspace reopens several projects together.",
        ],
        commands: &[
            "file.save",
            "file.saveAs",
            "file.exportPng",
            "file.exportSvg",
            "file.saveWorkspace",
        ],
    },
    Step {
        title: "Find your way",
        text: &[
            "The command palette runs any command; Go to jumps to any entity; Search finds text across the project.",
            "Settings change the theme, link and port styles, the text editor and the toolbar buttons. Reopen this tour from Help › Tutorial.",
        ],
        commands: &[
            "view.palette",
            "view.goto",
            "window.search",
            "help.shortcuts",
            "window.settings",
        ],
    },
];
