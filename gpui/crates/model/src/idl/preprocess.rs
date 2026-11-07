//! The C-like preprocessor: includes, macros and conditions.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;

use super::expr::{evaluate, truthy, unescape};
use super::lexer::{Token, TokenKind, at, tokenize};
use super::{IdlError, base_name, find_include};

#[derive(Clone)]
struct Macro {
    /// None for an object-like macro.
    params: Option<Vec<String>>,
    variadic: bool,
    body: Vec<Token>,
}

struct Condition {
    /// The current branch is read.
    on: bool,
    /// A branch was read already.
    done: bool,
    /// The enclosing branch is read.
    outer: bool,
}

type R<T> = Result<T, IdlError>;

pub(crate) struct Preprocessor<'a> {
    pub out: Vec<Token>,
    pub warnings: Vec<String>,
    pub missing: Vec<String>,
    /// Files each file includes.
    pub includes: IndexMap<String, Vec<String>>,
    files: &'a IndexMap<String, String>,
    main: String,
    macros: HashMap<String, Macro>,
    /// Files read already: each is read once.
    done: HashSet<String>,
}

static COMMENTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)/\*[\s\S]*?\*/|//.*$").unwrap());
static DIRECTIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*([A-Za-z_][A-Za-z0-9_]*)?\s*([\s\S]*)$").unwrap());
static DEFINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?").unwrap());
static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^"([^"]*)"|^<([^>]*)>"#).unwrap());

impl<'a> Preprocessor<'a> {
    pub fn new(files: &'a IndexMap<String, String>, main: &str) -> Self {
        Preprocessor {
            out: Vec::new(),
            warnings: Vec::new(),
            missing: Vec::new(),
            includes: IndexMap::new(),
            files,
            main: main.to_string(),
            macros: HashMap::new(),
            done: HashSet::new(),
        }
    }

    fn flush(&mut self, run: &mut Vec<Token>) -> R<()> {
        if !run.is_empty() {
            let expanded = self.expand(run, &HashSet::new())?;
            self.out.extend(expanded);
        }
        run.clear();
        Ok(())
    }

