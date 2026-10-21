//! Formato 1: {format:"radiofx-bank",formatVersion:1,banks:SoundBank[],
//! resources:{hash,name,format,defaultVolume}[],keyboardShortcuts?:ShortcutBinding[]}.
//! effectId referencia el hash del recurso; durationMs nunca prevalece sobre el decoder.
//! IDs de bancos, asignaciones y atajos son locales al paquete y se remapean al confirmar.
use super::*;
use crate::infrastructure::bank_archive::{self, PACKAGE_LIMIT};
use serde::{Deserialize, Serialize};
use std::{
    ops::Range,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

static IMPORT_PENDING: AtomicBool = AtomicBool::new(false);
const PACKAGE_FORMAT_VERSION: u32 = 1;
struct ImportLease;
impl ImportLease {
    fn acquire() -> Result<Self, AudioError> {
        IMPORT_PENDING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| failure("Ya existe una preparacion pendiente en este proceso."))?;
        Ok(Self)
    }
}
impl Drop for ImportLease {
    fn drop(&mut self) {
        IMPORT_PENDING.store(false, Ordering::Release);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    format_version: u32,
    banks: Vec<SoundBank>,
    resources: Vec<Resource>,
    #[serde(default)]
    keyboard_shortcuts: Vec<ShortcutBinding>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resource {
    hash: String,
    name: String,
    format: String,
    default_volume: f32,
}

pub(super) struct PendingImport {
    _lease: ImportLease,
    token: String,
    created: Instant,
    manifest: Manifest,
    bytes: Vec<u8>,
    entries: HashMap<String, Range<usize>>,
    pub(super) pcm: HashMap<String, PreparedPcm>,
}

impl LibraryStore {
    /// Caducidad perezosa: cada comando de biblioteca libera la unica preparacion a los diez minutos.
    pub fn expire_import(&mut self) {
        if self
            .pending_import
            .as_ref()
            .is_some_and(|p| p.created.elapsed() >= Duration::from_secs(600))
        {
            self.pending_import = None;
        }
    }

    /// Cancela solo el token vigente; no confirma datos ni elimina archivos ajenos.
    pub fn cancel_bank_import(&mut self, token: &str) -> Result<(), AudioError> {
        self.expire_import();
        if self
            .pending_import
            .as_ref()
            .is_none_or(|p| p.token != token)
        {
            return Err(failure("La preparacion no existe o ha caducado."));
        }
        self.pending_import = None;
        Ok(())
    }

    /// Lee unicamente la ruta elegida por el selector Rust, sin otorgar acceso persistente a su original.
    pub fn prepare_bank_path(&mut self, path: &Path) -> Result<BankImportPreview, AudioError> {
        self.expire_import();
        if self.pending_import.is_some() {
            return Err(failure(
                "Cancele o confirme la preparacion pendiente antes de abrir otra.",
            ));
        }
        let bytes = filesystem::read_external(path, PACKAGE_LIMIT).map_err(failure)?;
        self.prepare_bank_bytes(bytes)
    }

    /// Verifica el paquete entero y decodifica contra el presupuesto libre antes de publicar el token.
    pub fn prepare_bank_bytes(&mut self, bytes: Vec<u8>) -> Result<BankImportPreview, AudioError> {
        self.expire_import();
        if self.pending_import.is_some() {
            return Err(failure(
                "Cancele o confirme la preparacion pendiente antes de abrir otra.",
            ));
        }
        let lease = ImportLease::acquire()?;
        self.reload()?;
        let entries = bank_archive::inspect(&bytes)?;
        let range = entries
            .get("manifest.json")
            .ok_or_else(|| failure("Falta manifest.json."))?;
        let manifest: Manifest = serde_json::from_slice(&bytes[range.clone()]).map_err(failure)?;
        if manifest.format != "radiofx-bank"
            || manifest.format_version != PACKAGE_FORMAT_VERSION
            || manifest.resources.len() > 256
            || entries.len() != manifest.resources.len() + 1
        {
            return Err(failure("Version o recursos de paquete invalidos."));
        }
        let mut pcm = HashMap::new();
        let mut effects = Vec::new();
        let mut used = 0;
        for resource in &manifest.resources {
            validate_volume(resource.default_volume)?;
            if resource.name.trim().is_empty()
                || resource.name.chars().count() > 100
                || resource.name.chars().any(char::is_control)
            {
                return Err(failure("Nombre de recurso invalido."));
            }
            let name = format!("audio/{}.{}", resource.hash, resource.format);
            let range = entries
                .get(&name)
                .ok_or_else(|| failure("Falta un recurso declarado."))?;
            if !bank_archive::valid_name(&name)
                || pcm.contains_key(&resource.hash)
                || digest(&bytes[range.clone()]) != resource.hash
            {
                return Err(failure("Hash o recurso duplicado invalido."));
            }
            let decoded = if let Some(known) =
                self.known_pcm(&resource.hash, &resource.format, range.len())
            {
                known.clone()
            } else {
                let decoded = decode(
                    bytes[range.clone()].to_vec(),
                    &resource.format,
                    self.remaining().saturating_sub(used),
                )?;
                used += decoded.samples.len() * 4;
                decoded
            };
            effects.push(LibraryEffect {
                id: resource.hash.clone(),
                name: resource.name.clone(),
                duration_ms: decoded.samples.len() as u64 * 1000
                    / u64::from(decoded.channels)
                    / u64::from(decoded.sample_rate),
                format: resource.format.clone(),
                sample_rate: decoded.sample_rate,
                channels: decoded.channels,
                byte_size: range.len() as u64,
                default_volume: resource.default_volume,
                availability: "available".into(),
                error: None,
            });
            pcm.insert(resource.hash.clone(), decoded);
        }
        let board = BoardSnapshot {
            version: BOARD_VERSION,
            banks: manifest.banks.clone(),
            active_bank_id: manifest
                .banks
                .first()
                .map_or_else(String::new, |b| b.id.clone()),
            keyboard_shortcuts: manifest.keyboard_shortcuts.clone(),
        };
        Self::validate_board(&board, &effects)?;
        let token = uuid::Uuid::new_v4().to_string();
        let preview = BankImportPreview {
            token: token.clone(),
            bank_names: manifest.banks.iter().map(|b| b.name.clone()).collect(),
            effect_count: manifest.resources.len(),
            button_count: manifest.banks.iter().map(|b| b.buttons.len()).sum(),
            shortcut_count: manifest.keyboard_shortcuts.len(),
            warnings: vec![
                "Los atajos importados permanecen deshabilitados salvo confirmacion expresa."
                    .into(),
            ],
        };
        self.pending_import = Some(PendingImport {
            _lease: lease,
            token,
            created: Instant::now(),
            manifest,
            bytes,
            entries,
            pcm,
        });
        Ok(preview)
    }

    /// Confirma recursos y tablero en una sola transaccion; una revision obsoleta no consume el token.
    /// Tras aceptar el token se consume incluso ante fallo: recargar ante errores parciales, nunca reimportar a ciegas.
    pub fn commit_bank_import(
        &mut self,
        token: &str,
        revision: u64,
        enable_shortcuts: bool,
    ) -> Result<BankImportCommitResult, AudioError> {
        self.expire_import();
        self.reload()?;
        if self.snapshot.revision != revision {
            return Err(AudioError::new(
                "revision_conflict",
                "El tablero cambio. Recargue antes de confirmar.",
            ));
        }
        if self
            .pending_import
            .as_ref()
            .is_none_or(|p| p.token != token)
        {
            return Err(failure("La preparacion no existe o ha caducado."));
        }
        let pending = self
            .pending_import
            .take()
            .ok_or_else(|| failure("Preparacion ausente."))?;
        let mut board = self.snapshot.board.clone();
        let mut effects = self.snapshot.effects.clone();
        let mut mapping = HashMap::new();
        let mut files = Vec::new();
        let mut resources = Vec::new();
        let mut warnings = Vec::new();
        let mut reused = 0;
        for resource in &pending.manifest.resources {
            let existing = self
                .assets
                .iter()
                .find(|(_, (_, hash))| hash == &resource.hash)
                .map(|(id, _)| id.clone());
            let id = existing
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let range = pending
                .entries
                .get(&format!("audio/{}.{}", resource.hash, resource.format))
                .ok_or_else(|| failure("Recurso ausente."))?;
            let pcm = &pending.pcm[&resource.hash];
            let usable = existing
                .as_ref()
                .and_then(|id| self.assets.get(id))
                .is_some_and(|(path, hash)| {
                    self.read_managed(path)
                        .is_ok_and(|bytes| digest(&bytes) == *hash)
                });
            let relative = if usable {
                self.assets[&id].0.clone()
            } else {
                let audio = self.directory.open_dir_nofollow("audio").map_err(failure)?;
                let owned =
                    NewAudio::create(&audio, &pending.bytes[range.clone()]).map_err(failure)?;
                let relative = format!("audio/{}", owned.name());
                files.push(owned);
                relative
            };
            if let Some(previous) = effects.iter().find(|e| e.id == id) {
                reused += 1;
                if previous.default_volume != resource.default_volume
                    || previous.name != resource.name
                {
                    warnings.push("Un duplicado conserva su nombre y volumen locales.".into());
                }
                if previous.format != resource.format {
                    return Err(failure("Formato del duplicado inconsistente."));
                }
            } else {
                effects.push(LibraryEffect {
                    id: id.clone(),
                    name: resource.name.clone(),
                    duration_ms: pcm.samples.len() as u64 * 1000
                        / u64::from(pcm.channels)
                        / u64::from(pcm.sample_rate),
                    format: resource.format.clone(),
                    sample_rate: pcm.sample_rate,
                    channels: pcm.channels,
                    byte_size: range.len() as u64,
                    default_volume: resource.default_volume,
                    availability: "available".into(),
                    error: None,
                });
            }
            resources.push((id.clone(), relative, resource, existing.is_some()));
            mapping.insert(resource.hash.clone(), id);
        }
        if effects.len() > 4096 {
            return Err(failure("La biblioteca supera 4096 recursos."));
        }
        let mut ids = HashMap::new();
        let mut imported_bank_ids = Vec::new();
        for bank in &pending.manifest.banks {
            let mut bank = bank.clone();
            let id = uuid::Uuid::new_v4().to_string();
            ids.insert(bank.id.clone(), id.clone());
            bank.id = id.clone();
            imported_bank_ids.push(id);
            for button in &mut bank.buttons {
                let id = uuid::Uuid::new_v4().to_string();
                ids.insert(button.id.clone(), id.clone());
                button.id = id;
                if let Some(effect) = &button.effect_id {
                    button.effect_id = Some(mapping[effect].clone());
                }
            }
            board.banks.push(bank);
        }
        for shortcut in &pending.manifest.keyboard_shortcuts {
            let mut shortcut = shortcut.clone();
            shortcut.id = uuid::Uuid::new_v4().to_string();
            shortcut.enabled &= enable_shortcuts;
            shortcut.scope_bank_id = shortcut.scope_bank_id.map(|id| ids[&id].clone());
            shortcut.action.target_id = shortcut.action.target_id.map(|id| ids[&id].clone());
            board.keyboard_shortcuts.push(shortcut);
        }
        Self::validate_board(&board, &effects)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(failure)?;
        for (id, path, resource, existing) in &resources {
            let effect = effects
                .iter()
                .find(|e| &e.id == id)
                .ok_or_else(|| failure("Recurso inconsistente."))?;
            if *existing {
                tx.execute(
                    "UPDATE sound_effects SET path=? WHERE id=? AND hash=?",
                    params![path, id, resource.hash],
                )
                .map_err(failure)?;
            } else {
                tx.execute("INSERT INTO sound_effects(id,name,path,hash,duration_ms,format,sample_rate,channels,byte_size,default_volume) VALUES (?,?,?,?,?,?,?,?,?,?)",params![id,effect.name,path,resource.hash,effect.duration_ms as i64,effect.format,effect.sample_rate,effect.channels,effect.byte_size as i64,effect.default_volume]).map_err(failure)?;
            }
        }
        Self::write_board(&tx, &board, revision)?;
        tx.commit().map_err(failure)?;
        // Desde aqui los archivos pertenecen al catalogo, aun si falla recarga/registro posterior.
        for file in files {
            file.commit();
        }
        for (id, _, resource, _) in resources {
            let range = &pending.entries[&format!("audio/{}.{}", resource.hash, resource.format)];
            let pcm = self
                .known_pcm(&resource.hash, &resource.format, range.len())
                .cloned()
                .unwrap_or_else(|| pending.pcm[&resource.hash].clone());
            if self.pcm.get(&id).is_none_or(|current| {
                !std::sync::Arc::ptr_eq(&current.samples, &pcm.samples)
                    || current.channels != pcm.channels
                    || current.sample_rate != pcm.sample_rate
            }) && let Some(old) = self.pcm.insert(id.clone(), pcm)
            {
                self.retired.push(old);
            }
            self.pcm_hashes
                .insert(id, (resource.hash.clone(), resource.format.clone()));
        }
        self.reload().map_err(|e| {
            AudioError::new(
                "library_partial_failure",
                format!(
                    "El paquete ya fue confirmado. Recargue la biblioteca: {}",
                    e.message
                ),
            )
        })?;
        Ok(BankImportCommitResult {
            snapshot: self.snapshot.clone(),
            imported_bank_ids,
            reused_effects: reused,
            warnings,
        })
    }

    /// Captura tablero coherente y bytes verificados; nunca exporta ajustes, rutas ni senales diagnosticas.
    pub fn export_bank_bytes(
        &mut self,
        bank_ids: &[String],
        revision: u64,
        include_shortcuts: bool,
    ) -> Result<(Vec<u8>, usize, usize), AudioError> {
        self.expire_import();
        self.reload()?;
        if self.snapshot.revision != revision {
            return Err(AudioError::new(
                "revision_conflict",
                "El tablero cambio. Recargue antes de exportar.",
            ));
        }
        let ids: HashSet<_> = bank_ids.iter().collect();
        if bank_ids.is_empty() || ids.len() != bank_ids.len() || ids.len() > 100 {
            return Err(failure("Seleccion de bancos invalida."));
        }
        let mut banks = self
            .snapshot
            .board
            .banks
            .iter()
            .filter(|b| ids.contains(&b.id))
            .cloned()
            .collect::<Vec<_>>();
        if banks.len() != ids.len() {
            return Err(failure("Banco desconocido."));
        }
        let effects: HashSet<_> = banks
            .iter()
            .flat_map(|b| &b.buttons)
            .filter_map(|b| b.effect_id.clone())
            .collect();
        if effects.len() > 256 {
            return Err(failure("El paquete admite hasta 256 recursos unicos."));
        }
        let mut resources = Vec::new();
        let mut entries = Vec::new();
        let mut mapping = HashMap::new();
        let mut total = 0usize;
        for id in &effects {
            let effect = self
                .snapshot
                .effects
                .iter()
                .find(|e| &e.id == id)
                .ok_or_else(|| failure("Recurso desconocido."))?;
            let (path, hash) = &self.assets[id];
            let bytes = self.read_managed(path)?;
            if digest(&bytes) != *hash {
                return Err(failure("Un recurso fue modificado; no se exporto."));
            }
            total = total
                .checked_add(bytes.len())
                .ok_or_else(|| failure("Paquete excesivo."))?;
            if total > PACKAGE_LIMIT - 3 * 1024 * 1024 {
                return Err(failure("El paquete supera el limite de 256 MiB."));
            }
            entries.push((format!("audio/{hash}.{}", effect.format), bytes));
            mapping.insert(id.clone(), hash.clone());
            resources.push(Resource {
                hash: hash.clone(),
                name: effect.name.clone(),
                format: effect.format.clone(),
                default_volume: effect.default_volume,
            });
        }
        let buttons: HashSet<_> = banks
            .iter()
            .flat_map(|b| b.buttons.iter().map(|v| v.id.clone()))
            .collect();
        let shortcuts = if include_shortcuts {
            self.snapshot
                .board
                .keyboard_shortcuts
                .iter()
                .filter(|s| {
                    s.scope_bank_id.as_ref().is_none_or(|id| ids.contains(id))
                        && match s.action.kind {
                            ShortcutKind::StopAll => true,
                            ShortcutKind::SelectBank => s
                                .action
                                .target_id
                                .as_ref()
                                .is_some_and(|id| ids.contains(id)),
                            ShortcutKind::PlayButton => s
                                .action
                                .target_id
                                .as_ref()
                                .is_some_and(|id| buttons.contains(id)),
                        }
                })
                .cloned()
                .collect()
        } else {
            vec![]
        };
        for bank in &mut banks {
            for button in &mut bank.buttons {
                if let Some(id) = &button.effect_id {
                    button.effect_id = Some(mapping[id].clone());
                }
            }
        }
        let count = banks.len();
        let effect_count = resources.len();
        let manifest = serde_json::to_vec(&Manifest {
            format: "radiofx-bank".into(),
            format_version: PACKAGE_FORMAT_VERSION,
            banks,
            resources,
            keyboard_shortcuts: shortcuts,
        })
        .map_err(failure)?;
        if manifest.len() > bank_archive::MANIFEST_LIMIT {
            return Err(failure("El manifiesto supera 2 MiB."));
        }
        entries.insert(0, ("manifest.json".into(), manifest));
        Ok((bank_archive::encode(entries)?, count, effect_count))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::audio::PlaybackOptions;

    /// Construye paquetes con cuatro codecs reales y referencias internas, sin dialogos ni hardware.
    fn package() -> Vec<u8> {
        let mut resources = Vec::new();
        let mut buttons = Vec::new();
        let mut entries = Vec::new();
        for (index, (format, bytes)) in [
            (
                "wav",
                include_bytes!("../../../tests/fixtures/tone.wav").as_slice(),
            ),
            (
                "mp3",
                include_bytes!("../../../tests/fixtures/tone.mp3").as_slice(),
            ),
            (
                "ogg",
                include_bytes!("../../../tests/fixtures/tone.ogg").as_slice(),
            ),
            (
                "flac",
                include_bytes!("../../../tests/fixtures/tone.flac").as_slice(),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let hash = digest(bytes);
            resources.push(Resource {
                hash: hash.clone(),
                name: format!("Recurso {index}"),
                format: format.into(),
                default_volume: 0.4,
            });
            buttons.push(SoundButton {
                id: format!("button-{index}"),
                effect_id: Some(hash.clone()),
                name: format!("Boton {index}"),
                duration_ms: u64::MAX,
                color: "mint".into(),
                category: "Radio".into(),
                playback: PlaybackOptions {
                    looped: true,
                    fade_in_ms: 10,
                    fade_out_ms: 25,
                },
            });
            entries.push((format!("audio/{hash}.{format}"), bytes.to_vec()));
        }
        let manifest = Manifest {
            format: "radiofx-bank".into(),
            format_version: 1,
            banks: vec![SoundBank {
                id: "bank".into(),
                name: "Programa".into(),
                buttons,
            }],
            resources,
            keyboard_shortcuts: vec![ShortcutBinding {
                id: "shortcut".into(),
                scope: ShortcutScope::Bank,
                scope_bank_id: Some("bank".into()),
                chord: KeyChord {
                    code: "KeyA".into(),
                    ctrl: false,
                    alt: false,
                    shift: false,
                    meta: false,
                },
                action: ShortcutAction {
                    kind: ShortcutKind::PlayButton,
                    target_id: Some("button-0".into()),
                },
                enabled: true,
            }],
        };
        entries.insert(
            0,
            (
                "manifest.json".into(),
                serde_json::to_vec(&manifest).unwrap(),
            ),
        );
        bank_archive::encode(entries).unwrap()
    }

    /// Empaqueta un recurso real para aislar duplicados y cambios de hash sin grandes asignaciones.
    fn single_package(bytes: &[u8]) -> Vec<u8> {
        let hash = digest(bytes);
        let manifest = Manifest {
            format: "radiofx-bank".into(),
            format_version: PACKAGE_FORMAT_VERSION,
            banks: vec![SoundBank {
                id: "bank".into(),
                name: "Radio".into(),
                buttons: vec![SoundButton {
                    id: "button".into(),
                    effect_id: Some(hash.clone()),
                    name: "Audio".into(),
                    duration_ms: 0,
                    color: "mint".into(),
                    category: String::new(),
                    playback: PlaybackOptions::default(),
                }],
            }],
            resources: vec![Resource {
                hash: hash.clone(),
                name: "Audio".into(),
                format: "wav".into(),
                default_volume: 0.5,
            }],
            keyboard_shortcuts: vec![],
        };
        bank_archive::encode(vec![
            (
                "manifest.json".into(),
                serde_json::to_vec(&manifest).unwrap(),
            ),
            (format!("audio/{hash}.wav"), bytes.to_vec()),
        ])
        .unwrap()
    }

    #[test]
    fn duplicate_previews_and_commits_preserve_pcm_with_no_extra_budget() {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let mut store = LibraryStore::open(temp.path().join("data")).unwrap();
        let bytes = include_bytes!("../../../tests/fixtures/tone.wav");
        let preview = store.prepare_bank_bytes(single_package(bytes)).unwrap();
        store.commit_bank_import(&preview.token, 0, false).unwrap();
        let id = store.snapshot.effects[0].id.clone();
        let original = store.pcm[&id].clone();
        // Margen equivalente a una biblioteca de 20 MiB casi llena, sin asignar 20 MiB en el test.
        store.pcm_budget = original.samples.len() * 4 + 1;
        for commit in [false, true] {
            let preview = store.prepare_bank_bytes(single_package(bytes)).unwrap();
            assert_eq!(store.remaining(), 1);
            assert!(std::sync::Arc::ptr_eq(
                &original.samples,
                &store.pending_import.as_ref().unwrap().pcm[&digest(bytes)].samples
            ));
            if commit {
                let result = store.commit_bank_import(&preview.token, 1, false).unwrap();
                assert_eq!(result.reused_effects, 1);
                assert_eq!(result.snapshot.board.banks.len(), 3);
            } else {
                store.cancel_bank_import(&preview.token).unwrap();
            }
            assert!(std::sync::Arc::ptr_eq(
                &original.samples,
                &store.pcm[&id].samples
            ));
            assert_eq!(store.remaining(), 1);
            assert!(store.retired.is_empty());
        }
        let mut changed = bytes.to_vec();
        *changed.last_mut().unwrap() ^= 1;
        assert_eq!(
            store
                .prepare_bank_bytes(single_package(&changed))
                .unwrap_err()
                .code,
            "pcm_budget"
        );
        assert_eq!(store.remaining(), 1);
    }

    #[test]
    fn pending_shared_pcm_is_counted_once_when_missing_retired_and_released() {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let root = temp.path().join("data");
        let mut store = LibraryStore::open(root.clone()).unwrap();
        let bytes = include_bytes!("../../../tests/fixtures/tone.wav");
        let preview = store.prepare_bank_bytes(single_package(bytes)).unwrap();
        store.commit_bank_import(&preview.token, 0, false).unwrap();
        let id = store.snapshot.effects[0].id.clone();
        let size = store.pcm[&id].samples.len() * 4;
        let pointer = store.pcm[&id].samples.as_ptr();
        store.pcm_budget = 2 * 1024 * 1024 + size * 3;
        let before = store.remaining();
        let preview = store.prepare_bank_bytes(single_package(bytes)).unwrap();
        fs::remove_file(root.join(&store.assets[&id].0)).unwrap();
        store.refresh_availability().unwrap();
        assert_eq!(store.snapshot.effects[0].availability, "missing");
        assert_eq!(store.remaining(), before);
        let mut changed = bytes.to_vec();
        *changed.last_mut().unwrap() ^= 1;
        let path = format!("audio/{}.bin", uuid::Uuid::new_v4());
        fs::write(root.join(&path), &changed).unwrap();
        store
            .connection
            .execute(
                "UPDATE sound_effects SET path=?,hash=? WHERE id=?",
                params![path, digest(&changed), id],
            )
            .unwrap();
        store.refresh_availability().unwrap();
        assert_eq!(store.snapshot.effects[0].availability, "available");
        assert!(
            store
                .retired
                .iter()
                .any(|pcm| pcm.samples.as_ptr() == pointer)
        );
        assert_eq!(store.remaining(), before - size);
        store.cancel_bank_import(&preview.token).unwrap();
        store.refresh_availability().unwrap();
        assert!(store.retired.is_empty());
        assert_eq!(store.remaining(), before);
    }

    #[test]
    fn mixed_staging_charges_new_allocations_and_blocks_imports_until_cancelled() {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let mut store = LibraryStore::open(temp.path().join("data")).unwrap();
        let bytes = include_bytes!("../../../tests/fixtures/tone.wav");
        let preview = store.prepare_bank_bytes(single_package(bytes)).unwrap();
        store.commit_bank_import(&preview.token, 0, false).unwrap();
        let size = store.pcm.values().next().unwrap().samples.len() * 4;
        let before = store.remaining();
        let preview = store.prepare_bank_bytes(package()).unwrap();
        let new_bytes = store
            .pending_import
            .as_ref()
            .unwrap()
            .pcm
            .iter()
            .filter(|(hash, _)| **hash != digest(bytes))
            .map(|(_, pcm)| pcm.samples.len() * 4)
            .sum::<usize>();
        assert_eq!(before - store.remaining(), new_bytes);
        // El nuevo WAV necesita dos copias PCM y la reserva del decoder, no el tamano de otros codecs.
        let required = 2 * 1024 * 1024 + size * 2;
        store.pcm_budget = size + required;
        assert_eq!(store.remaining(), required.saturating_sub(new_bytes));
        let mut changed = bytes.to_vec();
        *changed.last_mut().unwrap() ^= 1;
        let path = temp.path().join("new.wav");
        fs::write(&path, changed).unwrap();
        assert_eq!(store.import_paths(vec![path.clone()]).failed.len(), 1);
        store.cancel_bank_import(&preview.token).unwrap();
        assert_eq!(store.remaining(), required);
        let result = store.import_paths(vec![path]);
        assert!(
            result.failed.is_empty(),
            "{}",
            serde_json::to_string(&result).unwrap()
        );
    }

    #[test]
    fn dedupe_never_trusts_mislabeled_pcm_or_modified_uploaded_bytes() {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for case in ["hash", "format", "metadata", "upload"] {
            let temp = crate::test_support::tempdir().unwrap();
            let mut store = LibraryStore::open(temp.path().join("data")).unwrap();
            let bytes = include_bytes!("../../../tests/fixtures/tone.wav");
            let preview = store.prepare_bank_bytes(single_package(bytes)).unwrap();
            store.commit_bank_import(&preview.token, 0, false).unwrap();
            let id = store.snapshot.effects[0].id.clone();
            let pin = store.pcm[&id].clone();
            store.pcm_budget = pin.samples.len() * 4 + 1;
            let mut archive = single_package(bytes);
            match case {
                "hash" => store.pcm_hashes.get_mut(&id).unwrap().0 = "f".repeat(64),
                "format" => {
                    store
                        .connection
                        .execute("UPDATE sound_effects SET format='mp3' WHERE id=?", [&id])
                        .unwrap();
                }
                "metadata" => {
                    store
                        .connection
                        .execute(
                            "UPDATE sound_effects SET sample_rate=48000 WHERE id=?",
                            [&id],
                        )
                        .unwrap();
                }
                _ => {
                    let ranges = bank_archive::inspect(&archive).unwrap();
                    archive = bank_archive::encode(
                        ranges
                            .into_iter()
                            .map(|(name, range)| {
                                let mut data = archive[range].to_vec();
                                if name.starts_with("audio/") {
                                    *data.last_mut().unwrap() ^= 1;
                                }
                                (name, data)
                            })
                            .collect(),
                    )
                    .unwrap();
                }
            }
            assert!(store.prepare_bank_bytes(archive).is_err(), "{case}");
            assert!(store.pending_import.is_none());
            assert_eq!(store.remaining(), 1);
        }
    }

    #[test]
    fn roundtrip_four_formats_options_categories_remaps_ids_and_disables_shortcuts() {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let mut source = LibraryStore::open(temp.path().join("a")).unwrap();
        let preview = source.prepare_bank_bytes(package()).unwrap();
        assert_eq!(preview.effect_count, 4);
        assert_eq!(preview.shortcut_count, 1);
        assert!(source.snapshot.effects.is_empty());
        let first = source.commit_bank_import(&preview.token, 0, false).unwrap();
        assert_eq!(first.snapshot.revision, 1);
        assert_eq!(first.imported_bank_ids.len(), 1);
        let bank = &first.snapshot.board.banks[1];
        assert_ne!(bank.id, "bank");
        assert_eq!(bank.buttons[0].category, "Radio");
        assert!(bank.buttons[0].playback.looped);
        assert!(bank.buttons[0].duration_ms < 1000);
        assert!(!first.snapshot.board.keyboard_shortcuts[0].enabled);
        let (export, banks, effects) = source
            .export_bank_bytes(&first.imported_bank_ids, 1, true)
            .unwrap();
        assert_eq!((banks, effects), (1, 4));
        let mut target = LibraryStore::open(temp.path().join("b")).unwrap();
        let preview = target.prepare_bank_bytes(export).unwrap();
        let result = target.commit_bank_import(&preview.token, 0, true).unwrap();
        assert_eq!(result.snapshot.effects.len(), 4);
        assert!(!result.snapshot.board.keyboard_shortcuts[0].enabled);
        assert_ne!(result.imported_bank_ids, first.imported_bank_ids);
        for effect in &result.snapshot.effects {
            assert!(target.pcm.contains_key(&effect.id));
        }
    }

    #[test]
    fn deduplication_repairs_broken_files_preserves_local_defaults_and_old_bytes() {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for missing in [false, true] {
            let temp = crate::test_support::tempdir().unwrap();
            let root = temp.path().join("data");
            let mut store = LibraryStore::open(root.clone()).unwrap();
            let preview = store.prepare_bank_bytes(package()).unwrap();
            store.commit_bank_import(&preview.token, 0, false).unwrap();
            let id = store.snapshot.effects[0].id.clone();
            store.effect_volume(&id, 0.2).unwrap();
            let original = store.pcm[&id].clone();
            store.pcm_budget = store
                .pcm
                .values()
                .map(|pcm| pcm.samples.len() * 4)
                .sum::<usize>()
                + 1;
            let old = store.assets[&id].0.clone();
            if missing {
                fs::remove_file(root.join(&old)).unwrap();
            } else {
                fs::write(root.join(&old), b"ajeno").unwrap();
            }
            store.refresh_availability().unwrap();
            assert_eq!(
                store.snapshot.effects[0].availability,
                if missing { "missing" } else { "invalid" }
            );
            let preview = store.prepare_bank_bytes(package()).unwrap();
            let result = store.commit_bank_import(&preview.token, 1, false).unwrap();
            assert_eq!(result.reused_effects, 4);
            assert!(!result.warnings.is_empty());
            assert_eq!(
                store
                    .snapshot
                    .effects
                    .iter()
                    .find(|e| e.id == id)
                    .unwrap()
                    .default_volume,
                0.2
            );
            assert_ne!(store.assets[&id].0, old);
            assert!(std::sync::Arc::ptr_eq(
                &original.samples,
                &store.pcm[&id].samples
            ));
            assert_eq!(store.remaining(), 1);
            if missing {
                assert!(!root.join(old).exists());
            } else {
                assert_eq!(fs::read(root.join(old)).unwrap(), b"ajeno");
            }
        }
    }

    #[test]
    fn tokens_are_unique_single_pending_cancelled_expired_and_revision_conflicts_do_not_overwrite()
    {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let root = temp.path().join("data");
        let mut a = LibraryStore::open(root.clone()).unwrap();
        let free = a.remaining();
        let preview = a.prepare_bank_bytes(package()).unwrap();
        assert!(a.remaining() < free);
        let mut other = LibraryStore::open(temp.path().join("other")).unwrap();
        assert!(other.prepare_bank_bytes(package()).is_err());
        assert!(a.prepare_bank_bytes(package()).is_err());
        assert!(a.cancel_bank_import("wrong").is_err());
        a.cancel_bank_import(&preview.token).unwrap();
        assert_eq!(a.remaining(), free);
        let other_preview = other.prepare_bank_bytes(package()).unwrap();
        other.cancel_bank_import(&other_preview.token).unwrap();
        assert!(a.commit_bank_import(&preview.token, 0, false).is_err());
        let next = a.prepare_bank_bytes(package()).unwrap();
        assert_ne!(next.token, preview.token);
        a.pending_import.as_mut().unwrap().created = Instant::now() - Duration::from_secs(601);
        assert!(a.commit_bank_import(&next.token, 0, false).is_err());
        assert_eq!(a.remaining(), free);
        let preview = a.prepare_bank_bytes(package()).unwrap();
        let mut b = LibraryStore::open(root).unwrap();
        b.save_board(b.snapshot.board.clone(), 0).unwrap();
        assert_eq!(
            a.commit_bank_import(&preview.token, 0, false)
                .err()
                .unwrap()
                .code,
            "revision_conflict"
        );
        assert!(a.pending_import.is_some());
        assert!(a.snapshot.effects.is_empty());
        assert_eq!(a.snapshot.revision, 1);
    }

    #[test]
    fn staged_pcm_is_reserved_against_other_imports_and_released_on_cancel() {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let mut store = LibraryStore::open(temp.path().join("data")).unwrap();
        let free = store.remaining();
        let preview = store.prepare_bank_bytes(package()).unwrap();
        let used = free - store.remaining();
        store.pcm_budget = used + 2 * 1024 * 1024;
        let path = temp.path().join("tone.wav");
        fs::write(&path, include_bytes!("../../../tests/fixtures/tone.wav")).unwrap();
        assert_eq!(store.import_paths(vec![path.clone()]).failed.len(), 1);
        store.cancel_bank_import(&preview.token).unwrap();
        assert!(store.import_paths(vec![path]).failed.is_empty());
    }

    #[test]
    fn sql_commit_failure_rolls_back_all_resources_and_cleans_only_own_files() {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let root = temp.path().join("data");
        let mut store = LibraryStore::open(root.clone()).unwrap();
        fs::write(root.join("audio/keep.bin"), b"ajeno").unwrap();
        let preview = store.prepare_bank_bytes(package()).unwrap();
        store.connection.execute_batch("CREATE TRIGGER reject_commit AFTER UPDATE ON app_settings WHEN NEW.active_bank_id!='absent' BEGIN UPDATE app_settings SET active_bank_id='absent'; END;").unwrap();
        let error = store
            .commit_bank_import(&preview.token, 0, false)
            .err()
            .unwrap();
        assert!(error.message.contains("FOREIGN KEY"), "{error:?}");
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT board_revision,active_bank_id FROM app_settings",
                    [],
                    |row| Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
                )
                .unwrap(),
            (0, "principal".into())
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM sound_effects", [], |r| r
                    .get::<_, u32>(0))
                .unwrap(),
            0
        );
        assert_eq!(fs::read_dir(root.join("audio")).unwrap().count(), 1);
        assert_eq!(fs::read(root.join("audio/keep.bin")).unwrap(), b"ajeno");
    }

    #[test]
    fn post_commit_reload_failure_never_cleans_files_already_referenced_by_sqlite() {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let root = temp.path().join("data");
        let mut store = LibraryStore::open(root.clone()).unwrap();
        let preview = store.prepare_bank_bytes(package()).unwrap();
        store.connection.execute_batch("CREATE TRIGGER corrupt_reload AFTER UPDATE ON app_settings BEGIN INSERT INTO keyboard_shortcuts(id,binding) VALUES ('invalid-json','{'); END;").unwrap();
        assert_eq!(
            store
                .commit_bank_import(&preview.token, 0, false)
                .err()
                .unwrap()
                .code,
            "library_partial_failure"
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM sound_effects", [], |r| r
                    .get::<_, u32>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT board_revision FROM app_settings", [], |r| r
                    .get::<_, u32>(0))
                .unwrap(),
            1
        );
        assert_eq!(fs::read_dir(root.join("audio")).unwrap().count(), 4);
        let paths = store
            .connection
            .prepare("SELECT path FROM sound_effects")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for path in paths {
            assert!(!fs::read(root.join(path)).unwrap().is_empty());
        }
    }

