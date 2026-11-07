//! Semantic checks. Errors block export; warnings do not. Port of `validate.ts`.

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::Value;

use crate::binaries::{binaries_of, crosses};
use crate::constraints::{constraint_errors, constraint_value_errors, module_refs};
use crate::contracts::unknown_names;
use crate::defaults::{Resolved, resolve as resolve_type, types_by_id, value_errors};
use crate::project::*;
use crate::sync::normalize_file;
use crate::transports::{DEFAULT_HOST, foreign_fields};
use crate::typeexpr::{is_reserved_type_name, walk_type_ref};
use crate::types::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ProblemTarget {
    Project,
    Type(Id),
    Interface(Id),
    Const(Id),
    Module(Id),
    Link(Id),
    Dependency(Id),
}

impl ProblemTarget {
    pub fn id(&self) -> Option<&str> {
        match self {
            ProblemTarget::Project => None,
            ProblemTarget::Type(id)
            | ProblemTarget::Interface(id)
            | ProblemTarget::Const(id)
            | ProblemTarget::Module(id)
            | ProblemTarget::Link(id)
            | ProblemTarget::Dependency(id) => Some(id),
        }
    }
    fn of_owner(owner: &UsageOwner) -> Self {
        match owner.kind {
            UsageKind::Type => ProblemTarget::Type(owner.id.clone()),
            UsageKind::Interface => ProblemTarget::Interface(owner.id.clone()),
            UsageKind::Const => ProblemTarget::Const(owner.id.clone()),
            UsageKind::Module => ProblemTarget::Module(owner.id.clone()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Problem {
    pub severity: Severity,
    pub message: String,
    pub target: ProblemTarget,
}

fn duplicates<S: AsRef<str>>(names: impl IntoIterator<Item = S>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut dups: Vec<String> = Vec::new();
    for n in names {
        let n = n.as_ref().to_string();
        if !seen.insert(n.clone()) && !dups.contains(&n) {
            dups.push(n);
        }
    }
    dups
}

/// What a reference to something the project lacks says.
fn missing_text(id: &str, kind: &str, deleted: &str, verb: &str) -> String {
    match missing_name(id) {
        None => format!("{verb} a deleted {deleted}"),
        Some(name) => format!("{verb} unknown {kind} '{name}'"),
    }
}

/// A value as JavaScript's `String(v)` writes it.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => crate::emit::js_number(n),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        _ => crate::emit::to_json(v).trim_end().to_string(),
    }
}

/// A resolved type (aliases followed): a reference that is no user type, or a definition.
#[derive(Clone, Copy)]
enum R<'a> {
    Ref(&'a TypeRef),
    Def(&'a TypeDef),
}

impl<'a> R<'a> {
    fn primitive(&self) -> Option<Primitive> {
        match self {
            R::Ref(TypeRefOf::Primitive { name, .. }) => Some(*name),
            _ => None,
        }
    }
    fn def(&self) -> Option<&'a TypeDef> {
        match self {
            R::Def(d) => Some(d),
            _ => None,
        }
    }
}

struct V<'a> {
    p: &'a Project,
    problems: Vec<Problem>,
    from_library: HashSet<Id>,
    types: HashMap<&'a str, &'a TypeDef>,
    dependency_ids: HashSet<&'a str>,
    shared_modules: OnceCell<HashSet<Id>>,
    contract_globals: OnceCell<HashSet<String>>,
}

impl<'a> V<'a> {
    fn push(&mut self, severity: Severity, target: &ProblemTarget, message: String) {
        if severity == Severity::Warning && target.id().is_some_and(|id| self.from_library.contains(id)) {
            return;
        }
        self.problems.push(Problem {
            severity,
            target: target.clone(),
            message,
        });
    }
    fn error(&mut self, target: &ProblemTarget, message: String) {
        self.push(Severity::Error, target, message)
    }
    fn warn(&mut self, target: &ProblemTarget, message: String) {
        self.push(Severity::Warning, target, message)
    }

    fn is_module(&self, id: &str) -> bool {
        is_module_ref(self.p, id)
    }

    /// Whether a type reference names an existing type or module.
    fn exists(&self, id: &str) -> bool {
        if self.types.contains_key(id) {
            return true;
        }
        match parse_dependency_module_ref(id) {
            Some((dep, _)) => self.dependency_ids.contains(dep),
            None => self.is_module(id),
        }
    }

