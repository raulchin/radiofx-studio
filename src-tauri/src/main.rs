// Evita una consola adicional en Windows en compilaciones de distribución.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> tauri::Result<()> {
    radiofx_studio_lib::run()
}
