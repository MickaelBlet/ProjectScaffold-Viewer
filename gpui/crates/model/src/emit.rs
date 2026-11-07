//! Text of file data, written as the web build writes it: `JSON.stringify(data, null, 2)` and
//! `YAML.stringify(data, { lineWidth: 0 })` (the `yaml` package's defaults), so that files saved by
//! either build compare equal.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Number, Value};

/// A number as JavaScript prints it.
pub fn js_number(n: &Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(0.);
    let mut buf = ryu_js::Buffer::new();
    buf.format(f).to_string()
}

/// A finite number as file data: integral values as integers, as JavaScript holds them.
pub fn num(f: f64) -> Value {
    if f.fract() == 0. && f.abs() < 9_007_199_254_740_992. {
        Value::Number(Number::from(f as i64))
    } else {
        Number::from_f64(f).map_or(Value::Null, Value::Number)
    }
}

fn json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn json_value(v: &Value, indent: usize, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n)),
        Value::String(s) => json_string(s, out),
        Value::Array(a) if a.is_empty() => out.push_str("[]"),
        Value::Object(o) if o.is_empty() => out.push_str("{}"),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('\n');
                pad(out, indent + 2);
                json_value(x, indent + 2, out);
            }
            out.push('\n');
            pad(out, indent);
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('\n');
                pad(out, indent + 2);
                json_string(k, out);
                out.push_str(": ");
                json_value(x, indent + 2, out);
            }
            out.push('\n');
            pad(out, indent);
            out.push('}');
        }
    }
}

fn pad(out: &mut String, n: usize) {
    out.extend(std::iter::repeat_n(' ', n));
}

/// `JSON.stringify(v, null, 2) + "\n"`.
pub fn to_json(v: &Value) -> String {
    let mut out = String::new();
    json_value(v, 0, &mut out);
    out.push('\n');
    out
}

// YAML

static NEEDS_QUOTES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[\n\t ,\[\]{}#&*!|>'\x22%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$")
        .expect("regex")
});
static DOC_MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(%|---|\.\.\.)").expect("regex"));
/// Plain scalars the core schema reads as something else than a string.
static NOT_STRING: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^(?:~|[Nn]ull|NULL)?$",
        r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$",
        r"^0o[0-7]+$",
        r"^[-+]?[0-9]+$",
        r"^0x[0-9a-fA-F]+$",
        r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$",
        r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$",
        r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$",
    ]
    .iter()
    .map(|r| Regex::new(r).expect("regex"))
    .collect()
});
static TRAILING_SPACE_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[\t ]+$").expect("regex"));

fn double_quoted(s: &str) -> String {
    let mut out = String::new();
    json_string(s, &mut out);
    out
}

fn single_quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn quoted(s: &str) -> String {
    let has_double = s.contains('"');
    let has_single = s.contains('\'');
    if has_double && !has_single {
        single_quoted(s)
    } else {
        double_quoted(s)
    }
}

fn plain_ok(s: &str) -> bool {
    !s.is_empty()
        && !NEEDS_QUOTES.is_match(s)
        && !DOC_MARKER.is_match(s)
        && !NOT_STRING.iter().any(|r| r.is_match(s))
        && !s.starts_with(' ')
        && !s.ends_with(' ')
        && !s.contains('\t')
}

/// A string scalar: plain, quoted, or (multi-line value) a literal block at `indent`.
fn yaml_string(s: &str, indent: usize, key: bool) -> String {
    if !key && s.contains('\n') && !TRAILING_SPACE_LINE.is_match(s) && !s.trim().is_empty() {
        return block_literal(s, indent);
    }
    if !s.contains('\n') && plain_ok(s) {
        s.to_string()
    } else {
        quoted(s)
    }
}

fn block_literal(s: &str, indent: usize) -> String {
    let trailing = s.len() - s.trim_end_matches('\n').len();
    let chomp = match trailing {
        0 => "-",
        1 => "",
        _ => "+",
    };
    let body = if trailing == 1 { &s[..s.len() - 1] } else { s };
    let indicator = if body.starts_with(' ') || body.starts_with('\n') {
        "2"
    } else {
        ""
    };
    let mut out = format!("|{indicator}{chomp}");
    let lines: Vec<&str> = body.split('\n').collect();
    let n = lines.len();
    for (i, line) in lines.iter().enumerate() {
        // `|+` keeps the final newlines: the last split part is empty.
        if trailing > 1 && i == n - 1 && line.is_empty() {
            break;
        }
        out.push('\n');
        if !line.is_empty() {
            pad(&mut out, indent);
            out.push_str(line);
        }
    }
    out
}