    pub fn include(&mut self, path: &str, text: &str) -> R<()> {
        if !self.done.insert(path.to_string()) {
            return Ok(());
        }
        let tokens = tokenize(text, path, 1, true);
        let mut conditions: Vec<Condition> = Vec::new();
        let mut active = true;
        let mut run: Vec<Token> = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            let t = &tokens[i];
            i += 1;
            if t.kind != TokenKind::Directive {
                if !active {
                    continue;
                }
                // IDL 4 `import "file";` reads the file like #include.
                if t.text == "import"
                    && tokens.get(i).is_some_and(|x| x.kind == TokenKind::Str)
                    && tokens.get(i + 1).is_some_and(|x| x.text == ";")
                {
                    self.flush(&mut run)?;
                    let name = unescape(&tokens[i].text);
                    self.include_file(&name, t)?;
                    i += 2;
                    continue;
                }
                run.push(t.clone());
                continue;
            }
            self.flush(&mut run)?;
            let joined = t.text.replace("\\\n", " ");
            let body = COMMENTS.replace_all(&joined, " ");
            let body = &body[1..];
            let caps = DIRECTIVE.captures(body);
            let name = caps.as_ref().and_then(|c| c.get(1)).map_or("", |m| m.as_str());
            let rest = caps.as_ref().and_then(|c| c.get(2)).map_or("", |m| m.as_str());
            match name {
                "if" | "ifdef" | "ifndef" => {
                    let on = active
                        && if name == "if" {
                            self.condition(rest, t)?
                        } else {
                            let first = rest.split_whitespace().next().unwrap_or("");
                            self.macros.contains_key(first) == (name == "ifdef")
                        };
                    conditions.push(Condition {
                        on,
                        done: on,
                        outer: active,
                    });
                    active = on;
                    continue;
                }
                "elif" | "else" => {
                    let Some(c) = conditions.last() else {
                        return Err(IdlError(format!("{}: #{name} without #if", at(t, &self.main))));
                    };
                    let (outer, done) = (c.outer, c.done);
                    let on = outer && !done && (name == "else" || self.condition(rest, t)?);
                    let c = conditions.last_mut().expect("condition");
                    c.on = on;
                    c.done = c.done || on;
                    active = on;
                    continue;
                }
                "endif" => {
                    let Some(c) = conditions.pop() else {
                        return Err(IdlError(format!("{}: #endif without #if", at(t, &self.main))));
                    };
                    active = c.outer;
                    continue;
                }
                _ => {}
            }
            if !active {
                continue;
            }
            match name {
                "define" => self.define(rest, t)?,
                "undef" => {
                    self.macros.remove(rest.trim());
                }
                "include" | "import" => {
                    let mut spec = rest.trim().to_string();
                    if !spec.starts_with(['"', '<']) {
                        let toks = tokenize(&spec, path, t.line, false);
                        spec = self
                            .expand(&toks, &HashSet::new())?
                            .iter()
                            .map(|x| x.text.as_str())
                            .collect();
                    }
                    let Some(m) = QUOTED.captures(&spec) else {
                        return Err(IdlError(format!(
                            "{}: #include expects \"file\" or <file>",
                            at(t, &self.main)
                        )));
                    };
                    let name = m
                        .get(1)
                        .or_else(|| m.get(2))
                        .map_or("", |g| g.as_str())
                        .to_string();
                    self.include_file(&name, t)?;
                }
                "error" => {
                    return Err(IdlError(format!("{}: #error {}", at(t, &self.main), rest.trim())));
                }
                "warning" => {
                    let w = format!("{}: {}", at(t, &self.main), rest.trim());
                    self.warnings.push(w);
                }
                "" | "pragma" | "line" | "ident" | "sccs" => {}
                _ => {
                    let w = format!("{}: #{name} ignored", at(t, &self.main));
                    self.warnings.push(w);
                }
            }
        }
        self.flush(&mut run)?;
        if !conditions.is_empty() {
            let b = base_name(path);
            return Err(IdlError(format!(
                "{}: missing #endif",
                if b.is_empty() { "IDL" } else { b }
            )));
        }
        Ok(())
    }

    fn include_file(&mut self, name: &str, t: &Token) -> R<()> {
        let files = self.files;
        let Some(found) = find_include(name, &t.file, files) else {
            if !self.missing.iter().any(|m| m == name) {
                self.missing.push(name.to_string());
                let w = format!("{}: {name} not found", at(t, &self.main));
                self.warnings.push(w);
            }
            return Ok(());
        };
        let from = self.includes.entry(t.file.clone()).or_default();
        if found != t.file && !from.contains(&found) {
            from.push(found.clone());
        }
        self.include(&found, &files[&found])
    }

    fn define(&mut self, rest: &str, t: &Token) -> R<()> {
        let rest = rest.trim();
        let Some(m) = DEFINE.captures(rest) else {
            return Err(IdlError(format!("{}: #define expects a name", at(t, &self.main))));
        };
        let whole = m.get(0).expect("whole match");
        let name = m[1].to_string();
        let body = tokenize(&rest[whole.end()..], &t.file, t.line, false);
        let Some(list) = m.get(3) else {
            self.macros.insert(
                name,
                Macro {
                    params: None,
                    variadic: false,
                    body,
                },
            );
            return Ok(());
        };
        let mut params: Vec<String> = list
            .as_str()
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        let variadic = params.last().is_some_and(|p| p == "...");
        if variadic {
            *params.last_mut().expect("param") = "__VA_ARGS__".into();
        }
        self.macros.insert(
            name,
            Macro {
                params: Some(params),
                variadic,
                body,
            },
        );
        Ok(())
    }

    /// `#if` / `#elif` condition.
    fn condition(&self, rest: &str, t: &Token) -> R<bool> {
        let raw = tokenize(rest, &t.file, t.line, false);
        let mut tokens: Vec<Token> = Vec::new();
        let mut i = 0;
        while i < raw.len() {
            let x = &raw[i];
            if x.text != "defined" {
                tokens.push(x.clone());
                i += 1;
                continue;
            }
            let paren = raw.get(i + 1).is_some_and(|y| y.text == "(");
            let name = raw
                .get(i + if paren { 2 } else { 1 })
                .map_or("", |y| y.text.as_str());
            i += if paren { 4 } else { 2 };
            let on = self.macros.contains_key(name);
            tokens.push(Token::made(x, TokenKind::Int, if on { "1" } else { "0" }));
        }
        // Names left after expansion are 0, `true` is 1 (C++).
        let expanded: Vec<Token> = self
            .expand(&tokens, &HashSet::new())?
            .into_iter()
            .map(|x| {
                if x.kind == TokenKind::Ident {
                    let text = if x.text == "true" { "1" } else { "0" };
                    Token {
                        kind: TokenKind::Int,
                        text: text.into(),
                        ..x
                    }
                } else {
                    x
                }
            })
            .collect();
        Ok(truthy(&evaluate(&expanded, &|_| None, &self.main)?))
    }

    /// Macro expansion; `hidden` macros are being expanded (no recursion).
    fn expand(&self, tokens: &[Token], hidden: &HashSet<String>) -> R<Vec<Token>> {
        let mut out: Vec<Token> = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            let t = &tokens[i];
            i += 1;
            if t.kind == TokenKind::Ident && t.text == "__LINE__" {
                out.push(Token {
                    kind: TokenKind::Int,
                    text: t.line.to_string(),
                    ..t.clone()
                });
                continue;
            }
            if t.kind == TokenKind::Ident && t.text == "__FILE__" {
                let text = serde_json::to_string(base_name(&t.file)).unwrap_or_default();
                out.push(Token {
                    kind: TokenKind::Str,
                    text,
                    ..t.clone()
                });
                continue;
            }
            let m = if t.kind == TokenKind::Ident && !hidden.contains(&t.text) {
                self.macros.get(&t.text)
            } else {
                None
            };
            let Some(m) = m else {
                out.push(t.clone());
                continue;
            };
            if m.params.is_some() && tokens.get(i).map(|x| x.text.as_str()) != Some("(") {
                out.push(t.clone());
                continue;
            }
            let mut body = m.body.clone();
            if let Some(params) = &m.params {
                let mut args: Vec<Vec<Token>> = vec![Vec::new()];
                let mut depth = 0i32;
                let mut j = i + 1;
                while j < tokens.len() {
                    let a = &tokens[j];
                    if a.text == ")" && depth == 0 {
                        break;
                    }
                    if a.text == "(" {
                        depth += 1;
                    } else if a.text == ")" {
                        depth -= 1;
                    } else if a.text == "," && depth == 0 && !(m.variadic && args.len() >= params.len()) {
                        args.push(Vec::new());
                        j += 1;
                        continue;
                    }
                    args.last_mut().expect("arg").push(a.clone());
                    j += 1;
                }
                if j == tokens.len() {
                    return Err(IdlError(format!(
                        "{}: unterminated use of macro {}",
                        at(t, &self.main),
                        t.text
                    )));
                }
                i = j + 1;
                body = self.substitute(m, params, &args, hidden)?;
            }
            let placed: Vec<Token> = body
                .into_iter()
                .enumerate()
                .map(|(k, b)| Token {
                    file: t.file.clone(),
                    line: t.line,
                    doc: if k > 0 { String::new() } else { t.doc.clone() },
                    trail: String::new(),
                    ..b
                })
                .collect();
            let mut inner = hidden.clone();
            inner.insert(t.text.clone());
            out.extend(self.expand(&placed, &inner)?);
        }
        Ok(out)
    }

    /// Body of a function-like macro with its arguments: `#` makes a string, `##` pastes tokens.
    fn substitute(
        &self,
        m: &Macro,
        params: &[String],
        args: &[Vec<Token>],
        hidden: &HashSet<String>,
    ) -> R<Vec<Token>> {
        let arg = |name: &str| -> Option<&[Token]> {
            let k = params.iter().position(|p| p == name)?;
            Some(args.get(k).map_or(&[][..], Vec::as_slice))
        };
        let mut out: Vec<Token> = Vec::new();
        let mut paste = false;
        let mut i = 0;
        while i < m.body.len() {
            let b = &m.body[i];
            if b.text == "##" {
                paste = true;
                i += 1;
                continue;
            }
            let next = m.body.get(i + 1).map_or("", |x| x.text.as_str());
            let part: Vec<Token> = if b.text == "#" && arg(next).is_some() {
                i += 1;
                let text = arg(&m.body[i].text)
                    .unwrap_or(&[])
                    .iter()
                    .map(|x| x.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                vec![Token {
                    kind: TokenKind::Str,
                    text: serde_json::to_string(&text).unwrap_or_default(),
                    ..b.clone()
                }]
            } else {
                match arg(&b.text) {
                    // Operands of `##` are not expanded.
                    Some(a) if paste || next == "##" => a.to_vec(),
                    Some(a) => self.expand(a, hidden)?,
                    None => vec![b.clone()],
                }
            };
            if paste && !out.is_empty() && !part.is_empty() {
                let last = out.pop().expect("last");
                let joined = tokenize(&format!("{}{}", last.text, part[0].text), &b.file, b.line, false);
                out.extend(joined);
                out.extend(part.into_iter().skip(1));
            } else {
                out.extend(part);
            }
            paste = false;
            i += 1;
        }
        Ok(out)
    }
}
