# Desktop builds (see Dockerfile). `docker buildx bake` builds tauri and electron in parallel,
# sharing one web build. Single target: `docker buildx bake tauri`.
group "default" {
  targets = ["tauri", "electron"]
}

target "_desktop" {
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64"]
}

target "tauri" {
  inherits = ["_desktop"]
  target   = "tauri"
  output   = ["type=local,dest=dist-tauri"]
}

target "electron" {
  inherits = ["_desktop"]
  target   = "electron"
  output   = ["type=local,dest=dist-electron"]
}
