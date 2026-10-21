mod application;
mod commands;
mod domain;
mod infrastructure;

#[cfg(test)]
pub(crate) mod test_support;

use application::worker::AudioService;
use tauri::{Emitter, Manager};

/// Comparte el contexto entre producción y pruebas para incrustar Info.plist una sola vez en macOS.
pub(crate) fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// Inicia el shell y el worker sin abrir dispositivos de audio.
/// Devuelve el error de Tauri si falla el arranque o el ciclo de la aplicación.
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let service = AudioService::start(
                infrastructure::audio::NativeDriver::new,
                Box::new(move |event, status| {
                    // La consulta explicita permite reconciliar incluso si la ventana pierde un evento.
                    let _ = handle.emit_to("main", event, status);
                }),
            )
            .map_err(|error| std::io::Error::other(error.message))?;
            app.manage(service);
            app.manage(application::library::LibraryService::new(
                app.path().app_data_dir()?,
            ));
            let loading = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Los errores quedan disponibles por los comandos de biblioteca; nunca se resetean datos.
                let _ = loading
                    .state::<application::library::LibraryService>()
                    .initialize(&loading.state::<AudioService>())
                    .await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_audio_engine_status,
            commands::list_output_devices,
            commands::get_selected_output_device,
            commands::set_output_device,
            commands::play_effect,
            commands::stop_playback,
            commands::stop_effect,
            commands::stop_all,
            commands::set_master_volume,
            commands::set_playback_volume,
            commands::set_effect_volume,
            commands::set_max_concurrent_playbacks,
            commands::get_active_playbacks,
            commands::get_library_snapshot,
            commands::save_board,
            commands::import_audio_files,
            commands::set_library_columns,
            commands::play_effect_with_options,
            commands::restart_effect,
            commands::set_playback_loop,
            commands::fade_out_playback,
            commands::prepare_bank_import,
            commands::commit_bank_import,
            commands::cancel_bank_import,
            commands::export_sound_banks,
        ])
        .build(app_context())?
        .run(|app, event| {
            // Rompe explicitamente el ciclo AppHandle -> estado -> worker -> AppHandle.
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(service) = app.try_state::<AudioService>()
            {
                service.shutdown();
            }
        });
    Ok(())
}
