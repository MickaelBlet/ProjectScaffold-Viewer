//! Port of `tests/dependencies.test.ts`. Left out: the checks against the JSON Schema (no schema
//! validator in this crate; the file shape is checked field by field instead).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use scaffold_model::dependencies::*;
use scaffold_model::project::*;
use scaffold_model::serialize::{Format, from_file, load_text, to_file};
use scaffold_model::sync::{diff_renames, resolve_relative};
use scaffold_model::typeexpr::print_type_ref;
use scaffold_model::types::*;
use scaffold_model::validate::{Severity, validate};
use serde_json::{Value, json};

const F32: &str = "{ kind: primitive, name: float32 }";

fn load(yaml: &str) -> Project {
    load_text(yaml, Format::Yaml).unwrap_or_else(|e| panic!("{e}"))
}

fn read(name: &str) -> Project {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../examples")
        .join(name);
    load(&fs::read_to_string(path).unwrap())
}

fn by_path<'a>(p: &'a Project, path: &str) -> &'a Module {
    p.modules.iter().find(|m| module_path(p, &m.id) == path).unwrap()
}

fn by_path_mut<'a>(p: &'a mut Project, path: &str) -> &'a mut Module {
    let id = by_path(p, path).id.clone();
    find_module_mut(p, &id).unwrap()
}

fn errors(p: &Project) -> Vec<String> {
    validate(p)
        .into_iter()
        .filter(|pr| pr.severity == Severity::Error)
        .map(|pr| pr.message)
        .collect()
}

