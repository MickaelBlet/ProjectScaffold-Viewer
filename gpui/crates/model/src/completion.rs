//! Completion of the project YAML from the file's JSON Schema: the keys an object may have, and the
//! values a key takes (schema enums and constants, booleans, names of the project's interfaces,
//! modules and types). The structure around the caret is read from the indentation, so that it
//! works on text that does not parse yet. Port of `completion.ts`.
//!
//! Positions are byte offsets in the text (the web build uses UTF-16 offsets).

use std::sync::{LazyLock, OnceLock};

use indexmap::IndexMap;
use regex::Regex;
use serde_json::Value;

use crate::project::{DataPath, PathKey};

static FILE_SCHEMA: OnceLock<Value> = OnceLock::new();

/// JSON Schema of the project file (`schema/scaffold.schema.json`, the web build's
/// `z.toJSONSchema(FileProjectSchema, { target: 'draft-2020-12', io: 'input' })`).
pub fn file_schema() -> &'static Value {
    FILE_SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../schema/scaffold.schema.json"))
            .expect("scaffold.schema.json is valid JSON")
    })
}

/// Names of the project, for values that reference them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectNames {
    pub interfaces: Vec<String>,
    /// Paths of the project's modules.
    pub modules: Vec<String>,
    /// Paths of the placed modules of each dependency, by dependency name.
    pub placed: IndexMap<String, Vec<String>>,
    /// Qualified type names (`Core.Sensor.Filter`, `Dependency/Core.Sensor.Filter`).
    pub types: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub label: String,
    /// Text replacing the word at the caret.
    pub insert: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompletionResult {
    /// Range of the text the completion replaces.
    pub from: usize,
    pub to: usize,
    /// Typed part of the word, which filters the items.
    pub prefix: String,
    /// A value after `key: ` rather than a key.
    pub value: bool,
    pub items: Vec<Completion>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Map,
    Seq,
}

#[derive(Clone, Debug)]
struct Frame {
    kind: Kind,
    col: usize,
    /// Map: last key seen, and the scalar values of its keys.
    key: Option<String>,
    values: IndexMap<String, String>,
    /// Sequence: index of the last item.
    index: usize,
}

