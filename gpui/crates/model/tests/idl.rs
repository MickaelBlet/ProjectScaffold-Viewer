//! Port of `tests/idl.test.ts`, with the snapshots of `tests/__snapshots__/idl.test.ts.snap`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use scaffold_model::clipboard::{PasteOptions, PasteParent, paste_clip};
use scaffold_model::dependencies::{add_dependency, dependency_of};
use scaffold_model::idl::{
    IdlFile, IdlOptions, idl_import, idl_project, parse_idl, parse_idl_files, read_idl_includes,
};
use scaffold_model::project::{empty_project, module_path, type_names};
use scaffold_model::schema::{FileMessage, FileTypeBody, FileTypeDef, FileUnionCase};
use scaffold_model::typeexpr::{print_type_expr, print_type_ref};
use scaffold_model::types::*;
use scaffold_model::validate::{Severity, validate};
use serde_json::{Value, json};

const SRC: &str = r#"
#include "base.idl"
#pragma prefix "acme"

module Robot {
  const long AXES = 3;

  /** Position in meters. */
  struct Vec3 { double x, y, z; };

  enum Mode { IDLE, @value(10) RUN, STOP };
  const Mode START = RUN; // first mode
  const string NAME = "robot";

  typedef sequence<Vec3> Path;
  typedef double Matrix[AXES][AXES + 1];

  struct Pose : Vec3 {
    @optional float heading; // degrees
    string<16> frame;
  };

  enum Shape { CIRCLE, SQUARE, LINE };
  union Payload switch (long) { case 1: case 2: long a; default: string b; };
  union Figure switch (Shape) { case CIRCLE: double radius; case Shape::SQUARE: Vec3 side; };

  exception Busy { string reason; };

  module Control {
    // Motion commands.
    interface Motion {
      void move(in Path path, out boolean done) raises (Busy);
      Mode mode();
      oneway void stop();
      readonly attribute Pose pose raises (Busy);
      attribute unsigned long long speed;
      sequence<octet> dump(in map<string, Payload> items, inout ::Robot::Unknown u);
    };

    interface Arm : Motion { void grip(in long force); };
  };
};
"#;

fn parse(text: &str) -> IdlFile {
    parse_idl(text, &IdlOptions::default()).unwrap_or_else(|e| panic!("{e}"))
}

fn files(list: &[(&str, &str)]) -> IndexMap<String, String> {
    list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn strs(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn type_named<'a>(idl: &'a IdlFile, name: &str) -> Option<&'a FileTypeDef> {
    idl.types.iter().find(|t| t.name == name)
}

fn alias(idl: &IdlFile, name: &str) -> Option<String> {
    match &type_named(idl, name)?.body {
        FileTypeBody::Alias { ty } => Some(print_type_expr(ty)),
        _ => None,
    }
}

fn fields(idl: &IdlFile, name: &str) -> Option<Vec<String>> {
    match &type_named(idl, name)?.body {
        FileTypeBody::Struct { fields, .. } | FileTypeBody::Exception { fields } => Some(
            fields
                .iter()
                .map(|f| format!("{} {}", print_type_expr(&f.ty), f.name))
                .collect(),
        ),
        _ => None,
    }
}

fn signatures(messages: &[FileMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|m| {
            let params: Vec<String> = m
                .params
                .iter()
                .map(|p| {
                    format!(
                        "{} {} {}",
                        p.direction.expect("direction"),
                        print_type_expr(&p.ty),
                        p.name
                    )
                })
                .collect();
            let mut s = format!("{}({})", m.name, params.join(", "));
            if let Some(r) = &m.returns {
                s += &format!(": {}", print_type_expr(r));
            }
            s
        })
        .collect()
}

fn sig(idl: &IdlFile, name: &str) -> Vec<String> {
    signatures(&idl.interfaces.iter().find(|i| i.name == name).unwrap().messages)
}

fn paste(p: &mut Project, clip: &scaffold_model::clipboard::Clip) {
    paste_clip(
        p,
        clip,
        &PasteOptions {
            parent: PasteParent::Module(None),
            ..Default::default()
        },
    );
}

fn errors(p: &Project) -> Vec<String> {
    validate(p)
        .into_iter()
        .filter(|x| x.severity == Severity::Error)
        .map(|x| x.message)
        .collect()
}

/// Every definition of `idl` pasted into an empty project: no validation errors.
fn imports_cleanly(idl: &IdlFile) {
    let mut p = empty_project();
    let clip = idl_import(idl, &p, None, false).clip.unwrap();
    paste(&mut p, &clip);
    assert_eq!(errors(&p), Vec::<String>::new());
}

fn prim(name: Primitive) -> TypeRefOf<scaffold_model::schema::NameRef> {
    TypeRefOf::primitive(name)
}

fn name_ref(name: &str) -> TypeRefOf<scaffold_model::schema::NameRef> {
    TypeRefOf::Ref {
        target: scaffold_model::schema::NameRef { name: name.into() },
        args: None,
    }
}