fn yaml_scalar(v: &Value, indent: usize) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n),
        Value::String(s) => yaml_string(s, indent, false),
        Value::Array(_) => "[]".into(),
        Value::Object(_) => "{}".into(),
    }
}

fn is_collection(v: &Value) -> bool {
    match v {
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        _ => false,
    }
}

/// Lines of a map at `indent` (the first line without its indentation when `inline`).
fn yaml_map(o: &Map<String, Value>, indent: usize, inline: bool, out: &mut String) {
    for (i, (k, v)) in o.iter().enumerate() {
        if i > 0 || !inline {
            pad(out, indent);
        }
        out.push_str(&yaml_string(k, indent, true));
        out.push(':');
        match v {
            Value::Object(m) if !m.is_empty() => {
                out.push('\n');
                yaml_map(m, indent + 2, false, out);
            }
            Value::Array(a) if !a.is_empty() => {
                out.push('\n');
                yaml_seq(a, indent + 2, false, out);
            }
            _ => {
                out.push(' ');
                out.push_str(&yaml_scalar(v, indent + 2));
                out.push('\n');
            }
        }
    }
}

fn yaml_seq(a: &[Value], indent: usize, inline: bool, out: &mut String) {
    for (i, v) in a.iter().enumerate() {
        if i > 0 || !inline {
            pad(out, indent);
        }
        out.push_str("- ");
        match v {
            Value::Object(m) if is_collection(v) => yaml_map(m, indent + 2, true, out),
            Value::Array(x) if is_collection(v) => yaml_seq(x, indent + 2, true, out),
            _ => {
                out.push_str(&yaml_scalar(v, indent + 2));
                out.push('\n');
            }
        }
    }
}

/// A value as a one-line YAML flow literal (`YAML.stringify(v, { collectionStyle: 'flow' })`):
/// `{ x: 1, y: [ 2, 3 ] }`.
pub fn to_yaml_flow(v: &Value) -> String {
    fn flow_string(s: &str) -> String {
        if !s.contains('\n') && plain_ok(s) && !s.contains(['[', ']', '{', '}', ',']) {
            s.to_string()
        } else {
            quoted(s)
        }
    }
    fn go(v: &Value, top: bool) -> String {
        match v {
            Value::String(s) if top && !s.contains('\n') => yaml_string(s, 0, false),
            Value::String(s) => flow_string(s),
            Value::Array(a) if a.is_empty() => "[]".into(),
            Value::Object(o) if o.is_empty() => "{}".into(),
            Value::Array(a) => format!(
                "[ {} ]",
                a.iter().map(|x| go(x, false)).collect::<Vec<_>>().join(", ")
            ),
            Value::Object(o) => format!(
                "{{ {} }}",
                o.iter()
                    .map(|(k, x)| format!("{}: {}", flow_string(k), go(x, false)))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            v => yaml_scalar(v, 0),
        }
    }
    go(v, true)
}

/// `YAML.stringify(v, { lineWidth: 0 })`.
pub fn to_yaml(v: &Value) -> String {
    let mut out = String::new();
    match v {
        Value::Object(o) if !o.is_empty() => yaml_map(o, 0, false, &mut out),
        Value::Array(a) if !a.is_empty() => yaml_seq(a, 0, false, &mut out),
        _ => {
            out.push_str(&yaml_scalar(v, 0));
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn yaml_like_the_web_build() {
        let v = json!({
            "a": "plain text",
            "b": "15",
            "c": "{}",
            "d": "HAL: x",
            "e": [{"k": 1, "l": [true]}, "x"],
            "f": {},
            "g": [],
            "h": null,
            "i": "two\nlines",
            "j": "say \"hi\"",
            "q": "\"quoted\"",
            "k": 1.5,
        });
        assert_eq!(
            to_yaml(&v),
            "a: plain text\nb: \"15\"\nc: \"{}\"\nd: \"HAL: x\"\ne:\n  - k: 1\n    l:\n      - true\n  - x\nf: {}\ng: []\nh: null\ni: |-\n  two\n  lines\nj: say \"hi\"\nq: '\"quoted\"'\nk: 1.5\n"
        );
    }

    #[test]
    fn json_like_the_web_build() {
        let v = json!({"a": [1, {"b": []}], "c": {}});
        assert_eq!(
            to_json(&v),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": []\n    }\n  ],\n  \"c\": {}\n}\n"
        );
    }
}