static KEY_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s#'"\[\]{},:][^#]*?)\s*:(?:\s+(.*?))?\s*$"#)
        .expect("regex")
});
static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-(?: +|$)").expect("regex"));
static TRAILING_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+#.*$").expect("regex"));
static HEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^( *)((?:- +)*)").expect("regex"));
static VALUE_AT_CARET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?):\s+(\S*)$").expect("regex"));
static NEEDS_QUOTES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:true|false|null|~|[-+.0-9].*|.*[:#].*)$").expect("regex"));
static LINE_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ *(?:-(?: +|$))*").expect("regex"));

fn unquote(s: &str) -> String {
    let b = s.as_bytes();
    if b.len() >= 2 && matches!(b[0], b'"' | b'\'') && matches!(b[b.len() - 1], b'"' | b'\'') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Close the frames deeper than `col`: a key at a column ends the sequences at that column too
/// (`key:` then `- item` at the same indent), an item does not end the mapping owning it.
fn pop_to(stack: &mut Vec<Frame>, col: usize, sequences: bool) {
    while let Some(top) = stack.last() {
        if top.col < col || (top.col == col && !(sequences && top.kind == Kind::Seq)) {
            return;
        }
        stack.pop();
    }
}

/// Frames of the mappings and sequences open at the end of `lines`.
fn frames<'a>(lines: impl IntoIterator<Item = &'a str>) -> Vec<Frame> {
    let mut stack: Vec<Frame> = Vec::new();
    // Column that the lines of a block scalar are indented beyond.
    let mut block: Option<usize> = None;
    for line in lines {
        let indent = indent_of(line);
        if let Some(b) = block {
            if line.trim().is_empty() || indent > b {
                continue;
            }
            block = None;
        }
        let content = &line[indent..];
        if content.is_empty() || content.starts_with('#') {
            continue;
        }
        let mut col = indent;
        let mut rest = content;
        // Sequence items.
        while let Some(m) = ITEM.find(rest) {
            pop_to(&mut stack, col, false);
            match stack.last_mut() {
                Some(top) if top.kind == Kind::Seq && top.col == col => top.index += 1,
                _ => stack.push(Frame {
                    kind: Kind::Seq,
                    col,
                    key: None,
                    values: IndexMap::new(),
                    index: 0,
                }),
            }
            col += m.end();
            rest = &rest[m.end()..];
        }
        let Some(key) = KEY_LINE.captures(rest) else {
            continue;
        };
        pop_to(&mut stack, col, true);
        let name = unquote(&key[1]);
        let value = key.get(2).map_or("", |m| m.as_str());
        if !matches!(stack.last(), Some(t) if t.kind == Kind::Map && t.col == col) {
            stack.push(Frame {
                kind: Kind::Map,
                col,
                key: None,
                values: IndexMap::new(),
                index: 0,
            });
        }
        let top = stack.last_mut().expect("pushed");
        top.key = Some(name.clone());
        if !value.is_empty() && !value.starts_with('#') {
            top.values
                .insert(name, unquote(&TRAILING_COMMENT.replace(value, "")));
        }
        if value.starts_with(['|', '>']) {
            block = Some(col);
        }
    }
    stack
}

/// Data path of the value at the top of the frames.
fn path_of(stack: &[Frame]) -> DataPath {
    stack
        .iter()
        .map(|f| match f.kind {
            Kind::Map => PathKey::Key(f.key.clone().unwrap_or_default()),
            Kind::Seq => PathKey::Index(f.index),
        })
        .collect()
}

/// Where the caret is in the data: the path of its line (a key, or the list item it starts), and the
/// `name` (`module` for the modules of an import) of each list item along it, where written above.
pub fn structure_at(text: &str, pos: usize) -> (DataPath, Vec<Option<String>>) {
    let end = text[pos..].find('\n').map_or(text.len(), |i| pos + i);
    let stack = frames(text[..end].split('\n'));
    let names = stack
        .iter()
        .enumerate()
        .map(|(i, f)| match (f.kind, stack.get(i + 1)) {
            (Kind::Seq, Some(item)) if item.kind == Kind::Map => item
                .values
                .get("name")
                .or_else(|| item.values.get("module"))
                .cloned(),
            _ => None,
        })
        .collect();
    (path_of(&stack), names)
}

fn field<'a>(s: &'a Value, name: &str) -> Option<&'a Value> {
    s.get(name)
}

/// Dereferenced schemas, with their alternatives flattened.
fn expand<'a>(root: &'a Value, list: &[&'a Value]) -> Vec<&'a Value> {
    fn visit<'a>(root: &'a Value, s: &'a Value, out: &mut Vec<&'a Value>) {
        if let Some(r) = field(s, "$ref").and_then(Value::as_str) {
            let name = r.replacen("#/$defs/", "", 1);
            if let Some(target) = field(root, "$defs").and_then(|d| d.get(&name)) {
                visit(root, target, out);
            }
            return;
        }
        match field(s, "anyOf")
            .or_else(|| field(s, "oneOf"))
            .and_then(Value::as_array)
        {
            Some(alts) => alts.iter().for_each(|a| visit(root, a, out)),
            None => out.push(s),
        }
    }
    let mut out = Vec::new();
    for s in list {
        visit(root, s, &mut out);
    }
    out
}

