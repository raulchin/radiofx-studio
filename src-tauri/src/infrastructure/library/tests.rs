use super::*;
use crate::infrastructure::decoder::decode;

/// Crea una biblioteca historica v1 poblada sin usar las estructuras v2 del dominio.
fn legacy_library(root: &Path) {
    fs::create_dir_all(root.join("audio")).unwrap();
    let connection = Connection::open(root.join("library.sqlite3")).unwrap();
    connection
        .execute_batch(include_str!("../../../migrations/001_library.sql"))
        .unwrap();
    let id = "1d218cca-0000-4000-8000-000000000001";
    fs::write(root.join(format!("audio/{id}.bin")), WAV).unwrap();
    connection
        .execute(
            "INSERT INTO sound_effects VALUES (?,?,?,?,?,?,?,?,?,?)",
            params![
                id,
                "Historico",
                format!("audio/{id}.bin"),
                digest(WAV),
                100,
                "wav",
                44100,
                1,
                WAV.len() as i64,
                0.3
            ],
        )
        .unwrap();
    connection.execute_batch("INSERT INTO categories VALUES ('Radio'); INSERT INTO sound_banks VALUES ('second','Segundo',1); INSERT INTO bank_effects VALUES ('assignment','second','1d218cca-0000-4000-8000-000000000001','Asignado','mint','Radio',0); UPDATE app_settings SET active_bank_id='second',board_revision=17,columns='6',master_volume=0.2,max_concurrent_playbacks=8,preferred_device_name='USB'; INSERT INTO diagnostic_volumes VALUES ('native-test-low',0.25);").unwrap();
}

#[test]
fn populated_v1_migrates_atomically_preserving_ids_hashes_paths_settings_order_and_revision() {
    let temp = crate::test_support::tempdir().unwrap();
    let root = temp.path().join("data");
    legacy_library(&root);
    let before = Connection::open(root.join("library.sqlite3")).unwrap();
    let resource: (String, String, String) = before
        .query_row("SELECT id,path,hash FROM sound_effects", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    drop(before);
    let store = LibraryStore::open(root.clone()).unwrap();
    assert_eq!(store.snapshot.board.version, 2);
    assert_eq!(store.snapshot.revision, 17);
    assert_eq!(store.snapshot.board.active_bank_id, "second");
    assert_eq!(store.snapshot.board.banks[1].buttons[0].id, "assignment");
    assert_eq!(
        store.snapshot.board.banks[1].buttons[0].playback,
        Default::default()
    );
    assert!(store.snapshot.board.keyboard_shortcuts.is_empty());
    assert_eq!(store.assets[&resource.0], (resource.1.clone(), resource.2));
    assert_eq!(fs::read(root.join(resource.1)).unwrap(), WAV);
    assert_eq!(store.snapshot.settings.master_volume, 0.2);
    assert_eq!(store.snapshot.settings.columns, "6");
    assert_eq!(store.snapshot.settings.max_concurrent_playbacks, 8);
    assert_eq!(
        store.snapshot.settings.preferred_device_name.as_deref(),
        Some("USB")
    );
    assert_eq!(store.snapshot.effects[0].default_volume, 0.3);
}

#[test]
fn concurrent_openers_migrate_populated_v1_once_under_immediate_transaction() {
    let temp = crate::test_support::tempdir().unwrap();
    let root = temp.path().join("data");
    legacy_library(&root);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let threads = (0..2)
        .map(|_| {
            let root = root.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let store = LibraryStore::open(root).unwrap();
                (store.snapshot.revision, store.snapshot.board.version)
            })
        })
        .collect::<Vec<_>>();
    for thread in threads {
        assert_eq!(thread.join().unwrap(), (17, 2));
    }
}