    #[test]
    fn manifest_unknown_duplicate_fields_hash_last_invalid_and_real_duration_reject_before_any_write()
     {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let mut store = LibraryStore::open(temp.path().join("data")).unwrap();
        let original = package();
        let ranges = bank_archive::inspect(&original).unwrap();
        let manifest = &original[ranges["manifest.json"].clone()];
        for case in 0..6 {
            let mut entries = ranges
                .iter()
                .map(|(name, range)| (name.clone(), original[range.clone()].to_vec()))
                .collect::<Vec<_>>();
            let entry = entries
                .iter_mut()
                .find(|(name, _)| name == "manifest.json")
                .unwrap();
            let mut value: serde_json::Value = serde_json::from_slice(manifest).unwrap();
            match case {
                0 => value["unknown"] = serde_json::json!(true),
                1 => {
                    value["banks"][0]["buttons"][0]["playback"] =
                        serde_json::json!({"looped":false,"fadeInMs":30000,"fadeOutMs":30000})
                }
                2 => value["formatVersion"] = serde_json::json!(2),
                3 => value["resources"][3]["hash"] = serde_json::json!("f".repeat(64)),
                4 => value["banks"][0]["buttons"][0]["playback"]["other"] = serde_json::json!(0),
                _ => {}
            }
            entry.1 = if case == 5 {
                String::from_utf8(manifest.to_vec())
                    .unwrap()
                    .replacen(
                        "\"formatVersion\":1",
                        "\"formatVersion\":1,\"formatVersion\":1",
                        1,
                    )
                    .into_bytes()
            } else {
                serde_json::to_vec(&value).unwrap()
            };
            // El lector admite cualquier orden central coherente; el escritor construye las offsets.
            assert!(
                store
                    .prepare_bank_bytes(bank_archive::encode(entries).unwrap())
                    .is_err(),
                "{case}"
            );
            assert!(store.pending_import.is_none());
            assert!(store.snapshot.effects.is_empty());
        }
    }

