//! Default values of struct fields and module attributes: YAML values checked against their type.
//! Port of `defaults.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::emit::to_yaml_flow;
use crate::types::*;

static INT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([-+]?)(0x[0-9a-f]+|\d+)$").expect("regex"));
static FLOAT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$").expect("regex"));

/// Default value written as a one-line YAML flow literal: `{ x: 1, y: [ 2, 3 ] }`.
pub fn format_value(v: &Value) -> String {
    to_yaml_flow(v)
}

/// Reads a YAML flow literal; integers too large for a number are kept as decimal text.
pub fn parse_value(text: &str) -> Result<Value, String> {
    crate::yamlread::parse_yaml(text).map_err(|e| e.message)
}

fn describe(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Array(_) => "a list".into(),
        Value::Object(_) => "a mapping".into(),
        Value::String(_) => format!("text {}", format_value(v)),
        Value::Number(_) => format!("number {}", format_value(v)),
        Value::Bool(_) => format!("boolean {}", format_value(v)),
    }
}

fn to_big_int(v: &Value) -> Option<i128> {
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(i as i128)
            } else if let Some(u) = n.as_u64() {
                Some(u as i128)
            } else {
                let f = n.as_f64()?;
                (f.fract() == 0. && f.is_finite()).then_some(f as i128)
            }
        }
        Value::String(s) => {
            let c = INT_RE.captures(s)?;
            let digits = &c[2];
            let n = if digits.len() > 2 && digits[..2].eq_ignore_ascii_case("0x") {
                i128::from_str_radix(&digits[2..], 16).ok()?
            } else {
                digits.parse::<i128>().ok()?
            };
            Some(if &c[1] == "-" { -n } else { n })
        }
        _ => None,
    }
}

fn primitive_error(v: &Value, name: Primitive) -> Option<String> {
    match name {
        Primitive::Bool => (!v.is_boolean()).then(|| format!("Expected true or false, got {}", describe(v))),
        Primitive::Float32 | Primitive::Float64 => {
            (!v.is_number()).then(|| format!("Expected a number, got {}", describe(v)))
        }
        Primitive::Char => match v {
            Value::String(s) if s.chars().count() == 1 => None,
            _ => Some(format!("Expected one character, got {}", describe(v))),
        },
        Primitive::String | Primitive::Bytes => match v {
            Value::String(_) => None,
            Value::Null | Value::Array(_) | Value::Object(_) => {
                Some(format!("Expected text, got {}", describe(v)))
            }
            _ => Some(format!(
                "Expected text, got {} (quote it: \"{}\")",
                describe(v),
                format_value(v)
            )),
        },
        _ => {
            let Some(n) = to_big_int(v) else {
                return Some(format!("Expected an integer, got {}", describe(v)));
            };
            let int = name.int().expect("integer primitive");
            let (min, max) = int.range();
            (n < min || n > max).then(|| format!("{n} does not fit in {name}"))
        }
    }
}

/// A resolved type: a type reference that is no user type (primitive, container, module), or a definition.
#[derive(Clone, Copy, Debug)]
pub enum Resolved<'a> {
    Ref(&'a TypeRef),
    Def(&'a TypeDef),
}

pub type Types<'a> = HashMap<&'a str, &'a TypeDef>;

pub fn types_by_id(types: &[TypeDef]) -> Types<'_> {
    types.iter().map(|t| (t.id.as_str(), t)).collect()
}

/// Follows aliases; the reference itself for a module, None for a deleted type or a cyclic alias.
pub fn resolve<'a>(
    t: &'a TypeRef,
    types: &Types<'a>,
    is_module: &dyn Fn(&str) -> bool,
) -> Option<Resolved<'a>> {
    let mut seen = HashSet::new();
    let mut cur = t;
    loop {
        let TypeRefOf::Ref { target, .. } = cur else {
            return Some(Resolved::Ref(cur));
        };
        let Some(def) = types.get(target.id.as_str()).copied() else {
            return is_module(&target.id).then_some(Resolved::Ref(cur));
        };
        if !seen.insert(def.id.as_str()) {
            return None;
        }
        match &def.body {
            TypeBody::Alias { ty } => cur = ty,
            _ => return Some(Resolved::Def(def)),
        }
    }
}

pub fn no_modules(_: &str) -> bool {
    false
}