/// Subschemas matching a path; alternatives are kept unless the sibling values rule them out.
fn resolve<'a>(root: &'a Value, path: &[PathKey]) -> Vec<&'a Value> {
    let mut current = expand(root, &[root]);
    for key in path {
        let mut next: Vec<&Value> = Vec::new();
        for s in &current {
            match key {
                PathKey::Index(_) => {
                    if let Some(items) = field(s, "items") {
                        next.push(items);
                    }
                }
                PathKey::Key(k) => {
                    if let Some(prop) = field(s, "properties").and_then(|p| p.get(k)) {
                        next.push(prop);
                    } else if let Some(extra) = field(s, "additionalProperties").filter(|a| a.is_object()) {
                        next.push(extra);
                    }
                }
            }
        }
        current = expand(root, &next);
    }
    current
}

/// Constant values a schema allows.
fn allowed(s: &Value) -> Option<Vec<&Value>> {
    if let Some(c) = field(s, "const") {
        return Some(vec![c]);
    }
    field(s, "enum")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
}

/// JavaScript `String(value)` of a scalar.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => crate::emit::js_number(n),
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

/// Alternatives whose constant properties agree with the values already written.
fn matching<'a>(list: Vec<&'a Value>, values: Option<&IndexMap<String, String>>) -> Vec<&'a Value> {
    let Some(values) = values.filter(|v| !v.is_empty()) else {
        return list;
    };
    let kept: Vec<&Value> = list
        .iter()
        .copied()
        .filter(|s| {
            values.iter().all(|(k, v)| {
                let Some(props) = field(s, "properties") else {
                    return true;
                };
                let Some(prop) = props.get(k) else {
                    return false;
                };
                allowed(prop).is_none_or(|a| a.iter().any(|x| js_string(x) == *v))
            })
        })
        .collect();
    if kept.is_empty() { list } else { kept }
}

fn has_type(s: &Value, t: &str) -> bool {
    field(s, "type").and_then(Value::as_str) == Some(t)
}

fn is_object(s: &&Value) -> bool {
    has_type(s, "object")
}

/// Scalar text of a value: quoted when YAML would read it otherwise.
fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) if s.is_empty() || NEEDS_QUOTES.is_match(s) => {
            serde_json::to_string(s).unwrap_or_default()
        }
        Value::String(s) => s.clone(),
        other => js_string(other),
    }
}

