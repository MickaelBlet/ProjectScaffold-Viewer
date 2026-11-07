//! Pure helpers over the in-memory project. Port of `model/project.ts`.

use std::collections::{HashMap, HashSet};

use crate::schema::NameRef;
use crate::typeexpr::{is_reserved_type_name, map_ref, print_type_expr, walk_type_ref};
use crate::types::*;

pub fn is_identifier(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

pub fn new_id() -> Id {
    uuid::Uuid::new_v4().to_string()
}

pub fn empty_project() -> Project {
    Project {
        name: "Untitled".into(),
        ..Default::default()
    }
}

/// Some message of the interface answers the caller: returns a value or has out parameters.
pub fn replies_to_caller(iface: &Interface) -> bool {
    iface
        .messages
        .iter()
        .any(|m| m.returns.is_some() || m.params.iter().any(|p| p.direction != ParamDirection::In))
}

/// Constraints of a new link, bidirectional when its interface answers the caller.
pub fn default_constraints(iface: Option<&Interface>) -> LinkConstraints {
    LinkConstraints {
        direction: if iface.is_some_and(replies_to_caller) {
            Direction::Bidirectional
        } else {
            Direction::Unidirectional
        },
        ack: Ack {
            required: false,
            timeout_ms: None,
        },
        performance: Performance {
            class: PerformanceClass::Normal,
            max_latency_ms: None,
            rate_hz: None,
        },
        remote: Remote {
            enabled: false,
            transport: None,
            settings: None,
        },
    }
}

pub const MODULE_WIDTH: f64 = 200.;
pub const MODULE_HEADER: f64 = 36.;
pub const PORT_ROW: f64 = 24.;
pub const LAYOUT_PAD: f64 = 20.;
/// Vertical orientation: a band of `in` ports above the header, a band of `out` ports at the bottom.
pub const PORT_BAND: f64 = 24.;
/// Width taken by one port along a band.
const PORT_COL: f64 = 90.;
/// Height of one line in a module's attribute or method compartment.
pub const ATTR_ROW: f64 = 18.;

/// Port rows of a module node: `in` ports on the left, `out` ports on the right.
pub fn port_rows(roles: impl Iterator<Item = PortRole>) -> usize {
    let (mut ins, mut all) = (0, 0);
    for r in roles {
        all += 1;
        if r == PortRole::In {
            ins += 1
        }
    }
    ins.max(all - ins)
}

pub fn leaf_height(port_count: usize) -> f64 {
    MODULE_HEADER + port_count.max(1) as f64 * PORT_ROW + 12.
}

/// Counts of a module's compartment lines.
#[derive(Clone, Copy, Debug, Default)]
pub struct Compartments {
    pub attributes: usize,
    pub methods: usize,
    pub constructors: usize,
    pub destructor: bool,
}

impl Compartments {
    pub fn of_module(m: &Module) -> Self {
        Compartments {
            attributes: m.attributes.len(),
            methods: m.methods.len(),
            constructors: m.constructors.as_ref().map_or(0, Vec::len),
            destructor: m.destructor.is_some(),
        }
    }
    pub fn of_imported(m: &ImportedModule) -> Self {
        Compartments {
            attributes: m.attributes.as_ref().map_or(0, Vec::len),
            methods: m.methods.as_ref().map_or(0, Vec::len),
            ..Default::default()
        }
    }
}

fn compartment_height(n: usize) -> f64 {
    if n > 0 { n as f64 * ATTR_ROW + 8. } else { 0. }
}

/// Height of a module's attribute and method compartments, below its header.
pub fn compartments_height(c: Compartments) -> f64 {
    // Constructors and the destructor head the methods.
    let methods = c.methods + c.constructors + usize::from(c.destructor);
    compartment_height(c.attributes) + compartment_height(methods)
}

/// Top of the area holding a module's content: below the header, the top band and compartments.
pub fn content_top(o: Orientation, c: Compartments) -> f64 {
    (if o == Orientation::Vertical {
        PORT_BAND + MODULE_HEADER
    } else {
        MODULE_HEADER
    }) + compartments_height(c)
}

/// Space kept below a module's content.
pub fn content_bottom(o: Orientation) -> f64 {
    if o == Orientation::Vertical {
        PORT_BAND + LAYOUT_PAD
    } else {
        LAYOUT_PAD
    }
}

/// Smallest size showing a module's header, attributes, methods and ports.
pub fn min_size(roles: &[PortRole], c: Compartments, o: Orientation) -> Size {
    let attrs = compartments_height(c);
    if o == Orientation::Horizontal {
        return Size {
            width: 140.,
            height: leaf_height(port_rows(roles.iter().copied())) + attrs,
        };
    }
    let ins = roles.iter().filter(|r| **r == PortRole::In).count();
    Size {
        width: 140f64.max(ins.max(roles.len() - ins) as f64 * PORT_COL + 20.),
        height: 2. * PORT_BAND + MODULE_HEADER + 8. + attrs,
    }
}

/// Size of a new or reset module (no content).
pub fn default_size(roles: &[PortRole], c: Compartments, o: Orientation) -> Size {
    let min = min_size(roles, c, o);
    Size {
        width: MODULE_WIDTH.max(min.width),
        height: min.height,
    }
}

pub fn module_roles(m: &Module) -> Vec<PortRole> {
    m.ports.iter().map(|p| p.role).collect()
}

pub fn imported_roles(m: &ImportedModule) -> Vec<PortRole> {
    m.ports.iter().map(|p| p.role).collect()
}

pub fn find_module<'a>(p: &'a Project, id: &str) -> Option<&'a Module> {
    p.modules.iter().find(|m| m.id == id)
}

pub fn find_module_mut<'a>(p: &'a mut Project, id: &str) -> Option<&'a mut Module> {
    p.modules.iter_mut().find(|m| m.id == id)
}

/// Keep `id` inside its parent's content area, growing ancestors as needed.
pub fn grow_ancestors(d: &mut Project, id: &str) {
    let o = d.orientation;
    let mut child_id = id.to_string();
    loop {
        let Some(ci) = d.modules.iter().position(|m| m.id == child_id) else {
            return;
        };
        let Some(parent_id) = d.modules[ci].parent_id.clone() else {
            return;
        };
        let Some(pi) = d.modules.iter().position(|m| m.id == parent_id) else {
            return;
        };
        let top = content_top(o, Compartments::of_module(&d.modules[pi]));
        let child = &mut d.modules[ci].layout;
        child.x = child.x.max(LAYOUT_PAD / 2.);
        child.y = child.y.max(top);
        let c = *child;
        let parent = &mut d.modules[pi].layout;
        parent.width = parent.width.max(c.x + c.width + LAYOUT_PAD);
        parent.height = parent.height.max(c.y + c.height + content_bottom(o));
        child_id = parent_id;
    }
}

pub fn child_modules<'a>(p: &'a Project, parent_id: Option<&str>) -> impl Iterator<Item = &'a Module> {
    p.modules
        .iter()
        .filter(move |m| m.parent_id.as_deref() == parent_id)
}

/// Parent-relative top of the free space below a module's submodules (`except_id` left out).
pub fn below_content(p: &Project, parent_id: &str, except_id: Option<&str>) -> f64 {
    let parent = find_module(p, parent_id)
        .map(Compartments::of_module)
        .unwrap_or_default();
    child_modules(p, Some(parent_id))
        .filter(|c| Some(c.id.as_str()) != except_id)
        .map(|c| c.layout.y + c.layout.height + LAYOUT_PAD)
        .fold(content_top(p.orientation, parent) + LAYOUT_PAD, f64::max)
}

/// Ids of `id` and all its descendants.
pub fn subtree_ids(p: &Project, id: &str) -> HashSet<Id> {
    let mut ids = HashSet::from([id.to_string()]);
    let mut grew = true;
    while grew {
        grew = false;
        for m in &p.modules {
            if let Some(parent) = &m.parent_id {
                if ids.contains(parent) && !ids.contains(&m.id) {
                    ids.insert(m.id.clone());
                    grew = true;
                }
            }
        }
    }
    ids
}

