//! Reloading a project from its file keeps the ids of the entities it already had, so that the
//! selection, the open editors and the views survive edits made to the text. Port of `reuse.ts`.

use std::collections::{HashMap, HashSet, VecDeque};

/// Index in `prev_keys` of the entity matching each of `next_keys`: the one with the same key (in
/// order when several share it, as overloaded methods), else the one at the same position whose
/// key is gone (renamed).
pub fn pair<S: AsRef<str>, T: AsRef<str>>(prev_keys: &[S], next_keys: &[T]) -> Vec<Option<usize>> {
    let mut by_key: HashMap<&str, VecDeque<usize>> = HashMap::new();
    for (i, k) in prev_keys.iter().enumerate() {
        by_key.entry(k.as_ref()).or_default().push_back(i);
    }
    let kept: HashSet<&str> = next_keys.iter().map(|k| k.as_ref()).collect();
    let mut used = vec![false; prev_keys.len()];
    let take = |e: Option<usize>, used: &mut Vec<bool>| -> Option<usize> {
        let e = e?;
        if used[e] {
            return None;
        }
        used[e] = true;
        Some(e)
    };
    let same: Vec<Option<usize>> = next_keys
        .iter()
        .map(|k| {
            let e = by_key.get_mut(k.as_ref()).and_then(|l| l.pop_front());
            take(e, &mut used)
        })
        .collect();
    same.into_iter()
        .enumerate()
        .map(|(i, e)| {
            if e.is_some() {
                return e;
            }
            match prev_keys.get(i) {
                Some(k) if !kept.contains(k.as_ref()) => take(Some(i), &mut used),
                _ => None,
            }
        })
        .collect()
}

/// `pair` returning the matched entities.
pub fn pair_by<'a, E, T: AsRef<str>>(
    prev: &'a [E],
    key: impl Fn(&E) -> String,
    next_keys: &[T],
) -> Vec<Option<&'a E>> {
    let keys: Vec<String> = prev.iter().map(key).collect();
    pair(&keys, next_keys)
        .into_iter()
        .map(|i| i.map(|i| &prev[i]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_name_then_renamed_position() {
        let prev = ["a", "b", "c"];
        assert_eq!(pair(&prev, &["c", "x", "a"]), vec![Some(2), Some(1), Some(0)]);
        assert_eq!(pair(&prev, &["a", "a"]), vec![Some(0), Some(1)]);
        assert_eq!(pair(&["m", "m"], &["m", "m"]), vec![Some(0), Some(1)]);
    }
}
