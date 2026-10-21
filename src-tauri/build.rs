fn main() -> Result<(), Box<dyn std::error::Error>> {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(
                // El manifiesto se enlaza debajo también con los tests, sin duplicarlo en el binario.
                tauri_build::WindowsAttributes::new_without_app_manifest(),
            )
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "get_audio_engine_status",
                "list_output_devices",
                "get_selected_output_device",
                "set_output_device",
                "play_effect",
                "stop_playback",
                "stop_effect",
                "stop_all",
                "set_master_volume",
                "set_playback_volume",
                "set_effect_volume",
                "set_max_concurrent_playbacks",
                "get_active_playbacks",
                "get_library_snapshot",
                "save_board",
                "import_audio_files",
                "set_library_columns",
                "play_effect_with_options",
                "restart_effect",
                "set_playback_loop",
                "fade_out_playback",
                "prepare_bank_import",
                "commit_bank_import",
                "cancel_bank_import",
                "export_sound_banks",
            ])),
    )?;
    println!("cargo:rerun-if-changed=windows-manifest.rc");
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile_for_everything("windows-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .map_err(|error| {
                std::io::Error::other(format!(
                    "No se pudo incrustar el manifiesto Windows: {error:?}"
                ))
            })?;
    }
    Ok(())
}