fn strs(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

fn produce(p: &Project, f: impl FnOnce(&mut Project)) -> Project {
    let mut q = p.clone();
    f(&mut q);
    q
}

fn units() -> Project {
    load(&format!(
        "
schemaVersion: 1
project: {{ name: Units }}
types:
  - {{ kind: alias, name: Meters, type: {F32} }}
interfaces: []
modules: []
links: []
"
    ))
}

/// Common, saved in `lib/common.scaffold.yaml`, depends on Units saved next to it.
fn common() -> Project {
    load(&format!(
        "
schemaVersion: 1
project: {{ name: Common }}
types:
  - kind: struct
    name: Vec3
    fields: [{{ name: x, type: {{ kind: ref, name: Meters }} }}]
interfaces:
  - name: Telemetry
    messages: [{{ name: publish, params: [{{ name: at, type: {{ kind: ref, name: Vec3 }} }}], returns: null }}]
modules: []
links: []
dependencies:
  - name: Units
    file: units.scaffold.yaml
    types:
      - {{ kind: alias, name: Meters, type: {F32} }}
    interfaces: []
"
    ))
}

fn station() -> Project {
    load(
        "
schemaVersion: 1
project: { name: Station }
types: []
interfaces: []
modules: [{ name: Monitor, ports: [] }]
links: []
",
    )
}

fn telemetry_port(telemetry: &str) -> Port {
    Port {
        id: "in".into(),
        name: "telemetry".into(),
        role: PortRole::In,
        interface_id: Some(telemetry.into()),
        description: String::new(),
        label: None,
    }
}

/// A project with a module whose port uses `Telemetry`, bound after the dependency is added.
fn with_common(p: &Project) -> (Project, DependencyResult) {
    let mut d = p.clone();
    let r = add_dependency(
        &mut d,
        &common(),
        "lib/common.scaffold.yaml",
        Some("station.scaffold.yaml"),
    );
    if let Some(t) = d
        .interfaces
        .iter()
        .find(|i| i.name == "Telemetry")
        .map(|i| i.id.clone())
    {
        d.modules[0].ports.push(telemetry_port(&t));
    }
    (d, r)
}

/// Robot's Core.Sensor placed in `p` (with Core).
fn sensor_of(p: &Project) -> &ImportedModule {
    p.dependencies[0]
        .modules
        .iter()
        .find(|m| m.path == "Core.Sensor")
        .unwrap()
}

fn sensor_of_mut(p: &mut Project) -> &mut ImportedModule {
    p.dependencies[0]
        .modules
        .iter_mut()
        .find(|m| m.path == "Core.Sensor")
        .unwrap()
}

/// Paths of a module of `p` and of its content, parents first.
fn tree_paths(p: &Project, path: &str) -> Vec<String> {
    fn visit(p: &Project, id: &str, out: &mut Vec<String>) {
        out.push(module_path(p, id));
        for c in p.modules.iter().filter(|m| m.parent_id.as_deref() == Some(id)) {
            visit(p, &c.id, out);
        }
    }
    let mut out = Vec::new();
    visit(p, &by_path(p, path).id, &mut out);
    out
}

/// Station linking its Monitor to Robot's Core.Sensor, placed from robot.scaffold.yaml: placing it
/// places Core (`placed_id`) with its content.
fn monitor() -> (Project, String, DependencyResult) {
    let robot = read("robot.scaffold.yaml");
    let mut d = station();
    let placed = place_module(
        &mut d,
        &robot,
        "robot.scaffold.yaml",
        &by_path(&robot, "Core.Sensor").id,
        Point { x: 500., y: 40. },
        Some("station.scaffold.yaml"),
    );
    let telemetry = d
        .interfaces
        .iter()
        .find(|i| i.name == "Telemetry")
        .unwrap()
        .id
        .clone();
    d.modules[0].ports.push(telemetry_port(&telemetry));
    let sensor = sensor_of(&d);
    let link = Link {
        id: "l".into(),
        name: "sensor_to_monitor".into(),
        description: String::new(),
        from: Endpoint {
            module_id: sensor.id.clone(),
            port_id: sensor.ports[0].id.clone(),
        },
        to: Endpoint {
            module_id: d.modules[0].id.clone(),
            port_id: "in".into(),
        },
        constraints: default_constraints(None),
        color: None,
        route: None,
    };
    d.links.push(link);
    (d, placed.id.unwrap(), placed.result)
}

fn alias_type(name: &str, ty: TypeRef) -> TypeDef {
    TypeDef {
        id: name.to_lowercase(),
        name: name.into(),
        description: String::new(),
        dependency: None,
        module: None,
        module_path: None,
        access: None,
        body: TypeBody::Alias { ty },
    }
}

fn info(p: &Project) -> Vec<(String, Vec<String>, bool)> {
    p.dependencies
        .iter()
        .map(|x| (x.name.clone(), x.uses.clone(), x.indirect))
        .collect()
}

fn f64_of(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

#[test]
fn names_dependencies_after_the_project() {
    assert_eq!(dependency_name("Robot"), "Robot");
    assert_eq!(dependency_name("my robot-2"), "my_robot_2");
    assert_eq!(dependency_name("2d nav"), "_2d_nav");
    assert_eq!(dependency_name("!!"), "Other");
}

#[test]
fn rebases_nested_dependency_files() {
    assert_eq!(
        resolve_relative("lib/common.yaml", "units.yaml"),
        "lib/units.yaml"
    );
    assert_eq!(resolve_relative("lib/common.yaml", "../units.yaml"), "units.yaml");
    assert_eq!(
        resolve_relative("../shared/common.yaml", "./x/units.yaml"),
        "../shared/x/units.yaml"
    );
}

#[test]
fn adds_a_dependency_with_the_dependencies_it_uses() {
    let (p, r) = with_common(&station());
    assert!(r.conflicts.is_empty());
    let deps: Vec<_> = p
        .dependencies
        .iter()
        .map(|x| (x.name.as_str(), x.file.as_str(), x.uses.clone(), x.indirect))
        .collect();
    assert_eq!(
        deps,
        vec![
            ("Common", "lib/common.scaffold.yaml", strs(&["Units"]), false),
            ("Units", "lib/units.scaffold.yaml", vec![], true)
        ]
    );
    let vec3 = p.types.iter().find(|t| t.name == "Vec3").unwrap();
    let meters = p.types.iter().find(|t| t.name == "Meters").unwrap();
    assert_eq!(
        dependency_of(&p, &vec3.id).map(|d| d.name.as_str()),
        Some("Common")
    );
    assert_eq!(
        dependency_of(&p, &meters.id).map(|d| d.name.as_str()),
        Some("Units")
    );
    let TypeBody::Struct { fields, .. } = &vec3.body else {
        panic!("struct")
    };
    assert_eq!(fields[0].ty, TypeRef::to(meters.id.clone()));
    assert_eq!(errors(&p), Vec::<String>::new());
}

#[test]
fn adds_several_dependencies_at_once_the_dependencies_they_use_from_their_own_files() {
    // Units as read from its file: newer than the snapshot Common has of it.
    let mut newer = units();
    let TypeBody::Alias { ty } = newer.types[0].body.clone() else {
        panic!("alias")
    };
    newer.types.push(alias_type("Feet", ty));
    let (c, u) = (common(), units());
    let mut p = station();
    let r = add_dependencies(
        &mut p,
        &[
            DependencySource {
                project: &c,
                file: "lib/common.scaffold.yaml".into(),
                indirect: false,
            },
            DependencySource {
                project: &newer,
                file: "lib/units.scaffold.yaml".into(),
                indirect: true,
            },
        ],
        Some("station.scaffold.yaml"),
    );
    assert!(r.conflicts.is_empty());
    assert_eq!(
        info(&p),
        vec![
            ("Common".to_string(), strs(&["Units"]), false),
            ("Units".to_string(), vec![], true)
        ]
    );
    let mut names: Vec<_> = p.types.iter().map(|t| t.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["Feet", "Meters", "Vec3"]);

    // Both picked: both direct.
    let mut q = station();
    add_dependencies(
        &mut q,
        &[
            DependencySource {
                project: &u,
                file: "lib/units.scaffold.yaml".into(),
                indirect: false,
            },
            DependencySource {
                project: &c,
                file: "lib/common.scaffold.yaml".into(),
                indirect: false,
            },
        ],
        Some("station.scaffold.yaml"),
    );
    assert_eq!(
        info(&q),
        vec![
            ("Units".to_string(), vec![], false),
            ("Common".to_string(), strs(&["Units"]), false)
        ]
    );
    assert_eq!(errors(&q), Vec::<String>::new());
}

#[test]
fn round_trips_through_the_file_format() {
    let (p, _) = with_common(&station());
    let file = to_file(&p, false);
    assert_eq!(file["types"], json!([]));
    let names: Vec<_> = file["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Common", "Units"]);
    let back = from_file(&file, None).unwrap();
    assert_eq!(to_file(&back, false), file);
    assert_eq!(
        back.modules[0].ports[0].interface_id.as_ref(),
        Some(&back.interfaces[0].id)
    );
}

#[test]
fn copies_the_constants_of_a_dependency_follows_their_renames_drops_removed_ones() {
    let mut constants = common();
    let type_id = constants.types[0].id.clone();
    constants.consts.push(ConstDef {
        id: "g".into(),
        name: "Gravity".into(),
        description: String::new(),
        dependency: None,
        ty: TypeRef::primitive(Primitive::Float32),
        value: json!(9.81),
    });
    constants.consts.push(ConstDef {
        id: "o".into(),
        name: "Origin".into(),
        description: String::new(),
        dependency: None,
        ty: TypeRef::to(type_id),
        value: json!({ "x": 1 }),
    });
    let mut p = station();
    add_dependency(&mut p, &constants, "common.scaffold.yaml", None);
    let dep = p
        .dependencies
        .iter()
        .find(|x| x.name == "Common")
        .unwrap()
        .clone();
    let consts: Vec<_> = p
        .consts
        .iter()
        .map(|c| (c.name.as_str(), c.dependency.clone()))
        .collect();
    assert_eq!(
        consts,
        vec![
            ("Gravity", Some(dep.id.clone())),
            ("Origin", Some(dep.id.clone()))
        ]
    );
    assert_eq!(errors(&p), Vec::<String>::new());
    // File: under the dependency.
    let file = to_file(&p, false);
    assert!(file.get("constants").is_none());
    let names: Vec<_> = file["dependencies"][0]["constants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Gravity", "Origin"]);
    assert_eq!(to_file(&from_file(&file, None).unwrap(), false), file);
    // Renamed in the dependency, then removed there.
    let renamed = produce(&constants, |d| d.consts[0].name = "G".into());
    let q = produce(&p, |d| {
        apply_dependency_renames(
            d,
            "common.scaffold.yaml",
            &diff_renames(&constants, &renamed).unwrap(),
        )
    });
    let names: Vec<_> = q.consts.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["G", "Origin"]);
    let removed = produce(&renamed, |d| d.consts.clear());
    let r = produce(&q, |d| {
        refresh_dependencies(d, &HashMap::from([(dep.id.clone(), removed)]), None);
    });
    assert!(r.consts.is_empty());
}

