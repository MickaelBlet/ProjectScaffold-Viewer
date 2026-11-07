//! Constant expressions (preprocessor conditions, array sizes and bounds, annotation values).

use super::IdlError;
use super::lexer::{Token, TokenKind, at};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ConstValue {
    Int(i128),
    Float(f64),
    Str(String),
    Bool(bool),
}

/// A number as JavaScript prints it.
pub(crate) fn js_f64(f: f64) -> String {
    ryu_js::Buffer::new().format(f).to_string()
}

impl ConstValue {
    /// `String(value)`.
    pub fn display(&self) -> String {
        match self {
            ConstValue::Int(i) => i.to_string(),
            ConstValue::Float(f) => js_f64(*f),
            ConstValue::Str(s) => s.clone(),
            ConstValue::Bool(b) => b.to_string(),
        }
    }

    /// `Number(value)`.
    pub fn number(&self) -> f64 {
        match self {
            ConstValue::Int(i) => *i as f64,
            ConstValue::Float(f) => *f,
            ConstValue::Bool(b) => f64::from(u8::from(*b)),
            ConstValue::Str(s) => {
                let t = s.trim();
                if t.is_empty() {
                    0.
                } else {
                    t.parse().unwrap_or(f64::NAN)
                }
            }
        }
    }
}

pub(crate) fn unescape(literal: &str) -> String {
    let s = literal.strip_prefix('L').unwrap_or(literal);
    let chars: Vec<char> = s.chars().collect();
    let body = if chars.len() >= 2 {
        &chars[1..chars.len() - 1]
    } else {
        &[][..]
    };
    let mut out = String::new();
    let mut i = 0;
    while i < body.len() {
        let c = body[i];
        if c != '\\' || i + 1 >= body.len() || body[i + 1] == '\n' {
            out.push(c);
            i += 1;
            continue;
        }
        let e = body[i + 1];
        let digits = |from: usize, max: usize, radix: u32| -> usize {
            body[from..]
                .iter()
                .take(max)
                .take_while(|d| d.is_digit(radix))
                .count()
        };
        let take = |from: usize, n: usize, radix: u32| -> char {
            let text: String = body[from..from + n].iter().collect();
            char::from_u32(u32::from_str_radix(&text, radix).unwrap_or(0xFFFD)).unwrap_or('\u{FFFD}')
        };
        let (max, radix, skip) = match e {
            'x' => (2, 16, 2),
            'u' => (4, 16, 2),
            '0'..='7' => (3, 8, 1),
            _ => (0, 10, 1),
        };
        let n = if max > 0 { digits(i + skip, max, radix) } else { 0 };
        if max > 0 && n > 0 {
            out.push(take(i + skip, n, radix));
            i += skip + n;
            continue;
        }
        out.push(match e {
            'n' => '\n',
            't' => '\t',
            'r' => '\r',
            'v' => '\u{0B}',
            'b' => '\u{08}',
            'f' => '\u{0C}',
            'a' => '\u{07}',
            other => other,
        });
        i += 2;
    }
    out
}

fn literal(t: &Token) -> Option<ConstValue> {
    match t.kind {
        TokenKind::Int => {
            let s = t.text.trim_end_matches(['u', 'U', 'l', 'L']);
            let n = if let Some(h) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                i128::from_str_radix(h, 16).ok()
            } else if s.len() > 1 && s.starts_with('0') && s.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
                i128::from_str_radix(&s[1..], 8).ok()
            } else {
                s.parse().ok()
            };
            n.map(ConstValue::Int)
        }
        TokenKind::Float => {
            let s = match t.text.chars().last() {
                Some(c) if "fFdDlL".contains(c) => &t.text[..t.text.len() - 1],
                _ => t.text.as_str(),
            };
            Some(ConstValue::Float(s.parse().unwrap_or(f64::NAN)))
        }
        TokenKind::Str | TokenKind::Char => Some(ConstValue::Str(unescape(&t.text))),
        _ => None,
    }
}

pub(crate) fn truthy(v: &ConstValue) -> bool {
    !matches!(v, ConstValue::Int(0) | ConstValue::Bool(false))
        && !matches!(v, ConstValue::Float(f) if *f == 0.)
        && !matches!(v, ConstValue::Str(s) if s.is_empty())
}

const BINARY_LEVELS: &[&[&str]] = &[
    &["||"],
    &["&&"],
    &["|"],
    &["^"],
    &["&"],
    &["==", "!="],
    &["<", ">", "<=", ">="],
    &["<<", ">>"],
    &["+", "-"],
    &["*", "/", "%"],
];

