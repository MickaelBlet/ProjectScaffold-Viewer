//! The IDL grammar: tokens (after preprocessing) to definitions.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use super::expr::{ConstValue, evaluate};
use super::lexer::{Token, TokenKind, at};
use super::preprocess::Preprocessor;
use super::{
    INCLUDE_RE, IdlAttribute, IdlComponent, IdlError, IdlPort, find_include, last_segment, normalize_files,
    normalize_path, unescape_name,
};
use crate::emit::num;
use crate::schema::{
    FileBitmaskFlag, FileConstant, FileEnumValue, FileInterface, FileMessage, FileParam, FileQualifiers,
    FileTypeBody, FileTypeDef, FileTypeRef, FileUnionCase, FileValueField, NameRef,
};
use crate::typeexpr::{is_reserved_type_name, map_ref};
use crate::types::{IntPrimitive, ParamDirection, PortRole, Primitive, TypeRefOf, UnsignedPrimitive, Value};

type R<T> = Result<T, IdlError>;

/// What a reference is made of: the scope it is written in and the name, split by `SEP`.
const SEP: char = '\u{0}';
const BUILTIN: char = '\u{1}';

/// Names of the built-in types: project name and description.
fn builtin_info(word: &str) -> (&'static str, &'static str) {
    match word {
        "any" => ("Any", "Value of any IDL type"),
        "Object" => ("Object", "Reference to any CORBA object"),
        _ => ("ValueBase", "Any value type"),
    }
}

fn int_type_word(word: &str) -> Option<IntPrimitive> {
    Some(match word {
        "short" | "int16" => IntPrimitive::Int16,
        "long" | "int32" => IntPrimitive::Int32,
        "int8" => IntPrimitive::Int8,
        "int64" => IntPrimitive::Int64,
        "uint8" | "octet" => IntPrimitive::Uint8,
        "uint16" => IntPrimitive::Uint16,
        "uint32" => IntPrimitive::Uint32,
        "uint64" => IntPrimitive::Uint64,
        _ => return None,
    })
}

/// Words that start a definition inside interfaces, valuetypes, components and porttypes too.
fn is_definition_word(w: &str) -> bool {
    matches!(
        w,
        "struct"
            | "union"
            | "enum"
            | "bitmask"
            | "bitset"
            | "typedef"
            | "const"
            | "native"
            | "exception"
            | "typeid"
            | "typeprefix"
    )
}

fn is_constructed(w: &str) -> bool {
    matches!(w, "struct" | "union" | "enum" | "bitmask" | "bitset")
}

fn is_port_word(w: &str) -> bool {
    matches!(
        w,
        "provides" | "uses" | "emits" | "publishes" | "consumes" | "port" | "mirrorport"
    )
}

