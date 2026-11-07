//! Tokens of IDL text and of macro bodies.

use std::sync::LazyLock;

use regex::Regex;

use super::base_name;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TokenKind {
    Ident,
    Int,
    Float,
    Str,
    Char,
    Punct,
    Directive,
}

#[derive(Clone, Debug)]
pub(crate) struct Token {
    pub kind: TokenKind,
    pub text: String,
    pub file: String,
    pub line: usize,
    /// Comment block right above the token.
    pub doc: String,
    /// Comment following the token on its line.
    pub trail: String,
}

impl Token {
    /// A token made from `from` (its place) with another kind and text, without comments.
    pub fn made(from: &Token, kind: TokenKind, text: impl Into<String>) -> Token {
        Token {
            kind,
            text: text.into(),
            file: from.file.clone(),
            line: from.line,
            doc: String::new(),
            trail: String::new(),
        }
    }
}

/// Where a token is, for messages: its line, and its file when not the main one.
pub(crate) fn at(t: &Token, main: &str) -> String {
    if !t.file.is_empty() && t.file != main {
        format!("Line {} of {}", t.line, base_name(&t.file))
    } else {
        format!("Line {}", t.line)
    }
}

fn clean_comment(raw: &str) -> String {
    static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^//[/!]?<?").unwrap());
    static BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/\*[*!]?<?|\*/$").unwrap());
    static LEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\*?\s?").unwrap());
    let body = if raw.starts_with("//") {
        LINE.replace(raw, "")
    } else {
        BLOCK.replace_all(raw, "")
    };
    body.split('\n')
        .map(|l| LEAD.replace(l, "").trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"([\s\x{FEFF}]+)"#,
        r#"|(//[^\n]*|/\*[\s\S]*?\*/)"#,
        r#"|(L?"(?:[^"\\\n]|\\.)*")"#,
        r#"|(L?'(?:[^'\\\n]|\\.)*')"#,
        r#"|([A-Za-z_][A-Za-z0-9_]*)"#,
        r#"|(0[xX][0-9a-fA-F]+[uUlL]*|(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[fFdDlL]?|[0-9]+[eE][+-]?[0-9]+[fFdDlL]?|[0-9]+[dD]|[0-9]+[uUlL]*)"#,
        r#"|(::|<<|&&|\|\||==|!=|<=|>=|##|\.\.\.|\S)"#
    ))
    .unwrap()
});
static DIRECTIVE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#(?:[^\n\\]|\\[\s\S])*").unwrap());
static INT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0[xX]|^[0-9]+[uUlL]*$").unwrap());

/// Tokens of a file; `#` lines are directive tokens unless `directives` is false (macro bodies).
pub(crate) fn tokenize(src: &str, file: &str, first_line: usize, directives: bool) -> Vec<Token> {
    let text = src.replace("\r\n", "\n").replace('\r', "\n");
    let mut tokens: Vec<Token> = Vec::new();
    let mut line = first_line;
    let mut doc: Vec<String> = Vec::new();
    // Comments after the last token on its line are its trailing comment.
    let mut same_line = false;
    let mut line_start = true;
    let mut pos = 0;
    while pos < text.len() {
        if directives && line_start && text.as_bytes()[pos] == b'#' {
            let d = DIRECTIVE_RE.find_at(&text, pos).map_or("#", |m| m.as_str());
            tokens.push(Token {
                kind: TokenKind::Directive,
                text: d.to_string(),
                file: file.to_string(),
                line,
                doc: String::new(),
                trail: String::new(),
            });
            doc.clear();
            line += d.matches('\n').count();
            pos += d.len();
            line_start = false;
            same_line = false;
            continue;
        }
        let Some(m) = TOKEN_RE.captures_at(&text, pos) else {
            break;
        };
        let whole = m.get(0).expect("whole match");
        let s = whole.as_str();
        pos = whole.end();
        let newlines = s.matches('\n').count();
        if m.get(1).is_some() {
            if newlines > 0 {
                same_line = false;
                line_start = true;
            }
            // A blank line detaches a comment from what follows.
            if newlines > 1 {
                doc.clear();
            }
        } else if m.get(2).is_some() {
            let comment = clean_comment(s);
            match tokens.last_mut() {
                Some(last) if same_line && last.kind != TokenKind::Directive => {
                    if last.trail.is_empty() {
                        last.trail = comment;
                    } else {
                        last.trail = format!("{}\n{comment}", last.trail);
                    }
                }
                _ => {
                    if !comment.is_empty() {
                        doc.push(comment);
                    }
                }
            }
        } else {
            let kind = if m.get(3).is_some() {
                TokenKind::Str
            } else if m.get(4).is_some() {
                TokenKind::Char
            } else if m.get(5).is_some() {
                TokenKind::Ident
            } else if m.get(6).is_some() {
                if INT_RE.is_match(s) {
                    TokenKind::Int
                } else {
                    TokenKind::Float
                }
            } else {
                TokenKind::Punct
            };
            tokens.push(Token {
                kind,
                text: s.to_string(),
                file: file.to_string(),
                line,
                doc: doc.join("\n"),
                trail: String::new(),
            });
            doc.clear();
            same_line = true;
            line_start = false;
        }
        line += newlines;
    }
    tokens
}
