//! Constraints of fields and attributes (bounds, unit, pattern) and the ownership of the modules
//! they reference: checked against their type and their default value. Port of `constraints.ts`.

use serde_json::Value;

use crate::defaults::{Resolved, no_modules, resolve, types_by_id};
use crate::typeexpr::walk_type_ref;
use crate::types::*;

/// What constraints apply to in a type: its value, or each item of a container, aliases followed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scalar {
    Primitive(Primitive),
    Enum,
    Bitmask,
    Other,
}

pub fn constrained_scalar(t: &TypeRef, types: &[TypeDef]) -> Scalar {
    let by_id = types_by_id(types);
    let mut cur = t;
    loop {
        match resolve(cur, &by_id, &no_modules) {
            None => return Scalar::Other,
            Some(Resolved::Def(d)) => {
                return match d.body {
                    TypeBody::Enum { .. } => Scalar::Enum,
                    TypeBody::Bitmask { .. } => Scalar::Bitmask,
                    _ => Scalar::Other,
                };
            }
            Some(Resolved::Ref(r)) => match r {
                TypeRefOf::Primitive { name, .. } => return Scalar::Primitive(*name),
                _ => match r.item() {
                    Some(of) => cur = of,
                    None => return Scalar::Other,
                },
            },
        }
    }
}

fn is_number(s: Scalar) -> bool {
    matches!(s, Scalar::Primitive(p) if p.int().is_some() || matches!(p, Primitive::Float32 | Primitive::Float64))
}

fn is_text(s: Scalar) -> bool {
    matches!(s, Scalar::Primitive(Primitive::String | Primitive::Char))
}

/// Whether a pattern compiles: the reason when not.
pub fn pattern_error(pattern: &str) -> Option<String> {
    fancy_regex::Regex::new(pattern).err().map(|e| e.to_string())
}

fn fmt_num(n: f64) -> String {
    crate::emit::js_number(&serde_json::Number::from_f64(n).unwrap_or(0.into()))
}

/// Errors of constraints set on a field of type `t`.
pub fn constraint_errors(c: &Constraints, t: &TypeRef, types: &[TypeDef]) -> Vec<String> {
    let mut errors = Vec::new();
    let scalar = constrained_scalar(t, types);
    let bounds: Vec<(&str, f64)> = [("min", c.min), ("max", c.max)]
        .into_iter()
        .filter_map(|(k, v)| v.map(|v| (k, v)))
        .collect();
    if (!bounds.is_empty() || c.unit.is_some()) && !is_number(scalar) {
        errors.push("min, max and unit apply to numbers".into());
    } else if let Scalar::Primitive(p) = scalar {
        if let Some(int) = p.int() {
            let (lo, hi) = int.range();
            for (k, v) in &bounds {
                if v.fract() != 0. {
                    errors.push(format!("{k} of an integer is an integer"));
                } else if (*v as i128) < lo || (*v as i128) > hi {
                    errors.push(format!("{k} {} is out of the range of {p}", fmt_num(*v)));
                }
            }
        }
    }
    if let (Some(min), Some(max)) = (c.min, c.max) {
        if min > max {
            errors.push(format!("min {} is above max {}", fmt_num(min), fmt_num(max)));
        }
    }
    if let Some(p) = &c.pattern {
        if !is_text(scalar) {
            errors.push("pattern applies to text".into());
        } else if let Some(e) = pattern_error(p) {
            errors.push(format!("invalid pattern: {e}"));
        }
    }
    errors
}

/// Errors of a value (a default) against constraints.
pub fn constraint_value_errors(v: &Value, c: &Constraints) -> Vec<String> {
    let mut errors = Vec::new();
    let pattern = c
        .pattern
        .as_ref()
        .filter(|p| pattern_error(p).is_none())
        .and_then(|p| fancy_regex::Regex::new(&format!("^(?:{p})$")).ok());
    let unit = c.unit.as_ref().map(|u| format!(" {u}")).unwrap_or_default();
    fn walk(x: &Value, f: &mut dyn FnMut(&Value)) {
        match x {
            Value::Array(a) => a.iter().for_each(|e| walk(e, f)),
            _ => f(x),
        }
    }
    walk(v, &mut |x| {
        let n = match x {
            Value::Number(n) => n.as_f64(),
            Value::String(s)
                if s.strip_prefix('-')
                    .unwrap_or(s)
                    .chars()
                    .all(|c| c.is_ascii_digit())
                    && !s.is_empty()
                    && s != "-" =>
            {
                s.parse::<f64>().ok()
            }
            _ => None,
        };
        if let Some(n) = n {
            if let Some(min) = c.min.filter(|m| n < *m) {
                errors.push(format!(
                    "{}{unit} is below min {}{unit}",
                    fmt_num(n),
                    fmt_num(min)
                ));
            }
            if let Some(max) = c.max.filter(|m| n > *m) {
                errors.push(format!(
                    "{}{unit} is above max {}{unit}",
                    fmt_num(n),
                    fmt_num(max)
                ));
            }
        }
        if let (Value::String(s), Some(p)) = (x, &pattern) {
            if !p.is_match(s).unwrap_or(true) {
                errors.push(format!(
                    "'{s}' does not match {}",
                    c.pattern.as_deref().unwrap_or("")
                ));
            }
        }
    });
    errors
}

/// Modules a type references (as types), by id.
pub fn module_refs(t: &TypeRef, is_module: &dyn Fn(&str) -> bool) -> Vec<Id> {
    let mut out: Vec<Id> = Vec::new();
    walk_type_ref(t, &mut |n| {
        if let TypeRefOf::Ref { target, .. } = n {
            if is_module(&target.id) && !out.contains(&target.id) {
                out.push(target.id.clone());
            }
        }
    });
    out
}

/// UML multiplicity of the modules a type references: `1`, `0..1` (optional), `*` (containers).
pub fn multiplicity(t: &TypeRef) -> String {
    match t {
        TypeRefOf::Optional { of } => {
            if matches!(**of, TypeRefOf::Ref { .. }) {
                "0..1".into()
            } else {
                multiplicity(of)
            }
        }
        TypeRefOf::Array { size, .. } => size.to_string(),
        TypeRefOf::Vector { .. } | TypeRefOf::List { .. } | TypeRefOf::Set { .. } | TypeRefOf::Map { .. } => {
            "*".into()
        }
        _ => "1".into(),
    }
}