#[test]
fn keeps_ids_when_reloaded() {
    let (p, _) = with_common(&station());
    let again = from_file(&to_file(&p, true), Some(&p)).unwrap();
    let ids = |l: &[TypeDef]| l.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&again.types), ids(&p.types));
    let ids = |l: &[Interface]| l.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&again.interfaces), ids(&p.interfaces));
}

#[test]
fn reports_names_defined_both_here_and_in_a_dependency() {
    let mut file = to_file(&with_common(&station()).0, false);
    file["types"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "kind": "primitive", "name": "Vec3" }));
    let e = from_file(&file, None).unwrap_err();
    assert!(e.to_string().contains("Duplicate type name 'Vec3'"), "{e}");
}

#[test]
fn takes_over_an_own_entity_with_the_same_definition_skips_a_different_one() {
    let mut same = station();
    add_dependency(&mut same, &units(), "units.scaffold.yaml", None);
    let detached = produce(&same, |d| {
        let id = d.dependencies[0].id.clone();
        detach_dependency(d, &id);
    });
    assert_eq!(detached.types[0].dependency, None);
    let again = with_common(&detached);
    assert!(again.1.conflicts.is_empty());
    assert_eq!(
        again.0.types.iter().find(|t| t.name == "Meters").unwrap().id,
        detached.types[0].id
    );

    let other = produce(&detached, |d| {
        d.types[0].body = TypeBody::Alias {
            ty: TypeRef::primitive(Primitive::Float64),
        }
    });
    let (p, r) = with_common(&other);
    assert_eq!(r.conflicts, ["Units: Meters is already defined differently here"]);
    // The rest is taken all the same.
    assert_eq!(
        p.types.iter().find(|t| t.name == "Meters").unwrap().dependency,
        None
    );
    let vec3 = p.types.iter().find(|t| t.name == "Vec3").unwrap();
    assert_eq!(
        dependency_of(&p, &vec3.id).map(|d| d.name.as_str()),
        Some("Common")
    );
}