pub fn module_path(p: &Project, id: &str) -> String {
    if let Some((dep, m)) = find_imported(p, id) {
        return format!("{}/{}", dep.name, m.path);
    }
    let mut parts = Vec::new();
    let mut cur = find_module(p, id);
    while let Some(m) = cur {
        parts.push(m.name.as_str());
        cur = m.parent_id.as_deref().and_then(|pid| find_module(p, pid));
    }
    parts.reverse();
    parts.join(".")
}

/// `module_path` of every module and imported module, computed at once.
pub fn module_paths(modules: &[Module], dependencies: &[Dependency]) -> HashMap<Id, String> {
    let by_id: HashMap<&str, &Module> = modules.iter().map(|m| (m.id.as_str(), m)).collect();
    let mut paths: HashMap<Id, String> = HashMap::new();
    fn path(m: &Module, by_id: &HashMap<&str, &Module>, paths: &mut HashMap<Id, String>) -> String {
        if let Some(known) = paths.get(&m.id) {
            return known.clone();
        }
        let known = match m.parent_id.as_deref().and_then(|p| by_id.get(p)) {
            Some(parent) => format!("{}.{}", path(parent, by_id, paths), m.name),
            None => m.name.clone(),
        };
        paths.insert(m.id.clone(), known.clone());
        known
    }
    for m in modules {
        path(m, &by_id, &mut paths);
    }
    for dep in dependencies {
        for m in &dep.modules {
            paths.insert(m.id.clone(), format!("{}/{}", dep.name, m.path));
        }
    }
    paths
}

pub fn project_module_paths(p: &Project) -> HashMap<Id, String> {
    module_paths(&p.modules, &p.dependencies)
}

/// Text of a link end, `Module.Path:port`.
pub fn endpoint_label(p: &Project, paths: &HashMap<Id, String>, e: &Endpoint) -> String {
    let port = find_module(p, &e.module_id)
        .and_then(|m| {
            m.ports
                .iter()
                .find(|pt| pt.id == e.port_id)
                .map(|pt| pt.name.clone())
        })
        .or_else(|| {
            find_imported(p, &e.module_id).and_then(|(_, m)| {
                m.ports
                    .iter()
                    .find(|pt| pt.id == e.port_id)
                    .map(|pt| pt.name.clone())
            })
        })
        .unwrap_or_else(|| "?".into());
    format!(
        "{}:{port}",
        paths.get(&e.module_id).map(String::as_str).unwrap_or("")
    )
}

/// Absolute canvas position of a module (layouts are parent-relative).
pub fn absolute_position(p: &Project, id: &str) -> Point {
    if let Some((dep, m)) = find_imported(p, id) {
        let (mut x, mut y) = (m.position.x, m.position.y);
        let mut up = imported_parent(dep, m);
        while let Some(u) = up {
            x += u.position.x;
            y += u.position.y;
            up = imported_parent(dep, u);
        }
        return Point { x, y };
    }
    let (mut x, mut y) = (0., 0.);
    let mut cur = find_module(p, id);
    while let Some(m) = cur {
        x += m.layout.x;
        y += m.layout.y;
        cur = m.parent_id.as_deref().and_then(|pid| find_module(p, pid));
    }
    Point { x, y }
}

/// Roles of the ports at both ends of a link from module `from` to module `to`.
pub fn link_roles(p: &Project, from: &str, to: &str) -> (PortRole, PortRole) {
    if subtree_ids(p, from).contains(to) {
        return (PortRole::In, PortRole::In);
    }
    if subtree_ids(p, to).contains(from) {
        return (PortRole::Out, PortRole::Out);
    }
    (PortRole::Out, PortRole::In)
}

/// A link end candidate: module and port role (None: a new port, any role).
#[derive(Clone, Debug, PartialEq)]
pub struct LinkEnd<T> {
    pub module_id: Id,
    pub role: Option<PortRole>,
    pub data: T,
}

/// Two link ends in link order (from, to), matching the roles of their ports, or None.
pub fn order_link_ends<T: Clone>(
    p: &Project,
    a: &LinkEnd<T>,
    b: &LinkEnd<T>,
) -> Option<(LinkEnd<T>, LinkEnd<T>)> {
    for (x, y) in [(a, b), (b, a)] {
        let (rx, ry) = link_roles(p, &x.module_id, &y.module_id);
        if x.role.unwrap_or(rx) == rx && y.role.unwrap_or(ry) == ry {
            return Some((x.clone(), y.clone()));
        }
    }
    None
}

/// Innermost module holding both ends of a link (an end itself when the other is inside it).
pub fn link_origin(p: &Project, from: &str, to: &str) -> Option<Id> {
    let chain = |id: &str| -> Vec<Id> {
        let mut ids = Vec::new();
        let mut m = find_module(p, id);
        while let Some(x) = m {
            ids.push(x.id.clone());
            m = x.parent_id.as_deref().and_then(|pid| find_module(p, pid));
        }
        ids
    };
    let theirs: HashSet<Id> = chain(to).into_iter().collect();
    chain(from).into_iter().find(|id| theirs.contains(id))
}

/// A port of a module or of an imported module (as a copy whose interface is this project's
/// interface of the same name).
pub fn find_port(p: &Project, module_id: &str, port_id: &str) -> Option<Port> {
    if let Some(pt) = find_module(p, module_id).and_then(|m| m.ports.iter().find(|pt| pt.id == port_id)) {
        return Some(pt.clone());
    }
    let (_, m) = find_imported(p, module_id)?;
    let ip = m.ports.iter().find(|pt| pt.id == port_id)?;
    Some(Port {
        id: ip.id.clone(),
        name: ip.name.clone(),
        role: ip.role,
        interface_id: ip
            .interface
            .as_ref()
            .and_then(|n| p.interfaces.iter().find(|i| &i.name == n).map(|i| i.id.clone())),
        description: ip.description.clone(),
        label: ip.label,
    })
}

// Imported modules: modules of dependencies placed on the canvas.

pub const IMPORTED_PREFIX: &str = "imported:";

pub fn is_imported_id(id: &str) -> bool {
    id.starts_with(IMPORTED_PREFIX)
}

pub fn find_imported<'a>(p: &'a Project, id: &str) -> Option<(&'a Dependency, &'a ImportedModule)> {
    find_imported_in(&p.dependencies, id)
}

pub fn find_imported_in<'a>(
    deps: &'a [Dependency],
    id: &str,
) -> Option<(&'a Dependency, &'a ImportedModule)> {
    if !is_imported_id(id) {
        return None;
    }
    deps.iter()
        .find_map(|d| d.modules.iter().find(|m| m.id == id).map(|m| (d, m)))
}

/// Dependency index and module index of an imported module.
pub fn imported_index(p: &Project, id: &str) -> Option<(usize, usize)> {
    if !is_imported_id(id) {
        return None;
    }
    p.dependencies
        .iter()
        .enumerate()
        .find_map(|(di, d)| d.modules.iter().position(|m| m.id == id).map(|mi| (di, mi)))
}

pub fn all_imported(p: &Project) -> impl Iterator<Item = &ImportedModule> {
    p.dependencies.iter().flat_map(|d| d.modules.iter())
}

/// Path of the module holding the module at `path` (`A` for `A.B`); None for a top-level one.
pub fn parent_path(path: &str) -> Option<&str> {
    path.rfind('.').map(|i| &path[..i])
}

/// Placed module of `dep` holding `m` (None for a placed top-level module).
pub fn imported_parent<'a>(dep: &'a Dependency, m: &ImportedModule) -> Option<&'a ImportedModule> {
    let parent = parent_path(&m.path)?;
    dep.modules.iter().find(|x| x.path == parent)
}

/// Keep the placed module `id` inside its parent's content area, growing its placed ancestors.
pub fn grow_imported_ancestors(d: &mut Project, id: &str) {
    let o = d.orientation;
    let Some((di, mut ci)) = imported_index(d, id) else {
        return;
    };
    let dep = &mut d.dependencies[di];
    loop {
        let Some(parent) = parent_path(&dep.modules[ci].path).map(str::to_string) else {
            return;
        };
        let Some(pi) = dep.modules.iter().position(|x| x.path == parent) else {
            return;
        };
        let size = imported_size(&dep.modules[ci], o);
        let child = &mut dep.modules[ci];
        child.position = Point {
            x: child.position.x.max(LAYOUT_PAD / 2.),
            y: child.position.y.max(content_top(o, Compartments::default())),
        };
        let pos = child.position;
        let own = imported_size(&dep.modules[pi], o);
        let width = own.width.max(pos.x + size.width + LAYOUT_PAD);
        let height = own.height.max(pos.y + size.height + content_bottom(o));
        let parent = &mut dep.modules[pi];
        if parent.size.map(|s| (s.width, s.height)) != Some((width, height)) {
            parent.size = Some(Size { width, height });
        }
        ci = pi;
    }
}

