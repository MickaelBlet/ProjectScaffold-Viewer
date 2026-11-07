//! Reading YAML (and JSON, which parses as YAML) into file data, keeping where each node starts so
//! that problems can be placed on the lines of the text. Integers too large for a JavaScript
//! number are kept as decimal text, as the web build does (`safeIntegers`).

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Number, Value};
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// A node of the text, with the line (from 1) where it starts.
#[derive(Clone, Debug)]
pub enum Node {
    Scalar {
        value: Value,
        line: usize,
    },
    Seq {
        items: Vec<Node>,
        line: usize,
    },
    /// Entries with the line of their key.
    Map {
        entries: Vec<(String, usize, Node)>,
        line: usize,
    },
}

impl Node {
    pub fn line(&self) -> usize {
        match self {
            Node::Scalar { line, .. } | Node::Seq { line, .. } | Node::Map { line, .. } => *line,
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Node::Scalar { value, .. } => value.clone(),
            Node::Seq { items, .. } => Value::Array(items.iter().map(Node::to_value).collect()),
            Node::Map { entries, .. } => {
                let mut m = Map::new();
                for (k, _, v) in entries {
                    m.insert(k.clone(), v.to_value());
                }
                Value::Object(m)
            }
        }
    }

    /// Text of a scalar used as a mapping key.
    fn key_text(&self) -> String {
        match self {
            Node::Scalar {
                value: Value::String(s),
                ..
            } => s.clone(),
            Node::Scalar {
                value: Value::Null, ..
            } => String::new(),
            Node::Scalar { value, .. } => match value {
                Value::Number(n) => crate::emit::js_number(n),
                v => v.to_string(),
            },
            n => crate::emit::to_json(&n.to_value()).trim_end().to_string(),
        }
    }
}

/// A YAML syntax error, with its line (from 1).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct YamlError {
    pub message: String,
    pub line: Option<usize>,
}

static INT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-+]?[0-9]+$").expect("regex"));
static OCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0o[0-7]+$").expect("regex"));
static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0x[0-9a-fA-F]+$").expect("regex"));
static FLOAT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$").expect("regex")
});

const MAX_SAFE: i128 = 9_007_199_254_740_991;

/// An integer as file data: a number when JavaScript holds it exactly, else decimal text.
fn int_value(n: i128) -> Value {
    if (-MAX_SAFE..=MAX_SAFE).contains(&n) {
        Value::Number(Number::from(n as i64))
    } else {
        Value::String(n.to_string())
    }
}

/// Value of a plain scalar (YAML 1.2 core schema).
fn plain(s: &str) -> Value {
    match s {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    if INT.is_match(s) {
        if let Ok(n) = s.parse::<i128>() {
            return int_value(n);
        }
    }
    if OCT.is_match(s) {
        if let Ok(n) = i128::from_str_radix(&s[2..], 8) {
            return int_value(n);
        }
    }
    if HEX.is_match(s) {
        if let Ok(n) = i128::from_str_radix(&s[2..], 16) {
            return int_value(n);
        }
    }
    if FLOAT.is_match(s) {
        if let Some(n) = s.parse::<f64>().ok().and_then(Number::from_f64) {
            return Value::Number(n);
        }
    }
    Value::String(s.to_string())
}

enum Frame {
    Seq {
        items: Vec<Node>,
        line: usize,
        anchor: usize,
    },
    Map {
        entries: Vec<(String, usize, Node)>,
        key: Option<(String, usize)>,
        line: usize,
        anchor: usize,
    },
}

#[derive(Default)]
struct Builder {
    stack: Vec<Frame>,
    anchors: HashMap<usize, Node>,
    root: Option<Node>,
    error: Option<YamlError>,
}

impl Builder {
    fn push(&mut self, node: Node) {
        match self.stack.last_mut() {
            None => {
                if self.root.is_none() {
                    self.root = Some(node)
                }
            }
            Some(Frame::Seq { items, .. }) => items.push(node),
            Some(Frame::Map { entries, key, .. }) => match key.take() {
                None => *key = Some((node.key_text(), node.line())),
                Some((k, line)) => {
                    if entries.iter().any(|(e, _, _)| *e == k) && self.error.is_none() {
                        self.error = Some(YamlError {
                            message: format!("Map keys must be unique: '{k}'"),
                            line: Some(line),
                        });
                    }
                    entries.push((k, line, node));
                }
            },
        }
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, ev: Event, mark: Marker) {
        let line = mark.line();
        match ev {
            Event::Scalar(s, style, anchor, tag) => {
                let value = if style == TScalarStyle::Plain && tag.is_none() {
                    plain(&s)
                } else {
                    Value::String(s)
                };
                let node = Node::Scalar { value, line };
                if anchor > 0 {
                    self.anchors.insert(anchor, node.clone());
                }
                self.push(node);
            }
            Event::Alias(id) => {
                let node = self.anchors.get(&id).cloned().unwrap_or(Node::Scalar {
                    value: Value::Null,
                    line,
                });
                self.push(node);
            }
            Event::SequenceStart(anchor, _) => self.stack.push(Frame::Seq {
                items: vec![],
                line,
                anchor,
            }),
            Event::MappingStart(anchor, _) => self.stack.push(Frame::Map {
                entries: vec![],
                key: None,
                line,
                anchor,
            }),
            Event::SequenceEnd | Event::MappingEnd => {
                let (node, anchor) = match self.stack.pop() {
                    Some(Frame::Seq { items, line, anchor }) => (Node::Seq { items, line }, anchor),
                    Some(Frame::Map {
                        entries,
                        line,
                        anchor,
                        ..
                    }) => (Node::Map { entries, line }, anchor),
                    None => return,
                };
                if anchor > 0 {
                    self.anchors.insert(anchor, node.clone());
                }
                self.push(node);
            }
            _ => {}
        }
    }
}

/// The node tree of a YAML (or JSON) text; an empty text is null.
pub fn parse_nodes(text: &str) -> Result<Node, YamlError> {
    let mut b = Builder::default();
    let mut parser = Parser::new_from_str(text);
    parser.load(&mut b, false).map_err(|e| YamlError {
        message: e.info().to_string(),
        line: Some(e.marker().line()),
    })?;
    if let Some(e) = b.error {
        return Err(e);
    }
    Ok(b.root.unwrap_or(Node::Scalar {
        value: Value::Null,
        line: 1,
    }))
}

/// File data of a YAML (or JSON) text.
pub fn parse_yaml(text: &str) -> Result<Value, YamlError> {
    parse_nodes(text).map(|n| n.to_value())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_core_schema() {
        let v = parse_yaml("a: 1\nb: '1'\nc: 0x10\nd: 1.5\ne: ~\nf: true\ng: [x, 2]\nh: 90071992547409930\n")
            .unwrap();
        assert_eq!(
            v,
            json!({"a": 1, "b": "1", "c": 16, "d": 1.5, "e": null, "f": true, "g": ["x", 2], "h": "90071992547409930"})
        );
    }

    #[test]
    fn reports_lines() {
        let e = parse_yaml("a: 1\nb: [\n").unwrap_err();
        assert!(e.line.is_some());
        let n = parse_nodes("a:\n  b: 1\n").unwrap();
        let Node::Map { entries, .. } = n else { panic!() };
        assert_eq!(entries[0].1, 1);
        let Node::Map { entries: inner, .. } = &entries[0].2 else {
            panic!()
        };
        assert_eq!(inner[0].1, 2);
    }
}