/// Whether a struct field of type `t` may be left out of a value.
fn implicit(
    t: &TypeRef,
    types: &Types,
    is_module: &dyn Fn(&str) -> bool,
    seen: &mut HashSet<String>,
) -> bool {
    match resolve(t, types, is_module) {
        Some(Resolved::Ref(TypeRefOf::Optional { .. } | TypeRefOf::Ref { .. })) => true,
        Some(Resolved::Def(d)) => {
            let TypeBody::Struct { fields, .. } = &d.body else {
                return false;
            };
            if !seen.insert(d.id.clone()) {
                return false;
            }
            fields
                .iter()
                .all(|f| f.default.is_some() || implicit(&f.ty, types, is_module, seen))
        }
        _ => false,
    }
}

/// Whether values of `t` are module references: no value.
pub fn is_module_value(t: &TypeRef, types: &[TypeDef], is_module: &dyn Fn(&str) -> bool) -> bool {
    matches!(
        resolve(t, &types_by_id(types), is_module),
        Some(Resolved::Ref(TypeRefOf::Ref { .. }))
    )
}

/// Values offered as a choice (bool, enum, and null for optional), or None for a free literal.
pub fn value_choices(t: &TypeRef, types: &[TypeDef]) -> Option<Vec<Value>> {
    let by_id = types_by_id(types);
    let mut r = resolve(t, &by_id, &no_modules);
    let optional = matches!(r, Some(Resolved::Ref(TypeRefOf::Optional { .. })));
    if let Some(Resolved::Ref(TypeRefOf::Optional { of })) = r {
        r = resolve(of, &by_id, &no_modules);
    }
    let mut list: Vec<Value> = match r {
        Some(Resolved::Ref(TypeRefOf::Primitive {
            name: Primitive::Bool,
            ..
        })) => vec![true.into(), false.into()],
        Some(Resolved::Def(TypeDef {
            body: TypeBody::Enum { values, .. },
            ..
        })) => values.iter().map(|v| v.name.clone().into()).collect(),
        _ => return None,
    };
    if optional {
        list.push(Value::Null);
    }
    Some(list)
}

/// Flag names of a bitmask type (its values are lists of them), else None.
pub fn value_flags(t: &TypeRef, types: &[TypeDef]) -> Option<Vec<String>> {
    match resolve(t, &types_by_id(types), &no_modules) {
        Some(Resolved::Def(TypeDef {
            body: TypeBody::Bitmask { flags, .. },
            ..
        })) => Some(flags.iter().map(|f| f.name.clone()).collect()),
        _ => None,
    }
}

/// Value showing the shape of a type, for a placeholder.
pub fn value_example(t: &TypeRef, types: &[TypeDef]) -> Value {
    let by_id = types_by_id(types);
    fn example(t: &TypeRef, by_id: &Types, seen: &HashSet<String>) -> Value {
        match t {
            TypeRefOf::Primitive { name, .. } => match name {
                Primitive::Bool => false.into(),
                Primitive::Char => "a".into(),
                Primitive::String | Primitive::Bytes => "".into(),
                _ => 0.into(),
            },
            TypeRefOf::Optional { .. } => Value::Null,
            TypeRefOf::Array { of, size } => {
                Value::Array((0..(*size).min(4)).map(|_| example(of, by_id, seen)).collect())
            }
            TypeRefOf::Vector { .. } | TypeRefOf::List { .. } | TypeRefOf::Set { .. } => Value::Array(vec![]),
            TypeRefOf::Map { .. } => Value::Object(Map::new()),
            TypeRefOf::Ref { target, .. } => {
                let Some(def) = by_id.get(target.id.as_str()) else {
                    return Value::Null;
                };
                if seen.contains(&def.id) {
                    return Value::Null;
                }
                let mut inner = seen.clone();
                inner.insert(def.id.clone());
                match &def.body {
                    TypeBody::Primitive { .. } => def.name.clone().into(),
                    TypeBody::Alias { ty } => example(ty, by_id, &inner),
                    TypeBody::Enum { values, .. } => {
                        values.first().map_or(Value::Null, |v| v.name.clone().into())
                    }
                    TypeBody::Bitmask { flags, .. } => {
                        Value::Array(flags.first().map(|f| f.name.clone().into()).into_iter().collect())
                    }
                    TypeBody::Union { cases, .. } => cases.first().map_or(Value::Null, |c| {
                        let mut m = Map::new();
                        m.insert(c.name.clone(), example(&c.ty, by_id, &inner));
                        Value::Object(m)
                    }),
                    TypeBody::Struct { fields, .. } | TypeBody::Exception { fields } => Value::Object(
                        fields
                            .iter()
                            .map(|f| {
                                (
                                    f.name.clone(),
                                    f.default.clone().unwrap_or_else(|| example(&f.ty, by_id, &inner)),
                                )
                            })
                            .collect(),
                    ),
                }
            }
        }
    }
    example(t, &by_id, &HashSet::new())
}

