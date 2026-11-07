//! Binaries of a project: top-level modules run in one each, links between two of them are remote.
//! Port of `binaries.ts`.

use std::collections::{HashMap, HashSet};

use crate::types::{Endpoint, Id, Project};

/// Binary a module runs in: its own at the top level, else its top-level ancestor's.
pub fn binary_of(p: &Project, module_id: &str) -> Option<Id> {
    let mut m = p.modules.iter().find(|x| x.id == module_id);
    let mut seen = HashSet::new();
    while let Some(x) = m {
        let Some(parent) = &x.parent_id else { break };
        if !seen.insert(x.id.clone()) {
            break;
        }
        m = p.modules.iter().find(|y| &y.id == parent);
    }
    m.and_then(|x| x.binary_id.clone())
}

/// Binary of every module of the project.
pub fn binaries_of(p: &Project) -> HashMap<Id, Option<Id>> {
    p.modules
        .iter()
        .map(|m| (m.id.clone(), binary_of(p, &m.id)))
        .collect()
}

/// Where the modules ran before a change: their binaries, and which were at the top level.
#[derive(Clone, Debug)]
pub struct BinarySnapshot {
    pub of: HashMap<Id, Option<Id>>,
    pub top: HashSet<Id>,
}

pub fn binary_snapshot(p: &Project) -> BinarySnapshot {
    BinarySnapshot {
        of: binaries_of(p),
        top: p
            .modules
            .iter()
            .filter(|m| m.parent_id.is_none())
            .map(|m| m.id.clone())
            .collect(),
    }
}

/// Whether a link joins modules of two different binaries.
pub fn crosses(binaries: &HashMap<Id, Option<Id>>, from: &Endpoint, to: &Endpoint) -> bool {
    let a = binaries.get(&from.module_id).cloned().flatten();
    let b = binaries.get(&to.module_id).cloned().flatten();
    matches!((a, b), (Some(a), Some(b)) if a != b)
}

/// After a change of binaries or of the module tree: settle module binaries and remote links.
pub fn settle_binaries(d: &mut Project, before: &BinarySnapshot) {
    let known: HashSet<Id> = d.binaries.iter().map(|b| b.id.clone()).collect();
    let ids: Vec<Id> = d.modules.iter().map(|m| m.id.clone()).collect();
    for id in ids {
        let i = d.modules.iter().position(|m| m.id == id).expect("module");
        let m = &mut d.modules[i];
        if m.parent_id.is_some() || m.binary_id.as_ref().is_some_and(|b| !known.contains(b)) {
            m.binary_id = None;
        }
        if m.parent_id.is_some() || m.binary_id.is_some() || before.top.contains(&m.id) {
            continue;
        }
        let was = before
            .of
            .get(&id)
            .cloned()
            .flatten()
            .or_else(|| unanimous(d, &id, &before.of));
        if let Some(was) = was.filter(|w| known.contains(w)) {
            d.modules[i].binary_id = Some(was);
        }
    }
    let after = binaries_of(d);
    for l in &mut d.links {
        let crossing = crosses(&after, &l.from, &l.to);
        let crossed = crosses(&before.of, &l.from, &l.to);
        let remote = &mut l.constraints.remote;
        if crossing {
            remote.enabled = true;
        } else if crossed && remote.enabled && remote.transport.is_none() {
            remote.enabled = false;
            remote.settings = None;
        }
    }
}

/// The binary all the modules inside `id` ran in, if one.
fn unanimous(d: &Project, id: &str, before: &HashMap<Id, Option<Id>>) -> Option<Id> {
    let inner: Vec<Option<Id>> = d
        .modules
        .iter()
        .filter(|m| m.parent_id.as_deref() == Some(id))
        .map(|m| before.get(&m.id).cloned().flatten())
        .collect();
    let first = inner.first()?.clone();
    inner.iter().all(|b| *b == first).then_some(first).flatten()
}

/// Move top-level modules into a binary (None: none), and settle the links.
pub fn assign_binary<'a>(
    d: &mut Project,
    module_ids: impl IntoIterator<Item = &'a Id>,
    binary_id: Option<&Id>,
) {
    let before = binary_snapshot(d);
    for id in module_ids {
        if let Some(m) = d
            .modules
            .iter_mut()
            .find(|x| &x.id == id && x.parent_id.is_none())
        {
            m.binary_id = binary_id.cloned();
        }
    }
    settle_binaries(d, &before);
}

/// Remove a binary: its modules run in none.
pub fn remove_binary(d: &mut Project, id: &str) {
    let before = binary_snapshot(d);
    d.binaries.retain(|b| b.id != id);
    for m in &mut d.modules {
        if m.binary_id.as_deref() == Some(id) {
            m.binary_id = None;
        }
    }
    settle_binaries(d, &before);
}