/// Placed modules of dependencies not inside another one.
pub fn imported_roots(p: &Project) -> Vec<&ImportedModule> {
    p.dependencies
        .iter()
        .flat_map(|d| d.modules.iter().filter(move |m| imported_parent(d, m).is_none()))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameItemKind {
    Module,
    Note,
    Imported,
}

/// Top-level modules, notes and imported modules lying fully inside a frame.
pub fn frame_contents(p: &Project, frame_id: &str) -> Vec<(Id, FrameItemKind, String)> {
    let Some(f) = p.notes.iter().find(|n| n.id == frame_id).map(|n| n.layout) else {
        return vec![];
    };
    let within = |r: &Rect| {
        r.x >= f.x && r.y >= f.y && r.x + r.width <= f.x + f.width && r.y + r.height <= f.y + f.height
    };
    let mut out = Vec::new();
    for m in p
        .modules
        .iter()
        .filter(|m| m.parent_id.is_none() && within(&m.layout))
    {
        out.push((m.id.clone(), FrameItemKind::Module, m.name.clone()));
    }
    for n in p.notes.iter().filter(|n| n.id != frame_id && within(&n.layout)) {
        let first = n.text.split('\n').next().unwrap_or("");
        let name = if first.is_empty() {
            format!("({})", n.kind)
        } else {
            first.to_string()
        };
        out.push((n.id.clone(), FrameItemKind::Note, name));
    }
    for m in imported_roots(p) {
        let s = imported_size(m, p.orientation);
        let r = Rect {
            x: m.position.x,
            y: m.position.y,
            width: s.width,
            height: s.height,
        };
        if within(&r) {
            out.push((m.id.clone(), FrameItemKind::Imported, m.path.clone()));
        }
    }
    out
}

/// Size of an imported module on the canvas: set by hand (at least its minimum), else from its ports.
pub fn imported_size(m: &ImportedModule, o: Orientation) -> Size {
    let roles = imported_roles(m);
    let c = Compartments::of_imported(m);
    match m.size {
        None => default_size(&roles, c, o),
        Some(s) => {
            let min = min_size(&roles, c, o);
            Size {
                width: min.width.max(s.width),
                height: min.height.max(s.height),
            }
        }
    }
}

pub const PALETTE: &[&str] = &[
    "#e0513b", "#d98b00", "#d6c21f", "#2e9e5b", "#2e9e8f", "#3b8fd1", "#3b6fe0", "#8a4fd1", "#d14f9e",
    "#7a8496",
];

/// The least used palette hue (grey excluded).
pub fn next_module_color(p: &Project) -> String {
    let hues = &PALETTE[..PALETTE.len() - 1];
    let count = |c: &str| p.modules.iter().filter(|m| m.color.as_deref() == Some(c)).count();
    let mut best = hues[0];
    for c in hues {
        if count(c) < count(best) {
            best = c;
        }
    }
    best.to_string()
}

/// Set a qualifier of an attribute, keeping the others consistent.
pub fn set_attribute_qualifier(a: &mut Attribute, q: Qualifier, on: bool) {
    a.qualifiers.set(q, on);
    if !on {
        return;
    }
    match q {
        Qualifier::Mutable => {
            a.qualifiers.set(Qualifier::Static, false);
            a.qualifiers.set(Qualifier::Const, false);
        }
        Qualifier::Static | Qualifier::Const => a.qualifiers.set(Qualifier::Mutable, false),
        _ => {}
    }
    if q == Qualifier::Const && a.accessors == Some(Accessors::Read) {
        a.accessors = None;
    }
}

/// Set the access level of a type, attribute or method; public is left out.
pub fn set_access(e: &mut Option<StoredAccess>, access: Access) {
    *e = StoredAccess::stored(access);
}

const VIRTUAL_QUALIFIERS: &[Qualifier] = &[Qualifier::Pure, Qualifier::Override, Qualifier::Final];

/// Set a qualifier of a method, keeping the others consistent.
pub fn set_method_qualifier(m: &mut Method, q: Qualifier, on: bool) {
    let qs = &mut m.qualifiers;
    qs.set(q, on);
    if !on {
        if q == Qualifier::Virtual {
            for k in VIRTUAL_QUALIFIERS {
                qs.set(*k, false);
            }
        }
        return;
    }
    if q == Qualifier::Static {
        qs.set(Qualifier::Virtual, false);
        for k in VIRTUAL_QUALIFIERS {
            qs.set(*k, false);
        }
    } else if q == Qualifier::Virtual || VIRTUAL_QUALIFIERS.contains(&q) {
        qs.set(Qualifier::Virtual, true);
        qs.set(Qualifier::Static, false);
        if q == Qualifier::Pure {
            qs.set(Qualifier::Final, false);
        }
        if q == Qualifier::Final {
            qs.set(Qualifier::Pure, false);
        }
    }
}

/// Qualifiers of a method as drawn around its name and parameters.
pub fn method_qualifier_text(m: &Method) -> (String, String) {
    let q = m.qualifiers;
    let mut before = String::new();
    if q.has(Qualifier::Nodiscard) {
        before.push_str("nodiscard ");
    }
    if q.has(Qualifier::Static) {
        before.push_str("static ");
    } else if q.has(Qualifier::Virtual) {
        before.push_str("virtual ");
    }
    let mut after = String::new();
    for k in [
        Qualifier::Const,
        Qualifier::Noexcept,
        Qualifier::Override,
        Qualifier::Final,
        Qualifier::ThreadSafe,
    ] {
        if q.has(k) {
            after.push(' ');
            after.push_str(k.as_str());
        }
    }
    if q.has(Qualifier::Pure) {
        after.push_str(" = 0");
    }
    (before, after)
}

/// Member id of a module's destructor.
pub const DESTRUCTOR_MEMBER: &str = "destructor";

/// Whether `member` is an attribute, method, constructor or the destructor of `m`.
pub fn has_member(m: &Module, member: &str) -> bool {
    if member == DESTRUCTOR_MEMBER {
        return m.destructor.is_some();
    }
    m.attributes.iter().any(|x| x.field.id == member)
        || m.methods.iter().any(|x| x.id == member)
        || m.constructors.iter().flatten().any(|x| x.id == member)
}

/// Remove member `member` from `m`.
pub fn remove_member(m: &mut Module, member: &str) {
    if member == DESTRUCTOR_MEMBER {
        m.destructor = None;
        return;
    }
    m.attributes.retain(|x| x.field.id != member);
    m.methods.retain(|x| x.id != member);
    if let Some(c) = &mut m.constructors {
        c.retain(|x| x.id != member);
        if c.is_empty() {
            m.constructors = None;
        }
    }
}

/// A base of a module: one of this project, or a placed module of a dependency.
#[derive(Clone, Copy, Debug)]
pub enum BaseModule<'a> {
    Local(&'a Module),
    Imported(&'a ImportedModule),
}

impl<'a> BaseModule<'a> {
    pub fn id(&self) -> &'a str {
        match self {
            BaseModule::Local(m) => &m.id,
            BaseModule::Imported(m) => &m.id,
        }
    }
    /// Methods (as last read for a placed module of a dependency).
    pub fn methods(&self) -> &'a [Method] {
        match self {
            BaseModule::Local(m) => &m.methods,
            BaseModule::Imported(m) => m.methods.as_deref().unwrap_or(&[]),
        }
    }
    pub fn bases(&self) -> &'a [Id] {
        match self {
            BaseModule::Local(m) => m.bases.as_deref().unwrap_or(&[]),
            BaseModule::Imported(_) => &[],
        }
    }
    pub fn is_final(&self) -> bool {
        match self {
            BaseModule::Local(m) => m.r#final,
            BaseModule::Imported(m) => m.r#final,
        }
    }
}

