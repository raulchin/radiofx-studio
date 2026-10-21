use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybackOptions {
    pub looped: bool,
    pub fade_in_ms: u32,
    pub fade_out_ms: u32,
}
impl PlaybackOptions {
    /// Valida envolventes contra la duracion real, sin corregir valores silenciosamente.
    pub fn validate(self, duration_ms: u64) -> Result<(), AudioError> {
        if self.fade_in_ms > 30_000
            || self.fade_out_ms > 30_000
            || (!self.looped
                && u64::from(self.fade_in_ms) + u64::from(self.fade_out_ms) > duration_ms)
        {
            return Err(AudioError::new(
                "invalid_playback_options",
                "Los fades deben estar entre 0 y 30000 ms y caber en la duracion de una reproduccion simple.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackState {
    Playing,
    FadingOut,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AudioError {
    pub code: String,
    pub message: String,
}

impl AudioError {
    /// Construye un error de dominio serializable, sin detalles internos obligatorios.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NativeEffect {
    pub effect_id: String,
    pub name: String,
    pub duration_ms: u32,
    pub default_volume: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Playback {
    pub playback_id: String,
    pub effect_id: String,
    pub volume: f32,
    pub looped: bool,
    pub state: PlaybackState,
    pub fade_out_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineState {
    NotInitialized,
    Ready,
    DeviceError,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AudioEngineStatus {
    pub engine_id: String,
    pub revision: u64,
    pub state: EngineState,
    pub selected_device: Option<OutputDevice>,
    pub active_playbacks: Vec<Playback>,
    pub master_volume: f32,
    pub max_concurrent_playbacks: u16,
    pub last_error: Option<AudioError>,
    pub effects: Vec<NativeEffect>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeviceSelectionResult {
    pub status: AudioEngineStatus,
    pub restored_previous: bool,
    pub error: Option<AudioError>,
}

/// Valida ganancias sin corregir silenciosamente entradas fuera de rango.
pub fn validate_volume(value: f32) -> Result<(), AudioError> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(AudioError::new(
            "invalid_volume",
            "El volumen debe ser un numero finito entre 0 y 1.",
        ))
    }
}