enum Num {
    I(i128),
    F(f64),
}

impl Num {
    fn f(&self) -> f64 {
        match self {
            Num::I(i) => *i as f64,
            Num::F(f) => *f,
        }
    }
}

struct Eval<'a> {
    tokens: Vec<Token>,
    i: usize,
    last_raw: Option<Token>,
    main: &'a str,
    lookup: &'a dyn Fn(&str) -> Option<ConstValue>,
}

type R<T> = Result<T, IdlError>;

/// Value of a C-like constant expression; `lookup` gives the value of a (scoped) name.
pub(crate) fn evaluate(
    raw: &[Token],
    lookup: &dyn Fn(&str) -> Option<ConstValue>,
    main: &str,
) -> Result<ConstValue, IdlError> {
    // `>>` comes as two tokens: it also closes nested templates.
    let mut tokens: Vec<Token> = Vec::new();
    for t in raw {
        match tokens.last_mut() {
            Some(last) if last.text == ">" && t.text == ">" => last.text = ">>".into(),
            _ => tokens.push(t.clone()),
        }
    }
    let mut e = Eval {
        tokens,
        i: 0,
        last_raw: raw.last().cloned(),
        main,
        lookup,
    };
    let v = e.ternary()?;
    if e.i < e.tokens.len() {
        let t = e.tokens[e.i].clone();
        return e.fail(Some(&t), &format!("unexpected '{}'", t.text));
    }
    Ok(v)
}