pub fn base_module<'a>(p: &'a Project, id: &str) -> Option<BaseModule<'a>> {
    if is_imported_id(id) {
        find_imported(p, id).map(|(_, m)| BaseModule::Imported(m))
    } else {
        find_module(p, id).map(BaseModule::Local)
    }
}

/// Remove a base of a module, with its type arguments and the shape of its line.
pub fn remove_base(m: &mut Module, base: &str) {
    if let Some(b) = &mut m.bases {
        b.retain(|x| x != base);
        if b.is_empty() {
            m.bases = None;
        }
    }
    if let Some(a) = &mut m.base_args {
        a.shift_remove(base);
        if a.is_empty() {
            m.base_args = None;
        }
    }
    if let Some(r) = &mut m.base_routes {
        r.shift_remove(base);
        if r.is_empty() {
            m.base_routes = None;
        }
    }
}

/// Bases of a module, direct and indirect, nearest first; each listed once.
pub fn ancestor_modules<'a>(p: &'a Project, id: &str) -> Vec<BaseModule<'a>> {
    let mut seen = HashSet::from([id.to_string()]);
    let mut out = Vec::new();
    let mut level = vec![id.to_string()];
    while !level.is_empty() {
        let mut next = Vec::new();
        for cur in &level {
            for b in find_module(p, cur)
                .and_then(|m| m.bases.as_ref())
                .into_iter()
                .flatten()
            {
                let Some(base) = base_module(p, b) else { continue };
                if !seen.insert(b.clone()) {
                    continue;
                }
                out.push(base);
                next.push(b.clone());
            }
        }
        level = next;
    }
    out
}

/// Whether making `base_id` a base of `id` keeps the inheritance acyclic.
pub fn can_derive(p: &Project, id: &str, base_id: &str) -> bool {
    base_id != id && !ancestor_modules(p, base_id).iter().any(|m| m.id() == id)
}

/// Type parameters of a generic module, in order.
pub fn type_params_of<'a>(p: &'a Project, module_id: &str) -> Vec<&'a TypeDef> {
    p.types
        .iter()
        .filter(|t| t.type_param().is_some() && t.module.as_deref() == Some(module_id))
        .collect()
}

/// A type reference as text naming user types by id: equal for the same type.
pub fn type_key(t: &TypeRef) -> String {
    print_type_expr(&map_ref(t, |r| NameRef { name: r.id.clone() }))
}

/// Parameters (directions and types), result and exceptions of a message or method.
pub fn message_signature<'a>(
    params: impl Iterator<Item = &'a Param>,
    returns: Option<&TypeRef>,
    raises: Option<&Vec<Id>>,
) -> String {
    let params: Vec<String> = params
        .map(|p| format!("{} {}", p.direction, type_key(&p.ty)))
        .collect();
    let mut r: Vec<&str> = raises.into_iter().flatten().map(String::as_str).collect();
    r.sort();
    let raises = r.join(", ");
    format!(
        "({}){}{}",
        params.join(", "),
        returns.map(type_key).unwrap_or_default(),
        if raises.is_empty() {
            String::new()
        } else {
            format!(" raises {raises}")
        }
    )
}

pub fn msg_signature(m: &Message) -> String {
    message_signature(m.params.iter(), m.returns.as_ref(), m.raises.as_ref())
}

pub fn method_msg_signature(m: &Method) -> String {
    message_signature(
        m.params.iter().map(|p| &p.param),
        m.returns.as_ref(),
        m.raises.as_ref(),
    )
}

/// Messages of the interfaces a module implements it has no public method for.
pub fn unimplemented_messages<'a>(
    p: &'a Project,
    m: &'a Module,
) -> Vec<(&'a Interface, &'a Message, Option<&'a Method>)> {
    let mut out = Vec::new();
    for id in m.implements.iter().flatten() {
        let Some(iface) = p.interfaces.iter().find(|i| &i.id == id) else {
            continue;
        };
        for message in &iface.messages {
            let named: Vec<&Method> = m.methods.iter().filter(|x| x.name == message.name).collect();
            let sig = msg_signature(message);
            if !named.iter().any(|x| {
                x.access.is_none() && !x.qualifiers.has(Qualifier::Static) && method_msg_signature(x) == sig
            }) {
                out.push((iface, message, named.first().copied()));
            }
        }
    }
    out
}

/// Parameters (direction, const, type), return type and const of a method, to compare overrides.
pub fn method_signature(m: &Method) -> String {
    let params: Vec<String> = m
        .params
        .iter()
        .map(|p| {
            format!(
                "{} {}{}",
                p.param.direction,
                if p.qualifiers.has(Qualifier::Const) {
                    "const "
                } else {
                    ""
                },
                type_key(&p.param.ty)
            )
        })
        .collect();
    format!(
        "({}){}{}",
        params.join(", "),
        m.returns.as_ref().map(type_key).unwrap_or_default(),
        if m.qualifiers.has(Qualifier::Const) {
            " const"
        } else {
            ""
        }
    )
}

/// Parameter types (with directions) and const of a method: overloads of a name differ by it.
pub fn overload_key(params: &[MethodParam], is_const: bool) -> String {
    let params: Vec<String> = params
        .iter()
        .map(|p| {
            let d = if p.param.direction == ParamDirection::In {
                String::new()
            } else {
                format!("{} ", p.param.direction)
            };
            format!("{d}{}", type_key(&p.param.ty))
        })
        .collect();
    format!("({}){}", params.join(", "), if is_const { " const" } else { "" })
}

pub fn method_overload_key(m: &Method) -> String {
    overload_key(&m.params, m.qualifiers.has(Qualifier::Const))
}

/// A method by name and overload key: `f(int32) const`.
pub fn overload_name(m: &Method) -> String {
    format!("{}{}", m.name, method_overload_key(m))
}

/// The method of `methods` `m` overrides or redefines: same name and overload key.
pub fn same_overload<'a>(methods: &'a [Method], m: &Method) -> Option<&'a Method> {
    let key = method_overload_key(m);
    methods
        .iter()
        .find(|x| x.name == m.name && method_overload_key(x) == key)
}

/// Pure methods a module inherits and does not implement.
pub fn unimplemented_methods<'a>(p: &'a Project, id: &str) -> Vec<(BaseModule<'a>, &'a Method)> {
    let mut out: indexmap::IndexMap<String, (BaseModule<'a>, &'a Method)> = indexmap::IndexMap::new();
    fn walk<'a>(
        p: &'a Project,
        cur: BaseModule<'a>,
        defined: &HashSet<String>,
        stack: &HashSet<Id>,
        out: &mut indexmap::IndexMap<String, (BaseModule<'a>, &'a Method)>,
    ) {
        for b in cur.bases() {
            let Some(base) = base_module(p, b) else { continue };
            if stack.contains(b) {
                continue;
            }
            let methods = base.methods();
            for x in methods {
                let key = overload_name(x);
                if x.qualifiers.has(Qualifier::Pure) && !defined.contains(&key) && !out.contains_key(&key) {
                    out.insert(key, (base, x));
                }
            }
            let mut names = defined.clone();
            names.extend(
                methods
                    .iter()
                    .filter(|x| !x.qualifiers.has(Qualifier::Pure))
                    .map(overload_name),
            );
            let mut stack = stack.clone();
            stack.insert(b.clone());
            walk(p, base, &names, &stack, out);
        }
    }
    if let Some(m) = find_module(p, id) {
        let defined = m.methods.iter().map(overload_name).collect();
        walk(
            p,
            BaseModule::Local(m),
            &defined,
            &HashSet::from([id.to_string()]),
            &mut out,
        );
    }
    out.into_values().collect()
}

pub fn unique_name<'a>(base: &str, taken: impl IntoIterator<Item = &'a str>) -> String {
    let set: HashSet<&str> = taken.into_iter().collect();
    if !set.contains(base) {
        return base.to_string();
    }
    (2..)
        .map(|i| format!("{base}{i}"))
        .find(|n| !set.contains(n.as_str()))
        .expect("free name")
}