/// Problems of `v` as a value of type `t`, each prefixed with where it is in the value.
pub fn value_errors(
    v: &Value,
    t: &TypeRef,
    types: &[TypeDef],
    is_module: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let by_id = types_by_id(types);
    let mut errors = Vec::new();
    check(v, t, "", &HashSet::new(), &by_id, is_module, &mut errors);
    errors
}

fn at(errors: &mut Vec<String>, path: &str, message: String) {
    errors.push(if path.is_empty() {
        message
    } else {
        format!("{path}: {message}")
    })
}

/// Map keys are text in YAML: read them as the key type.
fn key_value(k: &str, t: &TypeRef, by_id: &Types, is_module: &dyn Fn(&str) -> bool) -> Value {
    match resolve(t, by_id, is_module) {
        Some(Resolved::Ref(TypeRefOf::Primitive {
            name: Primitive::Bool,
            ..
        })) => match k {
            "true" => true.into(),
            "false" => false.into(),
            _ => k.into(),
        },
        Some(Resolved::Ref(TypeRefOf::Primitive {
            name: Primitive::Float32 | Primitive::Float64,
            ..
        })) if FLOAT_RE.is_match(k) => k.parse::<f64>().ok().map_or(k.into(), crate::emit::num),
        _ => k.into(),
    }
}