#[test]
fn shares_an_entity_two_dependencies_define_the_same_way_and_hands_it_over_on_removal() {
    // Other defines Meters like Units does.
    let other = load(&format!(
        "
schemaVersion: 1
project: {{ name: Other }}
types:
  - {{ kind: alias, name: Meters, type: {F32} }}
interfaces: []
modules: []
links: []
"
    ));
    let mut p = with_common(&station()).0;
    let r = add_dependency(&mut p, &other, "other.scaffold.yaml", None);
    assert!(r.conflicts.is_empty());
    let dep = |p: &Project, name: &str| p.dependencies.iter().find(|x| x.name == name).unwrap().clone();
    assert_eq!(dep(&p, "Other").shared, ["Meters"]);
    assert_eq!(p.types.iter().filter(|t| t.name == "Meters").count(), 1);
    assert_eq!(errors(&p), Vec::<String>::new());
    let file = to_file(&p, false);
    let other_file = file["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == "Other")
        .unwrap();
    assert_eq!(other_file["shared"], json!(["Meters"]));
    assert_eq!(other_file["types"], json!([]));
    assert_eq!(to_file(&from_file(&file, None).unwrap(), false), file);

    // Without Common, Units goes; Meters stays, with Other.
    let q = produce(&p, |d| {
        d.modules[0].ports = vec![];
        assert!(remove_dependency(d, &dep(&p, "Common").id, false).is_empty());
    });
    let shared: Vec<_> = q
        .dependencies
        .iter()
        .map(|x| (x.name.as_str(), x.shared.clone()))
        .collect();
    assert_eq!(shared, vec![("Other", vec![])]);
    let meters = q.types.iter().find(|t| t.name == "Meters").unwrap();
    assert_eq!(
        dependency_of(&q, &meters.id).map(|d| d.name.as_str()),
        Some("Other")
    );
}

#[test]
fn refuses_a_dependency_using_this_project() {
    let mut d = station();
    let r = add_dependency(
        &mut d,
        &common(),
        "lib/common.scaffold.yaml",
        Some("lib/units.scaffold.yaml"),
    );
    assert_eq!(
        r.conflicts,
        ["lib/units.scaffold.yaml: uses this project (cycle)"]
    );
}

#[test]
fn refreshes_renamed_entities_keep_their_id_removed_ones_still_used_stay_as_own_ones() {
    let (p, _) = with_common(&station());
    let telemetry_id = p.interfaces[0].id.clone();
    let changed = produce(&common(), |d| {
        d.interfaces[0].name = "Telemetry2".into();
        d.types.retain(|t| t.name != "Vec3");
        d.interfaces[0].messages[0].params = vec![];
    });
    let mut q = p.clone();
    let id = q.dependencies[0].id.clone();
    let r = refresh_dependencies(&mut q, &HashMap::from([(id, changed)]), None);
    assert_eq!(r.renamed, ["Telemetry → Telemetry2"]);
    assert_eq!(q.interfaces[0].id, telemetry_id);
    assert_eq!(q.interfaces[0].name, "Telemetry2");
    assert!(!q.types.iter().any(|t| t.name == "Vec3"));
    assert_eq!(errors(&q), Vec::<String>::new());
}

#[test]
fn leaves_a_project_unchanged_when_refreshed_from_the_same_content() {
    let (p, _, _) = monitor();
    let mut q = p.clone();
    let id = q
        .dependencies
        .iter()
        .find(|x| x.name == "Robot")
        .unwrap()
        .id
        .clone();
    refresh_dependencies(&mut q, &HashMap::from([(id, read("robot.scaffold.yaml"))]), None);
    assert_eq!(q, p);
}

#[test]
fn follows_renames_made_in_an_open_dependency() {
    let (p, _) = with_common(&station());
    let renamed = produce(&common(), |d| d.types[0].name = "Vector".into());
    let q = produce(&p, |d| {
        apply_dependency_renames(
            d,
            "common.scaffold.yaml",
            &diff_renames(&common(), &renamed).unwrap(),
        )
    });
    let dep = q.dependencies[0].id.clone();
    assert_eq!(
        q.types
            .iter()
            .find(|t| t.dependency.as_ref() == Some(&dep))
            .unwrap()
            .name,
        "Vector"
    );
}

#[test]
fn removes_a_dependency_only_when_unused_detaches_it_otherwise() {
    let (p, _) = with_common(&station());
    let mut d = p.clone();
    let id = d.dependencies[1].id.clone();
    assert_eq!(
        remove_dependency(&mut d, &id, false),
        ["dependency Common", "Meters"]
    );
    let mut d = p.clone();
    let id = d.dependencies[0].id.clone();
    assert_eq!(remove_dependency(&mut d, &id, false), ["Telemetry"]);

    let own = produce(&p, |d| {
        let id = d.dependencies[0].id.clone();
        detach_dependency(d, &id);
    });
    let deps: Vec<_> = own
        .dependencies
        .iter()
        .map(|x| (x.name.as_str(), x.indirect))
        .collect();
    assert_eq!(deps, vec![("Units", false)]);
    assert_eq!(errors(&own), Vec::<String>::new());

    let unused = produce(&p, |d| {
        d.modules[0].ports = vec![];
        let id = d.dependencies[0].id.clone();
        remove_dependency(d, &id, false);
    });
    assert!(unused.dependencies.is_empty());
    assert!(unused.types.is_empty());
}

#[test]
fn removes_a_used_dependency_when_forced_keeping_the_names_it_leaves_missing() {
    let (p, _) = with_common(&station());
    let mut d = p.clone();
    let id = d.dependencies[1].id.clone();
    assert_eq!(remove_dependency(&mut d, &id, true), ["dependency Common"]);
    let q = produce(&p, |d| {
        let id = d.dependencies[0].id.clone();
        remove_dependency(d, &id, true);
    });
    assert!(q.dependencies.is_empty());
    assert_eq!(
        errors(&q),
        ["Monitor:telemetry references unknown interface 'Telemetry'"]
    );
    let file = to_file(&q, false);
    assert_eq!(file["modules"][0]["ports"][0]["interface"], "Telemetry");
    assert_eq!(errors(&from_file(&file, None).unwrap()), errors(&q));
}

#[test]
fn checks_that_dependency_entities_only_use_their_dependencies() {
    let (p, _) = with_common(&station());
    let q = produce(&p, |d| d.dependencies[0].uses = vec![]);
    assert_eq!(
        errors(&q),
        ["Vec3.x: 'Meters' is not in its dependency or the dependencies it uses"]
    );
}

// Placed modules.

#[test]
fn places_a_module_depending_on_its_project_instead_of_copying_its_interfaces() {
    let robot = read("robot.scaffold.yaml");
    let (p, placed_id, r) = monitor();
    assert!(r.conflicts.is_empty());
    let deps: Vec<_> = p
        .dependencies
        .iter()
        .map(|x| (x.name.as_str(), x.file.as_str(), x.uses.clone(), x.indirect))
        .collect();
    assert_eq!(
        deps,
        vec![
            ("Robot", "robot.scaffold.yaml", strs(&["Common"]), false),
            ("Common", "common.scaffold.yaml", vec![], true)
        ]
    );
    // Its top-level module, with its content where its project puts it.
    let core = by_path(&robot, "Core");
    let paths: Vec<_> = p.dependencies[0].modules.iter().map(|m| m.path.clone()).collect();
    assert_eq!(paths, tree_paths(&robot, "Core"));
    let first = &p.dependencies[0].modules[0];
    assert_eq!(first.id, placed_id);
    assert_eq!(first.path, "Core");
    assert_eq!(first.position, Point { x: 500., y: 40. });
    assert_eq!(
        first.size,
        Some(Size {
            width: core.layout.width,
            height: core.layout.height
        })
    );
    let sensor = by_path(&robot, "Core.Sensor").layout;
    let placed = sensor_of(&p);
    assert_eq!(
        placed.position,
        Point {
            x: sensor.x,
            y: sensor.y
        }
    );
    assert_eq!(
        placed.size,
        Some(Size {
            width: sensor.width,
            height: sensor.height
        })
    );
    assert_eq!(placed.ports.len(), 1);
    assert_eq!(placed.ports[0].name, "out");
    assert_eq!(placed.ports[0].role, PortRole::Out);
    assert_eq!(placed.ports[0].interface.as_deref(), Some("Telemetry"));
    let abs = absolute_rect(&p, &placed.id);
    assert_eq!((abs.x, abs.y), (500. + sensor.x, 40. + sensor.y));
    assert!(
        p.interfaces
            .iter()
            .all(|i| dependency_of(&p, &i.id).map(|d| d.name.as_str()) == Some("Common"))
    );
    assert_eq!(
        p.types
            .iter()
            .find(|t| t.name == "Primitive")
            .unwrap()
            .dependency
            .as_ref(),
        Some(&p.dependencies[0].id)
    );
    assert_eq!(module_path(&p, &placed.id), "Robot/Core.Sensor");
    assert_eq!(errors(&p), Vec::<String>::new());
}

#[test]
fn places_modules_with_their_attributes_and_methods_typed_with_the_types_here() {
    let robot = read("robot.scaffold.yaml");
    let (p, _, _) = monitor();
    let names = type_names(&p);
    let ty = |t: &TypeRef| print_type_ref(t, |id| names.get(id).cloned());
    let attrs: Vec<_> = sensor_of(&p)
        .attributes
        .as_ref()
        .unwrap()
        .iter()
        .map(|a| (a.field.name.clone(), ty(&a.field.ty)))
        .collect();
    let expected = [
        ("rateHz", "float32"),
        ("maxRateHz", "float32"),
        ("filter", "Robot/Core.Sensor.Filter"),
        ("last", "Robot/Core.Sensor.Sample"),
    ];
    assert_eq!(attrs, expected.map(|(a, b)| (a.to_string(), b.to_string())));
    let controller = p.dependencies[0]
        .modules
        .iter()
        .find(|m| m.path == "Core.Controller")
        .unwrap();
    let methods: Vec<_> = controller
        .methods
        .as_ref()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m.name.clone(),
                m.params.iter().map(|prm| ty(&prm.param.ty)).collect::<Vec<_>>(),
            )
        })
        .collect();
    assert_eq!(
        methods,
        vec![
            ("setMode".to_string(), strs(&["Mode"])),
            ("tune".to_string(), strs(&["Robot/Core.Sensor.Filter"])),
            ("reset".to_string(), vec![]),
            ("isRunning".to_string(), vec![]),
            ("instances".to_string(), vec![])
        ]
    );
    // Saved and read back as they are.
    let file = to_file(&p, true);
    let back = from_file(&file, None).unwrap();
    assert_eq!(to_file(&back, true), file);
    assert_eq!(errors(&back), Vec::<String>::new());
    // Refreshed from the same project: unchanged.
    let mut fresh = p.clone();
    let id = fresh.dependencies[0].id.clone();
    refresh_dependencies(
        &mut fresh,
        &HashMap::from([(id, robot)]),
        Some("station.scaffold.yaml"),
    );
    assert_eq!(fresh.dependencies[0].modules, p.dependencies[0].modules);
}