/// Names that must be unique together: user types, interfaces and constants (not module types).
pub fn global_type_names<'a>(p: &'a Project, except_id: Option<&str>) -> Vec<&'a str> {
    let types = p
        .types
        .iter()
        .filter(|t| !t.is_module_type())
        .map(|t| (&t.id, &t.name));
    let ifaces = p.interfaces.iter().map(|i| (&i.id, &i.name));
    let consts = p.consts.iter().map(|c| (&c.id, &c.name));
    types
        .chain(ifaces)
        .chain(consts)
        .filter(|(id, _)| Some(id.as_str()) != except_id)
        .map(|(_, n)| n.as_str())
        .collect()
}

/// Types of a module of this project.
pub fn module_types<'a>(p: &'a Project, module_id: &str) -> Vec<&'a TypeDef> {
    p.types
        .iter()
        .filter(|t| t.module.as_deref() == Some(module_id))
        .collect()
}

/// Names of the types as the file writes them, by id.
pub fn type_names_of(
    types: &[TypeDef],
    modules: &[Module],
    dependencies: &[Dependency],
) -> HashMap<Id, String> {
    let paths = module_paths(modules, dependencies);
    let deps: HashMap<&str, &str> = dependencies
        .iter()
        .map(|x| (x.id.as_str(), x.name.as_str()))
        .collect();
    types
        .iter()
        .map(|t| (t.id.clone(), qualified_type_name(t, &paths, &deps)))
        .collect()
}

pub fn type_names(p: &Project) -> HashMap<Id, String> {
    type_names_of(&p.types, &p.modules, &p.dependencies)
}

fn qualified_type_name(t: &TypeDef, paths: &HashMap<Id, String>, deps: &HashMap<&str, &str>) -> String {
    if let Some(m) = &t.module {
        return format!("{}.{}", paths.get(m).map(String::as_str).unwrap_or("?"), t.name);
    }
    if let Some(mp) = &t.module_path {
        let dep = t
            .dependency
            .as_deref()
            .and_then(|d| deps.get(d))
            .copied()
            .unwrap_or("?");
        return format!("{dep}/{mp}.{}", t.name);
    }
    t.name.clone()
}

/// Name of a type as the file writes it.
pub fn type_qualified_name(p: &Project, t: &TypeDef) -> String {
    if !t.is_module_type() {
        return t.name.clone();
    }
    let deps = p
        .dependencies
        .iter()
        .map(|x| (x.id.as_str(), x.name.as_str()))
        .collect();
    qualified_type_name(t, &project_module_paths(p), &deps)
}

const DEPENDENCY_MODULE_PREFIX: &str = "depmodule:";

/// Id standing for the module at `path` of dependency `dependency` in type references.
pub fn dependency_module_ref(dependency: &str, path: &str) -> Id {
    format!("{DEPENDENCY_MODULE_PREFIX}{dependency}|{path}")
}

/// Dependency and module path of an id made by `dependency_module_ref`.
pub fn parse_dependency_module_ref(id: &str) -> Option<(&str, &str)> {
    let rest = id.strip_prefix(DEPENDENCY_MODULE_PREFIX)?;
    let bar = rest.rfind('|')?;
    Some((&rest[..bar], &rest[bar + 1..]))
}

/// Whether a type reference names a module rather than a type.
pub fn is_module_ref(p: &Project, id: &str) -> bool {
    parse_dependency_module_ref(id).is_some() || p.modules.iter().any(|m| m.id == id)
}

const MISSING_PREFIX: &str = "missing:";

/// Id of a reference to a type, module or interface named `name` that the project does not have.
pub fn missing_ref(name: &str) -> Id {
    format!("{MISSING_PREFIX}{name}")
}

/// Name kept by an id made by `missing_ref`.
pub fn missing_name(id: &str) -> Option<&str> {
    id.strip_prefix(MISSING_PREFIX)
}

/// Every type reference of the project, mutably (those `all_type_refs` lists).
pub fn for_each_type_ref_mut(d: &mut Project, f: &mut impl FnMut(&mut TypeRef)) {
    for t in &mut d.types {
        match &mut t.body {
            TypeBody::Struct { fields, .. } | TypeBody::Exception { fields } => {
                fields.iter_mut().for_each(|x| f(&mut x.ty))
            }
            TypeBody::Alias { ty } => f(ty),
            TypeBody::Union { discriminator, cases } => {
                f(discriminator);
                cases.iter_mut().for_each(|c| f(&mut c.ty));
            }
            _ => {}
        }
    }
    for c in &mut d.consts {
        f(&mut c.ty)
    }
    for i in &mut d.interfaces {
        for m in &mut i.messages {
            m.params.iter_mut().for_each(|p| f(&mut p.ty));
            if let Some(r) = &mut m.returns {
                f(r)
            }
        }
    }
    let methods = |ms: &mut Vec<Method>, f: &mut dyn FnMut(&mut TypeRef)| {
        for m in ms {
            m.params.iter_mut().for_each(|p| f(&mut p.param.ty));
            if let Some(r) = &mut m.returns {
                f(r)
            }
        }
    };
    for m in &mut d.modules {
        m.attributes.iter_mut().for_each(|a| f(&mut a.field.ty));
        methods(&mut m.methods, f);
    }
}

/// Every reference id node of a type tree, mutably.
pub fn for_each_ref_id_mut(t: &mut TypeRef, f: &mut impl FnMut(&mut Id)) {
    match t {
        TypeRefOf::Ref { target, args } => {
            f(&mut target.id);
            for a in args.iter_mut().flatten() {
                for_each_ref_id_mut(a, f)
            }
        }
        TypeRefOf::Array { of, .. }
        | TypeRefOf::Vector { of, .. }
        | TypeRefOf::List { of, .. }
        | TypeRefOf::Set { of, .. }
        | TypeRefOf::Optional { of } => for_each_ref_id_mut(of, f),
        TypeRefOf::Map { key, value, .. } => {
            for_each_ref_id_mut(key, f);
            for_each_ref_id_mut(value, f);
        }
        TypeRefOf::Primitive { .. } => {}
    }
}

/// Every raised exception list and port interface of the project, mutably.
fn for_each_raise_and_port_mut(
    d: &mut Project,
    raise: &mut impl FnMut(&mut Id),
    port: &mut impl FnMut(&mut Id),
) {
    for i in &mut d.interfaces {
        for m in &mut i.messages {
            m.raises.iter_mut().flatten().for_each(&mut *raise);
        }
    }
    for m in &mut d.modules {
        for x in &mut m.methods {
            x.raises.iter_mut().flatten().for_each(&mut *raise);
        }
        for pt in &mut m.ports {
            if let Some(i) = &mut pt.interface_id {
                port(i)
            }
        }
    }
}

/// Make the references to what `name_of` names (by id) missing ones.
pub fn orphan_refs(d: &mut Project, name_of: impl Fn(&str) -> Option<String>) {
    let orphan = |id: &mut Id| {
        if let Some(name) = name_of(id) {
            *id = missing_ref(&name)
        }
    };
    for_each_type_ref_mut(d, &mut |t| for_each_ref_id_mut(t, &mut |id| orphan(id)));
    for_each_raise_and_port_mut(d, &mut |id| orphan(id), &mut |id| orphan(id));
}

/// Whether the project has missing references.
pub fn has_missing_refs(p: &Project) -> bool {
    let missing = |id: &str| missing_name(id).is_some();
    if p.modules.iter().any(|m| {
        m.ports
            .iter()
            .any(|pt| pt.interface_id.as_deref().is_some_and(missing))
    }) {
        return true;
    }
    let raises = p
        .interfaces
        .iter()
        .flat_map(|i| i.messages.iter().map(|m| &m.raises))
        .chain(p.modules.iter().flat_map(|m| m.methods.iter().map(|x| &x.raises)));
    if raises.flatten().flatten().any(|id| missing(id)) {
        return true;
    }
    all_type_refs(p).iter().any(|u| {
        let mut found = false;
        walk_type_ref(&u.ty, &mut |n| {
            if let TypeRefOf::Ref { target, .. } = n {
                found |= missing(&target.id)
            }
        });
        found
    })
}

