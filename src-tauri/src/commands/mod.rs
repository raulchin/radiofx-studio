use crate::domain::library::*;
use crate::infrastructure::library::Setting;
use crate::{
    application::library::LibraryService,
    application::worker::{AudioService, Operation, Reply},
    domain::audio::*,
};
use tauri_plugin_dialog::DialogExt;

macro_rules! audio_command {
    ($name:ident, ($($arg:ident: $ty:ty),*), $result:ty, $operation:expr, $variant:ident) => {
        #[doc = "Valida y delega la operacion de audio al worker propietario sin bloquear la UI."]
        #[tauri::command(rename_all = "camelCase")]
        pub async fn $name(service: tauri::State<'_, AudioService>, library: tauri::State<'_, LibraryService>, $($arg: $ty),*) -> Result<$result, AudioError> {
            library.initialize(&service).await?;
            match service.request($operation).await? {
                Reply::$variant(value) => Ok(value),
                _ => Err(AudioError::new("internal_reply", "Respuesta interna inesperada del motor.")),
            }
        }
    };
}

macro_rules! audio_action {
    ($name:ident, ($($arg:ident: $ty:ty),*), $operation:expr) => {
        #[doc = "Valida y aplica una accion serializada de audio sin bloquear el hilo principal."]
        #[tauri::command(rename_all = "camelCase")]
        pub async fn $name(service: tauri::State<'_, AudioService>, $($arg: $ty),*) -> Result<(), AudioError> {
            match service.request($operation).await? {
                Reply::Unit => Ok(()),
                _ => Err(AudioError::new("internal_reply", "Respuesta interna inesperada del motor.")),
            }
        }
    };
}

audio_command!(
    get_audio_engine_status,
    (),
    AudioEngineStatus,
    Operation::Status,
    Status
);
audio_command!(
    list_output_devices,
    (),
    Vec<OutputDevice>,
    Operation::Devices,
    Devices
);
audio_command!(
    get_selected_output_device,
    (),
    Option<OutputDevice>,
    Operation::Selected,
    Selected
);
/// Rechaza durante la carga en vez de dejar un disparo pendiente que pueda escapar a STOP ALL.
#[tauri::command(rename_all = "camelCase")]
pub async fn play_effect(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    effect_id: String,
) -> Result<String, AudioError> {
    if !library.is_ready() {
        return Err(AudioError::new(
            "library_loading",
            "La biblioteca aun no esta disponible. Consulte su estado y vuelva a pulsar cuando termine la carga.",
        ));
    }
    match service.request(Operation::Play(effect_id)).await? {
        Reply::PlaybackId(id) => Ok(id),
        _ => Err(AudioError::new(
            "internal_reply",
            "Respuesta interna inesperada del motor.",
        )),
    }
}
audio_command!(
    get_active_playbacks,
    (),
    Vec<Playback>,
    Operation::Playbacks,
    Playbacks
);
audio_action!(stop_playback, (playback_id: String), Operation::Stop(playback_id));
audio_action!(stop_effect, (effect_id: String), Operation::StopEffect(effect_id));
audio_action!(stop_all, (), Operation::StopAll);
audio_action!(set_playback_volume, (playback_id: String, value: f32), Operation::PlaybackVolume(playback_id, value));
audio_action!(set_playback_loop, (playback_id: String, looped: bool), Operation::Loop(playback_id, looped));
audio_action!(fade_out_playback, (playback_id: String, duration_ms: u32), Operation::FadeOut(playback_id, duration_ms));

/// Rechaza cargas pendientes igual que el disparo simple; no espera I/O antes de admitir la voz.
#[tauri::command(rename_all = "camelCase")]
pub async fn play_effect_with_options(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    effect_id: String,
    options: PlaybackOptions,
) -> Result<String, AudioError> {
    if !library.is_ready() {
        return Err(AudioError::new(
            "library_loading",
            "La biblioteca aun no esta disponible.",
        ));
    }
    match service
        .request(Operation::PlayWithOptions(effect_id, options))
        .await?
    {
        Reply::PlaybackId(id) => Ok(id),
        _ => Err(AudioError::new(
            "internal_reply",
            "Respuesta interna inesperada.",
        )),
    }
}

