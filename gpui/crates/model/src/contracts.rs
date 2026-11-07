//! Contracts of modules and methods: preconditions, postconditions and invariants, free expressions
//! whose names are checked against what they may use. Port of `contracts.ts`.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

/// Words of the expressions that name nothing of the project.
pub const CONTRACT_WORDS: &[&str] = &[
    "true", "false", "null", "nullptr", "None", "and", "or", "not", "in", "is", "implies", "this", "self",
    "old", "len", "size", "length", "count", "empty", "abs", "min", "max", "sum", "all", "any", "exists",
    "forall", "contains",
];

static STRINGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#).expect("regex"));
static IDENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z_][A-Za-z0-9_]*").expect("regex"));
static MEMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\.|::)\s*$").expect("regex"));

/// Names an expression uses: identifiers outside of string literals, not members nor numbers.
pub fn contract_names(expression: &str) -> Vec<String> {
    let text = STRINGS.replace_all(expression, "\"\"");
    let mut names: Vec<String> = Vec::new();
    for m in IDENT.find_iter(&text) {
        let before = &text[..m.start()];
        if MEMBER.is_match(before) || before.ends_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        if !names.iter().any(|n| n == m.as_str()) {
            names.push(m.as_str().to_string());
        }
    }
    names
}

/// Names of an expression not in `known` nor usual words.
pub fn unknown_names(expression: &str, known: &HashSet<String>) -> Vec<String> {
    contract_names(expression)
        .into_iter()
        .filter(|n| !known.contains(n) && !CONTRACT_WORDS.contains(&n.as_str()))
        .collect()
}