fn check(
    v: &Value,
    t: &TypeRef,
    path: &str,
    seen: &HashSet<String>,
    by_id: &Types,
    is_module: &dyn Fn(&str) -> bool,
    errors: &mut Vec<String>,
) {
    match t {
        TypeRefOf::Primitive { name, max } => {
            if let Some(e) = primitive_error(v, *name) {
                at(errors, path, e);
            } else if let (Some(max), Value::String(s)) = (max, v) {
                // Bytes: one per character, as generators write them.
                let size = if *name == Primitive::Bytes {
                    s.chars().count()
                } else {
                    s.len()
                } as u64;
                if size > *max {
                    at(
                        errors,
                        path,
                        format!("{size} bytes, more than the bound of {max}"),
                    );
                }
            }
        }
        TypeRefOf::Optional { of } => {
            if !v.is_null() {
                check(v, of, path, seen, by_id, is_module, errors)
            }
        }
        TypeRefOf::Array { of, .. }
        | TypeRefOf::Vector { of, .. }
        | TypeRefOf::List { of, .. }
        | TypeRefOf::Set { of, .. } => {
            let Value::Array(a) = v else {
                return at(errors, path, format!("Expected a list, got {}", describe(v)));
            };
            if let TypeRefOf::Array { size, .. } = t {
                if a.len() as u64 != *size {
                    at(errors, path, format!("Expected {size} elements, got {}", a.len()));
                }
            } else if let Some(max) = t.max() {
                if a.len() as u64 > max {
                    at(
                        errors,
                        path,
                        format!("{} elements, more than the bound of {max}", a.len()),
                    );
                }
            }
            for (i, e) in a.iter().enumerate() {
                check(e, of, &format!("{path}[{i}]"), seen, by_id, is_module, errors);
            }
            if matches!(t, TypeRefOf::Set { .. }) {
                let texts: Vec<String> = a.iter().map(format_value).collect();
                for (i, s) in texts.iter().enumerate() {
                    if texts.iter().position(|x| x == s) < Some(i) {
                        at(errors, path, format!("Duplicate element {s}"));
                    }
                }
            }
        }
        TypeRefOf::Map { key, value, max } => {
            let Value::Object(o) = v else {
                return at(errors, path, format!("Expected a mapping, got {}", describe(v)));
            };
            if let Some(max) = max {
                if o.len() as u64 > *max {
                    at(
                        errors,
                        path,
                        format!("{} entries, more than the bound of {max}", o.len()),
                    );
                }
            }
            for (k, e) in o {
                let p = format!("{path}[{k}]");
                check(
                    &key_value(k, key, by_id, is_module),
                    key,
                    &p,
                    seen,
                    by_id,
                    is_module,
                    errors,
                );
                check(e, value, &p, seen, by_id, is_module, errors);
            }
        }
        TypeRefOf::Ref { target, .. } => {
            let def = by_id.get(target.id.as_str()).copied();
            if def.is_none() && is_module(&target.id) {
                if !v.is_null() {
                    at(
                        errors,
                        path,
                        format!(
                            "Expected null (a module reference has no value), got {}",
                            describe(v)
                        ),
                    );
                }
                return;
            }
            // Deleted types are reported on their own.
            let Some(def) = def else { return };
            match &def.body {
                TypeBody::Primitive { .. } => {}
                TypeBody::Alias { ty } => {
                    if !seen.contains(&def.id) {
                        let mut s = seen.clone();
                        s.insert(def.id.clone());
                        check(v, ty, path, &s, by_id, is_module, errors);
                    }
                }
                TypeBody::Enum { values, .. } => {
                    if !matches!(v, Value::String(s) if values.iter().any(|x| &x.name == s)) {
                        let names: Vec<&str> = values.iter().map(|x| x.name.as_str()).collect();
                        at(
                            errors,
                            path,
                            format!(
                                "Expected a value of {} ({}), got {}",
                                def.name,
                                names.join(", "),
                                describe(v)
                            ),
                        );
                    }
                }
                TypeBody::Bitmask { flags, .. } => {
                    let names: Vec<&str> = flags.iter().map(|x| x.name.as_str()).collect();
                    let Value::Array(a) = v else {
                        return at(
                            errors,
                            path,
                            format!("Expected a list of {} flags, got {}", def.name, describe(v)),
                        );
                    };
                    for (i, e) in a.iter().enumerate() {
                        match e {
                            Value::String(s) if names.contains(&s.as_str()) => {
                                if a.iter().position(|x| x == e) < Some(i) {
                                    at(errors, path, format!("Duplicate flag {s}"));
                                }
                            }
                            _ => at(
                                errors,
                                &format!("{path}[{i}]"),
                                format!(
                                    "Expected a flag of {} ({}), got {}",
                                    def.name,
                                    names.join(", "),
                                    describe(e)
                                ),
                            ),
                        }
                    }
                }
                TypeBody::Union { cases, .. } => {
                    let entries: Vec<(&String, &Value)> = match v {
                        Value::Object(o) => o.iter().collect(),
                        _ => vec![],
                    };
                    if entries.len() != 1 {
                        return at(
                            errors,
                            path,
                            format!(
                                "Expected a mapping of one {} case (case: value), got {}",
                                def.name,
                                describe(v)
                            ),
                        );
                    }
                    let (name, e) = entries[0];
                    let Some(c) = cases.iter().find(|x| &x.name == name) else {
                        return at(errors, path, format!("Unknown case '{name}' of {}", def.name));
                    };
                    let p = if path.is_empty() {
                        name.clone()
                    } else {
                        format!("{path}.{name}")
                    };
                    check(e, &c.ty, &p, seen, by_id, is_module, errors);
                }
                TypeBody::Struct { fields, .. } | TypeBody::Exception { fields } => {
                    let Value::Object(o) = v else {
                        return at(
                            errors,
                            path,
                            format!("Expected a mapping of {} fields, got {}", def.name, describe(v)),
                        );
                    };
                    for k in o.keys() {
                        if !fields.iter().any(|f| &f.name == k) {
                            at(errors, path, format!("Unknown field '{k}' of {}", def.name));
                        }
                    }
                    for f in fields {
                        match o.get(&f.name) {
                            Some(e) => {
                                let p = if path.is_empty() {
                                    f.name.clone()
                                } else {
                                    format!("{path}.{}", f.name)
                                };
                                check(e, &f.ty, &p, seen, by_id, is_module, errors);
                            }
                            None => {
                                if f.default.is_none()
                                    && !implicit(&f.ty, by_id, is_module, &mut HashSet::new())
                                {
                                    at(
                                        errors,
                                        path,
                                        format!("Missing field '{}' of {}", f.name, def.name),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