/// Reinicia atomicamente el recurso sin esperar cargas que puedan escapar a STOP ALL.
#[tauri::command(rename_all = "camelCase")]
pub async fn restart_effect(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    effect_id: String,
    options: PlaybackOptions,
) -> Result<String, AudioError> {
    if !library.is_ready() {
        return Err(AudioError::new(
            "library_loading",
            "La biblioteca aun no esta disponible.",
        ));
    }
    match service
        .request(Operation::Restart(effect_id, options))
        .await?
    {
        Reply::PlaybackId(id) => Ok(id),
        _ => Err(AudioError::new(
            "internal_reply",
            "Respuesta interna inesperada.",
        )),
    }
}

/// Explicita que el audio ya cambió cuando falla la escritura durable; no simula un rollback.
fn partial(error: AudioError) -> AudioError {
    AudioError::new(
        "persistence_partial_failure",
        format!(
            "El audio ya se aplico, pero no pudo guardarse la preferencia: {} Consulte el estado real del motor.",
            error.message
        ),
    )
}

/// Serializa los cambios durables fuera del actor de audio para evitar escrituras fuera de orden.
async fn durable(
    audio: &AudioService,
    library: &LibraryService,
    operation: Operation,
) -> Result<(), AudioError> {
    let _guard = library.updates.lock().await;
    library.initialize(audio).await?;
    let persisted = match &operation {
        Operation::Master(value) => (Some(*value), None, None),
        Operation::Limit(value) => (None, Some(*value), None),
        Operation::EffectVolume(id, value) => (None, None, Some((id.clone(), *value))),
        _ => {
            return Err(AudioError::new(
                "internal_operation",
                "Operacion durable invalida.",
            ));
        }
    };
    audio.request(operation).await?;
    library
        .access(audio, move |store| {
            if let Some((id, value)) = persisted.2 {
                return store.effect_volume(&id, value);
            }
            if let Some(value) = persisted.0 {
                return store.patch_settings(Setting::Master(value));
            }
            if let Some(value) = persisted.1 {
                return store.patch_settings(Setting::Limit(value));
            }
            Err(AudioError::new(
                "internal_operation",
                "Preferencia ausente.",
            ))
        })
        .await
        .map_err(partial)
}

/// Aplica y guarda el maestro solo después de la aceptación del motor.
#[tauri::command]
pub async fn set_master_volume(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    value: f32,
) -> Result<(), AudioError> {
    durable(&service, &library, Operation::Master(value)).await
}
/// Aplica y guarda el límite sin modificar la revisión del tablero.
#[tauri::command]
pub async fn set_max_concurrent_playbacks(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    value: u16,
) -> Result<(), AudioError> {
    durable(&service, &library, Operation::Limit(value)).await
}
/// Persiste el volumen predeterminado, no la ganancia de instancias ya activas.
#[tauri::command(rename_all = "camelCase")]
pub async fn set_effect_volume(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    effect_id: String,
    value: f32,
) -> Result<(), AudioError> {
    durable(
        &service,
        &library,
        Operation::EffectVolume(effect_id, value),
    )
    .await
}
/// Guarda únicamente el nombre de una salida realmente abierta o restaurada; nunca el UUID de sesión.
#[tauri::command(rename_all = "camelCase")]
pub async fn set_output_device(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    device_id: String,
) -> Result<DeviceSelectionResult, AudioError> {
    let _guard = library.updates.lock().await;
    library.initialize(&service).await?;
    let Reply::Selection(result) = service.request(Operation::Select(device_id)).await? else {
        return Err(AudioError::new(
            "internal_reply",
            "Respuesta interna inesperada.",
        ));
    };
    if result.status.state == EngineState::Ready {
        let name = result
            .status
            .selected_device
            .as_ref()
            .map(|device| device.name.clone());
        library
            .access(&service, move |store| {
                store.patch_settings(Setting::PreferredDevice(name))
            })
            .await
            .map_err(partial)?;
    }
    Ok(result)
}