#[test]
fn migration_ddl_or_integrity_failure_rolls_back_alter_and_declared_version_without_reset() {
    for invalid_ddl in [true, false] {
        let temp = crate::test_support::tempdir().unwrap();
        let root = temp.path().join("data");
        legacy_library(&root);
        let connection = Connection::open(root.join("library.sqlite3")).unwrap();
        if invalid_ddl {
            connection
                .execute_batch("CREATE INDEX keyboard_shortcuts ON sound_banks(name);")
                .unwrap();
        } else {
            // Solo la fixture historica se corrompe; open debe activar FK y revertir la migracion.
            connection
                .pragma_update(None, "foreign_keys", false)
                .unwrap();
            connection
                .execute("UPDATE app_settings SET active_bank_id='missing'", [])
                .unwrap();
            connection
                .pragma_update(None, "foreign_keys", true)
                .unwrap();
        }
        assert!(LibraryStore::open(root.clone()).is_err());
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            1
        );
        assert!(
            connection
                .prepare("SELECT looped FROM bank_effects")
                .is_err()
        );
        assert_eq!(
            connection
                .query_row("SELECT board_revision FROM app_settings", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            17
        );
        assert_eq!(
            connection
                .query_row("SELECT name FROM sound_effects", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "Historico"
        );
    }
}

/// Crea un atajo basico que apunta a un banco real del tablero.
fn shortcut(id: &str, scope: ShortcutScope, bank: Option<&str>, target: &str) -> ShortcutBinding {
    ShortcutBinding {
        id: id.into(),
        scope,
        scope_bank_id: bank.map(str::to_owned),
        chord: KeyChord {
            code: "KeyA".into(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        },
        action: ShortcutAction {
            kind: ShortcutKind::SelectBank,
            target_id: Some(target.into()),
        },
        enabled: true,
    }
}

#[test]
fn shortcuts_validate_scopes_exact_modifiers_reserved_disabled_targets_and_joint_revision() {
    let temp = crate::test_support::tempdir().unwrap();
    let mut store = LibraryStore::open(temp.path().join("data")).unwrap();
    let mut board = store.snapshot.board.clone();
    board.banks.push(SoundBank {
        id: "second".into(),
        name: "Segundo".into(),
        buttons: vec![],
    });
    board.keyboard_shortcuts = vec![
        shortcut("a", ShortcutScope::Bank, Some("principal"), "principal"),
        shortcut("b", ShortcutScope::Bank, Some("second"), "second"),
    ];
    store.save_board(board.clone(), 0).unwrap();
    assert_eq!(store.snapshot.revision, 1);
    for case in 0..9 {
        let mut invalid = board.clone();
        match case {
            0 => {
                invalid.keyboard_shortcuts[1].scope = ShortcutScope::Application;
                invalid.keyboard_shortcuts[1].scope_bank_id = None;
            }
            1 => invalid.keyboard_shortcuts[1].scope_bank_id = Some("principal".into()),
            2 => invalid.keyboard_shortcuts[0].chord.code = "Enter".into(),
            3 => {
                let c = &mut invalid.keyboard_shortcuts[0].chord;
                c.code = "Space".into();
                c.ctrl = true;
                c.shift = true;
                invalid.keyboard_shortcuts[0].enabled = false;
            }
            4 => {
                let c = &mut invalid.keyboard_shortcuts[0].chord;
                c.code = "KeyR".into();
                c.meta = true;
            }
            5 => invalid.keyboard_shortcuts[0].chord.code = "F5".into(),
            6 => invalid.keyboard_shortcuts[0].action.target_id = Some("missing".into()),
            7 => invalid.keyboard_shortcuts[1].id = "a".into(),
            _ => {
                invalid.keyboard_shortcuts[0].action.kind = ShortcutKind::StopAll;
            }
        }
        assert!(store.save_board(invalid, 1).is_err(), "{case}");
        assert_eq!(store.snapshot.revision, 1);
    }
    board.keyboard_shortcuts[1].scope_bank_id = Some("principal".into());
    board.keyboard_shortcuts[1].enabled = false;
    store.save_board(board.clone(), 1).unwrap();
    board.keyboard_shortcuts[1].enabled = true;
    board.keyboard_shortcuts[1].chord.shift = true;
    store.save_board(board, 2).unwrap();
    assert_eq!(store.snapshot.revision, 3);
    let mut board = store.snapshot.board.clone();
    board.banks.reverse();
    store.save_board(board.clone(), 3).unwrap();
    board.banks.retain(|b| b.id != "principal");
    board.active_bank_id = "second".into();
    assert!(store.save_board(board.clone(), 4).is_err());
    board.keyboard_shortcuts.clear();
    store.save_board(board, 4).unwrap();
    assert!(store.snapshot.board.keyboard_shortcuts.is_empty());
}

const WAV: &[u8] = include_bytes!("../../../tests/fixtures/tone.wav");
const MP3: &[u8] = include_bytes!("../../../tests/fixtures/tone.mp3");
const OGG: &[u8] = include_bytes!("../../../tests/fixtures/tone.ogg");
const FLAC: &[u8] = include_bytes!("../../../tests/fixtures/tone.flac");

/// Copia fixtures generados con ffmpeg 6.1.1 exclusivamente a un directorio temporal.
fn fixture(directory: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = directory.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn serialized_library_contract_has_exact_camel_case_fields_without_paths() {
    let directory = crate::test_support::tempdir().unwrap();
    let mut store = LibraryStore::open(directory.path().join("data")).unwrap();
    let path = fixture(directory.path(), "tone.wav", WAV);
    let imported = store.import_paths(vec![path]);
    let mut board = store.snapshot.board.clone();
    board.banks[0].buttons.push(SoundButton {
        id: "button".into(),
        effect_id: Some(imported.imported[0].effect.id.clone()),
        name: "Señal".into(),
        duration_ms: 999,
        color: "amber".into(),
        category: "Radio".into(),
        playback: Default::default(),
    });
    store.save_board(board, 0).unwrap();
    let mut result = store.import_paths(vec![]);
    result.failed.push(ImportFailure {
        name: "ejemplo".into(),
        message: "Error visible".into(),
    });
    let json = serde_json::to_value(result).unwrap();
    let keys = |value: &serde_json::Value| {
        value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(keys(&json), ["cancelled", "failed", "imported", "snapshot"]);
    assert_eq!(keys(&json["failed"][0]), ["message", "name"]);
    assert_eq!(
        keys(&json["snapshot"]),
        ["board", "effects", "revision", "settings"]
    );
    assert_eq!(
        keys(&json["snapshot"]["board"]),
        ["activeBankId", "banks", "keyboardShortcuts", "version"]
    );
    assert_eq!(
        keys(&json["snapshot"]["board"]["banks"][0]),
        ["buttons", "id", "name"]
    );
    assert_eq!(
        keys(&json["snapshot"]["board"]["banks"][0]["buttons"][0]),
        [
            "category",
            "color",
            "durationMs",
            "effectId",
            "id",
            "name",
            "playback"
        ]
    );
    assert_eq!(
        keys(&json["snapshot"]["effects"][0]),
        [
            "availability",
            "byteSize",
            "channels",
            "defaultVolume",
            "durationMs",
            "error",
            "format",
            "id",
            "name",
            "sampleRate"
        ]
    );
    assert_eq!(
        keys(&json["snapshot"]["settings"]),
        [
            "columns",
            "masterVolume",
            "maxConcurrentPlaybacks",
            "preferredDeviceName"
        ]
    );
    assert_eq!(
        serde_json::to_value(&imported.imported[0])
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        2
    );
}

/// Genera PCM16 WAV sin herramientas externas para verificar límites declarados y reales.
fn wave(channels: u16, rate: u32, frames: u32) -> Vec<u8> {
    let size = frames * u32::from(channels) * 2;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(size + 36).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&channels.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
    bytes.extend_from_slice(&(channels * 2).to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&size.to_le_bytes());
    bytes.resize(bytes.len() + size as usize, 0);
    bytes
}

#[test]
fn duration_channels_rate_per_file_pcm_and_transient_memory_budget_are_enforced() {
    assert!(decode(wave(3, 44100, 100), "wav", CACHE_LIMIT).is_err());
    assert!(decode(wave(1, 4000, 100), "wav", CACHE_LIMIT).is_err());
    assert!(decode(wave(1, 8000, 8000 * 121), "wav", CACHE_LIMIT).is_err());
    assert!(decode(wave(2, 192000, 192000 * 23), "wav", CACHE_LIMIT).is_err());
    let pcm = decode(WAV.to_vec(), "wav", CACHE_LIMIT).unwrap();
    let peak_budget = 2 * 1024 * 1024 + pcm.samples.len() * 8;
    assert!(decode(WAV.to_vec(), "wav", peak_budget).is_ok());
    assert_eq!(
        decode(WAV.to_vec(), "wav", peak_budget - 8)
            .unwrap_err()
            .code,
        "pcm_budget"
    );
}

#[test]
fn deferred_commit_failure_removes_only_the_new_owned_copy_and_rolls_back_metadata() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("data");
    let mut store = LibraryStore::open(root.clone()).unwrap();
    let path = fixture(directory.path(), "tone.wav", WAV);
    let orphan = root.join("audio/keep.bin");
    fs::write(&orphan, b"keep").unwrap();
    store.connection.execute_batch("CREATE TRIGGER deferred_failure AFTER INSERT ON sound_effects BEGIN UPDATE app_settings SET active_bank_id='absent'; END;").unwrap();
    let result = store.import_paths(vec![path.clone()]);
    assert_eq!(result.failed.len(), 1);
    assert!(store.snapshot.effects.is_empty());
    assert!(store.pcm.is_empty());
    assert_eq!(
        store
            .connection
            .query_row("SELECT count(*) FROM sound_effects", [], |r| r
                .get::<_, u32>(0))
            .unwrap(),
        0
    );
    assert_eq!(fs::read_dir(root.join("audio")).unwrap().count(), 1);
    assert_eq!(fs::read(orphan).unwrap(), b"keep");
    assert_eq!(fs::read(path).unwrap(), WAV);
}

#[test]
fn live_file_changes_are_visible_and_reserved_pcm_remains_accounted_while_pinned() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("data");
    let path = fixture(directory.path(), "tone.wav", WAV);
    let mut store = LibraryStore::open(root.clone()).unwrap();
    let effect = store.import_paths(vec![path]).imported.remove(0).effect;
    let pin = store.pcm[&effect.id].clone();
    let remaining = store.remaining();
    let managed = root.join(format!("audio/{}.bin", effect.id));
    fs::remove_file(&managed).unwrap();
    store.refresh_availability().unwrap();
    assert_eq!(store.snapshot.effects[0].availability, "missing");
    assert_eq!(store.remaining(), remaining);
    fs::write(&managed, WAV).unwrap();
    store.refresh_availability().unwrap();
    assert_eq!(store.snapshot.effects[0].availability, "available");
    assert_eq!(store.remaining(), remaining);
    assert!(std::sync::Arc::ptr_eq(
        &pin.samples,
        &store.pcm[&effect.id].samples
    ));
}

#[test]
fn real_encoded_formats_decode_and_preserve_rate_and_channels() {
    for (extension, bytes) in [("wav", WAV), ("mp3", MP3), ("ogg", OGG), ("flac", FLAC)] {
        let pcm = decode(bytes.to_vec(), extension, CACHE_LIMIT).unwrap();
        assert_eq!(pcm.sample_rate, 44100);
        assert!((1..=2).contains(&pcm.channels));
        assert!(pcm.samples.len() > 1000);
        assert!(pcm.samples.iter().any(|sample| sample.abs() > 0.001));
        assert!(pcm.samples.iter().all(|sample| sample.is_finite()));
    }
}

#[test]
fn decoder_rejects_false_extensions_corrupt_truncated_and_budget_exhaustion() {
    assert!(decode(WAV.to_vec(), "mp3", CACHE_LIMIT).is_err());
    assert!(decode(OGG.to_vec(), "flac", CACHE_LIMIT).is_err());
    assert!(decode(b"RIFF0000WAVEgarbage".to_vec(), "wav", CACHE_LIMIT).is_err());
    for (extension, bytes) in [("wav", WAV), ("mp3", MP3), ("ogg", OGG), ("flac", FLAC)] {
        assert!(
            decode(bytes[..bytes.len() / 2].to_vec(), extension, CACHE_LIMIT).is_err(),
            "{extension}"
        );
        assert!(decode(bytes.to_vec(), extension, 32).is_err());
    }
}

#[test]
fn migration_seed_restart_idempotence_and_unknown_future_schemas_are_preserved() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("data");
    let store = LibraryStore::open(root.clone()).unwrap();
    assert_eq!(store.snapshot.board.banks.len(), 1);
    assert_eq!(store.snapshot.board.banks[0].name, "Principal");
    assert!(store.snapshot.board.banks[0].buttons.is_empty());
    assert!(store.snapshot.effects.is_empty());
    drop(store);
    assert!(LibraryStore::open(root.clone()).is_ok());
    let connection = Connection::open(root.join("library.sqlite3")).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    assert!(LibraryStore::open(root.clone()).is_err());
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        99
    );
    connection.pragma_update(None, "user_version", 0).unwrap();
    assert!(LibraryStore::open(root).is_err());
    assert_eq!(
        connection
            .query_row("SELECT name FROM sound_banks", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "Principal"
    );
}

#[test]
fn imports_are_managed_deduplicated_and_originals_remain_unchanged() {
    let directory = crate::test_support::tempdir().unwrap();
    let path = fixture(directory.path(), "original.wav", WAV);
    let root = directory.path().join("data");
    let mut store = LibraryStore::open(root.clone()).unwrap();
    let result = store.import_paths(vec![path.clone(), path.clone()]);
    assert!(result.failed.is_empty());
    assert_eq!(result.imported.len(), 2);
    assert!(!result.imported[0].duplicate);
    assert!(result.imported[1].duplicate);
    assert_eq!(result.snapshot.effects.len(), 1);
    assert_eq!(fs::read(path).unwrap(), WAV);
    assert_eq!(fs::read_dir(root.join("audio")).unwrap().count(), 1);
    let json = serde_json::to_value(&result.snapshot).unwrap();
    assert!(json["effects"][0].get("path").is_none());
    assert!(json["effects"][0].get("durationMs").is_some());
    drop(store);
    let reopened = LibraryStore::open(root).unwrap();
    assert_eq!(reopened.pcm.len(), 1);
    assert_eq!(reopened.snapshot.effects[0].availability, "available");
}

#[test]
fn board_assignments_order_settings_and_columns_roundtrip_without_revision_conflicts() {
    let directory = crate::test_support::tempdir().unwrap();
    let path = fixture(directory.path(), "audio.wav", WAV);
    let root = directory.path().join("data");
    let mut store = LibraryStore::open(root.clone()).unwrap();
    let imported = store.import_paths(vec![path]);
    let effect = imported.imported[0].effect.clone();
    let mut settings = store.snapshot.settings.clone();
    settings.columns = "6".into();
    settings.master_volume = 0.2;
    settings.max_concurrent_playbacks = 32;
    settings.preferred_device_name = Some("USB duplicado".into());
    store
        .patch_settings(Setting::Columns(settings.columns))
        .unwrap();
    store
        .patch_settings(Setting::Master(settings.master_volume))
        .unwrap();
    store
        .patch_settings(Setting::Limit(settings.max_concurrent_playbacks))
        .unwrap();
    store
        .patch_settings(Setting::PreferredDevice(settings.preferred_device_name))
        .unwrap();
    store.effect_volume(&effect.id, 0.8).unwrap();
    assert_eq!(store.snapshot.revision, 0);
    let board = BoardSnapshot {
        version: 2,
        keyboard_shortcuts: vec![],
        active_bank_id: "bank-b".into(),
        banks: vec![
            SoundBank {
                id: "bank-b".into(),
                name: "Segundo".into(),
                buttons: vec![SoundButton {
                    id: "button".into(),
                    effect_id: Some(effect.id.clone()),
                    name: "Efecto".into(),
                    duration_ms: 999,
                    color: "mint".into(),
                    category: "Radio".into(),
                    playback: Default::default(),
                }],
            },
            SoundBank {
                id: "bank-a".into(),
                name: "Primero".into(),
                buttons: vec![SoundButton {
                    id: "empty".into(),
                    effect_id: None,
                    name: "Vacio".into(),
                    duration_ms: 999,
                    color: "slate".into(),
                    category: String::new(),
                    playback: Default::default(),
                }],
            },
        ],
    };
    store.save_board(board.clone(), 0).unwrap();
    assert_eq!(
        store.save_board(board, 0).unwrap_err().code,
        "revision_conflict"
    );
    drop(store);
    let store = LibraryStore::open(root).unwrap();
    assert_eq!(store.snapshot.revision, 1);
    assert_eq!(store.snapshot.board.active_bank_id, "bank-b");
    assert_eq!(
        store.snapshot.board.banks[0].buttons[0].duration_ms,
        effect.duration_ms
    );
    assert_eq!(store.snapshot.board.banks[1].buttons[0].duration_ms, 0);
    assert_eq!(store.snapshot.settings.columns, "6");
    assert_eq!(store.snapshot.settings.master_volume, 0.2);
    assert_eq!(store.snapshot.settings.max_concurrent_playbacks, 32);
    assert_eq!(store.snapshot.effects[0].default_volume, 0.8);
}

#[test]
fn board_rejects_invalid_ids_colors_native_bindings_and_cross_bank_duplicates_atomically() {
    let directory = crate::test_support::tempdir().unwrap();
    let mut store = LibraryStore::open(directory.path().join("data")).unwrap();
    let initial = serde_json::to_value(&store.snapshot).unwrap();
    let button = SoundButton {
        id: "button".into(),
        effect_id: None,
        name: "Boton".into(),
        duration_ms: 0,
        color: "amber".into(),
        category: String::new(),
        playback: Default::default(),
    };
    for case in 0..6 {
        let mut board = store.snapshot.board.clone();
        board.banks[0].buttons.push(button.clone());
        match case {
            0 => board.banks[0].buttons[0].effect_id = Some("native-test-low".into()),
            1 => board.banks[0].buttons[0].effect_id = Some("mock-effect".into()),
            2 => board.banks[0].buttons[0].color = "pink".into(),
            3 => board.banks[0].name = "x".repeat(61),
            4 => board.banks.push(SoundBank {
                id: "other".into(),
                name: "Otro".into(),
                buttons: vec![button.clone()],
            }),
            _ => board.active_bank_id = "absent".into(),
        }
        assert!(store.save_board(board, 0).is_err());
        assert_eq!(serde_json::to_value(&store.snapshot).unwrap(), initial);
    }
}

#[test]
fn foreign_keys_constraints_and_failed_board_transaction_roll_back() {
    let directory = crate::test_support::tempdir().unwrap();
    let mut store = LibraryStore::open(directory.path().join("data")).unwrap();
    assert!(
        store
            .connection
            .execute(
                "INSERT INTO bank_effects(id,bank_id,effect_id,name,color,category,position) VALUES ('bad','absent',NULL,'Bad','amber',NULL,0)",
                []
            )
            .is_err()
    );
    assert!(
        store
            .connection
            .execute("UPDATE app_settings SET master_volume=2", [])
            .is_err()
    );
    store.connection.execute_batch("CREATE TRIGGER reject_bank BEFORE INSERT ON sound_banks BEGIN SELECT RAISE(ABORT,'simulated'); END;").unwrap();
    let board = store.snapshot.board.clone();
    assert!(store.save_board(board, 0).is_err());
    assert_eq!(
        store
            .connection
            .query_row("SELECT name FROM sound_banks", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "Principal"
    );
    assert_eq!(store.snapshot.revision, 0);
}

#[test]
fn missing_changed_and_corrupt_managed_files_are_isolated_on_restart() {
    for mode in ["missing", "changed", "corrupt"] {
        let directory = crate::test_support::tempdir().unwrap();
        let root = directory.path().join("data");
        let mut store = LibraryStore::open(root.clone()).unwrap();
        let paths = [
            fixture(directory.path(), "good.wav", WAV),
            fixture(directory.path(), "bad.flac", FLAC),
        ];
        let result = store.import_paths(paths.to_vec());
        assert!(result.failed.is_empty());
        let path: String = store
            .connection
            .query_row(
                "SELECT path FROM sound_effects WHERE id=?",
                [&result.imported[1].effect.id],
                |r| r.get(0),
            )
            .unwrap();
        let managed = root.join(path);
        match mode {
            "missing" => fs::remove_file(&managed).unwrap(),
            "changed" => fs::write(&managed, WAV).unwrap(),
            _ => {
                let bytes = b"fLaCcorrupt";
                fs::write(&managed, bytes).unwrap();
                store
                    .connection
                    .execute(
                        "UPDATE sound_effects SET hash=? WHERE id=?",
                        params![digest(bytes), result.imported[1].effect.id],
                    )
                    .unwrap();
            }
        }
        drop(store);
        let reopened = LibraryStore::open(root).unwrap();
        assert_eq!(reopened.snapshot.effects[0].availability, "available");
        assert_eq!(
            reopened.snapshot.effects[1].availability,
            if mode == "missing" {
                "missing"
            } else {
                "invalid"
            }
        );
        assert!(reopened.snapshot.effects[1].error.is_some());
        assert_eq!(reopened.pcm.len(), 1);
    }
}

#[test]
fn unsafe_paths_special_entries_and_size_limits_are_rejected_without_deleting_orphans() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("data");
    let mut store = LibraryStore::open(root.clone()).unwrap();
    for path in [
        "../escape",
        "audio/../escape",
        "/absolute",
        "audio/CON",
        "audio/a/b",
        "audio/00000000-0000-0000-0000-000000000000.bin/extra",
    ] {
        assert!(store.managed_name(path).is_err());
    }
    let huge = directory.path().join("huge.wav");
    fs::File::create(&huge)
        .unwrap()
        .set_len(FILE_LIMIT as u64 + 1)
        .unwrap();
    assert_eq!(
        store
            .import_paths(vec![
                huge,
                directory.path().into(),
                directory.path().join("missing.wav")
            ])
            .failed
            .len(),
        3
    );
    let orphan = root.join("audio/unexpected.bin");
    fs::write(&orphan, b"userdata").unwrap();
    drop(store);
    assert!(LibraryStore::open(root).is_ok());
    assert_eq!(fs::read(orphan).unwrap(), b"userdata");
}

#[cfg(unix)]
#[test]
fn source_managed_and_root_symlinks_are_rejected() {
    use std::os::unix::fs::symlink;
    let directory = crate::test_support::tempdir().unwrap();
    let source = fixture(directory.path(), "source.wav", WAV);
    let link = directory.path().join("link.wav");
    symlink(&source, &link).unwrap();
    let root = directory.path().join("data");
    let mut store = LibraryStore::open(root.clone()).unwrap();
    assert_eq!(store.import_paths(vec![link]).failed.len(), 1);
    let result = store.import_paths(vec![source.clone()]);
    let managed = root.join(format!("audio/{}.bin", result.imported[0].effect.id));
    fs::remove_file(&managed).unwrap();
    symlink(&source, &managed).unwrap();
    drop(store);
    let reopened = LibraryStore::open(root.clone()).unwrap();
    assert_eq!(reopened.snapshot.effects[0].availability, "invalid");
    let alias = directory.path().join("alias");
    symlink(root, &alias).unwrap();
    assert!(LibraryStore::open(alias).is_err());
}

#[test]
fn import_database_failure_cleans_temporary_files_and_preserves_good_catalog() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("data");
    let mut store = LibraryStore::open(root.clone()).unwrap();
    let good = fixture(directory.path(), "good.wav", WAV);
    store.import_paths(vec![good.clone()]);
    store.connection.execute_batch("CREATE TRIGGER reject_effect BEFORE INSERT ON sound_effects BEGIN SELECT RAISE(ABORT,'simulated IO failure'); END;").unwrap();
    let bad = fixture(directory.path(), "new.flac", FLAC);
    let result = store.import_paths(vec![bad]);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(store.snapshot.effects.len(), 1);
    assert_eq!(store.pcm.len(), 1);
    assert_eq!(fs::read_dir(root.join("audio")).unwrap().count(), 1);
    assert_eq!(fs::read(good).unwrap(), WAV);
    assert!(store.import_paths(vec![]).cancelled);
}

