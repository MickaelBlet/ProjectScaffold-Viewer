//! Fuzzy matching for the command palette: query characters in order, rewarding consecutive
//! matches and word starts. Port of `fuzzy.ts` (positions are char indexes).

#[derive(Clone, Debug, PartialEq)]
pub struct FuzzyMatch {
    pub score: f64,
    /// Indexes of the matched characters in the text.
    pub positions: Vec<usize>,
}

fn is_word_start(text: &[char], i: usize) -> bool {
    if i == 0 {
        return true;
    }
    let prev = text[i - 1];
    prev.is_whitespace()
        || "._-/:>(".contains(prev)
        || (prev.is_ascii_lowercase() && text.get(i).is_some_and(|c| c.is_ascii_uppercase()))
}

pub fn fuzzy_match(query: &str, text: &str) -> Option<FuzzyMatch> {
    let q: Vec<char> = query.trim().to_lowercase().chars().collect();
    if q.is_empty() {
        return Some(FuzzyMatch {
            score: 0.,
            positions: vec![],
        });
    }
    let chars: Vec<char> = text.chars().collect();
    let t: Vec<char> = chars
        .iter()
        .map(|c| c.to_lowercase().next().unwrap_or(*c))
        .collect();
    let index_of = |ch: char, from: usize| (from..t.len()).find(|&j| t[j] == ch);
    let mut positions = Vec::new();
    let mut score = 0.;
    let mut from = 0;
    let mut prev: isize = -2;
    for &ch in &q {
        if ch == ' ' {
            continue;
        }
        // Prefer a word start ahead, else the next occurrence.
        let mut i = index_of(ch, from)?;
        let mut j = Some(i);
        while let Some(k) = j {
            if k as isize == prev + 1 || is_word_start(&chars, k) {
                i = k;
                break;
            }
            j = index_of(ch, k + 1);
        }
        score += 1.;
        if i as isize == prev + 1 {
            score += 5.;
        }
        if is_word_start(&chars, i) {
            score += 3.;
        }
        positions.push(i);
        prev = i as isize;
        from = i + 1;
    }
    if t.starts_with(&q) {
        score += 10.;
    }
    score -= (chars.len() as f64 - q.len() as f64) * 0.05;
    Some(FuzzyMatch { score, positions })
}

/// Items matching the query, best first.
pub fn fuzzy_filter<'a, T>(
    query: &str,
    items: &'a [T],
    text: impl Fn(&T) -> String,
) -> Vec<(&'a T, FuzzyMatch)> {
    let mut out: Vec<(&T, FuzzyMatch)> = items
        .iter()
        .filter_map(|item| fuzzy_match(query, &text(item)).map(|m| (item, m)))
        .collect();
    if !query.trim().is_empty() {
        out.sort_by(|a, b| {
            b.1.score
                .partial_cmp(&a.1.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    out
}
