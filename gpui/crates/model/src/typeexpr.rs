//! Textual type expressions, e.g. `map<string, vector<uint16>>`, `array<Vec3, 4>`; bounds:
//! `string<16>`, `bytes<16>`, `vector<T, 8>` (also list and set), `map<K, V, 8>`. Types of modules:
//! `Core.Sensor.Mode`, of a module of a dependency: `Dep/Core.Sensor.Mode`. Generic modules take
//! type arguments: `Box<int32>`. Port of `typeExpr.ts`.

use crate::schema::{FileTypeRef, NameRef};
use crate::types::{CONTAINERS, IdRef, Primitive, TypeRef, TypeRefOf};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct TypeExprError(pub String);

fn err<T>(msg: impl Into<String>) -> Result<T, TypeExprError> {
    Err(TypeExprError(msg.into()))
}

pub fn is_reserved_type_name(name: &str) -> bool {
    Primitive::parse(name).is_some() || CONTAINERS.contains(&name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokKind {
    Ident,
    Int,
    Punct,
}

#[derive(Debug, Clone)]
struct Token<'a> {
    kind: TokKind,
    text: &'a str,
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}
fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// Length of `[A-Za-z_]\w*` at `i`, 0 if none.
fn word(b: &[u8], i: usize) -> usize {
    if i < b.len() && is_ident_start(b[i]) {
        let mut j = i + 1;
        while j < b.len() && is_ident(b[j]) {
            j += 1;
        }
        j - i
    } else {
        0
    }
}

/// Length of `(?:word\/)?word(?:\.word)*` at `i`, 0 if none.
fn qualified(b: &[u8], i: usize) -> usize {
    let first = word(b, i);
    if first == 0 {
        return 0;
    }
    let mut j = i + first;
    if j < b.len() && b[j] == b'/' {
        let w = word(b, j + 1);
        if w > 0 {
            j += 1 + w;
        }
    }
    while j < b.len() && b[j] == b'.' {
        let w = word(b, j + 1);
        if w == 0 {
            break;
        }
        j += 1 + w;
    }
    j - i
}

fn tokenize(src: &str) -> Result<Vec<Token<'_>>, TypeExprError> {
    let b = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let q = qualified(b, i);
        if q > 0 {
            out.push(Token {
                kind: TokKind::Ident,
                text: &src[i..i + q],
            });
            i += q;
        } else if c.is_ascii_digit() {
            let mut j = i;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            out.push(Token {
                kind: TokKind::Int,
                text: &src[i..j],
            });
            i = j;
        } else if matches!(c, b'<' | b'>' | b',') {
            out.push(Token {
                kind: TokKind::Punct,
                text: &src[i..i + 1],
            });
            i += 1;
        } else {
            let ch = src[i..].chars().next().unwrap_or('?');
            return err(format!("Unexpected character '{ch}' at {i}"));
        }
    }
    Ok(out)
}

