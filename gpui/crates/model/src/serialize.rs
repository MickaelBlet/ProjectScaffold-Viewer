//! In-memory project <-> file format (qualified names), YAML/JSON text. Port of `serialize.ts`.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::emit::{num, to_json, to_yaml};
use crate::path;
use crate::project::*;
use crate::reuse::{pair, pair_by};
use crate::schema::*;
use crate::typeexpr::{map_ref, map_type_ref, parse_type_expr, print_type_expr};
use crate::types::*;
use crate::yamlread::{Node, parse_nodes};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Yaml,
    Json,
}

pub fn format_from_path(path: &str) -> Format {
    if path.to_lowercase().ends_with(".json") {
        Format::Json
    } else {
        Format::Yaml
    }
}

/// A problem of a file: its path in the file data, and its line (from 1) once found in the text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadIssue {
    pub message: String,
    pub path: Option<DataPath>,
    pub line: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{}", self.problems().join("\n"))]
pub struct LoadError {
    pub issues: Vec<LoadIssue>,
}

impl LoadError {
    pub fn message(message: impl Into<String>) -> Self {
        LoadError {
            issues: vec![LoadIssue {
                message: message.into(),
                path: None,
                line: None,
            }],
        }
    }
    /// Messages, prefixed with their line when known.
    pub fn problems(&self) -> Vec<String> {
        self.issues
            .iter()
            .map(|i| match i.line {
                Some(l) => format!("Line {l}: {}", i.message),
                None => i.message.clone(),
            })
            .collect()
    }
}

// Writing

/// Ordered object built like the web build's object literals (absent values left out).
#[derive(Default)]
struct Obj(Map<String, Value>);

impl Obj {
    fn new() -> Self {
        Obj(Map::new())
    }
    fn set(mut self, k: &str, v: impl Into<Value>) -> Self {
        self.0.insert(k.to_string(), v.into());
        self
    }
    fn opt<T: Into<Value>>(mut self, k: &str, v: Option<T>) -> Self {
        if let Some(v) = v {
            self.0.insert(k.to_string(), v.into());
        }
        self
    }
    fn flag(self, k: &str, on: bool) -> Self {
        self.opt(k, on.then_some(true))
    }
    fn merge(mut self, other: Obj) -> Self {
        self.0.extend(other.0);
        self
    }
    fn done(self) -> Value {
        Value::Object(self.0)
    }
}

fn opt_str(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    clean_numbers(serde_json::to_value(v).unwrap_or(Value::Null))
}

/// Integral floats as integers, as JavaScript holds them.
fn clean_numbers(v: Value) -> Value {
    match v {
        Value::Number(n) if !n.is_i64() && !n.is_u64() => num(n.as_f64().unwrap_or(0.)),
        Value::Array(a) => Value::Array(a.into_iter().map(clean_numbers).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, clean_numbers(v))).collect()),
        v => v,
    }
}

fn qualifiers_obj(q: Qualifiers) -> Obj {
    q.iter().fold(Obj::new(), |o, k| o.set(k.as_str(), true))
}

fn access_obj(a: Option<StoredAccess>) -> Obj {
    Obj::new().opt("access", a.map(|a| a.as_str()))
}

fn rect_value(r: &Rect) -> Value {
    Obj::new()
        .set("x", num(r.x))
        .set("y", num(r.y))
        .set("width", num(r.width))
        .set("height", num(r.height))
        .done()
}

fn point_value(p: &Point) -> Value {
    Obj::new().set("x", num(p.x)).set("y", num(p.y)).done()
}

fn anchor_value(a: &LinkAnchor) -> Value {
    Obj::new()
        .set("side", a.side.as_str())
        .set("at", num(a.at))
        .done()
}

/// File entry of a link shape.
fn route_entry(r: &LinkRoute) -> Value {
    Obj::new()
        .opt(
            "points",
            (!r.points.is_empty()).then(|| Value::Array(r.points.iter().map(point_value).collect())),
        )
        .opt("from", r.from.as_ref().map(anchor_value))
        .opt("to", r.to.as_ref().map(anchor_value))
        .opt("label", r.label.map(num))
        .done()
}

fn note_entry(n: &Note) -> Value {
    Obj::new()
        .set("kind", n.kind.as_str())
        .set("text", n.text.clone())
        .set("x", num(n.layout.x))
        .set("y", num(n.layout.y))
        .set("width", num(n.layout.width))
        .set("height", num(n.layout.height))
        .opt("color", n.color.clone())
        .flag("locked", n.locked)
        .done()
}

/// Name placements of the ports that have one, by port name.
fn port_labels<'a>(ports: impl Iterator<Item = (&'a str, Option<Side>)>) -> Option<Value> {
    let m: Map<String, Value> = ports
        .filter_map(|(n, l)| l.map(|l| (n.to_string(), Value::from(l.as_str()))))
        .collect();
    (!m.is_empty()).then_some(Value::Object(m))
}

fn non_empty(m: Map<String, Value>) -> Option<Value> {
    (!m.is_empty()).then_some(Value::Object(m))
}