#[test]
fn reads_types() {
    let idl = parse(SRC);
    let vec3 = type_named(&idl, "Vec3").unwrap();
    assert!(matches!(vec3.body, FileTypeBody::Struct { .. }));
    assert_eq!(vec3.description.as_deref(), Some("Position in meters."));
    assert_eq!(
        fields(&idl, "Vec3").unwrap(),
        ["float64 x", "float64 y", "float64 z"]
    );
    match &type_named(&idl, "Mode").unwrap().body {
        FileTypeBody::Enum { underlying, values } => {
            assert_eq!(*underlying, IntPrimitive::Int32);
            let got: Vec<(&str, i64)> = values.iter().map(|v| (v.name.as_str(), v.value)).collect();
            assert_eq!(got, [("IDLE", 0), ("RUN", 10), ("STOP", 11)]);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(alias(&idl, "Path").unwrap(), "vector<Vec3>");
    assert_eq!(alias(&idl, "Matrix").unwrap(), "array<array<float64, 4>, 3>");
    match &type_named(&idl, "Pose").unwrap().body {
        FileTypeBody::Struct { fields, .. } => {
            let got: Vec<(&str, String, Option<&str>)> = fields
                .iter()
                .map(|f| (f.name.as_str(), print_type_expr(&f.ty), f.description.as_deref()))
                .collect();
            assert_eq!(
                got,
                [
                    ("x", "float64".to_string(), None),
                    ("y", "float64".to_string(), None),
                    ("z", "float64".to_string(), None),
                    ("heading", "optional<float32>".to_string(), Some("degrees")),
                    ("frame", "string<16>".to_string(), None),
                ]
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        type_named(&idl, "Payload").unwrap(),
        &FileTypeDef {
            name: "Payload".into(),
            description: Some(String::new()),
            access: None,
            body: FileTypeBody::Union {
                discriminator: prim(Primitive::Int32),
                cases: vec![
                    FileUnionCase {
                        name: "a".into(),
                        ty: prim(Primitive::Int32),
                        description: Some(String::new()),
                        labels: Some(vec![json!(1), json!(2)]),
                        default: None,
                    },
                    FileUnionCase {
                        name: "b".into(),
                        ty: prim(Primitive::String),
                        description: Some(String::new()),
                        labels: None,
                        default: Some(true),
                    },
                ],
            },
        }
    );
    match &type_named(&idl, "Figure").unwrap().body {
        FileTypeBody::Union { discriminator, cases } => {
            assert_eq!(discriminator, &name_ref("Shape"));
            assert_eq!(cases[0].name, "radius");
            assert_eq!(cases[0].labels, Some(vec![json!("CIRCLE")]));
            assert_eq!(cases[1].name, "side");
            assert_eq!(cases[1].labels, Some(vec![json!("SQUARE")]));
            assert_eq!(cases[1].ty, name_ref("Vec3"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(fields(&idl, "Busy").unwrap(), ["string reason"]);
    assert!(matches!(
        type_named(&idl, "Busy").unwrap().body,
        FileTypeBody::Exception { .. }
    ));
    assert_eq!(idl.warnings, ["Line 2: base.idl not found"]);
    assert_eq!(idl.missing, ["base.idl"]);
    let consts: Vec<_> = idl
        .constants
        .iter()
        .map(|c| {
            (
                c.name.as_str(),
                c.description.as_deref(),
                c.ty.clone(),
                c.value.clone(),
            )
        })
        .collect();
    assert_eq!(
        consts,
        [
            ("AXES", Some(""), prim(Primitive::Int32), Some(json!(3))),
            ("START", Some("first mode"), name_ref("Mode"), Some(json!("RUN"))),
            ("NAME", Some(""), prim(Primitive::String), Some(json!("robot"))),
        ]
    );
}

#[test]
fn imports_the_constants_of_the_whole_file_with_their_types() {
    let t = parse("module M { enum E { A, B }; const E FIRST = A; const short N = -2; };");
    let clip = idl_import(&t, &empty_project(), None, false).clip.unwrap();
    let got: Vec<(&str, &Value)> = clip.consts.iter().map(|c| (c.name.as_str(), &c.value)).collect();
    assert_eq!(got, [("FIRST", &json!("A")), ("N", &json!(-2))]);
    let names: Vec<&str> = clip.types.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, ["E"]);
    assert!(idl_import(&t, &empty_project(), Some(&[]), false).clip.is_none());
}

#[test]
fn reads_interfaces() {
    let idl = parse(SRC);
    let motion = idl.interfaces.iter().find(|i| i.name == "Motion").unwrap();
    assert_eq!(motion.description.as_deref(), Some("Motion commands."));
    assert_eq!(
        sig(&idl, "Motion"),
        [
            "move(in Path path, out bool done)",
            "mode(): Mode",
            "stop()",
            "get_pose(): Pose",
            "get_speed(): uint64",
            "set_speed(in uint64 speed)",
            "dump(in map<string, Payload> items, inout Unknown u): bytes",
        ]
    );
    assert_eq!(motion.messages[0].raises, Some(strs(&["Busy"])));
    let get_pose = motion.messages.iter().find(|m| m.name == "get_pose").unwrap();
    assert_eq!(get_pose.raises, Some(strs(&["Busy"])));
    let needs: Vec<(&str, &Vec<String>)> = idl.needs.iter().map(|(k, v)| (k.as_str(), v)).collect();
    assert_eq!(needs, [("Motion", &strs(&["Busy"])), ("Arm", &strs(&["Busy"]))]);
    let mut arm = sig(&idl, "Motion");
    arm.push("grip(in int32 force)".into());
    assert_eq!(sig(&idl, "Arm"), arm);
}

#[test]
fn imports_an_interface_with_the_types_it_uses_and_the_exceptions_it_raises() {
    let idl = parse(SRC);
    let mut p = empty_project();
    let import = idl_import(&idl, &p, Some(&strs(&["Motion"])), false);
    assert_eq!(import.unresolved, ["Unknown"]);
    let clip = import.clip.unwrap();
    let interfaces: Vec<&str> = clip.interfaces.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(interfaces, ["Motion"]);
    let mut types: Vec<&str> = clip.types.iter().map(|t| t.name.as_str()).collect();
    types.sort();
    assert_eq!(
        types,
        ["Busy", "Mode", "Path", "Payload", "Pose", "Unknown", "Vec3"]
    );
    paste(&mut p, &clip);
    assert_eq!(errors(&p), Vec::<String>::new());
    let names = |id: &str| {
        p.types
            .iter()
            .map(|t| (&t.id, &t.name))
            .chain(p.interfaces.iter().map(|i| (&i.id, &i.name)))
            .find(|(i, _)| i.as_str() == id)
            .map(|(_, n)| n.clone())
    };
    let mv = &p.interfaces[0].messages[0];
    assert_eq!(print_type_ref(&mv.params[0].ty, names), "Path");
}

#[test]
fn keeps_the_types_the_project_has() {
    let idl = parse(SRC);
    let mut p = empty_project();
    let first = idl_import(&idl, &p, Some(&strs(&["Vec3"])), false).clip.unwrap();
    paste(&mut p, &first);
    let vec = p.types[0].id.clone();
    let import = idl_import(&idl, &p, Some(&strs(&["Motion"])), false);
    assert_eq!(import.existing, ["Vec3"]);
    let clip = import.clip.unwrap();
    assert!(!clip.types.iter().any(|t| t.name == "Vec3"));
    paste(&mut p, &clip);
    let path = p.types.iter().find(|t| t.name == "Path").unwrap();
    match &path.body {
        TypeBody::Alias { ty } => assert_eq!(
            ty,
            &TypeRef::Vector {
                of: Box::new(TypeRef::to(vec)),
                max: None
            }
        ),
        other => panic!("{other:?}"),
    }
    assert!(
        idl_import(&idl, &p, Some(&strs(&["Motion"])), false)
            .clip
            .is_none()
    );
}

#[test]
fn imports_every_type_of_a_file_without_interfaces() {
    let clip = idl_import(
        &parse("struct A { long x; }; typedef A B;"),
        &empty_project(),
        None,
        false,
    )
    .clip
    .unwrap();
    let names: Vec<&str> = clip.types.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["A", "B"]);
}

#[test]
fn reports_syntax_errors_with_their_line_and_file() {
    let err = parse_idl("struct A {\n  long;\n};", &IdlOptions::default()).unwrap_err();
    assert!(err.0.starts_with("Line 2: expected an identifier"), "{err}");
    let options = IdlOptions {
        file: "dir/main.idl".into(),
        files: files(&[("dir/bad.idl", "\n\nstruct B { long };")]),
    };
    let err = parse_idl("#include \"bad.idl\"", &options).unwrap_err();
    assert!(err.0.starts_with("Line 3 of bad.idl"), "{err}");
}

#[test]
fn evaluates_constant_expressions() {
    let t = parse(
        r#"
      const long N = (1 << 2) + 1;
      const unsigned long long BIG = 0xFFFFFFFFFFFFFFFF;
      const long OCT = 010;
      const boolean B = TRUE;
      typedef sequence<sequence<long>> S;
      typedef octet A[N * 2];
      typedef octet O[OCT];
      typedef octet R[(BIG >> 62) | 0x10];
      module M { const short K = 2; };
      typedef long Q[M :: K];
    "#,
    );
    assert_eq!(alias(&t, "S").unwrap(), "vector<vector<int32>>");
    assert_eq!(alias(&t, "A").unwrap(), "array<uint8, 10>");
    assert_eq!(alias(&t, "O").unwrap(), "array<uint8, 8>");
    assert_eq!(alias(&t, "R").unwrap(), "array<uint8, 19>");
    assert_eq!(alias(&t, "Q").unwrap(), "array<int32, 2>");
}

#[test]
fn preprocesses_macros_conditions_includes_once() {
    let options = IdlOptions {
        file: "/idl/robot/main.idl".into(),
        files: files(&[
            (
                "/idl/common/types.idl",
                r#"#ifndef TYPES_IDL
         #define TYPES_IDL
         module Common { struct Stamp { long long ns; }; };
         #endif"#,
            ),
            (
                "/idl/robot/limits.idl",
                "#include \"../common/types.idl\"\nconst long LIMIT = 4;",
            ),
        ]),
    };
    let t = parse_idl(
        r##"#include "limits.idl"
       #include <common/types.idl>
       #define SIZE (LIMIT * 2)
       #define SEQ(T, N) sequence<T, N>
       #define NAME(x) x ## _t
       #define STR(x) #x
       #if defined(SIZE) && !defined(NOPE) && (2 > 1 ? 1 : 0)
       typedef SEQ(Common::Stamp, SIZE) Stamps;
       #elif 1
       typedef long Wrong;
       #else
       typedef long Wrong2;
       #endif
       #ifdef NOPE
       garbage that is never read !
       #endif
       typedef long NAME(id);
       const string S = STR(hello);
       #undef SIZE
       #ifndef SIZE
       typedef long Undefined;
       #endif
       import "../common/types.idl";"##,
        &options,
    )
    .unwrap();
    assert_eq!(alias(&t, "Stamps").unwrap(), "vector<Stamp, 8>");
    assert!(type_named(&t, "Wrong").is_none());
    assert!(type_named(&t, "Wrong2").is_none());
    assert_eq!(alias(&t, "id_t").unwrap(), "int32");
    assert_eq!(alias(&t, "Undefined").unwrap(), "int32");
    assert_eq!(t.types.iter().filter(|x| x.name == "Stamp").count(), 1);
    assert_eq!(t.warnings, Vec::<String>::new());
    let missing_endif = parse_idl("#if 1\nstruct A { long x; };", &IdlOptions::default()).unwrap_err();
    assert!(missing_endif.0.contains("missing #endif"));
    let error = parse_idl("#error unsupported", &IdlOptions::default()).unwrap_err();
    assert!(error.0.contains("#error unsupported"));
}

#[test]
fn finds_includes_by_name_among_picked_files_and_reads_them_with_the_host() {
    let picked = files(&[
        ("main.idl", "#include \"sub/a.idl\"\nstruct M { A a; B b; };"),
        ("a.idl", "struct A { long x; };"),
    ]);
    let parsed = parse_idl_files(&picked).unwrap();
    assert_eq!(fields(&parsed, "M").unwrap(), ["A a", "B b"]);
    assert!(parsed.missing.is_empty());

    let disk: HashMap<&str, &str> = HashMap::from([
        (
            "/w/idl/main.idl",
            "#include \"inc/b.idl\"\n#include \"shared.idl\"",
        ),
        ("/w/idl/inc/b.idl", "struct B { long y; };"),
        ("/w/shared.idl", "struct S { long z; };"),
    ]);
    let read = |path: &str| disk.get(path).map(|s| s.to_string());
    let all = read_idl_includes(&files(&[("/w/idl/main.idl", disk["/w/idl/main.idl"])]), read);
    let mut keys: Vec<&String> = all.keys().collect();
    keys.sort();
    assert_eq!(keys, ["/w/idl/inc/b.idl", "/w/idl/main.idl", "/w/shared.idl"]);
    let names: Vec<String> = parse_idl_files(&all)
        .unwrap()
        .types
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert_eq!(names, ["B", "S"]);
}

#[test]
fn reads_an_idl_file_as_a_project_its_includes_as_dependencies() {
    let list = files(&[
        (
            "idl/main.idl",
            "#include \"inc/a.idl\"\nstruct M { A a; B b; };\ncomponent Main { provides IA ia; };",
        ),
        (
            "idl/inc/a.idl",
            "#include \"../b.idl\"\nstruct A { B b; };\ninterface IA { void go(); };\ncomponent Other {};",
        ),
        ("idl/b.idl", "struct B { long y; };\nconst long MAX = 3;"),
    ]);
    let out = idl_project("idl/main.idl", &list).unwrap();
    let p = out.project;
    assert_eq!(out.warnings, Vec::<String>::new());
    assert_eq!(p.name, "main");
    let deps: Vec<(&str, &str, &Vec<String>, bool)> = p
        .dependencies
        .iter()
        .map(|x| (x.name.as_str(), x.file.as_str(), &x.uses, x.indirect))
        .collect();
    assert_eq!(
        deps,
        [
            ("a", "inc/a.idl", &strs(&["b"]), false),
            ("b", "b.idl", &strs(&[]), true)
        ]
    );
    let owner = |name: &str| -> Option<String> {
        let id = p
            .types
            .iter()
            .map(|t| (&t.id, &t.name))
            .chain(p.interfaces.iter().map(|t| (&t.id, &t.name)))
            .chain(p.consts.iter().map(|t| (&t.id, &t.name)))
            .find(|(_, n)| n.as_str() == name)
            .unwrap()
            .0;
        dependency_of(&p, id).map(|d| d.name.clone())
    };
    let owners: Vec<Option<String>> = ["M", "A", "IA", "B", "MAX"].iter().map(|n| owner(n)).collect();
    assert_eq!(
        owners,
        [
            None,
            Some("a".into()),
            Some("a".into()),
            Some("b".into()),
            Some("b".into())
        ]
    );
    // Components of included files belong to their own project.
    let modules: Vec<&str> = p.modules.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(modules, ["Main"]);
    assert_eq!(errors(&p), Vec::<String>::new());

    // Depended on like a project file: the files it includes come with it.
    let mut d = empty_project();
    add_dependency(&mut d, &p, "idl/main.idl", None);
    let deps: Vec<(&str, &str, bool)> = d
        .dependencies
        .iter()
        .map(|x| (x.name.as_str(), x.file.as_str(), x.indirect))
        .collect();
    assert_eq!(
        deps,
        [
            ("main", "idl/main.idl", false),
            ("a", "idl/inc/a.idl", true),
            ("b", "idl/b.idl", true)
        ]
    );
    let mut names: Vec<&str> = d.types.iter().map(|t| t.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["A", "B", "M"]);
}

fn assert_nested(p: &Project) {
    for m in p.modules.iter().filter(|x| x.parent_id.is_some()) {
        let parent = p
            .modules
            .iter()
            .find(|x| Some(&x.id) == m.parent_id.as_ref())
            .unwrap();
        assert!(m.layout.x + m.layout.width <= parent.layout.width);
        assert!(m.layout.y + m.layout.height <= parent.layout.height);
    }
}

#[test]
fn reads_the_idl_modules_of_a_file_without_components_as_modules_serving_their_interfaces() {
    let mut list = files(&[
        (
            "idl/main.idl",
            "#include \"a.idl\"\ninterface Top { void t(); };\nmodule A { module Ctl { interface Arm { void go(); }; interface gripper : Arm {}; }; };\nmodule B { module Ctl { interface Lamp { void on(); }; }; };",
        ),
        ("idl/a.idl", "module Other { interface Far { void f(); }; };"),
    ]);
    let out = idl_project("idl/main.idl", &list).unwrap();
    let p = out.project;
    assert_eq!(out.warnings, Vec::<String>::new());
    let iface = |id: &Option<Id>| -> Option<String> {
        p.interfaces
            .iter()
            .find(|i| Some(&i.id) == id.as_ref())
            .map(|i| i.name.clone())
    };
    // Nested like the IDL modules, each inside its parent.
    type PortRow = (String, PortRole, Option<String>);
    let got: Vec<(String, Vec<PortRow>)> = p
        .modules
        .iter()
        .map(|m| {
            (
                module_path(&p, &m.id),
                m.ports
                    .iter()
                    .map(|pt| (pt.name.clone(), pt.role, iface(&pt.interface_id)))
                    .collect(),
            )
        })
        .collect();
    let port = |n: &str, i: &str| (n.to_string(), PortRole::In, Some(i.to_string()));
    assert_eq!(
        got,
        [
            ("main".to_string(), vec![port("top", "Top")]),
            ("A".to_string(), vec![]),
            (
                "A.Ctl".to_string(),
                vec![port("arm", "Arm"), port("gripper", "gripper")]
            ),
            ("B".to_string(), vec![]),
            ("B.Ctl".to_string(), vec![port("lamp", "Lamp")]),
        ]
    );
    // Parents only hold their content: no ports, no links.
    assert!(p.links.is_empty());
    assert_nested(&p);
    assert_eq!(errors(&p), Vec::<String>::new());
    // A file with components: only those.
    list.insert(
        "idl/main.idl".into(),
        "interface I { void go(); };\ncomponent C { provides I i; };".into(),
    );
    let names: Vec<String> = idl_project("idl/main.idl", &list)
        .unwrap()
        .project
        .modules
        .into_iter()
        .map(|m| m.name)
        .collect();
    assert_eq!(names, ["C"]);
}

#[test]
fn nests_the_components_of_a_file_in_their_idl_modules_with_their_types() {
    let list = files(
        &[(
            "idl/main.idl",
            &[
                "interface I { void go(); };",
                "struct Top { long t; };",
                "component Main {};",
                "module A { component Tank { provides I i; }; module Deep { component Pump {}; }; };",
                "module B { const long MAX = 2; struct S { long x; }; component Tank { attribute S s; }; };",
                "module C { interface J { void j(); }; };",
            ]
            .join("\n"),
        )]
        .map(|(k, v)| (k, v.as_str())),
    );
    let out = idl_project("idl/main.idl", &list).unwrap();
    let p = out.project;
    // Renames the modules made needless.
    assert_eq!(out.warnings, Vec::<String>::new());
    // Every IDL module holding definitions or components, serving no interfaces.
    let got: Vec<(String, Vec<&str>)> = p
        .modules
        .iter()
        .map(|m| {
            (
                module_path(&p, &m.id),
                m.ports.iter().map(|pt| pt.name.as_str()).collect(),
            )
        })
        .collect();
    let expected: Vec<(String, Vec<&str>)> = [
        ("Main", vec![]),
        ("A.Tank", vec!["i"]),
        ("A.Deep.Pump", vec![]),
        ("B.Tank", vec![]),
        ("B", vec![]),
        ("C", vec![]),
        ("A", vec![]),
        ("A.Deep", vec![]),
    ]
    .into_iter()
    .map(|(a, b)| (a.to_string(), b))
    .collect();
    assert_eq!(got, expected);
    assert_nested(&p);
    // Types of IDL modules are theirs; those at file scope, constants and interfaces the project's.
    let names = type_names(&p);
    let got: Vec<&String> = p.types.iter().map(|t| &names[&t.id]).collect();
    assert_eq!(got, ["Top", "B.S"]);
    let consts: Vec<&str> = p.consts.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(consts, ["MAX"]);
    let interfaces: Vec<&str> = p.interfaces.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(interfaces, ["I", "J"]);
    assert_eq!(errors(&p), Vec::<String>::new());
}

#[test]
fn gives_the_types_of_idl_modules_to_their_modules_named_simply_there() {
    let main = [
        "#include \"inc.idl\"",
        "struct Top { long t; };",
        "module A { const long MAX = 3; struct Status { long a; }; interface Arm { Status get(); }; };",
        "module B { struct Status { long b; }; module Deep { enum Mode { ON, OFF }; }; };",
        "interface Mixed { A::Status a(); B::Status b(); Common::Kind k(); };",
    ]
    .join("\n");
    let list = files(&[
        ("idl/main.idl", &main),
        (
            "idl/inc.idl",
            "module Common { enum Kind { X, Y }; const short N = 2; };",
        ),
    ]);
    let out = idl_project("idl/main.idl", &list).unwrap();
    let p = out.project;
    assert_eq!(out.warnings, Vec::<String>::new());
    // Modules holding only types are modules too.
    let paths: Vec<String> = p.modules.iter().map(|m| module_path(&p, &m.id)).collect();
    assert_eq!(paths, ["A", "B", "B.Deep", "main"]);
    let names = type_names(&p);
    let own: Vec<&String> = p
        .types
        .iter()
        .filter(|t| t.dependency.is_none())
        .map(|t| &names[&t.id])
        .collect();
    assert_eq!(own, ["Top", "A.Status", "B.Status", "B.Deep.Mode"]);
    // Constants are the project's.
    let mut consts: Vec<&str> = p.consts.iter().map(|c| c.name.as_str()).collect();
    consts.sort();
    assert_eq!(consts, ["MAX", "N"]);
    // Those of included files: of their module by path, in their own project.
    let kind = p.types.iter().find(|t| t.name == "Kind").unwrap();
    assert_eq!(kind.module_path.as_deref(), Some("Common"));
    // Public: used by interfaces outside their module.
    assert_eq!(errors(&p), Vec::<String>::new());

    // Depended on: under their module's path.
    let mut d = empty_project();
    add_dependency(&mut d, &p, "idl/main.idl", None);
    let dep_names = type_names(&d);
    let mut got: Vec<&String> = d.types.iter().map(|t| &dep_names[&t.id]).collect();
    got.sort();
    assert_eq!(
        got,
        [
            "Top",
            "inc/Common.Kind",
            "main/A.Status",
            "main/B.Deep.Mode",
            "main/B.Status"
        ]
    );
    let mut consts: Vec<&str> = d.consts.iter().map(|c| c.name.as_str()).collect();
    consts.sort();
    assert_eq!(consts, ["MAX", "N"]);
}

#[test]
fn resolves_scoped_names_and_qualifies_names_several_modules_use() {
    let t = parse(
        r#"
      module A { struct Status { long a; }; struct Use { Status s; }; };
      module B {
        struct Status { long b; };
        struct Use2 { Status s; ::A::Status t; A::Status u; };
        interface I { typedef long Local; Local get(); };
        interface J : I { Local again(); };
      };
      struct set { long x; };
    "#,
    );
    assert_eq!(fields(&t, "Use").unwrap(), ["A_Status s"]);
    assert_eq!(
        fields(&t, "Use2").unwrap(),
        ["B_Status s", "A_Status t", "A_Status u"]
    );
    assert_eq!(sig(&t, "J"), ["get(): Local", "again(): Local"]);
    assert!(matches!(
        type_named(&t, "set_").unwrap().body,
        FileTypeBody::Struct { .. }
    ));
    assert_eq!(
        t.warnings,
        [
            "A::Status imported as A_Status",
            "B::Status imported as B_Status",
            "set imported as set_"
        ]
    );
    imports_cleanly(&t);
}

#[test]
fn imports_object_references_as_custom_primitives() {
    let t = parse(
        r#"
      interface Node;
      interface Tree { Node root(); any value(); Object raw(); };
      interface Node { Tree owner(); };
    "#,
    );
    assert_eq!(
        sig(&t, "Tree"),
        ["root(): NodeRef", "value(): Any", "raw(): Object"]
    );
    let node_ref = type_named(&t, "NodeRef").unwrap();
    assert!(matches!(node_ref.body, FileTypeBody::Primitive {}));
    assert_eq!(
        node_ref.description.as_deref(),
        Some("Reference to a Node object")
    );
    assert_eq!(t.needs["NodeRef"], ["Node"]);
    assert_eq!(t.needs["TreeRef"], ["Tree"]);
    let clip = idl_import(&t, &empty_project(), Some(&strs(&["Tree"])), false)
        .clip
        .unwrap();
    let mut names: Vec<&str> = clip.interfaces.iter().map(|i| i.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["Node", "Tree"]);
    imports_cleanly(&t);
}

#[test]
fn reads_annotations() {
    let t = parse(
        r#"
      @annotation Units { string value; };
      @bit_bound(8) enum Small { @value(1) ONE, TWO };
      @bit_bound(16) bitmask Flags { A, @position(9) B };
      bitmask Big { A, @position(63) TOP };
      @final @topic
      struct S {
        @key @default(3) long count;
        @unit("m") @range(min=0, max=10.5) double length;
        @default(TWO) Small small;
        @verbatim(language="c++", text="x") @external @id(4) long other;
      };
    "#,
    );
    match &type_named(&t, "Small").unwrap().body {
        FileTypeBody::Enum { underlying, values } => {
            assert_eq!(*underlying, IntPrimitive::Uint8);
            assert_eq!(values[0].value, 1);
            assert_eq!(values[1].value, 2);
        }
        other => panic!("{other:?}"),
    }
    match &type_named(&t, "Flags").unwrap().body {
        FileTypeBody::Bitmask { underlying, flags } => {
            assert_eq!(*underlying, UnsignedPrimitive::Uint16);
            let got: Vec<(&str, u32)> = flags.iter().map(|f| (f.name.as_str(), f.bit)).collect();
            assert_eq!(got, [("A", 0), ("B", 9)]);
        }
        other => panic!("{other:?}"),
    }
    match &type_named(&t, "Big").unwrap().body {
        FileTypeBody::Bitmask { underlying, flags } => {
            assert_eq!(*underlying, UnsignedPrimitive::Uint64);
            assert_eq!(flags[0].bit, 0);
            assert_eq!(flags[1].bit, 63);
        }
        other => panic!("{other:?}"),
    }
    match &type_named(&t, "S").unwrap().body {
        FileTypeBody::Struct { fields, .. } => {
            let got: Vec<(&str, Option<&Value>, Option<&str>)> = fields
                .iter()
                .map(|f| (f.name.as_str(), f.default.as_ref(), f.description.as_deref()))
                .collect();
            assert_eq!(
                got,
                [
                    ("count", Some(&json!(3)), None),
                    ("length", None, Some("Unit: m.\nRange: 0 to 10.5.")),
                    ("small", Some(&json!("TWO")), None),
                    ("other", None, None),
                ]
            );
        }
        other => panic!("{other:?}"),
    }
    imports_cleanly(&t);
}

#[test]
fn reads_valuetypes_eventtypes_bitsets_and_other_definitions() {
    let t = parse(
        r#"
      typeprefix M "acme.com";
      native Handle;
      valuetype Name string;
      abstract valuetype Shape { double area(); };
      valuetype Base { public long id; };
      custom valuetype Circle : truncatable Base supports Shape {
        public double radius;
        private string secret;
        factory create(in double r);
        double area();
      };
      eventtype Alarm { public string text; };
      bitset Bits { bitfield<1> on; bitfield<3> level, mode; bitfield<2>; bitfield<12, short> big; };
      typedef struct Inner { long v; } InnerAlias;
      struct Outer { struct Nested { long n; } nested; enum Color { RED, GREEN } color; };
      typeid Base "IDL:Base:1.0";
      typedef fixed<10, 2> Money;
      typedef long double Precise;
    "#,
    );
    assert!(matches!(
        type_named(&t, "Handle").unwrap().body,
        FileTypeBody::Primitive {}
    ));
    assert_eq!(alias(&t, "Name").unwrap(), "optional<string>");
    assert_eq!(sig(&t, "Shape"), ["area(): float64"]);
    assert_eq!(
        fields(&t, "Circle").unwrap(),
        ["int32 id", "float64 radius", "string secret"]
    );
    assert_eq!(fields(&t, "Alarm").unwrap(), ["string text"]);
    assert_eq!(
        fields(&t, "Bits").unwrap(),
        ["bool on", "uint8 level", "uint8 mode", "int16 big"]
    );
    assert_eq!(alias(&t, "InnerAlias").unwrap(), "Inner");
    assert_eq!(fields(&t, "Outer").unwrap(), ["Nested nested", "Color color"]);
    assert_eq!(alias(&t, "Money").unwrap(), "float64");
    assert_eq!(
        t.warnings,
        [
            "Line 7: valuetype Circle: 2 operations, factories or attributes left out",
            "Line 14: bitset Bits imported as a struct of its bitfields",
            "Line 18: fixed imported as float64",
            "Line 19: long double imported as float64"
        ]
    );
    imports_cleanly(&t);
}

#[test]
fn instantiates_template_modules() {
    let t = parse(
        r#"
      module Buffers<typename T, const long N> {
        struct Ring { T items[N]; long head; };
        interface Queue { void push(in T item); };
      };
      module Buffers<double, 8> Doubles;
      module Buffers<string, 2> Strings;
    "#,
    );
    assert_eq!(
        fields(&t, "Doubles_Ring").unwrap(),
        ["array<float64, 8> items", "int32 head"]
    );
    assert_eq!(
        fields(&t, "Strings_Ring").unwrap(),
        ["array<string, 2> items", "int32 head"]
    );
    assert_eq!(sig(&t, "Doubles_Queue"), ["push(in float64 item)"]);
}

#[test]
fn imports_components_and_connectors_as_modules_with_ports() {
    let t = parse(
        r#"
      interface Pump { void start(); };
      interface Admin { void reset(); };
      eventtype Level { public double value; };
      porttype Control { provides Pump pump; uses Admin admin; attribute long rate; };
      component Device supports Admin {
        attribute string serial;
        readonly attribute long errors;
      };
      component Tank : Device {
        provides Pump inlet;
        uses multiple Pump outlets;
        publishes Level level;
        consumes Level alarm;
        port Control ctl;
        mirrorport Control back;
      };
      home TankHome manages Tank { factory build(in long size); };
      connector Wire { mirrorport Control a; };
    "#,
    );
    let names: Vec<&str> = t.components.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["Device", "Tank", "Wire"]);
    let tank = t.components.iter().find(|c| c.name == "Tank").unwrap();
    assert_eq!(tank.bases, ["Device"]);
    let ports: Vec<String> = tank
        .ports
        .iter()
        .map(|p| format!("{} {}: {}", p.role, p.name, p.interface.as_deref().unwrap()))
        .collect();
    assert_eq!(
        ports,
        [
            "in inlet: Pump",
            "out outlets: Pump",
            "out level: LevelConsumer",
            "in alarm: LevelConsumer",
            "in ctl_pump: Pump",
            "out ctl_admin: Admin",
            "out back_pump: Pump",
            "in back_admin: Admin"
        ]
    );
    let attrs: Vec<&str> = tank.attributes.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(attrs, ["ctl_rate", "back_rate"]);
    assert_eq!(sig(&t, "LevelConsumer"), ["push(in Level event)"]);
    let device = t.components.iter().find(|c| c.name == "Device").unwrap();
    assert_eq!(signatures(&device.methods), ["reset()"]);
    let attrs: Vec<(&str, bool)> = device
        .attributes
        .iter()
        .map(|a| (a.name.as_str(), a.readonly))
        .collect();
    assert_eq!(attrs, [("serial", false), ("errors", true)]);
    assert_eq!(t.warnings, ["Line 18: home TankHome left out"]);

    let mut p = empty_project();
    let clip = idl_import(&t, &p, Some(&strs(&["Tank"])), false).clip.unwrap();
    let modules: Vec<&str> = clip.modules.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(modules, ["Device", "Tank"]);
    let mut interfaces: Vec<&str> = clip.interfaces.iter().map(|i| i.name.as_str()).collect();
    interfaces.sort();
    assert_eq!(interfaces, ["Admin", "LevelConsumer", "Pump"]);
    paste(&mut p, &clip);
    assert_eq!(errors(&p), Vec::<String>::new());
    let tank_module = p.modules.iter().find(|m| m.name == "Tank").unwrap();
    let device_id = p.modules.iter().find(|m| m.name == "Device").unwrap().id.clone();
    assert_eq!(tank_module.bases, Some(vec![device_id]));
    assert!(tank_module.ports.iter().all(|pt| pt.interface_id.is_some()));
    imports_cleanly(&t);
}

#[test]
fn adds_empty_interfaces_for_ports_of_unknown_interfaces() {
    let t = parse("component C { provides Missing m; uses Object o; };");
    let mut p = empty_project();
    let import = idl_import(&t, &p, None, false);
    let mut unresolved = import.unresolved.clone();
    unresolved.sort();
    assert_eq!(unresolved, ["Missing", "Object"]);
    let clip = import.clip.unwrap();
    let mut names: Vec<&str> = clip.interfaces.iter().map(|i| i.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["Missing", "Object"]);
    paste(&mut p, &clip);
    assert_eq!(errors(&p), Vec::<String>::new());
}

// Examples

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// A list as `pretty-format` prints it, one item per line.
fn snapshot_list(out: &mut String, key: &str, items: &[String]) {
    if items.is_empty() {
        out.push_str(&format!("  \"{key}\": [],\n"));
        return;
    }
    out.push_str(&format!("  \"{key}\": [\n"));
    for i in items {
        out.push_str(&format!(
            "    \"{}\",\n",
            i.replace('\\', "\\\\").replace('"', "\\\"")
        ));
    }
    out.push_str("  ],\n");
}

#[test]
fn imports_the_examples() {
    let dir = root().join("examples/idl");
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|f| f.ends_with(".idl"))
        .collect();
    names.sort();
    assert!(names.len() >= 5);
    let examples: IndexMap<String, String> = names
        .iter()
        .map(|f| (f.clone(), fs::read_to_string(dir.join(f)).unwrap()))
        .collect();
    let snap = fs::read_to_string(root().join("tests/__snapshots__/idl.test.ts.snap")).unwrap();
    for file in &names {
        let options = IdlOptions {
            file: file.clone(),
            files: examples.clone(),
        };
        let example = parse_idl(&examples[file], &options).unwrap_or_else(|e| panic!("{file}: {e}"));
        assert!(example.missing.is_empty(), "{file}");
        let mut p = empty_project();
        let clip = idl_import(&example, &p, None, false).clip.unwrap();
        paste(&mut p, &clip);
        assert_eq!(errors(&p), Vec::<String>::new(), "{file}");
        let mut out = String::from("\n{\n");
        snapshot_list(
            &mut out,
            "interfaces",
            &p.interfaces.iter().map(|i| i.name.clone()).collect::<Vec<_>>(),
        );
        snapshot_list(
            &mut out,
            "modules",
            &p.modules
                .iter()
                .map(|m| {
                    let ports: Vec<String> = m
                        .ports
                        .iter()
                        .map(|pt| format!("{} {}", pt.role, pt.name))
                        .collect();
                    format!("{}: {}", m.name, ports.join(", "))
                })
                .collect::<Vec<_>>(),
        );
        snapshot_list(
            &mut out,
            "types",
            &p.types
                .iter()
                .map(|t| format!("{} {}", t.kind(), t.name))
                .collect::<Vec<_>>(),
        );
        snapshot_list(&mut out, "warnings", &example.warnings);
        out.push_str("}\n");
        let head = format!("exports[`IDL import > imports examples/idl/{file} 1`] = `");
        let start = snap
            .find(&head)
            .unwrap_or_else(|| panic!("no snapshot for {file}"))
            + head.len();
        let end = start + snap[start..].find("`;").unwrap();
        assert_eq!(&snap[start..end], out, "{file}");
    }
}
