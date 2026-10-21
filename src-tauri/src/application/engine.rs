use crate::domain::audio::*;
use crate::domain::library::PreparedPcm;
use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU32},
};

/// Puerto de salida: el controlador y su stream pertenecen exclusivamente al worker.
/// Los tokens conservan el dispositivo real, nunca un indice de una lista renovada.
pub trait AudioDriver {
    type Device: Clone;
    /// Enumera salidas con tokens reales e IDs nuevos, sin abrir streams.
    fn enumerate(&mut self) -> Result<Vec<(OutputDevice, Self::Device)>, AudioError>;
    /// Abre solamente el dispositivo solicitado, sin fallback implicito.
    fn open(
        &mut self,
        device: &Self::Device,
        master: Arc<AtomicU32>,
        cutoff: Arc<AtomicBool>,
    ) -> Result<(), AudioError>;
    /// Libera todas las voces y el unico stream, si existe.
    fn close(&mut self);
    /// Invalida caches derivadas del recurso sin detener voces; los drivers sin cache no retienen pins.
    fn invalidate_prepared(&mut self, _effect: &str) {}
    /// Conecta una voz precargada al mezclador compartido.
    fn start(&mut self, id: &str, effect: &str, volume: f32) -> Result<(), AudioError>;
    /// Inicia con envolvente por frame; el puerto simulado conserva su politica de finalizacion manual.
    fn start_with_options(
        &mut self,
        id: &str,
        effect: &str,
        pcm: Option<PreparedPcm>,
        volume: f32,
        _options: PlaybackOptions,
    ) -> Result<(), AudioError> {
        match pcm {
            Some(pcm) => self.start_prepared(id, effect, pcm, volume),
            None => self.start(id, effect, volume),
        }
    }
    /// Cambia el loop sin rearmar fuentes retiradas.
    fn set_loop(&mut self, _id: &str, _looped: bool) {}
    /// Solicita salida por consumo de frames, sin temporizadores de volumen.
    fn fade_out(&mut self, _id: &str, _duration_ms: u32) {}
    /// Recibe PCM compartido ya validado; los drivers simulados pueden reutilizar su contador de voces.
    fn start_prepared(
        &mut self,
        id: &str,
        effect: &str,
        _pcm: PreparedPcm,
        volume: f32,
    ) -> Result<(), AudioError> {
        self.start(id, effect, volume)
    }
    /// Detiene y libera una voz de forma idempotente.
    fn stop(&mut self, id: &str);
    /// Cambia la ganancia de una voz existente.
    fn set_volume(&mut self, id: &str, volume: f32);
    /// Retira y devuelve IDs de voces finalizadas naturalmente.
    fn finished(&mut self) -> Vec<String>;
    /// Consume el indicador atomico de fallo del stream.
    fn failed(&mut self) -> bool;
}

pub type EventEmitter = Box<dyn Fn(&str, &AudioEngineStatus) + Send>;

pub struct Engine<D: AudioDriver> {
    pub status: AudioEngineStatus,
    driver: D,
    registry: Vec<(OutputDevice, D::Device)>,
    selected: Option<D::Device>,
    master: Arc<AtomicU32>,
    cutoff: Arc<AtomicBool>,
    emit: EventEmitter,
    next_playback: u64,
    prepared: HashMap<String, Option<PreparedPcm>>,
}

impl<D: AudioDriver> Engine<D> {
    /// Crea un motor sin abrir salida; la biblioteca se registra ya decodificada desde otro hilo.
    pub fn new(driver: D, emit: EventEmitter, cutoff: Arc<AtomicBool>) -> Self {
        let effects = [
            ("native-test-chime", "Señal de prueba aguda", 450),
            ("native-test-pulse", "Señal de prueba pulsada", 300),
            ("native-test-low", "Señal de prueba grave", 4000),
        ]
        .into_iter()
        .map(|(id, name, duration)| NativeEffect {
            effect_id: id.into(),
            name: name.into(),
            duration_ms: duration,
            default_volume: 0.5,
        })
        .collect();
        Self {
            status: AudioEngineStatus {
                engine_id: uuid::Uuid::new_v4().to_string(),
                revision: 0,
                state: EngineState::NotInitialized,
                selected_device: None,
                active_playbacks: Vec::new(),
                master_volume: 0.7,
                max_concurrent_playbacks: 16,
                last_error: None,
                effects,
            },
            driver,
            registry: Vec::new(),
            selected: None,
            master: Arc::new(AtomicU32::new(0.7_f32.to_bits())),
            cutoff,
            emit,
            next_playback: 0,
            prepared: HashMap::new(),
        }
    }