    /// Follow aliases; the reference itself for a module, None for dangling or cyclic aliases.
    fn resolve(&self, t: &'a TypeRef, seen: &mut HashSet<Id>) -> Option<R<'a>> {
        let TypeRefOf::Ref { target, .. } = t else {
            return Some(R::Ref(t));
        };
        let def = self.types.get(target.id.as_str()).copied();
        if def.is_none() && self.exists(&target.id) {
            return Some(R::Ref(t));
        }
        let def = def?;
        if seen.contains(&target.id) {
            return None;
        }
        match &def.body {
            TypeBody::Alias { ty } => {
                seen.insert(target.id.clone());
                self.resolve(ty, seen)
            }
            _ => Some(R::Def(def)),
        }
    }

    fn res(&self, t: &'a TypeRef) -> Option<R<'a>> {
        self.resolve(t, &mut HashSet::new())
    }

    fn module_name(&self, id: &str) -> String {
        match parse_dependency_module_ref(id) {
            Some((dep, path)) => format!(
                "{}/{path}",
                self.p
                    .dependencies
                    .iter()
                    .find(|x| x.id == dep)
                    .map_or("?", |x| x.name.as_str())
            ),
            None => module_path(self.p, id),
        }
    }

    /// Type arguments `args` given to the type or module `id` (`name`): its type parameters.
    fn check_type_args(
        &mut self,
        id: &str,
        args: &'a [TypeRef],
        target: &ProblemTarget,
        w: &str,
        name: &str,
    ) {
        let params: Vec<&TypeDef> = if self.p.modules.iter().any(|m| m.id == id) {
            type_params_of(self.p, id)
        } else {
            vec![]
        };
        if params.is_empty() {
            if !args.is_empty() {
                self.error(target, format!("{w}: {name} takes no type arguments"));
            }
            return;
        }
        if args.len() > params.len() {
            self.error(
                target,
                format!(
                    "{w}: {name} takes {} type arguments, not {}",
                    params.len(),
                    args.len()
                ),
            );
        }
        for (i, tp) in params.iter().enumerate() {
            match args.get(i) {
                None => {
                    if tp.type_param().and_then(|x| x.default.as_ref()).is_none() {
                        self.error(
                            target,
                            format!("{w}: {name} needs a type argument for {}", tp.name),
                        );
                    }
                }
                Some(arg) => {
                    for e in self.type_arg_errors(arg, tp) {
                        self.error(target, format!("{w}: {} of {name}: {e}", tp.name));
                    }
                }
            }
        }
    }

    /// Why a type argument does not fit a type parameter.
    fn type_arg_errors(&self, arg: &'a TypeRef, tp: &TypeDef) -> Vec<String> {
        let Some(own) = tp.type_param() else { return vec![] };
        let r = self.res(arg);
        // A type parameter given on: it fits when it is at least as constrained.
        let param = r.and_then(|r| r.def()).and_then(|d| d.type_param());
        let mut errors = Vec::new();
        if let Some(constraint) = own.constraint {
            let name = r.and_then(|r| r.primitive());
            let integral = name.is_some_and(|n| n.int().is_some());
            let fits = match param {
                Some(param) => {
                    param.constraint == Some(TypeConstraint::Integral) || param.constraint == Some(constraint)
                }
                None => {
                    if constraint == TypeConstraint::Integral {
                        integral
                    } else {
                        integral || matches!(name, Some(Primitive::Float32 | Primitive::Float64))
                    }
                }
            };
            if !fits {
                errors.push(
                    if constraint == TypeConstraint::Integral {
                        "an integer type"
                    } else {
                        "a number type"
                    }
                    .to_string(),
                );
            }
        }
        if let Some(derives_from) = &own.derives_from {
            let id = arg.ref_id();
            let fits = param.is_some_and(|param| param.derives_from.as_ref() == Some(derives_from))
                || id.is_some_and(|id| {
                    id == derives_from
                        || ancestor_modules(self.p, id)
                            .iter()
                            .any(|b| b.id() == derives_from)
                });
            if !fits {
                errors.push(format!(
                    "a module deriving from {}",
                    module_path(self.p, derives_from)
                ));
            }
        }
        errors.into_iter().map(|e| format!("expects {e}")).collect()
    }

    fn check_type_ref(&mut self, t: &'a TypeRef, target: &ProblemTarget, w: &str) {
        let nodes = type_nodes(t);
        for n in nodes {
            if let TypeRefOf::Ref { target: r, args } = n {
                if self.exists(&r.id) {
                    let name = self
                        .types
                        .get(r.id.as_str())
                        .map_or_else(|| self.module_name(&r.id), |d| d.name.clone());
                    self.check_type_args(&r.id, args.as_deref().unwrap_or(&[]), target, w, &name);
                } else {
                    self.error(
                        target,
                        format!(
                            "{w}: {}",
                            missing_text(&r.id, "type", "type or module", "references")
                        ),
                    );
                }
                if let Some(d) = self.types.get(r.id.as_str()).filter(|d| d.kind() == "exception") {
                    let name = d.name.clone();
                    self.error(target, format!("{w}: exception '{name}' can only be raised"));
                }
            }
            if let TypeRefOf::Primitive { name, max: Some(_) } = n {
                if !name.bounded() {
                    self.error(target, format!("{w}: {name} cannot be bounded"));
                }
            }
            let key_of = match n {
                TypeRefOf::Map { key, .. } => Some(&**key),
                TypeRefOf::Set { of, .. } => Some(&**of),
                _ => None,
            };
            let Some(key_of) = key_of else { continue };
            let Some(k) = self.res(key_of) else { continue };
            let ok = match k {
                R::Ref(TypeRefOf::Primitive { .. } | TypeRefOf::Ref { .. }) => true,
                R::Def(d) => matches!(
                    d.body,
                    TypeBody::Enum { .. } | TypeBody::Bitmask { .. } | TypeBody::Primitive { .. }
                ),
                _ => false,
            };
            if !ok {
                self.error(
                    target,
                    format!(
                        "{w}: {} key must be a primitive, an enum, a bitmask or a module",
                        n.kind()
                    ),
                );
            } else if matches!(k.primitive(), Some(Primitive::Float32 | Primitive::Float64)) {
                self.warn(target, format!("{w}: floating-point {} key", n.kind()));
            }
        }
    }

    /// Modules some field or attribute holds as `shared`: those a `weak` one may reference.
    fn shared(&self) -> &HashSet<Id> {
        self.shared_modules.get_or_init(|| {
            let fields = self
                .p
                .modules
                .iter()
                .flat_map(|m| m.attributes.iter().map(|a| &a.field))
                .chain(self.p.types.iter().flat_map(|t| match &t.body {
                    TypeBody::Struct { fields, .. } | TypeBody::Exception { fields } => fields.iter(),
                    _ => [].iter(),
                }));
            fields
                .filter(|f| f.ownership == Some(Ownership::Shared))
                .flat_map(|f| module_refs(&f.ty, &|id| is_module_ref(self.p, id)))
                .collect()
        })
    }

    /// Default value, constraints and ownership of a field, attribute or parameter (`w`).
    fn check_default(
        &mut self,
        ty: &'a TypeRef,
        default: Option<&Value>,
        constraints: Option<&Constraints>,
        ownership: Option<Ownership>,
        target: &ProblemTarget,
        w: &str,
    ) {
        if let Some(c) = constraints {
            for e in constraint_errors(c, ty, &self.p.types) {
                self.error(target, format!("{w}: {e}"));
            }
        }
        if let Some(o) = ownership {
            let refs = module_refs(ty, &|id| is_module_ref(self.p, id));
            if refs.is_empty() {
                self.error(
                    target,
                    format!("{w}: ownership applies to types referencing modules"),
                );
            } else if o == Ownership::Weak {
                for id in refs {
                    if !self.shared().contains(&id) {
                        let name = self.module_name(&id);
                        self.warn(target, format!("{w}: weak, but nothing holds {name} as shared"));
                    }
                }
            }
        }
        let Some(default) = default else { return };
        let errors = value_errors(default, ty, &self.p.types, &|id| is_module_ref(self.p, id));
        for e in &errors {
            self.error(target, format!("{w} default: {e}"));
        }
        if let (Some(c), true) = (constraints, errors.is_empty()) {
            for e in constraint_value_errors(default, c) {
                self.error(target, format!("{w} default: {e}"));
            }
        }
    }

    fn check_field_default(&mut self, f: &'a ValueField, target: &ProblemTarget, w: &str) {
        self.check_default(
            &f.ty,
            f.default.as_ref(),
            f.constraints.as_ref(),
            f.ownership,
            target,
            w,
        )
    }

    /// Operations derived from members (`what`).
    fn check_derives(
        &mut self,
        derives: &[Derive],
        members: &[&'a ValueField],
        target: &ProblemTarget,
        what: &str,
    ) {
        for n in duplicates(derives.iter().map(|d| d.as_str())) {
            self.error(target, format!("{what}: derives {n} more than once"));
        }
        for d in [Derive::Ordering, Derive::Hash] {
            if derives.contains(&d) && !derives.contains(&Derive::Equality) {
                self.error(target, format!("{what}: derives {d}, which needs equality"));
            }
        }
        for f in members {
            for d in derives {
                if let Some(why) = self.derive_error(f, *d) {
                    self.error(target, format!("{what}.{}: {why}, no {d}", f.name));
                }
            }
        }
    }

    /// Why a member does not support a derived operation; None when it does.
    fn derive_error(&self, f: &'a ValueField, d: Derive) -> Option<String> {
        if d == Derive::String {
            return None;
        }
        if f.ownership == Some(Ownership::Weak) {
            return Some("a weak reference".into());
        }
        for n in type_nodes(&f.ty) {
            if matches!(n, TypeRefOf::Map { .. }) && d != Derive::Equality {
                return Some("a map".into());
            }
            if !matches!(n, TypeRefOf::Ref { .. }) {
                continue;
            }
            match self.res(n).and_then(|r| r.def()) {
                Some(TypeDef {
                    name,
                    body: TypeBody::Struct { derives, .. },
                    ..
                }) if !derives.as_ref().is_some_and(|x| x.contains(&d)) => {
                    return Some(format!("struct '{name}' does not derive {d}"));
                }
                Some(TypeDef {
                    name,
                    body: TypeBody::Union { .. },
                    ..
                }) if d != Derive::Equality => {
                    return Some(format!("union '{name}'"));
                }
                _ => {}
            }
        }
        None
    }

    /// Names any contract may use.
    fn contract_globals(&self) -> &HashSet<String> {
        self.contract_globals.get_or_init(|| {
            let p = self.p;
            p.types
                .iter()
                .map(|t| t.name.clone())
                .chain(p.types.iter().flat_map(|t| match &t.body {
                    TypeBody::Enum { values, .. } => values.iter().map(|v| v.name.clone()).collect(),
                    TypeBody::Bitmask { flags, .. } => flags.iter().map(|v| v.name.clone()).collect(),
                    _ => vec![],
                }))
                .chain(p.consts.iter().map(|c| c.name.clone()))
                .chain(
                    p.modules
                        .iter()
                        .filter(|x| x.parent_id.is_none())
                        .map(|x| x.name.clone()),
                )
                .chain(p.dependencies.iter().map(|d| d.name.clone()))
                .collect()
        })
    }

    /// Names the conditions of a module may use: its members, those of its bases, the project's.
    fn contract_members(&self, m: &Module, ancestors: &[BaseModule]) -> HashSet<String> {
        let mut out = self.contract_globals().clone();
        out.extend(m.attributes.iter().map(|a| a.field.name.clone()));
        out.extend(m.methods.iter().map(|x| x.name.clone()));
        out.extend(m.locks.iter().flatten().map(|l| l.name.clone()));
        out.extend(module_types(self.p, &m.id).iter().map(|t| t.name.clone()));
        for b in ancestors {
            if let BaseModule::Local(x) = b {
                out.extend(x.attributes.iter().map(|a| a.field.name.clone()));
            } else if let BaseModule::Imported(x) = b {
                out.extend(x.attributes.iter().flatten().map(|a| a.field.name.clone()));
            }
            out.extend(b.methods().iter().map(|x| x.name.clone()));
        }
        out
    }

    fn check_condition(
        &mut self,
        expression: &str,
        known: &HashSet<String>,
        target: &ProblemTarget,
        w: &str,
    ) {
        if expression.trim().is_empty() {
            self.warn(target, format!("{w}: empty condition"));
        }
        for n in unknown_names(expression, known) {
            self.warn(target, format!("{w}: '{n}' names nothing here"));
        }
    }

    fn check_contracts(&mut self, m: &Module, target: &ProblemTarget, path: &str, ancestors: &[BaseModule]) {
        let members = self.contract_members(m, ancestors);
        for e in m.invariants.iter().flatten() {
            self.check_condition(e, &members, target, &format!("{path} invariant"));
        }
        for x in &m.methods {
            if x.pre.as_ref().is_none_or(Vec::is_empty) && x.post.as_ref().is_none_or(Vec::is_empty) {
                continue;
            }
            let mut params = members.clone();
            params.extend(x.params.iter().map(|p| p.param.name.clone()));
            for e in x.pre.iter().flatten() {
                self.check_condition(e, &params, target, &format!("{path}.{} precondition", x.name));
            }
            let mut after = params.clone();
            if x.returns.is_some() {
                after.insert("result".into());
            }
            for e in x.post.iter().flatten() {
                self.check_condition(e, &after, target, &format!("{path}.{} postcondition", x.name));
            }
        }
    }

    fn check_state_machine(
        &mut self,
        m: &Module,
        target: &ProblemTarget,
        path: &str,
        ancestors: &[BaseModule],
    ) {
        let Some(sm) = &m.state_machine else { return };
        let w = format!("{path} state machine");
        let states: HashMap<&str, &State> = sm.states.iter().map(|x| (x.id.as_str(), x)).collect();
        let state_name = |id: &str| states.get(id).map_or("?".to_string(), |s| s.name.clone());
        if sm.states.is_empty() {
            self.warn(target, format!("{w}: no states"));
        }
        for n in duplicates(sm.states.iter().map(|x| &x.name)) {
            self.error(target, format!("{w}: duplicate state '{n}'"));
        }
        for x in &sm.states {
            if !is_identifier(&x.name) {
                self.error(target, format!("{w}: state '{}' is not an identifier", x.name));
            }
        }
        match &sm.initial {
            None => {
                if !sm.states.is_empty() {
                    self.error(target, format!("{w}: no initial state"));
                }
            }
            Some(i) if !states.contains_key(i.as_str()) => {
                self.error(target, format!("{w}: unknown initial state"))
            }
            _ => {}
        }
        let method = |me: &mut Self, id: &Option<Id>, what: &str| {
            let Some(id) = id else { return };
            match m.methods.iter().find(|y| &y.id == id) {
                None => me.error(
                    target,
                    format!("{w}: {what} {}", missing_text(id, "method", "method", "names")),
                ),
                Some(x) => {
                    if m.methods.iter().any(|y| y.id != x.id && y.name == x.name) {
                        me.error(
                            target,
                            format!("{w}: {what} names overloaded method '{}'", x.name),
                        );
                    }
                }
            }
        };
        for x in &sm.states {
            method(self, &x.entry, &format!("entry of {}", x.name));
            method(self, &x.exit, &format!("exit of {}", x.name));
        }
        let members = self.contract_members(m, ancestors);
        let mut taken: IndexMap<String, Vec<&Transition>> = IndexMap::new();
        for t in &sm.transitions {
            let name = format!("{} -> {}", state_name(&t.from), state_name(&t.to));
            if !states.contains_key(t.from.as_str()) || !states.contains_key(t.to.as_str()) {
                self.error(target, format!("{w}: transition {name} joins an unknown state"));
            } else if states[t.from.as_str()].r#final {
                self.error(
                    target,
                    format!(
                        "{w}: transition {name} leaves final state {}",
                        state_name(&t.from)
                    ),
                );
            }
            method(self, &t.trigger, &format!("trigger of {name}"));
            method(self, &t.action, &format!("action of {name}"));
            if let Some(guard) = &t.guard {
                let trigger = m.methods.iter().find(|y| Some(&y.id) == t.trigger.as_ref());
                let mut known = members.clone();
                known.extend(
                    trigger
                        .iter()
                        .flat_map(|x| x.params.iter().map(|p| p.param.name.clone())),
                );
                self.check_condition(guard, &known, target, &format!("{w}: guard of {name}"));
            }
            taken
                .entry(format!("{}:{}", t.from, t.trigger.as_deref().unwrap_or("")))
                .or_default()
                .push(t);
        }
        for list in taken.values() {
            if list.len() < 2
                || list
                    .iter()
                    .all(|t| t.guard.as_ref().is_some_and(|g| !g.trim().is_empty()))
            {
                continue;
            }
            let t = list[0];
            let trigger = m
                .methods
                .iter()
                .find(|y| Some(&y.id) == t.trigger.as_ref())
                .map(|x| x.name.clone());
            self.error(
                target,
                format!(
                    "{w}: {} has {} transitions {}, not all guarded",
                    state_name(&t.from),
                    list.len(),
                    trigger.map_or("without trigger".to_string(), |n| format!("on {n}"))
                ),
            );
        }
        if let Some(initial) = sm.initial.as_ref().filter(|i| states.contains_key(i.as_str())) {
            let mut reached = HashSet::from([initial.clone()]);
            let mut todo = vec![initial.clone()];
            while let Some(from) = todo.pop() {
                for t in &sm.transitions {
                    if t.from == from && reached.insert(t.to.clone()) {
                        todo.push(t.to.clone());
                    }
                }
            }
            for x in &sm.states {
                if !reached.contains(&x.id) {
                    self.warn(target, format!("{w}: state {} is never reached", x.name));
                }
            }
        }
    }

    /// What an attribute's value is, for atomic ones: a scalar type, not a container.
    fn constrained_scalar_of(&self, t: &'a TypeRef) -> &'static str {
        match resolve_type(t, &self.types, &|id| is_module_ref(self.p, id)) {
            None => "other",
            Some(Resolved::Def(d)) => match d.body {
                TypeBody::Enum { .. } => "enum",
                TypeBody::Bitmask { .. } => "bitmask",
                _ => "other",
            },
            Some(Resolved::Ref(TypeRefOf::Primitive { name, .. })) => match name {
                Primitive::String => "string",
                Primitive::Bytes => "bytes",
                _ => "scalar",
            },
            Some(Resolved::Ref(_)) => "other",
        }
    }

    fn check_attribute(&mut self, m: &Module, a: &'a Attribute, target: &ProblemTarget, w: &str) {
        let q = a.qualifiers;
        let (st, cn) = (q.has(Qualifier::Static), q.has(Qualifier::Const));
        if q.has(Qualifier::Mutable) && (st || cn) {
            self.error(
                target,
                format!(
                    "{w}: a mutable attribute is not {}",
                    if st { "static" } else { "const" }
                ),
            );
        }
        if a.accessors == Some(Accessors::Read) && cn {
            self.warn(
                target,
                format!("{w}: const has no setter already (accessors: read)"),
            );
        }
        if let (Some(acc), Some(StoredAccess::Private)) = (a.accessors, a.access) {
            self.warn(
                target,
                format!("{w}: private has no accessors already (accessors: {acc})"),
            );
        }
        if q.has(Qualifier::Atomic) {
            if a.guarded_by.is_some() {
                self.error(target, format!("{w}: atomic, it needs no lock"));
            }
            let scalar = self.constrained_scalar_of(&a.field.ty);
            if matches!(scalar, "other" | "string" | "bytes") {
                self.error(
                    target,
                    format!("{w}: atomic applies to booleans, characters, numbers, enums and bitmasks"),
                );
            }
            if cn {
                self.warn(target, format!("{w}: const, atomic changes nothing"));
            }
        }
        if let Some(g) = &a.guarded_by {
            if !m.locks.iter().flatten().any(|l| &l.id == g) {
                self.error(target, format!("{w}: guarded by a deleted lock"));
            }
        }
    }

    fn check_params(&mut self, params: &'a [MethodParam], target: &ProblemTarget, w: &str) {
        let mut defaulted: Option<String> = None;
        for prm in params {
            let at = format!("{w}({})", prm.param.name);
            let dir = prm.param.direction;
            if prm.qualifiers.has(Qualifier::Const) && dir != ParamDirection::In {
                self.error(target, format!("{at}: an {dir} parameter cannot be const"));
            }
            if let Some(d) = &prm.default {
                if dir != ParamDirection::In {
                    self.error(target, format!("{at}: an {dir} parameter cannot have a default"));
                } else {
                    self.check_default(&prm.param.ty, Some(d), None, None, target, &at);
                }
                defaulted.get_or_insert_with(|| prm.param.name.clone());
            } else if let Some(d) = &defaulted {
                self.error(
                    target,
                    format!("{at}: needs a default or to move before {d}, which has one"),
                );
            }
        }
    }

    fn check_message(
        &mut self,
        params: &[(&'a str, &'a TypeRef)],
        returns: Option<&'a TypeRef>,
        raises: Option<&'a Vec<Id>>,
        target: &ProblemTarget,
        w: &str,
    ) {
        for n in duplicates(params.iter().map(|p| p.0)) {
            self.error(target, format!("{w}: duplicate parameter '{n}'"));
        }
        for (name, ty) in params {
            self.check_type_ref(ty, target, &format!("{w}({name})"));
        }
        if let Some(r) = returns {
            self.check_type_ref(r, target, &format!("{w} returns"));
        }
        for id in raises.into_iter().flatten() {
            match self.types.get(id.as_str()) {
                None => self.error(
                    target,
                    format!("{w} {}", missing_text(id, "exception", "type", "raises")),
                ),
                Some(e) if e.kind() != "exception" => {
                    let n = e.name.clone();
                    self.error(target, format!("{w} raises '{n}', which is not an exception"))
                }
                _ => {}
            }
        }
        for id in duplicates(raises.into_iter().flatten()) {
            let n = self.types.get(id.as_str()).map_or(id.clone(), |t| t.name.clone());
            self.error(target, format!("{w} raises '{n}' more than once"));
        }
    }

    fn check_lifecycle(
        &mut self,
        m: &'a Module,
        target: &ProblemTarget,
        path: &str,
        ancestors: &[BaseModule],
    ) {
        let ctors = m.constructors.as_deref().unwrap_or(&[]);
        let ctor_where = |c: &Constructor| {
            format!(
                "{path}({})",
                c.params
                    .iter()
                    .map(|p| p.param.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let attributes: HashMap<&str, &Attribute> =
            m.attributes.iter().map(|a| (a.field.name.as_str(), a)).collect();
        let mut keys = HashSet::new();
        for c in ctors {
            let w = ctor_where(c);
            let key = overload_key(&c.params, false);
            if !keys.insert(key) {
                self.error(target, format!("{w}: same parameters as another constructor"));
            }
            let params: Vec<(&str, &TypeRef)> = c
                .params
                .iter()
                .map(|p| (p.param.name.as_str(), &p.param.ty))
                .collect();
            self.check_message(&params, None, None, target, &w);
            self.check_params(&c.params, target, path);
            if c.defaulted && c.deleted {
                self.error(target, format!("{w}: cannot be both defaulted and deleted"));
            } else if c.defaulted && !c.params.is_empty() {
                self.error(target, format!("{w}: a defaulted constructor has no parameters"));
            }
            if c.explicit && c.params.is_empty() {
                self.warn(target, format!("{w}: explicit has no effect without parameters"));
            }
            for prm in &c.params {
                let Some(a) = attributes.get(prm.param.name.as_str()) else {
                    continue;
                };
                let n = &prm.param.name;
                if a.qualifiers.has(Qualifier::Static) {
                    self.error(
                        target,
                        format!("{w}: {n} is a static attribute, constructors do not set it"),
                    );
                } else if type_key(&a.field.ty) != type_key(&prm.param.ty) {
                    self.error(
                        target,
                        format!("{w}: {n} is not of the type of the attribute it sets"),
                    );
                } else if prm.param.direction != ParamDirection::In {
                    self.error(target, format!("{w}: {n} sets the attribute: an in parameter"));
                }
            }
        }
        for n in duplicates(m.locks.iter().flatten().map(|l| &l.name)) {
            self.error(target, format!("{path}: duplicate lock '{n}'"));
        }
        let members: HashSet<&str> = m
            .attributes
            .iter()
            .map(|a| a.field.name.as_str())
            .chain(m.methods.iter().map(|x| x.name.as_str()))
            .collect();
        for l in m.locks.iter().flatten() {
            if members.contains(l.name.as_str()) {
                self.error(
                    target,
                    format!("{path}: lock '{}' has the name of a member", l.name),
                );
            }
        }
        for a in &m.attributes {
            if a.field.ownership == Some(Ownership::Owned) && m.copy == Some(SpecialMember::Default) {
                self.error(
                    target,
                    format!(
                        "{path}.{}: owned modules are not copied (copy: default)",
                        a.field.name
                    ),
                );
            }
        }
        if m.kind == Some(ModuleKind::Interface) && !ctors.is_empty() {
            self.error(target, format!("{path}: an interface module has no constructors"));
        }
        // Const attributes get their value from their default, else from every constructor.
        let live: Vec<&Constructor> = ctors.iter().filter(|c| !c.deleted).collect();
        for a in &m.attributes {
            let q = a.qualifiers;
            if q.has(Qualifier::Const) && !q.has(Qualifier::Static) && a.field.default.is_none() {
                if ctors.is_empty() {
                    self.warn(
                        target,
                        format!(
                            "{path}.{}: const, without a default value nor constructors setting it",
                            a.field.name
                        ),
                    );
                }
                for c in &live {
                    if !c.params.iter().any(|p| p.param.name == a.field.name) {
                        self.error(
                            target,
                            format!("{}: leaves const attribute {} unset", ctor_where(c), a.field.name),
                        );
                    }
                }
            }
        }
        let virtuals = m.methods.iter().any(|x| x.qualifiers.has(Qualifier::Virtual))
            || ancestors
                .iter()
                .any(|b| b.methods().iter().any(|x| x.qualifiers.has(Qualifier::Virtual)));
        if let Some(d) = &m.destructor {
            if d.r#virtual == Some(false) && virtuals && d.access.is_none() {
                self.warn(
                    target,
                    format!("{path}: virtual methods, but a public destructor that is not virtual"),
                );
            }
        }
        let public_ctors: Vec<&Constructor> = ctors
            .iter()
            .filter(|c| !c.deleted && c.access.is_none())
            .collect();
        match m.instantiation {
            Some(Instantiation::Singleton) => {
                for c in public_ctors {
                    self.error(
                        target,
                        format!("{}: constructors of a singleton are not public", ctor_where(c)),
                    );
                }
                if m.copy.is_some_and(|c| c != SpecialMember::Delete) {
                    self.error(
                        target,
                        format!("{path}: a singleton is not copied (copy: delete)"),
                    );
                }
                if m.r#move.is_some_and(|c| c != SpecialMember::Delete) {
                    self.error(target, format!("{path}: a singleton is not moved (move: delete)"));
                }
            }
            Some(Instantiation::Utility) => {
                if !live.is_empty() {
                    self.error(
                        target,
                        format!("{path}: a utility module is not instantiated (no constructors)"),
                    );
                }
                for a in &m.attributes {
                    if !a.qualifiers.has(Qualifier::Static) {
                        self.error(
                            target,
                            format!("{path}.{}: members of a utility module are static", a.field.name),
                        );
                    }
                }
                for x in &m.methods {
                    if !x.qualifiers.has(Qualifier::Static) {
                        self.error(
                            target,
                            format!("{path}.{}: members of a utility module are static", x.name),
                        );
                    }
                }
                if !m.ports.is_empty() {
                    self.error(target, format!("{path}: a utility module has no ports"));
                }
            }
            Some(Instantiation::Value) => {
                if let Some(k) = m.kind {
                    self.error(target, format!("{path}: a value module is a class (not {k})"));
                }
                for x in &m.methods {
                    if x.qualifiers.has(Qualifier::Virtual) {
                        self.error(
                            target,
                            format!("{path}.{}: a value module has no virtual methods", x.name),
                        );
                    }
                }
                if m.copy == Some(SpecialMember::Delete) {
                    self.error(
                        target,
                        format!("{path}: a value module is copied (not copy: delete)"),
                    );
                }
                if !m.ports.is_empty() {
                    self.warn(target, format!("{path}: a value module with ports"));
                }
            }
            None => {}
        }
        if m.active.is_some() {
            if let Some(k) = m.kind {
                self.error(target, format!("{path}: an active module is a class (not {k})"));
            }
            if m.instantiation == Some(Instantiation::Utility) {
                self.error(target, format!("{path}: a utility module is not active"));
            }
            if !m.ports.iter().any(|x| x.role == PortRole::In) {
                self.warn(
                    target,
                    format!("{path}: active, without in ports to run calls of"),
                );
            }
        }
    }

    fn check_generics(&mut self, m: &'a Module, target: &ProblemTarget, path: &str) {
        let mut defaulted: Option<String> = None;
        for tp in type_params_of(self.p, &m.id) {
            let own = tp.type_param().expect("type parameter");
            if let Some(d) = &own.default {
                self.check_type_ref(d, target, &format!("{path}<{}> default", tp.name));
                for e in self.type_arg_errors(d, tp) {
                    self.error(target, format!("{path}<{}> default: {e}", tp.name));
                }
                defaulted.get_or_insert_with(|| tp.name.clone());
            } else if let Some(d) = &defaulted {
                self.error(
                    target,
                    format!("{path}<{}>: needs a default, as {d} before it has one", tp.name),
                );
            }
            if let Some(from) = &own.derives_from {
                if !self.p.modules.iter().any(|x| &x.id == from) {
                    self.error(
                        target,
                        format!("{path}<{}>: derives from a deleted module", tp.name),
                    );
                }
            }
        }
        for b in m.bases.iter().flatten() {
            if self.p.modules.iter().any(|x| &x.id == b) {
                let args: &'a [TypeRef] = m
                    .base_args
                    .as_ref()
                    .and_then(|a| a.get(b))
                    .map_or(&[], |v| &v[..]);
                let bp = module_path(self.p, b);
                for a in args {
                    self.check_type_ref(a, target, &format!("{path} base {bp}"));
                }
                self.check_type_args(b, args, target, &format!("{path} base"), &bp);
            }
        }
    }
}

pub fn validate<'a>(p: &'a Project) -> Vec<Problem> {
    let from_library: HashSet<Id> = p
        .types
        .iter()
        .filter(|e| e.dependency.is_some())
        .map(|e| e.id.clone())
        .chain(
            p.interfaces
                .iter()
                .filter(|e| e.dependency.is_some())
                .map(|e| e.id.clone()),
        )
        .chain(
            p.consts
                .iter()
                .filter(|e| e.dependency.is_some())
                .map(|e| e.id.clone()),
        )
        .collect();
    let mut v = V {
        p,
        problems: vec![],
        from_library,
        types: types_by_id(&p.types),
        dependency_ids: p.dependencies.iter().map(|x| x.id.as_str()).collect(),
        shared_modules: OnceCell::new(),
        contract_globals: OnceCell::new(),
    };
    let interfaces: HashMap<&str, &Interface> = p.interfaces.iter().map(|i| (i.id.as_str(), i)).collect();
    let project = ProblemTarget::Project;

    if p.name.trim().is_empty() {
        v.warn(&project, "Project has no name".into());
    }
    for n in duplicates(global_type_names(p, None)) {
        v.error(&project, format!("Duplicate type/interface/constant name '{n}'"));
    }
    for c in &p.consts {
        let target = ProblemTarget::Const(c.id.clone());
        if is_reserved_type_name(&c.name) {
            v.error(&target, format!("'{}' is a reserved type name", c.name));
        }
        v.check_type_ref(&c.ty, &target, &c.name);
        for e in value_errors(&c.value, &c.ty, &p.types, &|id| is_module_ref(p, id)) {
            v.error(&target, format!("Constant '{}': {e}", c.name));
        }
    }

    for t in &p.types {
        let target = ProblemTarget::Type(t.id.clone());
        let n = &t.name;
        if is_reserved_type_name(n) {
            v.error(&target, format!("'{n}' is a reserved type name"));
        }
        match &t.body {
            TypeBody::Struct { fields, .. } | TypeBody::Exception { fields } => {
                let is_struct = t.kind() == "struct";
                if is_struct && fields.is_empty() {
                    v.warn(&target, format!("Struct '{n}' has no fields"));
                }
                if let TypeBody::Struct { derives: Some(d), .. } = &t.body {
                    let members: Vec<&ValueField> = fields.iter().collect();
                    v.check_derives(d, &members, &target, &format!("Struct '{n}'"));
                }
                for d in duplicates(fields.iter().map(|f| &f.name)) {
                    v.error(
                        &target,
                        format!(
                            "{} '{n}': duplicate field '{d}'",
                            if is_struct { "Struct" } else { "Exception" }
                        ),
                    );
                }
                for f in fields {
                    v.check_type_ref(&f.ty, &target, &format!("{n}.{}", f.name));
                    v.check_field_default(f, &target, &format!("{n}.{}", f.name));
                }
            }
            TypeBody::Enum { underlying, values } => {
                if values.is_empty() {
                    v.warn(&target, format!("Enum '{n}' has no values"));
                }
                for d in duplicates(values.iter().map(|x| &x.name)) {
                    v.error(&target, format!("Enum '{n}': duplicate value name '{d}'"));
                }
                for d in duplicates(values.iter().map(|x| x.value.to_string())) {
                    v.warn(&target, format!("Enum '{n}': value {d} used more than once"));
                }
                let (min, max) = underlying.range();
                for x in values {
                    if (x.value as i128) < min || (x.value as i128) > max {
                        v.error(
                            &target,
                            format!(
                                "Enum '{n}': {} = {} does not fit in {underlying}",
                                x.name, x.value
                            ),
                        );
                    }
                }
            }
            TypeBody::Bitmask { underlying, flags } => {
                if flags.is_empty() {
                    v.warn(&target, format!("Bitmask '{n}' has no flags"));
                }
                for d in duplicates(flags.iter().map(|x| &x.name)) {
                    v.error(&target, format!("Bitmask '{n}': duplicate flag '{d}'"));
                }
                for d in duplicates(flags.iter().map(|x| x.bit.to_string())) {
                    v.error(&target, format!("Bitmask '{n}': bit {d} used more than once"));
                }
                let width: u32 = underlying.as_str()[4..].parse().unwrap_or(64);
                for x in flags {
                    if x.bit >= width {
                        v.error(
                            &target,
                            format!(
                                "Bitmask '{n}': {} (bit {}) does not fit in {underlying}",
                                x.name, x.bit
                            ),
                        );
                    }
                }
            }
            TypeBody::Union { discriminator, cases } => {
                v.check_type_ref(discriminator, &target, &format!("{n} discriminator"));
                let d = v.res(discriminator);
                let valid = match d {
                    Some(R::Def(TypeDef {
                        body: TypeBody::Enum { .. },
                        ..
                    })) => true,
                    Some(r) => {
                        matches!(r.primitive(), Some(x) if x == Primitive::Bool || x == Primitive::Char || x.int().is_some())
                    }
                    None => false,
                };
                if d.is_some() && !valid {
                    v.error(
                        &target,
                        format!("Union '{n}': discriminator must be an integer, bool, char or enum"),
                    );
                }
                if cases.is_empty() {
                    v.warn(&target, format!("Union '{n}' has no cases"));
                }
                for c in duplicates(cases.iter().map(|c| &c.name)) {
                    v.error(&target, format!("Union '{n}': duplicate case '{c}'"));
                }
                if cases.iter().filter(|c| c.is_default).count() > 1 {
                    v.error(&target, format!("Union '{n}': more than one default case"));
                }
                for c in cases {
                    v.check_type_ref(&c.ty, &target, &format!("{n}.{}", c.name));
                    if c.labels.is_empty() && !c.is_default {
                        v.error(&target, format!("Union '{n}': case '{}' has no label", c.name));
                    }
                    if valid {
                        for l in &c.labels {
                            for e in value_errors(l, discriminator, &p.types, &no_module) {
                                v.error(&target, format!("Union '{n}': label of case '{}': {e}", c.name));
                            }
                        }
                    }
                }
                let labels: Vec<String> = cases
                    .iter()
                    .flat_map(|c| c.labels.iter().map(js_string))
                    .collect();
                for l in duplicates(&labels) {
                    v.error(&target, format!("Union '{n}': label {l} used by several cases"));
                }
                let all: Option<Vec<String>> = match d {
                    Some(R::Def(TypeDef {
                        body: TypeBody::Enum { values, .. },
                        ..
                    })) => Some(values.iter().map(|x| x.name.clone()).collect()),
                    Some(r) if r.primitive() == Some(Primitive::Bool) => {
                        Some(vec!["true".into(), "false".into()])
                    }
                    _ => None,
                };
                if cases.iter().any(|c| c.is_default)
                    && all.is_some_and(|a| a.iter().all(|x| labels.contains(x)))
                {
                    v.warn(
                        &target,
                        format!("Union '{n}': the default case is never held, every value has a case"),
                    );
                }
            }
            TypeBody::Alias { ty } => {
                v.check_type_ref(ty, &target, n);
                if let Some(id) = ty.ref_id() {
                    if v.types.contains_key(id) && v.resolve(ty, &mut HashSet::from([t.id.clone()])).is_none()
                    {
                        v.error(&target, format!("Alias '{n}' is cyclic"));
                    }
                }
            }
            TypeBody::Primitive { .. } => {}
        }
    }

    // Structs and unions containing themselves by value.
    fn by_value(
        t: &TypeRef,
        types: &HashMap<&str, &TypeDef>,
        out: &mut Vec<Id>,
        seen_alias: &mut HashSet<Id>,
    ) {
        match t {
            TypeRefOf::Array { of, .. } | TypeRefOf::Optional { of } => by_value(of, types, out, seen_alias),
            TypeRefOf::Ref { target, .. } => match types.get(target.id.as_str()) {
                Some(d) if matches!(d.body, TypeBody::Struct { .. } | TypeBody::Union { .. }) => {
                    if !out.contains(&d.id) {
                        out.push(d.id.clone())
                    }
                }
                Some(d) => {
                    if let TypeBody::Alias { ty } = &d.body {
                        if seen_alias.insert(d.id.clone()) {
                            by_value(ty, types, out, seen_alias)
                        }
                    }
                }
                None => {}
            },
            _ => {}
        }
    }
    let mut edges: IndexMap<Id, Vec<Id>> = IndexMap::new();
    for t in &p.types {
        let refs: Vec<&TypeRef> = match &t.body {
            TypeBody::Struct { fields, .. } => fields.iter().map(|f| &f.ty).collect(),
            TypeBody::Union { cases, .. } => cases.iter().map(|c| &c.ty).collect(),
            _ => continue,
        };
        let mut out = Vec::new();
        for r in refs {
            by_value(r, &v.types, &mut out, &mut HashSet::new());
        }
        edges.insert(t.id.clone(), out);
    }
    let mut state: HashMap<Id, bool> = HashMap::new(); // false: visiting, true: done
    let mut cyclic: indexmap::IndexSet<Id> = indexmap::IndexSet::new();
    fn visit(
        id: &Id,
        stack: &mut Vec<Id>,
        edges: &IndexMap<Id, Vec<Id>>,
        state: &mut HashMap<Id, bool>,
        cyclic: &mut indexmap::IndexSet<Id>,
    ) {
        match state.get(id) {
            Some(true) => return,
            Some(false) => {
                if let Some(i) = stack.iter().position(|s| s == id) {
                    cyclic.extend(stack[i..].iter().cloned());
                }
                return;
            }
            None => {}
        }
        state.insert(id.clone(), false);
        stack.push(id.clone());
        for next in edges.get(id).into_iter().flatten() {
            visit(next, stack, edges, state, cyclic);
        }
        stack.pop();
        state.insert(id.clone(), true);
    }
    for id in edges.keys() {
        visit(id, &mut vec![], &edges, &mut state, &mut cyclic);
    }
    for id in cyclic {
        let t = v.types[id.as_str()];
        let what = if t.kind() == "union" { "Union" } else { "Struct" };
        let name = t.name.clone();
        v.error(
            &ProblemTarget::Type(id.clone()),
            format!(
                "{what} '{name}' contains itself by value (use vector, list, map or set to break the cycle)"
            ),
        );
    }

    // Interfaces
    for i in &p.interfaces {
        let target = ProblemTarget::Interface(i.id.clone());
        if is_reserved_type_name(&i.name) {
            v.error(&target, format!("'{}' is a reserved type name", i.name));
        }
        if i.messages.is_empty() {
            v.warn(&target, format!("Interface '{}' has no messages", i.name));
        }
        for n in duplicates(i.messages.iter().map(|m| &m.name)) {
            v.error(
                &target,
                format!("Interface '{}': duplicate message '{n}'", i.name),
            );
        }
        for m in &i.messages {
            let params: Vec<(&str, &TypeRef)> = m.params.iter().map(|x| (x.name.as_str(), &x.ty)).collect();
            v.check_message(
                &params,
                m.returns.as_ref(),
                m.raises.as_ref(),
                &target,
                &format!("{}.{}", i.name, m.name),
            );
        }
    }

    // Modules
    let mut siblings: IndexMap<Option<&Id>, Vec<&str>> = IndexMap::new();
    for m in &p.modules {
        siblings.entry(m.parent_id.as_ref()).or_default().push(&m.name);
    }
    for (parent, names) in &siblings {
        let target = parent.map_or(ProblemTarget::Project, |id| ProblemTarget::Module(id.clone()));
        for n in duplicates(names) {
            v.error(&target, format!("Duplicate module name '{n}'"));
        }
    }
    let global_names: HashSet<&str> = global_type_names(p, None).into_iter().collect();
    for m in &p.modules {
        if m.parent_id.is_none() && global_names.contains(m.name.as_str()) {
            v.warn(
                &ProblemTarget::Module(m.id.clone()),
                format!("Module '{}' has the name of a type, interface or constant: '{}' in a type names that one", m.name, m.name),
            );
        }
    }
    for n in duplicates(p.binaries.iter().map(|b| &b.name)) {
        v.error(&project, format!("Duplicate binary name '{n}'"));
    }
    for b in &p.binaries {
        if !is_identifier(&b.name) {
            v.error(&project, format!("Binary '{}': not an identifier", b.name));
        }
    }
    let binary_names: HashMap<&str, &str> = p
        .binaries
        .iter()
        .map(|b| (b.id.as_str(), b.name.as_str()))
        .collect();
    let binaries = binaries_of(p);
    let paths = project_module_paths(p);

    for m in &p.modules {
        let target = ProblemTarget::Module(m.id.clone());
        let path = paths[&m.id].clone();
        if m.binary_id
            .as_ref()
            .is_some_and(|b| !binary_names.contains_key(b.as_str()))
        {
            v.error(&target, format!("{path}: runs in a deleted binary"));
        } else if !p.binaries.is_empty() && m.parent_id.is_none() && m.binary_id.is_none() {
            v.error(
                &target,
                format!("{path}: runs in no binary (the project has binaries)"),
            );
        }
        for n in duplicates(m.ports.iter().map(|x| &x.name)) {
            v.error(&target, format!("{path}: duplicate port '{n}'"));
        }
        let own_types = module_types(p, &m.id);
        for n in duplicates(own_types.iter().map(|t| &t.name)) {
            v.error(&target, format!("{path}: duplicate type '{n}'"));
        }
        let members: HashSet<String> = member_names(p, m).into_iter().collect();
        for t in &own_types {
            if members.contains(&t.name) {
                v.error(
                    &target,
                    format!("{path}: '{}' is both a type and a member or submodule", t.name),
                );
            }
        }
        for n in duplicates(m.attributes.iter().map(|a| &a.field.name)) {
            v.error(&target, format!("{path}: duplicate attribute '{n}'"));
        }
        for a in &m.attributes {
            let w = format!("{path}.{}", a.field.name);
            v.check_type_ref(&a.field.ty, &target, &w);
            v.check_field_default(&a.field, &target, &w);
            v.check_attribute(m, a, &target, &w);
        }
        for n in duplicates(m.methods.iter().map(overload_name)) {
            let name = &n[..n.find('(').unwrap_or(n.len())];
            v.error(&target, format!("{path}: duplicate method '{name}'"));
        }
        let attributes: HashSet<&str> = m.attributes.iter().map(|a| a.field.name.as_str()).collect();
        let ancestors = ancestor_modules(p, &m.id);
        for x in &m.methods {
            let w = format!("{path}.{}", x.name);
            let q = x.qualifiers;
            let has = |k| q.has(k);
            if has(Qualifier::Static) && has(Qualifier::Const) {
                v.error(&target, format!("{w}: a static method cannot be const"));
            }
            if has(Qualifier::Static) && has(Qualifier::Virtual) {
                v.error(&target, format!("{w}: a static method cannot be virtual"));
            }
            let virtual_only = if has(Qualifier::Pure) {
                Some("pure")
            } else if has(Qualifier::Override) {
                Some("override")
            } else if has(Qualifier::Final) {
                Some("final")
            } else {
                None
            };
            if let (Some(vo), false) = (virtual_only, has(Qualifier::Virtual)) {
                v.error(&target, format!("{w}: a {vo} method must be virtual"));
            }
            if has(Qualifier::Pure) && has(Qualifier::Final) {
                v.error(&target, format!("{w}: a pure method cannot be final"));
            }
            if has(Qualifier::Nodiscard) && x.returns.is_none() {
                v.warn(&target, format!("{w}: nodiscard but returns nothing"));
            }
            if has(Qualifier::Pure) && m.kind.is_none() {
                v.error(
                    &target,
                    format!("{w}: pure method in a concrete module (make it abstract or an interface)"),
                );
            }
            if m.kind == Some(ModuleKind::Interface) && !has(Qualifier::Pure) {
                v.error(
                    &target,
                    format!("{w}: methods of an interface module must be pure"),
                );
            }
            // The overload of the same parameters, else (for an override) the only one of the name.
            let virtuals = |a: &BaseModule<'a>| -> Vec<&'a Method> {
                a.methods()
                    .iter()
                    .filter(|y| y.name == x.name && y.qualifiers.has(Qualifier::Virtual))
                    .collect()
            };
            let key = method_overload_key(x);
            let inherited = ancestors
                .iter()
                .find_map(|a| {
                    virtuals(a)
                        .into_iter()
                        .find(|y| method_overload_key(y) == key)
                        .map(|y| (a, y))
                })
                .or_else(|| {
                    if has(Qualifier::Override) {
                        ancestors
                            .iter()
                            .find_map(|a| virtuals(a).first().map(|y| (a, *y)))
                    } else {
                        None
                    }
                });
            if let Some((base, im)) = inherited {
                let bp = module_path(p, base.id());
                if im.qualifiers.has(Qualifier::Final) {
                    v.error(&target, format!("{w}: overrides final {bp}.{}", x.name));
                } else if im.qualifiers.has(Qualifier::Noexcept) && !has(Qualifier::Noexcept) {
                    v.warn(
                        &target,
                        format!("{w}: not noexcept, as {bp}.{} it overrides is", x.name),
                    );
                }
            }
            if has(Qualifier::Override) {
                match inherited {
                    None => v.error(&target, format!("{w}: overrides no virtual method of a base")),
                    Some((base, im)) => {
                        let bp = module_path(p, base.id());
                        if method_signature(x) != method_signature(im) {
                            v.error(
                                &target,
                                format!("{w}: signature differs from {bp}.{} it overrides", x.name),
                            );
                        } else if x.access != im.access {
                            v.warn(
                                &target,
                                format!("{w}: access differs from {bp}.{} it overrides", x.name),
                            );
                        }
                    }
                }
            } else if let Some((base, im)) = inherited {
                if !im.qualifiers.has(Qualifier::Final) {
                    let bp = module_path(p, base.id());
                    v.warn(
                        &target,
                        format!("{w}: hides virtual {bp}.{} (mark it override)", x.name),
                    );
                }
            }
            if attributes.contains(x.name.as_str()) {
                v.error(
                    &target,
                    format!("{path}: '{}' is both an attribute and a method", x.name),
                );
            }
            let params: Vec<(&str, &TypeRef)> = x
                .params
                .iter()
                .map(|p| (p.param.name.as_str(), &p.param.ty))
                .collect();
            v.check_message(&params, x.returns.as_ref(), x.raises.as_ref(), &target, &w);
            v.check_params(&x.params, &target, &w);
        }
        v.check_lifecycle(m, &target, &path, &ancestors);
        for id in duplicates(m.implements.iter().flatten()) {
            let n = interfaces.get(id.as_str()).map_or(id.clone(), |i| i.name.clone());
            v.error(&target, format!("{path} implements {n} more than once"));
        }
        for id in m.implements.iter().flatten() {
            if !interfaces.contains_key(id.as_str()) {
                v.error(
                    &target,
                    format!(
                        "{path} implements {}",
                        missing_text(id, "interface", "interface", "references")
                    ),
                );
            }
        }
        if !matches!(m.kind, Some(ModuleKind::Abstract | ModuleKind::Interface)) {
            for (iface, message, method) in unimplemented_messages(p, m) {
                v.error(
                    &target,
                    if method.is_some() {
                        format!(
                            "{path}.{}: not as {}.{} it implements (public, same parameters, result and exceptions)",
                            message.name, iface.name, message.name
                        )
                    } else {
                        format!("{path} does not implement {}.{}", iface.name, message.name)
                    },
                );
            }
        }
        if let Some(d) = &m.derives {
            if let Some(k) = m.kind {
                v.error(&target, format!("{path}: an {k} module derives no operations"));
            }
            let members: Vec<&ValueField> = m
                .attributes
                .iter()
                .filter(|a| !a.qualifiers.has(Qualifier::Static))
                .map(|a| &a.field)
                .collect();
            v.check_derives(d, &members, &target, &path);
        }
        v.check_generics(m, &target, &path);
        v.check_contracts(m, &target, &path, &ancestors);
        v.check_state_machine(m, &target, &path, &ancestors);
        if m.kind == Some(ModuleKind::Interface) && !m.attributes.is_empty() {
            v.error(
                &target,
                format!("{path}: an interface module cannot have attributes"),
            );
        }
        let bases = m.bases.as_deref().unwrap_or(&[]);
        for b in bases {
            if base_module(p, b).is_none() {
                v.error(
                    &target,
                    format!(
                        "{path} derives from a deleted module{}",
                        if is_imported_id(b) { " of a dependency" } else { "" }
                    ),
                );
            }
        }
        if let (true, Some(k)) = (m.r#final, m.kind) {
            let what = if k == ModuleKind::Abstract {
                "an abstract"
            } else {
                "an interface"
            };
            v.error(&target, format!("{path}: {what} module cannot be final"));
        }
        for b in bases {
            if b != &m.id && base_module(p, b).is_some_and(|x| x.is_final()) {
                v.error(
                    &target,
                    format!("{path} derives from final module {}", module_path(p, b)),
                );
            }
        }
        if bases.contains(&m.id) {
            v.error(&target, format!("{path} derives from itself"));
        } else if bases
            .iter()
            .any(|b| ancestor_modules(p, b).iter().any(|a| a.id() == m.id))
        {
            v.error(&target, format!("{path} derives from itself through its bases"));
        }
        for id in duplicates(bases) {
            v.error(
                &target,
                format!("{path} derives from {} more than once", module_path(p, &id)),
            );
        }
        if m.kind.is_none() {
            for (base, method) in unimplemented_methods(p, &m.id) {
                v.error(
                    &target,
                    format!(
                        "{path} does not implement pure method {}.{} (implement it or make the module abstract)",
                        module_path(p, base.id()),
                        method.name
                    ),
                );
            }
        }
        for pt in &m.ports {
            match &pt.interface_id {
                None => v.warn(&target, format!("{path}:{} has no interface", pt.name)),
                Some(i) if !interfaces.contains_key(i.as_str()) => v.error(
                    &target,
                    format!(
                        "{path}:{} {}",
                        pt.name,
                        missing_text(i, "interface", "interface", "references")
                    ),
                ),
                _ => {}
            }
        }
    }

    // Dependencies
    for n in duplicates(p.dependencies.iter().map(|x| &x.name)) {
        v.error(&project, format!("Duplicate dependency name '{n}'"));
    }
    for n in duplicates(p.dependencies.iter().map(|x| normalize_file(&x.file))) {
        v.error(&project, format!("Dependency file '{n}' listed more than once"));
    }
    let dependency_by_name: HashMap<&str, &Dependency> =
        p.dependencies.iter().map(|x| (x.name.as_str(), x)).collect();
    /// Dependencies whose entities those of `id` may use: itself and the ones it uses.
    fn reach(p: &Project, by_name: &HashMap<&str, &Dependency>, id: &str, seen: &mut HashSet<Id>) {
        if !seen.insert(id.to_string()) {
            return;
        }
        if let Some(dep) = p.dependencies.iter().find(|x| x.id == id) {
            for u in &dep.uses {
                if let Some(used) = by_name.get(u.as_str()) {
                    reach(p, by_name, &used.id, seen)
                }
            }
        }
    }
    let reach_of = |id: &str| {
        let mut s = HashSet::new();
        reach(p, &dependency_by_name, id, &mut s);
        s
    };
    for x in &p.dependencies {
        if x.file.trim().is_empty() {
            v.warn(&project, format!("Dependency '{}' has no file", x.name));
        }
        for u in &x.uses {
            if !dependency_by_name.contains_key(u.as_str()) {
                v.error(
                    &project,
                    format!("Dependency '{}' uses unknown dependency '{u}'", x.name),
                );
            }
        }
        if x.uses.iter().any(|u| {
            dependency_by_name
                .get(u.as_str())
                .is_some_and(|used| reach_of(&used.id).contains(&x.id))
        }) {
            v.error(
                &project,
                format!("Dependency '{}' uses itself through other dependencies", x.name),
            );
        }
    }
    // Types of modules: public ones anywhere, the others in modules only, as their access allows.
    let qualified = type_names(p);
    let rank = |a: Access| match a {
        Access::Public => 0,
        Access::Protected => 1,
        Access::Private => 2,
    };
    let refs = all_type_refs(p);
    for u in &refs {
        if v.from_library.contains(&u.owner.id) {
            continue;
        }
        let context = ref_context(p, &u.owner);
        let mut used_list: Vec<&TypeDef> = Vec::new();
        walk_type_ref(&u.ty, &mut |n| {
            if let TypeRefOf::Ref { target, .. } = n {
                if let Some(t) = v.types.get(target.id.as_str()) {
                    if t.is_module_type() {
                        used_list.push(t)
                    }
                }
            }
        });
        for used in used_list {
            let name = &qualified[&used.id];
            let target = ProblemTarget::of_owner(&u.owner);
            let of = match &used.module {
                Some(m) => module_path(p, m),
                None => used.module_path.clone().unwrap_or_default(),
            };
            let used_access = used.access.map_or(Access::Public, StoredAccess::access);
            if context.is_none() && !can_use_type(p, None, used) {
                v.error(
                    &target,
                    format!(
                        "{}: '{name}' is a {used_access} type of module {of}, used by modules only",
                        u.r#where
                    ),
                );
            } else if !can_use_type(p, context.as_deref(), used) {
                v.error(
                    &target,
                    format!("{}: '{name}' is {used_access} in {of}", u.r#where),
                );
            } else if let Some(access) = u.access {
                // Type parameters stand for their arguments: any member uses them.
                if rank(used_access) > rank(access) && used.type_param().is_none() {
                    v.warn(
                        &target,
                        format!("{}: {access} member uses {used_access} type '{name}'", u.r#where),
                    );
                }
            }
        }
    }

    let owners: HashMap<&str, Option<&Id>> = p
        .types
        .iter()
        .map(|e| (e.id.as_str(), e.dependency.as_ref()))
        .chain(
            p.interfaces
                .iter()
                .map(|e| (e.id.as_str(), e.dependency.as_ref())),
        )
        .chain(p.consts.iter().map(|e| (e.id.as_str(), e.dependency.as_ref())))
        .collect();
    let ref_name = ref_namer(p);
    for u in &refs {
        let dependency = if u.owner.kind == UsageKind::Module {
            None
        } else {
            owners.get(u.owner.id.as_str()).copied().flatten()
        };
        let Some(dependency) = dependency else { continue };
        let allowed = reach_of(dependency);
        // Entities held by another dependency count as those of the ones sharing them.
        let shared: HashSet<&str> = p
            .dependencies
            .iter()
            .filter(|x| allowed.contains(&x.id))
            .flat_map(|x| x.shared.iter().map(String::as_str))
            .collect();
        let target = ProblemTarget::of_owner(&u.owner);
        let mut messages = Vec::new();
        walk_type_ref(&u.ty, &mut |n| {
            let TypeRefOf::Ref { target: r, .. } = n else {
                return;
            };
            if is_module_ref(p, &r.id) {
                if !parse_dependency_module_ref(&r.id).is_some_and(|(d, _)| allowed.contains(d)) {
                    messages.push(format!(
                        "{}: module '{}' is not in its dependency or the dependencies it uses",
                        u.r#where,
                        ref_name(&r.id).unwrap_or_else(|| "?".into())
                    ));
                }
                return;
            }
            if let Some(used) = v.types.get(r.id.as_str()) {
                if !used.dependency.as_ref().is_some_and(|d| allowed.contains(d))
                    && !shared.contains(used.name.as_str())
                {
                    messages.push(format!(
                        "{}: '{}' is not in its dependency or the dependencies it uses",
                        u.r#where, used.name
                    ));
                }
            }
        });
        for m in messages {
            v.error(&target, m);
        }
    }

    // Links
    for n in duplicates(p.links.iter().map(|l| &l.name)) {
        v.error(&project, format!("Duplicate link name '{n}'"));
    }
    let mut endpoints = HashSet::new();
    let mut servers: HashMap<String, String> = HashMap::new();
    let mut segments: HashMap<String, String> = HashMap::new();
    let shm_name = regex::Regex::new(r"^/?[^/]+$").expect("regex");
    for l in &p.links {
        let target = ProblemTarget::Link(l.id.clone());
        let n = &l.name;
        let (Some(from), Some(to)) = (
            find_port(p, &l.from.module_id, &l.from.port_id),
            find_port(p, &l.to.module_id, &l.to.port_id),
        ) else {
            v.error(&target, format!("Link '{n}' has a missing endpoint"));
            continue;
        };
        if !endpoints.insert(format!("{}->{}", l.from.port_id, l.to.port_id)) {
            v.warn(&target, format!("Link '{n}' duplicates another link"));
        }
        let (from_role, to_role) = link_roles(p, &l.from.module_id, &l.to.module_id);
        if from.role != from_role {
            v.error(
                &target,
                format!(
                    "Link '{n}': source port '{}' must be an '{from_role}' port",
                    from.name
                ),
            );
        }
        if to.role != to_role {
            v.error(
                &target,
                format!(
                    "Link '{n}': target port '{}' must be an '{to_role}' port",
                    to.name
                ),
            );
        }
        // Imported ports use this project's interface of the same name.
        let foreign: Vec<String> = [&l.from, &l.to]
            .iter()
            .filter_map(|e| {
                let name = find_imported(p, &e.module_id)?
                    .1
                    .ports
                    .iter()
                    .find(|pt| pt.id == e.port_id)?
                    .interface
                    .clone()?;
                (!p.interfaces.iter().any(|i| i.name == name)).then(|| {
                    format!(
                        "{}:{} uses interface '{name}', not defined in this project",
                        module_path(p, &e.module_id),
                        find_port(p, &e.module_id, &e.port_id).map_or("undefined".into(), |x| x.name)
                    )
                })
            })
            .collect();
        for f in &foreign {
            v.error(&target, format!("Link '{n}': {f}"));
        }
        if foreign.is_empty() && from.interface_id != to.interface_id {
            v.error(&target, format!("Link '{n}': ports use different interfaces"));
        }
        if is_imported_id(&l.from.module_id) && is_imported_id(&l.to.module_id) {
            v.error(
                &target,
                format!("Link '{n}' joins two imported modules: one end must be in this project"),
            );
        }
        let c = &l.constraints;
        let iface = from.interface_id.as_deref().and_then(|i| interfaces.get(i));
        if let (Some(iface), Direction::Unidirectional) = (iface, c.direction) {
            for m in &iface.messages {
                if m.returns.is_some() {
                    v.error(
                        &target,
                        format!(
                            "Link '{n}' is unidirectional but {}.{} returns a value",
                            iface.name, m.name
                        ),
                    );
                } else if m.params.iter().any(|x| x.direction != ParamDirection::In) {
                    v.error(
                        &target,
                        format!(
                            "Link '{n}' is unidirectional but {}.{} has out parameters",
                            iface.name, m.name
                        ),
                    );
                }
            }
        }
        if c.direction == Direction::Unidirectional && c.ack.required {
            v.error(
                &target,
                format!("Link '{n}' is unidirectional but requires an ack"),
            );
        }
        if !c.ack.required && c.ack.timeout_ms.is_some() {
            v.warn(
                &target,
                format!("Link '{n}': ack timeout set but ack not required"),
            );
        }
        let binary_from = binaries.get(&l.from.module_id).cloned().flatten();
        let binary_to = binaries.get(&l.to.module_id).cloned().flatten();
        let bname = |b: &Option<Id>| {
            b.as_deref()
                .and_then(|b| binary_names.get(b))
                .copied()
                .unwrap_or("undefined")
        };
        let between = format!("binaries {} and {}", bname(&binary_from), bname(&binary_to));
        let crossing = crosses(&binaries, &l.from, &l.to);
        let transport = c.remote.transport.as_deref();
        if crossing && !c.remote.enabled {
            v.error(&target, format!("Link '{n}' joins {between}: it must be remote"));
        } else if crossing && transport.is_none_or(str::is_empty) {
            v.error(
                &target,
                format!("Link '{n}' joins {between}: it needs a transport"),
            );
        } else if c.remote.enabled && transport.is_none_or(str::is_empty) {
            v.warn(&target, format!("Link '{n}' is remote but has no transport"));
        }
        if c.remote.enabled && binary_from.is_some() && binary_from == binary_to {
            v.warn(
                &target,
                format!(
                    "Link '{n}' is remote but both ends run in binary {}",
                    bname(&binary_from)
                ),
            );
        }
        if let Some(t) = transport.filter(|t| !t.is_empty()) {
            if !TRANSPORTS.contains(&t) && !p.transports.iter().any(|x| x == t) {
                v.warn(&target, format!("Link '{n}': unknown transport '{t}'"));
            }
            if !c.remote.enabled {
                v.warn(
                    &target,
                    format!("Link '{n}': transport set but link is not remote"),
                );
            }
        }
        let settings = c.remote.settings.as_ref();
        if !c.remote.enabled && settings.is_some() {
            v.warn(
                &target,
                format!("Link '{n}': transport settings set but link is not remote"),
            );
        }
        if let (Some(settings), true) = (settings, c.remote.enabled) {
            let foreign = foreign_fields(settings, transport);
            if !foreign.is_empty() {
                v.warn(
                    &target,
                    format!(
                        "Link '{n}': {} {} not apply to transport '{}'",
                        foreign.join(", "),
                        if foreign.len() > 1 { "do" } else { "does" },
                        transport.unwrap_or("")
                    ),
                );
            }
            if matches!(transport, Some("http" | "websocket")) {
                if let Some(path) = settings
                    .path
                    .as_ref()
                    .filter(|x| !x.is_empty() && !x.starts_with('/'))
                {
                    v.error(&target, format!("Link '{n}': path '{path}' must start with '/'"));
                }
            }
            if let (Some(t @ ("shm" | "mq")), Some(name)) = (transport, &settings.name) {
                let what = if t == "shm" {
                    "shared memory"
                } else {
                    "message queue"
                };
                let limit = if t == "shm" { 255 } else { 249 };
                if !shm_name.is_match(name) || name.chars().count() > limit {
                    v.error(&target, format!("Link '{n}': {what} name '{name}' is not valid"));
                }
                let segment = name.strip_prefix('/').unwrap_or(name);
                let key = format!("{t}:{segment}");
                match segments.get(&key) {
                    Some(other) => v.warn(
                        &target,
                        format!("Link '{n}' uses the {what} '{segment}' of link '{other}'"),
                    ),
                    None => {
                        segments.insert(key, n.clone());
                    }
                }
            }
            let port = settings.server.as_ref().and_then(|s| s.port);
            let family = match transport {
                Some("udp") => Some("udp"),
                Some("tcp" | "http" | "websocket" | "grpc") => Some("tcp"),
                _ => None,
            };
            if let (Some(family), Some(port)) = (family, port) {
                let host = settings
                    .server
                    .as_ref()
                    .and_then(|s| s.host.clone())
                    .or_else(|| {
                        p.remote_defaults
                            .as_ref()
                            .and_then(|r| r.server.as_ref())
                            .and_then(|s| s.host.clone())
                    })
                    .unwrap_or_else(|| DEFAULT_HOST.into());
                let key = format!("{family} {host}:{port}");
                match servers.get(&key) {
                    Some(other) => v.warn(
                        &target,
                        format!("Link '{n}' listens on {family} {host}:{port}, as link '{other}'"),
                    ),
                    None => {
                        servers.insert(key, n.clone());
                    }
                }
            }
        }
        if l.from.module_id == l.to.module_id {
            v.warn(&target, format!("Link '{n}' loops back on the same module"));
        }
    }

    v.problems
}

/// Every node of a type tree, in `walk_type_ref` order.
fn type_nodes(t: &TypeRef) -> Vec<&TypeRef> {
    fn collect<'b>(t: &'b TypeRef, out: &mut Vec<&'b TypeRef>) {
        out.push(t);
        match t {
            TypeRefOf::Array { of, .. }
            | TypeRefOf::Vector { of, .. }
            | TypeRefOf::List { of, .. }
            | TypeRefOf::Set { of, .. }
            | TypeRefOf::Optional { of } => collect(of, out),
            TypeRefOf::Map { key, value, .. } => {
                collect(key, out);
                collect(value, out);
            }
            TypeRefOf::Ref { args, .. } => {
                for a in args.iter().flatten() {
                    collect(a, out)
                }
            }
            TypeRefOf::Primitive { .. } => {}
        }
    }
    let mut out = Vec::new();
    collect(t, &mut out);
    out
}

fn no_module(_: &str) -> bool {
    false
}

pub fn has_errors(problems: &[Problem]) -> bool {
    problems.iter().any(|p| p.severity == Severity::Error)
}