fn description(s: &Value) -> Option<String> {
    field(s, "description")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn key_items(root: &Value, schemas: &[&Value], present: &[String], col: usize) -> Vec<Completion> {
    let mut items: IndexMap<String, (Completion, bool)> = IndexMap::new();
    for s in schemas {
        let Some(props) = field(s, "properties").and_then(Value::as_object) else {
            continue;
        };
        for (key, prop) in props {
            if present.contains(key) || items.contains_key(key) {
                continue;
            }
            let alts = expand(root, &[prop]);
            let pad = " ".repeat(col + 2);
            // Nested objects and lists start on the next line.
            let insert = if alts.iter().any(|a| has_type(a, "array")) {
                format!("{key}:\n{pad}- ")
            } else if alts.iter().any(|a| has_type(a, "object")) {
                format!("{key}:\n{pad}")
            } else {
                format!("{key}: ")
            };
            let required = field(s, "required")
                .and_then(Value::as_array)
                .is_some_and(|r| r.iter().any(|x| x.as_str() == Some(key)));
            items.insert(
                key.clone(),
                (
                    Completion {
                        label: key.clone(),
                        insert,
                        detail: description(prop).filter(|d| !d.is_empty()),
                    },
                    required,
                ),
            );
        }
    }
    // Required keys first, then in schema order.
    let mut list: Vec<(Completion, bool)> = items.into_values().collect();
    list.sort_by_key(|(_, required)| !*required);
    list.into_iter().map(|(c, _)| c).collect()
}

fn value_items(
    schemas: &[&Value],
    path: &[PathKey],
    siblings: Option<&IndexMap<String, String>>,
    names: &ProjectNames,
) -> Vec<Completion> {
    let name_at = |i: Option<usize>| match i.and_then(|i| path.get(i)) {
        Some(PathKey::Key(k)) => Some(k.as_str()),
        _ => None,
    };
    let key = name_at(path.len().checked_sub(1));
    let parent = name_at(path.len().checked_sub(2));
    let mut values: Vec<Value> = Vec::new();
    let mut push = |v: Value| {
        if !values.contains(&v) {
            values.push(v);
        }
    };
    for s in schemas {
        for v in allowed(s).unwrap_or_default() {
            push(v.clone());
        }
        if has_type(s, "boolean") {
            push(Value::Bool(true));
            push(Value::Bool(false));
        }
    }
    let mut out: Vec<Completion> = values
        .iter()
        .map(|v| Completion {
            label: js_string(v),
            insert: scalar(v),
            detail: None,
        })
        .collect();
    let mut add = |list: &[String], detail: &str| {
        for n in list {
            if !values.contains(&Value::String(n.clone())) {
                out.push(Completion {
                    label: n.clone(),
                    insert: scalar(&Value::String(n.clone())),
                    detail: Some(detail.to_string()),
                });
            }
        }
    };
    let endpoint = matches!(parent, Some("from" | "to"));
    match key {
        Some("interface") => add(&names.interfaces, "interface"),
        Some("module") if endpoint => {
            // A module of a dependency is named in it, its dependency by `project`.
            match siblings.and_then(|s| s.get("project")) {
                None => add(&names.modules, "module"),
                Some(project) => add(names.placed.get(project).map_or(&[][..], Vec::as_slice), "module"),
            }
        }
        Some("project") if endpoint => {
            let deps: Vec<String> = names.placed.keys().cloned().collect();
            add(&deps, "dependency");
        }
        Some("root") => add(&names.modules, "module"),
        _ => {}
    }
    out
}

/// Type names complete the `name` of a `kind: ref` type reference.
fn ref_names(values: Option<&IndexMap<String, String>>, key: &str, names: &ProjectNames) -> Vec<Completion> {
    if key == "name" && values.and_then(|v| v.get("kind")).map(String::as_str) == Some("ref") {
        names
            .types
            .iter()
            .map(|n| Completion {
                label: n.clone(),
                insert: n.clone(),
                detail: Some("type".to_string()),
            })
            .collect()
    } else {
        Vec::new()
    }
}

/// Completions at `pos` in YAML `text`; None where there is nothing to complete.
pub fn complete(text: &str, pos: usize, schema: &Value, names: &ProjectNames) -> Option<CompletionResult> {
    let line_start = text[..pos].rfind('\n').map_or(0, |i| i + 1);
    let line_end = text[pos..].find('\n').map_or(text.len(), |i| pos + i);
    let before = &text[line_start..pos];
    let after = &text[pos..line_end];
    let word_after = after
        .find(|c: char| !(is_word(c) || c == '.' || c == '-'))
        .unwrap_or(after.len());
    let head = HEAD.captures(before).expect("matches empty");
    let col = head[0].len();
    let has_items = !head[2].is_empty();
    let rest = &before[col..];
    // The lines above, and the sequence items starting the caret line (as if an `x` key followed).
    let extra = if has_items {
        format!("{}x: ", &head[0])
    } else {
        String::new()
    };
    let mut stack = frames(text[..line_start].split('\n').chain([extra.as_str()]));

    if rest.chars().all(|c| is_word(c) || c == '-') {
        // Key of the mapping at the caret column (a new item of a sequence starts one).
        if has_items {
            stack.pop();
        }
        pop_to(&mut stack, col, true);
        let top = stack.last();
        let in_map = top.is_some_and(|t| t.kind == Kind::Map && t.col == col);
        let mut path = path_of(&stack);
        if in_map {
            path.pop();
        }
        let siblings = top.filter(|_| in_map).map(|t| &t.values);
        let mut present: Vec<String> = Vec::new();
        if let Some(t) = top.filter(|_| in_map) {
            present.extend(t.values.keys().cloned());
            present.extend(t.key.clone());
        }
        // Keys written below the caret, in the same mapping.
        for line in text[pos..].split('\n').skip(1) {
            let indent = indent_of(line);
            if line.trim().is_empty() {
                continue;
            }
            if indent < col {
                break;
            }
            let key = if indent == col {
                KEY_LINE.captures(&line[indent..])
            } else {
                None
            };
            if let Some(k) = key {
                present.push(unquote(&k[1]));
            } else if indent == col {
                break;
            }
        }
        let objects: Vec<&Value> = resolve(schema, &path).into_iter().filter(is_object).collect();
        let schemas = matching(objects, siblings);
        let items = key_items(schema, &schemas, &present, col);
        return Some(CompletionResult {
            from: pos - rest.len(),
            to: pos + word_after,
            prefix: rest.to_string(),
            value: false,
            items,
        });
    }

    let stripped = rest.trim_end_matches(|c: char| !c.is_whitespace());
    let value_match = if KEY_LINE.is_match(stripped) {
        VALUE_AT_CARET.captures(rest)
    } else {
        None
    }?;
    let key = unquote(value_match[1].trim());
    let prefix = value_match[2].to_string();
    if prefix.starts_with(['"', '\'', '[', '{']) {
        return None;
    }
    // The key's mapping: the caret line adds or replaces its key.
    pop_to(&mut stack, col, true);
    let top = stack.last();
    let in_map = top.is_some_and(|t| t.kind == Kind::Map && t.col == col);
    let siblings = top.filter(|_| in_map).map(|t| &t.values);
    let mut path = path_of(&stack);
    if in_map {
        path.pop();
    }
    let objects: Vec<&Value> = resolve(schema, &path).into_iter().filter(is_object).collect();
    let parents = matching(objects, siblings);
    path.push(PathKey::Key(key.clone()));
    let props: Vec<&Value> = parents
        .iter()
        .filter_map(|s| field(s, "properties").and_then(|p| p.get(&key)))
        .collect();
    let schemas = expand(schema, &props);
    let mut items = value_items(&schemas, &path, siblings, names);
    items.extend(ref_names(siblings, &key, names));
    Some(CompletionResult {
        from: pos - prefix.len(),
        to: pos + word_after,
        prefix,
        value: true,
        items,
    })
}

/// Description the schema gives a key, and the key's range in the text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyDescription {
    pub from: usize,
    pub to: usize,
    pub text: String,
}

