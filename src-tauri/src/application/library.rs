use crate::{
    application::worker::{AudioService, Operation},
    domain::audio::{AudioError, NativeEffect},
    infrastructure::library::{LibraryStore, failure},
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub struct LibraryService {
    root: PathBuf,
    store: tokio::sync::OnceCell<Arc<Mutex<LibraryStore>>>,
    pub updates: tokio::sync::Mutex<()>,
    pub package_exports: tokio::sync::Mutex<()>,
}

impl LibraryService {
    /// Indica disponibilidad sin esperar cargas: un disparo nunca queda pendiente del decoder.
    pub fn is_ready(&self) -> bool {
        self.store.get().is_some()
    }
    /// Conserva la ruta autorizada sin tocar disco ni abrir dispositivos durante setup.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            store: tokio::sync::OnceCell::new(),
            updates: tokio::sync::Mutex::new(()),
            package_exports: tokio::sync::Mutex::new(()),
        }
    }

    /// Inicializa una sola vez fuera de UI/audio; comunica errores sin crear una biblioteca vacía ficticia.
    pub async fn initialize(
        &self,
        audio: &AudioService,
    ) -> Result<Arc<Mutex<LibraryStore>>, AudioError> {
        self.store
            .get_or_try_init(|| async {
                let root = self.root.clone();
                let store = tauri::async_runtime::spawn_blocking(move || LibraryStore::open(root))
                    .await
                    .map_err(failure)??;
                let settings = store.snapshot.settings.clone();
                let entries = store
                    .snapshot
                    .effects
                    .iter()
                    .map(|effect| {
                        (
                            NativeEffect {
                                effect_id: effect.id.clone(),
                                name: effect.name.clone(),
                                duration_ms: effect.duration_ms as u32,
                                default_volume: effect.default_volume,
                            },
                            (effect.availability == "available")
                                .then(|| store.pcm.get(&effect.id).cloned())
                                .flatten(),
                        )
                    })
                    .collect();
                audio
                    .request(Operation::Initialize(
                        entries,
                        settings.master_volume,
                        settings.max_concurrent_playbacks,
                        store.diagnostic_volumes.clone(),
                    ))
                    .await?;
                Ok(Arc::new(Mutex::new(store)))
            })
            .await
            .cloned()
    }

    /// Ejecuta SQLite/importación en blocking pool, serializado por el mutex exclusivo del almacén.
    pub async fn access<T, F>(&self, audio: &AudioService, operation: F) -> Result<T, AudioError>
    where
        T: Send + 'static,
        F: FnOnce(&mut LibraryStore) -> Result<T, AudioError> + Send + 'static,
    {
        let store = self.initialize(audio).await?;
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = store
                .lock()
                .map_err(|_| failure("Almacen bloqueado por un fallo anterior."))?;
            guard.expire_import();
            operation(&mut guard)
        })
        .await
        .map_err(failure)?
    }

    /// Registra handles e invalida caches obsoletas sin reproducir ni rearmar STOP ALL.
    /// Un segundo pase acotado permite decodificar con los pins ociosos ya liberados por el worker.
    pub async fn synchronize(&self, audio: &AudioService) -> Result<(), AudioError> {
        let _guard = self.updates.lock().await;
        for _ in 0..2 {
            let (entries, retry) = self
                .access(audio, |store| {
                    let retry = store.refresh_availability()?;
                    let entries = store
                        .snapshot
                        .effects
                        .iter()
                        .map(|effect| {
                            (
                                NativeEffect {
                                    effect_id: effect.id.clone(),
                                    name: effect.name.clone(),
                                    duration_ms: effect.duration_ms as u32,
                                    default_volume: effect.default_volume,
                                },
                                (effect.availability == "available")
                                    .then(|| store.pcm.get(&effect.id).cloned())
                                    .flatten(),
                            )
                        })
                        .collect();
                    Ok((entries, retry))
                })
                .await?;
            audio.request(Operation::Register(entries)).await?;
            if !retry {
                break;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::{engine::tests::FakeDriver, worker::Reply};
    use std::{fs, sync::mpsc, time::Duration};

    #[test]
    fn two_services_reconcile_sql_revision_new_catalog_and_preserve_cached_pcm_after_conflict() {
        let temp = crate::test_support::tempdir().unwrap();
        let root = temp.path().join("data");
        let source = temp.path().join("tone.wav");
        fs::write(&source, include_bytes!("../../tests/fixtures/tone.wav")).unwrap();
        let a = LibraryService::new(root.clone());
        let b = LibraryService::new(root);
        let audio_a = AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap();
        let audio_b = AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap();
        tauri::async_runtime::block_on(async {
            a.initialize(&audio_a).await.unwrap();
            b.initialize(&audio_b).await.unwrap();
            let stale = b
                .access(&audio_b, |store| Ok(store.snapshot.board.clone()))
                .await
                .unwrap();
            let id = a
                .access(&audio_a, move |store| {
                    let imported = store.import_paths(vec![source]);
                    let id = imported.imported[0].effect.id.clone();
                    let mut board = store.snapshot.board.clone();
                    board.banks[0].name = "Edicion A".into();
                    store.save_board(board, 0)?;
                    Ok(id)
                })
                .await
                .unwrap();
            assert_eq!(
                b.access(&audio_b, move |store| store.save_board(stale, 0))
                    .await
                    .unwrap_err()
                    .code,
                "revision_conflict"
            );
            b.synchronize(&audio_b).await.unwrap();
            let snapshot = b
                .access(&audio_b, |store| Ok(store.snapshot.clone()))
                .await
                .unwrap();
            assert_eq!(snapshot.revision, 1);
            assert_eq!(snapshot.board.banks[0].name, "Edicion A");
            assert_eq!(snapshot.effects[0].id, id);
            let Reply::Status(status) = audio_b.request(Operation::Status).await.unwrap() else {
                panic!("status")
            };
            assert!(status.effects.iter().any(|effect| effect.effect_id == id));
            let cached_id = id.clone();
            let cached = b
                .access(&audio_b, move |store| Ok(store.pcm[&cached_id].clone()))
                .await
                .unwrap();
            b.access(&audio_b, move |store| {
                let mut board = snapshot.board;
                board.banks.push(crate::domain::library::SoundBank {
                    id: "b".into(),
                    name: "Edicion B".into(),
                    buttons: vec![],
                });
                store.save_board(board, snapshot.revision)
            })
            .await
            .unwrap();
            a.synchronize(&audio_a).await.unwrap();
            let snapshot = a
                .access(&audio_a, |store| Ok(store.snapshot.clone()))
                .await
                .unwrap();
            assert_eq!(snapshot.revision, 2);
            assert_eq!(snapshot.board.banks[0].name, "Edicion A");
            assert_eq!(snapshot.board.banks[1].name, "Edicion B");
            b.synchronize(&audio_b).await.unwrap();
            let current = b
                .access(&audio_b, move |store| Ok(store.pcm[&id].clone()))
                .await
                .unwrap();
            assert!(Arc::ptr_eq(&cached.samples, &current.samples));
        });
        audio_a.shutdown();
        audio_b.shutdown();
    }

    #[test]
    fn repaired_duplicate_is_registered_and_playable_without_restarting_or_stopping_other_voices() {
        let temp = crate::test_support::tempdir().unwrap();
        let root = temp.path().join("data");
        let source = temp.path().join("tone.wav");
        fs::write(&source, include_bytes!("../../tests/fixtures/tone.wav")).unwrap();
        let library = LibraryService::new(root.clone());
        let audio = AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap();
        tauri::async_runtime::block_on(async {
            let source_copy = source.clone();
            let effect = library
                .access(&audio, move |store| {
                    Ok(store
                        .import_paths(vec![source_copy])
                        .imported
                        .remove(0)
                        .effect)
                })
                .await
                .unwrap();
            library.synchronize(&audio).await.unwrap();
            let Reply::Devices(devices) = audio.request(Operation::Devices).await.unwrap() else {
                panic!("devices")
            };
            audio
                .request(Operation::Select(devices[0].id.clone()))
                .await
                .unwrap();
            audio
                .request(Operation::Play(effect.id.clone()))
                .await
                .unwrap();
            fs::remove_file(root.join(format!("audio/{}.bin", effect.id))).unwrap();
            library.synchronize(&audio).await.unwrap();
            assert_eq!(
                audio
                    .request(Operation::Play(effect.id.clone()))
                    .await
                    .err()
                    .unwrap()
                    .code,
                "effect_unavailable"
            );
            let result = library
                .access(&audio, move |store| Ok(store.import_paths(vec![source])))
                .await
                .unwrap();
            assert!(result.failed.is_empty());
            assert_eq!(result.imported[0].effect.id, effect.id);
            assert!(result.imported[0].duplicate);
            library.synchronize(&audio).await.unwrap();
            audio.request(Operation::Play(effect.id)).await.unwrap();
            let Reply::Playbacks(voices) = audio.request(Operation::Playbacks).await.unwrap()
            else {
                panic!("voices")
            };
            assert_eq!(voices.len(), 2);
        });
        audio.shutdown();
    }

    #[test]
    fn startup_restores_settings_and_effect_defaults_but_never_opens_or_selects_output() {
        let directory = crate::test_support::tempdir().unwrap();
        let root = directory.path().join("data");
        let path = directory.path().join("tone.wav");
        fs::write(&path, include_bytes!("../../tests/fixtures/tone.wav")).unwrap();
        let mut store = LibraryStore::open(root.clone()).unwrap();
        let effect = store.import_paths(vec![path]).imported.remove(0).effect;
        let mut settings = store.snapshot.settings.clone();
        settings.master_volume = 0.3;
        settings.max_concurrent_playbacks = 3;
        settings.preferred_device_name = Some("Nombre duplicado".into());
        store
            .patch_settings(crate::infrastructure::library::Setting::Master(
                settings.master_volume,
            ))
            .unwrap();
        store
            .patch_settings(crate::infrastructure::library::Setting::Limit(
                settings.max_concurrent_playbacks,
            ))
            .unwrap();
        store
            .patch_settings(crate::infrastructure::library::Setting::PreferredDevice(
                settings.preferred_device_name,
            ))
            .unwrap();
        store.effect_volume(&effect.id, 0.9).unwrap();
        store.effect_volume("native-test-low", 0.2).unwrap();
        drop(store);
        tauri::async_runtime::block_on(async {
            let audio = AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap();
            let library = LibraryService::new(root);
            library.initialize(&audio).await.unwrap();
            let Reply::Status(status) = audio.request(Operation::Status).await.unwrap() else {
                panic!("status")
            };
            assert!(status.selected_device.is_none());
            assert_eq!(
                status.state,
                crate::domain::audio::EngineState::NotInitialized
            );
            assert_eq!(status.master_volume, 0.3);
            assert_eq!(status.max_concurrent_playbacks, 3);
            assert_eq!(
                status
                    .effects
                    .iter()
                    .find(|e| e.effect_id == effect.id)
                    .unwrap()
                    .default_volume,
                0.9
            );
            assert_eq!(
                status
                    .effects
                    .iter()
                    .find(|e| e.effect_id == "native-test-low")
                    .unwrap()
                    .default_volume,
                0.2
            );
            let Reply::Devices(devices) = audio.request(Operation::Devices).await.unwrap() else {
                panic!("devices")
            };
            assert_eq!(
                devices
                    .iter()
                    .filter(|device| device.name == "Nombre duplicado")
                    .count(),
                2
            );
            let Reply::Selected(selected) = audio.request(Operation::Selected).await.unwrap()
            else {
                panic!("selected")
            };
            assert!(selected.is_none());
            audio.shutdown();
        });
    }

    #[test]
    fn import_preparation_cannot_block_stop_or_route_change_and_late_registration_never_plays() {
        let directory = crate::test_support::tempdir().unwrap();
        let path = directory.path().join("tone.wav");
        fs::write(&path, include_bytes!("../../tests/fixtures/tone.wav")).unwrap();
        let audio =
            Arc::new(AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap());
        let library = Arc::new(LibraryService::new(directory.path().join("data")));
        tauri::async_runtime::block_on(async {
            library.initialize(&audio).await.unwrap();
            let Reply::Devices(devices) = audio.request(Operation::Devices).await.unwrap() else {
                panic!("devices")
            };
            audio
                .request(Operation::Select(devices[0].id.clone()))
                .await
                .unwrap();
            audio
                .request(Operation::Play("native-test-low".into()))
                .await
                .unwrap();
            let (entered, waiting) = mpsc::sync_channel(1);
            let (release, blocked) = mpsc::sync_channel(1);
            let loading_library = library.clone();
            let loading_audio = audio.clone();
            let loading = tauri::async_runtime::spawn(async move {
                loading_library
                    .access(&loading_audio, move |store| {
                        let imported = store.import_paths(vec![path]);
                        entered.send(()).unwrap();
                        blocked.recv_timeout(Duration::from_secs(5)).unwrap();
                        Ok(imported.imported[0].effect.id.clone())
                    })
                    .await
                    .unwrap()
            });
            waiting.recv_timeout(Duration::from_secs(5)).unwrap();
            audio.request(Operation::StopAll).await.unwrap();
            audio
                .request(Operation::Select(devices[1].id.clone()))
                .await
                .unwrap();
            release.send(()).unwrap();
            let id = loading.await.unwrap();
            library.synchronize(&audio).await.unwrap();
            let Reply::Status(status) = audio.request(Operation::Status).await.unwrap() else {
                panic!("status")
            };
            assert!(status.active_playbacks.is_empty());
            assert!(status.effects.iter().any(|effect| effect.effect_id == id));
            audio.request(Operation::Play(id.clone())).await.unwrap();
            audio.request(Operation::Play(id)).await.unwrap();
            let Reply::Playbacks(voices) = audio.request(Operation::Playbacks).await.unwrap()
            else {
                panic!("voices")
            };
            assert_eq!(voices.len(), 2);
            audio.request(Operation::StopAll).await.unwrap();
        });
        audio.shutdown();
    }

    #[test]
    fn future_database_returns_visible_error_without_fake_empty_snapshot() {
        let directory = crate::test_support::tempdir().unwrap();
        let root = directory.path().join("data");
        drop(LibraryStore::open(root.clone()).unwrap());
        let connection = rusqlite::Connection::open(root.join("library.sqlite3")).unwrap();
        connection.pragma_update(None, "user_version", 77).unwrap();
        let audio = AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap();
        let library = LibraryService::new(root);
        tauri::async_runtime::block_on(async {
            assert!(
                library
                    .access(&audio, |store| Ok(store.snapshot.clone()))
                    .await
                    .is_err()
            );
            assert!(
                library
                    .access(&audio, |store| Ok(store.snapshot.clone()))
                    .await
                    .is_err()
            );
            assert!(audio.request(Operation::StopAll).await.is_ok());
        });
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            77
        );
        audio.shutdown();
    }
}