/// Point the missing references naming what the project has (again) at it.
pub fn resolve_missing_refs(d: &mut Project) {
    let resolve = ref_resolver(d);
    let interfaces: HashMap<String, Id> = d
        .interfaces
        .iter()
        .map(|i| (i.name.clone(), i.id.clone()))
        .collect();
    let found = |id: &mut Id, lookup: &dyn Fn(&str) -> Option<Id>| {
        if let Some(n) = missing_name(id).and_then(lookup) {
            *id = n
        }
    };
    for_each_type_ref_mut(d, &mut |t| for_each_ref_id_mut(t, &mut |id| found(id, &resolve)));
    for_each_raise_and_port_mut(d, &mut |id| found(id, &resolve), &mut |id| {
        found(id, &|n| interfaces.get(n).cloned())
    });
}

/// Names type references write, by id (None for a deleted one).
pub fn ref_namer(p: &Project) -> impl Fn(&str) -> Option<String> + use<> {
    let types = type_names(p);
    let paths = module_paths(&p.modules, &[]);
    let deps: HashMap<Id, String> = p
        .dependencies
        .iter()
        .map(|x| (x.id.clone(), x.name.clone()))
        .collect();
    move |id: &str| {
        if let Some(n) = types.get(id).or_else(|| paths.get(id)) {
            return Some(n.clone());
        }
        match parse_dependency_module_ref(id) {
            Some((dep, path)) => deps.get(dep).map(|d| format!("{d}/{path}")),
            None => missing_name(id).map(str::to_string),
        }
    }
}

/// Id a name of a type reference stands for (`ref_namer` reversed).
pub fn ref_resolver(p: &Project) -> impl Fn(&str) -> Option<Id> + use<> {
    let types: HashMap<String, Id> = type_names(p).into_iter().map(|(id, n)| (n, id)).collect();
    let modules: HashMap<String, Id> = module_paths(&p.modules, &[])
        .into_iter()
        .map(|(id, n)| (n, id))
        .collect();
    let deps: HashMap<String, Id> = p
        .dependencies
        .iter()
        .map(|x| (x.name.clone(), x.id.clone()))
        .collect();
    move |name: &str| {
        if let Some(id) = types.get(name).or_else(|| modules.get(name)) {
            return Some(id.clone());
        }
        let slash = name.find('/').filter(|s| *s > 0)?;
        deps.get(&name[..slash])
            .map(|d| dependency_module_ref(d, &name[slash + 1..]))
    }
}

/// Modules of dependencies known here, as type references name them.
pub fn dependency_module_refs(p: &Project) -> Vec<(Id, String)> {
    let mut ids: indexmap::IndexSet<Id> = indexmap::IndexSet::new();
    for dep in &p.dependencies {
        for m in &dep.modules {
            ids.insert(dependency_module_ref(&dep.id, &m.path));
        }
    }
    for t in &p.types {
        if let (Some(d), Some(mp)) = (&t.dependency, &t.module_path) {
            ids.insert(dependency_module_ref(d, mp));
        }
    }
    for r in all_type_refs(p) {
        walk_type_ref(&r.ty, &mut |n| {
            if let TypeRefOf::Ref { target, .. } = n {
                if parse_dependency_module_ref(&target.id).is_some() {
                    ids.insert(target.id.clone());
                }
            }
        });
    }
    let name_of = ref_namer(p);
    ids.into_iter()
        .filter_map(|id| name_of(&id).map(|n| (id, n)))
        .collect()
}

