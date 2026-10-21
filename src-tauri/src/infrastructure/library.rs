//! Almacen exclusivo bajo app_data_dir: library.sqlite3 y audio/<UUID>.bin.
//! Maximo 4096 recursos; todos los disponibles se precargan, sin streaming ni referencias externas.
//! El PCM invalidado se retira y solo sigue presupuestado mientras conserve pins externos.
//! Los huerfanos de interrupciones no se eliminan: no se infiere propiedad de archivos inesperados.
//! Recuperar un duplicado roto publica otro UUID y conserva la entrada vieja sin borrarla ni sobrescribirla.
//! Las versiones PCM retiradas siguen presupuestadas hasta liberar los pins del motor y sus adaptaciones.

use super::decoder::{CACHE_LIMIT, FILE_LIMIT, decode};
use super::filesystem::{self, NewAudio};
use crate::domain::{
    audio::{AudioError, validate_volume},
    library::*,
};
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
};

const SCHEMA_VERSION: u32 = 2;

/// Traduce errores de infraestructura sin exponer rutas del almacén por IPC.
pub fn failure(error: impl std::fmt::Display) -> AudioError {
    AudioError::new(
        "library_error",
        format!("No se pudo completar la operacion de biblioteca: {error}"),
    )
}

/// Codifica SHA-256 sin depender de las implementaciones de formato del buffer Digest.
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Rechaza enlaces en cualquier componente existente, incluidos directorios antecesores.
fn reject_links(path: &Path) -> Result<(), AudioError> {
    for parent in path.ancestors() {
        if fs::symlink_metadata(parent)
            .map_err(failure)?
            .file_type()
            .is_symlink()
        {
            return Err(failure("No se admiten enlaces simbolicos."));
        }
    }
    Ok(())
}

/// Lee una entrada regular con un límite estricto, nunca referencias externas persistidas.
fn read_audio(path: &Path) -> Result<Vec<u8>, AudioError> {
    filesystem::read_external(path, FILE_LIMIT).map_err(failure)
}

pub enum Setting {
    Columns(String),
    Master(f32),
    Limit(u16),
    PreferredDevice(Option<String>),
}

pub struct LibraryStore {
    pub snapshot: LibrarySnapshot,
    pub pcm: HashMap<String, PreparedPcm>,
    pub diagnostic_volumes: Vec<(String, f32)>,
    connection: Connection,
    directory: Dir,
    assets: HashMap<String, (String, String)>,
    // Hash y formato verificados al decodificar; no se reconstruyen desde metadatos SQL posteriores.
    pcm_hashes: HashMap<String, (String, String)>,
    retired: Vec<PreparedPcm>,
    pending_import: Option<packages::PendingImport>,
    #[cfg(test)]
    pub(crate) pcm_budget: usize,
    #[cfg(test)]
    reload_hook: Option<Box<dyn FnOnce() + Send>>,
}

