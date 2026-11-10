# Examples

Every project here is [Scaffold text](../docs/scaffold-text.md) (`*.scaffold`); switch the text editor to _YAML_, or use _File › Export as YAML…_, to see one in YAML. Open a project file with _File › Open…_, a workspace file to open all its projects at once. Every file here is checked by `tests/examples.test.ts`: valid, without errors, saved as the editor saves it, its dependencies up to date.

## Single projects

| File                                         | Shows                                                                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`hello.scaffold`](hello.scaffold)           | The smallest useful project: two modules, one interface, one link. Start here.                                                                                                                                                    |
| [`robot.scaffold`](robot.scaffold)           | Nested modules, attributes and methods with access levels, types of modules; depends on `common.scaffold`.                                                                                                                        |
| [`rover.scaffold`](rover.scaffold)           | Binaries (rover, ground station) linked over TCP, bitmask, union, exception, constants, vertical layout.                                                                                                                          |
| [`ledger.scaffold`](ledger.scaffold)         | Every kind of type (custom primitive, alias, enum, bitmask, struct, union with a default case, exception) and of type reference, bounds, default values of each, constants; `out` / `inout` parameters, `raises`.                 |
| [`audio.scaffold`](audio.scaffold)           | Class hierarchy: `interface` and `abstract` modules, multiple inheritance, `virtual` / `pure` / `override` methods, static members.                                                                                               |
| [`game.scaffold`](game.scaffold)             | Modules three deep, ports forwarded through containers, types of modules (public, protected, private) used by path, constants as static const attributes, bases between nested modules, a module used as a type (`Player.world`). |
| [`vehicle.scaffold`](vehicle.scaffold)       | ECUs as binaries on CAN buses (frame ids, options), realtime constraints, container ports.                                                                                                                                        |
| [`home.scaffold`](home.scaffold)             | One link per transport: `ipc`, `shm`, `tcp`, `udp`, `http`, `grpc`, `websocket`, `mqtt`, `can`, `serial`, plus a custom one (`zigbee`); `remoteDefaults`.                                                                         |
| [`radio.scaffold`](radio.scaffold)           | Software-defined radio components (uses / provides ports, properties).                                                                                                                                                            |
| [`shop.scaffold`](shop.scaffold)             | Editor data: notes and frames, a view of a module with a hidden module, placed outside modules and notes of its own, a view hiding a module, hand-set link shapes, a locked module, port label sides.                             |
| [`thermostat.scaffold`](thermostat.scaffold) | Room thermostat on a small microcontroller, generated in C++98: fixed-size arrays, no dynamic types.                                                                                                                              |

## Projects depending on each other

| Files                                                                                 | Shows                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`common`](common.scaffold), [`robot`](robot.scaffold), [`station`](station.scaffold) | Types and interfaces only (`common`), used by `robot`; `station` uses both, links to a placed module of `robot` and uses one of its module types.                                                |
| [`fleet/`](fleet) ([workspace](fleet/fleet.scaffold-workspace.yaml))                  | Drones and their ground station across five projects: shared units, placed modules of two dependencies, module views, custom transport (`mavlink`).                                              |
| [`plugins/`](plugins) ([workspace](plugins/plugins.scaffold-workspace.yaml))          | An SDK with an abstract `Plugin` module; `filters` derives modules from it (`bases: [Sdk/Plugin]`) and links them to the SDK's `Host`; `app` places the filters and derives a plugin of its own. |

## IDL files

| File                                                     | Shows                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`idl/robot_control.idl`](idl/robot_control.idl)         | CORBA-style interfaces, attributes, inheritance, exceptions.                                                                                        |
| [`idl/sensors_dds.idl`](idl/sensors_dds.idl)             | DDS types only: annotations, bitmask, union, bounded sequences, maps.                                                                               |
| [`idl/tank_ccm.idl`](idl/tank_ccm.idl)                   | CCM components, porttypes and events; includes `sensors_dds.idl`.                                                                                   |
| [`idl/navigation.idl`](idl/navigation.idl)               | Uses `Pose` and `Vec3` without defining them: import it into `robot.scaffold` to see them matched by name.                                          |
| [`idl/imaging.idl`](idl/imaging.idl)                     | `import`, template modules, constant expressions, value types (concrete, abstract, boxed), bitsets, natives, connectors.                            |
| [`idl/filling_cell.scaffold`](idl/filling_cell.scaffold) | Depends on `tank_ccm.idl` and `robot_control.idl`: places the `Plant` components, uses the IDL interfaces and types.                                |
| [`idl/inspection.scaffold`](idl/inspection.scaffold)     | Depends on `imaging.idl`: places its `Imaging` module, links to the `Grabber` and `Viewer` components, uses `Imaging.Roi` as `imaging/Imaging.Roi`. |

Generating code from them: [ProjectScaffold-Generator](https://github.com/MickaelBlet/ProjectScaffold-Generator) (bases from dependencies, as in `plugins/`, are not generated yet).
