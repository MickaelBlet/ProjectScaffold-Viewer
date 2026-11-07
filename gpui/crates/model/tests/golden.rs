//! Parity with the web build: every example loads, and saves exactly as the web build saves it
//! (golden files written by `gpui/scripts/golden.ts`).

use std::fs;
use std::path::{Path, PathBuf};

use scaffold_model::serialize::{Format, format_from_path, load_text, reload_text, save_text};

fn examples(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            examples(&p, out)
        } else if p.to_string_lossy().contains(".scaffold.") {
            out.push(p)
        }
    }
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

#[test]
fn examples_save_like_the_web_build() {
    let base = root().join("examples");
    let mut files = vec![];
    examples(&base, &mut files);
    files.sort();
    assert!(files.len() > 10);
    let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let mut failures = vec![];
    for file in files {
        let rel = file
            .strip_prefix(&base)
            .unwrap()
            .to_string_lossy()
            .replace('/', "__");
        let text = fs::read_to_string(&file).unwrap();
        let p = match load_text(&text, format_from_path(&file.to_string_lossy())) {
            Ok(p) => p,
            Err(e) => {
                failures.push(format!("{rel}: {e}"));
                continue;
            }
        };
        for (suffix, format, editor) in [
            ("json", Format::Json, true),
            ("yaml", Format::Yaml, true),
            ("noeditor.json", Format::Json, false),
        ] {
            let expected = fs::read_to_string(golden.join(format!("{rel}.{suffix}"))).unwrap();
            let actual = save_text(&p, format, editor);
            if actual != expected {
                let line = actual
                    .lines()
                    .zip(expected.lines())
                    .position(|(a, b)| a != b)
                    .unwrap_or(0);
                failures.push(format!(
                    "{rel}.{suffix}: line {}\n  rust: {:?}\n  web:  {:?}",
                    line + 1,
                    actual.lines().nth(line).unwrap_or(""),
                    expected.lines().nth(line).unwrap_or("")
                ));
            }
        }
        // Reloading the saved text keeps everything.
        let again = reload_text(&save_text(&p, Format::Yaml, true), Format::Yaml, &p).unwrap();
        assert_eq!(again, p, "{rel}: reload changed the project");
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