/// Whether modules (`context`; None: outside modules) may use a type.
pub fn can_use_type(p: &Project, context: Option<&str>, t: &TypeDef) -> bool {
    if !t.is_module_type() || t.access.is_none() {
        return true;
    }
    let (Some(ctx), Some(module)) = (context, t.module.as_deref()) else {
        return false;
    };
    if module == ctx {
        return true;
    }
    t.access == Some(StoredAccess::Protected) && ancestor_modules(p, ctx).iter().any(|m| m.id() == module)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UsageKind {
    Type,
    Interface,
    Const,
    Module,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct UsageOwner {
    pub kind: UsageKind,
    pub id: Id,
}

/// Module whose scope a reference held by `owner` is in.
pub fn ref_context(p: &Project, owner: &UsageOwner) -> Option<Id> {
    match owner.kind {
        UsageKind::Module => Some(owner.id.clone()),
        UsageKind::Type => p
            .types
            .iter()
            .find(|t| t.id == owner.id)
            .and_then(|t| t.module.clone()),
        _ => None,
    }
}

/// Names of the types in a scope: a module (C++-like lookup) or outside modules.
pub struct TypeScope {
    qualified: HashMap<Id, String>,
    by_qualified: HashMap<String, Id>,
    local: HashMap<String, Id>,
    type_name: HashMap<Id, String>,
    module_by_name: HashMap<String, Id>,
    module_name: HashMap<Id, String>,
    /// Types this scope may use, with the name to write.
    pub usable: Vec<(Id, String)>,
    /// Modules usable as types, by path.
    pub modules: Vec<(Id, String)>,
}

impl TypeScope {
    /// Name of a type written in this scope.
    pub fn name_of(&self, id: &str) -> Option<String> {
        match self.type_name.get(id) {
            None => self.module_name.get(id).cloned(),
            Some(n) => {
                if self.local.get(n).map(String::as_str) == Some(id) {
                    Some(n.clone())
                } else {
                    self.qualified.get(id).cloned()
                }
            }
        }
    }
    /// Type a name written in this scope stands for.
    pub fn id_of(&self, name: &str) -> Option<Id> {
        self.local
            .get(name)
            .or_else(|| self.by_qualified.get(name))
            .or_else(|| self.module_by_name.get(name))
            .cloned()
    }
}

pub fn type_scope(p: &Project, context: Option<&str>) -> TypeScope {
    let qualified = type_names(p);
    let by_qualified: HashMap<String, Id> = qualified.iter().map(|(id, n)| (n.clone(), id.clone())).collect();
    let own: Vec<(Id, String)> = {
        let paths = module_paths(&p.modules, &[]);
        p.modules
            .iter()
            .map(|m| (m.id.clone(), paths[&m.id].clone()))
            .collect()
    };
    let modules: Vec<(Id, String)> = own
        .into_iter()
        .chain(dependency_module_refs(p))
        .filter(|(_, n)| !by_qualified.contains_key(n))
        .collect();
    let module_by_name = modules.iter().map(|(id, n)| (n.clone(), id.clone())).collect();
    let module_name = modules.iter().map(|(id, n)| (id.clone(), n.clone())).collect();
    let mut local: HashMap<String, Id> = HashMap::new();
    if let Some(ctx) = context {
        let chain: Vec<Id> = std::iter::once(ctx.to_string())
            .chain(ancestor_modules(p, ctx).iter().map(|a| a.id().to_string()))
            .collect();
        for m in chain {
            let placed = find_imported(p, &m);
            for t in &p.types {
                let owns = match placed {
                    Some((dep, im)) => {
                        t.dependency.as_deref() == Some(&dep.id) && t.module_path.as_deref() == Some(&im.path)
                    }
                    None => t.module.as_deref() == Some(&m),
                };
                if owns && !local.contains_key(&t.name) && can_use_type(p, context, t) {
                    local.insert(t.name.clone(), t.id.clone());
                }
            }
        }
    }
    for t in &p.types {
        if !t.is_module_type() && !local.contains_key(&t.name) {
            local.insert(t.name.clone(), t.id.clone());
        }
    }
    let type_name = p.types.iter().map(|t| (t.id.clone(), t.name.clone())).collect();
    let mut scope = TypeScope {
        qualified,
        by_qualified,
        local,
        type_name,
        module_by_name,
        module_name,
        usable: vec![],
        modules,
    };
    scope.usable = p
        .types
        .iter()
        .filter(|t| can_use_type(p, context, t))
        .map(|t| (t.id.clone(), scope.name_of(&t.id).unwrap_or_default()))
        .collect();
    scope
}

/// What a name is checked for.
#[derive(Clone, Debug)]
pub enum NameTarget {
    Type { id: Option<Id>, module: Option<Id> },
    Interface { id: Option<Id> },
    Const { id: Option<Id> },
    Module { id: Option<Id>, parent_id: Option<Id> },
    Port { id: Option<Id>, module_id: Id },
    Other,
}

/// Check a name for an entity.
pub fn name_error(p: &Project, target: &NameTarget, name: &str) -> Option<String> {
    if !is_identifier(name) {
        return Some("Must be an identifier: letters, digits, _ (not starting with a digit)".into());
    }
    match target {
        NameTarget::Type { id, .. } | NameTarget::Interface { id } | NameTarget::Const { id } => {
            if is_reserved_type_name(name) {
                return Some(format!("'{name}' is a reserved type name"));
            }
            if let NameTarget::Type {
                module: Some(module), ..
            } = target
            {
                return module_type_name_error(p, module, name, id.as_deref());
            }
            if global_type_names(p, id.as_deref()).contains(&name) {
                return Some(format!(
                    "A type, interface or constant named '{name}' already exists"
                ));
            }
            if child_modules(p, None).any(|m| m.name == name) {
                return Some(format!("A module named '{name}' already exists"));
            }
            None
        }
        NameTarget::Module { id, parent_id } => {
            if child_modules(p, parent_id.as_deref()).any(|m| Some(&m.id) != id.as_ref() && m.name == name) {
                return Some(format!("A sibling module named '{name}' already exists"));
            }
            if parent_id.is_none() && global_type_names(p, None).contains(&name) {
                return Some(format!(
                    "A type, interface or constant named '{name}' already exists"
                ));
            }
            None
        }
        NameTarget::Port { id, module_id } => {
            let m = find_module(p, module_id)?;
            if m.ports
                .iter()
                .any(|pt| Some(&pt.id) != id.as_ref() && pt.name == name)
            {
                return Some(format!("This module already has a port named '{name}'"));
            }
            None
        }
        NameTarget::Other => None,
    }
}

fn module_type_name_error(
    p: &Project,
    module_id: &str,
    name: &str,
    except_id: Option<&str>,
) -> Option<String> {
    if module_types(p, module_id)
        .iter()
        .any(|t| Some(t.id.as_str()) != except_id && t.name == name)
    {
        return Some(format!("This module already has a type named '{name}'"));
    }
    if let Some(m) = find_module(p, module_id) {
        if member_names(p, m).contains(&name.to_string()) {
            return Some(format!(
                "This module already has an attribute, method, port or submodule named '{name}'"
            ));
        }
    }
    None
}

/// Names of a module's attributes, methods, ports and submodules.
pub fn member_names(p: &Project, m: &Module) -> Vec<String> {
    m.attributes
        .iter()
        .map(|a| a.field.name.clone())
        .chain(m.methods.iter().map(|x| x.name.clone()))
        .chain(m.ports.iter().map(|x| x.name.clone()))
        .chain(child_modules(p, Some(&m.id)).map(|c| c.name.clone()))
        .collect()
}

/// Check the name of a custom transport (`except`: its index when renamed).
pub fn transport_error(p: &Project, name: &str, except: Option<usize>) -> Option<String> {
    if name.trim().is_empty() {
        return Some("Must not be empty".into());
    }
    if TRANSPORTS.contains(&name) {
        return Some("Built-in transport".into());
    }
    if p.transports
        .iter()
        .enumerate()
        .any(|(i, t)| Some(i) != except && t == name)
    {
        return Some("Name already used".into());
    }
    None
}

/// Check the name of a binary (`except`: its id when renamed).
pub fn binary_error(p: &Project, name: &str, except: Option<&str>) -> Option<String> {
    if !is_identifier(name) {
        return Some("Must be an identifier".into());
    }
    if p.binaries
        .iter()
        .any(|b| Some(b.id.as_str()) != except && b.name == name)
    {
        return Some("Name already used".into());
    }
    None
}

/// A type reference of the project, with where it is used and who holds it.
#[derive(Clone, Debug)]
pub struct TypeRefUse {
    pub ty: TypeRef,
    pub r#where: String,
    pub owner: UsageOwner,
    pub raised: bool,
    pub access: Option<Access>,
}

/// Every type reference in the project.
pub fn all_type_refs(p: &Project) -> Vec<TypeRefUse> {
    let names = type_names(p);
    let mut out = Vec::new();
    let mut push = |ty: &TypeRef, w: String, owner: &UsageOwner, raised: bool, access: Option<Access>| {
        out.push(TypeRefUse {
            ty: ty.clone(),
            r#where: w,
            owner: owner.clone(),
            raised,
            access,
        })
    };
    for t in &p.types {
        let owner = UsageOwner {
            kind: UsageKind::Type,
            id: t.id.clone(),
        };
        let name = &names[&t.id];
        let access = t
            .is_module_type()
            .then(|| t.access.map_or(Access::Public, StoredAccess::access));
        match &t.body {
            TypeBody::Struct { fields, .. } | TypeBody::Exception { fields } => {
                for f in fields {
                    push(&f.ty, format!("{name}.{}", f.name), &owner, false, access);
                }
            }
            TypeBody::Alias { ty } => push(ty, name.clone(), &owner, false, access),
            TypeBody::Union { discriminator, cases } => {
                push(
                    discriminator,
                    format!("{name} discriminator"),
                    &owner,
                    false,
                    access,
                );
                for c in cases {
                    push(&c.ty, format!("{name}.{}", c.name), &owner, false, access);
                }
            }
            _ => {}
        }
    }
    for c in &p.consts {
        push(
            &c.ty,
            c.name.clone(),
            &UsageOwner {
                kind: UsageKind::Const,
                id: c.id.clone(),
            },
            false,
            None,
        );
    }
    for i in &p.interfaces {
        let owner = UsageOwner {
            kind: UsageKind::Interface,
            id: i.id.clone(),
        };
        for m in &i.messages {
            for prm in &m.params {
                push(
                    &prm.ty,
                    format!("{}.{}({})", i.name, m.name, prm.name),
                    &owner,
                    false,
                    None,
                );
            }
            if let Some(r) = &m.returns {
                push(r, format!("{}.{} returns", i.name, m.name), &owner, false, None);
            }
            for id in m.raises.iter().flatten() {
                push(
                    &TypeRef::to(id.clone()),
                    format!("{}.{} raises", i.name, m.name),
                    &owner,
                    true,
                    None,
                );
            }
        }
    }
    let paths = project_module_paths(p);
    for m in &p.modules {
        let owner = UsageOwner {
            kind: UsageKind::Module,
            id: m.id.clone(),
        };
        let path = &paths[&m.id];
        for a in &m.attributes {
            let access = Some(a.access.map_or(Access::Public, StoredAccess::access));
            push(
                &a.field.ty,
                format!("{path}.{}", a.field.name),
                &owner,
                false,
                access,
            );
        }
        for x in &m.methods {
            let access = Some(x.access.map_or(Access::Public, StoredAccess::access));
            for prm in &x.params {
                push(
                    &prm.param.ty,
                    format!("{path}.{}({})", x.name, prm.param.name),
                    &owner,
                    false,
                    access,
                );
            }
            if let Some(r) = &x.returns {
                push(r, format!("{path}.{} returns", x.name), &owner, false, access);
            }
            for id in x.raises.iter().flatten() {
                push(
                    &TypeRef::to(id.clone()),
                    format!("{path}.{} raises", x.name),
                    &owner,
                    true,
                    access,
                );
            }
        }
    }
    out
}

/// Places using a type, with the entity holding each reference.
pub fn type_usage_targets(p: &Project, type_id: &str) -> Vec<(String, UsageOwner)> {
    all_type_refs(p)
        .into_iter()
        .filter(|u| {
            let mut used = false;
            walk_type_ref(&u.ty, &mut |n| {
                if let TypeRefOf::Ref { target, .. } = n {
                    used |= target.id == type_id
                }
            });
            used
        })
        .map(|u| (u.r#where, u.owner))
        .collect()
}

pub fn type_usages(p: &Project, type_id: &str) -> Vec<String> {
    type_usage_targets(p, type_id)
        .into_iter()
        .map(|(w, _)| w)
        .collect()
}

// Views

pub fn global_view() -> View {
    View {
        id: GLOBAL_VIEW.into(),
        name: "Project".into(),
        root_module_id: None,
        hidden: vec![],
        layouts: None,
        routes: None,
        port_labels: None,
        stand_ins: None,
        temporary: false,
    }
}

const ISOLATED: &str = "isolate:";

/// Id of the temporary view showing a module with its content.
pub fn isolated_view_id(module_id: &str) -> Id {
    format!("{ISOLATED}{module_id}")
}

/// Module shown by a temporary view id.
pub fn isolated_module_id(view_id: &str) -> Option<&str> {
    view_id.strip_prefix(ISOLATED)
}

/// The view with this id (a temporary view resolved from its module); the global view otherwise.
pub fn find_view(p: &Project, view_id: &str) -> View {
    if let Some(v) = p.views.iter().find(|v| v.id == view_id) {
        return v.clone();
    }
    let temp = |name: String, root: &str| View {
        id: view_id.into(),
        name,
        root_module_id: Some(root.into()),
        temporary: true,
        ..global_view()
    };
    if let Some(module_id) = isolated_module_id(view_id) {
        if let Some(m) = find_module(p, module_id) {
            return temp(m.name.clone(), &m.id);
        }
        if let Some((_, im)) = find_imported(p, module_id) {
            return temp(im.path.rsplit('.').next().unwrap_or("").to_string(), &im.id);
        }
    }
    global_view()
}

/// Whether a temporary view can be stored in the project.
pub fn can_keep_view(view: &View) -> bool {
    view.temporary && !view.root_module_id.as_deref().is_some_and(is_imported_id)
}

pub fn view_exists(p: &Project, view_id: &str) -> bool {
    view_id == GLOBAL_VIEW || find_view(p, view_id).id == view_id
}

/// Notes drawn in a view.
pub fn view_notes<'a>(p: &'a Project, view: &View) -> Vec<&'a Note> {
    p.notes
        .iter()
        .filter(|n| {
            if view.root_module_id.is_some() {
                n.view_id.as_deref() == Some(&view.id)
            } else {
                n.view_id.is_none()
            }
        })
        .collect()
}

/// Data path segment.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum PathKey {
    Key(String),
    Index(usize),
}

impl From<&str> for PathKey {
    fn from(s: &str) -> Self {
        PathKey::Key(s.to_string())
    }
}
impl From<usize> for PathKey {
    fn from(i: usize) -> Self {
        PathKey::Index(i)
    }
}
impl std::fmt::Display for PathKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathKey::Key(k) => f.write_str(k),
            PathKey::Index(i) => write!(f, "{i}"),
        }
    }
}