    /// Añade recursos precargados sin disco ni decoder; los registros repetidos no revierten ganancias.
    pub fn register(&mut self, entries: Vec<(NativeEffect, Option<PreparedPcm>)>) {
        let mut changed = false;
        for (effect, pcm) in entries {
            if let Some(current) = self.prepared.get_mut(&effect.effect_id) {
                let same = match (&current, &pcm) {
                    (Some(a), Some(b)) => {
                        a.channels == b.channels
                            && a.sample_rate == b.sample_rate
                            && Arc::ptr_eq(&a.samples, &b.samples)
                    }
                    (None, None) => true,
                    _ => false,
                };
                if !same || pcm.is_none() {
                    self.driver.invalidate_prepared(&effect.effect_id);
                }
                if !same {
                    *current = pcm;
                    changed = true;
                }
                if let Some(metadata) = self
                    .status
                    .effects
                    .iter_mut()
                    .find(|metadata| metadata.effect_id == effect.effect_id)
                    && (metadata.name != effect.name || metadata.duration_ms != effect.duration_ms)
                {
                    metadata.name = effect.name;
                    metadata.duration_ms = effect.duration_ms;
                    changed = true;
                }
                continue;
            }
            if self
                .status
                .effects
                .iter()
                .any(|e| e.effect_id == effect.effect_id)
            {
                continue;
            }
            self.prepared.insert(effect.effect_id.clone(), pcm);
            self.status.effects.push(effect);
            changed = true;
        }
        if changed {
            self.publish("audio:state-changed");
        }
    }

    fn publish(&mut self, event: &str) {
        // Solo operaciones observables incrementan revision. La validacion fallida no muta
        // estado, excepto play: todos sus rechazos publican last_error y playback-error.
        self.status.revision += 1;
        (self.emit)(event, &self.status);
    }

    /// Renueva IDs de sesion; un ID de una enumeracion anterior deja de ser seleccionable.
    pub fn list_devices(&mut self) -> Result<Vec<OutputDevice>, AudioError> {
        self.registry = self.driver.enumerate()?;
        Ok(self.registry.iter().map(|(dto, _)| dto.clone()).collect())
    }

    /// Detiene voces y cierra la salida antes de abrir otra; restaura sin reanudar audio.
    pub fn select(&mut self, id: &str) -> Result<DeviceSelectionResult, AudioError> {
        let (dto, device) = self
            .registry
            .iter()
            .find(|(dto, _)| dto.id == id)
            .cloned()
            .ok_or_else(|| {
                AudioError::new(
                    "invalid_device",
                    "Dispositivo desconocido o lista caducada. Actualice la lista.",
                )
            })?;
        let previous = self
            .selected
            .clone()
            .zip(self.status.selected_device.clone());
        self.stop_all();
        self.driver.close();
        self.selected = None;
        let mut restored = false;
        let error = match self
            .driver
            .open(&device, self.master.clone(), self.cutoff.clone())
        {
            Ok(()) => {
                self.selected = Some(device);
                self.status.selected_device = Some(dto);
                self.status.state = EngineState::Ready;
                None
            }
            Err(open_error) => {
                self.driver.close();
                self.status.selected_device = Some(dto);
                self.status.state = EngineState::DeviceError;
                let mut message = format!(
                    "No se pudo abrir la salida solicitada: {}",
                    open_error.message
                );
                if let Some((old_device, old_dto)) = previous {
                    match self
                        .driver
                        .open(&old_device, self.master.clone(), self.cutoff.clone())
                    {
                        Ok(()) => {
                            self.selected = Some(old_device);
                            self.status.selected_device = Some(old_dto);
                            self.status.state = EngineState::Ready;
                            restored = true;
                            message.push_str(
                                " Se restauro la salida anterior sin reanudar reproducciones.",
                            );
                        }
                        Err(restore_error) => {
                            self.driver.close();
                            message.push_str(&format!(
                                " Tampoco se pudo restaurar la salida anterior: {}",
                                restore_error.message
                            ));
                        }
                    }
                }
                Some(AudioError::new("device_open_failed", message))
            }
        };
        self.status.last_error = error.clone();
        self.publish(if error.is_some() {
            "audio:device-error"
        } else {
            "audio:device-changed"
        });
        Ok(DeviceSelectionResult {
            status: self.status.clone(),
            restored_previous: restored,
            error,
        })
    }

    /// Crea una instancia independiente; todo rechazo de disparo se publica sin cortar otras voces.
    pub fn play(&mut self, effect_id: &str) -> Result<String, AudioError> {
        self.play_with_options(effect_id, PlaybackOptions::default())
    }