#[cfg(test)]
pub(crate) static PACKAGE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl LibraryStore {
    /// Abre únicamente el almacén gestionado; nunca reinicia esquemas desconocidos ni elimina huérfanos.
    pub fn open(root: PathBuf) -> Result<Self, AudioError> {
        let directory = filesystem::open_directory(&root, true).map_err(failure)?;
        let _audio = match directory.open_dir_nofollow("audio") {
            Ok(audio) => audio,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match directory.create_dir("audio") {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(failure(error)),
                }
                directory.open_dir_nofollow("audio").map_err(failure)?
            }
            Err(error) => return Err(failure(error)),
        };
        let db = root.join("library.sqlite3");
        if fs::symlink_metadata(&db).is_ok() {
            reject_links(&db)?;
        }
        for suffix in ["-journal", "-wal", "-shm"] {
            let sidecar = root.join(format!("library.sqlite3{suffix}"));
            if fs::symlink_metadata(&sidecar).is_ok() {
                reject_links(&sidecar)?;
            }
        }
        let mut connection = Connection::open_with_flags(
            db,
            rusqlite::OpenFlags::default() | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(failure)?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(failure)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(failure)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(failure)?;
        let version: u32 = tx
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(failure)?;
        if version > SCHEMA_VERSION {
            return Err(failure(
                "La biblioteca pertenece a una version futura. No se modificaron sus datos.",
            ));
        }
        if version == 0 {
            let tables: u32 = tx
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                    [],
                    |r| r.get(0),
                )
                .map_err(failure)?;
            if tables != 0 {
                return Err(failure(
                    "Esquema desconocido; no se sobrescribira la biblioteca.",
                ));
            }
            tx.execute_batch(include_str!("../../migrations/001_library.sql"))
                .map_err(failure)?;
        }
        // Verifica version y estructura antes de escribir sobre una base existente.
        let reference = Connection::open_in_memory().map_err(failure)?;
        reference
            .execute_batch(include_str!("../../migrations/001_library.sql"))
            .map_err(failure)?;
        if version == SCHEMA_VERSION {
            reference
                .execute_batch(include_str!("../../migrations/002_professional.sql"))
                .map_err(failure)?;
        }
        let schema = |db: &Connection| -> Result<Vec<(String, String)>, AudioError> {
            db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map_err(failure)?.query_map([],|r|Ok((r.get(0)?,r.get(1)?))).map_err(failure)?.collect::<Result<Vec<_>,_>>().map_err(failure)
        };
        if schema(&tx)? != schema(&reference)? {
            return Err(failure(
                "El esquema no corresponde a la version declarada. No se modificaron sus datos.",
            ));
        }
        if version < SCHEMA_VERSION {
            tx.execute_batch(include_str!("../../migrations/002_professional.sql"))
                .map_err(failure)?;
            reference
                .execute_batch(include_str!("../../migrations/002_professional.sql"))
                .map_err(failure)?;
        }
        if schema(&tx)? != schema(&reference)? {
            return Err(failure("La migracion no produjo el esquema esperado."));
        }
        let integrity: String = tx
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(failure)?;
        if integrity != "ok" {
            return Err(failure(
                "La biblioteca no supera la comprobacion de integridad.",
            ));
        }
        if tx
            .prepare("PRAGMA foreign_key_check")
            .map_err(failure)?
            .exists([])
            .map_err(failure)?
        {
            return Err(failure(
                "La biblioteca contiene referencias inconsistentes.",
            ));
        }
        tx.commit().map_err(failure)?;
        let mut store = Self {
            connection,
            directory,
            assets: HashMap::new(),
            pcm_hashes: HashMap::new(),
            retired: Vec::new(),
            pending_import: None,
            #[cfg(test)]
            pcm_budget: CACHE_LIMIT,
            #[cfg(test)]
            reload_hook: None,
            pcm: HashMap::new(),
            diagnostic_volumes: Vec::new(),
            snapshot: LibrarySnapshot {
                revision: 0,
                board: BoardSnapshot {
                    version: BOARD_VERSION,
                    banks: vec![],
                    active_bank_id: String::new(),
                    keyboard_shortcuts: vec![],
                },
                effects: vec![],
                settings: LibrarySettings {
                    columns: "auto".into(),
                    master_volume: 0.7,
                    max_concurrent_playbacks: 16,
                    preferred_device_name: None,
                },
            },
        };
        store.refresh_availability()?;
        Ok(store)
    }

    /// Revalida fuera del audio y retira PCM inutilizable sin ocultar pins externos.
    /// Devuelve true si falto presupuesto y conviene reintentar tras invalidar las caches del motor.
    pub fn refresh_availability(&mut self) -> Result<bool, AudioError> {
        self.reload()?;
        let mut retry = false;
        self.retired
            .retain(|pcm| std::sync::Arc::strong_count(&pcm.samples) > 1);
        for effect in self.snapshot.effects.clone() {
            let id = effect.id.clone();
            let (path, hash) = self
                .assets
                .get(&id)
                .cloned()
                .ok_or_else(|| failure("Catalogo inconsistente."))?;
            let result = self.read_managed(&path).and_then(|bytes| {
                if digest(&bytes) != hash {
                    return Err(failure("El archivo gestionado ha cambiado."));
                }
                if let Some(pcm) = self.pcm.get(&id) {
                    return Ok(pcm.clone());
                }
                decode(bytes, &effect.format, self.remaining())
            });
            match result {
                Ok(pcm) => {
                    self.pcm.insert(id.clone(), pcm);
                    self.pcm_hashes
                        .insert(id.clone(), (hash, effect.format.clone()));
                    if let Some(effect) = self.snapshot.effects.iter_mut().find(|e| e.id == id) {
                        effect.availability = "available".into();
                        effect.error = None;
                    }
                }
                Err(error) => {
                    retry |= error.code == "pcm_budget";
                    if self
                        .pcm
                        .get(&id)
                        .is_some_and(|pcm| std::sync::Arc::strong_count(&pcm.samples) == 1)
                    {
                        self.pcm.remove(&id);
                        self.pcm_hashes.remove(&id);
                    }
                    if let Some(effect) = self.snapshot.effects.iter_mut().find(|e| e.id == id) {
                        effect.availability = if error.code == "missing" {
                            "missing"
                        } else {
                            "invalid"
                        }
                        .into();
                        effect.error = Some(error.message);
                    }
                }
            }
        }
        self.retired
            .retain(|pcm| std::sync::Arc::strong_count(&pcm.samples) > 1);
        Ok(retry)
    }

    fn remaining(&self) -> usize {
        #[cfg(test)]
        let capacity = self.pcm_budget;
        #[cfg(not(test))]
        let capacity = CACHE_LIMIT;
        // Una preparacion puede fijar PCM del catalogo que despues pasa a retirados.
        // Contar por asignacion, no por lista ni numero de pins, evita dobles cargos y huecos.
        let mut allocations = HashSet::new();
        let used = self
            .pcm
            .values()
            .chain(self.retired.iter())
            .chain(
                self.pending_import
                    .iter()
                    .flat_map(|pending| pending.pcm.values()),
            )
            .filter(|pcm| allocations.insert(pcm.samples.as_ptr()))
            .map(|pcm| pcm.samples.len() * 4)
            .sum::<usize>();
        capacity.saturating_sub(used)
    }

    /// Reutiliza solo PCM cuya procedencia validada coincide con hash, formato y metadatos reales.
    /// La copia gestionada puede faltar: bytes entrantes del mismo hash permiten repararla sin otro decode.
    fn known_pcm(&self, hash: &str, format: &str, byte_size: usize) -> Option<&PreparedPcm> {
        self.snapshot.effects.iter().find_map(|effect| {
            let (path_hash, decoded) = (
                self.assets.get(&effect.id)?,
                self.pcm_hashes.get(&effect.id)?,
            );
            let pcm = self.pcm.get(&effect.id)?;
            (path_hash.1 == hash
                && decoded.0 == hash
                && decoded.1 == format
                && effect.format == format
                && effect.byte_size == byte_size as u64
                && effect.channels == pcm.channels
                && effect.sample_rate == pcm.sample_rate
                && effect.duration_ms
                    == pcm.samples.len() as u64 * 1000
                        / u64::from(pcm.channels)
                        / u64::from(pcm.sample_rate))
            .then_some(pcm)
        })
    }

    fn managed_name<'a>(&self, relative: &'a str) -> Result<&'a str, AudioError> {
        let Some(name) = relative.strip_prefix("audio/") else {
            return Err(failure("Ruta interna invalida."));
        };
        if name.len() != 40
            || !name.is_ascii()
            || !name.ends_with(".bin")
            || uuid::Uuid::parse_str(&name[..36]).is_err()
        {
            return Err(failure("Nombre interno invalido."));
        }
        Ok(name)
    }

    fn read_managed(&self, relative: &str) -> Result<Vec<u8>, AudioError> {
        let name = self.managed_name(relative)?;
        let audio = self.directory.open_dir_nofollow("audio").map_err(failure)?;
        filesystem::read_regular(&audio, name.as_ref(), FILE_LIMIT).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                AudioError::new("missing", "El archivo gestionado no existe.")
            } else {
                failure(error)
            }
        })
    }

    fn reload(&mut self) -> Result<(), AudioError> {
        // Todas las tablas se leen en la misma version SQLite; publicar solo despues de terminar.
        let tx = self.connection.transaction().map_err(failure)?;
        let count: u32 = tx
            .query_row("SELECT count(*) FROM sound_effects", [], |row| row.get(0))
            .map_err(failure)?;
        if count > 4096 {
            return Err(failure("La biblioteca supera el limite de 4096 efectos."));
        }
        #[cfg(test)]
        if let Some(hook) = self.reload_hook.take() {
            hook();
        }
        let diagnostics = tx
            .prepare("SELECT effect_id,volume FROM diagnostic_volumes")
            .map_err(failure)?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(failure)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(failure)?;
        let rows=tx.prepare("SELECT id,name,duration_ms,format,sample_rate,channels,byte_size,default_volume,path,hash FROM sound_effects ORDER BY rowid").map_err(failure)?.query_map([], |r| Ok((LibraryEffect {
            id:r.get(0)?,name:r.get(1)?,duration_ms:u64::from(r.get::<_,u32>(2)?),format:r.get(3)?,sample_rate:r.get(4)?,channels:r.get(5)?,byte_size:u64::from(r.get::<_,u32>(6)?),default_volume:r.get(7)?,availability:"available".into(),error:None
        },r.get::<_,String>(8)?,r.get::<_,String>(9)?))).map_err(failure)?.collect::<Result<Vec<_>,_>>().map_err(failure)?;
        let mut effects = Vec::new();
        let mut assets = HashMap::new();
        for (mut effect, path, hash) in rows {
            if let Some(old) = self.snapshot.effects.iter().find(|e| e.id == effect.id) {
                effect.availability.clone_from(&old.availability);
                effect.error.clone_from(&old.error);
            }
            assets.insert(effect.id.clone(), (path, hash));
            effects.push(effect);
        }
        let banks = tx
            .prepare("SELECT id,name FROM sound_banks ORDER BY position")
            .map_err(failure)?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(failure)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(failure)?;
        let mut board_banks = Vec::new();
        for (id, name) in banks {
            let buttons = tx.prepare("SELECT b.id,b.effect_id,b.name,coalesce(e.duration_ms,0),b.color,coalesce(b.category,''),b.looped,b.fade_in_ms,b.fade_out_ms FROM bank_effects b LEFT JOIN sound_effects e ON e.id=b.effect_id WHERE bank_id=? ORDER BY position").map_err(failure)?.query_map([&id], |r| Ok(SoundButton { id:r.get(0)?,effect_id:r.get(1)?,name:r.get(2)?,duration_ms:u64::from(r.get::<_,u32>(3)?),color:r.get(4)?,category:r.get(5)?,playback:crate::domain::audio::PlaybackOptions {looped:r.get(6)?,fade_in_ms:r.get(7)?,fade_out_ms:r.get(8)?} })).map_err(failure)?.collect::<Result<Vec<_>,_>>().map_err(failure)?;
            board_banks.push(SoundBank { id, name, buttons });
        }
        let (revision, active, settings) = tx.query_row("SELECT board_revision,active_bank_id,columns,master_volume,max_concurrent_playbacks,preferred_device_name FROM app_settings WHERE id=1", [], |r| Ok((r.get::<_,i64>(0)?, r.get(1)?, LibrarySettings { columns:r.get(2)?,master_volume:r.get(3)?,max_concurrent_playbacks:r.get(4)?,preferred_device_name:r.get(5)? }))).map_err(failure)?;
        let keyboard_shortcuts = tx
            .prepare("SELECT binding FROM keyboard_shortcuts ORDER BY rowid")
            .map_err(failure)?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(failure)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(failure)?
            .into_iter()
            .map(|value| serde_json::from_str(&value).map_err(failure))
            .collect::<Result<Vec<ShortcutBinding>, _>>()?;
        let board = BoardSnapshot {
            version: BOARD_VERSION,
            banks: board_banks,
            active_bank_id: active,
            keyboard_shortcuts,
        };
        Self::validate_board(&board, &effects)?;
        tx.commit().map_err(failure)?;
        let stale = self
            .pcm_hashes
            .iter()
            .filter(|(id, (hash, format))| {
                assets.get(*id).is_none_or(|(_, current)| current != hash)
                    || effects
                        .iter()
                        .find(|effect| &effect.id == *id)
                        .is_none_or(|effect| &effect.format != format)
                    || (effects
                        .iter()
                        .any(|effect| &effect.id == *id && effect.availability != "available")
                        && self
                            .pcm
                            .get(*id)
                            .is_some_and(|pcm| std::sync::Arc::strong_count(&pcm.samples) == 1))
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in stale {
            if let Some(pcm) = self.pcm.remove(&id) {
                self.retired.push(pcm);
            }
            self.pcm_hashes.remove(&id);
        }
        self.retired
            .retain(|pcm| std::sync::Arc::strong_count(&pcm.samples) > 1);
        self.snapshot.effects = effects;
        self.assets = assets;
        self.diagnostic_volumes = diagnostics;
        self.snapshot.revision = u64::try_from(revision).map_err(failure)?;
        self.snapshot.settings = settings;
        self.snapshot.board = board;
        Ok(())
    }

    /// Guarda solo la revisión de tablero, con validación completa antes de iniciar la transacción.
    pub fn save_board(
        &mut self,
        board: BoardSnapshot,
        revision: u64,
    ) -> Result<LibrarySnapshot, AudioError> {
        self.reload()?;
        if revision != self.snapshot.revision {
            return Err(AudioError::new(
                "revision_conflict",
                "El tablero cambio. Recargue antes de guardar.",
            ));
        }
        Self::validate_board(&board, &self.snapshot.effects)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(failure)?;
        Self::write_board(&tx, &board, revision)?;
        tx.commit().map_err(failure)?;
        self.reload()?;
        Ok(self.snapshot.clone())
    }

    fn validate_board(board: &BoardSnapshot, effects: &[LibraryEffect]) -> Result<(), AudioError> {
        let valid_text = |s: &str, max| {
            !s.trim().is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
        };
        if board.version != BOARD_VERSION
            || board.banks.is_empty()
            || board.banks.len() > 100
            || !board.banks.iter().any(|b| b.id == board.active_bank_id)
        {
            return Err(failure("Tablero invalido."));
        }
        board.validate_shortcuts()?;
        let mut ids = HashSet::new();
        for bank in &board.banks {
            if !valid_text(&bank.id, 100)
                || !ids.insert(bank.id.clone())
                || !valid_text(&bank.name, 60)
                || bank.buttons.len() > 256
            {
                return Err(failure("Banco invalido o identificador duplicado."));
            }
            for button in &bank.buttons {
                let duration = button
                    .effect_id
                    .as_ref()
                    .and_then(|id| effects.iter().find(|e| &e.id == id))
                    .map_or(0, |e| e.duration_ms);
                button.playback.validate(duration)?;
                if button.effect_id.is_none()
                    && button.playback != crate::domain::audio::PlaybackOptions::default()
                {
                    return Err(failure(
                        "Un boton sin recurso no admite opciones de reproduccion.",
                    ));
                }
                if !valid_text(&button.id, 100)
                    || !ids.insert(button.id.clone())
                    || !valid_text(&button.name, 100)
                    || button.category.chars().count() > 80
                    || button.category.chars().any(char::is_control)
                    || !["amber", "coral", "mint", "sky", "violet", "slate"]
                        .contains(&button.color.as_str())
                    || button
                        .effect_id
                        .as_ref()
                        .is_some_and(|id| !effects.iter().any(|e| &e.id == id))
                {
                    return Err(failure("Boton invalido, duplicado o efecto desconocido."));
                }
            }
        }
        Ok(())
    }

    fn write_board(
        tx: &rusqlite::Transaction<'_>,
        board: &BoardSnapshot,
        revision: u64,
    ) -> Result<(), AudioError> {
        let actual: i64 = tx
            .query_row(
                "SELECT board_revision FROM app_settings WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(failure)?;
        if u64::try_from(actual).map_err(failure)? != revision {
            return Err(AudioError::new(
                "revision_conflict",
                "El tablero cambio. Recargue antes de guardar.",
            ));
        }
        tx.execute("DELETE FROM keyboard_shortcuts", [])
            .map_err(failure)?;
        tx.execute("DELETE FROM bank_effects", [])
            .map_err(failure)?;
        tx.execute("DELETE FROM sound_banks", []).map_err(failure)?;
        tx.execute("DELETE FROM categories", []).map_err(failure)?;
        for (position, bank) in board.banks.iter().enumerate() {
            tx.execute(
                "INSERT INTO sound_banks VALUES (?,?,?)",
                params![bank.id, bank.name, position as i64],
            )
            .map_err(failure)?;
            for (position, button) in bank.buttons.iter().enumerate() {
                let category = (!button.category.is_empty()).then_some(&button.category);
                if let Some(category) = category {
                    tx.execute("INSERT OR IGNORE INTO categories VALUES (?)", [category])
                        .map_err(failure)?;
                }
                tx.execute(
                    "INSERT INTO bank_effects (id,bank_id,effect_id,name,color,category,position,looped,fade_in_ms,fade_out_ms) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    params![
                        button.id,
                        bank.id,
                        button.effect_id,
                        button.name,
                        button.color,
                        category,
                        position as i64,
                        button.playback.looped,
                        button.playback.fade_in_ms,
                        button.playback.fade_out_ms
                    ],
                )
                .map_err(failure)?;
            }
        }
        for binding in &board.keyboard_shortcuts {
            tx.execute(
                "INSERT INTO keyboard_shortcuts(id,scope_bank_id,button_id,bank_id,binding) VALUES (?,?,?,?,?)",
                params![binding.id, binding.scope_bank_id,
                    (binding.action.kind == ShortcutKind::PlayButton).then_some(binding.action.target_id.as_ref()).flatten(),
                    (binding.action.kind == ShortcutKind::SelectBank).then_some(binding.action.target_id.as_ref()).flatten(),
                    serde_json::to_string(binding).map_err(failure)?],
            )
            .map_err(failure)?;
        }
        tx.execute(
            "UPDATE app_settings SET active_bank_id=?,board_revision=board_revision+1 WHERE id=1",
            [&board.active_bank_id],
        )
        .map_err(failure)?;
        Ok(())
    }

    /// Importa entradas seleccionadas por Rust; conserva originales y confirma cada archivo aisladamente.
    pub fn import_paths(&mut self, paths: Vec<PathBuf>) -> ImportResult {
        let mut imported = Vec::new();
        let mut failed = Vec::new();
        for path in paths.iter().take(256) {
            match self.import_one(path) {
                Ok(effect) => imported.push(effect),
                Err(error) => failed.push(ImportFailure {
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    message: error.message,
                }),
            }
        }
        if paths.len() > 256 {
            failed.push(ImportFailure {
                name: "Seleccion".into(),
                message: "Maximo 256 archivos por importacion.".into(),
            });
        }
        ImportResult {
            cancelled: paths.is_empty(),
            imported,
            failed,
            snapshot: self.snapshot.clone(),
        }
    }

    fn import_one(&mut self, path: &Path) -> Result<ImportedEffect, AudioError> {
        self.reload()?;
        let bytes = read_audio(path)?;
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !["wav", "mp3", "ogg", "flac"].contains(&extension.as_str()) {
            return Err(failure("Extension no admitida."));
        }
        let hash = digest(&bytes);
        let existing: Option<String> = self
            .connection
            .query_row("SELECT id FROM sound_effects WHERE hash=?", [&hash], |r| {
                r.get(0)
            })
            .optional()
            .map_err(failure)?;
        if let Some(id) = &existing {
            self.reload()?;
            let effect = self
                .snapshot
                .effects
                .iter()
                .find(|e| &e.id == id)
                .cloned()
                .ok_or_else(|| failure("Catalogo inconsistente."))?;
            if effect.format != extension {
                return Err(failure(
                    "La extension no coincide con el formato real del audio.",
                ));
            }
        }
        if existing.is_none() && self.snapshot.effects.len() >= 4096 {
            return Err(failure(
                "La biblioteca admite como maximo 4096 efectos precargados.",
            ));
        }
        let byte_size = bytes.len() as u64;
        let old_path = existing
            .as_ref()
            .and_then(|id| self.assets.get(id))
            .map(|(path, _)| path.clone());
        let managed_status = old_path.as_ref().map(|path| {
            self.read_managed(path).and_then(|bytes| {
                if digest(&bytes) == hash {
                    Ok(())
                } else {
                    Err(failure("El archivo gestionado ha cambiado."))
                }
            })
        });
        let usable = managed_status.as_ref().is_some_and(Result::is_ok);
        if let Some(Err(error)) = managed_status
            && let Some(effect) = self
                .snapshot
                .effects
                .iter_mut()
                .find(|effect| Some(&effect.id) == existing.as_ref())
        {
            effect.availability = if error.code == "missing" {
                "missing"
            } else {
                "invalid"
            }
            .into();
            effect.error = Some(error.message);
        }
        // Una recuperacion nunca sobrescribe la entrada vieja: publica otro nombre generado.
        // El archivo privado aun no pertenece a SQLite; RAII limpia solo esta nueva copia si falla.
        let owned = if usable {
            None
        } else {
            let audio = self.directory.open_dir_nofollow("audio").map_err(failure)?;
            Some(NewAudio::create(&audio, &bytes).map_err(failure)?)
        };
        let pcm = if let Some(pcm) = existing.as_ref().and_then(|id| self.pcm.get(id)) {
            pcm.clone()
        } else {
            decode(bytes, &extension, self.remaining())?
        };
        let id = existing
            .clone()
            .or_else(|| {
                owned
                    .as_ref()
                    .map(|file| file.name().trim_end_matches(".bin").to_owned())
            })
            .ok_or_else(|| failure("Identificador de importacion ausente."))?;
        let relative = owned
            .as_ref()
            .map(|file| format!("audio/{}", file.name()))
            .or(old_path.clone())
            .ok_or_else(|| failure("Ruta gestionada ausente."))?;
        let name: String = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .chars()
            .filter(|c| !c.is_control())
            .take(100)
            .collect();
        let mut effect = LibraryEffect {
            id: id.clone(),
            name: if name.trim().is_empty() {
                "Audio".into()
            } else {
                name
            },
            duration_ms: pcm.samples.len() as u64 * 1000
                / u64::from(pcm.channels)
                / u64::from(pcm.sample_rate),
            format: extension,
            sample_rate: pcm.sample_rate,
            channels: pcm.channels,
            byte_size,
            default_volume: 0.5,
            availability: "available".into(),
            error: None,
        };
        if let Some(previous) = self.snapshot.effects.iter().find(|effect| effect.id == id) {
            effect = previous.clone();
        }
        effect.availability = "available".into();
        effect.error = None;
        let tx = self.connection.transaction().map_err(failure)?;
        if existing.is_some() {
            if !usable {
                let changed = tx
                    .execute(
                        "UPDATE sound_effects SET path=? WHERE id=? AND hash=? AND path=?",
                        params![relative, id, hash, old_path],
                    )
                    .map_err(failure)?;
                if changed != 1 {
                    return Err(failure(
                        "Otro proceso modifico el recurso durante su recuperacion. Recargue y reintente.",
                    ));
                }
            }
        } else {
            tx.execute(
                "INSERT INTO sound_effects VALUES (?,?,?,?,?,?,?,?,?,?)",
                params![
                    id,
                    effect.name,
                    relative,
                    hash,
                    effect.duration_ms as i64,
                    effect.format,
                    effect.sample_rate,
                    effect.channels,
                    byte_size as i64,
                    0.5
                ],
            )
            .map_err(failure)?;
        }
        tx.commit().map_err(failure)?;
        if let Some(owned) = owned {
            owned.commit();
        }
        self.pcm.insert(id.clone(), pcm);
        self.pcm_hashes
            .insert(id.clone(), (hash.clone(), effect.format.clone()));
        self.reload().map_err(|error|AudioError::new("library_partial_failure",format!("La copia y sus metadatos ya se guardaron, pero no se pudo recargar la biblioteca: {}",error.message)))?;
        if self
            .assets
            .get(&id)
            .is_none_or(|(_, current)| current != &hash)
        {
            return Err(AudioError::new(
                "library_partial_failure",
                "Otro proceso cambio el recurso despues de la importacion. Recargue la biblioteca antes de continuar.",
            ));
        }
        if let Some(current) = self
            .snapshot
            .effects
            .iter_mut()
            .find(|effect| effect.id == id)
        {
            current.availability = "available".into();
            current.error = None;
            effect = current.clone();
        }
        Ok(ImportedEffect {
            effect,
            duplicate: existing.is_some(),
        })
    }

    /// Actualiza solo el campo solicitado: una cache de otro proceso no puede restaurar valores antiguos.
    pub fn patch_settings(&mut self, setting: Setting) -> Result<(), AudioError> {
        match setting {
            Setting::Columns(value) => {
                if !["auto", "3", "4", "6"].contains(&value.as_str()) {
                    return Err(failure("Columnas invalidas."));
                }
                self.connection
                    .execute("UPDATE app_settings SET columns=? WHERE id=1", [value])
                    .map_err(failure)?;
            }
            Setting::Master(value) => {
                validate_volume(value)?;
                self.connection
                    .execute(
                        "UPDATE app_settings SET master_volume=? WHERE id=1",
                        [value],
                    )
                    .map_err(failure)?;
            }
            Setting::Limit(value) => {
                if !(1..=64).contains(&value) {
                    return Err(failure("Limite de voces invalido."));
                }
                self.connection
                    .execute(
                        "UPDATE app_settings SET max_concurrent_playbacks=? WHERE id=1",
                        [value],
                    )
                    .map_err(failure)?;
            }
            Setting::PreferredDevice(value) => {
                self.connection
                    .execute(
                        "UPDATE app_settings SET preferred_device_name=? WHERE id=1",
                        [value],
                    )
                    .map_err(failure)?;
            }
        }
        self.reload()
    }

    /// Guarda la ganancia predeterminada de un recurso; las señales diagnósticas no son biblioteca.
    pub fn effect_volume(&mut self, id: &str, value: f32) -> Result<(), AudioError> {
        validate_volume(value)?;
        if ["native-test-chime", "native-test-pulse", "native-test-low"].contains(&id) {
            self.connection.execute("INSERT INTO diagnostic_volumes VALUES (?,?) ON CONFLICT(effect_id) DO UPDATE SET volume=excluded.volume",params![id,value]).map_err(failure)?;
            self.diagnostic_volumes.retain(|(effect, _)| effect != id);
            self.diagnostic_volumes.push((id.into(), value));
            return Ok(());
        }
        self.connection
            .execute(
                "UPDATE sound_effects SET default_volume=? WHERE id=?",
                params![value, id],
            )
            .map_err(failure)?;
        if let Some(effect) = self.snapshot.effects.iter_mut().find(|e| e.id == id) {
            effect.default_volume = value;
        }
        Ok(())
    }
}
use rusqlite::OptionalExtension;

mod packages;
#[cfg(test)]
mod tests;
