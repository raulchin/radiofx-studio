use super::*;
use crate::application::engine::tests::FakeDriver;
use serde_json::{Value, json};
use tauri::{
    Manager,
    test::{MockRuntime, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

#[test]
fn device_preference_saves_actual_restored_name_and_never_failed_target_or_opaque_id() {
    let directory = crate::test_support::tempdir().unwrap();
    let app = mock_builder()
        .manage(
            AudioService::start(FakeDriver::failing_second_output, Box::new(|_, _| {})).unwrap(),
        )
        .manage(LibraryService::new(directory.path().into()))
        .invoke_handler(tauri::generate_handler![
            list_output_devices,
            set_output_device,
            get_library_snapshot
        ])
        .build(crate::app_context())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let devices = invoke(&main, "list_output_devices", json!({})).unwrap();
    let failed = invoke(
        &main,
        "set_output_device",
        json!({"deviceId":devices[1]["id"]}),
    )
    .unwrap();
    assert!(failed["error"].is_object());
    assert_eq!(
        invoke(&main, "get_library_snapshot", json!({})).unwrap()["settings"]["preferredDeviceName"],
        Value::Null
    );
    invoke(
        &main,
        "set_output_device",
        json!({"deviceId":devices[0]["id"]}),
    )
    .unwrap();
    let restored = invoke(
        &main,
        "set_output_device",
        json!({"deviceId":devices[1]["id"]}),
    )
    .unwrap();
    assert_eq!(restored["restored_previous"], true);
    assert_eq!(restored["status"]["selected_device"]["name"], "Salida 1");
    let snapshot = invoke(&main, "get_library_snapshot", json!({})).unwrap();
    assert_eq!(snapshot["settings"]["preferredDeviceName"], "Salida 1");
    assert_ne!(
        snapshot["settings"]["preferredDeviceName"],
        devices[0]["id"]
    );
    app.state::<AudioService>().shutdown();
}

#[test]
fn two_ipc_instances_reload_after_conflict_and_column_writes_cannot_restore_stale_audio_settings() {
    let directory = crate::test_support::tempdir().unwrap();
    let build = || {
        mock_builder()
            .manage(AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap())
            .manage(LibraryService::new(directory.path().into()))
            .invoke_handler(tauri::generate_handler![
                get_library_snapshot,
                save_board,
                set_library_columns,
                set_master_volume,
                set_max_concurrent_playbacks,
                list_output_devices,
                set_output_device,
                get_audio_engine_status
            ])
            .build(crate::app_context())
            .unwrap()
    };
    let a = build();
    let b = build();
    let window_a = tauri::WebviewWindowBuilder::new(&a, "main", Default::default())
        .build()
        .unwrap();
    let window_b = tauri::WebviewWindowBuilder::new(&b, "main", Default::default())
        .build()
        .unwrap();
    let stale = invoke(&window_b, "get_library_snapshot", json!({})).unwrap();
    invoke(&window_a, "set_master_volume", json!({"value":0.0})).unwrap();
    invoke(
        &window_a,
        "set_max_concurrent_playbacks",
        json!({"value":5}),
    )
    .unwrap();
    let devices = invoke(&window_a, "list_output_devices", json!({})).unwrap();
    invoke(
        &window_a,
        "set_output_device",
        json!({"deviceId":devices[0]["id"]}),
    )
    .unwrap();
    let patched = invoke(&window_b, "set_library_columns", json!({"columns":"6"})).unwrap();
    assert_eq!(patched["settings"]["masterVolume"], 0.0);
    assert_eq!(patched["settings"]["maxConcurrentPlaybacks"], 5);
    assert_eq!(
        patched["settings"]["preferredDeviceName"],
        "Nombre duplicado"
    );
    // La persistencia es compartida; no se cambia silenciosamente el motor de la otra instancia.
    assert_eq!(
        invoke(&window_b, "get_audio_engine_status", json!({})).unwrap()["master_volume"],
        0.7
    );
    let mut board = stale["board"].clone();
    board["banks"][0]["name"] = json!("Edicion A");
    invoke(
        &window_a,
        "save_board",
        json!({"board":board,"expectedRevision":0}),
    )
    .unwrap();
    assert_eq!(
        invoke(
            &window_b,
            "save_board",
            json!({"board":stale["board"],"expectedRevision":0})
        )
        .unwrap_err()["code"],
        "revision_conflict"
    );
    let fresh = invoke(&window_b, "get_library_snapshot", json!({})).unwrap();
    assert_eq!(fresh["revision"], 1);
    assert_eq!(fresh["board"]["banks"][0]["name"], "Edicion A");
    let mut board = fresh["board"].clone();
    board["banks"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"b","name":"Edicion B","buttons":[]}));
    let saved = invoke(
        &window_b,
        "save_board",
        json!({"board":board,"expectedRevision":1}),
    )
    .unwrap();
    assert_eq!(saved["revision"], 2);
    assert_eq!(saved["board"]["banks"][0]["name"], "Edicion A");
    assert_eq!(
        invoke(&window_a, "get_library_snapshot", json!({})).unwrap()["board"],
        saved["board"]
    );
    a.state::<AudioService>().shutdown();
    b.state::<AudioService>().shutdown();
}