    /// Dispara opciones validadas para recursos gestionados y senales diagnosticas por igual.
    pub fn play_with_options(
        &mut self,
        effect_id: &str,
        options: PlaybackOptions,
    ) -> Result<String, AudioError> {
        let result = self.try_play(effect_id, options, false);
        if let Err(error) = &result {
            self.status.last_error = Some(error.clone());
            self.publish("audio:playback-error");
        }
        result
    }

    /// Valida antes de cortar todas las voces del recurso y arranca desde cero en el worker.
    /// Si el driver falla despues del corte, publica el error sin restaurar voces antiguas.
    /// El corte invalida las fuentes, pero no retira muestras ya entregadas al buffer del SO.
    pub fn restart(
        &mut self,
        effect_id: &str,
        options: PlaybackOptions,
    ) -> Result<String, AudioError> {
        let result = self.try_play(effect_id, options, true);
        if let Err(error) = &result {
            self.status.last_error = Some(error.clone());
            self.publish("audio:playback-error");
        }
        result
    }

    fn try_play(
        &mut self,
        effect_id: &str,
        options: PlaybackOptions,
        restart: bool,
    ) -> Result<String, AudioError> {
        let effect = self
            .status
            .effects
            .iter()
            .find(|e| e.effect_id == effect_id)
            .ok_or_else(|| AudioError::new("unknown_effect", "El efecto solicitado no existe."))?;
        options.validate(u64::from(effect.duration_ms))?;
        let volume = effect.default_volume;
        validate_volume(volume)?;
        if self.status.state != EngineState::Ready {
            return Err(AudioError::new(
                "output_not_ready",
                "Seleccione una salida disponible antes de reproducir.",
            ));
        }
        let pcm = match self.prepared.get(effect_id) {
            Some(Some(pcm)) => Some(pcm.clone()),
            Some(None) => {
                return Err(AudioError::new(
                    "effect_unavailable",
                    "El archivo esta ausente, es invalido o excede la memoria de precarga. Consulte la biblioteca.",
                ));
            }
            None => None,
        };
        let remaining = self
            .status
            .active_playbacks
            .iter()
            .filter(|voice| !restart || voice.effect_id != effect_id)
            .count();
        if remaining >= usize::from(self.status.max_concurrent_playbacks) {
            return Err(AudioError::new(
                "voice_limit",
                "Se alcanzo el limite de reproducciones simultaneas.",
            ));
        }
        if restart {
            self.stop_effect(effect_id);
        }
        self.next_playback += 1;
        let id = format!("{}:{}", self.status.engine_id, self.next_playback);
        self.driver
            .start_with_options(&id, effect_id, pcm, volume, options)?;
        self.status.active_playbacks.push(Playback {
            playback_id: id.clone(),
            effect_id: effect_id.into(),
            volume,
            looped: options.looped,
            state: PlaybackState::Playing,
            fade_out_ms: options.fade_out_ms,
        });
        self.status.last_error = None;
        self.publish("audio:playback-started");
        Ok(id)
    }

    /// Desactiva loop al terminar la vuelta actual; una salida ya iniciada es irreversible.
    pub fn set_loop(&mut self, id: &str, looped: bool) -> Result<(), AudioError> {
        let voice = self
            .status
            .active_playbacks
            .iter_mut()
            .find(|p| p.playback_id == id)
            .ok_or_else(|| {
                AudioError::new("unknown_playback", "La reproduccion ya no esta activa.")
            })?;
        if voice.looped != looped {
            voice.looped = looped;
            self.driver.set_loop(id, looped);
            self.publish("audio:state-changed");
        }
        Ok(())
    }

    /// Inicia una unica salida; repetir no extiende ni revive la voz. Cero corta inmediatamente.
    pub fn fade_out(&mut self, id: &str, duration_ms: u32) -> Result<(), AudioError> {
        if duration_ms > 30_000 {
            return Err(AudioError::new(
                "invalid_fade",
                "El fade debe estar entre 0 y 30000 ms.",
            ));
        }
        let voice = self
            .status
            .active_playbacks
            .iter_mut()
            .find(|p| p.playback_id == id)
            .ok_or_else(|| {
                AudioError::new("unknown_playback", "La reproduccion ya no esta activa.")
            })?;
        if duration_ms == 0 {
            self.stop(id);
            return Ok(());
        }
        if voice.state != PlaybackState::FadingOut {
            voice.state = PlaybackState::FadingOut;
            voice.fade_out_ms = duration_ms;
            self.driver.fade_out(id, duration_ms);
            self.publish("audio:state-changed");
        }
        Ok(())
    }

