use super::audio::{AudioError, PlaybackOptions};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const BOARD_VERSION: u8 = 2;

#[derive(Clone, Debug)]
pub struct PreparedPcm {
    pub samples: Arc<[f32]>,
    pub channels: u16,
    pub sample_rate: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SoundButton {
    pub id: String,
    pub effect_id: Option<String>,
    pub name: String,
    pub duration_ms: u64,
    pub color: String,
    pub category: String,
    pub playback: PlaybackOptions,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SoundBank {
    pub id: String,
    pub name: String,
    pub buttons: Vec<SoundButton>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardSnapshot {
    pub version: u8,
    pub banks: Vec<SoundBank>,
    pub active_bank_id: String,
    pub keyboard_shortcuts: Vec<ShortcutBinding>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyChord {
    pub code: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutScope {
    Application,
    Bank,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutKind {
    PlayButton,
    SelectBank,
    StopAll,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShortcutAction {
    pub kind: ShortcutKind,
    pub target_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShortcutBinding {
    pub id: String,
    pub scope: ShortcutScope,
    pub scope_bank_id: Option<String>,
    pub chord: KeyChord,
    pub action: ShortcutAction,
    pub enabled: bool,
}

impl BoardSnapshot {
    /// Valida referencias y conflictos incluso de atajos deshabilitados, salvo colisiones activas.
    pub fn validate_shortcuts(&self) -> Result<(), AudioError> {
        use std::collections::HashSet;
        let invalid = || {
            AudioError::new(
                "invalid_shortcut",
                "Atajo invalido, reservado, duplicado o con referencias inconsistentes.",
            )
        };
        if self.keyboard_shortcuts.len() > 512 {
            return Err(invalid());
        }
        let mut ids = HashSet::new();
        for (index, binding) in self.keyboard_shortcuts.iter().enumerate() {
            let c = &binding.chord;
            let allowed = (b'A'..=b'Z').any(|v| c.code == format!("Key{}", char::from(v)))
                || (0..=9).any(|v| c.code == format!("Digit{v}") || c.code == format!("Numpad{v}"))
                || (1..=12).any(|v| c.code == format!("F{v}"))
                || ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
                    .contains(&c.code.as_str());
            if binding.id.trim().is_empty()
                || binding.id.chars().count() > 100
                || binding.id.chars().any(char::is_control)
                || !ids.insert(&binding.id)
                || !allowed
                || (c.ctrl && c.shift && c.code == "Space")
                || ((c.ctrl || c.meta)
                    && ["KeyR", "KeyW", "KeyL", "KeyT", "KeyN", "KeyQ"].contains(&c.code.as_str()))
                || c.code == "F5"
                || (c.alt && c.code == "F4")
            {
                return Err(invalid());
            }
            let bank = binding
                .scope_bank_id
                .as_ref()
                .and_then(|id| self.banks.iter().find(|b| &b.id == id));
            if match binding.scope {
                ShortcutScope::Application => binding.scope_bank_id.is_some(),
                ShortcutScope::Bank => bank.is_none(),
            } {
                return Err(invalid());
            }
            let target = binding.action.target_id.as_ref();
            let valid = match binding.action.kind {
                ShortcutKind::StopAll => target.is_none(),
                ShortcutKind::SelectBank => self.banks.iter().any(|b| Some(&b.id) == target),
                ShortcutKind::PlayButton => self
                    .banks
                    .iter()
                    .filter(|b| {
                        binding.scope == ShortcutScope::Application
                            || Some(&b.id) == binding.scope_bank_id.as_ref()
                    })
                    .any(|b| b.buttons.iter().any(|v| Some(&v.id) == target)),
            };
            if !valid {
                return Err(invalid());
            }
            if binding.enabled
                && self.keyboard_shortcuts[..index].iter().any(|other| {
                    other.enabled
                        && other.chord == *c
                        && (binding.scope == ShortcutScope::Application
                            || other.scope == ShortcutScope::Application
                            || binding.scope_bank_id == other.scope_bank_id)
                })
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEffect {
    pub id: String,
    pub name: String,
    pub duration_ms: u64,
    pub format: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub byte_size: u64,
    pub default_volume: f32,
    pub availability: String,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySettings {
    pub columns: String,
    pub master_volume: f32,
    pub max_concurrent_playbacks: u16,
    pub preferred_device_name: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub revision: u64,
    pub board: BoardSnapshot,
    pub effects: Vec<LibraryEffect>,
    pub settings: LibrarySettings,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEffect {
    pub effect: LibraryEffect,
    pub duplicate: bool,
}
#[derive(Serialize)]
pub struct ImportFailure {
    pub name: String,
    pub message: String,
}
#[derive(Serialize)]
pub struct ImportResult {
    pub cancelled: bool,
    pub imported: Vec<ImportedEffect>,
    pub failed: Vec<ImportFailure>,
    pub snapshot: LibrarySnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankImportPreview {
    pub token: String,
    pub bank_names: Vec<String>,
    pub effect_count: usize,
    pub button_count: usize,
    pub shortcut_count: usize,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankImportPreparation {
    pub cancelled: bool,
    pub preview: Option<BankImportPreview>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankImportCommitResult {
    pub snapshot: LibrarySnapshot,
    pub imported_bank_ids: Vec<String>,
    pub reused_effects: usize,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankExportResult {
    pub cancelled: bool,
    pub exported_banks: usize,
    pub exported_effects: usize,
    pub byte_size: usize,
    pub warnings: Vec<String>,
}