    #[test]
    fn export_refuses_changed_resources_stale_revision_and_existing_destination_without_touching_bytes()
     {
        let _serial = PACKAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let root = temp.path().join("data");
        let mut store = LibraryStore::open(root.clone()).unwrap();
        let preview = store.prepare_bank_bytes(package()).unwrap();
        let result = store.commit_bank_import(&preview.token, 0, false).unwrap();
        assert!(
            store
                .export_bank_bytes(&result.imported_bank_ids, 0, true)
                .is_err()
        );
        let (bytes, _, _) = store
            .export_bank_bytes(&result.imported_bank_ids, 1, false)
            .unwrap();
        let destination = temp.path().join("bank.rfxbank");
        fs::write(&destination, b"no reemplazar").unwrap();
        assert!(filesystem::publish_new(&destination, &bytes).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"no reemplazar");
        let fresh = temp.path().join("fresh.rfxbank");
        filesystem::publish_new(&fresh, &bytes).unwrap();
        assert_eq!(fs::read(&fresh).unwrap(), bytes);
        let path = store.assets.values().next().unwrap().0.clone();
        fs::write(root.join(path), b"corrupto").unwrap();
        assert!(
            store
                .export_bank_bytes(&result.imported_bank_ids, 1, false)
                .is_err()
        );
    }
}