#[test]
fn filesystem_write_failure_leaves_original_and_existing_metadata_untouched() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("data");
    let mut store = LibraryStore::open(root.clone()).unwrap();
    let good = fixture(directory.path(), "good.wav", WAV);
    store.import_paths(vec![good]);
    fs::rename(root.join("audio"), root.join("preserved-audio")).unwrap();
    fs::write(root.join("audio"), b"No sobrescribir").unwrap();
    let source = fixture(directory.path(), "new.flac", FLAC);
    let result = store.import_paths(vec![source.clone()]);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(store.snapshot.effects.len(), 1);
    assert_eq!(store.pcm.len(), 1);
    assert_eq!(fs::read(source).unwrap(), FLAC);
    assert_eq!(fs::read(root.join("audio")).unwrap(), b"No sobrescribir");
    assert_eq!(
        fs::read_dir(root.join("preserved-audio")).unwrap().count(),
        1
    );
}

#[test]
fn version_one_with_unknown_schema_is_refused_without_seeding_or_overwriting() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("data");
    fs::create_dir(&root).unwrap();
    let connection = Connection::open(root.join("library.sqlite3")).unwrap();
    connection.execute_batch("CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES ('preservar'); PRAGMA user_version=1;").unwrap();
    assert!(LibraryStore::open(root).is_err());
    assert_eq!(
        connection
            .query_row("SELECT value FROM user_data", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "preservar"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn stale_store_can_reload_after_revision_conflict_and_preserve_the_other_edit() {
    let temp = crate::test_support::tempdir().unwrap();
    let root = temp.path().join("data");
    let mut a = LibraryStore::open(root.clone()).unwrap();
    let mut b = LibraryStore::open(root).unwrap();
    let stale = b.snapshot.board.clone();
    let mut board = a.snapshot.board.clone();
    board.banks[0].name = "Edicion A".into();
    a.save_board(board, 0).unwrap();
    assert_eq!(
        b.save_board(stale, 0).unwrap_err().code,
        "revision_conflict"
    );
    b.refresh_availability().unwrap();
    assert_eq!(b.snapshot.revision, 1);
    assert_eq!(b.snapshot.board.banks[0].name, "Edicion A");
    let mut board = b.snapshot.board.clone();
    board.banks.push(SoundBank {
        id: "b".into(),
        name: "Edicion B".into(),
        buttons: vec![],
    });
    b.save_board(board, 1).unwrap();
    a.refresh_availability().unwrap();
    assert_eq!(a.snapshot.revision, 2);
    assert_eq!(a.snapshot.board.banks[0].name, "Edicion A");
    assert_eq!(a.snapshot.board.banks[1].name, "Edicion B");
}

#[test]
fn field_patches_preserve_mute_device_limit_and_columns_written_by_another_store() {
    let temp = crate::test_support::tempdir().unwrap();
    let root = temp.path().join("data");
    let mut a = LibraryStore::open(root.clone()).unwrap();
    let mut b = LibraryStore::open(root).unwrap();
    a.patch_settings(Setting::Master(0.0)).unwrap();
    a.patch_settings(Setting::Limit(7)).unwrap();
    a.patch_settings(Setting::PreferredDevice(Some("USB".into())))
        .unwrap();
    assert_eq!(b.snapshot.settings.master_volume, 0.7);
    b.patch_settings(Setting::Columns("6".into())).unwrap();
    assert_eq!(b.snapshot.settings.master_volume, 0.0);
    assert_eq!(b.snapshot.settings.max_concurrent_playbacks, 7);
    assert_eq!(
        b.snapshot.settings.preferred_device_name.as_deref(),
        Some("USB")
    );
    a.patch_settings(Setting::Master(0.2)).unwrap();
    assert_eq!(a.snapshot.settings.columns, "6");
    b.patch_settings(Setting::Limit(3)).unwrap();
    assert_eq!(b.snapshot.settings.master_volume, 0.2);
    a.patch_settings(Setting::PreferredDevice(None)).unwrap();
    assert_eq!(a.snapshot.settings.max_concurrent_playbacks, 3);
    assert_eq!(a.snapshot.settings.columns, "6");
    b.patch_settings(Setting::Columns("4".into())).unwrap();
    assert!(b.snapshot.settings.preferred_device_name.is_none());
    assert_eq!(b.snapshot.revision, 0);
}

#[test]
fn reload_publishes_one_sqlite_snapshot_even_when_another_process_commits_mid_read() {
    let temp = crate::test_support::tempdir().unwrap();
    let root = temp.path().join("data");
    let mut a = LibraryStore::open(root.clone()).unwrap();
    a.connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    a.reload_hook = Some(Box::new(move || {
        let writer = Connection::open(root.join("library.sqlite3")).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE; UPDATE sound_banks SET name='Nuevo'; UPDATE app_settings SET columns='6',board_revision=1; COMMIT;").unwrap();
    }));
    a.reload().unwrap();
    assert_eq!(a.snapshot.revision, 0);
    assert_eq!(a.snapshot.board.banks[0].name, "Principal");
    assert_eq!(a.snapshot.settings.columns, "auto");
    a.reload().unwrap();
    assert_eq!(a.snapshot.revision, 1);
    assert_eq!(a.snapshot.board.banks[0].name, "Nuevo");
    assert_eq!(a.snapshot.settings.columns, "6");
}

#[test]
fn reimport_repairs_missing_or_corrupt_duplicates_with_new_paths_and_preserves_identity_and_assignments()
 {
    for missing in [true, false] {
        let temp = crate::test_support::tempdir().unwrap();
        let root = temp.path().join("data");
        let source = fixture(temp.path(), "tone.wav", WAV);
        let mut store = LibraryStore::open(root.clone()).unwrap();
        let effect = store
            .import_paths(vec![source.clone()])
            .imported
            .remove(0)
            .effect;
        store
            .connection
            .execute(
                "UPDATE sound_effects SET name='Personalizado',default_volume=0.25 WHERE id=?",
                [&effect.id],
            )
            .unwrap();
        let mut board = store.snapshot.board.clone();
        board.banks[0].buttons.push(SoundButton {
            id: "button".into(),
            effect_id: Some(effect.id.clone()),
            name: "Asignado".into(),
            playback: Default::default(),
            duration_ms: 0,
            color: "mint".into(),
            category: "Radio".into(),
        });
        store.save_board(board, 0).unwrap();
        let old = store.assets[&effect.id].0.clone();
        let old_path = root.join(&old);
        let pcm = store.pcm[&effect.id].clone();
        let budget = store.remaining();
        if missing {
            fs::remove_file(&old_path).unwrap();
        } else {
            fs::write(&old_path, b"contenido ajeno").unwrap();
        }
        store.refresh_availability().unwrap();
        assert_ne!(store.snapshot.effects[0].availability, "available");
        let result = store.import_paths(vec![source.clone()]);
        assert!(result.failed.is_empty());
        assert_eq!(result.imported.len(), 1);
        assert!(result.imported[0].duplicate);
        assert_eq!(result.imported[0].effect.id, effect.id);
        assert_eq!(result.imported[0].effect.name, "Personalizado");
        assert_eq!(result.imported[0].effect.default_volume, 0.25);
        assert_eq!(result.imported[0].effect.availability, "available");
        assert_ne!(store.assets[&effect.id].0, old);
        assert_eq!(
            fs::read(root.join(&store.assets[&effect.id].0)).unwrap(),
            WAV
        );
        if missing {
            assert!(!old_path.exists());
        } else {
            assert_eq!(fs::read(old_path).unwrap(), b"contenido ajeno");
        }
        assert_eq!(fs::read(source).unwrap(), WAV);
        assert_eq!(store.snapshot.effects.len(), 1);
        assert_eq!(store.snapshot.revision, 1);
        assert_eq!(
            store.snapshot.board.banks[0].buttons[0]
                .effect_id
                .as_deref(),
            Some(effect.id.as_str())
        );
        assert!(std::sync::Arc::ptr_eq(
            &pcm.samples,
            &store.pcm[&effect.id].samples
        ));
        assert_eq!(store.remaining(), budget);
        drop(store);
        let restarted = LibraryStore::open(root).unwrap();
        assert_eq!(restarted.snapshot.effects[0].availability, "available");
        assert!(restarted.pcm.contains_key(&effect.id));
    }
}

#[cfg(unix)]
#[test]
fn duplicate_recovery_leaves_unexpected_old_symlink_and_target_untouched() {
    let temp = crate::test_support::tempdir().unwrap();
    let root = temp.path().join("data");
    let source = fixture(temp.path(), "tone.wav", WAV);
    let target = fixture(temp.path(), "ajeno.wav", b"ajeno");
    let mut store = LibraryStore::open(root.clone()).unwrap();
    let id = store.import_paths(vec![source.clone()]).imported[0]
        .effect
        .id
        .clone();
    let old = root.join(&store.assets[&id].0);
    fs::remove_file(&old).unwrap();
    std::os::unix::fs::symlink(&target, &old).unwrap();
    let result = store.import_paths(vec![source.clone()]);
    assert!(result.failed.is_empty());
    assert_eq!(result.imported[0].effect.availability, "available");
    assert_eq!(result.imported[0].effect.id, id);
    assert!(fs::symlink_metadata(old).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(target).unwrap(), b"ajeno");
    assert_eq!(fs::read(source).unwrap(), WAV);
}

#[test]
fn failed_duplicate_recovery_reports_failure_cleans_only_new_copy_and_preserves_old_data() {
    let temp = crate::test_support::tempdir().unwrap();
    let root = temp.path().join("data");
    let source = fixture(temp.path(), "tone.wav", WAV);
    let mut store = LibraryStore::open(root.clone()).unwrap();
    let id = store.import_paths(vec![source.clone()]).imported[0]
        .effect
        .id
        .clone();
    let old = store.assets[&id].0.clone();
    fs::write(root.join(&old), b"ajeno").unwrap();
    store.connection.execute_batch("CREATE TRIGGER reject_recovery BEFORE UPDATE ON sound_effects BEGIN SELECT RAISE(ABORT,'simulated recovery failure'); END;").unwrap();
    let result = store.import_paths(vec![source.clone()]);
    assert_eq!(result.failed.len(), 1);
    assert!(result.imported.is_empty());
    assert_eq!(result.snapshot.effects[0].availability, "invalid");
    assert_eq!(store.assets[&id].0, old);
    assert_eq!(fs::read(root.join(&old)).unwrap(), b"ajeno");
    assert_eq!(fs::read_dir(root.join("audio")).unwrap().count(), 1);
    assert_eq!(fs::read(source).unwrap(), WAV);
}

#[test]
fn healthy_duplicate_is_reused_without_copying_or_updating_its_sql_record() {
    let temp = crate::test_support::tempdir().unwrap();
    let root = temp.path().join("data");
    let source = fixture(temp.path(), "tone.wav", WAV);
    let mut store = LibraryStore::open(root.clone()).unwrap();
    let id = store.import_paths(vec![source.clone()]).imported[0]
        .effect
        .id
        .clone();
    let original_path = store.assets[&id].0.clone();
    store.connection.execute_batch("CREATE TRIGGER no_rewrite BEFORE UPDATE ON sound_effects BEGIN SELECT RAISE(ABORT,'unexpected rewrite'); END;").unwrap();
    let result = store.import_paths(vec![source]);
    assert!(result.failed.is_empty());
    assert!(result.imported[0].duplicate);
    assert_eq!(result.imported[0].effect.id, id);
    assert_eq!(store.assets[&id].0, original_path);
    assert_eq!(fs::read_dir(root.join("audio")).unwrap().count(), 1);
}

#[test]
fn hash_reload_retires_old_pinned_pcm_and_never_reuses_it_for_changed_bytes() {
    let temp = crate::test_support::tempdir().unwrap();
    let root = temp.path().join("data");
    let source = fixture(temp.path(), "tone.wav", WAV);
    let mut store = LibraryStore::open(root.clone()).unwrap();
    let id = store.import_paths(vec![source]).imported[0]
        .effect
        .id
        .clone();
    let old = store.pcm[&id].clone();
    let bytes = wave(1, 8000, 800);
    let name = format!("audio/{}.bin", uuid::Uuid::new_v4());
    fs::write(root.join(&name), &bytes).unwrap();
    store.connection.execute("UPDATE sound_effects SET path=?,hash=?,channels=1,sample_rate=8000,duration_ms=100,byte_size=? WHERE id=?",params![name,digest(&bytes),bytes.len() as i64,id]).unwrap();
    store.refresh_availability().unwrap();
    assert!(!std::sync::Arc::ptr_eq(
        &old.samples,
        &store.pcm[&id].samples
    ));
    assert_eq!(store.retired.len(), 1);
    assert_eq!(
        store.remaining(),
        CACHE_LIMIT - old.samples.len() * 4 - store.pcm[&id].samples.len() * 4
    );
    drop(old);
    store.refresh_availability().unwrap();
    assert!(store.retired.is_empty());
}
