//! Pure model of a ProjectScaffold project: in-memory types, file format,
//! serialization and validation. Port of `src/renderer/src/model/`.

pub mod align;
pub mod binaries;
pub mod clipboard;
pub mod constraints;
pub mod contracts;
pub mod defaults;
pub mod edit;
pub mod emit;
pub mod fuzzy;
pub mod grid;
pub mod locate;
pub mod project;
pub mod reuse;
pub mod schema;
pub mod search;
pub mod serialize;
pub mod sync;
pub mod transports;
pub mod typeexpr;
pub mod types;
pub mod validate;
pub mod workspace;
pub mod yamlread;

pub use schema::SCHEMA_VERSION;