/// Invoca la ACL con el origen local que Tauri utiliza en cada plataforma, sin ampliar permisos.
fn invoke(
    window: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    let origin = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    invoke_from(window, command, body, origin)
}

/// Permite probar que un origen remoto no hereda los permisos de la ventana local.
fn invoke_from(
    window: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: Value,
    origin: &str,
) -> Result<Value, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: origin.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}

#[test]
fn tauri_ipc_handlers_validate_camel_case_errors_snapshots_and_actual_acl() {
    let service = AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap();
    let directory = crate::test_support::tempdir().unwrap();
    let app = mock_builder()
        .plugin(tauri_plugin_dialog::init())
        .manage(service)
        .manage(LibraryService::new(directory.path().into()))
        .invoke_handler(tauri::generate_handler![
            get_audio_engine_status,
            list_output_devices,
            get_selected_output_device,
            set_output_device,
            play_effect,
            stop_playback,
            stop_effect,
            stop_all,
            set_master_volume,
            set_playback_volume,
            set_effect_volume,
            set_max_concurrent_playbacks,
            get_active_playbacks,
            get_library_snapshot,
            save_board,
            set_library_columns,
            import_audio_files,
            play_effect_with_options,
            restart_effect,
            set_playback_loop,
            fade_out_playback,
            prepare_bank_import,
            commit_bank_import,
            cancel_bank_import,
            export_sound_banks,
        ])
        // El contexto generado conserva el manifiesto y las capabilities de produccion.
        .build(crate::app_context())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "unauthorized", Default::default())
        .build()
        .unwrap();
    assert_eq!(
        invoke(&main, "play_effect", json!({"effectId":"native-test-low"})).unwrap_err()["code"],
        "library_loading"
    );
    invoke(&main, "stop_all", json!({})).unwrap();
    assert_eq!(invoke(&main, "restart_effect", json!({"effectId":"native-test-low","options":{"looped":false,"fadeInMs":0,"fadeOutMs":0}})).unwrap_err()["code"], "library_loading");
    let initial = invoke(&main, "get_audio_engine_status", json!({})).unwrap();
    assert_eq!(initial["active_playbacks"], json!([]));
    let library = invoke(&main, "get_library_snapshot", json!({})).unwrap();
    assert_eq!(library["revision"], 0);
    assert_eq!(library["board"]["version"], 2);
    assert_eq!(library["board"]["banks"][0]["buttons"], json!([]));
    assert_eq!(library["settings"]["columns"], "auto");
    assert!(library["settings"].get("preferredDeviceName").is_some());
    let changed = invoke(&main, "set_library_columns", json!({"columns":"4"})).unwrap();
    assert_eq!(changed["revision"], 0);
    assert_eq!(changed["settings"]["columns"], "4");
    assert!(invoke(&main, "set_library_columns", json!({"columns":"5"})).is_err());
    let saved = invoke(
        &main,
        "save_board",
        json!({"board":library["board"],"expectedRevision":0}),
    )
    .unwrap();
    assert_eq!(saved["revision"], 1);
    assert_eq!(
        invoke(
            &main,
            "save_board",
            json!({"board":library["board"],"expectedRevision":0})
        )
        .unwrap_err()["code"],
        "revision_conflict"
    );
    assert_eq!(initial["state"], "not_initialized");
    assert_eq!(initial["effects"][2]["duration_ms"], 4000);
    assert_eq!(
        invoke(&main, "get_selected_output_device", json!({})).unwrap(),
        Value::Null
    );
    let devices = invoke(&main, "list_output_devices", json!({})).unwrap();
    let selection = invoke(
        &main,
        "set_output_device",
        json!({"deviceId": devices[0]["id"]}),
    )
    .unwrap();
    assert_eq!(selection["status"]["state"], "ready");
    assert_eq!(selection["error"], Value::Null);
    assert_eq!(
        invoke(&main, "get_selected_output_device", json!({})).unwrap(),
        devices[0]
    );
    invoke(
        &main,
        "set_effect_volume",
        json!({"effectId":"native-test-low", "value":0.25}),
    )
    .unwrap();
    let id = invoke(&main, "play_effect", json!({"effectId":"native-test-low"})).unwrap();
    let loop_id=invoke(&main,"play_effect_with_options",json!({"effectId":"native-test-chime","options":{"looped":true,"fadeInMs":10,"fadeOutMs":20}})).unwrap();
    assert_eq!(
        invoke(
            &main,
            "set_playback_loop",
            json!({"playbackId":loop_id,"looped":false})
        )
        .unwrap(),
        Value::Null
    );
    assert_eq!(
        invoke(
            &main,
            "fade_out_playback",
            json!({"playbackId":loop_id,"durationMs":10})
        )
        .unwrap(),
        Value::Null
    );
    let extended = invoke(&main, "get_active_playbacks", json!({})).unwrap();
    assert_eq!(extended[1]["state"], "fading_out");
    assert_eq!(extended[1]["fade_out_ms"], 10);
    invoke(&main, "stop_playback", json!({"playbackId":loop_id})).unwrap();
    let restarted = invoke(&main, "restart_effect", json!({"effectId":"native-test-chime","options":{"looped":true,"fadeInMs":10,"fadeOutMs":20}})).unwrap();
    let restarted_again = invoke(&main, "restart_effect", json!({"effectId":"native-test-chime","options":{"looped":false,"fadeInMs":0,"fadeOutMs":0}})).unwrap();
    assert_ne!(restarted, restarted_again);
    let voices = invoke(&main, "get_active_playbacks", json!({})).unwrap();
    assert_eq!(voices.as_array().unwrap().len(), 2);
    assert_eq!(voices[0]["playback_id"], id);
    assert_eq!(voices[1]["playback_id"], restarted_again);
    assert_eq!(voices[1]["looped"], false);
    for body in [
        json!({"effect_id":"native-test-chime","options":{"looped":false,"fadeInMs":0,"fadeOutMs":0}}),
        json!({"effectId":"native-test-chime"}),
        json!({"effectId":"native-test-chime","options":{"looped":false,"fadeInMs":30001,"fadeOutMs":0}}),
        json!({"effectId":"native-test-chime","options":{"looped":false,"fadeInMs":0,"fadeOutMs":0,"unknown":true}}),
    ] {
        assert!(invoke(&main, "restart_effect", body).is_err());
    }
    assert_eq!(
        invoke(&main, "get_active_playbacks", json!({})).unwrap(),
        voices
    );
    invoke(
        &main,
        "stop_playback",
        json!({"playbackId":restarted_again}),
    )
    .unwrap();
    assert!(invoke(&main,"play_effect_with_options",json!({"effectId":"native-test-low","options":{"looped":false,"fadeInMs":30001,"fadeOutMs":0}})).is_err());
    assert!(invoke(&main,"play_effect_with_options",json!({"effectId":"native-test-low","options":{"looped":false,"fadeInMs":0,"fadeOutMs":0,"unknown":true}})).is_err());
    assert!(
        invoke(
            &main,
            "fade_out_playback",
            json!({"playback_id":id,"duration_ms":0})
        )
        .is_err()
    );
    assert!(
        invoke(
            &main,
            "set_playback_loop",
            json!({"playbackId":id,"looped":"true"})
        )
        .is_err()
    );
    assert!(
        invoke(
            &main,
            "commit_bank_import",
            json!({"token":"missing","expectedRevision":1,"enableShortcuts":false})
        )
        .is_err()
    );
    assert!(
        invoke(
            &main,
            "commit_bank_import",
            json!({"token":"missing","expected_revision":1,"enableShortcuts":false})
        )
        .is_err()
    );
    assert!(invoke(&main, "cancel_bank_import", json!({"token":"missing"})).is_err());
    // Una seleccion vacia se rechaza antes de alcanzar el selector nativo.
    assert!(
        invoke(
            &main,
            "export_sound_banks",
            json!({"bankIds":[],"expectedRevision":1,"includeShortcuts":false})
        )
        .is_err()
    );
    invoke(
        &main,
        "set_playback_volume",
        json!({"playbackId":id, "value":0.5}),
    )
    .unwrap();
    invoke(&main, "set_master_volume", json!({"value":0.6})).unwrap();
    invoke(&main, "set_max_concurrent_playbacks", json!({"value":2})).unwrap();
    let active = invoke(&main, "get_active_playbacks", json!({})).unwrap();
    assert_eq!(
        active,
        json!([{"playback_id":id, "effect_id":"native-test-low", "volume":0.5, "looped":false,"state":"playing","fade_out_ms":0}])
    );
    let status = invoke(&main, "get_audio_engine_status", json!({})).unwrap();
    assert_eq!(status["active_playbacks"], active);
    assert_eq!(status["engine_id"], initial["engine_id"]);
    assert!(status["revision"].as_u64() > initial["revision"].as_u64());
    invoke(&main, "stop_playback", json!({"playbackId":id})).unwrap();
    invoke(&main, "stop_effect", json!({"effectId":"native-test-low"})).unwrap();
    invoke(&main, "play_effect", json!({"effectId":"native-test-low"})).unwrap();
    assert_eq!(invoke(&main, "stop_all", json!({})).unwrap(), Value::Null);
    assert_eq!(
        invoke(&main, "get_active_playbacks", json!({})).unwrap(),
        json!([])
    );
    let error = invoke(&main, "play_effect", json!({"effectId":"missing"})).unwrap_err();
    assert_eq!(error["code"], "unknown_effect");
    assert!(error["message"].as_str().unwrap().contains("efecto"));
    assert_eq!(
        invoke(&main, "set_master_volume", json!({"value":2})).unwrap_err()["code"],
        "invalid_volume"
    );
    assert!(invoke(&main, "play_effect", json!({"effect_id":"native-test-low"})).is_err());
    invoke(&main, "list_output_devices", json!({})).unwrap();
    assert_eq!(
        invoke(
            &main,
            "set_output_device",
            json!({"deviceId":devices[0]["id"]})
        )
        .unwrap_err()["code"],
        "invalid_device"
    );

    for command in [
        "get_audio_engine_status",
        "play_effect",
        "stop_all",
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
    ] {
        let error = invoke(&other, command, json!({})).unwrap_err();
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("not allowed")),
            "{error}"
        );
        assert!(invoke_from(&main, command, json!({}), "https://untrusted.invalid").is_err());
    }
    for command in ["plugin:dialog|open", "plugin:fs|read_file", "import_paths"] {
        assert!(invoke(&main, command, json!({"path":"/etc/passwd"})).is_err());
    }
    let event = "audio:state-changed";
    let listener = invoke(
        &main,
        "plugin:event|listen",
        json!({"event":event, "target":tauri::EventTarget::Any, "handler":12}),
    )
    .unwrap();
    invoke(
        &main,
        "plugin:event|unlisten",
        json!({"event":event, "eventId":listener}),
    )
    .unwrap();
    assert!(
        invoke(
            &main,
            "plugin:event|emit",
            json!({"event":event, "payload":null})
        )
        .is_err()
    );
    app.state::<AudioService>().shutdown();
    let persisted =
        crate::infrastructure::library::LibraryStore::open(directory.path().into()).unwrap();
    assert_eq!(persisted.snapshot.revision, 1);
    assert_eq!(persisted.snapshot.settings.columns, "4");
    assert_eq!(persisted.snapshot.settings.master_volume, 0.6);
    assert_eq!(persisted.snapshot.settings.max_concurrent_playbacks, 2);
    assert_eq!(
        persisted.snapshot.settings.preferred_device_name.as_deref(),
        Some("Nombre duplicado")
    );
    assert_eq!(
        persisted.diagnostic_volumes,
        vec![("native-test-low".into(), 0.25)]
    );
}