    /// Detiene una instancia; repetir la parada o usar una instancia ya finalizada no falla.
    pub fn stop(&mut self, id: &str) {
        if self
            .status
            .active_playbacks
            .iter()
            .any(|p| p.playback_id == id)
        {
            self.driver.stop(id);
            self.status.active_playbacks.retain(|p| p.playback_id != id);
            self.publish("audio:playback-stopped");
        }
    }

    /// Detiene todas las instancias de un efecto, sin afectar a otros recursos.
    pub fn stop_effect(&mut self, effect_id: &str) {
        let ids: Vec<_> = self
            .status
            .active_playbacks
            .iter()
            .filter(|p| p.effect_id == effect_id)
            .map(|p| p.playback_id.clone())
            .collect();
        for id in ids {
            self.stop(&id);
        }
    }

    /// Detiene las voces aceptadas; no existen cargas pendientes que puedan iniciarse despues.
    pub fn stop_all(&mut self) {
        let ids: Vec<_> = self
            .status
            .active_playbacks
            .iter()
            .map(|p| p.playback_id.clone())
            .collect();
        for id in ids {
            self.stop(&id);
        }
    }

    /// Aplica el maestro atomicamente a la mezcla completa, no a las ganancias de instancia.
    pub fn set_master(&mut self, value: f32) -> Result<(), AudioError> {
        validate_volume(value)?;
        if self.status.master_volume != value {
            self.master
                .store(value.to_bits(), std::sync::atomic::Ordering::Relaxed);
            self.status.master_volume = value;
            self.publish("audio:state-changed");
        }
        Ok(())
    }

    /// Cambia exclusivamente una voz activa; una instancia ausente se comunica como error.
    pub fn set_playback(&mut self, id: &str, value: f32) -> Result<(), AudioError> {
        validate_volume(value)?;
        let playback = self
            .status
            .active_playbacks
            .iter_mut()
            .find(|p| p.playback_id == id)
            .ok_or_else(|| {
                AudioError::new("unknown_playback", "La reproduccion ya no esta activa.")
            })?;
        if playback.volume != value {
            playback.volume = value;
            self.driver.set_volume(id, value);
            self.publish("audio:state-changed");
        }
        Ok(())
    }

    /// Cambia el valor por defecto solamente para futuras instancias del efecto.
    pub fn set_effect(&mut self, id: &str, value: f32) -> Result<(), AudioError> {
        validate_volume(value)?;
        let effect = self
            .status
            .effects
            .iter_mut()
            .find(|e| e.effect_id == id)
            .ok_or_else(|| AudioError::new("unknown_effect", "El efecto solicitado no existe."))?;
        if effect.default_volume != value {
            effect.default_volume = value;
            self.publish("audio:state-changed");
        }
        Ok(())
    }

    /// Valida el limite 1..64 y rechaza reducciones por debajo del numero de voces activas.
    pub fn set_limit(&mut self, value: u16) -> Result<(), AudioError> {
        if !(1..=64).contains(&value) || usize::from(value) < self.status.active_playbacks.len() {
            return Err(AudioError::new(
                "invalid_voice_limit",
                "El limite debe estar entre 1 y 64 y no ser menor que las voces activas.",
            ));
        }
        if self.status.max_concurrent_playbacks != value {
            self.status.max_concurrent_playbacks = value;
            self.publish("audio:state-changed");
        }
        Ok(())
    }

    /// Recolecta finalizaciones y fallos fuera del callback, sin fallback de dispositivo.
    pub fn poll(&mut self) {
        if self.driver.failed() && self.status.state == EngineState::Ready {
            self.stop_all();
            self.driver.close();
            self.status.state = EngineState::DeviceError;
            self.status.last_error = Some(AudioError::new(
                "device_disconnected",
                "La salida de audio fallo o se desconecto. Seleccione una salida para recuperarla.",
            ));
            self.publish("audio:device-error");
            return;
        }
        for id in self.driver.finished() {
            let faded = self
                .status
                .active_playbacks
                .iter()
                .any(|p| p.playback_id == id && p.state == PlaybackState::FadingOut);
            let before = self.status.active_playbacks.len();
            self.status.active_playbacks.retain(|p| p.playback_id != id);
            if before != self.status.active_playbacks.len() {
                self.publish(if faded {
                    "audio:playback-stopped"
                } else {
                    "audio:playback-finished"
                });
            }
        }
    }

    /// Libera voces y salida en el propio hilo propietario antes de terminarlo.
    pub fn shutdown(&mut self) {
        self.stop_all();
        self.driver.close();
    }
}

#[cfg(test)]
pub(crate) mod tests;