/// Words that cannot name a type.
fn is_not_type(w: &str) -> bool {
    matches!(
        w,
        "void" | "struct" | "union" | "enum" | "interface" | "module" | "in" | "out" | "inout"
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeclKind {
    Module,
    Type,
    Interface,
    Component,
    Porttype,
    Home,
    Const,
    Enumerator,
    Template,
}

#[derive(Clone)]
enum EntityDef {
    Type(FileTypeDef),
    Interface(FileInterface),
    Component(IdlComponent),
}

#[derive(Clone)]
struct Entity {
    /// Qualified IDL name.
    q: String,
    /// Preferred name in the project.
    simple: String,
    /// Name when `simple` is taken; else from `q`.
    alt: Option<String>,
    /// Made by the import, not defined in the file.
    synthetic: bool,
    /// References to what it needs besides its types (see `IdlFile::needs`).
    needs: Vec<String>,
    /// File defining it.
    file: Option<String>,
    def: EntityDef,
}

impl Entity {
    fn new(q: String, simple: String, def: EntityDef) -> Entity {
        Entity {
            q,
            simple,
            alt: None,
            synthetic: false,
            needs: Vec::new(),
            file: None,
            def,
        }
    }
    fn kind(&self) -> DeclKind {
        match self.def {
            EntityDef::Type(_) => DeclKind::Type,
            EntityDef::Interface(_) => DeclKind::Interface,
            EntityDef::Component(_) => DeclKind::Component,
        }
    }
    fn name(&self) -> &str {
        match &self.def {
            EntityDef::Type(t) => &t.name,
            EntityDef::Interface(i) => &i.name,
            EntityDef::Component(c) => &c.name,
        }
    }
    fn set_name(&mut self, name: String) {
        match &mut self.def {
            EntityDef::Type(t) => t.name = name,
            EntityDef::Interface(i) => i.name = name,
            EntityDef::Component(c) => c.name = name,
        }
    }
}

#[derive(Clone)]
struct Annotation {
    name: String,
    args: Vec<Token>,
}

struct Template {
    params: Vec<String>,
    body: Vec<Token>,
}

struct PortType {
    ports: Vec<IdlPort>,
    attributes: Vec<IdlAttribute>,
}

struct ConstEntry {
    q: String,
    def: FileConstant,
    file: String,
}

struct AttrDecl {
    names: Vec<String>,
    ty: FileTypeRef,
    readonly: bool,
    description: String,
    get_raises: Vec<String>,
    set_raises: Vec<String>,
    refs: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RefKind {
    /// A type reference.
    Type,
    /// Any other reference.
    Other,
}

/// Content of a file: what the IDL text and the files it includes define.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct IdlFile {
    pub types: Vec<FileTypeDef>,
    pub interfaces: Vec<FileInterface>,
    pub constants: Vec<FileConstant>,
    pub components: Vec<IdlComponent>,
    /// Names each type or interface needs besides the types it references: raised exceptions,
    /// interfaces of object references.
    pub needs: IndexMap<String, Vec<String>>,
    /// File defining each type, interface, constant and component, by name.
    pub origins: IndexMap<String, String>,
    /// Innermost IDL module defining each type and interface written in the files
    /// (`Robot::Control`, "" at file scope), by name.
    pub scopes: IndexMap<String, String>,
    /// Qualified IDL name of each type and interface written in the files (`Robot::Status`), by name.
    pub qualified: IndexMap<String, String>,
    /// Files each file includes.
    pub includes: IndexMap<String, Vec<String>>,
    /// Included files found nowhere.
    pub missing: Vec<String>,
    /// What was left out or approximated.
    pub warnings: Vec<String>,
}

fn prim(name: Primitive) -> FileTypeRef {
    TypeRefOf::Primitive { name, max: None }
}

fn prim_max(name: Primitive, max: Option<u64>) -> FileTypeRef {
    TypeRefOf::Primitive { name, max }
}

fn name_ref(name: String) -> FileTypeRef {
    TypeRefOf::Ref {
        target: NameRef { name },
        args: None,
    }
}

fn type_def(name: &str, description: String, body: FileTypeBody) -> FileTypeDef {
    FileTypeDef {
        name: name.to_string(),
        description: Some(description),
        access: None,
        body,
    }
}

fn value_field(
    name: String,
    ty: FileTypeRef,
    description: Option<String>,
    default: Option<Value>,
) -> FileValueField {
    FileValueField {
        name,
        ty,
        description,
        default,
        constraints: None,
        ownership: None,
    }
}

fn file_param(
    name: String,
    ty: FileTypeRef,
    direction: ParamDirection,
    description: Option<String>,
) -> FileParam {
    FileParam {
        name,
        ty,
        description,
        direction: Some(direction),
        qualifiers: FileQualifiers::default(),
        default: None,
    }
}

fn file_message(
    name: String,
    description: String,
    params: Vec<FileParam>,
    returns: Option<FileTypeRef>,
    raises: &[String],
) -> FileMessage {
    FileMessage {
        name,
        description: Some(description),
        access: None,
        qualifiers: FileQualifiers::default(),
        params,
        returns,
        raises: if raises.is_empty() {
            None
        } else {
            Some(raises.to_vec())
        },
        pre: None,
        post: None,
    }
}

/// First of the comments that is not empty.
fn first_text(a: &str, b: &str, c: &str) -> String {
    [a, b, c]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

fn join_lines(lines: &[Option<String>]) -> String {
    lines
        .iter()
        .flatten()
        .filter(|l| !l.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

fn flip(role: PortRole) -> PortRole {
    if role == PortRole::In {
        PortRole::Out
    } else {
        PortRole::In
    }
}

/// Plain value of a constant, as the file format holds it.
fn const_to_value(v: &ConstValue) -> Value {
    match v {
        ConstValue::Int(i) if i.unsigned_abs() <= 9_007_199_254_740_991 => Value::from(*i as i64),
        ConstValue::Int(i) => Value::String(i.to_string()),
        ConstValue::Float(f) => num(*f),
        ConstValue::Str(s) => Value::String(s.clone()),
        ConstValue::Bool(b) => Value::Bool(*b),
    }
}

/// Unsigned type of a bitfield of `bits` bits.
fn bitfield_type(bits: u64) -> FileTypeRef {
    prim(if bits <= 1 {
        Primitive::Bool
    } else if bits <= 8 {
        Primitive::Uint8
    } else if bits <= 16 {
        Primitive::Uint16
    } else if bits <= 32 {
        Primitive::Uint32
    } else {
        Primitive::Uint64
    })
}

/// Smallest integer type of at least `bits` bits holding `values`.
fn int_type(values: &[i64], bits: f64, signed_default: bool) -> IntPrimitive {
    let signed = signed_default || values.iter().any(|v| *v < 0);
    for width in [8u32, 16, 32, 64] {
        if f64::from(width) < bits {
            continue;
        }
        let t = match (signed, width) {
            (true, 8) => IntPrimitive::Int8,
            (true, 16) => IntPrimitive::Int16,
            (true, 32) => IntPrimitive::Int32,
            (true, _) => IntPrimitive::Int64,
            (false, 8) => IntPrimitive::Uint8,
            (false, 16) => IntPrimitive::Uint16,
            (false, 32) => IntPrimitive::Uint32,
            (false, _) => IntPrimitive::Uint64,
        };
        let (min, max) = t.range();
        if values
            .iter()
            .all(|v| i128::from(*v) >= min && i128::from(*v) <= max)
        {
            return t;
        }
    }
    if signed {
        IntPrimitive::Int64
    } else {
        IntPrimitive::Uint64
    }
}

fn map_names(t: &FileTypeRef, f: &mut dyn FnMut(&str) -> String) -> FileTypeRef {
    map_ref(t, |r| NameRef { name: f(&r.name) })
}

fn rewrite_message(m: &mut FileMessage, f: &mut dyn FnMut(RefKind, &str) -> String) {
    for p in &mut m.params {
        p.ty = map_names(&p.ty, &mut |n| f(RefKind::Type, n));
    }
    if let Some(r) = &m.returns {
        m.returns = Some(map_names(r, &mut |n| f(RefKind::Type, n)));
    }
    if let Some(r) = &mut m.raises {
        *r = r.iter().map(|n| f(RefKind::Other, n)).collect();
    }
}

/// Rewrites every reference of an entity: type references with `f(Type, ..)`, others with `f(Other, ..)`.
fn rewrite_entity(e: &mut Entity, f: &mut dyn FnMut(RefKind, &str) -> String) {
    e.needs = e.needs.iter().map(|n| f(RefKind::Other, n)).collect();
    let ty = |t: &FileTypeRef, f: &mut dyn FnMut(RefKind, &str) -> String| {
        map_names(t, &mut |n| f(RefKind::Type, n))
    };
    match &mut e.def {
        EntityDef::Interface(i) => i.messages.iter_mut().for_each(|m| rewrite_message(m, f)),
        EntityDef::Component(c) => {
            for a in &mut c.attributes {
                a.ty = ty(&a.ty, f);
            }
            c.methods.iter_mut().for_each(|m| rewrite_message(m, f));
            for p in &mut c.ports {
                if let Some(i) = &p.interface {
                    p.interface = Some(f(RefKind::Other, i));
                }
            }
            c.bases = c.bases.iter().map(|b| f(RefKind::Other, b)).collect();
        }
        EntityDef::Type(t) => match &mut t.body {
            FileTypeBody::Struct { fields, .. } | FileTypeBody::Exception { fields } => {
                for x in fields {
                    x.ty = ty(&x.ty, f);
                }
            }
            FileTypeBody::Union { discriminator, cases } => {
                *discriminator = ty(discriminator, f);
                for c in cases {
                    c.ty = ty(&c.ty, f);
                }
            }
            FileTypeBody::Alias { ty: t } => *t = ty(t, f),
            _ => {}
        },
    }
}

pub(crate) struct Parser<'a> {
    tokens: Vec<Token>,
    i: usize,
    scope: Vec<String>,
    decls: HashMap<String, DeclKind>,
    entities: IndexMap<String, Entity>,
    /// Interfaces and valuetypes (qualified) by scope: their names are visible in derived ones.
    inherited: HashMap<String, Vec<String>>,
    consts: HashMap<String, ConstValue>,
    /// Constants with a value, for the project (qualified IDL name).
    const_defs: Vec<ConstEntry>,
    templates: HashMap<String, Template>,
    porttypes: HashMap<String, PortType>,
    instances: usize,
    main: &'a str,
    warnings: Vec<String>,
}

impl<'a> Parser<'a> {
    pub fn new(tokens: Vec<Token>, main: &'a str, warnings: Vec<String>) -> Self {
        Parser {
            tokens,
            i: 0,
            scope: Vec::new(),
            decls: HashMap::new(),
            entities: IndexMap::new(),
            inherited: HashMap::new(),
            consts: HashMap::new(),
            const_defs: Vec::new(),
            templates: HashMap::new(),
            porttypes: HashMap::new(),
            instances: 0,
            main,
            warnings,
        }
    }

    pub fn parse(mut self, missing: Vec<String>) -> R<IdlFile> {
        while self.peek(0).is_some() {
            self.definition()?;
        }
        self.finish(missing)
    }

    // Tokens

    fn peek(&self, offset: usize) -> Option<&Token> {
        self.tokens.get(self.i + offset)
    }

    fn next(&mut self) -> R<Token> {
        let t = self
            .tokens
            .get(self.i)
            .cloned()
            .ok_or_else(|| IdlError("Unexpected end of file".into()))?;
        self.i += 1;
        Ok(t)
    }

    fn fail<T>(&self, t: Option<&Token>, expected: &str) -> R<T> {
        Err(IdlError(match t {
            None => format!("Unexpected end of file, expected {expected}"),
            Some(t) => format!("{}: expected {expected} but found '{}'", at(t, self.main), t.text),
        }))
    }

    fn warn(&mut self, t: &Token, message: &str) {
        let w = format!("{}: {message}", at(t, self.main));
        self.warnings.push(w);
    }

    fn is_at(&self, text: &str, offset: usize) -> bool {
        self.peek(offset)
            .is_some_and(|t| t.text == text && t.kind != TokenKind::Str && t.kind != TokenKind::Char)
    }

    fn is(&self, text: &str) -> bool {
        self.is_at(text, 0)
    }

    fn accept(&mut self, text: &str) -> Option<Token> {
        if self.is(text) {
            let t = self.tokens[self.i].clone();
            self.i += 1;
            Some(t)
        } else {
            None
        }
    }

    fn expect(&mut self, text: &str) -> R<Token> {
        match self.accept(text) {
            Some(t) => Ok(t),
            None => self.fail(self.peek(0), &format!("'{text}'")),
        }
    }

    /// A simple name, IDL escape removed.
    fn name(&mut self) -> R<String> {
        let t = self.peek(0);
        if t.map(|t| t.kind) != Some(TokenKind::Ident) {
            return self.fail(t, "an identifier");
        }
        Ok(unescape_name(&self.next()?.text))
    }

    /// A scoped name (`A::B`, `::A::B`), IDL escapes removed.
    fn scoped(&mut self) -> R<String> {
        let mut name = if self.accept("::").is_some() {
            "::".to_string()
        } else {
            String::new()
        };
        name += &self.name()?;
        while self.is("::") && self.peek(1).is_some_and(|t| t.kind == TokenKind::Ident) {
            self.next()?;
            name += &format!("::{}", self.name()?);
        }
        Ok(name)
    }

    fn scoped_list(&mut self) -> R<Vec<String>> {
        let mut list = vec![self.scoped()?];
        while self.accept(",").is_some() {
            list.push(self.scoped()?);
        }
        Ok(list)
    }

    /// Skips up to the `;` ending the current definition, over nested braces.
    fn skip_definition(&mut self) -> R<()> {
        let mut depth = 0i32;
        loop {
            let t = self.next()?;
            match t.text.as_str() {
                "{" | "(" => depth += 1,
                "}" | ")" => depth -= 1,
                ";" if depth <= 0 => return Ok(()),
                _ => {}
            }
        }
    }

    /// Tokens between `open` and its matching `close`, both consumed.
    fn balanced(&mut self, open: &str, close: &str) -> R<Vec<Token>> {
        self.expect(open)?;
        let start = self.i;
        let mut depth = 1;
        loop {
            let t = self.next()?;
            if t.text == open {
                depth += 1;
            } else if t.text == close {
                depth -= 1;
                if depth == 0 {
                    return Ok(self.tokens[start..self.i - 1].to_vec());
                }
            }
        }
    }

    /// Tokens up to one of `ends` (or `,`) outside parentheses, not consumed.
    fn until(&mut self, ends: &[&str]) -> R<Vec<Token>> {
        let start = self.i;
        let mut depth = 0i32;
        while self.peek(0).is_some() && !(depth == 0 && (ends.iter().any(|e| self.is(e)) || self.is(","))) {
            let t = self.next()?;
            if t.text == "(" {
                depth += 1;
            } else if t.text == ")" {
                depth -= 1;
            }
        }
        Ok(self.tokens[start..self.i].to_vec())
    }

    /// Trailing comment of the `;` ending the current definition.
    fn end_trail(&self) -> String {
        match self.peek(0) {
            Some(t) if t.text == ";" => t.trail.clone(),
            _ => String::new(),
        }
    }

    // Names and references

    fn qualified(&self, name: &str) -> String {
        let mut parts = self.scope.clone();
        parts.push(name.to_string());
        parts.join("::")
    }

    /// Innermost IDL module holding the definition `q` ("" at file scope).
    fn module_of(&self, q: &str) -> String {
        let mut parts: Vec<&str> = q.split("::").collect();
        parts.pop();
        while !parts.is_empty() && self.decls.get(&parts.join("::")) != Some(&DeclKind::Module) {
            parts.pop();
        }
        parts.join("::")
    }

    fn has(&self, q: &str, ok: &dyn Fn(DeclKind) -> bool) -> bool {
        self.decls.get(q).is_some_and(|k| ok(*k))
    }

    fn in_scope(
        &self,
        prefix: &str,
        written: &str,
        seen: &mut HashSet<String>,
        ok: &dyn Fn(DeclKind) -> bool,
    ) -> Option<String> {
        let q = if prefix.is_empty() {
            written.to_string()
        } else {
            format!("{prefix}::{written}")
        };
        if self.has(&q, ok) {
            return Some(q);
        }
        if !seen.insert(prefix.to_string()) {
            return None;
        }
        for base in self.inherited.get(prefix).into_iter().flatten() {
            if let Some(found) = self.in_scope(base, written, seen, ok) {
                return Some(found);
            }
        }
        None
    }

    /// Qualified name a written name refers to from `scope`, among declarations `ok` accepts.
    fn lookup(&self, written: &str, scope: &[String], ok: &dyn Fn(DeclKind) -> bool) -> Option<String> {
        if let Some(rest) = written.strip_prefix("::") {
            return self.has(rest, ok).then(|| rest.to_string());
        }
        for k in (0..=scope.len()).rev() {
            let prefix = scope[..k].join("::");
            if let Some(found) = self.in_scope(&prefix, written, &mut HashSet::new(), ok) {
                return Some(found);
            }
        }
        None
    }

    fn entity(&self, written: &str, kind: DeclKind) -> Option<Entity> {
        let q = self.lookup(written, &self.scope, &|k| k == kind)?;
        self.entities.get(&q).filter(|e| e.kind() == kind).cloned()
    }

    /// Reference to a written name, resolved at the end.
    fn encode(&self, written: &str) -> String {
        format!("{}{SEP}{written}", self.scope.join("::"))
    }

    fn ref_to(&self, written: &str) -> FileTypeRef {
        name_ref(self.encode(written))
    }

    /// File of the definition just read.
    fn file(&self) -> String {
        let prev = self.i.checked_sub(1).and_then(|k| self.tokens.get(k));
        prev.or_else(|| self.peek(0))
            .map_or_else(|| self.main.to_string(), |t| t.file.clone())
    }

    fn add(&mut self, mut e: Entity) {
        // Read twice (a file included without guards, a reopened module): the first one stays.
        if self.entities.contains_key(&e.q) {
            return;
        }
        e.file = Some(self.file());
        self.decls.insert(e.q.clone(), e.kind());
        self.entities.insert(e.q.clone(), e);
    }

    fn forward(&mut self, q: &str, kind: DeclKind) {
        self.decls.entry(q.to_string()).or_insert(kind);
    }

    fn const_value(&self, name: &str) -> Option<ConstValue> {
        match name {
            "TRUE" => return Some(ConstValue::Bool(true)),
            "FALSE" => return Some(ConstValue::Bool(false)),
            _ => {}
        }
        let constant = |k: DeclKind| k == DeclKind::Const || k == DeclKind::Enumerator;
        // Enumerators are in the scope of their enum's, also written `Enum::VALUE`.
        let parts: Vec<&str> = name.split("::").collect();
        let q = self.lookup(name, &self.scope, &constant).or_else(|| {
            if parts.len() > 1 {
                let mut v: Vec<&str> = parts[..parts.len() - 2].to_vec();
                v.push(parts[parts.len() - 1]);
                self.lookup(&v.join("::"), &self.scope, &constant)
            } else {
                None
            }
        })?;
        self.consts.get(&q).cloned()
    }

    fn evaluate(&self, tokens: &[Token]) -> R<ConstValue> {
        if tokens.is_empty() {
            return self.fail(self.peek(0), "a constant");
        }
        evaluate(tokens, &|n| self.const_value(n), self.main)
    }

    /// A positive integer constant expression, up to one of `ends`.
    fn count(&mut self, ends: &[&str]) -> R<u64> {
        let tokens = self.until(ends)?;
        let v = self.evaluate(&tokens)?;
        let n = match &v {
            ConstValue::Int(i) => *i as f64,
            ConstValue::Float(f) => *f,
            _ => f64::NAN,
        };
        if n.is_finite() && n.fract() == 0. && n.abs() <= 9_007_199_254_740_991. && n >= 0. {
            return Ok(n as u64);
        }
        Err(IdlError(format!(
            "{}: expected a positive integer",
            tokens.first().map_or_else(String::new, |t| at(t, self.main))
        )))
    }

    /// Bound of a string, sequence or map, up to `>`; none when 0.
    fn bound(&mut self) -> R<Option<u64>> {
        let n = self.count(&[">"])?;
        Ok((n > 0).then_some(n))
    }

    // Annotations

    fn annotations(&mut self) -> R<Vec<Annotation>> {
        let mut list = Vec::new();
        while self.is("@") && !self.is_at("annotation", 1) {
            self.next()?;
            let name = self.scoped()?;
            let args = if self.is("(") {
                self.balanced("(", ")")?
            } else {
                Vec::new()
            };
            list.push(Annotation {
                name: last_segment(&format!("::{name}")).to_string(),
                args,
            });
        }
        Ok(list)
    }

    /// Value of an annotation parameter: `key = value`, else the single value.
    fn annotation_value(&self, a: Option<&Annotation>, key: &str) -> Option<ConstValue> {
        let a = a.filter(|a| !a.args.is_empty())?;
        let mut tokens: &[Token] = &a.args;
        if a.args.get(1).is_some_and(|t| t.text == "=") {
            let start = a
                .args
                .iter()
                .enumerate()
                .position(|(k, t)| t.text == key && a.args.get(k + 1).is_some_and(|x| x.text == "="))?;
            let end = a.args.iter().enumerate().position(|(k, t)| {
                k > start && t.text == "," && a.args.get(k + 2).is_some_and(|x| x.text == "=")
            });
            tokens = &a.args[start + 2..end.unwrap_or(a.args.len())];
        }
        self.evaluate(tokens).ok()
    }

    /// Description of a member: its comment, then what annotations tell about it.
    fn describe(&self, text: &str, anns: &[Annotation]) -> String {
        let find = |n: &str| anns.iter().find(|a| a.name == n);
        let show = |v: Option<ConstValue>| v.map(|v| v.display());
        let range = find("range");
        let min = show(
            self.annotation_value(range, "min")
                .or_else(|| self.annotation_value(find("min"), "value")),
        );
        let max = show(
            self.annotation_value(range, "max")
                .or_else(|| self.annotation_value(find("max"), "value")),
        );
        let unit = show(self.annotation_value(find("unit"), "value"));
        let span = match (&min, &max) {
            (Some(min), Some(max)) => Some(format!("Range: {min} to {max}.")),
            (Some(min), None) => Some(format!("Minimum: {min}.")),
            (None, Some(max)) => Some(format!("Maximum: {max}.")),
            (None, None) => None,
        };
        join_lines(&[
            Some(text.to_string()),
            unit.filter(|u| !u.is_empty()).map(|u| format!("Unit: {u}.")),
            span,
        ])
    }

    /// `@default` value of a member, as a field default.
    fn default_value(&self, anns: &[Annotation]) -> Option<Value> {
        let v = self.annotation_value(anns.iter().find(|a| a.name == "default"), "value")?;
        if let ConstValue::Int(i) = v {
            return (i.unsigned_abs() <= 9_007_199_254_740_991).then(|| Value::from(i as i64));
        }
        Some(const_to_value(&v))
    }

    // Definitions

    fn definition(&mut self) -> R<()> {
        let Some(first) = self.peek(0).cloned() else {
            return Ok(());
        };
        if self.is("@") && self.is_at("annotation", 1) {
            // Annotation declaration.
            self.next()?;
            self.next()?;
            self.name()?;
            self.balanced("{", "}")?;
            self.expect(";")?;
            return Ok(());
        }
        let anns = self.annotations()?;
        self.declaration(&first, anns)
    }

    fn declaration(&mut self, first: &Token, anns: Vec<Annotation>) -> R<()> {
        let Some(t) = self.peek(0).cloned() else {
            return Ok(());
        };
        match t.text.as_str() {
            ";" => {
                self.next()?;
                return Ok(());
            }
            "module" => return self.module(),
            "abstract" | "local" | "custom" => {
                self.next()?;
                if self.is("interface") {
                    return self.interface(first);
                }
                if self.is("custom") {
                    self.next()?;
                }
                if self.is("valuetype") || self.is("eventtype") {
                    return self.valuetype(first, t.text == "abstract");
                }
                return self.fail(self.peek(0), "interface, valuetype or eventtype");
            }
            "interface" => return self.interface(first),
            "typedef" => return self.typedef(first),
            "const" => return self.constant(first),
            "native" => {
                self.next()?;
                let name = self.name()?;
                let description = first_text(&first.doc, &self.end_trail(), &first.trail);
                self.expect(";")?;
                let q = self.qualified(&name);
                let def = type_def(&name, description, FileTypeBody::Primitive {});
                self.add(Entity::new(q, name, EntityDef::Type(def)));
                return Ok(());
            }
            "exception" => return self.exception(first),
            "valuetype" | "eventtype" => return self.valuetype(first, false),
            "component" | "connector" => return self.component(first),
            "porttype" => return self.porttype(),
            "home" => {
                self.next()?;
                let name = self.name()?;
                let q = self.qualified(&name);
                self.decls.insert(q.clone(), DeclKind::Home);
                self.warn(&t, &format!("home {q} left out"));
                return self.skip_definition();
            }
            // Template module referenced in a template module.
            "alias" => return self.module(),
            "typeid" | "typeprefix" | "import" => return self.skip_definition(),
            _ => {}
        }
        if is_constructed(&t.text) {
            self.constructed(first, &anns)?;
            self.expect(";")?;
            return Ok(());
        }
        self.fail(Some(&t), "a definition")
    }

    fn module(&mut self) -> R<()> {
        let keyword = self.next()?;
        let written = self.scoped()?;
        if self.is("<") {
            let args = self.template_args()?;
            if keyword.text == "module" && self.is("{") {
                // Template module: read where instantiated.
                let q = self.qualified(&unescape_name(&written));
                let params = args
                    .iter()
                    .map(|a| a.last().map_or(String::new(), |t| t.text.clone()))
                    .collect();
                let body = self.balanced("{", "}")?;
                self.templates.insert(q.clone(), Template { params, body });
                self.decls.insert(q, DeclKind::Template);
                self.expect(";")?;
                return Ok(());
            }
            let name = self.name()?;
            self.expect(";")?;
            return self.instantiate(&written, &args, &name, &keyword);
        }
        if keyword.text != "module" {
            return self.fail(self.peek(0), "'<'");
        }
        let name = unescape_name(&written);
        let q = self.qualified(&name);
        self.forward(&q, DeclKind::Module);
        self.expect("{")?;
        self.scope.push(name);
        while !self.is("}") {
            if self.peek(0).is_none() {
                return self.fail(None, "'}'");
            }
            self.definition()?;
        }
        self.scope.pop();
        self.expect("}")?;
        self.expect(";")?;
        Ok(())
    }

    /// `<a, b, ...>` of a template module: the tokens of each parameter or argument.
    fn template_args(&mut self) -> R<Vec<Vec<Token>>> {
        self.expect("<")?;
        let mut args: Vec<Vec<Token>> = vec![Vec::new()];
        let mut depth = 0i32;
        loop {
            let t = self.next()?;
            if t.text == ">" && depth == 0 {
                return Ok(args);
            }
            if t.text == "<" || t.text == "(" {
                depth += 1;
            } else if t.text == ">" || t.text == ")" {
                depth -= 1;
            } else if t.text == "," && depth == 0 {
                args.push(Vec::new());
                continue;
            }
            args.last_mut().expect("argument").push(t);
        }
    }

    /// Reads an instance of a template module as a module `name` holding its definitions.
    fn instantiate(&mut self, written: &str, args: &[Vec<Token>], name: &str, from: &Token) -> R<()> {
        let q = self.lookup(written, &self.scope, &|k| k == DeclKind::Template);
        let Some(template) = q.as_ref().and_then(|q| self.templates.get(q)) else {
            self.warn(
                from,
                &format!("template module {written} not found, {name} left out"),
            );
            return Ok(());
        };
        if template.params.len() != args.len() {
            return Err(IdlError(format!(
                "{}: {written} takes {} parameters, not {}",
                at(from, self.main),
                template.params.len(),
                args.len()
            )));
        }
        self.instances += 1;
        if self.instances > 1000 {
            return Err(IdlError(format!(
                "{}: too many template instances",
                at(from, self.main)
            )));
        }
        let actual: HashMap<&str, &Vec<Token>> = template
            .params
            .iter()
            .map(String::as_str)
            .zip(args.iter())
            .collect();
        let mut body: Vec<Token> = Vec::new();
        for t in &template.body {
            match actual.get(t.text.as_str()) {
                Some(a) if t.kind == TokenKind::Ident => body.extend(a.iter().cloned()),
                _ => body.push(t.clone()),
            }
        }
        let token = |text: &str, kind: TokenKind| Token::made(from, kind, text);
        let mut inserted = vec![
            token("module", TokenKind::Ident),
            token(name, TokenKind::Ident),
            token("{", TokenKind::Punct),
        ];
        inserted.extend(body);
        inserted.push(token("}", TokenKind::Punct));
        inserted.push(token(";", TokenKind::Punct));
        self.tokens.splice(self.i..self.i, inserted);
        Ok(())
    }

    fn interface(&mut self, first: &Token) -> R<()> {
        self.expect("interface")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        if self.accept(";").is_some() {
            self.forward(&q, DeclKind::Interface);
            return Ok(());
        }
        let mut messages: Vec<FileMessage> = Vec::new();
        let mut needs: Vec<String> = Vec::new();
        let mut bases: Vec<String> = Vec::new();
        if self.accept(":").is_some() {
            for b in self.scoped_list()? {
                let base = self.entity(&b, DeclKind::Interface);
                let Some(Entity {
                    def: EntityDef::Interface(base_def),
                    q: base_q,
                    needs: base_needs,
                    ..
                }) = base
                else {
                    self.warn(first, &format!("{q}: base interface {b} not found"));
                    continue;
                };
                bases.push(base_q);
                for m in base_def.messages {
                    if !messages.iter().any(|x| x.name == m.name) {
                        messages.push(m);
                    }
                }
                needs.extend(base_needs);
            }
        }
        self.expect("{")?;
        self.forward(&q, DeclKind::Interface);
        self.inherited.insert(q.clone(), bases);
        self.scope.push(name.clone());
        while self.accept("}").is_none() {
            let Some(f) = self.peek(0).cloned() else {
                return self.fail(None, "'}'");
            };
            let anns = self.annotations()?;
            let t = self.peek(0).cloned();
            if t.as_ref().is_some_and(|t| is_definition_word(&t.text)) {
                self.declaration(&f, anns)?;
            } else if self.is("attribute") || self.is("readonly") {
                self.attribute(&f, &mut messages, &mut needs)?;
            } else {
                let (message, raises) = self.operation(&f)?;
                messages.push(message);
                needs.extend(raises);
            }
        }
        self.scope.pop();
        let description = first_text(&first.doc, &self.end_trail(), &first.trail);
        self.expect(";")?;
        let def = FileInterface {
            name: name.clone(),
            description: Some(description),
            messages,
        };
        let mut e = Entity::new(q, name, EntityDef::Interface(def));
        e.needs = needs;
        self.add(e);
        Ok(())
    }

    /// `raises (A, B)`: references to the exceptions.
    fn raises(&mut self) -> R<Vec<String>> {
        self.expect("(")?;
        let names = self.scoped_list()?;
        self.expect(")")?;
        Ok(names.iter().map(|n| self.encode(n)).collect())
    }

    /// Attribute declaration, as messages: `get_x`, and `set_x` unless read-only.
    fn attribute(
        &mut self,
        first: &Token,
        messages: &mut Vec<FileMessage>,
        needs: &mut Vec<String>,
    ) -> R<()> {
        let a = self.attribute_decl(first)?;
        for n in &a.names {
            messages.push(file_message(
                format!("get_{n}"),
                a.description.clone(),
                Vec::new(),
                Some(a.ty.clone()),
                &a.get_raises,
            ));
            if !a.readonly {
                messages.push(file_message(
                    format!("set_{n}"),
                    a.description.clone(),
                    vec![file_param(n.clone(), a.ty.clone(), ParamDirection::In, None)],
                    None,
                    &a.set_raises,
                ));
            }
        }
        needs.extend(a.refs);
        Ok(())
    }

    fn attribute_decl(&mut self, first: &Token) -> R<AttrDecl> {
        let readonly = self.accept("readonly").is_some();
        self.expect("attribute")?;
        let ty = self.type_spec()?;
        let mut names = vec![self.name()?];
        while self.accept(",").is_some() {
            names.push(self.name()?);
        }
        let mut get_raises: Vec<String> = Vec::new();
        let mut set_raises: Vec<String> = Vec::new();
        while self.is("raises") || self.is("getraises") || self.is("setraises") {
            let which = self.next()?.text;
            let list = self.raises()?;
            if which == "setraises" {
                set_raises.extend(list);
            } else {
                get_raises.extend(list);
            }
        }
        let end = self.expect(";")?;
        let refs = get_raises.iter().chain(&set_raises).cloned().collect();
        Ok(AttrDecl {
            names,
            ty,
            readonly,
            description: first_text(&first.doc, &end.trail, &first.trail),
            get_raises,
            set_raises,
            refs,
        })
    }

    fn operation(&mut self, first: &Token) -> R<(FileMessage, Vec<String>)> {
        self.accept("oneway");
        let returns = if self.accept("void").is_some() {
            None
        } else {
            Some(self.type_spec()?)
        };
        let name = self.name()?;
        self.expect("(")?;
        let mut params: Vec<FileParam> = Vec::new();
        if !self.is(")") {
            loop {
                let param = self.peek(0).cloned();
                self.annotations()?;
                let dir = if self.is("in") || self.is("out") || self.is("inout") {
                    self.next()?.text
                } else {
                    "in".to_string()
                };
                let ty = self.type_spec()?;
                let pname = self.name()?;
                let direction = ParamDirection::parse(&dir).unwrap_or(ParamDirection::In);
                let doc = param.map(|p| p.doc).filter(|d| !d.is_empty());
                params.push(file_param(pname, ty, direction, doc));
                if self.accept(",").is_none() {
                    break;
                }
            }
        }
        self.expect(")")?;
        let raised = if self.accept("raises").is_some() {
            self.raises()?
        } else {
            Vec::new()
        };
        if self.accept("context").is_some() {
            self.balanced("(", ")")?;
        }
        let end = self.expect(";")?;
        let description = first_text(&first.doc, &end.trail, &first.trail);
        Ok((file_message(name, description, params, returns, &raised), raised))
    }

    /// Struct, union, enum, bitmask or bitset definition (or forward declaration): its qualified name.
    fn constructed(&mut self, first: &Token, anns: &[Annotation]) -> R<String> {
        match self.peek(0).map(|t| t.text.as_str()) {
            Some("struct") => self.struct_def(first),
            Some("union") => self.union_def(first),
            Some("enum") => self.enum_def(first, anns),
            Some("bitmask") => self.bitmask(first, anns),
            _ => self.bitset(first),
        }
    }

    /// Struct members up to `}`.
    fn members(&mut self, fields: &mut Vec<FileValueField>) -> R<()> {
        while self.accept("}").is_none() {
            let Some(member) = self.peek(0).cloned() else {
                return self.fail(None, "'}'");
            };
            let anns = self.annotations()?;
            if self.is("}") {
                continue;
            }
            let optional = anns.iter().any(|a| a.name == "optional");
            let base = self.type_spec()?;
            let declarators = self.declarators(base, true)?;
            let end = self.expect(";")?;
            let description = self.describe(&first_text(&member.doc, &end.trail, &member.trail), &anns);
            for (name, ty) in declarators {
                fields.push(value_field(
                    name,
                    if optional {
                        TypeRefOf::Optional { of: Box::new(ty) }
                    } else {
                        ty
                    },
                    (!description.is_empty()).then(|| description.clone()),
                    self.default_value(&anns),
                ));
            }
        }
        Ok(())
    }

    /// Fields of a base struct, valuetype or bitset.
    fn base_fields(&mut self, written: &str, what: &str, first: &Token, q: &str) -> Vec<FileValueField> {
        if let Some(Entity {
            def:
                EntityDef::Type(FileTypeDef {
                    body: FileTypeBody::Struct { fields, .. },
                    ..
                }),
            ..
        }) = self.entity(written, DeclKind::Type)
        {
            return fields;
        }
        self.warn(first, &format!("{q}: base {what} {written} not found"));
        Vec::new()
    }

    fn struct_def(&mut self, first: &Token) -> R<String> {
        self.expect("struct")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        if !self.is("{") && !self.is(":") {
            self.forward(&q, DeclKind::Type);
            return Ok(q);
        }
        let mut fields = if self.accept(":").is_some() {
            let written = self.scoped()?;
            self.base_fields(&written, "struct", first, &q)
        } else {
            Vec::new()
        };
        self.expect("{")?;
        self.forward(&q, DeclKind::Type);
        self.scope.push(name.clone());
        self.members(&mut fields)?;
        self.scope.pop();
        let description = first_text(&first.doc, &self.end_trail(), &first.trail);
        let def = type_def(
            &name,
            description,
            FileTypeBody::Struct {
                derives: None,
                fields,
            },
        );
        self.add(Entity::new(q.clone(), name, EntityDef::Type(def)));
        Ok(q)
    }

    fn exception(&mut self, first: &Token) -> R<()> {
        self.expect("exception")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        self.expect("{")?;
        self.forward(&q, DeclKind::Type);
        self.scope.push(name.clone());
        let mut fields = Vec::new();
        self.members(&mut fields)?;
        self.scope.pop();
        let description = first_text(&first.doc, &self.end_trail(), &first.trail);
        self.expect(";")?;
        let def = type_def(&name, description, FileTypeBody::Exception { fields });
        self.add(Entity::new(q, name, EntityDef::Type(def)));
        Ok(())
    }

    /// Union: its discriminator and cases, with their labels.
    fn union_def(&mut self, first: &Token) -> R<String> {
        self.expect("union")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        if !self.is("switch") {
            self.forward(&q, DeclKind::Type);
            return Ok(q);
        }
        self.expect("switch")?;
        self.expect("(")?;
        self.annotations()?;
        let discriminator = self.type_spec()?;
        self.expect(")")?;
        self.expect("{")?;
        self.forward(&q, DeclKind::Type);
        self.scope.push(name.clone());
        let mut cases: Vec<FileUnionCase> = Vec::new();
        while self.accept("}").is_none() {
            let mut labels: Vec<Value> = Vec::new();
            let mut is_default = false;
            while self.is("case") || self.is("default") {
                if self.accept("default").is_some() {
                    is_default = true;
                } else {
                    self.next()?;
                    let tokens = self.until(&[":"])?;
                    let v = self.evaluate(&tokens)?;
                    labels.push(const_to_value(&v));
                }
                self.expect(":")?;
            }
            if labels.is_empty() && !is_default {
                return self.fail(self.peek(0), "'case' or 'default'");
            }
            let Some(member) = self.peek(0).cloned() else {
                return self.fail(None, "a type");
            };
            let anns = self.annotations()?;
            let ty = self.type_spec()?;
            let (dname, dty) = self.declarators(ty, false)?.remove(0);
            let end = self.expect(";")?;
            cases.push(FileUnionCase {
                name: dname,
                ty: dty,
                description: Some(self.describe(&first_text(&member.doc, &end.trail, &member.trail), &anns)),
                labels: (!labels.is_empty()).then_some(labels),
                default: is_default.then_some(true),
            });
        }
        self.scope.pop();
        let description = first_text(&first.doc, &self.end_trail(), &first.trail);
        let def = type_def(&name, description, FileTypeBody::Union { discriminator, cases });
        self.add(Entity::new(q.clone(), name, EntityDef::Type(def)));
        Ok(q)
    }

    fn enum_def(&mut self, first: &Token, anns: &[Annotation]) -> R<String> {
        self.expect("enum")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        self.expect("{")?;
        let mut values: Vec<FileEnumValue> = Vec::new();
        let mut value: i64 = 0;
        loop {
            if self.is("}") {
                break;
            }
            let found = self.annotations()?;
            if let Some(explicit) = self.annotation_value(found.iter().find(|a| a.name == "value"), "value") {
                value = explicit.number() as i64;
            }
            let v = self.name()?;
            values.push(FileEnumValue {
                name: v.clone(),
                value,
            });
            value += 1;
            // Enumerators belong to the enclosing scope.
            let vq = self.qualified(&v);
            self.decls.insert(vq.clone(), DeclKind::Enumerator);
            self.consts.insert(vq, ConstValue::Str(v));
            if self.accept(",").is_none() {
                break;
            }
        }
        self.expect("}")?;
        let bits = self.annotation_value(anns.iter().find(|a| a.name == "bit_bound"), "value");
        let nums: Vec<i64> = values.iter().map(|v| v.value).collect();
        let underlying = match bits {
            None if nums.iter().all(|v| *v <= i64::from(i32::MAX)) => IntPrimitive::Int32,
            None => int_type(&nums, 32., false),
            Some(b) => int_type(&nums, b.number(), false),
        };
        let description = first_text(&first.doc, &self.end_trail(), &first.trail);
        let def = type_def(&name, description, FileTypeBody::Enum { underlying, values });
        self.add(Entity::new(q.clone(), name, EntityDef::Type(def)));
        Ok(q)
    }

    /// Bitmask: an enum of its flags.
    fn bitmask(&mut self, first: &Token, anns: &[Annotation]) -> R<String> {
        self.expect("bitmask")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        self.expect("{")?;
        let mut flags: Vec<FileBitmaskFlag> = Vec::new();
        let mut bit: f64 = 0.;
        loop {
            if self.is("}") {
                break;
            }
            let found = self.annotations()?;
            if let Some(position) =
                self.annotation_value(found.iter().find(|a| a.name == "position"), "value")
            {
                bit = position.number();
            }
            let flag = self.name()?;
            let fq = self.qualified(&flag);
            self.decls.insert(fq.clone(), DeclKind::Enumerator);
            self.consts.insert(fq, ConstValue::Str(flag.clone()));
            if bit < 64. {
                flags.push(FileBitmaskFlag {
                    name: flag,
                    bit: bit as u32,
                });
            } else {
                self.warn(first, &format!("bitmask {q}: flag {flag} above bit 63 left out"));
            }
            bit += 1.;
            if self.accept(",").is_none() {
                break;
            }
        }
        self.expect("}")?;
        let bound = self
            .annotation_value(anns.iter().find(|a| a.name == "bit_bound"), "value")
            .map_or(32., |v| v.number());
        let bits = flags.iter().fold(bound, |m, f| m.max(f64::from(f.bit) + 1.));
        let description = first_text(&first.doc, &self.end_trail(), &first.trail);
        let underlying = if bits <= 8. {
            UnsignedPrimitive::Uint8
        } else if bits <= 16. {
            UnsignedPrimitive::Uint16
        } else if bits <= 32. {
            UnsignedPrimitive::Uint32
        } else {
            UnsignedPrimitive::Uint64
        };
        let def = type_def(&name, description, FileTypeBody::Bitmask { underlying, flags });
        self.add(Entity::new(q.clone(), name, EntityDef::Type(def)));
        Ok(q)
    }

    /// Bitset: a struct of its bitfields.
    fn bitset(&mut self, first: &Token) -> R<String> {
        self.expect("bitset")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        if !self.is("{") && !self.is(":") {
            self.forward(&q, DeclKind::Type);
            return Ok(q);
        }
        let mut fields = if self.accept(":").is_some() {
            let written = self.scoped()?;
            self.base_fields(&written, "bitset", first, &q)
        } else {
            Vec::new()
        };
        self.expect("{")?;
        while self.accept("}").is_none() {
            let member = self.peek(0).cloned();
            let anns = self.annotations()?;
            self.expect("bitfield")?;
            self.expect("<")?;
            let bits = self.count(&[">"])?;
            let ty = if self.accept(",").is_some() {
                self.type_spec()?
            } else {
                bitfield_type(bits)
            };
            self.expect(">")?;
            let mut names: Vec<String> = Vec::new();
            if !self.is(";") {
                names.push(self.name()?);
                while self.accept(",").is_some() {
                    names.push(self.name()?);
                }
            }
            let end = self.expect(";")?;
            let doc = member
                .map(|m| m.doc)
                .filter(|d| !d.is_empty())
                .unwrap_or(end.trail);
            let description = join_lines(&[Some(self.describe(&doc, &anns)), Some(format!("{bits} bits."))]);
            for n in names {
                fields.push(value_field(n, ty.clone(), Some(description.clone()), None));
            }
        }
        self.warn(
            first,
            &format!("bitset {q} imported as a struct of its bitfields"),
        );
        let description = first_text(&first.doc, &self.end_trail(), &first.trail);
        let def = type_def(
            &name,
            description,
            FileTypeBody::Struct {
                derives: None,
                fields,
            },
        );
        self.add(Entity::new(q.clone(), name, EntityDef::Type(def)));
        Ok(q)
    }

    fn typedef(&mut self, first: &Token) -> R<()> {
        self.expect("typedef")?;
        self.annotations()?;
        let base = self.type_spec()?;
        let declarators = self.declarators(base, true)?;
        let end = self.expect(";")?;
        let description = first_text(&first.doc, &end.trail, &first.trail);
        for (name, ty) in declarators {
            let q = self.qualified(&name);
            let def = type_def(&name, description.clone(), FileTypeBody::Alias { ty });
            self.add(Entity::new(q, name, EntityDef::Type(def)));
        }
        Ok(())
    }

    fn constant(&mut self, first: &Token) -> R<()> {
        self.expect("const")?;
        let warnings = self.warnings.len();
        let ty = self.type_spec()?;
        self.warnings.truncate(warnings);
        let name = self.name()?;
        self.expect("=")?;
        let tokens = self.until(&[";"])?;
        let end = self.expect(";")?;
        let q = self.qualified(&name);
        self.decls.insert(q.clone(), DeclKind::Const);
        let Ok(value) = self.evaluate(&tokens) else {
            // Unknown value: uses of the constant tell.
            self.warn(
                first,
                &format!("constant {q} left out: its value is not computed"),
            );
            return Ok(());
        };
        self.consts.insert(q.clone(), value.clone());
        if self.const_defs.iter().any(|c| c.q == q) {
            return Ok(());
        }
        let file = self.file();
        self.const_defs.push(ConstEntry {
            q,
            file,
            def: FileConstant {
                name,
                description: Some(first_text(&first.doc, &end.trail, &first.trail)),
                ty,
                value: Some(const_to_value(&value)),
            },
        });
        Ok(())
    }

    /// Valuetype or eventtype: a struct of its state members; an abstract one, an interface of its
    /// operations. A value box is an alias of an optional value.
    fn valuetype(&mut self, first: &Token, is_abstract: bool) -> R<()> {
        let keyword = self.next()?.text;
        let name = self.name()?;
        let q = self.qualified(&name);
        let kind = if is_abstract {
            DeclKind::Interface
        } else {
            DeclKind::Type
        };
        if self.accept(";").is_some() {
            self.forward(&q, kind);
            return Ok(());
        }
        if !self.is(":") && !self.is("supports") && !self.is("{") {
            let ty = self.type_spec()?;
            let description = first_text(&first.doc, &self.end_trail(), &first.trail);
            self.expect(";")?;
            let def = type_def(
                &name,
                description,
                FileTypeBody::Alias {
                    ty: TypeRefOf::Optional { of: Box::new(ty) },
                },
            );
            self.add(Entity::new(q, name, EntityDef::Type(def)));
            return Ok(());
        }
        let mut fields: Vec<FileValueField> = Vec::new();
        let mut messages: Vec<FileMessage> = Vec::new();
        let mut needs: Vec<String> = Vec::new();
        let mut bases: Vec<String> = Vec::new();
        let mut inherit_from: Vec<String> = Vec::new();
        if self.accept(":").is_some() {
            self.accept("truncatable");
            inherit_from.extend(self.scoped_list()?);
        }
        if self.accept("supports").is_some() {
            inherit_from.extend(self.scoped_list()?);
        }
        for written in inherit_from {
            let found = self
                .lookup(&written, &self.scope, &|k| {
                    k == DeclKind::Type || k == DeclKind::Interface
                })
                .and_then(|l| self.entities.get(&l).cloned());
            match found {
                Some(Entity {
                    def:
                        EntityDef::Type(FileTypeDef {
                            body: FileTypeBody::Struct { fields: f, .. },
                            ..
                        }),
                    q: base_q,
                    ..
                }) => {
                    fields.extend(f);
                    bases.push(base_q);
                }
                Some(Entity {
                    def: EntityDef::Interface(i),
                    q: base_q,
                    needs: n,
                    ..
                }) => {
                    for m in i.messages {
                        if !messages.iter().any(|x| x.name == m.name) {
                            messages.push(m);
                        }
                    }
                    needs.extend(n);
                    bases.push(base_q);
                }
                _ => self.warn(first, &format!("{q}: base {written} not found")),
            }
        }
        self.expect("{")?;
        self.forward(&q, kind);
        self.inherited.insert(q.clone(), bases);
        self.scope.push(name.clone());
        let mut left = 0usize;
        while self.accept("}").is_none() {
            let Some(f) = self.peek(0).cloned() else {
                return self.fail(None, "'}'");
            };
            let anns = self.annotations()?;
            let Some(t) = self.peek(0).cloned() else {
                return self.fail(None, "a definition");
            };
            if t.text == "public" || t.text == "private" {
                self.next()?;
                let ty = self.type_spec()?;
                let declarators = self.declarators(ty, true)?;
                let end = self.expect(";")?;
                let description = self.describe(&first_text(&f.doc, &end.trail, &f.trail), &anns);
                for (n, ty) in declarators {
                    fields.push(value_field(
                        n,
                        ty,
                        (!description.is_empty()).then(|| description.clone()),
                        None,
                    ));
                }
            } else if t.text == "factory" || t.text == "init" {
                self.skip_definition()?;
                left += 1;
            } else if is_definition_word(&t.text) {
                self.declaration(&f, anns)?;
            } else if t.text == "attribute" || t.text == "readonly" {
                let before = messages.len();
                self.attribute(&f, &mut messages, &mut needs)?;
                if !is_abstract {
                    left += messages.drain(before..).count();
                }
            } else {
                let (message, raises) = self.operation(&f)?;
                if is_abstract {
                    messages.push(message);
                    needs.extend(raises);
                } else {
                    left += 1;
                }
            }
        }
        self.scope.pop();
        let description = first_text(&first.doc, &self.end_trail(), &first.trail);
        self.expect(";")?;
        if is_abstract {
            let def = FileInterface {
                name: name.clone(),
                description: Some(description),
                messages,
            };
            let mut e = Entity::new(q, name, EntityDef::Interface(def));
            e.needs = needs;
            self.add(e);
            return Ok(());
        }
        if left > 0 {
            self.warn(
                first,
                &format!("{keyword} {q}: {left} operations, factories or attributes left out"),
            );
        }
        let def = type_def(
            &name,
            description,
            FileTypeBody::Struct {
                derives: None,
                fields,
            },
        );
        self.add(Entity::new(q, name, EntityDef::Type(def)));
        Ok(())
    }

    /// Component or connector: a module with ports and attributes.
    fn component(&mut self, first: &Token) -> R<()> {
        let keyword = self.next()?.text;
        let name = self.name()?;
        let q = self.qualified(&name);
        if self.accept(";").is_some() {
            self.forward(&q, DeclKind::Component);
            return Ok(());
        }
        let mut def = IdlComponent {
            name: name.clone(),
            description: String::new(),
            bases: Vec::new(),
            attributes: Vec::new(),
            methods: Vec::new(),
            ports: Vec::new(),
            needs: Vec::new(),
            qualified: None,
        };
        let mut needs: Vec<String> = Vec::new();
        if self.accept(":").is_some() {
            let b = self.scoped()?;
            match self.entity(&b, DeclKind::Component) {
                Some(base) => def.bases.push(format!("{SEP}::{}", base.q)),
                None => self.warn(first, &format!("{q}: base {keyword} {b} not found")),
            }
        }
        if self.accept("supports").is_some() {
            for s in self.scoped_list()? {
                let Some(Entity {
                    def: EntityDef::Interface(i),
                    needs: n,
                    ..
                }) = self.entity(&s, DeclKind::Interface)
                else {
                    self.warn(first, &format!("{q}: supported interface {s} not found"));
                    continue;
                };
                def.methods.extend(i.messages);
                needs.extend(n);
            }
        }
        self.expect("{")?;
        self.forward(&q, DeclKind::Component);
        self.scope.push(name.clone());
        self.component_members(&mut def, Some(&mut needs))?;
        self.scope.pop();
        def.description = first_text(&first.doc, &self.end_trail(), &first.trail);
        self.expect(";")?;
        let mut e = Entity::new(q, name, EntityDef::Component(def));
        e.needs = needs;
        self.add(e);
        Ok(())
    }

    /// Ports, attributes and definitions up to `}` (consumed).
    fn component_members(&mut self, def: &mut IdlComponent, mut needs: Option<&mut Vec<String>>) -> R<()> {
        while self.accept("}").is_none() {
            let Some(f) = self.peek(0).cloned() else {
                return self.fail(None, "'}'");
            };
            let anns = self.annotations()?;
            let Some(t) = self.peek(0).cloned() else {
                return self.fail(None, "a port or an attribute");
            };
            if t.text == "attribute" || t.text == "readonly" {
                let a = self.attribute_decl(&f)?;
                for n in a.names {
                    def.attributes.push(IdlAttribute {
                        name: n,
                        ty: a.ty.clone(),
                        description: a.description.clone(),
                        readonly: a.readonly,
                    });
                }
                if let Some(needs) = needs.as_deref_mut() {
                    needs.extend(a.refs);
                }
            } else if is_port_word(&t.text) {
                self.port(&mut def.ports, &mut def.attributes, &f)?;
            } else if is_definition_word(&t.text) {
                self.declaration(&f, anns)?;
            } else {
                return self.fail(Some(&t), "a port or an attribute");
            }
        }
        Ok(())
    }

    fn porttype(&mut self) -> R<()> {
        self.expect("porttype")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        if self.accept(";").is_some() {
            self.forward(&q, DeclKind::Porttype);
            return Ok(());
        }
        let mut def = IdlComponent {
            name: String::new(),
            description: String::new(),
            bases: Vec::new(),
            attributes: Vec::new(),
            methods: Vec::new(),
            ports: Vec::new(),
            needs: Vec::new(),
            qualified: None,
        };
        self.expect("{")?;
        self.decls.insert(q.clone(), DeclKind::Porttype);
        self.scope.push(name);
        self.component_members(&mut def, None)?;
        self.scope.pop();
        self.expect(";")?;
        self.porttypes.insert(
            q,
            PortType {
                ports: def.ports,
                attributes: def.attributes,
            },
        );
        Ok(())
    }

    /// Port declaration: `provides` and `consumes` are `in` ports, the others `out` ports.
    fn port(&mut self, ports: &mut Vec<IdlPort>, attributes: &mut Vec<IdlAttribute>, first: &Token) -> R<()> {
        let keyword = self.next()?.text;
        let multiple = keyword == "uses" && self.accept("multiple").is_some();
        let written = if self.is("Object") {
            self.next()?.text
        } else {
            self.scoped()?
        };
        let name = self.name()?;
        let end = self.expect(";")?;
        let description = join_lines(&[
            Some(first_text(&first.doc, &end.trail, &first.trail)),
            multiple.then(|| "Multiple connections.".to_string()),
        ]);
        match keyword.as_str() {
            "provides" | "uses" => {
                ports.push(IdlPort {
                    name,
                    role: if keyword == "provides" {
                        PortRole::In
                    } else {
                        PortRole::Out
                    },
                    interface: Some(self.encode(&written)),
                    description,
                });
                return Ok(());
            }
            "emits" | "publishes" | "consumes" => {
                let interface = self.event_consumer(&written, first);
                ports.push(IdlPort {
                    name,
                    role: if keyword == "consumes" {
                        PortRole::In
                    } else {
                        PortRole::Out
                    },
                    interface: Some(interface),
                    description: join_lines(&[
                        Some(description),
                        (keyword == "publishes").then(|| "Publishes to any number of consumers.".to_string()),
                    ]),
                });
                return Ok(());
            }
            _ => {}
        }
        let q = self.lookup(&written, &self.scope, &|k| k == DeclKind::Porttype);
        let Some(ty) = q.as_ref().and_then(|q| self.porttypes.get(q)) else {
            self.warn(
                first,
                &format!("porttype {written} not found, port {name} left out"),
            );
            return Ok(());
        };
        for p in &ty.ports {
            ports.push(IdlPort {
                name: format!("{name}_{}", p.name),
                role: if keyword == "mirrorport" {
                    flip(p.role)
                } else {
                    p.role
                },
                ..p.clone()
            });
        }
        for a in &ty.attributes {
            attributes.push(IdlAttribute {
                name: format!("{name}_{}", a.name),
                ..a.clone()
            });
        }
        Ok(())
    }

    /// Interface receiving events of an eventtype (CCM's `<Event>Consumer`): its reference.
    fn event_consumer(&mut self, written: &str, first: &Token) -> String {
        let event = self.lookup(written, &self.scope, &|k| k == DeclKind::Type);
        if event.is_none() {
            self.warn(first, &format!("eventtype {written} not found"));
        }
        let simple = last_segment(&format!("::{written}")).to_string();
        let q = format!("{}Consumer", event.as_deref().unwrap_or(&simple));
        if !self.entities.contains_key(&q) {
            let target = match &event {
                Some(e) => format!("::{e}"),
                None => written.to_string(),
            };
            let push = file_message(
                "push".into(),
                String::new(),
                vec![file_param(
                    "event".into(),
                    self.ref_to(&target),
                    ParamDirection::In,
                    None,
                )],
                None,
                &[],
            );
            let def = FileInterface {
                name: String::new(),
                description: Some(format!("Receives {simple} events.")),
                messages: vec![push],
            };
            let mut e = Entity::new(q.clone(), format!("{simple}Consumer"), EntityDef::Interface(def));
            e.synthetic = true;
            self.add(e);
        }
        format!("{SEP}::{q}")
    }

    // Types

    fn declarators(&mut self, base: FileTypeRef, several: bool) -> R<Vec<(String, FileTypeRef)>> {
        let mut list = Vec::new();
        loop {
            let name = self.name()?;
            let mut sizes: Vec<u64> = Vec::new();
            while self.accept("[").is_some() {
                sizes.push(self.count(&["]"])?);
                self.expect("]")?;
            }
            // `T x[2][3]`: two arrays of three.
            let mut ty = base.clone();
            for size in sizes.into_iter().rev() {
                ty = TypeRefOf::Array {
                    of: Box::new(ty),
                    size,
                };
            }
            list.push((name, ty));
            if !(several && self.accept(",").is_some()) {
                break;
            }
        }
        Ok(list)
    }

    fn type_spec(&mut self) -> R<FileTypeRef> {
        let t = self.peek(0).cloned();
        if t.as_ref().is_some_and(|t| t.text == "::") {
            let written = self.scoped()?;
            return Ok(self.ref_to(&written));
        }
        let Some(t) = t.filter(|t| t.kind == TokenKind::Ident) else {
            return self.fail(self.peek(0), "a type");
        };
        let word = t.text.as_str();
        if is_constructed(word)
            && self.peek(1).is_some_and(|x| x.kind == TokenKind::Ident)
            && matches!(self.peek(2).map(|x| x.text.as_str()), Some("{" | ":" | "switch"))
        {
            let q = self.constructed(&t, &[])?;
            return Ok(name_ref(format!("{SEP}::{q}")));
        }
        let template = self.is_at("<", 1);
        match word {
            "unsigned" => {
                self.next()?;
                let rest = self.next()?.text;
                let full = if rest == "long" && self.accept("long").is_some() {
                    "long long".to_string()
                } else {
                    rest
                };
                let int = match full.as_str() {
                    "short" => Primitive::Uint16,
                    "long" => Primitive::Uint32,
                    "long long" => Primitive::Uint64,
                    _ => return self.fail(Some(&t), "an unsigned integer type"),
                };
                return Ok(prim(int));
            }
            "long" => {
                self.next()?;
                if self.accept("long").is_some() {
                    return Ok(prim(Primitive::Int64));
                }
                if self.accept("double").is_some() {
                    self.warn(&t, "long double imported as float64");
                    return Ok(prim(Primitive::Float64));
                }
                return Ok(prim(Primitive::Int32));
            }
            "float" => {
                self.next()?;
                return Ok(prim(Primitive::Float32));
            }
            "double" => {
                self.next()?;
                return Ok(prim(Primitive::Float64));
            }
            "boolean" => {
                self.next()?;
                return Ok(prim(Primitive::Bool));
            }
            "char" | "wchar" => {
                self.next()?;
                return Ok(prim(Primitive::Char));
            }
            "string" | "wstring" => {
                self.next()?;
                if self.accept("<").is_none() {
                    return Ok(prim(Primitive::String));
                }
                let max = self.bound()?;
                self.expect(">")?;
                return Ok(prim_max(Primitive::String, max));
            }
            "sequence" if template => {
                self.next()?;
                self.expect("<")?;
                let of = self.type_spec()?;
                let max = if self.accept(",").is_some() {
                    self.bound()?
                } else {
                    None
                };
                self.expect(">")?;
                return Ok(match of {
                    TypeRefOf::Primitive {
                        name: Primitive::Uint8,
                        ..
                    } => prim_max(Primitive::Bytes, max),
                    of => TypeRefOf::Vector {
                        of: Box::new(of),
                        max,
                    },
                });
            }
            "map" if template => {
                self.next()?;
                self.expect("<")?;
                let key = self.type_spec()?;
                self.expect(",")?;
                let value = self.type_spec()?;
                let max = if self.accept(",").is_some() {
                    self.bound()?
                } else {
                    None
                };
                self.expect(">")?;
                return Ok(TypeRefOf::Map {
                    key: Box::new(key),
                    value: Box::new(value),
                    max,
                });
            }
            "fixed" => {
                self.next()?;
                if self.is("<") {
                    self.balanced("<", ">")?;
                }
                self.warn(&t, "fixed imported as float64");
                return Ok(prim(Primitive::Float64));
            }
            "any" | "Object" | "ValueBase" => {
                self.next()?;
                return Ok(name_ref(format!("{BUILTIN}{word}")));
            }
            _ => {}
        }
        if let Some(int) = int_type_word(word) {
            self.next()?;
            return Ok(prim(int.primitive()));
        }
        if is_not_type(word) {
            return self.fail(Some(&t), "a type");
        }
        let written = self.scoped()?;
        Ok(self.ref_to(&written))
    }

    // Result

    /// Custom primitive standing for references to an interface or component.
    fn object_ref(&mut self, e: &Entity) -> String {
        let q = format!("{}{BUILTIN}Ref", e.q);
        if !self.entities.contains_key(&q) {
            let def = type_def(
                "",
                format!("Reference to a {} object", e.simple),
                FileTypeBody::Primitive {},
            );
            let mut n = Entity::new(q.clone(), format!("{}Ref", e.simple), EntityDef::Type(def));
            n.alt = Some(format!("{}Ref", e.q.split("::").collect::<Vec<_>>().join("_")));
            n.synthetic = true;
            if e.kind() == DeclKind::Interface {
                n.needs = vec![e.q.clone()];
            }
            self.add(n);
        }
        q
    }

    fn builtin(&mut self, word: &str) -> String {
        let q = format!("{BUILTIN}{word}");
        if !self.entities.contains_key(&q) {
            let (simple, description) = builtin_info(word);
            let def = type_def("", description.to_string(), FileTypeBody::Primitive {});
            let mut n = Entity::new(q.clone(), simple.to_string(), EntityDef::Type(def));
            n.synthetic = true;
            self.add(n);
        }
        q
    }

    /// Qualified name of the entity a reference stands for; `?name` when defined nowhere.
    fn target(&mut self, encoded: &str, defined: &[String]) -> String {
        if let Some(word) = encoded.strip_prefix(BUILTIN) {
            return self.builtin(word);
        }
        let (scope, written) = match encoded.find(SEP) {
            Some(k) => (&encoded[..k], &encoded[k + 1..]),
            None => ("", encoded),
        };
        let is_entity = |k: DeclKind| matches!(k, DeclKind::Type | DeclKind::Interface | DeclKind::Component);
        let scope_parts: Vec<String> = if scope.is_empty() {
            Vec::new()
        } else {
            scope.split("::").map(str::to_string).collect()
        };
        let mut q = self.lookup(written, &scope_parts, &is_entity);
        if q.as_ref().is_some_and(|q| !self.entities.contains_key(q)) {
            q = None;
        }
        if q.is_none() {
            // Not visible from there: a single definition of that name anywhere.
            let simple_q = format!("::{written}");
            let simple = last_segment(&simple_q);
            let same: Vec<&String> = defined
                .iter()
                .filter(|d| last_segment(&format!("::{d}")) == simple)
                .collect();
            if same.len() == 1 {
                q = Some(same[0].clone());
            }
        }
        q.unwrap_or_else(|| format!("?{}", last_segment(&format!("::{written}"))))
    }

    fn type_target(&mut self, encoded: &str, defined: &[String]) -> String {
        let q = self.target(encoded, defined);
        match self.entities.get(&q).cloned() {
            Some(e) if e.kind() != DeclKind::Type => self.object_ref(&e),
            _ => q,
        }
    }

    fn finish(mut self, missing: Vec<String>) -> R<IdlFile> {
        // References to qualified names; `?name` when defined nowhere.
        let defined: Vec<String> = self
            .entities
            .values()
            .filter(|e| !e.synthetic)
            .map(|e| e.q.clone())
            .collect();
        let keys: Vec<String> = self.entities.keys().cloned().collect();
        for key in keys {
            let mut e = self.entities[&key].clone();
            rewrite_entity(&mut e, &mut |kind, n| match kind {
                RefKind::Type => self.type_target(n, &defined),
                RefKind::Other => self.target(n, &defined),
            });
            self.entities.insert(key, e);
        }
        let mut const_defs = std::mem::take(&mut self.const_defs);
        for c in &mut const_defs {
            c.def.ty = map_names(&c.def.ty, &mut |n| self.type_target(n, &defined));
        }

        // Project names: simple names, qualified ones for those several entities share.
        let mut names: HashMap<String, String> = HashMap::new();
        let mut renames: Vec<String> = Vec::new();
        {
            let mut assign = |list: Vec<&Entity>, reserved: &dyn Fn(&str) -> bool| {
                let mut count: HashMap<&str, usize> = HashMap::new();
                for e in &list {
                    *count.entry(e.simple.as_str()).or_default() += 1;
                }
                let mut taken: HashSet<String> = HashSet::new();
                for e in &list {
                    let mut n = e.simple.clone();
                    if count[n.as_str()] > 1 || reserved(&n) {
                        n = e
                            .alt
                            .clone()
                            .unwrap_or_else(|| e.q.split("::").collect::<Vec<_>>().join("_"));
                    }
                    while taken.contains(&n) || reserved(&n) {
                        n.push('_');
                    }
                    taken.insert(n.clone());
                    if n != e.simple && !e.synthetic {
                        renames.push(format!("{} imported as {n}", e.q));
                    }
                    names.insert(e.q.clone(), n);
                }
            };
            let all: Vec<&Entity> = self.entities.values().collect();
            assign(
                all.iter()
                    .copied()
                    .filter(|e| e.kind() != DeclKind::Component)
                    .collect(),
                &is_reserved_type_name,
            );
            assign(
                all.iter()
                    .copied()
                    .filter(|e| e.kind() == DeclKind::Component)
                    .collect(),
                &|_| false,
            );
        }
        self.warnings.extend(renames);
        let resolve = |n: &str| -> String {
            match n.strip_prefix('?') {
                Some(rest) => rest.to_string(),
                None => names.get(n).cloned().unwrap_or_else(|| n.to_string()),
            }
        };
        for e in self.entities.values_mut() {
            rewrite_entity(e, &mut |_, n| resolve(n));
            let name = names[&e.q].clone();
            e.set_name(name);
        }
        // Constants: in the namespace of the types and interfaces.
        for c in &mut const_defs {
            c.def.ty = map_names(&c.def.ty, &mut |n| resolve(n));
        }
        let mut taken: HashSet<String> = names.values().cloned().collect();
        let mut const_count: HashMap<String, usize> = HashMap::new();
        for c in &const_defs {
            *const_count.entry(c.def.name.clone()).or_default() += 1;
        }
        let bitmasks: HashSet<&str> = self
            .entities
            .values()
            .filter_map(|e| match &e.def {
                EntityDef::Type(FileTypeDef {
                    name,
                    body: FileTypeBody::Bitmask { .. },
                    ..
                }) => Some(name.as_str()),
                _ => None,
            })
            .collect();
        let mut const_renames: Vec<String> = Vec::new();
        for c in &mut const_defs {
            let simple = c.def.name.clone();
            let mut n = simple.clone();
            if const_count[&n] > 1 || taken.contains(&n) || is_reserved_type_name(&n) {
                n = c.q.split("::").collect::<Vec<_>>().join("_");
            }
            while taken.contains(&n) || is_reserved_type_name(&n) {
                n.push('_');
            }
            taken.insert(n.clone());
            if n != simple {
                const_renames.push(format!("{} imported as {n}", c.q));
            }
            c.def.name = n;
            // A bitmask value: its flags.
            if let TypeRefOf::Ref { target, .. } = &c.def.ty {
                if bitmasks.contains(target.name.as_str()) {
                    if let Some(Value::String(s)) = &c.def.value {
                        c.def.value = Some(Value::Array(vec![Value::String(s.clone())]));
                    }
                }
            }
        }
        self.warnings.extend(const_renames);

        let unique = |v: &[String]| -> Vec<String> {
            let mut seen = HashSet::new();
            v.iter().filter(|x| seen.insert((*x).clone())).cloned().collect()
        };
        let mut file = IdlFile::default();
        let mut written: Vec<(String, String)> = Vec::new();
        for e in self.entities.values() {
            file.origins.insert(
                e.name().to_string(),
                e.file.clone().unwrap_or_else(|| self.main.to_string()),
            );
            match &e.def {
                EntityDef::Type(t) => file.types.push(t.clone()),
                EntityDef::Interface(i) => file.interfaces.push(i.clone()),
                EntityDef::Component(c) => {
                    file.components.push(IdlComponent {
                        needs: unique(&e.needs),
                        qualified: Some(e.q.clone()),
                        ..c.clone()
                    });
                    continue;
                }
            }
            if !e.needs.is_empty() {
                file.needs.insert(e.name().to_string(), unique(&e.needs));
            }
            if !e.synthetic {
                written.push((e.name().to_string(), e.q.clone()));
            }
        }
        // Components come after types in the origins of the web build's `all` order only by
        // insertion; constants follow.
        for c in &const_defs {
            file.origins.insert(c.def.name.clone(), c.file.clone());
        }
        file.constants = const_defs.iter().map(|c| c.def.clone()).collect();
        for (n, q) in &written {
            file.scopes.insert(n.clone(), self.module_of(q));
            file.qualified.insert(n.clone(), q.clone());
        }
        file.missing = missing;
        file.warnings = self.warnings;
        Ok(file)
    }
}

/// Options of [`parse_idl`].
#[derive(Clone, Debug, Default)]
pub struct IdlOptions {
    /// Path of the text: includes are looked up next to it.
    pub file: String,
    /// Files includes may name, by path.
    pub files: IndexMap<String, String>,
}

/// Reads the definitions of an IDL text and the files it includes.
pub fn parse_idl(text: &str, options: &IdlOptions) -> Result<IdlFile, IdlError> {
    let file = normalize_path(&options.file);
    let files = normalize_files(&options.files);
    let mut pre = Preprocessor::new(&files, &file);
    pre.include(&file, text)?;
    let Preprocessor {
        out,
        warnings,
        missing,
        includes,
        ..
    } = pre;
    let mut parsed = Parser::new(out, &file, warnings).parse(missing)?;
    parsed.includes = includes;
    Ok(parsed)
}

/// Reads several IDL files (by path) as one: each in turn, but those another one includes.
pub fn parse_idl_files(files: &IndexMap<String, String>) -> Result<IdlFile, IdlError> {
    let all = normalize_files(files);
    let mut included: HashSet<String> = HashSet::new();
    for (path, text) in &all {
        for m in INCLUDE_RE.captures_iter(text) {
            let name = m.get(1).or_else(|| m.get(2)).map_or("", |g| g.as_str());
            if let Some(found) = find_include(name, path, &all) {
                if &found != path {
                    included.insert(found);
                }
            }
        }
    }
    let mut roots: Vec<&String> = all.keys().filter(|p| !included.contains(*p)).collect();
    if roots.is_empty() {
        roots = all.keys().collect();
    }
    let main = if roots.len() == 1 {
        roots[0].clone()
    } else {
        String::new()
    };
    let mut pre = Preprocessor::new(&all, &main);
    for r in &roots {
        pre.include(r, &all[*r])?;
    }
    let Preprocessor {
        out,
        warnings,
        missing,
        includes,
        ..
    } = pre;
    let mut parsed = Parser::new(out, &main, warnings).parse(missing)?;
    parsed.includes = includes;
    Ok(parsed)
}
