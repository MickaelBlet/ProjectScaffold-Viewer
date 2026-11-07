//! Parity with the web build's validation: projects the TS tests validate (captured by
//! `gpui/scripts/capture-validate.ts`) give the same problems, in the same order.

use std::fs;
use std::path::Path;

use scaffold_model::serialize::from_file;
use scaffold_model::validate::{ProblemTarget, Severity, validate};

fn kind(t: &ProblemTarget) -> &'static str {
    match t {
        ProblemTarget::Project => "project",
        ProblemTarget::Type(_) => "type",
        ProblemTarget::Interface(_) => "interface",
        ProblemTarget::Const(_) => "const",
        ProblemTarget::Module(_) => "module",
        ProblemTarget::Link(_) => "link",
        ProblemTarget::Dependency(_) => "dependency",
    }
}

#[test]
fn problems_match_the_web_build() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/validate");
    let mut files: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    assert!(files.len() > 50);
    let mut failures = vec![];
    for file in &files {
        let data: serde_json::Value = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
        let expected = fs::read_to_string(file.with_extension("problems.txt")).unwrap();
        let name = file.file_stem().unwrap().to_string_lossy().to_string();
        let p = match from_file(&data, None) {
            Ok(p) => p,
            Err(e) => {
                failures.push(format!("{name}: load failed: {e}"));
                continue;
            }
        };
        let actual: Vec<String> = validate(&p)
            .iter()
            .map(|x| {
                let s = if x.severity == Severity::Error {
                    "error"
                } else {
                    "warning"
                };
                format!("{s} {}: {}", kind(&x.target), x.message)
            })
            .collect();
        let actual = actual.join("\n") + "\n";
        if actual != expected {
            failures.push(format!("{name}:\n--- web\n{expected}--- rust\n{actual}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        files.len(),
        failures.join("\n")
    );
}