impl Eval<'_> {
    fn fail<T>(&self, t: Option<&Token>, msg: &str) -> R<T> {
        let near = t.or(self.last_raw.as_ref());
        Err(IdlError(match near {
            Some(n) => format!("{}: {msg}", at(n, self.main)),
            None => msg.to_string(),
        }))
    }

    fn int(&self, v: &ConstValue, t: &Token) -> R<i128> {
        match v {
            ConstValue::Int(i) => Ok(*i),
            ConstValue::Bool(b) => Ok(i128::from(*b)),
            ConstValue::Float(f) if f.fract() == 0. && f.is_finite() => Ok(*f as i128),
            ConstValue::Str(s) if s.chars().count() == 1 => Ok(s.chars().next().map_or(0, |c| c as i128)),
            other => {
                let shown = match other {
                    ConstValue::Str(s) => serde_json::to_string(s).unwrap_or_default(),
                    o => o.display(),
                };
                self.fail(Some(t), &format!("{shown} is not an integer"))
            }
        }
    }

    fn num(&self, v: &ConstValue, t: &Token) -> R<Num> {
        match v {
            ConstValue::Float(f) => Ok(Num::F(*f)),
            other => Ok(Num::I(self.int(other, t)?)),
        }
    }

    fn compare(&self, a: &ConstValue, b: &ConstValue, t: &Token) -> R<std::cmp::Ordering> {
        use std::cmp::Ordering::{Equal, Greater, Less};
        if let (ConstValue::Str(x), ConstValue::Str(y)) = (a, b) {
            return Ok(x.cmp(y));
        }
        let (x, y) = (self.num(a, t)?, self.num(b, t)?);
        Ok(match (&x, &y) {
            (Num::I(p), Num::I(q)) => p.cmp(q),
            _ => {
                let (p, q) = (x.f(), y.f());
                if p < q {
                    Less
                } else if p > q {
                    Greater
                } else {
                    Equal
                }
            }
        })
    }

    fn binary(&self, op: &str, a: &ConstValue, b: &ConstValue, t: &Token) -> R<ConstValue> {
        use std::cmp::Ordering::{Equal, Greater, Less};
        let bool_int = |c: bool| ConstValue::Int(i128::from(c));
        match op {
            "||" => return Ok(bool_int(truthy(a) || truthy(b))),
            "&&" => return Ok(bool_int(truthy(a) && truthy(b))),
            "|" => return Ok(ConstValue::Int(self.int(a, t)? | self.int(b, t)?)),
            "^" => return Ok(ConstValue::Int(self.int(a, t)? ^ self.int(b, t)?)),
            "&" => return Ok(ConstValue::Int(self.int(a, t)? & self.int(b, t)?)),
            "==" => return Ok(bool_int(self.compare(a, b, t)? == Equal)),
            "!=" => return Ok(bool_int(self.compare(a, b, t)? != Equal)),
            "<" => return Ok(bool_int(self.compare(a, b, t)? == Less)),
            ">" => return Ok(bool_int(self.compare(a, b, t)? == Greater)),
            "<=" => return Ok(bool_int(self.compare(a, b, t)? != Greater)),
            ">=" => return Ok(bool_int(self.compare(a, b, t)? != Less)),
            "<<" | ">>" => {
                let (x, y) = (self.int(a, t)?, self.int(b, t)?);
                let left = (op == "<<") == (y >= 0);
                let n = y.unsigned_abs();
                return Ok(ConstValue::Int(if left {
                    if n >= 128 { 0 } else { x.wrapping_shl(n as u32) }
                } else if n >= 128 {
                    if x < 0 { -1 } else { 0 }
                } else {
                    x >> n
                }));
            }
            _ => {}
        }
        let (x, y) = (self.num(a, t)?, self.num(b, t)?);
        if let (Num::I(p), Num::I(q)) = (&x, &y) {
            if (op == "/" || op == "%") && *q == 0 {
                return self.fail(Some(t), "division by zero");
            }
            return Ok(ConstValue::Int(match op {
                "+" => p.wrapping_add(*q),
                "-" => p.wrapping_sub(*q),
                "*" => p.wrapping_mul(*q),
                "/" => p.wrapping_div(*q),
                _ => p.wrapping_rem(*q),
            }));
        }
        if op == "%" {
            return self.fail(Some(t), "% of a floating-point value");
        }
        let (p, q) = (x.f(), y.f());
        Ok(ConstValue::Float(match op {
            "+" => p + q,
            "-" => p - q,
            "*" => p * q,
            _ => p / q,
        }))
    }

    fn level(&mut self, n: usize) -> R<ConstValue> {
        if n == BINARY_LEVELS.len() {
            return self.unary();
        }
        let mut a = self.level(n + 1)?;
        while let Some(t) = self.tokens.get(self.i).cloned() {
            if t.kind != TokenKind::Punct || !BINARY_LEVELS[n].contains(&t.text.as_str()) {
                break;
            }
            self.i += 1;
            let b = self.level(n + 1)?;
            a = self.binary(&t.text, &a, &b, &t)?;
        }
        Ok(a)
    }

    fn ternary(&mut self) -> R<ConstValue> {
        let c = self.level(0)?;
        if self.tokens.get(self.i).map(|t| t.text.as_str()) != Some("?") {
            return Ok(c);
        }
        self.i += 1;
        let a = self.ternary()?;
        if self.tokens.get(self.i).map(|t| t.text.as_str()) != Some(":") {
            let t = self.tokens.get(self.i).cloned();
            return self.fail(t.as_ref(), "expected ':'");
        }
        self.i += 1;
        let b = self.ternary()?;
        Ok(if truthy(&c) { a } else { b })
    }

    fn unary(&mut self) -> R<ConstValue> {
        let Some(t) = self.tokens.get(self.i).cloned() else {
            self.i += 1;
            return self.fail(None, "expected a constant");
        };
        self.i += 1;
        match t.text.as_str() {
            "-" => {
                let v = self.unary()?;
                return Ok(match v {
                    ConstValue::Float(f) => ConstValue::Float(-f),
                    other => ConstValue::Int(self.int(&other, &t)?.wrapping_neg()),
                });
            }
            "+" => return self.unary(),
            "~" => {
                let v = self.unary()?;
                return Ok(ConstValue::Int(!self.int(&v, &t)?));
            }
            "!" => return Ok(ConstValue::Int(i128::from(!truthy(&self.unary()?)))),
            "(" => {
                let v = self.ternary()?;
                let close = self.tokens.get(self.i).cloned();
                self.i += 1;
                if close.as_ref().map(|c| c.text.as_str()) != Some(")") {
                    let near = self.tokens.get(self.i - 1).cloned();
                    return self.fail(near.as_ref(), "expected ')'");
                }
                return Ok(v);
            }
            _ => {}
        }
        if let Some(v) = literal(&t) {
            return Ok(v);
        }
        if t.kind == TokenKind::Ident || t.text == "::" {
            let mut name = t.text.clone();
            while let Some(n) = self.tokens.get(self.i) {
                if n.text == "::" || (name.ends_with("::") && n.kind == TokenKind::Ident) {
                    name.push_str(&n.text);
                    self.i += 1;
                } else {
                    break;
                }
            }
            if let Some(v) = (self.lookup)(&name) {
                return Ok(v);
            }
        }
        self.fail(Some(&t), &format!("'{}' is not a constant", t.text))
    }
}