#[test]
fn reuses_the_dependency_and_an_already_placed_module() {
    let robot = read("robot.scaffold.yaml");
    let (p, placed_id, _) = monitor();
    let mut q = p.clone();
    let mut place = |path: &str| {
        place_module(
            &mut q,
            &robot,
            "robot.scaffold.yaml",
            &by_path(&robot, path).id,
            Point { x: 0., y: 0. },
            None,
        )
        .id
    };
    let again = place("Core.Controller");
    let other = place("Operator");
    assert_eq!(again.as_ref(), Some(&placed_id));
    assert_ne!(other.as_ref(), Some(&placed_id));
    let names: Vec<_> = q.dependencies.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, ["Robot", "Common"]);
    let paths: Vec<_> = q.dependencies[0].modules.iter().map(|m| m.path.clone()).collect();
    let mut expected = tree_paths(&robot, "Core");
    expected.extend(tree_paths(&robot, "Operator"));
    assert_eq!(paths, expected);
}

#[test]
fn round_trips_links_to_placed_modules() {
    let robot = read("robot.scaffold.yaml");
    let (p, _, _) = monitor();
    let file = to_file(&p, true);
    let dep = &file["dependencies"][0];
    assert_eq!(dep["name"], "Robot");
    assert_eq!(dep["file"], "robot.scaffold.yaml");
    assert_eq!(dep["uses"], json!(["Common"]));
    let modules: Vec<_> = dep["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["module"].as_str().unwrap())
        .collect();
    assert_eq!(modules, tree_paths(&robot, "Core"));
    let sensor_file = dep["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["module"] == "Core.Sensor")
        .unwrap();
    assert_eq!(sensor_file["ports"][0]["name"], "out");
    assert_eq!(sensor_file["ports"][0]["role"], "out");
    assert_eq!(sensor_file["ports"][0]["interface"], "Telemetry");
    assert_eq!(
        file["links"][0]["from"],
        json!({ "project": "Robot", "module": "Core.Sensor", "port": "out" })
    );
    // Content where it is in its parent.
    let sensor = by_path(&robot, "Core.Sensor").layout;
    let editor = &file["editor"]["dependencies"]["Robot"];
    assert_eq!(
        (f64_of(&editor["Core"]["x"]), f64_of(&editor["Core"]["y"])),
        (500., 40.)
    );
    let s = &editor["Core.Sensor"];
    assert_eq!(
        [
            f64_of(&s["x"]),
            f64_of(&s["y"]),
            f64_of(&s["width"]),
            f64_of(&s["height"])
        ],
        [sensor.x, sensor.y, sensor.width, sensor.height]
    );
    assert_eq!(to_file(&from_file(&file, None).unwrap(), true), file);
    // Exports keep the placed modules (generators need them), not their positions.
    let exported = to_file(&p, false);
    assert_eq!(exported["dependencies"], file["dependencies"]);
    assert!(exported.get("editor").is_none());
}

#[test]
fn round_trips_moved_names_of_placed_ports() {
    let mut p = monitor().0;
    sensor_of_mut(&mut p).ports[0].label = Some(Side::Bottom);
    let file = to_file(&p, true);
    assert_eq!(
        file["editor"]["dependencies"]["Robot"]["Core.Sensor"]["labels"]["out"],
        "bottom"
    );
    assert_eq!(
        sensor_of(&from_file(&file, None).unwrap()).ports[0].label,
        Some(Side::Bottom)
    );
}

#[test]
fn round_trips_the_size_of_resized_placed_modules_kept_at_least_their_minimum() {
    let mut p = monitor().0;
    p.dependencies[0].modules[0].size = Some(Size {
        width: 300.,
        height: 10.,
    });
    let file = to_file(&p, true);
    let core = &file["editor"]["dependencies"]["Robot"]["Core"];
    assert_eq!(
        [
            f64_of(&core["x"]),
            f64_of(&core["y"]),
            f64_of(&core["width"]),
            f64_of(&core["height"])
        ],
        [500., 40., 300., 10.]
    );
    let q = from_file(&file, None).unwrap();
    assert_eq!(
        q.dependencies[0].modules[0].size,
        Some(Size {
            width: 300.,
            height: 10.
        })
    );
    let size = imported_size(&q.dependencies[0].modules[0], q.orientation);
    assert_eq!(size.width, 300.);
    assert!(size.height > 10.);
}

#[test]
fn reports_unknown_dependencies_and_modules_not_placed_on_load() {
    let mut file = to_file(&monitor().0, false);
    file["links"][0]["from"] = json!({ "project": "Nav", "module": "Core.Sensor", "port": "out" });
    let e = from_file(&file, None).unwrap_err();
    assert!(e.to_string().contains("unknown dependency 'Nav'"), "{e}");
    file["links"][0]["from"] = json!({ "project": "Robot", "module": "Operator", "port": "cmd" });
    let e = from_file(&file, None).unwrap_err();
    assert!(
        e.to_string()
            .contains("module 'Operator' is not placed from dependency 'Robot'"),
        "{e}"
    );
}

#[test]
fn flags_interfaces_not_defined_here_and_links_between_two_placed_modules() {
    let (p, placed_id, _) = monitor();
    let q = produce(&p, |d| {
        sensor_of_mut(d).ports[0].interface = Some("Stream".into())
    });
    assert_eq!(
        errors(&q),
        [
            "Link 'sensor_to_monitor': Robot/Core.Sensor:out uses interface 'Stream', not defined in this project"
        ]
    );
    let r = produce(&p, |d| {
        let core = d.dependencies[0]
            .modules
            .iter()
            .find(|m| m.id == placed_id)
            .unwrap();
        let port_id = core.ports[0].id.clone();
        d.links[0].to = Endpoint {
            module_id: placed_id.clone(),
            port_id,
        };
    });
    assert!(errors(&r).contains(
        &"Link 'sensor_to_monitor' joins two imported modules: one end must be in this project".to_string()
    ));
}

#[test]
fn refreshes_ports_by_name_dropping_links_to_removed_ports() {
    let robot = read("robot.scaffold.yaml");
    let (p, _, _) = monitor();
    let robot_id = p.dependencies[0].id.clone();
    let port_id = sensor_of(&p).ports[0].id.clone();
    let refresh = |source: &Project| -> (Project, DependencyResult) {
        let mut q = p.clone();
        let r = refresh_dependencies(&mut q, &HashMap::from([(robot_id.clone(), source.clone())]), None);
        (q, r)
    };
    let mut added = robot.clone();
    by_path_mut(&mut added, "Core.Sensor").ports.push(Port {
        id: "x".into(),
        name: "status".into(),
        role: PortRole::Out,
        interface_id: None,
        description: String::new(),
        label: None,
    });
    let (q, r) = refresh(&added);
    assert_eq!(r, DependencyResult::default());
    let names: Vec<_> = sensor_of(&q).ports.iter().map(|pt| pt.name.as_str()).collect();
    assert_eq!(names, ["out", "status"]);
    assert_eq!(sensor_of(&q).ports[0].id, port_id);
    assert_eq!(q.links.len(), 1);

    let mut gone = robot.clone();
    by_path_mut(&mut gone, "Core.Sensor").ports[0].name = "data".into();
    assert!(refresh(&gone).0.links.is_empty());

    // Content gone from its parent goes, with its links.
    let mut deleted = robot.clone();
    deleted.modules.retain(|m| m.name != "Sensor");
    let (q, r) = refresh(&deleted);
    assert_eq!(
        r.missing,
        ["Robot: module 'Core.Sensor' no longer exists in robot.scaffold.yaml"]
    );
    let paths: Vec<_> = q.dependencies[0].modules.iter().map(|m| m.path.clone()).collect();
    assert_eq!(paths, tree_paths(&deleted, "Core"));
    assert!(q.links.is_empty());

    // Content added comes in.
    let mut more = robot.clone();
    let mut lidar = by_path(&robot, "Core.Sensor").clone();
    lidar.id = "lidar".into();
    lidar.name = "Lidar".into();
    lidar.ports = vec![];
    more.modules.push(lidar);
    let paths: Vec<_> = refresh(&more).0.dependencies[0]
        .modules
        .iter()
        .map(|m| m.path.clone())
        .collect();
    assert_eq!(paths, tree_paths(&more, "Core"));
}

#[test]
fn keeps_content_moved_in_its_placed_parent_which_grows_to_hold_it() {
    let robot = read("robot.scaffold.yaml");
    let (p, placed_id, _) = monitor();
    let robot_id = p.dependencies[0].id.clone();
    let q = produce(&p, |d| {
        sensor_of_mut(d).position = Point { x: 2000., y: -5. };
        let id = sensor_of(d).id.clone();
        grow_imported_ancestors(d, &id);
    });
    let sensor = sensor_of(&q);
    assert_eq!(
        sensor.position,
        Point {
            x: 2000.,
            y: content_top(q.orientation, Compartments::default())
        }
    );
    let core = q.dependencies[0]
        .modules
        .iter()
        .find(|m| m.id == placed_id)
        .unwrap();
    assert_eq!(
        core.size.unwrap().width,
        2000. + imported_size(sensor, q.orientation).width + LAYOUT_PAD
    );
    let mut r = q.clone();
    refresh_dependencies(&mut r, &HashMap::from([(robot_id, robot)]), None);
    assert_eq!(sensor_of(&r).position, sensor.position);
}

#[test]
fn detects_modules_renamed_or_moved_while_this_project_was_closed() {
    let robot = read("robot.scaffold.yaml");
    let (p, _, _) = monitor();
    let robot_id = p.dependencies[0].id.clone();
    let mut renamed = robot.clone();
    by_path_mut(&mut renamed, "Core.Sensor").name = "Lidar".into();
    let mut q = p.clone();
    let r = refresh_dependencies(&mut q, &HashMap::from([(robot_id.clone(), renamed)]), None);
    assert_eq!(r.renamed, ["module Core.Sensor → Core.Lidar"]);
    assert!(q.dependencies[0].modules.iter().any(|m| m.path == "Core.Lidar"));
    assert_eq!(q.links.len(), 1);

    // Moved out of its parent: placed on its own, where it was drawn, its links kept.
    let mut moved = robot.clone();
    by_path_mut(&mut moved, "Core.Sensor").parent_id = None;
    let before = absolute_rect(&p, &sensor_of(&p).id);
    let mut s = p.clone();
    let r = refresh_dependencies(&mut s, &HashMap::from([(robot_id, moved)]), None);
    assert_eq!(r.renamed, ["module Core.Sensor → Sensor"]);
    let sensor = s.dependencies[0]
        .modules
        .iter()
        .find(|m| m.path == "Sensor")
        .unwrap();
    assert_eq!(
        sensor.position,
        Point {
            x: before.x,
            y: before.y
        }
    );
    assert_eq!(s.links[0].from.module_id, sensor.id);
}

#[test]
fn follows_an_interface_renamed_in_the_project_it_comes_from() {
    let (p, _, _) = monitor();
    let common_file = read("common.scaffold.yaml");
    let renamed = produce(&common_file, |d| {
        d.interfaces
            .iter_mut()
            .find(|i| i.name == "Telemetry")
            .unwrap()
            .name = "Stream".into()
    });
    let q = produce(&p, |d| {
        apply_dependency_renames(
            d,
            "common.scaffold.yaml",
            &diff_renames(&common_file, &renamed).unwrap(),
        )
    });
    assert!(q.interfaces.iter().any(|i| i.name == "Stream"));
    assert_eq!(sensor_of(&q).ports[0].interface.as_deref(), Some("Stream"));
    assert_eq!(errors(&q), Vec::<String>::new());
}

#[test]
fn removes_placed_modules_with_their_links_keeping_the_dependency() {
    let (p, placed_id, _) = monitor();
    let mut d = p.clone();
    let id = d.dependencies[0].id.clone();
    assert_eq!(
        remove_dependency(&mut d, &id, false),
        ["module Core, placed on the canvas"]
    );
    // Content goes with its top-level module only.
    let q = produce(&p, |d| {
        let id = sensor_of(d).id.clone();
        remove_placed(d, &HashSet::from([id]));
    });
    assert_eq!(q, p);
    let q = produce(&p, |d| remove_placed(d, &HashSet::from([placed_id.clone()])));
    let deps: Vec<_> = q
        .dependencies
        .iter()
        .map(|x| (x.name.as_str(), x.modules.len()))
        .collect();
    assert_eq!(deps, vec![("Robot", 0), ("Common", 0)]);
    assert!(q.links.is_empty());
    assert_eq!(q.modules.len(), 1);
}

// Dependency examples.

#[test]
fn robot_depends_on_common_up_to_date() {
    let robot = read("robot.scaffold.yaml");
    assert_eq!(errors(&robot), Vec::<String>::new());
    let mut fresh = robot.clone();
    let id = fresh.dependencies[0].id.clone();
    let r = refresh_dependencies(
        &mut fresh,
        &HashMap::from([(id, read("common.scaffold.yaml"))]),
        None,
    );
    assert_eq!(r, DependencyResult::default());
    assert_eq!(fresh, robot);
}

#[test]
fn station_depends_on_common_and_robot_links_to_a_placed_module_up_to_date() {
    let station = read("station.scaffold.yaml");
    assert_eq!(errors(&station), Vec::<String>::new());
    let sources = HashMap::from([
        (station.dependencies[0].id.clone(), read("common.scaffold.yaml")),
        (station.dependencies[1].id.clone(), read("robot.scaffold.yaml")),
    ]);
    let mut fresh = station.clone();
    let r = refresh_dependencies(&mut fresh, &sources, Some("station.scaffold.yaml"));
    assert_eq!(r, DependencyResult::default());
    assert_eq!(to_file(&fresh, false), to_file(&station, false));
}