/// File data of a project; `editor`: with the editor section.
pub fn to_file(p: &Project, editor: bool) -> Value {
    let types = type_names(p);
    let iface_names: HashMap<&str, &str> = p
        .interfaces
        .iter()
        .map(|i| (i.id.as_str(), i.name.as_str()))
        .collect();
    let type_name = |id: &str| -> Option<String> {
        types
            .get(id)
            .cloned()
            .or_else(|| iface_names.get(id).map(|s| s.to_string()))
    };
    let name_or_missing = |id: &str| {
        type_name(id)
            .or_else(|| missing_name(id).map(str::to_string))
            .unwrap_or("__deleted__".into())
    };
    let ref_name = ref_namer(p);
    let file_ref = |t: &TypeRef| -> FileTypeRef {
        map_ref(t, |r| NameRef {
            name: ref_name(&r.id).unwrap_or_else(|| "__deleted__".into()),
        })
    };
    let rf = |t: &TypeRef| to_value(&file_ref(t));
    let field = |name: &str, ty: &TypeRef, description: &str| {
        Obj::new()
            .set("name", name)
            .set("type", rf(ty))
            .opt("description", opt_str(description))
    };
    let value_rest = |f: &ValueField| {
        Obj::new()
            .opt("default", f.default.clone())
            .opt(
                "constraints",
                f.constraints.as_ref().filter(|c| !c.is_empty()).map(to_value),
            )
            .opt("ownership", f.ownership.map(|o| o.as_str()))
    };
    let value_field = |f: &ValueField| field(&f.name, &f.ty, &f.description).merge(value_rest(f)).done();
    let param = |prm: &Param| {
        field(&prm.name, &prm.ty, &prm.description).opt(
            "direction",
            (prm.direction != ParamDirection::In).then(|| prm.direction.as_str()),
        )
    };
    let raises = |r: &Option<Vec<Id>>| -> Option<Value> {
        r.as_ref()
            .filter(|r| !r.is_empty())
            .map(|r| Value::Array(r.iter().map(|id| name_or_missing(id).into()).collect()))
    };
    let returns = |r: &Option<TypeRef>| r.as_ref().map(rf).unwrap_or(Value::Null);
    let message = |m: &Message| {
        Obj::new()
            .set("name", m.name.clone())
            .opt("description", opt_str(&m.description))
            .set(
                "params",
                Value::Array(m.params.iter().map(|x| param(x).done()).collect()),
            )
            .set("returns", returns(&m.returns))
            .opt("raises", raises(&m.raises))
            .done()
    };
    let attribute = |a: &Attribute, locks: &[Lock]| {
        let f = &a.field;
        Obj::new()
            .set("name", f.name.clone())
            .merge(access_obj(a.access))
            .merge(qualifiers_obj(a.qualifiers))
            .set("type", rf(&f.ty))
            .opt("description", opt_str(&f.description))
            .merge(value_rest(f))
            .opt("accessors", a.accessors.map(|x| x.as_str()))
            .opt(
                "guardedBy",
                a.guarded_by
                    .as_ref()
                    .and_then(|g| locks.iter().find(|l| &l.id == g))
                    .map(|l| l.name.clone()),
            )
            .done()
    };
    let method_params = |params: &[MethodParam]| {
        Value::Array(
            params
                .iter()
                .map(|prm| {
                    param(&prm.param)
                        .merge(qualifiers_obj(prm.qualifiers))
                        .opt("default", prm.default.clone())
                        .done()
                })
                .collect(),
        )
    };
    let strings = |v: &Option<Vec<String>>| {
        v.as_ref()
            .filter(|v| !v.is_empty())
            .map(|v| Value::Array(v.iter().map(|s| s.clone().into()).collect()))
    };
    let method = |m: &Method| {
        Obj::new()
            .set("name", m.name.clone())
            .opt("description", opt_str(&m.description))
            .merge(access_obj(m.access))
            .merge(qualifiers_obj(m.qualifiers))
            .set("params", method_params(&m.params))
            .set("returns", returns(&m.returns))
            .opt("raises", raises(&m.raises))
            .opt("pre", strings(&m.pre))
            .opt("post", strings(&m.post))
            .done()
    };
    let constructor = |c: &Constructor| {
        Obj::new()
            .opt("description", opt_str(&c.description))
            .merge(access_obj(c.access))
            .flag("explicit", c.explicit)
            .flag("defaulted", c.defaulted)
            .flag("deleted", c.deleted)
            .set("params", method_params(&c.params))
            .done()
    };
    let state_machine = |m: &Module, sm: &StateMachine| {
        let state = |id: &str| {
            sm.states
                .iter()
                .find(|x| x.id == id)
                .map_or("__deleted__".into(), |x| x.name.clone())
        };
        let method = |id: &Option<Id>| {
            id.as_ref().map(|id| {
                m.methods
                    .iter()
                    .find(|x| &x.id == id)
                    .map_or("__deleted__".into(), |x| x.name.clone())
            })
        };
        Obj::new()
            .opt("initial", sm.initial.as_deref().map(state))
            .set(
                "states",
                Value::Array(
                    sm.states
                        .iter()
                        .map(|x| {
                            Obj::new()
                                .set("name", x.name.clone())
                                .opt("description", opt_str(&x.description))
                                .opt("entry", method(&x.entry))
                                .opt("exit", method(&x.exit))
                                .flag("final", x.r#final)
                                .done()
                        })
                        .collect(),
                ),
            )
            .set(
                "transitions",
                Value::Array(
                    sm.transitions
                        .iter()
                        .map(|t| {
                            Obj::new()
                                .set("from", state(&t.from))
                                .set("to", state(&t.to))
                                .opt("trigger", method(&t.trigger))
                                .opt("guard", t.guard.clone())
                                .opt("action", method(&t.action))
                                .done()
                        })
                        .collect(),
                ),
            )
            .done()
    };
    let type_body = |t: &TypeDef| -> Obj {
        let o = Obj::new().opt("description", opt_str(&t.description));
        match &t.body {
            TypeBody::Struct { fields, derives } => o
                .opt(
                    "derives",
                    derives
                        .as_ref()
                        .filter(|d| !d.is_empty())
                        .map(|d| Value::Array(d.iter().map(|x| x.as_str().into()).collect())),
                )
                .set("fields", Value::Array(fields.iter().map(value_field).collect())),
            TypeBody::Enum { underlying, values } => o.set("underlying", underlying.as_str()).set(
                "values",
                Value::Array(
                    values
                        .iter()
                        .map(|v| {
                            Obj::new()
                                .set("name", v.name.clone())
                                .set("value", v.value)
                                .done()
                        })
                        .collect(),
                ),
            ),
            TypeBody::Exception { fields } => {
                o.set("fields", Value::Array(fields.iter().map(value_field).collect()))
            }
            TypeBody::Bitmask { underlying, flags } => o.set("underlying", underlying.as_str()).set(
                "flags",
                Value::Array(
                    flags
                        .iter()
                        .map(|v| Obj::new().set("name", v.name.clone()).set("bit", v.bit).done())
                        .collect(),
                ),
            ),
            TypeBody::Union { discriminator, cases } => o.set("discriminator", rf(discriminator)).set(
                "cases",
                Value::Array(
                    cases
                        .iter()
                        .map(|c| {
                            field(&c.name, &c.ty, &c.description)
                                .opt(
                                    "labels",
                                    (!c.labels.is_empty()).then(|| Value::Array(c.labels.clone())),
                                )
                                .flag("default", c.is_default)
                                .done()
                        })
                        .collect(),
                ),
            ),
            TypeBody::Alias { ty } => o.set("type", rf(ty)),
            TypeBody::Primitive { .. } => o,
        }
    };
    let type_def = |t: &TypeDef| {
        Obj::new()
            .set("kind", t.kind())
            .set("name", t.name.clone())
            .merge(type_body(t))
            .done()
    };
    // A type of a module, with its access.
    let module_type_def = |t: &TypeDef| {
        Obj::new()
            .set("kind", t.kind())
            .set("name", t.name.clone())
            .merge(access_obj(t.access))
            .merge(type_body(t))
            .done()
    };
    let iface = |i: &Interface| {
        Obj::new()
            .set("name", i.name.clone())
            .opt("description", opt_str(&i.description))
            .set("messages", Value::Array(i.messages.iter().map(message).collect()))
            .done()
    };
    let constant = |c: &ConstDef| {
        Obj::new()
            .set("name", c.name.clone())
            .opt("description", opt_str(&c.description))
            .set("type", rf(&c.ty))
            .set("value", c.value.clone())
            .done()
    };
    let owned = |dependency: Option<&str>| {
        let consts: Vec<Value> = p
            .consts
            .iter()
            .filter(|c| c.dependency.as_deref() == dependency)
            .map(constant)
            .collect();
        Obj::new()
            .set(
                "types",
                Value::Array(
                    p.types
                        .iter()
                        .filter(|t| t.dependency.as_deref() == dependency && !t.is_module_type())
                        .map(type_def)
                        .collect(),
                ),
            )
            .set(
                "interfaces",
                Value::Array(
                    p.interfaces
                        .iter()
                        .filter(|i| i.dependency.as_deref() == dependency)
                        .map(iface)
                        .collect(),
                ),
            )
            .opt("constants", (!consts.is_empty()).then_some(Value::Array(consts)))
    };
    // Types of the modules of a dependency, by module path in the order of the types.
    let dependency_module_types = |dependency: &str| {
        let mut by_module: IndexMap<&str, Vec<Value>> = IndexMap::new();
        for t in &p.types {
            if t.dependency.as_deref() == Some(dependency) {
                if let Some(mp) = &t.module_path {
                    by_module.entry(mp.as_str()).or_default().push(module_type_def(t));
                }
            }
        }
        (!by_module.is_empty()).then(|| {
            Value::Array(
                by_module
                    .into_iter()
                    .map(|(m, types)| {
                        Obj::new()
                            .set("module", m)
                            .set("types", Value::Array(types))
                            .done()
                    })
                    .collect(),
            )
        })
    };
    let binary_name: HashMap<&str, &str> = p
        .binaries
        .iter()
        .map(|b| (b.id.as_str(), b.name.as_str()))
        .collect();
    let paths = project_module_paths(p);
    let path_of = |id: &str| paths.get(id).cloned().unwrap_or_default();
    fn module_tree(
        p: &Project,
        parent: Option<&str>,
        f: &dyn Fn(&Module, Vec<Value>) -> Value,
    ) -> Vec<Value> {
        child_modules(p, parent)
            .map(|m| f(m, module_tree(p, Some(&m.id), f)))
            .collect()
    }
    let ids = |v: &Option<Vec<Derive>>| {
        v.as_ref()
            .filter(|d| !d.is_empty())
            .map(|d| Value::Array(d.iter().map(|x| x.as_str().into()).collect()))
    };
    let module_entry = |m: &Module, children: Vec<Value>| -> Value {
        let all = module_types(p, &m.id);
        let params: Vec<&TypeDef> = all.iter().copied().filter(|t| t.type_param().is_some()).collect();
        let types: Vec<&TypeDef> = all.iter().copied().filter(|t| t.type_param().is_none()).collect();
        let base_name = |b: &Id| {
            let args = m
                .base_args
                .as_ref()
                .and_then(|a| a.get(b))
                .filter(|a| !a.is_empty());
            match args {
                Some(a) => format!(
                    "{}<{}>",
                    path_of(b),
                    a.iter()
                        .map(|x| print_type_expr(&file_ref(x)))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                None => path_of(b),
            }
        };
        Obj::new()
            .set("name", m.name.clone())
            .opt("description", opt_str(&m.description))
            .opt("kind", m.kind.map(|k| k.as_str()))
            .opt(
                "typeParams",
                (!params.is_empty()).then(|| {
                    Value::Array(
                        params
                            .iter()
                            .map(|t| {
                                let tp = t.type_param().cloned().unwrap_or_default();
                                Obj::new()
                                    .set("name", t.name.clone())
                                    .opt("description", opt_str(&t.description))
                                    .opt("constraint", tp.constraint.map(|c| c.as_str()))
                                    .opt("derivesFrom", tp.derives_from.as_deref().map(path_of))
                                    .opt("default", tp.default.as_ref().map(rf))
                                    .done()
                            })
                            .collect(),
                    )
                }),
            )
            .opt(
                "bases",
                m.bases
                    .as_ref()
                    .filter(|b| !b.is_empty())
                    .map(|b| Value::Array(b.iter().map(|x| base_name(x).into()).collect())),
            )
            .opt(
                "implements",
                m.implements
                    .as_ref()
                    .filter(|i| !i.is_empty())
                    .map(|i| Value::Array(i.iter().map(|x| name_or_missing(x).into()).collect())),
            )
            .flag("final", m.r#final)
            .opt("derives", ids(&m.derives))
            .opt("instantiation", m.instantiation.map(|x| x.as_str()))
            .opt("copy", m.copy.map(|x| x.as_str()))
            .opt("move", m.r#move.map(|x| x.as_str()))
            .opt(
                "locks",
                m.locks.as_ref().filter(|l| !l.is_empty()).map(|l| {
                    Value::Array(
                        l.iter()
                            .map(|l| {
                                Obj::new()
                                    .set("name", l.name.clone())
                                    .set("kind", l.kind.as_str())
                                    .done()
                            })
                            .collect(),
                    )
                }),
            )
            .opt(
                "active",
                m.active.as_ref().map(|a| {
                    let v = to_value(a);
                    if v.as_object().is_some_and(|o| o.is_empty()) {
                        Value::Bool(true)
                    } else {
                        v
                    }
                }),
            )
            .opt("invariants", strings(&m.invariants))
            .opt(
                "metadata",
                (!m.metadata.is_empty()).then(|| to_value(&m.metadata)),
            )
            .opt("color", m.color.clone())
            .opt(
                "binary",
                m.binary_id
                    .as_deref()
                    .and_then(|b| binary_name.get(b))
                    .map(|s| s.to_string()),
            )
            .opt(
                "types",
                (!types.is_empty()).then(|| Value::Array(types.iter().map(|t| module_type_def(t)).collect())),
            )
            .opt(
                "attributes",
                (!m.attributes.is_empty()).then(|| {
                    let locks = m.locks.as_deref().unwrap_or(&[]);
                    Value::Array(m.attributes.iter().map(|a| attribute(a, locks)).collect())
                }),
            )
            .opt(
                "constructors",
                m.constructors
                    .as_ref()
                    .filter(|c| !c.is_empty())
                    .map(|c| Value::Array(c.iter().map(constructor).collect())),
            )
            .opt(
                "destructor",
                m.destructor
                    .as_ref()
                    .map(|d| access_obj(d.access).opt("virtual", d.r#virtual).done()),
            )
            .opt(
                "methods",
                (!m.methods.is_empty()).then(|| Value::Array(m.methods.iter().map(method).collect())),
            )
            .opt(
                "stateMachine",
                m.state_machine.as_ref().map(|sm| state_machine(m, sm)),
            )
            .set(
                "ports",
                Value::Array(
                    m.ports
                        .iter()
                        .map(|pt| {
                            Obj::new()
                                .set("name", pt.name.clone())
                                .set("role", pt.role.as_str())
                                .set(
                                    "interface",
                                    pt.interface_id
                                        .as_deref()
                                        .and_then(|i| {
                                            type_name(i).or_else(|| missing_name(i).map(str::to_string))
                                        })
                                        .map_or(Value::Null, Value::from),
                                )
                                .opt("description", opt_str(&pt.description))
                                .done()
                        })
                        .collect(),
                ),
            )
            .opt(
                "modules",
                (!children.is_empty()).then_some(Value::Array(children)),
            )
            .done()
    };
    let endpoint = |e: &Endpoint| -> Value {
        if let Some((dep, m)) = find_imported(p, &e.module_id) {
            return Obj::new()
                .set("project", dep.name.clone())
                .set("module", m.path.clone())
                .set(
                    "port",
                    m.ports
                        .iter()
                        .find(|pt| pt.id == e.port_id)
                        .map_or(String::new(), |pt| pt.name.clone()),
                )
                .done();
        }
        Obj::new()
            .set("module", path_of(&e.module_id))
            .set(
                "port",
                find_module(p, &e.module_id)
                    .and_then(|m| m.ports.iter().find(|pt| pt.id == e.port_id))
                    .map_or(String::new(), |pt| pt.name.clone()),
            )
            .done()
    };
    let imported_port = |pt: &ImportedPort| {
        Obj::new()
            .set("name", pt.name.clone())
            .set("role", pt.role.as_str())
            .set("interface", pt.interface.clone().map_or(Value::Null, Value::from))
            .opt("description", opt_str(&pt.description))
            .done()
    };

    let mut file = Obj::new()
        .set("schemaVersion", SCHEMA_VERSION)
        .set(
            "project",
            Obj::new()
                .set("name", p.name.clone())
                .opt("description", opt_str(&p.description))
                .opt(
                    "metadata",
                    (!p.metadata.is_empty()).then(|| to_value(&p.metadata)),
                )
                .done(),
        )
        .opt(
            "transports",
            (!p.transports.is_empty())
                .then(|| Value::Array(p.transports.iter().map(|t| t.clone().into()).collect())),
        )
        .opt(
            "remoteDefaults",
            p.remote_defaults.as_ref().filter(|r| !r.is_empty()).map(to_value),
        )
        .opt(
            "binaries",
            (!p.binaries.is_empty()).then(|| {
                Value::Array(
                    p.binaries
                        .iter()
                        .map(|b| {
                            Obj::new()
                                .set("name", b.name.clone())
                                .opt("description", opt_str(&b.description))
                                .opt("color", b.color.clone())
                                .done()
                        })
                        .collect(),
                )
            }),
        )
        .merge(owned(None))
        .set("modules", Value::Array(module_tree(p, None, &module_entry)))
        .set(
            "links",
            Value::Array(
                p.links
                    .iter()
                    .map(|l| {
                        Obj::new()
                            .set("name", l.name.clone())
                            .opt("description", opt_str(&l.description))
                            .set("from", endpoint(&l.from))
                            .set("to", endpoint(&l.to))
                            .set("constraints", to_value(&l.constraints))
                            .opt("color", l.color.clone())
                            .done()
                    })
                    .collect(),
            ),
        )
        .opt(
            "dependencies",
            (!p.dependencies.is_empty()).then(|| {
                Value::Array(
                    p.dependencies
                        .iter()
                        .map(|x| {
                            Obj::new()
                                .set("name", x.name.clone())
                                .set("file", x.file.clone())
                                .opt("uses", (!x.uses.is_empty()).then(|| to_value(&x.uses)))
                                .flag("indirect", x.indirect)
                                .opt("shared", (!x.shared.is_empty()).then(|| to_value(&x.shared)))
                                .merge(owned(Some(&x.id)))
                                .opt("moduleTypes", dependency_module_types(&x.id))
                                .opt(
                                    "modules",
                                    (!x.modules.is_empty()).then(|| {
                                        Value::Array(
                                            x.modules
                                                .iter()
                                                .map(|m| {
                                                    Obj::new()
                                                        .set("module", m.path.clone())
                                                        .flag("final", m.r#final)
                                                        .opt(
                                                            "attributes",
                                                            m.attributes
                                                                .as_ref()
                                                                .filter(|a| !a.is_empty())
                                                                .map(|a| {
                                                                    Value::Array(
                                                                        a.iter()
                                                                            .map(|a| attribute(a, &[]))
                                                                            .collect(),
                                                                    )
                                                                }),
                                                        )
                                                        .opt(
                                                            "methods",
                                                            m.methods.as_ref().filter(|a| !a.is_empty()).map(
                                                                |a| {
                                                                    Value::Array(
                                                                        a.iter().map(method).collect(),
                                                                    )
                                                                },
                                                            ),
                                                        )
                                                        .set(
                                                            "ports",
                                                            Value::Array(
                                                                m.ports.iter().map(imported_port).collect(),
                                                            ),
                                                        )
                                                        .done()
                                                })
                                                .collect(),
                                        )
                                    }),
                                )
                                .done()
                        })
                        .collect(),
                )
            }),
        );

    if editor {
        // Shapes of the inheritance lines of a module, by base path.
        let base_routes = |m: &Module| -> Option<Value> {
            let mut out = Map::new();
            for b in m.bases.iter().flatten() {
                if let Some(r) = m.base_routes.as_ref().and_then(|r| r.get(b)) {
                    out.insert(
                        path_of(b),
                        route_entry(&LinkRoute {
                            label: None,
                            ..r.clone()
                        }),
                    );
                }
            }
            non_empty(out)
        };
        let mut e = Obj::new().set(
            "layout",
            Value::Object(
                p.modules
                    .iter()
                    .map(|m| (path_of(&m.id), rect_value(&m.layout)))
                    .collect(),
            ),
        );
        if !p.views.is_empty() {
            e = e.set(
                "views",
                Value::Array(p.views.iter().map(|v| view_entry(p, v, &path_of)).collect()),
            );
        }
        let mut style = Map::new();
        for m in &p.modules {
            let labels = port_labels(m.ports.iter().map(|pt| (pt.name.as_str(), pt.label)));
            let bases = base_routes(m);
            if m.locked || labels.is_some() || bases.is_some() {
                style.insert(
                    path_of(&m.id),
                    Obj::new()
                        .flag("locked", m.locked)
                        .opt("labels", labels)
                        .opt("bases", bases)
                        .done(),
                );
            }
        }
        e = e.opt("style", non_empty(style));
        if p.dependencies.iter().any(|x| !x.modules.is_empty()) {
            let deps: Map<String, Value> = p
                .dependencies
                .iter()
                .filter(|x| !x.modules.is_empty())
                .map(|x| {
                    let mods: Map<String, Value> = x
                        .modules
                        .iter()
                        .map(|m| {
                            let o = Obj::new()
                                .set("x", num(m.position.x))
                                .set("y", num(m.position.y))
                                .opt("width", m.size.map(|s| num(s.width)))
                                .opt("height", m.size.map(|s| num(s.height)))
                                .flag("locked", m.locked)
                                .opt(
                                    "labels",
                                    port_labels(m.ports.iter().map(|pt| (pt.name.as_str(), pt.label))),
                                );
                            (m.path.clone(), o.done())
                        })
                        .collect();
                    (x.name.clone(), Value::Object(mods))
                })
                .collect();
            e = e.set("dependencies", Value::Object(deps));
        }
        if p.orientation != Orientation::Horizontal {
            e = e.set("orientation", p.orientation.as_str());
        }
        let routed: Map<String, Value> = p
            .links
            .iter()
            .filter_map(|l| l.route.as_ref().map(|r| (l.name.clone(), route_entry(r))))
            .collect();
        e = e.opt("links", non_empty(routed));
        let notes: Vec<Value> = p
            .notes
            .iter()
            .filter(|n| n.view_id.is_none())
            .map(note_entry)
            .collect();
        e = e.opt("notes", (!notes.is_empty()).then_some(Value::Array(notes)));
        file = file.set("editor", e.done());
    }
    file.done()
}

/// File entry of a view.
fn view_entry(p: &Project, v: &View, path_of: &dyn Fn(&str) -> String) -> Value {
    let drill = v.root_module_id.is_some();
    // Own rects of a drill-down view, by module path: those of the modules in its root's subtree.
    let layouts = v.root_module_id.as_ref().and_then(|root| {
        let inside = subtree_ids(p, root);
        let m: Map<String, Value> = v
            .layouts
            .iter()
            .flatten()
            .filter(|(id, _)| inside.contains(*id))
            .map(|(id, r)| (path_of(id), rect_value(r)))
            .collect();
        non_empty(m)
    });
    let routes = drill.then(|| {
        let m: Map<String, Value> = p
            .links
            .iter()
            .filter_map(|l| {
                v.routes
                    .as_ref()
                    .and_then(|r| r.get(&l.id))
                    .map(|r| (l.name.clone(), route_entry(r)))
            })
            .collect();
        non_empty(m)
    });
    let labels = drill.then(|| {
        let own = v.port_labels.as_ref();
        let mut m = Map::new();
        let mut add = |id: &str, ports: Vec<(&str, &Id)>| {
            if let Some(l) = port_labels(
                ports
                    .into_iter()
                    .map(|(n, id)| (n, own.and_then(|o| o.get(id).copied()))),
            ) {
                m.insert(path_of(id), l);
            }
        };
        for x in &p.modules {
            add(
                &x.id,
                x.ports.iter().map(|pt| (pt.name.as_str(), &pt.id)).collect(),
            );
        }
        for x in all_imported(p) {
            add(
                &x.id,
                x.ports.iter().map(|pt| (pt.name.as_str(), &pt.id)).collect(),
            );
        }
        non_empty(m)
    });
    let outside = drill.then(|| {
        let own = v.stand_ins.as_ref();
        let paths = project_module_paths(p);
        // In the order of `modulePaths`: modules, then placed modules.
        let order = p
            .modules
            .iter()
            .map(|m| &m.id)
            .chain(all_imported(p).map(|m| &m.id));
        let m: Map<String, Value> = order
            .filter_map(|id| {
                own.and_then(|o| o.get(id)).map(|at| {
                    let o = Obj::new()
                        .set("x", num(at.x))
                        .set("y", num(at.y))
                        .opt("width", at.width.map(num))
                        .opt("height", at.height.map(num));
                    (paths[id].clone(), o.done())
                })
            })
            .collect();
        non_empty(m)
    });
    let notes = drill.then(|| {
        let n = view_notes(p, v);
        (!n.is_empty()).then(|| Value::Array(n.into_iter().map(note_entry).collect()))
    });
    Obj::new()
        .set("name", v.name.clone())
        .opt("root", v.root_module_id.as_deref().map(path_of))
        .opt(
            "hidden",
            (!v.hidden.is_empty())
                .then(|| Value::Array(v.hidden.iter().map(|h| path_of(h).into()).collect())),
        )
        .opt("layout", layouts)
        .opt("links", routes.flatten())
        .opt("labels", labels.flatten())
        .opt("outside", outside.flatten())
        .opt("notes", notes.flatten())
        .done()
}

// Reading

fn issue(message: String, path: DataPath) -> LoadIssue {
    LoadIssue {
        message,
        path: Some(path),
        line: None,
    }
}

fn with(at: &DataPath, more: DataPath) -> DataPath {
    let mut p = at.clone();
    p.extend(more);
    p
}

/// Checks of the file data the schema makes beyond its shape: names are identifiers or paths.
fn check_names(data: &Value) -> Vec<LoadIssue> {
    let mut out = Vec::new();
    fn ident(s: &str) -> bool {
        is_identifier(s)
    }
    fn qualified(s: &str) -> bool {
        !s.is_empty() && s.split('.').all(is_identifier)
    }
    fn module_path(s: &str) -> bool {
        match s.split_once('/') {
            Some((d, rest)) => ident(d) && qualified(rest),
            None => qualified(s),
        }
    }
    fn base_name(s: &str) -> bool {
        let head = s.split_once('<').map_or(s, |(h, _)| h);
        module_path(head) && (head.len() == s.len() || (s.ends_with('>') && s.len() > head.len() + 2))
    }
    /// Checks the string at `key` of each object of `v` (an array) with `ok`.
    fn walk(v: &Value, path: &DataPath, out: &mut Vec<LoadIssue>) {
        let msg_ident = "must be a valid identifier";
        let check =
            |v: Option<&Value>, at: DataPath, ok: fn(&str) -> bool, msg: &str, out: &mut Vec<LoadIssue>| {
                if let Some(Value::String(s)) = v {
                    if !ok(s) {
                        out.push(issue(format!("{}: {msg}", join(&at)), at));
                    }
                }
            };
        let Value::Object(o) = v else { return };
        let last = path.iter().rev().find_map(|k| {
            if let PathKey::Key(k) = k {
                Some(k.as_str())
            } else {
                None
            }
        });
        // Objects named by an identifier, by the key of the list holding them.
        const NAMED: &[&str] = &[
            "types",
            "interfaces",
            "constants",
            "modules",
            "ports",
            "links",
            "messages",
            "methods",
            "params",
            "fields",
            "attributes",
            "values",
            "flags",
            "cases",
            "binaries",
            "dependencies",
            "locks",
            "states",
            "typeParams",
        ];
        if let Some(l) = last {
            if NAMED.contains(&l)
                && !(l == "modules"
                    && path.iter().any(|k| *k == PathKey::Key("dependencies".into()))
                    && o.contains_key("module"))
            {
                check(o.get("name"), with(path, path!["name"]), ident, msg_ident, out);
            }
        }
        if let Some(Value::Array(a)) = o.get("bases") {
            for (i, b) in a.iter().enumerate() {
                check(
                    Some(b),
                    with(path, path!["bases", i]),
                    base_name,
                    "must be a module path, with type arguments for a generic module: Box<int32>",
                    out,
                );
            }
        }
        for (k, x) in o {
            let at = with(path, path![k.as_str()]);
            match x {
                Value::Array(a) => {
                    for (i, e) in a.iter().enumerate() {
                        walk(e, &with(&at, path![i]), out)
                    }
                }
                Value::Object(_) if k != "editor" && k != "default" && k != "value" && k != "metadata" => {
                    walk(x, &at, out)
                }
                _ => {}
            }
        }
    }
    walk(data, &vec![], &mut out);
    out
}

fn join(p: &[PathKey]) -> String {
    if p.is_empty() {
        return "<root>".into();
    }
    p.iter().map(ToString::to_string).collect::<Vec<_>>().join(".")
}

fn parse_file(data: &Value) -> Result<FileProject, LoadError> {
    let names = check_names(data);
    let f: FileProject = match serde_path_to_error::deserialize(data) {
        Ok(f) => f,
        Err(e) => {
            let path: DataPath = e
                .path()
                .iter()
                .filter_map(|s| match s {
                    serde_path_to_error::Segment::Seq { index } => Some(PathKey::Index(*index)),
                    serde_path_to_error::Segment::Map { key } => Some(PathKey::Key(key.clone())),
                    serde_path_to_error::Segment::Enum { variant } => Some(PathKey::Key(variant.clone())),
                    serde_path_to_error::Segment::Unknown => None,
                })
                .collect();
            let mut issues = vec![issue(format!("{}: {}", join(&path), e.inner()), path)];
            issues.extend(names);
            return Err(LoadError { issues });
        }
    };
    if f.schema_version != SCHEMA_VERSION {
        return Err(LoadError {
            issues: vec![issue(
                format!("schemaVersion: Invalid input: expected {SCHEMA_VERSION}"),
                path!["schemaVersion"],
            )],
        });
    }
    if !names.is_empty() {
        return Err(LoadError { issues: names });
    }
    Ok(f)
}

/// A type entry of the file: with its name as the file writes it and its owner.
struct TypeEntry {
    e: FileTypeDef,
    at: DataPath,
    key: String,
    dependency: Option<Id>,
    /// Path of the module of this project owning it.
    module: Option<String>,
    /// Path of the module of its dependency owning it.
    module_path: Option<String>,
    /// A type parameter of its module, as written in the file.
    param: Option<FileTypeParam>,
}

/// Prefix of the ids of references naming no type, resolved once modules are known.
const PENDING: &str = "\u{0}pending:";

struct Loader<'a> {
    prev: Option<&'a Project>,
    problems: Vec<LoadIssue>,
    type_ids: HashMap<String, Id>,
    interface_names: HashSet<String>,
    /// Names of the references naming no type, by index in the pending ids.
    pending: Vec<String>,
}

impl<'a> Loader<'a> {
    fn report(&mut self, message: String, at: DataPath) {
        self.problems.push(issue(message, at));
    }

    fn id_of(&self, was: Option<&Id>, derived: impl FnOnce() -> Id) -> Id {
        match was {
            Some(id) => id.clone(),
            None if self.prev.is_some() => new_id(),
            None => derived(),
        }
    }

    fn type_ref(&mut self, t: &FileTypeRef, w: &str, at: &DataPath) -> TypeRef {
        let mut reports = Vec::new();
        let out = map_type_ref(t, &mut |r: &NameRef| {
            if self.interface_names.contains(&r.name) {
                reports.push(format!("{w}: unknown type '{}'", r.name));
            }
            if let Some(id) = self.type_ids.get(&r.name) {
                return Ok::<IdRef, ()>(IdRef { id: id.clone() });
            }
            self.pending.push(r.name.clone());
            Ok(IdRef {
                id: format!("{PENDING}{}", self.pending.len() - 1),
            })
        })
        .unwrap_or_else(|_| TypeRef::primitive(Primitive::Bool));
        for m in reports {
            self.report(m, at.clone());
        }
        out
    }

    fn value_field(
        &mut self,
        fl: &FileValueField,
        w: &str,
        was: Option<&ValueField>,
        at: &DataPath,
    ) -> ValueField {
        ValueField {
            id: was.map_or_else(new_id, |x| x.id.clone()),
            name: fl.name.clone(),
            ty: self.type_ref(&fl.ty, &format!("{w}.{}", fl.name), &with(at, path!["type"])),
            description: fl.description.clone().unwrap_or_default(),
            default: fl.default.clone(),
            constraints: fl.constraints.clone().filter(|c| !c.is_empty()),
            ownership: fl.ownership,
        }
    }

    /// Messages of an interface or methods of a module (`owner`), at `at` in the file data.
    fn messages(
        &mut self,
        list: &[FileMethod],
        owner: &str,
        before: &[Message],
        at: &DataPath,
    ) -> Vec<Message> {
        let was = pair_by(
            before,
            |m| m.name.clone(),
            &list.iter().map(|m| &m.name).collect::<Vec<_>>(),
        );
        list.iter()
            .enumerate()
            .map(|(j, m)| {
                let w = format!("{owner}.{}", m.name);
                let prev_params = was[j].map_or(&[][..], |x| &x.params[..]);
                let params = pair_by(
                    prev_params,
                    |x| x.name.clone(),
                    &m.params.iter().map(|x| &x.name).collect::<Vec<_>>(),
                );
                let at_m = with(at, path![j]);
                let params = m
                    .params
                    .iter()
                    .enumerate()
                    .map(|(k, prm)| Param {
                        id: params[k].map_or_else(new_id, |x| x.id.clone()),
                        name: prm.name.clone(),
                        ty: self.type_ref(
                            &prm.ty,
                            &format!("{w}.{}", prm.name),
                            &with(&at_m, path!["params", k, "type"]),
                        ),
                        description: prm.description.clone().unwrap_or_default(),
                        direction: prm.direction.unwrap_or(ParamDirection::In),
                    })
                    .collect();
                let returns = m
                    .returns
                    .as_ref()
                    .map(|r| self.type_ref(r, &format!("{w} returns"), &with(&at_m, path!["returns"])));
                let raises = m.raises.as_ref().filter(|r| !r.is_empty()).map(|r| {
                    r.iter()
                        .enumerate()
                        .map(|(k, name)| {
                            // Unknown ones are missing references, reported by validation.
                            if self.interface_names.contains(name) {
                                self.report(
                                    format!("{w} raises: unknown exception '{name}'"),
                                    with(&at_m, path!["raises", k]),
                                );
                            }
                            self.type_ids
                                .get(name)
                                .cloned()
                                .unwrap_or_else(|| missing_ref(name))
                        })
                        .collect()
                });
                Message {
                    id: was[j].map_or_else(new_id, |x| x.id.clone()),
                    name: m.name.clone(),
                    description: m.description.clone().unwrap_or_default(),
                    params,
                    returns,
                    raises,
                }
            })
            .collect()
    }

    /// Methods of a module (`path`) or placed module, at `at` in the file data.
    fn methods(&mut self, list: &[FileMethod], path: &str, before: &[Method], at: &DataPath) -> Vec<Method> {
        let as_messages: Vec<Message> = before
            .iter()
            .map(|m| Message {
                id: m.id.clone(),
                name: m.name.clone(),
                description: String::new(),
                params: m.params.iter().map(|p| p.param.clone()).collect(),
                returns: None,
                raises: None,
            })
            .collect();
        self.messages(list, path, &as_messages, at)
            .into_iter()
            .zip(list)
            .map(|(x, fx)| Method {
                id: x.id,
                name: x.name,
                description: x.description,
                params: x
                    .params
                    .into_iter()
                    .zip(&fx.params)
                    .map(|(prm, fp)| MethodParam {
                        param: prm,
                        qualifiers: fp.qualifiers.qualifiers(),
                        default: fp.default.clone(),
                    })
                    .collect(),
                returns: x.returns,
                raises: x.raises,
                qualifiers: fx.qualifiers.qualifiers(),
                pre: fx.pre.clone().filter(|v| !v.is_empty()),
                post: fx.post.clone().filter(|v| !v.is_empty()),
                access: fx.access.and_then(StoredAccess::stored),
            })
            .collect()
    }

    /// Attributes of a module (`path`) or placed module, at `at`; `locks`: those of the module.
    fn attributes(
        &mut self,
        list: &[FileAttribute],
        path: &str,
        before: &[Attribute],
        at: &DataPath,
        locks: &[Lock],
    ) -> Vec<Attribute> {
        let was = pair_by(
            before,
            |a| a.field.name.clone(),
            &list.iter().map(|a| &a.name).collect::<Vec<_>>(),
        );
        list.iter()
            .enumerate()
            .map(|(j, a)| {
                let lock = a
                    .guarded_by
                    .as_ref()
                    .and_then(|g| locks.iter().find(|l| &l.name == g));
                if let (Some(g), None) = (&a.guarded_by, lock) {
                    self.report(
                        format!("{path}.{}: unknown lock '{g}'", a.name),
                        with(at, path![j, "guardedBy"]),
                    );
                }
                let vf = FileValueField {
                    name: a.name.clone(),
                    ty: a.ty.clone(),
                    description: a.description.clone(),
                    default: a.default.clone(),
                    constraints: a.constraints.clone(),
                    ownership: a.ownership,
                };
                Attribute {
                    field: self.value_field(&vf, path, was[j].map(|x| &x.field), &with(at, path![j])),
                    qualifiers: a.qualifiers.qualifiers(),
                    access: a.access.and_then(StoredAccess::stored),
                    accessors: a.accessors,
                    guarded_by: lock.map(|l| l.id.clone()),
                }
            })
            .collect()
    }

    /// Constructors of a module (`path`, named `name`): read as methods.
    fn constructors(
        &mut self,
        list: &[FileConstructor],
        path: &str,
        name: &str,
        before: &[Constructor],
        at: &DataPath,
    ) -> Vec<Constructor> {
        let as_methods: Vec<FileMethod> = list
            .iter()
            .map(|c| FileMethod {
                name: name.to_string(),
                description: c.description.clone(),
                access: None,
                qualifiers: FileQualifiers::default(),
                params: c.params.clone(),
                returns: None,
                raises: None,
                pre: None,
                post: None,
            })
            .collect();
        let was: Vec<Method> = before
            .iter()
            .map(|c| Method {
                id: c.id.clone(),
                name: name.to_string(),
                description: c.description.clone(),
                params: c.params.clone(),
                returns: None,
                raises: None,
                qualifiers: Qualifiers::default(),
                pre: None,
                post: None,
                access: c.access,
            })
            .collect();
        self.methods(&as_methods, path, &was, at)
            .into_iter()
            .zip(list)
            .map(|(x, fc)| Constructor {
                id: x.id,
                description: x.description,
                params: x.params,
                access: fc.access.and_then(StoredAccess::stored),
                explicit: fc.explicit == Some(true),
                defaulted: fc.defaulted == Some(true),
                deleted: fc.deleted == Some(true),
            })
            .collect()
    }

    /// State machine of a module (`path`) with methods `methods`, at `at` in the file data.
    fn state_machine(
        &mut self,
        fsm: &FileStateMachine,
        path: &str,
        before: Option<&StateMachine>,
        methods: &[Method],
        at: &DataPath,
    ) -> StateMachine {
        let prev_states = before.map_or(&[][..], |b| &b.states[..]);
        let state_was = pair_by(
            prev_states,
            |s| s.name.clone(),
            &fsm.states.iter().map(|s| &s.name).collect::<Vec<_>>(),
        );
        let mut states: Vec<State> = fsm
            .states
            .iter()
            .enumerate()
            .map(|(j, x)| State {
                id: state_was[j].map_or_else(new_id, |s| s.id.clone()),
                name: x.name.clone(),
                description: x.description.clone().unwrap_or_default(),
                entry: None,
                exit: None,
                r#final: x.is_final == Some(true),
            })
            .collect();
        let state_id = |me: &mut Self, states: &[State], name: &str, w: DataPath| -> Id {
            match states.iter().find(|s| s.name == name) {
                Some(s) => s.id.clone(),
                None => {
                    me.report(format!("{path}: unknown state '{name}'"), w);
                    missing_ref(name)
                }
            }
        };
        let method_id = |me: &mut Self, name: &Option<String>, w: DataPath| -> Option<Id> {
            let name = name.as_ref()?;
            Some(match methods.iter().find(|m| &m.name == name) {
                Some(m) => m.id.clone(),
                None => {
                    me.report(format!("{path}: unknown method '{name}'"), w);
                    missing_ref(name)
                }
            })
        };
        for (j, x) in fsm.states.iter().enumerate() {
            states[j].entry = method_id(self, &x.entry, with(at, path!["states", j, "entry"]));
            states[j].exit = method_id(self, &x.exit, with(at, path!["states", j, "exit"]));
        }
        let name_of: HashMap<&str, &str> = prev_states
            .iter()
            .map(|s| (s.id.as_str(), s.name.as_str()))
            .collect();
        let key = |from: Option<&str>, to: Option<&str>, trigger: Option<&str>| {
            format!(
                "{}>{}:{}",
                from.unwrap_or("undefined"),
                to.unwrap_or("undefined"),
                trigger.unwrap_or("")
            )
        };
        let prev_transitions = before.map_or(&[][..], |b| &b.transitions[..]);
        let prev_keys: Vec<String> = prev_transitions
            .iter()
            .map(|t| {
                key(
                    name_of.get(t.from.as_str()).copied(),
                    name_of.get(t.to.as_str()).copied(),
                    t.trigger
                        .as_deref()
                        .and_then(|tr| methods.iter().find(|x| x.id == tr))
                        .map(|m| m.name.as_str()),
                )
            })
            .collect();
        let next_keys: Vec<String> = fsm
            .transitions
            .iter()
            .map(|t| key(Some(&t.from), Some(&t.to), t.trigger.as_deref()))
            .collect();
        let transition_was = pair(&prev_keys, &next_keys);
        let transitions = fsm
            .transitions
            .iter()
            .enumerate()
            .map(|(j, t)| {
                let w = with(at, path!["transitions", j]);
                let trigger = method_id(self, &t.trigger, with(&w, path!["trigger"]));
                let action = method_id(self, &t.action, with(&w, path!["action"]));
                Transition {
                    id: transition_was[j].map_or_else(new_id, |i| prev_transitions[i].id.clone()),
                    from: state_id(self, &states, &t.from, with(&w, path!["from"])),
                    to: state_id(self, &states, &t.to, with(&w, path!["to"])),
                    trigger,
                    guard: t.guard.clone(),
                    action,
                }
            })
            .collect();
        let initial = fsm
            .initial
            .as_ref()
            .map(|i| state_id(self, &states, i, with(at, path!["initial"])));
        StateMachine {
            initial,
            states,
            transitions,
        }
    }
}

/// Every type reference of a project, wherever it is held, mutably.
fn for_each_any_type_ref_mut(d: &mut Project, f: &mut impl FnMut(&mut TypeRef)) {
    for_each_type_ref_mut(d, f);
    for t in &mut d.types {
        if let TypeBody::Primitive {
            type_param: Some(TypeParam { default: Some(x), .. }),
        } = &mut t.body
        {
            f(x)
        }
    }
    let method = |m: &mut Method, f: &mut dyn FnMut(&mut TypeRef)| {
        m.params.iter_mut().for_each(|p| f(&mut p.param.ty));
        if let Some(r) = &mut m.returns {
            f(r)
        }
    };
    for m in &mut d.modules {
        for c in m.constructors.iter_mut().flatten() {
            c.params.iter_mut().for_each(|p| f(&mut p.param.ty));
        }
        for args in m.base_args.iter_mut().flat_map(|a| a.values_mut()) {
            args.iter_mut().for_each(&mut *f);
        }
    }
    for dep in &mut d.dependencies {
        for m in &mut dep.modules {
            m.attributes.iter_mut().flatten().for_each(|a| f(&mut a.field.ty));
            for x in m.methods.iter_mut().flatten() {
                method(x, f)
            }
        }
    }
}

// Auto layout (modules without editor data): rows of siblings, parents grown to fit children.
const PAD: f64 = 20.;
const GAP_X: f64 = 80.;
const GAP_Y: f64 = 60.;
const MAX_ROW: f64 = 1400.;

fn file_module_compartments(fm: &FileModule) -> Compartments {
    Compartments {
        attributes: fm.attributes.as_ref().map_or(0, Vec::len),
        methods: fm.methods.as_ref().map_or(0, Vec::len),
        constructors: fm.constructors.as_ref().map_or(0, Vec::len),
        destructor: fm.destructor.is_some(),
    }
}

/// A module with bases, resolved once all modules are known.
struct Derived {
    index: usize,
    path: String,
    bases: Vec<String>,
    at: DataPath,
    /// Shapes of its inheritance lines in the file, by base path; None: no style for the module.
    shapes: Option<Record<FileLinkShape>>,
    /// Those of the module renamed since the previous state, by base.
    prev_shapes: Option<IndexMap<Id, BaseRoute>>,
}

fn shape_route(s: &FileLinkShape, label: bool) -> LinkRoute {
    LinkRoute {
        points: s
            .points
            .iter()
            .flatten()
            .map(|p| Point { x: p.x, y: p.y })
            .collect(),
        from: s.from.map(|a| LinkAnchor {
            side: a.side,
            at: a.at,
        }),
        to: s.to.map(|a| LinkAnchor {
            side: a.side,
            at: a.at,
        }),
        label: if label { s.label } else { None },
    }
}

/// Project of file data. With `prev`, a previous state of the project, its entities keep their ids
/// and their editor data when the file has none for them (added to the text or renamed in it).
pub fn from_file(data: &Value, prev: Option<&Project>) -> Result<Project, LoadError> {
    let f = parse_file(data)?;
    let mut ld = Loader {
        prev,
        problems: vec![],
        type_ids: HashMap::new(),
        interface_names: HashSet::new(),
        pending: vec![],
    };
    let names_of = |list: &[&String]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();

    let file_binaries = f.binaries.clone().unwrap_or_default();
    let prev_binaries = pair_by(
        prev.map_or(&[][..], |p| &p.binaries[..]),
        |b| b.name.clone(),
        &names_of(&file_binaries.iter().map(|b| &b.name).collect::<Vec<_>>()),
    );
    let mut binary_ids: HashMap<String, Id> = HashMap::new();
    let mut binaries = Vec::new();
    for (i, b) in file_binaries.iter().enumerate() {
        if binary_ids.contains_key(&b.name) {
            ld.report(
                format!("Duplicate binary '{}'", b.name),
                path!["binaries", i, "name"],
            );
        }
        let id = ld.id_of(prev_binaries[i].map(|x| &x.id), || format!("binary:{}", b.name));
        binary_ids.insert(b.name.clone(), id.clone());
        binaries.push(Binary {
            id,
            name: b.name.clone(),
            description: b.description.clone().unwrap_or_default(),
            color: b.color.clone().filter(|c| !c.is_empty()),
        });
    }

    // Dependencies: their types and interfaces follow the project's own ones, in the same namespace.
    let file_dependencies = f.dependencies.clone().unwrap_or_default();
    let prev_dependencies = pair_by(
        prev.map_or(&[][..], |p| &p.dependencies[..]),
        |d| d.name.clone(),
        &names_of(&file_dependencies.iter().map(|d| &d.name).collect::<Vec<_>>()),
    );
    let mut dependency_names = HashSet::new();
    let mut dependency_ids = Vec::new();
    for (i, x) in file_dependencies.iter().enumerate() {
        if !dependency_names.insert(x.name.clone()) {
            ld.report(
                format!("Duplicate dependency '{}'", x.name),
                path!["dependencies", i, "name"],
            );
        }
        dependency_ids.push(ld.id_of(prev_dependencies[i].map(|x| &x.id), || {
            format!("dependency:{}", x.name)
        }));
    }
    for (i, x) in file_dependencies.iter().enumerate() {
        for (j, u) in x.uses.iter().flatten().enumerate() {
            if !dependency_names.contains(u) {
                ld.report(
                    format!("Dependency '{}' uses unknown dependency '{u}'", x.name),
                    path!["dependencies", i, "uses", j],
                );
            }
        }
    }

    fn own_module_types(list: &[FileModule], parent_path: &str, at: &DataPath, out: &mut Vec<TypeEntry>) {
        for (i, fm) in list.iter().enumerate() {
            let path = if parent_path.is_empty() {
                fm.name.clone()
            } else {
                format!("{parent_path}.{}", fm.name)
            };
            // Type parameters: private types of the module, named `Module.Path.T` in the file.
            for (j, tp) in fm.type_params.iter().flatten().enumerate() {
                out.push(TypeEntry {
                    e: FileTypeDef {
                        name: tp.name.clone(),
                        description: tp.description.clone(),
                        access: Some(Access::Private),
                        body: FileTypeBody::Primitive {},
                    },
                    at: with(at, path![i, "typeParams", j]),
                    key: format!("{path}.{}", tp.name),
                    dependency: None,
                    module: Some(path.clone()),
                    module_path: None,
                    param: Some(tp.clone()),
                });
            }
            for (j, e) in fm.types.iter().flatten().enumerate() {
                out.push(TypeEntry {
                    e: e.clone(),
                    at: with(at, path![i, "types", j]),
                    key: format!("{path}.{}", e.name),
                    dependency: None,
                    module: Some(path.clone()),
                    module_path: None,
                    param: None,
                });
            }
            own_module_types(
                fm.modules.as_deref().unwrap_or(&[]),
                &path,
                &with(at, path![i, "modules"]),
                out,
            );
        }
    }
    let mut type_entries: Vec<TypeEntry> = f
        .types
        .iter()
        .enumerate()
        .map(|(i, e)| {
            // Project types have no access (only module types do).
            let mut e = e.clone();
            e.access = None;
            TypeEntry {
                e,
                at: path!["types", i],
                key: String::new(),
                dependency: None,
                module: None,
                module_path: None,
                param: None,
            }
        })
        .map(|mut t| {
            t.key = t.e.name.clone();
            t
        })
        .collect();
    own_module_types(&f.modules, "", &path!["modules"], &mut type_entries);
    for (xi, x) in file_dependencies.iter().enumerate() {
        for (i, e) in x.types.iter().enumerate() {
            let mut e = e.clone();
            e.access = None;
            type_entries.push(TypeEntry {
                key: e.name.clone(),
                e,
                at: path!["dependencies", xi, "types", i],
                dependency: Some(dependency_ids[xi].clone()),
                module: None,
                module_path: None,
                param: None,
            });
        }
        for (gi, g) in x.module_types.iter().flatten().enumerate() {
            for (i, e) in g.types.iter().enumerate() {
                type_entries.push(TypeEntry {
                    e: e.clone(),
                    at: path!["dependencies", xi, "moduleTypes", gi, "types", i],
                    key: format!("{}/{}.{}", x.name, g.module, e.name),
                    dependency: Some(dependency_ids[xi].clone()),
                    module: None,
                    module_path: Some(g.module.clone()),
                    param: None,
                });
            }
        }
    }
    let mut interface_entries: Vec<(&FileInterface, DataPath, Option<Id>)> = f
        .interfaces
        .iter()
        .enumerate()
        .map(|(i, e)| (e, path!["interfaces", i], None))
        .collect();
    for (xi, x) in file_dependencies.iter().enumerate() {
        for (i, e) in x.interfaces.iter().enumerate() {
            interface_entries.push((
                e,
                path!["dependencies", xi, "interfaces", i],
                Some(dependency_ids[xi].clone()),
            ));
        }
    }

    let prev_type_names = prev.map(type_names).unwrap_or_default();
    let prev_types_list = prev.map_or(&[][..], |p| &p.types[..]);
    let prev_type_keys: Vec<String> = prev_types_list
        .iter()
        .map(|t| prev_type_names.get(&t.id).cloned().unwrap_or_default())
        .collect();
    let prev_types: Vec<Option<&TypeDef>> = pair(
        &prev_type_keys,
        &type_entries.iter().map(|x| &x.key).collect::<Vec<_>>(),
    )
    .into_iter()
    .map(|i| i.map(|i| &prev_types_list[i]))
    .collect();
    let prev_interfaces = pair_by(
        prev.map_or(&[][..], |p| &p.interfaces[..]),
        |i| i.name.clone(),
        &interface_entries.iter().map(|x| &x.0.name).collect::<Vec<_>>(),
    );
    // Types and interfaces share one namespace.
    let declare = |ld: &mut Loader, name: &str, what: &str, was: Option<&Id>, at: DataPath| -> Id {
        if ld.type_ids.contains_key(name) {
            ld.report(format!("Duplicate {what} name '{name}'"), at);
        }
        let id = ld.id_of(was, || format!("{what}:{name}"));
        ld.type_ids.insert(name.to_string(), id.clone());
        id
    };
    let type_def_ids: Vec<Id> = type_entries
        .iter()
        .enumerate()
        .map(|(i, x)| {
            declare(
                &mut ld,
                &x.key,
                "type",
                prev_types[i].map(|t| &t.id),
                with(&x.at, path!["name"]),
            )
        })
        .collect();
    let interface_ids: Vec<Id> = interface_entries
        .iter()
        .enumerate()
        .map(|(i, x)| {
            declare(
                &mut ld,
                &x.0.name,
                "interface",
                prev_interfaces[i].map(|t| &t.id),
                with(&x.1, path!["name"]),
            )
        })
        .collect();
    ld.interface_names = interface_entries.iter().map(|x| x.0.name.clone()).collect();

    // Constants share the namespace too.
    let mut const_entries: Vec<(&FileConstant, DataPath, Option<Id>)> = f
        .constants
        .iter()
        .flatten()
        .enumerate()
        .map(|(i, e)| (e, path!["constants", i], None))
        .collect();
    for (xi, x) in file_dependencies.iter().enumerate() {
        for (i, e) in x.constants.iter().flatten().enumerate() {
            const_entries.push((
                e,
                path!["dependencies", xi, "constants", i],
                Some(dependency_ids[xi].clone()),
            ));
        }
    }
    let prev_consts = pair_by(
        prev.map_or(&[][..], |p| &p.consts[..]),
        |c| c.name.clone(),
        &const_entries.iter().map(|x| &x.0.name).collect::<Vec<_>>(),
    );
    let mut const_names = HashSet::new();
    let mut const_ids = Vec::new();
    for (i, x) in const_entries.iter().enumerate() {
        if ld.type_ids.contains_key(&x.0.name) || const_names.contains(&x.0.name) {
            ld.report(
                format!("Duplicate constant name '{}'", x.0.name),
                with(&x.1, path!["name"]),
            );
        }
        const_names.insert(x.0.name.clone());
        const_ids.push(ld.id_of(prev_consts[i].map(|c| &c.id), || format!("const:{}", x.0.name)));
    }

    let mut types: Vec<TypeDef> = Vec::new();
    for (i, x) in type_entries.iter().enumerate() {
        let t = &x.e;
        let was = prev_types[i];
        let at = &x.at;
        let module_type = x.module.is_some() || x.module_path.is_some();
        let body = match &t.body {
            FileTypeBody::Struct { derives, fields } => {
                let before = match was.map(|w| &w.body) {
                    Some(TypeBody::Struct { fields, .. }) => &fields[..],
                    _ => &[][..],
                };
                let pairs = pair_by(
                    before,
                    |f| f.name.clone(),
                    &fields.iter().map(|f| &f.name).collect::<Vec<_>>(),
                );
                TypeBody::Struct {
                    derives: derives.clone().filter(|d| !d.is_empty()),
                    fields: fields
                        .iter()
                        .enumerate()
                        .map(|(j, fl)| ld.value_field(fl, &t.name, pairs[j], &with(at, path!["fields", j])))
                        .collect(),
                }
            }
            FileTypeBody::Enum { underlying, values } => {
                let before = match was.map(|w| &w.body) {
                    Some(TypeBody::Enum { values, .. }) => &values[..],
                    _ => &[][..],
                };
                let pairs = pair_by(
                    before,
                    |v| v.name.clone(),
                    &values.iter().map(|v| &v.name).collect::<Vec<_>>(),
                );
                TypeBody::Enum {
                    underlying: *underlying,
                    values: values
                        .iter()
                        .enumerate()
                        .map(|(j, v)| EnumValue {
                            id: pairs[j].map_or_else(new_id, |x| x.id.clone()),
                            name: v.name.clone(),
                            value: v.value,
                        })
                        .collect(),
                }
            }
            FileTypeBody::Exception { fields } => {
                let before = match was.map(|w| &w.body) {
                    Some(TypeBody::Exception { fields }) => &fields[..],
                    _ => &[][..],
                };
                let pairs = pair_by(
                    before,
                    |f| f.name.clone(),
                    &fields.iter().map(|f| &f.name).collect::<Vec<_>>(),
                );
                TypeBody::Exception {
                    fields: fields
                        .iter()
                        .enumerate()
                        .map(|(j, fl)| ld.value_field(fl, &t.name, pairs[j], &with(at, path!["fields", j])))
                        .collect(),
                }
            }
            FileTypeBody::Bitmask { underlying, flags } => {
                let before = match was.map(|w| &w.body) {
                    Some(TypeBody::Bitmask { flags, .. }) => &flags[..],
                    _ => &[][..],
                };
                let pairs = pair_by(
                    before,
                    |v| v.name.clone(),
                    &flags.iter().map(|v| &v.name).collect::<Vec<_>>(),
                );
                TypeBody::Bitmask {
                    underlying: *underlying,
                    flags: flags
                        .iter()
                        .enumerate()
                        .map(|(j, v)| BitmaskFlag {
                            id: pairs[j].map_or_else(new_id, |x| x.id.clone()),
                            name: v.name.clone(),
                            bit: v.bit,
                        })
                        .collect(),
                }
            }
            FileTypeBody::Union { discriminator, cases } => {
                let before = match was.map(|w| &w.body) {
                    Some(TypeBody::Union { cases, .. }) => &cases[..],
                    _ => &[][..],
                };
                let pairs = pair_by(
                    before,
                    |c| c.name.clone(),
                    &cases.iter().map(|c| &c.name).collect::<Vec<_>>(),
                );
                let discriminator = ld.type_ref(
                    discriminator,
                    &format!("{} discriminator", t.name),
                    &with(at, path!["discriminator"]),
                );
                TypeBody::Union {
                    discriminator,
                    cases: cases
                        .iter()
                        .enumerate()
                        .map(|(j, c)| UnionCase {
                            id: pairs[j].map_or_else(new_id, |x| x.id.clone()),
                            name: c.name.clone(),
                            ty: ld.type_ref(
                                &c.ty,
                                &format!("{}.{}", t.name, c.name),
                                &with(at, path!["cases", j, "type"]),
                            ),
                            description: c.description.clone().unwrap_or_default(),
                            labels: c.labels.clone().unwrap_or_default(),
                            is_default: c.default.unwrap_or(false),
                        })
                        .collect(),
                }
            }
            FileTypeBody::Alias { ty } => TypeBody::Alias {
                ty: ld.type_ref(ty, &t.name, &with(at, path!["type"])),
            },
            FileTypeBody::Primitive {} => TypeBody::Primitive { type_param: None },
        };
        types.push(TypeDef {
            id: type_def_ids[i].clone(),
            name: t.name.clone(),
            description: t.description.clone().unwrap_or_default(),
            dependency: x.dependency.clone(),
            module: None,
            module_path: x.module_path.clone(),
            access: if module_type {
                t.access.and_then(StoredAccess::stored)
            } else {
                None
            },
            body,
        });
    }

    let consts: Vec<ConstDef> = const_entries
        .iter()
        .enumerate()
        .map(|(i, (c, at, dependency))| ConstDef {
            id: const_ids[i].clone(),
            name: c.name.clone(),
            description: c.description.clone().unwrap_or_default(),
            dependency: dependency.clone(),
            ty: ld.type_ref(&c.ty, &c.name, &with(at, path!["type"])),
            value: c.value.clone().unwrap_or(Value::Null),
        })
        .collect();

    let interfaces: Vec<Interface> = interface_entries
        .iter()
        .enumerate()
        .map(|(idx, (i, at, dependency))| Interface {
            id: interface_ids[idx].clone(),
            name: i.name.clone(),
            description: i.description.clone().unwrap_or_default(),
            dependency: dependency.clone(),
            messages: ld.messages(
                &i.messages,
                &i.name,
                prev_interfaces[idx].map_or(&[][..], |p| &p.messages[..]),
                &with(at, path!["messages"]),
            ),
        })
        .collect();

    let empty_layout = Record::new();
    let editor = f.editor.as_ref();
    let layout = editor.map_or(&empty_layout, |e| &e.layout);
    let mut modules: Vec<Module> = Vec::new();
    let mut module_by_path: HashMap<String, usize> = HashMap::new();
    let prev_paths = prev.map(project_module_paths).unwrap_or_default();
    let mut derived: Vec<Derived> = Vec::new();

    struct Ctx<'c> {
        f: &'c FileProject,
        prev: Option<&'c Project>,
        layout: &'c Record<FileRect>,
        binary_ids: &'c HashMap<String, Id>,
        prev_paths: &'c HashMap<Id, String>,
    }
    let ctx = Ctx {
        f: &f,
        prev,
        layout,
        binary_ids: &binary_ids,
        prev_paths: &prev_paths,
    };

    /// Adds modules and returns the extent (width, height) they occupy inside their parent.
    #[allow(clippy::too_many_arguments)]
    fn add_modules(
        ctx: &Ctx,
        ld: &mut Loader,
        modules: &mut Vec<Module>,
        module_by_path: &mut HashMap<String, usize>,
        derived: &mut Vec<Derived>,
        list: &[FileModule],
        parent_id: Option<&Id>,
        parent_path: &str,
        top: f64,
        at: &DataPath,
    ) -> Size {
        let mut seen = HashSet::new();
        // A kept module keeps its id: the children of the previous state have the same parent id.
        let siblings: Vec<&Module> = ctx
            .prev
            .map(|p| {
                p.modules
                    .iter()
                    .filter(|m| m.parent_id.as_ref() == parent_id)
                    .collect()
            })
            .unwrap_or_default();
        let sibling_names: Vec<String> = siblings.iter().map(|m| m.name.clone()).collect();
        let before: Vec<Option<&Module>> =
            pair(&sibling_names, &list.iter().map(|m| &m.name).collect::<Vec<_>>())
                .into_iter()
                .map(|i| i.map(|i| siblings[i]))
                .collect();
        let mut extent = Size::default();
        let (mut x, mut y, mut row_height) = (PAD, top + PAD, 0f64);
        for (i, fm) in list.iter().enumerate() {
            let path = if parent_path.is_empty() {
                fm.name.clone()
            } else {
                format!("{parent_path}.{}", fm.name)
            };
            if !seen.insert(fm.name.clone()) {
                ld.report(format!("Duplicate module '{path}'"), with(at, path![i, "name"]));
            }
            let at_i = with(at, path![i]);
            let was = before[i];
            let renamed = was.is_some_and(|w| ctx.prev_paths.get(&w.id) != Some(&path));
            let ports_was = pair_by(
                was.map_or(&[][..], |w| &w.ports[..]),
                |pt| pt.name.clone(),
                &fm.ports.iter().map(|pt| &pt.name).collect::<Vec<_>>(),
            );
            let height = leaf_height(port_rows(fm.ports.iter().map(|pt| pt.role)))
                + compartments_height(file_module_compartments(fm));
            let lock_was = pair_by(
                was.and_then(|w| w.locks.as_deref()).unwrap_or(&[]),
                |l| l.name.clone(),
                &fm.locks.iter().flatten().map(|l| &l.name).collect::<Vec<_>>(),
            );
            let locks: Option<Vec<Lock>> = fm.locks.as_ref().map(|ls| {
                ls.iter()
                    .enumerate()
                    .map(|(k, l)| Lock {
                        id: lock_was[k].map_or_else(new_id, |x| x.id.clone()),
                        name: l.name.clone(),
                        kind: l.kind,
                    })
                    .collect()
            });
            let implements = fm.implements.as_ref().filter(|v| !v.is_empty()).map(|v| {
                v.iter()
                    .enumerate()
                    .map(|(k, name)| {
                        if !ld.interface_names.contains(name) {
                            ld.report(
                                format!("Module '{path}': unknown interface '{name}'"),
                                with(&at_i, path!["implements", k]),
                            );
                        }
                        ld.type_ids
                            .get(name)
                            .cloned()
                            .unwrap_or_else(|| missing_ref(name))
                    })
                    .collect()
            });
            let constructors = fm.constructors.as_ref().map(|c| {
                ld.constructors(
                    c,
                    &path,
                    &fm.name,
                    was.and_then(|w| w.constructors.as_deref()).unwrap_or(&[]),
                    &with(&at_i, path!["constructors"]),
                )
            });
            let attributes = ld.attributes(
                fm.attributes.as_deref().unwrap_or(&[]),
                &path,
                was.map_or(&[][..], |w| &w.attributes[..]),
                &with(&at_i, path!["attributes"]),
                locks.as_deref().unwrap_or(&[]),
            );
            let methods = ld.methods(
                fm.methods.as_deref().unwrap_or(&[]),
                &path,
                was.map_or(&[][..], |w| &w.methods[..]),
                &with(&at_i, path!["methods"]),
            );
            let mut port_names = HashSet::new();
            let ports: Vec<Port> = fm
                .ports
                .iter()
                .enumerate()
                .map(|(j, pt)| {
                    if !port_names.insert(pt.name.clone()) {
                        ld.report(
                            format!("Duplicate port '{path}:{}'", pt.name),
                            with(&at_i, path!["ports", j, "name"]),
                        );
                    }
                    let interface_id = pt.interface.as_ref().map(|name| {
                        if ld.type_ids.contains_key(name) && !ld.interface_names.contains(name) {
                            ld.report(
                                format!("Port '{path}:{}': unknown interface '{name}'", pt.name),
                                with(&at_i, path!["ports", j, "interface"]),
                            );
                        }
                        ld.type_ids
                            .get(name)
                            .cloned()
                            .unwrap_or_else(|| missing_ref(name))
                    });
                    Port {
                        id: ports_was[j].map_or_else(new_id, |x| x.id.clone()),
                        name: pt.name.clone(),
                        role: pt.role,
                        interface_id,
                        description: pt.description.clone().unwrap_or_default(),
                        label: None,
                    }
                })
                .collect();
            let id = ld.id_of(was.map(|w| &w.id), || format!("module:{path}"));
            let mut m = Module {
                id: id.clone(),
                name: fm.name.clone(),
                description: fm.description.clone().unwrap_or_default(),
                parent_id: parent_id.cloned(),
                kind: fm.kind.filter(|k| *k != ModuleKind::Class),
                bases: None,
                base_args: None,
                implements,
                r#final: fm.is_final == Some(true),
                derives: fm.derives.clone().filter(|d| !d.is_empty()),
                constructors,
                copy: fm.copy,
                r#move: fm.is_move,
                destructor: fm.destructor.as_ref().map(|d| Destructor {
                    access: d.access.and_then(StoredAccess::stored),
                    r#virtual: d.is_virtual,
                }),
                instantiation: fm.instantiation,
                locks: locks.filter(|l| !l.is_empty()),
                active: match &fm.active {
                    Some(FileActive::Flag(true)) => Some(Active::default()),
                    Some(FileActive::Settings(s)) => Some(Active {
                        queue: s.queue,
                        timeout_ms: s.timeout_ms,
                        overflow: s.overflow,
                    }),
                    _ => None,
                },
                invariants: fm.invariants.clone().filter(|v| !v.is_empty()),
                state_machine: None,
                metadata: fm.metadata.clone().unwrap_or_default(),
                attributes,
                methods,
                ports,
                layout: Rect {
                    x: 0.,
                    y: 0.,
                    width: MODULE_WIDTH,
                    height,
                },
                color: None,
                binary_id: None,
                locked: false,
                base_routes: None,
            };
            if let Some(b) = &fm.binary {
                let binary_id = ctx.binary_ids.get(b);
                if parent_id.is_some() {
                    ld.report(
                        format!("Module '{path}': only top-level modules name their binary"),
                        with(&at_i, path!["binary"]),
                    );
                } else if let Some(bid) = binary_id {
                    m.binary_id = Some(bid.clone());
                } else {
                    ld.report(
                        format!("Module '{path}': unknown binary '{b}'"),
                        with(&at_i, path!["binary"]),
                    );
                }
            }
            if let Some(sm) = &fm.state_machine {
                let methods = m.methods.clone();
                m.state_machine = Some(ld.state_machine(
                    sm,
                    &path,
                    was.and_then(|w| w.state_machine.as_ref()),
                    &methods,
                    &with(&at_i, path!["stateMachine"]),
                ));
            }
            let index = modules.len();
            modules.push(m);
            module_by_path.insert(path.clone(), index);
            let style = ctx
                .f
                .editor
                .as_ref()
                .and_then(|e| e.style.as_ref())
                .and_then(|s| s.get(&path));
            if fm.bases.as_ref().is_some_and(|b| !b.is_empty()) {
                derived.push(Derived {
                    index,
                    path: path.clone(),
                    bases: fm.bases.clone().unwrap_or_default(),
                    at: with(&at_i, path!["bases"]),
                    shapes: style.map(|s| s.bases.clone().unwrap_or_default()),
                    prev_shapes: if renamed {
                        was.and_then(|w| w.base_routes.clone())
                    } else {
                        None
                    },
                });
            }

            let inner = add_modules(
                ctx,
                ld,
                modules,
                module_by_path,
                derived,
                fm.modules.as_deref().unwrap_or(&[]),
                Some(&id),
                &path,
                height,
                &with(&at_i, path!["modules"]),
            );
            let m = &mut modules[index];
            if let Some(c) = fm
                .color
                .clone()
                .or_else(|| style.and_then(|s| s.color.clone()))
                .filter(|c| !c.is_empty())
            {
                m.color = Some(c);
            }
            m.locked = match style {
                Some(s) => s.locked == Some(true),
                None => renamed && was.is_some_and(|w| w.locked),
            };
            for (j, pt) in m.ports.iter_mut().enumerate() {
                pt.label = match style {
                    Some(s) => s.labels.as_ref().and_then(|l| l.get(&pt.name).copied()),
                    None if renamed => ports_was[j].and_then(|x| x.label),
                    None => None,
                };
            }
            let saved = ctx.layout.get(&path).map(|r| Rect {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
            });
            if let Some(saved) = saved.or_else(|| was.map(|w| w.layout)) {
                m.layout = saved;
            } else {
                let r = &mut m.layout;
                r.width = r.width.max(inner.width + PAD);
                r.height = r.height.max(inner.height + PAD);
                if x > PAD && x + r.width > MAX_ROW {
                    x = PAD;
                    y += row_height + GAP_Y;
                    row_height = 0.;
                }
                r.x = x;
                r.y = y;
                x += r.width + GAP_X;
                row_height = row_height.max(r.height);
            }
            extent.width = extent.width.max(m.layout.x + m.layout.width);
            extent.height = extent.height.max(m.layout.y + m.layout.height);
        }
        extent
    }
    add_modules(
        &ctx,
        &mut ld,
        &mut modules,
        &mut module_by_path,
        &mut derived,
        &f.modules,
        None,
        "",
        0.,
        &path!["modules"],
    );

    // Types of modules: owned by the module at their path.
    for (i, x) in type_entries.iter().enumerate() {
        if let Some(mi) = x.module.as_ref().and_then(|m| module_by_path.get(m)) {
            types[i].module = Some(modules[*mi].id.clone());
        }
        let Some(tp) = &x.param else { continue };
        let derives_from = tp
            .derives_from
            .as_ref()
            .and_then(|d| module_by_path.get(d))
            .map(|mi| modules[*mi].id.clone());
        if let (Some(d), None) = (&tp.derives_from, &derives_from) {
            ld.report(
                format!("{}: unknown module '{d}'", x.key),
                with(&x.at, path!["derivesFrom"]),
            );
        }
        let default = tp
            .default
            .as_ref()
            .map(|d| ld.type_ref(d, &x.key, &with(&x.at, path!["default"])));
        types[i].body = TypeBody::Primitive {
            type_param: Some(TypeParam {
                constraint: tp.constraint,
                derives_from,
                default,
            }),
        };
    }
    // Type arguments of generic bases, read before modules used as types are resolved.
    let base_args: Vec<Vec<Option<Vec<TypeRef>>>> = derived
        .iter()
        .map(|d| {
            d.bases
                .iter()
                .enumerate()
                .map(|(j, b)| {
                    if !b.contains('<') {
                        return None;
                    }
                    match parse_type_expr(b) {
                        Ok(TypeRefOf::Ref { args, .. }) => Some(
                            args.unwrap_or_default()
                                .iter()
                                .map(|a| ld.type_ref(a, &format!("{} base", d.path), &with(&d.at, path![j])))
                                .collect(),
                        ),
                        Ok(_) => None,
                        Err(e) => {
                            ld.report(
                                format!("Module '{}': base '{b}': {e}", d.path),
                                with(&d.at, path![j]),
                            );
                            None
                        }
                    }
                })
                .collect()
        })
        .collect();

    // Placed modules of dependencies: on the right of the project's modules when they have no position.
    let mut import_y = PAD;
    let import_x = modules
        .iter()
        .filter(|m| m.parent_id.is_none())
        .map(|m| m.layout.x + m.layout.width)
        .fold(0f64, f64::max)
        + GAP_X * 2.;
    let mut dependencies: Vec<Dependency> = Vec::new();
    for (idx, i) in file_dependencies.iter().enumerate() {
        let mut paths = HashSet::new();
        let file_modules = i.modules.as_deref().unwrap_or(&[]);
        let before = pair_by(
            prev_dependencies[idx].map_or(&[][..], |d| &d.modules[..]),
            |m| m.path.clone(),
            &file_modules.iter().map(|m| &m.module).collect::<Vec<_>>(),
        );
        let mut placed = Vec::new();
        for (j, m) in file_modules.iter().enumerate() {
            let w = format!("Dependency '{}' module '{}'", i.name, m.module);
            if !paths.insert(m.module.clone()) {
                ld.report(
                    format!("{w}: listed more than once"),
                    path!["dependencies", idx, "modules", j, "module"],
                );
            }
            let was = before[j];
            let ports_was = pair_by(
                was.map_or(&[][..], |w| &w.ports[..]),
                |pt| pt.name.clone(),
                &m.ports.iter().map(|pt| &pt.name).collect::<Vec<_>>(),
            );
            let saved = editor
                .and_then(|e| e.dependencies.as_ref())
                .and_then(|d| d.get(&i.name))
                .and_then(|d| d.get(&m.module));
            let at = saved
                .map(|s| Point { x: s.x, y: s.y })
                .or_else(|| was.map(|w| w.position));
            let position = at.unwrap_or(Point {
                x: import_x,
                y: import_y,
            });
            if at.is_none() {
                let c = Compartments {
                    attributes: m.attributes.as_ref().map_or(0, Vec::len),
                    methods: m.methods.as_ref().map_or(0, Vec::len),
                    ..Default::default()
                };
                import_y +=
                    leaf_height(port_rows(m.ports.iter().map(|pt| pt.role))) + compartments_height(c) + GAP_Y;
            }
            let placed_path = format!("{}/{}", i.name, m.module);
            let data = path!["dependencies", idx, "modules", j];
            let attributes = ld.attributes(
                m.attributes.as_deref().unwrap_or(&[]),
                &placed_path,
                was.and_then(|w| w.attributes.as_deref()).unwrap_or(&[]),
                &with(&data, path!["attributes"]),
                &[],
            );
            let methods = ld.methods(
                m.methods.as_deref().unwrap_or(&[]),
                &placed_path,
                was.and_then(|w| w.methods.as_deref()).unwrap_or(&[]),
                &with(&data, path!["methods"]),
            );
            let size = match saved {
                Some(s) => match (s.width, s.height) {
                    (Some(width), Some(height)) => Some(Size { width, height }),
                    _ => None,
                },
                None => was.and_then(|w| w.size),
            };
            let mut port_names = HashSet::new();
            let ports = m
                .ports
                .iter()
                .enumerate()
                .map(|(k, pt)| {
                    if !port_names.insert(pt.name.clone()) {
                        ld.report(
                            format!("{w}: duplicate port '{}'", pt.name),
                            path!["dependencies", idx, "modules", j, "ports", k, "name"],
                        );
                    }
                    ImportedPort {
                        id: ports_was[k].map_or_else(new_id, |x| x.id.clone()),
                        name: pt.name.clone(),
                        role: pt.role,
                        interface: pt.interface.clone(),
                        description: pt.description.clone().unwrap_or_default(),
                        label: saved
                            .and_then(|s| s.labels.as_ref())
                            .and_then(|l| l.get(&pt.name).copied()),
                    }
                })
                .collect();
            placed.push(ImportedModule {
                id: ld.id_of(was.map(|w| &w.id), || {
                    format!("{IMPORTED_PREFIX}{}/{}", i.name, m.module)
                }),
                path: m.module.clone(),
                attributes: (!attributes.is_empty()).then_some(attributes),
                methods: (!methods.is_empty()).then_some(methods),
                r#final: m.is_final == Some(true),
                ports,
                position,
                size,
                locked: match saved {
                    Some(s) => s.locked == Some(true),
                    None => was.is_some_and(|w| w.locked),
                },
            });
        }
        dependencies.push(Dependency {
            id: dependency_ids[idx].clone(),
            name: i.name.clone(),
            file: i.file.clone(),
            uses: i.uses.clone().unwrap_or_default(),
            indirect: i.indirect.unwrap_or(false),
            shared: i.shared.clone().unwrap_or_default(),
            modules: placed,
        });
    }

    // Bases: modules of this project, or placed modules of dependencies (`Dependency/Module.Path`).
    for (k, d) in derived.iter().enumerate() {
        let mut bases = Vec::new();
        for (j, full) in d.bases.iter().enumerate() {
            let b = full.split_once('<').map_or(full.as_str(), |(h, _)| h);
            let base_id: Option<Id> = match b.split_once('/') {
                None => module_by_path.get(b).map(|i| modules[*i].id.clone()),
                Some((dep, rest)) => dependencies
                    .iter()
                    .find(|x| x.name == dep)
                    .and_then(|x| x.modules.iter().find(|m| m.path == rest))
                    .map(|m| m.id.clone()),
            };
            let Some(base_id) = base_id else {
                let msg = if b.contains('/') {
                    format!(
                        "Module '{}': base '{b}' is not a placed module of a dependency",
                        d.path
                    )
                } else {
                    format!("Module '{}': unknown base '{b}'", d.path)
                };
                ld.report(msg, with(&d.at, path![j]));
                continue;
            };
            let m = &mut modules[d.index];
            if let Some(args) = &base_args[k][j] {
                m.base_args
                    .get_or_insert_with(IndexMap::new)
                    .insert(base_id.clone(), args.clone());
            }
            let shape = match &d.shapes {
                Some(s) => s.get(b).map(|s| shape_route(s, false)),
                None => d.prev_shapes.as_ref().and_then(|s| s.get(&base_id)).cloned(),
            };
            if let Some(shape) = shape {
                m.base_routes
                    .get_or_insert_with(IndexMap::new)
                    .insert(base_id.clone(), shape);
            }
            bases.push(base_id);
        }
        modules[d.index].bases = (!bases.is_empty()).then_some(bases);
    }

    let endpoint = |ld: &mut Loader, e: &FileEndpoint, w: &str, at: DataPath| -> Endpoint {
        if let Some(project) = &e.project {
            let dep = dependencies.iter().find(|x| &x.name == project);
            let m = dep.and_then(|d| d.modules.iter().find(|m| m.path == e.module));
            let port = m.and_then(|m| m.ports.iter().find(|pt| pt.name == e.port));
            if dep.is_none() {
                ld.report(
                    format!("{w}: unknown dependency '{project}'"),
                    with(&at, path!["project"]),
                );
            } else if m.is_none() {
                ld.report(
                    format!(
                        "{w}: module '{}' is not placed from dependency '{project}'",
                        e.module
                    ),
                    with(&at, path!["module"]),
                );
            } else if port.is_none() {
                ld.report(
                    format!("{w}: unknown port '{project}/{}:{}'", e.module, e.port),
                    with(&at, path!["port"]),
                );
            }
            return Endpoint {
                module_id: m.map_or(String::new(), |m| m.id.clone()),
                port_id: port.map_or(String::new(), |p| p.id.clone()),
            };
        }
        let m = module_by_path.get(&e.module).map(|i| &modules[*i]);
        let port = m.and_then(|m| m.ports.iter().find(|pt| pt.name == e.port));
        if m.is_none() {
            ld.report(
                format!("{w}: unknown module '{}'", e.module),
                with(&at, path!["module"]),
            );
        } else if port.is_none() {
            ld.report(
                format!("{w}: unknown port '{}:{}'", e.module, e.port),
                with(&at, path!["port"]),
            );
        }
        Endpoint {
            module_id: m.map_or(String::new(), |m| m.id.clone()),
            port_id: port.map_or(String::new(), |p| p.id.clone()),
        }
    };
    let prev_links = pair_by(
        prev.map_or(&[][..], |p| &p.links[..]),
        |l| l.name.clone(),
        &f.links.iter().map(|l| &l.name).collect::<Vec<_>>(),
    );
    let links: Vec<Link> = f
        .links
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let was = prev_links[i];
            let route = editor
                .and_then(|e| e.links.as_ref())
                .and_then(|r| r.get(&l.name))
                .map(|s| shape_route(s, true))
                .or_else(|| was.filter(|w| w.name != l.name).and_then(|w| w.route.clone()));
            Link {
                id: was.map_or_else(new_id, |w| w.id.clone()),
                name: l.name.clone(),
                description: l.description.clone().unwrap_or_default(),
                from: endpoint(
                    &mut ld,
                    &l.from,
                    &format!("Link '{}' from", l.name),
                    path!["links", i, "from"],
                ),
                to: endpoint(
                    &mut ld,
                    &l.to,
                    &format!("Link '{}' to", l.name),
                    path!["links", i, "to"],
                ),
                constraints: l.constraints.clone(),
                color: l.color.clone().filter(|c| !c.is_empty()),
                route,
            }
        })
        .collect();

    // Modules used as types: of this project by path, of a dependency `Dep/Core.Sensor`.
    let dependency_by_name: HashMap<&str, &Id> = file_dependencies
        .iter()
        .zip(&dependency_ids)
        .map(|(x, id)| (x.name.as_str(), id))
        .collect();
    let resolved: Vec<Id> = ld
        .pending
        .iter()
        .map(|name| {
            if let Some(i) = module_by_path.get(name) {
                return modules[*i].id.clone();
            }
            let dep = name
                .find('/')
                .filter(|s| *s > 0)
                .and_then(|s| dependency_by_name.get(&name[..s]).map(|d| (d, s)));
            match dep {
                Some((d, s)) => dependency_module_ref(d, &name[s + 1..]),
                // Unknown ones are missing references, reported by validation.
                None => missing_ref(name),
            }
        })
        .collect();

    // Editor data is best effort: dangling module paths are dropped, not reported.
    // Paths of the previous state still find the modules renamed since.
    let module_ids: HashSet<Id> = modules.iter().map(|m| m.id.clone()).collect();
    let prev_ids: HashMap<&String, &Id> = prev_paths.iter().map(|(id, path)| (path, id)).collect();
    let module_at = |path: &str| -> Option<Id> {
        let id = module_by_path
            .get(path)
            .map(|i| modules[*i].id.clone())
            .or_else(|| prev_ids.get(&path.to_string()).map(|s| s.to_string()))?;
        module_ids.contains(&id).then_some(id)
    };
    // Placed modules of dependencies too ('Dependency/Module'), for modules outside a view.
    let imported_by_path: HashMap<String, &ImportedModule> = dependencies
        .iter()
        .flat_map(|x| {
            x.modules
                .iter()
                .map(move |m| (format!("{}/{}", x.name, m.path), m))
        })
        .collect();
    let any_module_at =
        |path: &str| module_at(path).or_else(|| imported_by_path.get(path).map(|m| m.id.clone()));
    let file_views = editor.and_then(|e| e.views.clone()).unwrap_or_default();
    let prev_views = pair_by(
        prev.map_or(&[][..], |p| &p.views[..]),
        |v| v.name.clone(),
        &file_views.iter().map(|v| &v.name).collect::<Vec<_>>(),
    );
    let link_by_name: HashMap<&str, &Link> = links.iter().map(|l| (l.name.as_str(), l)).collect();
    // Notes of a file entry, keeping the ids of `before` (by index).
    let read_notes = |entries: &[FileNote], before: Vec<&Note>, view_id: Option<&Id>| -> Vec<Note> {
        entries
            .iter()
            .enumerate()
            .map(|(i, n)| Note {
                id: before.get(i).map_or_else(new_id, |x| x.id.clone()),
                kind: n.kind,
                text: n.text.clone(),
                layout: Rect {
                    x: n.x,
                    y: n.y,
                    width: n.width,
                    height: n.height,
                },
                color: n.color.clone().filter(|c| !c.is_empty()),
                locked: n.locked == Some(true),
                view_id: view_id.cloned(),
            })
            .collect()
    };
    let prev_notes = prev.map_or(&[][..], |p| &p.notes[..]);
    let mut view_note_list: Vec<Note> = Vec::new();
    let mut views: Vec<View> = Vec::new();
    for (i, v) in file_views.iter().enumerate() {
        let was = prev_views[i];
        let root = v.root.as_deref().and_then(module_at);
        if v.root.is_some() && root.is_none() {
            continue;
        }
        let hidden: Vec<Id> = v
            .hidden
            .iter()
            .flatten()
            .filter_map(|h| any_module_at(h))
            .collect();
        let layouts: IndexMap<Id, Rect> = v
            .layout
            .iter()
            .flatten()
            .filter_map(|(path, r)| {
                module_at(path).map(|id| {
                    (
                        id,
                        Rect {
                            x: r.x,
                            y: r.y,
                            width: r.width,
                            height: r.height,
                        },
                    )
                })
            })
            .collect();
        let id = ld.id_of(was.map(|w| &w.id), || format!("view:{i}"));
        let mut view = View {
            id: id.clone(),
            name: v.name.clone(),
            hidden,
            ..global_view()
        };
        let Some(root) = root else {
            views.push(view);
            continue;
        };
        let routes: IndexMap<Id, LinkRoute> = v
            .links
            .iter()
            .flatten()
            .filter_map(|(name, r)| {
                link_by_name
                    .get(name.as_str())
                    .map(|l| (l.id.clone(), shape_route(r, true)))
            })
            .collect();
        let mut labels: IndexMap<Id, Side> = IndexMap::new();
        for (path, sides) in v.labels.iter().flatten() {
            let ports: Option<Vec<(&String, &Id)>> = module_at(path)
                .and_then(|id| modules.iter().find(|m| m.id == id))
                .map(|m| m.ports.iter().map(|pt| (&pt.name, &pt.id)).collect())
                .or_else(|| {
                    imported_by_path
                        .get(path)
                        .map(|m| m.ports.iter().map(|pt| (&pt.name, &pt.id)).collect())
                });
            for (name, side) in sides {
                if let Some((_, pid)) = ports.iter().flatten().find(|(n, _)| *n == name) {
                    labels.insert((*pid).clone(), *side);
                }
            }
        }
        let stand_ins: IndexMap<Id, StandIn> = v
            .outside
            .iter()
            .flatten()
            .filter_map(|(path, at)| {
                any_module_at(path).map(|id| {
                    (
                        id,
                        StandIn {
                            x: at.x,
                            y: at.y,
                            width: at.width,
                            height: at.height,
                        },
                    )
                })
            })
            .collect();
        view_note_list.extend(read_notes(
            v.notes.as_deref().unwrap_or(&[]),
            prev_notes
                .iter()
                .filter(|n| n.view_id.as_ref() == Some(&id))
                .collect(),
            Some(&id),
        ));
        view.root_module_id = Some(root);
        view.layouts = (!layouts.is_empty()).then_some(layouts);
        view.routes = (!routes.is_empty()).then_some(routes);
        view.port_labels = (!labels.is_empty()).then_some(labels);
        view.stand_ins = (!stand_ins.is_empty()).then_some(stand_ins);
        views.push(view);
    }
    let mut notes = read_notes(
        editor.and_then(|e| e.notes.as_deref()).unwrap_or(&[]),
        prev_notes.iter().filter(|n| n.view_id.is_none()).collect(),
        None,
    );
    notes.extend(view_note_list);

    if !ld.problems.is_empty() {
        return Err(LoadError { issues: ld.problems });
    }
    let mut project = Project {
        name: f.project.name.clone(),
        description: f.project.description.clone().unwrap_or_default(),
        metadata: f.project.metadata.clone().unwrap_or_default(),
        transports: f.transports.clone().unwrap_or_default(),
        remote_defaults: f.remote_defaults.clone(),
        binaries,
        types,
        interfaces,
        consts,
        modules,
        links,
        dependencies,
        views,
        notes,
        orientation: editor.and_then(|e| e.orientation).unwrap_or_default(),
    };
    for_each_any_type_ref_mut(&mut project, &mut |t| {
        crate::project::for_each_ref_id_mut(t, &mut |id| {
            if let Some(n) = id.strip_prefix(PENDING).and_then(|n| n.parse::<usize>().ok()) {
                *id = resolved[n].clone();
            }
        })
    });
    Ok(project)
}

// Text

pub fn stringify(file: &Value, format: Format) -> String {
    match format {
        Format::Json => to_json(file),
        Format::Yaml => to_yaml(file),
    }
}

/// File data of a text; integers too large for a JavaScript number are kept as decimal text.
pub fn parse_text(text: &str, format: Format) -> Result<Value, LoadError> {
    let name = match format {
        Format::Json => "JSON",
        Format::Yaml => "YAML",
    };
    let fail = |message: String, line: Option<usize>| LoadError {
        issues: vec![LoadIssue {
            message: format!("Invalid {name}: {message}"),
            path: None,
            line,
        }],
    };
    match format {
        Format::Json => {
            // Checked as JSON, read as YAML (which keeps big integers as text).
            if let Err(e) = serde_json::from_str::<serde::de::IgnoredAny>(text) {
                return Err(fail(e.to_string(), Some(e.line())));
            }
            crate::yamlread::parse_yaml(text).map_err(|e| fail(e.message, e.line))
        }
        Format::Yaml => crate::yamlread::parse_yaml(text).map_err(|e| fail(e.message, e.line)),
    }
}

/// Line (from 1) of a path in the file data: the key of the deepest entry of the path found in the text.
pub fn line_of_path(text: &str, path: &[PathKey]) -> Option<usize> {
    let root = parse_nodes(text).ok()?;
    line_in(&root, path)
}

pub fn line_in(root: &Node, path: &[PathKey]) -> Option<usize> {
    let mut node = root;
    let mut at = node.line();
    for key in path {
        let (next, offset) = match (node, key) {
            (Node::Map { entries, .. }, PathKey::Key(k)) => match entries.iter().find(|(e, _, _)| e == k) {
                Some((_, line, v)) => (v, *line),
                None => break,
            },
            (Node::Seq { items, .. }, PathKey::Index(i)) => match items.get(*i) {
                Some(v) => (v, v.line()),
                None => break,
            },
            _ => break,
        };
        at = offset;
        node = next;
    }
    Some(at)
}

/// A load error whose problems are located in the text they come from.
fn located(text: &str, e: LoadError) -> LoadError {
    if !e.issues.iter().any(|i| i.path.is_some() && i.line.is_none()) {
        return e;
    }
    let root = parse_nodes(text).ok();
    LoadError {
        issues: e
            .issues
            .into_iter()
            .map(|mut i| {
                if let (Some(p), None, Some(r)) = (&i.path, i.line, &root) {
                    i.line = line_in(r, p);
                }
                i
            })
            .collect(),
    }
}

pub fn load_text(text: &str, format: Format) -> Result<Project, LoadError> {
    let data = parse_text(text, format)?;
    from_file(&data, None).map_err(|e| located(text, e))
}

pub fn save_text(p: &Project, format: Format, editor: bool) -> String {
    stringify(&to_file(p, editor), format)
}

/// New version of `prev` read from text: entities keep their ids, and the editor data of `prev`
/// stands in when the text has none.
pub fn reload_text(text: &str, format: Format, prev: &Project) -> Result<Project, LoadError> {
    let mut data = parse_text(text, format)?;
    if let Value::Object(o) = &mut data {
        if !o.contains_key("editor") {
            if let Some(e) = to_file(prev, true).get("editor") {
                o.insert("editor".into(), e.clone());
            }
        }
    }
    from_file(&data, Some(prev)).map_err(|e| located(text, e))
}

/// Whether two projects are saved the same (a reload that changes nothing).
pub fn same_content(a: &Project, b: &Project) -> bool {
    std::ptr::eq(a, b) || save_text(a, Format::Json, true) == save_text(b, Format::Json, true)
}