/// Description of the key under `pos` in YAML `text`; None off a key or for a key without one.
pub fn describe_key(text: &str, pos: usize, schema: &Value) -> Option<KeyDescription> {
    let line_start = text[..pos].rfind('\n').map_or(0, |i| i + 1);
    let line_end = text[pos..].find('\n').map_or(text.len(), |i| pos + i);
    let line = &text[line_start..line_end];
    let col = LINE_PREFIX.find(line).map_or(0, |m| m.end());
    let key = KEY_LINE.captures(&line[col..])?;
    let from = line_start + col;
    let to = from + key[1].len();
    if pos < from || pos > to {
        return None;
    }
    let name = unquote(&key[1]);
    let stack = frames(text[..line_end].split('\n'));
    let top = stack.last()?;
    // Not a key where the line sits in a block scalar.
    if top.kind != Kind::Map || top.col != col || top.key.as_deref() != Some(name.as_str()) {
        return None;
    }
    let mut path = path_of(&stack);
    path.pop();
    let objects: Vec<&Value> = resolve(schema, &path).into_iter().filter(is_object).collect();
    let parents = matching(objects, Some(&top.values));
    let mut texts: Vec<String> = Vec::new();
    for s in parents {
        // A key of a record (a module path, a link name...): the description of its values.
        let Some(prop) = field(s, "properties")
            .and_then(|p| p.get(&name))
            .or_else(|| field(s, "additionalProperties").filter(|a| a.is_object()))
        else {
            continue;
        };
        let text = description(prop).filter(|d| !d.is_empty()).or_else(|| {
            expand(schema, &[prop])
                .into_iter()
                .find_map(description)
                .filter(|d| !d.is_empty())
        });
        if let Some(t) = text
            && !texts.contains(&t)
        {
            texts.push(t);
        }
    }
    (!texts.is_empty()).then(|| KeyDescription {
        from,
        to,
        text: texts.join("\n"),
    })
}