struct Parser<'a> {
    tokens: Vec<Token<'a>>,
    i: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&str> {
        self.tokens.get(self.i).map(|t| t.text)
    }
    fn expect(&mut self, text: &str) -> Result<(), TypeExprError> {
        match self.tokens.get(self.i) {
            Some(t) if t.text == text => {
                self.i += 1;
                Ok(())
            }
            Some(t) => err(format!("Expected '{text}' but found '{}'", t.text)),
            None => err(format!("Expected '{text}' at end")),
        }
    }
    fn size(&mut self, what: &str) -> Result<u64, TypeExprError> {
        let n = self.tokens.get(self.i).cloned();
        self.i += 1;
        let Some(n) = n.filter(|n| n.kind == TokKind::Int) else {
            return err(format!("Expected {what}"));
        };
        let size: u64 = n.text.parse().unwrap_or(u64::MAX);
        if size == 0 {
            let mut c = what.chars();
            let cap = c
                .next()
                .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                .unwrap_or_default();
            return err(format!("{cap} must be > 0"));
        }
        Ok(size)
    }
    /// `, N>` or `>`: the bound, if any.
    fn bound(&mut self) -> Result<Option<u64>, TypeExprError> {
        let max = if self.peek() == Some(",") {
            self.i += 1;
            Some(self.size("bound")?)
        } else {
            None
        };
        self.expect(">")?;
        Ok(max)
    }
    fn parse_type(&mut self) -> Result<FileTypeRef, TypeExprError> {
        let Some(t) = self.tokens.get(self.i).cloned() else {
            return err("Expected a type");
        };
        self.i += 1;
        if t.kind != TokKind::Ident {
            return err(format!("Expected a type but found '{}'", t.text));
        }
        let name = t.text;
        if let Some(p) = Primitive::parse(name) {
            if !(p.bounded() && self.peek() == Some("<")) {
                return Ok(TypeRefOf::Primitive { name: p, max: None });
            }
            self.i += 1;
            let max = self.size("bound")?;
            self.expect(">")?;
            return Ok(TypeRefOf::Primitive {
                name: p,
                max: Some(max),
            });
        }
        Ok(match name {
            "vector" | "list" | "set" => {
                self.expect("<")?;
                let of = Box::new(self.parse_type()?);
                let max = self.bound()?;
                match name {
                    "vector" => TypeRefOf::Vector { of, max },
                    "list" => TypeRefOf::List { of, max },
                    _ => TypeRefOf::Set { of, max },
                }
            }
            "optional" => {
                self.expect("<")?;
                let of = Box::new(self.parse_type()?);
                self.expect(">")?;
                TypeRefOf::Optional { of }
            }
            "array" => {
                self.expect("<")?;
                let of = Box::new(self.parse_type()?);
                self.expect(",")?;
                let size = self.size("array size")?;
                self.expect(">")?;
                TypeRefOf::Array { of, size }
            }
            "map" => {
                self.expect("<")?;
                let key = Box::new(self.parse_type()?);
                self.expect(",")?;
                let value = Box::new(self.parse_type()?);
                let max = self.bound()?;
                TypeRefOf::Map { key, value, max }
            }
            _ => {
                let target = NameRef {
                    name: name.to_string(),
                };
                if self.peek() != Some("<") {
                    return Ok(TypeRefOf::Ref { target, args: None });
                }
                self.i += 1;
                let mut args = vec![self.parse_type()?];
                while self.peek() == Some(",") {
                    self.i += 1;
                    args.push(self.parse_type()?);
                }
                self.expect(">")?;
                TypeRefOf::Ref {
                    target,
                    args: Some(args),
                }
            }
        })
    }
}

/// Parse a type expression into a name-based type reference.
pub fn parse_type_expr(src: &str) -> Result<FileTypeRef, TypeExprError> {
    let mut p = Parser {
        tokens: tokenize(src)?,
        i: 0,
    };
    let result = p.parse_type()?;
    if let Some(rest) = p.peek() {
        return err(format!("Unexpected '{rest}'"));
    }
    Ok(result)
}

fn print_bound(max: Option<u64>) -> String {
    max.map(|m| format!(", {m}")).unwrap_or_default()
}

/// Print a name-based type reference.
pub fn print_type_expr(t: &FileTypeRef) -> String {
    match t {
        TypeRefOf::Primitive { name, max: None } => name.to_string(),
        TypeRefOf::Primitive { name, max: Some(m) } => format!("{name}<{m}>"),
        TypeRefOf::Ref { target, args } => match args {
            Some(a) if !a.is_empty() => {
                format!(
                    "{}<{}>",
                    target.name,
                    a.iter().map(print_type_expr).collect::<Vec<_>>().join(", ")
                )
            }
            _ => target.name.clone(),
        },
        TypeRefOf::Array { of, size } => format!("array<{}, {size}>", print_type_expr(of)),
        TypeRefOf::Map { key, value, max } => {
            format!(
                "map<{}, {}{}>",
                print_type_expr(key),
                print_type_expr(value),
                print_bound(*max)
            )
        }
        TypeRefOf::Optional { of } => format!("optional<{}>", print_type_expr(of)),
        TypeRefOf::Vector { of, max } | TypeRefOf::List { of, max } | TypeRefOf::Set { of, max } => {
            format!("{}<{}{}>", t.kind(), print_type_expr(of), print_bound(*max))
        }
    }
}