/// Consulta datos locales sin revelar rutas; también reconcilia registros tras una cola temporalmente ocupada.
#[tauri::command]
pub async fn get_library_snapshot(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
) -> Result<LibrarySnapshot, AudioError> {
    library.synchronize(&service).await?;
    library
        .access(&service, |store| Ok(store.snapshot.clone()))
        .await
}

/// Guarda el tablero con control optimista exclusivo de su revisión.
#[tauri::command(rename_all = "camelCase")]
pub async fn save_board(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    board: BoardSnapshot,
    expected_revision: u64,
) -> Result<LibrarySnapshot, AudioError> {
    library
        .access(&service, move |store| {
            store.save_board(board, expected_revision)
        })
        .await
}

/// Guarda la densidad sin conflictos artificiales con las ediciones de bancos.
#[tauri::command]
pub async fn set_library_columns(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    columns: String,
) -> Result<LibrarySnapshot, AudioError> {
    library
        .access(&service, move |store| {
            store.patch_settings(Setting::Columns(columns))?;
            Ok(store.snapshot.clone())
        })
        .await
}

/// Elige archivos mediante diálogo Rust; IPC no acepta rutas y no requiere permisos genéricos de filesystem.
#[tauri::command]
pub async fn import_audio_files<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
) -> Result<ImportResult, AudioError> {
    library.initialize(&service).await?;
    let paths = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Audio", &["wav", "mp3", "ogg", "flac"])
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|path| {
                path.into_path()
                    .map_err(crate::infrastructure::library::failure)
            })
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(crate::infrastructure::library::failure)??;
    let mut result = library
        .access(&service, move |store| Ok(store.import_paths(paths)))
        .await?;
    if result.cancelled {
        return Ok(result);
    }
    library.synchronize(&service).await.map_err(|error| AudioError::new("catalog_registration_pending",format!("La importacion se guardo, pero el motor aun no registro el catalogo: {} Consulte de nuevo la biblioteca.",error.message)))?;
    result.snapshot = library
        .access(&service, |store| Ok(store.snapshot.clone()))
        .await?;
    for imported in &mut result.imported {
        if let Some(effect) = result
            .snapshot
            .effects
            .iter()
            .find(|effect| effect.id == imported.effect.id)
        {
            imported.effect = effect.clone();
        }
    }
    Ok(result)
}

#[cfg(test)]
mod ipc_tests;

/// Prepara mediante selector nativo Rust; nunca acepta rutas arbitrarias desde IPC.
#[tauri::command]
pub async fn prepare_bank_import<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
) -> Result<BankImportPreparation, AudioError> {
    library.initialize(&service).await?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Banco RadioFX", &["rfxbank"])
            .blocking_pick_file()
            .map(|path| {
                path.into_path()
                    .map_err(crate::infrastructure::library::failure)
            })
            .transpose()
    })
    .await
    .map_err(crate::infrastructure::library::failure)??;
    let Some(path) = path else {
        return Ok(BankImportPreparation {
            cancelled: true,
            preview: None,
        });
    };
    let preview = library
        .access(&service, move |store| store.prepare_bank_path(&path))
        .await?;
    Ok(BankImportPreparation {
        cancelled: false,
        preview: Some(preview),
    })
}

/// Confirma la preparacion contra revision real; el registro tardio nunca dispara audio.
#[tauri::command(rename_all = "camelCase")]
pub async fn commit_bank_import(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    token: String,
    expected_revision: u64,
    enable_shortcuts: bool,
) -> Result<BankImportCommitResult, AudioError> {
    let mut result = library
        .access(&service, move |store| {
            store.commit_bank_import(&token, expected_revision, enable_shortcuts)
        })
        .await?;
    library.synchronize(&service).await.map_err(|e| {
        AudioError::new(
            "catalog_registration_pending",
            format!(
                "El paquete ya se guardo; consulte la biblioteca antes de continuar: {}",
                e.message
            ),
        )
    })?;
    result.snapshot = library
        .access(&service, |store| Ok(store.snapshot.clone()))
        .await?;
    Ok(result)
}