/// Items starting with the typed prefix, then those containing it.
pub fn filter_items(result: &CompletionResult) -> Vec<Completion> {
    let p = result.prefix.to_lowercase();
    if p.is_empty() {
        return result.items.clone();
    }
    let lower = |i: &Completion| i.label.to_lowercase();
    let starts = result.items.iter().filter(|i| lower(i).starts_with(&p));
    let contains = result
        .items
        .iter()
        .filter(|i| !lower(i).starts_with(&p) && lower(i).contains(&p));
    starts
        .chain(contains)
        .filter(|i| i.label != result.prefix || i.insert != result.prefix)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> ProjectNames {
        let strings = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        ProjectNames {
            interfaces: strings(&["Telemetry", "Control"]),
            modules: strings(&["Core", "Core.Sensor"]),
            placed: IndexMap::from([("Robot".to_string(), strings(&["Core", "Core.Logger"]))]),
            types: strings(&["Vec3", "Pose", "Core.Sensor.Filter", "Robot/Core.Sensor.Sample"]),
        }
    }

    /// Completion labels at the `|` of the text.
    fn at(text: &str) -> Option<Vec<String>> {
        let pos = text.find('|').unwrap();
        let r = complete(&text.replace('|', ""), pos, file_schema(), &names())?;
        Some(filter_items(&r).into_iter().map(|i| i.label).collect())
    }

    fn labels(l: &[&str]) -> Option<Vec<String>> {
        Some(l.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn completes_top_level_keys() {
        assert_eq!(at("schemaVersion: 1\npro|"), labels(&["project"]));
        assert!(
            !at("schemaVersion: 1\n|")
                .unwrap()
                .contains(&"schemaVersion".to_string())
        );
    }

    #[test]
    fn completes_the_keys_of_a_new_list_item_required_first() {
        let l = at("links:\n  - name: a\n  - |").unwrap();
        assert_eq!(l[..4], ["name", "from", "to", "constraints"]);
        assert!(l.contains(&"description".to_string()));
    }

    #[test]
    fn leaves_out_the_keys_already_present_above_and_below() {
        let l = at("modules:\n  - name: A\n    |\n    ports: []\n").unwrap();
        assert!(!l.contains(&"name".to_string()));
        assert!(!l.contains(&"ports".to_string()));
        assert!(l.contains(&"modules".to_string()));
    }

    #[test]
    fn narrows_alternatives_with_the_values_already_written() {
        assert_eq!(at("types:\n  - kind: enum\n    und|"), labels(&["underlying"]));
        assert_eq!(at("types:\n  - kind: struct\n    und|"), labels(&[]));
    }

    #[test]
    fn completes_enums_booleans_and_constants() {
        assert_eq!(
            at("types:\n  - kind: enum\n    underlying: uint|"),
            labels(&["uint8", "uint16", "uint32", "uint64"])
        );
        assert_eq!(
            at("links:\n  - constraints:\n      ack:\n        required: |"),
            labels(&["true", "false"])
        );
        assert_eq!(
            at("modules:\n  - name: A\n    ports:\n      - role: |"),
            labels(&["out", "in"])
        );
    }

    #[test]
    fn completes_project_names() {
        assert_eq!(
            at("modules:\n  - name: A\n    ports:\n      - interface: Te|"),
            labels(&["Telemetry"])
        );
        assert_eq!(
            at("links:\n  - from:\n      module: Core.|"),
            labels(&["Core.Sensor"])
        );
        assert_eq!(
            at("types:\n  - kind: alias\n    type:\n      kind: ref\n      name: |"),
            labels(&["Vec3", "Pose", "Core.Sensor.Filter", "Robot/Core.Sensor.Sample"])
        );
    }

    #[test]
    fn completes_types_and_modules_of_dependencies() {
        assert_eq!(
            at("types:\n  - kind: alias\n    type:\n      kind: ref\n      name: Rob|"),
            labels(&["Robot/Core.Sensor.Sample"])
        );
        assert_eq!(at("links:\n  - from:\n      project: |"), labels(&["Robot"]));
        assert_eq!(
            at("links:\n  - from:\n      project: Robot\n      module: Core.|"),
            labels(&["Core.Logger"])
        );
    }

    #[test]
    fn opens_nested_objects_and_lists_on_the_next_line() {
        let end = |t: &str| complete(t, t.len(), file_schema(), &names()).unwrap();
        let insert = |r: &CompletionResult, label: &str| {
            r.items.iter().find(|i| i.label == label).unwrap().insert.clone()
        };
        let r = end("links:\n  - name: a\n    constr");
        assert_eq!(insert(&r, "constraints"), "constraints:\n      ");
        let m = end("modules:\n  - name: A\n    por");
        assert_eq!(insert(&m, "ports"), "ports:\n      - ");
    }

    /// Description of the key at the `|` of the text.
    fn hover(text: &str) -> Option<String> {
        describe_key(&text.replace('|', ""), text.find('|').unwrap(), file_schema()).map(|d| d.text)
    }

    #[test]
    fn describes_the_key_under_the_pointer() {
        assert_eq!(
            hover("modules:\n  - name: A\n    me|thods: []").as_deref(),
            Some("method prototypes of the module")
        );
        assert_eq!(
            hover("modules:\n  - name: A\n    ports:\n      - ro|le: in").as_deref(),
            Some("out: initiates / sends; in: receives / serves")
        );
    }

    #[test]
    fn reaches_keys_through_list_items_and_alternatives() {
        assert_eq!(
            hover("types:\n  - ki|nd: exception\n    name: E\n").as_deref(),
            Some("exception: named fields, raised by messages and methods")
        );
        assert_eq!(
            hover("remote|Defaults:\n  basePort: 1").as_deref(),
            Some("defaults of the addresses of the remote links (default host 127.0.0.1)")
        );
    }

    #[test]
    fn describes_nested_keys_and_the_keys_of_records() {
        assert_eq!(
            hover("types:\n  - kind: struct\n    fields:\n      - name: a\n        type:\n          ki|nd: vector")
                .as_deref(),
            Some("vector, list: items in order, any number; set: distinct items")
        );
        assert_eq!(
            hover("editor:\n  layout:\n    Core.Sen|sor:\n      x: 1").as_deref(),
            Some("position and size of the module")
        );
        assert_eq!(
            hover("editor:\n  dependencies:\n    Robot:\n      Core:\n        wid|th: 1").as_deref(),
            Some("width")
        );
    }

    #[test]
    fn gives_nothing_off_a_key() {
        assert_eq!(hover("modules:\n  - name: A\n    methods: [|]"), None);
        assert_eq!(
            hover("project:\n  description: |\n    color: x\n    co|lor: y"),
            None
        );
    }

    #[test]
    fn reads_the_structure_around_the_caret() {
        let text = "modules:\n  - name: A\n    ports:\n      - role: in\n";
        let (path, names) = structure_at(text, text.len() - 1);
        assert_eq!(
            path,
            vec![
                PathKey::from("modules"),
                0.into(),
                PathKey::from("ports"),
                0.into(),
                PathKey::from("role")
            ]
        );
        assert_eq!(names[1].as_deref(), Some("A"));
    }
}