pub type DataPath = Vec<PathKey>;

#[macro_export]
macro_rules! path {
    ($($k:expr),* $(,)?) => { vec![$($crate::project::PathKey::from($k)),*] };
}

/// Place of a note in the project file.
pub fn note_path(p: &Project, id: &str) -> Option<DataPath> {
    let n = p.notes.iter().find(|n| n.id == id)?;
    let i = p
        .notes
        .iter()
        .filter(|x| x.view_id == n.view_id)
        .position(|x| x.id == id)?;
    match &n.view_id {
        None => Some(path!["editor", "notes", i]),
        Some(v) => {
            let j = p.views.iter().position(|x| &x.id == v)?;
            Some(path!["editor", "views", j, "notes", i])
        }
    }
}

/// The note at a place of the project file.
pub fn note_at_path<'a>(p: &'a Project, path: &[PathKey]) -> Option<&'a Note> {
    match path {
        [_, PathKey::Key(s), PathKey::Index(a), ..] if s == "notes" => {
            p.notes.iter().filter(|n| n.view_id.is_none()).nth(*a)
        }
        [
            _,
            PathKey::Key(s),
            PathKey::Index(a),
            PathKey::Key(n),
            PathKey::Index(b),
            ..,
        ] if s == "views" && n == "notes" => {
            let view = p.views.get(*a)?;
            p.notes
                .iter()
                .filter(|n| n.view_id.as_deref() == Some(&view.id))
                .nth(*b)
        }
        _ => None,
    }
}

/// Ids of a placed module of a dependency and of the placed modules inside it.
pub fn imported_subtree_ids(p: &Project, id: &str) -> HashSet<Id> {
    let Some((dep, m)) = find_imported(p, id) else {
        return HashSet::new();
    };
    let prefix = format!("{}.", m.path);
    std::iter::once(id.to_string())
        .chain(
            dep.modules
                .iter()
                .filter(|x| x.path.starts_with(&prefix))
                .map(|x| x.id.clone()),
        )
        .collect()
}

/// Ids of the modules a view rooted at `root_id` is about.
pub fn view_scope_ids(p: &Project, root_id: &str) -> HashSet<Id> {
    if is_imported_id(root_id) {
        imported_subtree_ids(p, root_id)
    } else {
        subtree_ids(p, root_id)
    }
}

/// Ids of the modules drawn in a view.
pub fn visible_module_ids(p: &Project, view: &View) -> HashSet<Id> {
    let mut scope = match &view.root_module_id {
        Some(r) => view_scope_ids(p, r),
        None => p
            .modules
            .iter()
            .map(|m| m.id.clone())
            .chain(all_imported(p).map(|m| m.id.clone()))
            .collect(),
    };
    for h in &view.hidden {
        if Some(h) != view.root_module_id.as_ref() {
            for id in subtree_ids(p, h) {
                scope.remove(&id);
            }
        }
    }
    scope
}

/// Drop view references to deleted modules, ports and links.
pub fn prune_views(p: &mut Project) {
    let ids: HashSet<Id> = p.modules.iter().map(|m| m.id.clone()).collect();
    let placed: Vec<&ImportedModule> = all_imported(p).collect();
    let any_ids: HashSet<Id> = ids
        .iter()
        .cloned()
        .chain(placed.iter().map(|m| m.id.clone()))
        .collect();
    let port_ids: HashSet<Id> = p
        .modules
        .iter()
        .flat_map(|m| m.ports.iter().map(|pt| pt.id.clone()))
        .chain(placed.iter().flat_map(|m| m.ports.iter().map(|pt| pt.id.clone())))
        .collect();
    let link_ids: HashSet<Id> = p.links.iter().map(|l| l.id.clone()).collect();
    p.views
        .retain(|v| v.root_module_id.as_ref().is_none_or(|r| ids.contains(r)));
    let view_ids: HashSet<Id> = p.views.iter().map(|v| v.id.clone()).collect();
    p.notes
        .retain(|n| n.view_id.as_ref().is_none_or(|v| view_ids.contains(v)));
    fn prune<V>(own: &mut Option<indexmap::IndexMap<Id, V>>, kept: &HashSet<Id>) {
        if let Some(m) = own {
            m.retain(|k, _| kept.contains(k));
            if m.is_empty() {
                *own = None;
            }
        }
    }
    for v in &mut p.views {
        v.hidden.retain(|h| any_ids.contains(h));
        prune(&mut v.layouts, &ids);
        prune(&mut v.stand_ins, &any_ids);
        prune(&mut v.port_labels, &port_ids);
        prune(&mut v.routes, &link_ids);
    }
}

/// Bounding box of rects.
pub fn bounds_of(rects: &[Rect]) -> Rect {
    if rects.is_empty() {
        return Rect::default();
    }
    let x = rects.iter().map(|r| r.x).fold(f64::INFINITY, f64::min);
    let y = rects.iter().map(|r| r.y).fold(f64::INFINITY, f64::min);
    let right = rects
        .iter()
        .map(|r| r.x + r.width)
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = rects
        .iter()
        .map(|r| r.y + r.height)
        .fold(f64::NEG_INFINITY, f64::max);
    Rect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    }
}

/// Absolute rect of a module.
pub fn absolute_rect(p: &Project, id: &str) -> Rect {
    let pos = absolute_position(p, id);
    if let Some((_, m)) = find_imported(p, id) {
        let s = imported_size(m, p.orientation);
        return Rect {
            x: pos.x,
            y: pos.y,
            width: s.width,
            height: s.height,
        };
    }
    let m = find_module(p, id);
    Rect {
        x: pos.x,
        y: pos.y,
        width: m.map_or(0., |m| m.layout.width),
        height: m.map_or(0., |m| m.layout.height),
    }
}
