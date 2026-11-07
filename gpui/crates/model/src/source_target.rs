//! The entity of the project that a place in its file text describes, for following the caret.
//! Port of `sourceTarget.ts`.

use serde_json::Value;

use crate::project::{PathKey, note_at_path, project_module_paths};
use crate::serialize::to_file;
use crate::types::{Id, Project};
use crate::validate::ProblemTarget;

/// An entity to navigate to, or a note.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SourceTarget {
    Entity(ProblemTarget),
    Note(Id),
}

/// Name of the item at `i` of a file list.
fn name_in(list: Option<&Value>, i: usize) -> Option<String> {
    list?.get(i)?.get("name")?.as_str().map(str::to_string)
}

/// Item of a file list with a name.
fn find_named<'a>(list: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    list?
        .as_array()?
        .iter()
        .find(|e| e.get("name").and_then(Value::as_str) == Some(name))
}

/// Entity at a data path of the file. List items are found by the names written in the text
/// (`names`, see `structure_at`), else by their position in the project.
pub fn target_at(p: &Project, path: &[PathKey], names: &[Option<String>]) -> Option<SourceTarget> {
    let file = to_file(p, false);
    let index = |k: usize| match path.get(k) {
        Some(PathKey::Index(i)) => Some(*i),
        _ => None,
    };
    let key = |k: usize| match path.get(k) {
        Some(PathKey::Key(s)) => Some(s.as_str()),
        _ => None,
    };
    // Name of the list item at `path[k]`: as written, else the project's at that position.
    let item_name = |k: usize, list: Option<&Value>| -> Option<String> {
        let i = index(k)?;
        names.get(k).cloned().flatten().or_else(|| name_in(list, i))
    };
    let entity = |t: ProblemTarget| Some(SourceTarget::Entity(t));
    let paths = project_module_paths(p);
    // Placed modules of dependencies too ('Dependency/Module').
    let module_at = |module_path: Option<&str>| -> Option<Id> {
        let wanted = module_path?;
        paths
            .iter()
            .find(|(_, path)| path.as_str() == wanted)
            .map(|(id, _)| id.clone())
    };
    let module_target =
        |module_path: Option<&str>| module_at(module_path).and_then(|id| entity(ProblemTarget::Module(id)));
    let link_target = |name: Option<&str>| {
        let l = p.links.iter().find(|l| Some(l.name.as_str()) == name)?;
        entity(ProblemTarget::Link(l.id.clone()))
    };

    match key(0)? {
        "project" | "schemaVersion" => entity(ProblemTarget::Project),
        "types" => {
            let name = item_name(1, file.get("types"))?;
            let t = p.types.iter().find(|t| t.name == name)?;
            entity(ProblemTarget::Type(t.id.clone()))
        }
        "interfaces" => {
            let name = item_name(1, file.get("interfaces"))?;
            let i = p.interfaces.iter().find(|i| i.name == name)?;
            entity(ProblemTarget::Interface(i.id.clone()))
        }
        "links" => link_target(item_name(1, file.get("links")).as_deref()),
        "modules" => {
            // Nested modules: modules.i.modules.j...
            let mut parts: Vec<String> = Vec::new();
            let mut list = file.get("modules");
            let mut k = 0;
            while key(k) == Some("modules") && index(k + 1).is_some() {
                let Some(name) = item_name(k + 1, list) else {
                    break;
                };
                let by_position = index(k + 1).and_then(|i| list?.get(i));
                let item = find_named(list, &name).or(by_position);
                parts.push(name);
                list = item.and_then(|m| m.get("modules"));
                k += 2;
            }
            let joined = parts.join(".");
            module_target((!parts.is_empty()).then_some(joined.as_str()))
        }
        "dependencies" => {
            let name = item_name(1, file.get("dependencies"))?;
            let dep = p.dependencies.iter().find(|d| d.name == name)?;
            let file_dep = find_named(file.get("dependencies"), &dep.name);
            // The dependency itself, or one of its fields.
            let (Some(file_dep), Some(j)) = (file_dep, index(3)) else {
                return entity(ProblemTarget::Dependency(dep.id.clone()));
            };
            match key(2) {
                Some("types") => {
                    let name = item_name(3, file_dep.get("types"))?;
                    let t = p.types.iter().find(|t| t.name == name)?;
                    entity(ProblemTarget::Type(t.id.clone()))
                }
                Some("interfaces") => {
                    let name = item_name(3, file_dep.get("interfaces"))?;
                    let i = p.interfaces.iter().find(|i| i.name == name)?;
                    entity(ProblemTarget::Interface(i.id.clone()))
                }
                Some("modules") => {
                    let module_path = names.get(3).cloned().flatten().or_else(|| {
                        file_dep
                            .get("modules")?
                            .get(j)?
                            .get("module")?
                            .as_str()
                            .map(str::to_string)
                    })?;
                    let m = dep.modules.iter().find(|m| m.path == module_path)?;
                    entity(ProblemTarget::Module(m.id.clone()))
                }
                _ => None,
            }
        }
        "editor" => {
            // Editor data keyed by module path or link name, notes, and the same in the views.
            if let Some(note) = note_at_path(p, path) {
                return Some(SourceTarget::Note(note.id.clone()));
            }
            match key(1) {
                Some("layout" | "style") => return module_target(key(2)),
                Some("links") => return link_target(key(2)),
                // Placed modules of dependencies: dependencies.<Dependency>.<Module>.
                Some("dependencies") => {
                    let dep = p.dependencies.iter().find(|d| Some(d.name.as_str()) == key(2))?;
                    return match key(3) {
                        None => entity(ProblemTarget::Dependency(dep.id.clone())),
                        Some(m) => module_target(Some(&format!("{}/{m}", dep.name))),
                    };
                }
                Some("views") => {}
                _ => return None,
            }
            let view = p.views.get(index(2)?)?;
            match key(3) {
                Some("layout" | "labels" | "outside") => module_target(key(4)),
                Some("links") => link_target(key(4)),
                Some("hidden") => {
                    let id = view.hidden.get(index(4)?)?;
                    entity(ProblemTarget::Module(id.clone()))
                }
                // The view itself: its root.
                _ => view
                    .root_module_id
                    .as_ref()
                    .and_then(|id| entity(ProblemTarget::Module(id.clone()))),
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::completion::structure_at;
    use crate::serialize::{Format, load_text, save_text};
    use crate::types::{LinkRoute, Point, StandIn, View};
    use indexmap::IndexMap;

    fn example(name: &str) -> Project {
        let path = format!("{}/../../../examples/{name}", env!("CARGO_MANIFEST_DIR"));
        load_text(&std::fs::read_to_string(path).unwrap(), Format::Yaml).unwrap()
    }

    fn target(p: &Project, text: &str, pos: usize) -> Option<SourceTarget> {
        let (path, names) = structure_at(text, pos);
        target_at(p, &path, &names)
    }

    /// Entity name at the first occurrence of `marker` in the text, from `from`.
    fn at(p: &Project, text: &str, marker: &str, from: usize) -> String {
        let pos = from + text[from..].find(marker).unwrap() + marker.len();
        let Some(t) = target(p, text, pos) else {
            return "none".into();
        };
        let SourceTarget::Entity(t) = t else {
            return "note".into();
        };
        let Some(id) = t.id() else {
            return "project".into();
        };
        let kind = match t {
            ProblemTarget::Type(_) => "type",
            ProblemTarget::Interface(_) => "interface",
            ProblemTarget::Const(_) => "const",
            ProblemTarget::Module(_) => "module",
            ProblemTarget::Link(_) => "link",
            ProblemTarget::Dependency(_) => "dependency",
            ProblemTarget::Project => unreachable!(),
        };
        let paths = project_module_paths(p);
        let name = p
            .modules
            .iter()
            .map(|e| (&e.id, &e.name))
            .chain(p.links.iter().map(|e| (&e.id, &e.name)))
            .chain(p.types.iter().map(|e| (&e.id, &e.name)))
            .chain(p.interfaces.iter().map(|e| (&e.id, &e.name)))
            .chain(p.dependencies.iter().map(|e| (&e.id, &e.name)))
            .find(|(i, _)| i.as_str() == id)
            .map(|(_, n)| n.clone())
            .or_else(|| {
                let placed = p.dependencies.iter().flat_map(|d| &d.modules);
                placed.clone().find(|m| m.id == id).map(|m| m.path.clone())
            })
            .or_else(|| paths.get(id).cloned())
            .unwrap_or_else(|| id.to_string());
        format!("{kind}:{name}")
    }

    #[test]
    fn finds_the_entity_of_a_line() {
        let p = example("robot.scaffold.yaml");
        let text = save_text(&p, Format::Yaml, true);
        let t = |m: &str, from: usize| at(&p, &text, m, from);
        assert_eq!(t("name: Robot", 0), "project");
        assert_eq!(t("name: Pose", 0), "type:Pose");
        assert_eq!(t("name: float64", 0), "type:Pose");
        assert_eq!(t("name: Telemetry", 0), "interface:Telemetry");
        assert_eq!(t("- name: Sensor", 0), "module:Sensor");
        assert_eq!(
            t("role: out", text.find("- name: Sensor").unwrap()),
            "module:Sensor"
        );
        assert_eq!(t("name: sensor_to_controller", 0), "link:sensor_to_controller");
        assert_eq!(t("class: realtime", 0), "link:sensor_to_controller");
        assert_eq!(t("- name: Common", 0), "dependency:Common");
        assert_eq!(t("file: common.scaffold.yaml", 0), "dependency:Common");
        assert_eq!(t("name: Vec3", 0), "type:Vec3");
    }

    #[test]
    fn finds_modules_from_their_editor_data() {
        let p = example("robot.scaffold.yaml");
        let text = save_text(&p, Format::Yaml, true);
        assert_eq!(at(&p, &text, "  Core.Logger:", 0), "module:Logger");
    }

    #[test]
    fn finds_placed_modules_of_dependencies_from_their_editor_data() {
        let p = example("station.scaffold.yaml");
        let text = save_text(&p, Format::Yaml, true);
        let from = text.find("\neditor:").unwrap();
        let t = |m: &str| at(&p, &text, m, from);
        assert_eq!(t("    Core.Sensor:"), "module:Core.Sensor");
        assert_eq!(t("      Core:\n        x: 660"), "module:Core");
        assert_eq!(t("  dependencies:\n    Robot:"), "dependency:Robot");
    }

    #[test]
    fn finds_links_and_modules_from_the_editor_data_of_the_views() {
        let mut p = example("robot.scaffold.yaml");
        let core = p.modules.iter().find(|m| m.name == "Core").unwrap().id.clone();
        let operator = p
            .modules
            .iter()
            .find(|m| m.name == "Operator")
            .unwrap()
            .id
            .clone();
        let route = |x, y| LinkRoute {
            points: vec![Point { x, y }],
            ..serde_json::from_value(serde_json::json!({ "points": [] })).unwrap()
        };
        p.links[0].route = Some(route(1.0, 2.0));
        let stand_in: StandIn = serde_json::from_value(serde_json::json!({ "x": -300, "y": 0 })).unwrap();
        p.views.push(View {
            id: "core-view".into(),
            name: "Core view".into(),
            root_module_id: Some(core),
            hidden: vec![],
            layouts: None,
            routes: Some(IndexMap::from([(p.links[2].id.clone(), route(3.0, 4.0))])),
            port_labels: None,
            stand_ins: Some(IndexMap::from([(operator, stand_in)])),
            temporary: false,
        });
        let text = save_text(&p, Format::Yaml, true);
        let (l0, l2) = (p.links[0].name.clone(), p.links[2].name.clone());
        let views = text.find("  views:").unwrap();
        assert_eq!(
            at(&p, &text, &format!("  links:\n    {l0}:"), 0),
            format!("link:{l0}")
        );
        assert_eq!(at(&p, &text, &format!("{l2}:"), views), format!("link:{l2}"));
        let outside = views + text[views..].find("outside:").unwrap();
        assert_eq!(at(&p, &text, "Operator:", outside), "module:Operator");
        assert_eq!(at(&p, &text, "- name: Core view", 0), "module:Core");
    }
}
