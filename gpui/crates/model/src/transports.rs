//! Settings of the built-in transports: which fields apply to each, defaults, pruning.
//! Port of `transports.ts`.

use std::sync::LazyLock;

use regex::Regex;

use crate::types::{TRANSPORTS, TransportSettings};

/// Fields of the settings of each built-in transport (custom transports: `options` only).
pub fn transport_fields(t: Option<&str>) -> &'static [&'static str] {
    match t.unwrap_or("") {
        "ipc" => &["socket"],
        "shm" => &["name", "capacity"],
        "mq" => &["name", "maxMessages", "messageSize"],
        "tcp" | "udp" | "grpc" => &["client", "server"],
        "http" | "websocket" => &["client", "server", "path"],
        "mqtt" => &["broker", "topic"],
        "can" => &["interface", "id"],
        "serial" => &["device", "baud"],
        _ => &[],
    }
}

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_BASE_PORT: u64 = 47000;
pub const DEFAULT_SHM_CAPACITY: u64 = 1 << 20;
pub const DEFAULT_MQ_MAX_MESSAGES: u64 = 10;
pub const DEFAULT_MQ_MESSAGE_SIZE: u64 = 8192;

static LOWER_UPPER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").expect("regex"));
static ACRONYM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([A-Z]+)([A-Z][a-z])").expect("regex"));
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9]+").expect("regex"));

/// Default shared memory or message queue name of a link: `<project>_<link>` in snake_case.
pub fn default_shm_name(project: &str, link: &str) -> String {
    let s = format!("{project}_{link}");
    let s = LOWER_UPPER.replace_all(&s, "$1 $2");
    let s = ACRONYM.replace_all(&s, "$1 $2");
    WORD.find_iter(&s)
        .map(|w| w.as_str().to_lowercase())
        .collect::<Vec<_>>()
        .join("_")
}

pub fn is_builtin_transport(t: Option<&str>) -> bool {
    t.is_some_and(|t| TRANSPORTS.contains(&t))
}

/// Settings as ordered JSON fields.
fn entries(s: &TransportSettings) -> serde_json::Map<String, serde_json::Value> {
    match serde_json::to_value(s) {
        Ok(serde_json::Value::Object(o)) => o,
        _ => serde_json::Map::new(),
    }
}

/// Fields set in `s` that do not apply to transport `t`.
pub fn foreign_fields(s: &TransportSettings, t: Option<&str>) -> Vec<String> {
    let fields = transport_fields(t);
    entries(s)
        .keys()
        .filter(|k| *k != "options" && !fields.contains(&k.as_str()))
        .cloned()
        .collect()
}

/// `s` without empty values and fields not applying to transport `t`; None when nothing is left.
pub fn prune_settings(s: Option<&TransportSettings>, t: Option<&str>) -> Option<TransportSettings> {
    use serde_json::Value;
    let s = s?;
    let fields = transport_fields(t);
    let mut out = serde_json::Map::new();
    for (k, v) in entries(s) {
        if k != "options" && !fields.contains(&k.as_str()) {
            continue;
        }
        if v.is_null() || v == Value::String(String::new()) {
            continue;
        }
        match v {
            Value::Object(o) if k == "options" => {
                if !o.is_empty() {
                    out.insert(k, Value::Object(o));
                }
            }
            Value::Object(o) => {
                let inner: serde_json::Map<String, Value> = o
                    .into_iter()
                    .filter(|(_, x)| !x.is_null() && *x != Value::String(String::new()))
                    .collect();
                if !inner.is_empty() {
                    out.insert(k, Value::Object(inner));
                }
            }
            v => {
                out.insert(k, v);
            }
        }
    }
    if out.is_empty() {
        return None;
    }
    serde_json::from_value(Value::Object(out)).ok()
}