/// Rewrite the user-type references of a type tree.
pub fn map_type_ref<A, B, E>(
    t: &TypeRefOf<A>,
    f: &mut impl FnMut(&A) -> Result<B, E>,
) -> Result<TypeRefOf<B>, E> {
    let mut m = |x: &TypeRefOf<A>| map_type_ref(x, f).map(Box::new);
    Ok(match t {
        TypeRefOf::Primitive { name, max } => TypeRefOf::Primitive {
            name: *name,
            max: *max,
        },
        TypeRefOf::Array { of, size } => TypeRefOf::Array {
            of: m(of)?,
            size: *size,
        },
        TypeRefOf::Vector { of, max } => TypeRefOf::Vector {
            of: m(of)?,
            max: *max,
        },
        TypeRefOf::List { of, max } => TypeRefOf::List {
            of: m(of)?,
            max: *max,
        },
        TypeRefOf::Set { of, max } => TypeRefOf::Set {
            of: m(of)?,
            max: *max,
        },
        TypeRefOf::Optional { of } => TypeRefOf::Optional { of: m(of)? },
        TypeRefOf::Map { key, value, max } => TypeRefOf::Map {
            key: m(key)?,
            value: m(value)?,
            max: *max,
        },
        TypeRefOf::Ref { target, args } => {
            let target = f(target)?;
            let args = match args {
                Some(a) => Some(
                    a.iter()
                        .map(|x| map_type_ref(x, f))
                        .collect::<Result<Vec<_>, E>>()?,
                ),
                None => None,
            };
            TypeRefOf::Ref { target, args }
        }
    })
}

/// `map_type_ref` with an infallible mapping.
pub fn map_ref<A, B>(t: &TypeRefOf<A>, mut f: impl FnMut(&A) -> B) -> TypeRefOf<B> {
    map_type_ref(t, &mut |a| Ok::<B, std::convert::Infallible>(f(a))).unwrap_or_else(|e| match e {})
}

/// Visit every node of a type tree.
pub fn walk_type_ref<R>(t: &TypeRefOf<R>, visit: &mut impl FnMut(&TypeRefOf<R>)) {
    visit(t);
    match t {
        TypeRefOf::Array { of, .. }
        | TypeRefOf::Vector { of, .. }
        | TypeRefOf::List { of, .. }
        | TypeRefOf::Set { of, .. }
        | TypeRefOf::Optional { of } => walk_type_ref(of, visit),
        TypeRefOf::Map { key, value, .. } => {
            walk_type_ref(key, visit);
            walk_type_ref(value, visit);
        }
        TypeRefOf::Ref { args, .. } => {
            for a in args.iter().flatten() {
                walk_type_ref(a, visit);
            }
        }
        TypeRefOf::Primitive { .. } => {}
    }
}

/// Print an id-based type reference, resolving ids with `name_of`.
pub fn print_type_ref(t: &TypeRef, name_of: impl Fn(&str) -> Option<String>) -> String {
    print_type_expr(&map_ref(t, |r| NameRef {
        name: name_of(&r.id).unwrap_or_else(|| "<deleted>".into()),
    }))
}

/// Parse a type expression into an id-based reference, resolving names with `id_of`.
pub fn parse_type_ref(src: &str, id_of: impl Fn(&str) -> Option<String>) -> Result<TypeRef, TypeExprError> {
    map_type_ref(&parse_type_expr(src)?, &mut |r: &NameRef| match id_of(&r.name) {
        Some(id) => Ok(IdRef { id }),
        None => err(format!("Unknown type '{}'", r.name)),
    })
}