/// Libera una preparacion sin escribir SQLite ni alterar archivos del usuario.
#[tauri::command]
pub async fn cancel_bank_import(
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    token: String,
) -> Result<(), AudioError> {
    library
        .access(&service, move |store| store.cancel_bank_import(&token))
        .await
}

/// Exporta una captura coherente a un nombre nuevo elegido en Rust, sin revelar rutas al frontend.
#[tauri::command(rename_all = "camelCase")]
pub async fn export_sound_banks<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    service: tauri::State<'_, AudioService>,
    library: tauri::State<'_, LibraryService>,
    bank_ids: Vec<String>,
    expected_revision: u64,
    include_shortcuts: bool,
) -> Result<BankExportResult, AudioError> {
    // Solo una captura grande puede esperar al selector; no bloquea ganancias ni STOP.
    let _export = library.package_exports.lock().await;
    let (bytes, banks, effects) = library
        .access(&service, move |store| {
            store.export_bank_bytes(&bank_ids, expected_revision, include_shortcuts)
        })
        .await?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Banco RadioFX", &["rfxbank"])
            .set_file_name("banco.rfxbank")
            .blocking_save_file()
            .map(|path| {
                path.into_path()
                    .map_err(crate::infrastructure::library::failure)
            })
            .transpose()
    })
    .await
    .map_err(crate::infrastructure::library::failure)??;
    let Some(path) = path else {
        return Ok(BankExportResult {
            cancelled: true,
            exported_banks: 0,
            exported_effects: 0,
            byte_size: 0,
            warnings: vec![],
        });
    };
    let byte_size = bytes.len();
    tauri::async_runtime::spawn_blocking(move ||crate::infrastructure::filesystem::publish_new(&path,&bytes)).await.map_err(crate::infrastructure::library::failure)?.map_err(|_|AudioError::new("export_not_published","No se publico el paquete. Elija un nombre nuevo: nunca se reemplaza un destino existente, aunque el selector lo confirme."))?;
    Ok(BankExportResult {
        cancelled: false,
        exported_banks: banks,
        exported_effects: effects,
        byte_size,
        warnings: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successful_audio_with_failed_persistence_returns_explicit_partial_failure_and_real_state() {
        let directory = crate::test_support::tempdir().unwrap();
        let root = directory.path().join("data");
        let service = AudioService::start(
            crate::application::engine::tests::FakeDriver::default,
            Box::new(|_, _| {}),
        )
        .unwrap();
        let library = LibraryService::new(root.clone());
        tauri::async_runtime::block_on(async {
            library.initialize(&service).await.unwrap();
            let connection = rusqlite::Connection::open(root.join("library.sqlite3")).unwrap();
            connection.execute_batch("CREATE TRIGGER fail_settings BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;").unwrap();
            let error = durable(&service, &library, Operation::Master(0.12))
                .await
                .unwrap_err();
            assert_eq!(error.code, "persistence_partial_failure");
            let Reply::Status(status) = service.request(Operation::Status).await.unwrap() else {
                panic!("status")
            };
            assert_eq!(status.master_volume, 0.12);
            let saved = library
                .access(&service, |store| Ok(store.snapshot.settings.master_volume))
                .await
                .unwrap();
            assert_eq!(saved, 0.7);
            assert_eq!(
                connection
                    .query_row("SELECT master_volume FROM app_settings", [], |r| r
                        .get::<_, f32>(0))
                    .unwrap(),
                0.7
            );
        });
        service.shutdown();
    }
    #[test]
    fn capability_is_minimal_and_command_registration_is_synchronized() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        let permissions = capability["permissions"].as_array().unwrap();
        let commands = [
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
        ];
        assert_eq!(commands.len(), 25);
        assert_eq!(permissions.len(), commands.len() + 2);
        for command in commands {
            assert!(permissions.contains(&serde_json::json!(format!(
                "allow-{}",
                command.replace('_', "-")
            ))));
            assert!(include_str!("../../build.rs").contains(&format!("\"{command}\"")));
            assert!(include_str!("../lib.rs").contains(&format!("commands::{command}")));
        }
        for permission in ["core:event:allow-listen", "core:event:allow-unlisten"] {
            assert!(permissions.contains(&serde_json::json!(permission)));
        }
    }
}
