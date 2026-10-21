use crate::{
    application::engine::AudioDriver,
    domain::audio::{AudioError, OutputDevice, PlaybackOptions},
    domain::library::PreparedPcm,
};
use rodio::{
    OutputStream, OutputStreamBuilder, Sink, Source,
    cpal::{
        self,
        traits::{DeviceTrait, HostTrait},
    },
    mixer::{self, Mixer},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};

const SAMPLE_RATE: u32 = 48_000;

// La cola comienza con Empty (mono/44100); su formato no describe el PCM ya adaptado.
// Fijarlo evita que el mezclador cree conversiones transitorias dentro del callback.
struct OutputSource<S> {
    source: S,
    channels: u16,
    rate: u32,
}
impl<S: Source> Iterator for OutputSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        self.source.next()
    }
}
impl<S: Source> Source for OutputSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_rate(&self) -> u32 {
        self.rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
}

struct PreparedSource {
    pcm: PreparedPcm,
    position: usize,
}

// Weak apunta al contenedor, no a [f32]: al retirar la voz se puede liberar el buffer grande
// aunque la cola silenciada siga conservando Weak. El render toma una referencia efimera por muestra.
struct VoiceSource {
    pcm: Weak<PreparedPcm>,
    position: usize,
    length: usize,
    channels: u16,
    rate: u32,
    control: Arc<VoiceControl>,
    frames: u64,
    fade_start: Option<(u64, u64, f32)>,
    gain: f32,
    fade_in_frames: u64,
    tail_frames: u64,
}

struct VoiceControl {
    looped: AtomicBool,
    // Cero significa sin solicitud; la primera solicitud positiva es irreversible.
    fade_ms: AtomicU32,
}
impl Iterator for VoiceSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let pcm = self.pcm.upgrade()?;
        if self.position == self.length {
            if !self.control.looped.load(Ordering::Acquire) || self.length == 0 {
                return None;
            }
            self.position = 0;
        }
        if self.position.is_multiple_of(usize::from(self.channels)) {
            let request = self.control.fade_ms.load(Ordering::Acquire);
            if self.fade_start.is_none() && request > 0 {
                self.fade_start = Some((
                    self.frames,
                    (u64::from(request) * u64::from(self.rate) / 1000).max(1),
                    self.gain,
                ));
            }
            if let Some((start, length, gain)) = self.fade_start {
                let elapsed = self.frames - start;
                if elapsed >= length {
                    return None;
                }
                self.gain =
                    gain * (1.0 - elapsed as f32 / length.saturating_sub(1).max(1) as f32).max(0.0);
            } else {
                self.gain = if self.fade_in_frames > 1 {
                    (self.frames as f32 / (self.fade_in_frames - 1) as f32).min(1.0)
                } else {
                    1.0
                };
                if !self.control.looped.load(Ordering::Acquire) && self.tail_frames > 0 {
                    let remaining = (self.length - self.position) / usize::from(self.channels);
                    self.gain *= ((remaining - 1) as f32
                        / self.tail_frames.saturating_sub(1).max(1) as f32)
                        .min(1.0);
                }
            }
            self.frames = self.frames.saturating_add(1);
        }
        let sample = pcm.samples.get(self.position).copied()? * self.gain;
        self.position += 1;
        Some(sample)
    }
}
impl Source for VoiceSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_rate(&self) -> u32 {
        self.rate
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}
impl Iterator for PreparedSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = self.pcm.samples.get(self.position).copied();
        if sample.is_some() {
            self.position += 1;
        }
        sample
    }
}
impl Source for PreparedSource {
    fn current_span_len(&self) -> Option<usize> {
        Some(self.pcm.samples.len() - self.position)
    }
    fn channels(&self) -> u16 {
        self.pcm.channels
    }
    fn sample_rate(&self) -> u32 {
        self.pcm.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        Some(Duration::from_secs_f64(
            self.pcm.samples.len() as f64
                / f64::from(self.pcm.channels)
                / f64::from(self.pcm.sample_rate),
        ))
    }
}

#[cfg(test)]
struct PcmSource {
    samples: Arc<[f32]>,
    position: usize,
}

#[cfg(test)]
impl Iterator for PcmSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = self.samples.get(self.position).copied();
        if sample.is_some() {
            self.position += 1;
        }
        sample
    }
}

#[cfg(test)]
impl Source for PcmSource {
    fn current_span_len(&self) -> Option<usize> {
        Some(self.samples.len() - self.position)
    }
    fn channels(&self) -> u16 {
        1
    }
    fn sample_rate(&self) -> u32 {
        SAMPLE_RATE
    }
    fn total_duration(&self) -> Option<Duration> {
        Some(Duration::from_secs_f64(
            self.samples.len() as f64 / f64::from(SAMPLE_RATE),
        ))
    }
}

/// Saturacion suave comun: acota picos, pero colorea la mezcla; no es un limitador transparente.
fn protect_peak(sample: f32, master: f32) -> f32 {
    if !sample.is_finite() || !master.is_finite() {
        return 0.0;
    }
    0.95 * ((sample * master) / 0.95).tanh()
}

struct ProtectedSource<S> {
    source: S,
    master: Arc<AtomicU32>,
    cutoff: Arc<AtomicBool>,
}

impl<S: Source> Iterator for ProtectedSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        // No consumir el mezclador durante la emergencia: ni locks de Rodio ni espera al worker.
        if self.cutoff.load(Ordering::Acquire) {
            return Some(0.0);
        }
        let sample = self.source.next()?;
        Some(if self.cutoff.load(Ordering::Acquire) {
            0.0
        } else {
            protect_peak(sample, f32::from_bits(self.master.load(Ordering::Relaxed)))
        })
    }
}

impl<S: Source> Source for ProtectedSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> u16 {
        self.source.channels()
    }
    fn sample_rate(&self) -> u32 {
        self.source.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
}

struct LiveSource<S> {
    source: S,
    live: Arc<AtomicBool>,
    _render_lifetime: Arc<()>,
}

impl<S: Source> Iterator for LiveSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if !self.live.load(Ordering::Acquire) {
            return None;
        }
        let sample = self.source.next()?;
        self.live.load(Ordering::Acquire).then_some(sample)
    }
}

impl<S: Source> Source for LiveSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> u16 {
        self.source.channels()
    }
    fn sample_rate(&self) -> u32 {
        self.source.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
}

struct Voice {
    sink: Sink,
    live: Arc<AtomicBool>,
    _pcm: Arc<PreparedPcm>,
    control: Arc<VoiceControl>,
}

impl Drop for Voice {
    fn drop(&mut self) {
        // Invalida incluso muestras ya retenidas por remuestreo o periodic_access del Sink.
        self.live.store(false, Ordering::Release);
        self.sink.stop();
    }
}

pub struct NativeDriver {
    stream: Option<OutputStream>,
    mixer: Option<(Mixer, u16, u32)>,
    voices: HashMap<String, Voice>,
    cache: HashMap<&'static str, Arc<[f32]>>,
    converted: HashMap<String, PreparedPcm>,
    conversion_inputs: HashMap<String, PreparedPcm>,
    render_sources: Vec<Weak<()>>,
    failure: Arc<AtomicBool>,
}

impl NativeDriver {
    /// Retira adaptaciones invalidadas solo cuando ya no tienen voces ni referencias transitorias del render.
    fn prune_stale_conversions(&mut self) {
        self.converted.retain(|id, pcm| {
            self.conversion_inputs.contains_key(id) || Arc::strong_count(&pcm.samples) > 1
        });
    }
    /// Precarga tres senales cortas en memoria sin archivos, dispositivos ni decodificadores.
    pub fn new() -> Self {
        let cache = [
            ("native-test-chime", 880.0, 450),
            ("native-test-pulse", 440.0, 300),
            ("native-test-low", 220.0, 4000),
        ]
        .into_iter()
        .map(|(id, frequency, duration)| {
            let count = SAMPLE_RATE as usize * duration / 1000;
            let samples: Arc<[f32]> = (0..count)
                .map(|i| {
                    let time = i as f32 / SAMPLE_RATE as f32;
                    let envelope =
                        (i as f32 / 480.0).min(1.0) * ((count - 1 - i) as f32 / 1440.0).min(1.0);
                    let pulse = if id == "native-test-pulse" {
                        (std::f32::consts::TAU * 8.0 * time).sin().max(0.0)
                    } else {
                        1.0
                    };
                    0.18 * envelope * pulse * (std::f32::consts::TAU * frequency * time).sin()
                })
                .collect();
            (id, samples)
        })
        .collect();
        Self {
            stream: None,
            mixer: None,
            voices: HashMap::new(),
            cache,
            converted: HashMap::new(),
            conversion_inputs: HashMap::new(),
            render_sources: Vec::new(),
            failure: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Adapta PCM en el worker, nunca en el render: comparte resultados y solo expulsa entradas sin voces fijadas.
    /// Reserva 32 MiB para muestras convertidas y su copia transitoria; un presupuesto agotado rechaza la voz.
    /// La primera pulsacion tras cambiar de salida paga CPU de conversion; no implica una garantia de latencia.
    fn prepare_output(
        &mut self,
        effect: &str,
        pcm: PreparedPcm,
        channels: u16,
        rate: u32,
    ) -> Result<PreparedPcm, AudioError> {
        if pcm.channels == channels && pcm.sample_rate == rate {
            return Ok(pcm);
        }
        if let Some(prepared) = self.converted.get(effect) {
            if self.conversion_inputs.get(effect).is_some_and(|input| {
                input.channels == pcm.channels
                    && input.sample_rate == pcm.sample_rate
                    && Arc::ptr_eq(&input.samples, &pcm.samples)
            }) {
                return Ok(prepared.clone());
            }
            if Arc::strong_count(&prepared.samples) > 1 {
                return Err(AudioError::new(
                    "effect_reload_pending",
                    "El recurso cambio y su adaptacion anterior sigue fijada por voces. Detenga esas voces antes de reproducir la nueva version.",
                ));
            }
            self.converted.remove(effect);
            self.conversion_inputs.remove(effect);
        }
        let frames = (pcm.samples.len() / usize::from(pcm.channels)) as u64;
        let count = (frames * u64::from(rate))
            .div_ceil(u64::from(pcm.sample_rate))
            .saturating_add(4)
            .saturating_mul(u64::from(channels));
        let size = usize::try_from(count)
            .ok()
            .and_then(|count| count.checked_mul(4))
            .ok_or_else(|| {
                AudioError::new(
                    "pcm_budget",
                    "La adaptacion de salida excede el presupuesto de memoria.",
                )
            })?;
        let required = size.saturating_mul(2).saturating_add(2 * 1024 * 1024);
        let capacity = super::decoder::CONVERSION_LIMIT;
        if required > capacity {
            return Err(AudioError::new(
                "pcm_budget",
                "El audio adaptado a esta salida excede la reserva de 32 MiB. Use un efecto mas corto o una salida con menos canales/frecuencia.",
            ));
        }
        let used = self
            .converted
            .values()
            .map(|pcm| pcm.samples.len() * 4)
            .sum::<usize>();
        if required > capacity.saturating_sub(used) {
            self.converted
                .retain(|_, pcm| Arc::strong_count(&pcm.samples) > 1);
            self.conversion_inputs
                .retain(|id, _| self.converted.contains_key(id));
        }
        let used = self
            .converted
            .values()
            .map(|pcm| pcm.samples.len() * 4)
            .sum::<usize>();
        if required > capacity.saturating_sub(used) {
            return Err(AudioError::new(
                "pcm_budget",
                "Las voces activas fijan la memoria de adaptacion de salida. Detenga algunas y vuelva a pulsar.",
            ));
        }
        let mut samples = Vec::new();
        samples.try_reserve_exact(size / 4).map_err(|_| {
            AudioError::new(
                "pcm_budget",
                "No se pudo reservar memoria para adaptar la salida.",
            )
        })?;
        let input = pcm.clone();
        let source = rodio::source::UniformSourceIterator::new(
            PreparedSource { pcm, position: 0 },
            channels,
            rate,
        );
        for sample in source {
            if samples.len() >= size / 4 {
                return Err(AudioError::new(
                    "pcm_budget",
                    "La adaptacion excedio su reserva de memoria.",
                ));
            }
            samples.push(sample);
        }
        let prepared = PreparedPcm {
            samples: Arc::from(samples),
            channels,
            sample_rate: rate,
        };
        self.converted.insert(effect.into(), prepared.clone());
        self.conversion_inputs.insert(effect.into(), input);
        Ok(prepared)
    }
}

impl AudioDriver for NativeDriver {
    type Device = cpal::Device;

    fn enumerate(&mut self) -> Result<Vec<(OutputDevice, Self::Device)>, AudioError> {
        let host = cpal::default_host();
        let default_name = host.default_output_device().and_then(|d| d.name().ok());
        let devices = host.output_devices().map_err(|e| {
            AudioError::new(
                "device_enumeration_failed",
                format!("No se pudieron enumerar las salidas: {e}"),
            )
        })?;
        let mut result: Vec<_> = devices
            .map(|device| {
                let name = device.name().unwrap_or_else(|_| "Salida sin nombre".into());
                (
                    OutputDevice {
                        id: uuid::Uuid::new_v4().to_string(),
                        is_default: default_name.as_ref() == Some(&name),
                        name,
                    },
                    device,
                )
            })
            .collect();
        // CPAL 0.16 no ofrece identidad portable: nombres duplicados no acreditan un predeterminado.
        if result.iter().filter(|(d, _)| d.is_default).count() > 1 {
            for (dto, _) in &mut result {
                dto.is_default = false;
            }
        }
        Ok(result)
    }

    fn open(
        &mut self,
        device: &Self::Device,
        master: Arc<AtomicU32>,
        cutoff: Arc<AtomicBool>,
    ) -> Result<(), AudioError> {
        if self.stream.is_some() {
            return Err(AudioError::new(
                "output_already_open",
                "La salida anterior debe cerrarse primero.",
            ));
        }
        let failure = Arc::new(AtomicBool::new(false));
        let callback_flag = failure.clone();
        let mut stream = OutputStreamBuilder::from_device(device.clone())
            .map_err(|e| {
                AudioError::new(
                    "device_config_failed",
                    format!("No se pudo configurar la salida: {e}"),
                )
            })?
            .with_error_callback(move |_| {
                callback_flag.store(true, Ordering::Relaxed);
            })
            .open_stream()
            .map_err(|e| {
                AudioError::new(
                    "device_open_failed",
                    format!("No se pudo abrir la salida: {e}"),
                )
            })?;
        stream.log_on_drop(false);
        let channels = stream.config().channel_count();
        let rate = stream.config().sample_rate();
        let (mixer, source) = mixer::mixer(channels, rate);
        // Sin silencio permanente Rodio retiraria el mezclador vacio antes del primer disparo.
        mixer.add(rodio::source::Zero::new(channels, rate));
        stream.mixer().add(ProtectedSource {
            source,
            master,
            cutoff,
        });
        self.failure = failure;
        self.mixer = Some((mixer, channels, rate));
        self.stream = Some(stream);
        Ok(())
    }

    fn close(&mut self) {
        self.voices.clear();
        self.mixer = None;
        self.stream = None;
        self.converted.clear();
        self.conversion_inputs.clear();
        self.render_sources.clear();
    }

    fn invalidate_prepared(&mut self, effect: &str) {
        // La voz usa el PCM convertido, no su entrada original. Soltar esta ultima no corta audio.
        self.conversion_inputs.remove(effect);
        self.prune_stale_conversions();
    }

    fn start(&mut self, id: &str, effect: &str, volume: f32) -> Result<(), AudioError> {
        let samples = self
            .cache
            .get(effect)
            .ok_or_else(|| AudioError::new("unknown_effect", "La senal no esta en la cache."))?;
        self.start_prepared(
            id,
            effect,
            PreparedPcm {
                samples: samples.clone(),
                channels: 1,
                sample_rate: SAMPLE_RATE,
            },
            volume,
        )
    }

    fn start_prepared(
        &mut self,
        id: &str,
        effect: &str,
        pcm: PreparedPcm,
        volume: f32,
    ) -> Result<(), AudioError> {
        self.start_with_options(id, effect, Some(pcm), volume, PlaybackOptions::default())
    }

    fn set_loop(&mut self, id: &str, looped: bool) {
        if let Some(voice) = self.voices.get(id) {
            voice.control.looped.store(looped, Ordering::Release);
        }
    }

    fn fade_out(&mut self, id: &str, duration_ms: u32) {
        if let Some(voice) = self.voices.get(id) {
            let _ = voice.control.fade_ms.compare_exchange(
                0,
                duration_ms,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }

    fn start_with_options(
        &mut self,
        id: &str,
        effect: &str,
        pcm: Option<PreparedPcm>,
        volume: f32,
        options: PlaybackOptions,
    ) -> Result<(), AudioError> {
        let pcm = match pcm {
            Some(pcm) => pcm,
            None => PreparedPcm {
                samples: self
                    .cache
                    .get(effect)
                    .ok_or_else(|| {
                        AudioError::new("unknown_effect", "La senal no esta en la cache.")
                    })?
                    .clone(),
                channels: 1,
                sample_rate: SAMPLE_RATE,
            },
        };
        // Acota tambien metadatos de fuentes retiradas si un callback no vuelve a consumir el mixer.
        self.render_sources
            .retain(|source| source.strong_count() > 0);
        if self.render_sources.len() >= 128 {
            return Err(AudioError::new(
                "render_backpressure",
                "La salida no ha retirado sus fuentes anteriores. Seleccione de nuevo la salida para recuperarla; no se cortaron otras voces.",
            ));
        }
        let (mixer, channels, rate) = self.mixer.clone().ok_or_else(|| {
            AudioError::new("output_not_ready", "No hay salida de audio abierta.")
        })?;
        let pcm = Arc::new(self.prepare_output(effect, pcm, channels, rate)?);
        let (sink, queue) = Sink::new();
        sink.set_volume(volume);
        let control = Arc::new(VoiceControl {
            looped: AtomicBool::new(options.looped),
            fade_ms: AtomicU32::new(0),
        });
        sink.append(VoiceSource {
            pcm: Arc::downgrade(&pcm),
            position: 0,
            length: pcm.samples.len(),
            channels: pcm.channels,
            rate: pcm.sample_rate,
            control: control.clone(),
            frames: 0,
            fade_start: None,
            gain: if options.fade_in_ms == 0 { 1.0 } else { 0.0 },
            fade_in_frames: u64::from(options.fade_in_ms) * u64::from(rate) / 1000,
            tail_frames: u64::from(options.fade_out_ms) * u64::from(rate) / 1000,
        });
        let live = Arc::new(AtomicBool::new(true));
        // El PCM ya coincide con la salida: el render solo avanza cursores, ganancias y compuerta.
        let source = OutputSource {
            source: queue,
            channels,
            rate,
        };
        let lifetime = Arc::new(());
        self.render_sources.push(Arc::downgrade(&lifetime));
        mixer.add(LiveSource {
            source,
            live: live.clone(),
            _render_lifetime: lifetime,
        });
        self.voices.insert(
            id.into(),
            Voice {
                sink,
                live,
                _pcm: pcm,
                control,
            },
        );
        Ok(())
    }

    fn stop(&mut self, id: &str) {
        self.voices.remove(id);
        self.prune_stale_conversions();
    }

    fn set_volume(&mut self, id: &str, volume: f32) {
        if let Some(voice) = self.voices.get(id) {
            voice.sink.set_volume(volume);
        }
    }

    fn finished(&mut self) -> Vec<String> {
        let ids: Vec<_> = self
            .voices
            .iter()
            .filter(|(_, voice)| voice.sink.empty())
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            self.voices.remove(id);
        }
        self.prune_stale_conversions();
        ids
    }

    fn failed(&mut self) -> bool {
        self.failure.swap(false, Ordering::Relaxed)
    }
}

#[cfg(test)]
mod performance;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::library::LibraryService;
    use crate::application::worker::{AudioService, Operation, Reply};
    use std::sync::mpsc;

    /// Fuente estereo constante para comprobar endpoints sin Sink, dispositivo ni reloj.
    fn envelope_source(options: PlaybackOptions) -> (Arc<PreparedPcm>, VoiceSource) {
        let pcm = Arc::new(PreparedPcm {
            samples: Arc::from([1.0; 20]),
            channels: 2,
            sample_rate: 1000,
        });
        let source = VoiceSource {
            pcm: Arc::downgrade(&pcm),
            position: 0,
            length: 20,
            channels: 2,
            rate: 1000,
            control: Arc::new(VoiceControl {
                looped: AtomicBool::new(options.looped),
                fade_ms: AtomicU32::new(0),
            }),
            frames: 0,
            fade_start: None,
            gain: if options.fade_in_ms == 0 { 1.0 } else { 0.0 },
            fade_in_frames: u64::from(options.fade_in_ms),
            tail_frames: u64::from(options.fade_out_ms),
        };
        (pcm, source)
    }

    #[test]
    fn stereo_envelopes_are_frame_coherent_with_exact_endpoints_and_no_loop_restart() {
        let (_pcm, mut source) = envelope_source(PlaybackOptions {
            looped: false,
            fade_in_ms: 3,
            fade_out_ms: 3,
        });
        let samples = source.by_ref().collect::<Vec<_>>();
        assert_eq!(samples.len(), 20);
        for pair in samples.as_chunks::<2>().0 {
            assert_eq!(pair[0], pair[1]);
        }
        assert_eq!(&samples[..6], &[0.0, 0.0, 0.5, 0.5, 1.0, 1.0]);
        assert_eq!(&samples[14..], &[1.0, 1.0, 0.5, 0.5, 0.0, 0.0]);
        let (_pcm, mut source) = envelope_source(PlaybackOptions {
            looped: true,
            fade_in_ms: 3,
            fade_out_ms: 3,
        });
        for _ in 0..20 {
            source.next().unwrap();
        }
        assert_eq!(source.next(), Some(1.0));
        assert_eq!(source.next(), Some(1.0));
    }

    #[test]
    fn hundreds_of_loop_turns_keep_same_pcm_and_disabling_finishes_current_turn() {
        let (pcm, mut source) = envelope_source(PlaybackOptions {
            looped: true,
            ..Default::default()
        });
        let pointer = pcm.samples.as_ptr();
        let pins = Arc::strong_count(&pcm.samples);
        for _ in 0..20 * 500 + 4 {
            assert_eq!(source.next(), Some(1.0));
        }
        assert_eq!(pcm.samples.as_ptr(), pointer);
        assert_eq!(Arc::strong_count(&pcm.samples), pins);
        source.control.looped.store(false, Ordering::Release);
        assert_eq!(source.count(), 16);
    }

    #[test]
    fn explicit_fade_advances_only_when_rendered_and_loop_changes_cannot_revive_it() {
        let (_pcm, mut source) = envelope_source(PlaybackOptions {
            looped: true,
            ..Default::default()
        });
        source.next(); // La solicitud entre canales se aplica en el frame siguiente.
        source.control.fade_ms.store(3, Ordering::Release);
        assert_eq!(source.next(), Some(1.0));
        assert_eq!(source.frames, 1);
        assert_eq!(source.next(), Some(1.0));
        assert_eq!(source.next(), Some(1.0));
        source.control.looped.store(false, Ordering::Release);
        source.control.looped.store(true, Ordering::Release);
        assert_eq!(source.next(), Some(0.5));
        assert_eq!(source.next(), Some(0.5));
        assert_eq!(source.next(), Some(0.0));
        assert_eq!(source.next(), Some(0.0));
        assert_eq!(source.next(), None);
        source.control.looped.store(true, Ordering::Release);
        assert_eq!(source.next(), None);
    }

    #[test]
    fn native_fade_counts_until_consumed_emits_stopped_once_and_stop_all_cuts_both_play_paths() {
        let (audio, callback) = offline_cache_service();
        let mut output = callback.recv_timeout(Duration::from_secs(2)).unwrap();
        tauri::async_runtime::block_on(async {
            let options = PlaybackOptions {
                looped: true,
                fade_in_ms: 5,
                fade_out_ms: 25,
            };
            let Reply::PlaybackId(id) = audio
                .request(Operation::PlayWithOptions(
                    "native-test-low".into(),
                    options,
                ))
                .await
                .unwrap()
            else {
                panic!("id")
            };
            audio
                .request(Operation::FadeOut(id.clone(), 20))
                .await
                .unwrap();
            audio
                .request(Operation::Loop(id.clone(), true))
                .await
                .unwrap();
            let Reply::Playbacks(voices) = audio.request(Operation::Playbacks).await.unwrap()
            else {
                panic!("voices")
            };
            assert_eq!(voices.len(), 1);
            assert_eq!(
                voices[0].state,
                crate::domain::audio::PlaybackState::FadingOut
            );
            audio.request(Operation::FadeOut(id, 30000)).await.unwrap();
            for _ in 0..44100 * 2 / 10 {
                output.next();
            }
            let Reply::Playbacks(voices) = audio.request(Operation::Playbacks).await.unwrap()
            else {
                panic!("voices")
            };
            assert!(voices.is_empty());
            for operation in [
                Operation::Play("native-test-low".into()),
                Operation::PlayWithOptions("native-test-low".into(), options),
                Operation::Restart("native-test-low".into(), options),
            ] {
                let Reply::PlaybackId(id) = audio.request(operation).await.unwrap() else {
                    panic!("id")
                };
                audio.request(Operation::FadeOut(id, 30000)).await.unwrap();
                audio.request(Operation::StopAll).await.unwrap();
                assert!(output.by_ref().take(200).all(|v| v == 0.0));
                let Reply::Playbacks(voices) = audio.request(Operation::Playbacks).await.unwrap()
                else {
                    panic!("voices")
                };
                assert!(voices.is_empty());
            }
        });
        audio.shutdown();
    }

    /// Genera un WAV PCM16 pequeno con valor constante y una duracion conocida, sin herramientas ni hardware.
    fn cache_wave(channels: u16, rate: u32, value: i16) -> Vec<u8> {
        let size = 12000 * u32::from(channels) * 2;
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
        for _ in 0..12000 * u32::from(channels) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    /// Publica otra version en SQLite temporal conservando ID y formato; el archivo anterior no se elimina.
    fn replace_cached_file(root: &std::path::Path, id: &str, bytes: &[u8]) {
        use sha2::{Digest, Sha256};
        let relative = format!("audio/{}.bin", uuid::Uuid::new_v4());
        std::fs::write(root.join(&relative), bytes).unwrap();
        let hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        rusqlite::Connection::open(root.join("library.sqlite3"))
            .unwrap()
            .execute(
                "UPDATE sound_effects SET path=?,hash=? WHERE id=?",
                rusqlite::params![relative, hash, id],
            )
            .unwrap();
    }

    /// Abre solamente el mixer en memoria del adaptador de pruebas; todas las voces usan NativeDriver real.
    fn offline_cache_service() -> (
        AudioService,
        mpsc::Receiver<ProtectedSource<rodio::mixer::MixerSource>>,
    ) {
        offline_cache_service_at_rate(44_100)
    }

    /// Configura una salida simulada para probar conversiones reales sin abrir CPAL.
    pub(super) fn offline_cache_service_at_rate(
        rate: u32,
    ) -> (
        AudioService,
        mpsc::Receiver<ProtectedSource<rodio::mixer::MixerSource>>,
    ) {
        let (entered, _waiting) = mpsc::sync_channel(1);
        let (_release, blocked) = mpsc::sync_channel(1);
        let (render, callback) = mpsc::sync_channel(1);
        let audio = AudioService::start(
            move || BlockingDriver {
                native: NativeDriver::new(),
                enumerations: 0,
                entered,
                release: blocked,
                render,
                rate,
            },
            Box::new(|_, _| {}),
        )
        .unwrap();
        tauri::async_runtime::block_on(async {
            audio.request(Operation::Devices).await.unwrap();
            audio
                .request(Operation::Select("fake-output".into()))
                .await
                .unwrap();
        });
        (audio, callback)
    }

    #[test]
    fn package_dedupe_preserves_active_loop_conversion_and_allows_new_plays_at_full_pcm_budget() {
        use crate::domain::library::SoundButton;
        let _serial = crate::infrastructure::library::PACKAGE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_support::tempdir().unwrap();
        let path = temp.path().join("tone.wav");
        std::fs::write(&path, cache_wave(1, 44_100, 2000)).unwrap();
        let library = LibraryService::new(temp.path().join("data"));
        let (audio, callback) = offline_cache_service_at_rate(48_000);
        let mut output = callback.recv_timeout(Duration::from_secs(2)).unwrap();
        tauri::async_runtime::block_on(async {
            let (id, original, bytes) = library
                .access(&audio, move |store| {
                    let result = store.import_paths(vec![path]);
                    assert!(result.failed.is_empty());
                    let id = result.imported[0].effect.id.clone();
                    let pcm = store.pcm[&id].clone();
                    assert_eq!((pcm.channels, pcm.sample_rate), (1, 44_100));
                    let mut board = store.snapshot.board.clone();
                    board.banks[0].buttons.push(SoundButton {
                        id: "button".into(),
                        effect_id: Some(id.clone()),
                        name: "Radio".into(),
                        duration_ms: 0,
                        color: "mint".into(),
                        category: String::new(),
                        playback: PlaybackOptions {
                            looped: true,
                            ..Default::default()
                        },
                    });
                    store.save_board(board, 0)?;
                    let bank = store.snapshot.board.banks[0].id.clone();
                    let (bytes, _, _) = store.export_bank_bytes(&[bank], 1, false)?;
                    store.pcm_budget = pcm.samples.len() * 4 + 1;
                    Ok((id, pcm, bytes))
                })
                .await
                .unwrap();
            library.synchronize(&audio).await.unwrap();
            let options = PlaybackOptions {
                looped: true,
                ..Default::default()
            };
            let Reply::PlaybackId(first) = audio
                .request(Operation::PlayWithOptions(id.clone(), options))
                .await
                .unwrap()
            else {
                panic!("id")
            };
            assert!(
                output
                    .by_ref()
                    .take(48_000 * 2)
                    .fold(0.0_f32, |peak, v| peak.max(v.abs()))
                    > 0.001
            );
            let original_pin = original.clone();
            let cached_id = id.clone();
            library
                .access(&audio, move |store| {
                    let preview = store.prepare_bank_bytes(bytes)?;
                    store.commit_bank_import(&preview.token, 1, false)?;
                    assert!(Arc::ptr_eq(
                        &original_pin.samples,
                        &store.pcm[&cached_id].samples
                    ));
                    Ok(())
                })
                .await
                .unwrap();
            library.synchronize(&audio).await.unwrap();
            audio
                .request(Operation::PlayWithOptions(id.clone(), options))
                .await
                .unwrap();
            audio.request(Operation::Play(id)).await.unwrap();
            let Reply::Playbacks(voices) = audio.request(Operation::Playbacks).await.unwrap()
            else {
                panic!("voices")
            };
            assert_eq!(voices.len(), 3);
            assert!(voices.iter().any(|p| p.playback_id == first && p.looped));
            assert!(output.by_ref().take(48_000 * 2).any(|v| v.abs() > 0.001));
            audio.request(Operation::StopAll).await.unwrap();
        });
        audio.shutdown();
    }

    #[test]
    fn obsolete_idle_native_conversion_cannot_block_replacement_or_imports_under_a_tight_library_budget()
     {
        for mode in ["changed", "missing", "corrupt"] {
            let temp = crate::test_support::tempdir().unwrap();
            let root = temp.path().join("data");
            let source = temp.path().join("old.wav");
            let bytes = cache_wave(1, 8000, 2000);
            std::fs::write(&source, &bytes).unwrap();
            let library = LibraryService::new(root.clone());
            let (audio, callback) = offline_cache_service();
            let mut output = callback.recv_timeout(Duration::from_secs(2)).unwrap();
            tauri::async_runtime::block_on(async {
                let selected = source.clone();
                let id = library
                    .access(&audio, move |store| {
                        // Con el PCM viejo fijado queda reserva + 1,5 PCM; decodificar exige reserva + 2 PCM.
                        store.pcm_budget = 2 * 1024 * 1024 + 48000 * 5 / 2;
                        let result = store.import_paths(vec![selected]);
                        assert!(result.failed.is_empty());
                        Ok(result.imported[0].effect.id.clone())
                    })
                    .await
                    .unwrap();
                library.synchronize(&audio).await.unwrap();
                audio.request(Operation::Play(id.clone())).await.unwrap();
                for _ in 0..44100 * 2 * 2 {
                    output.next().unwrap();
                }
                let Reply::Status(status) = audio.request(Operation::Status).await.unwrap() else {
                    panic!("status")
                };
                assert!(status.active_playbacks.is_empty());
                let replacement = cache_wave(1, 8000, 4000);
                match mode {
                    "changed" => replace_cached_file(&root, &id, &replacement),
                    "missing" => {
                        std::fs::remove_file(root.join(format!("audio/{id}.bin"))).unwrap()
                    }
                    _ => std::fs::write(root.join(format!("audio/{id}.bin")), b"corrupto").unwrap(),
                }
                if mode == "changed" {
                    // Reproduce el bloqueo: sin avisar al actor, repetir solo la carga no libera su pin ocioso.
                    for _ in 0..2 {
                        assert!(
                            library
                                .access(&audio, |store| store.refresh_availability())
                                .await
                                .unwrap()
                        );
                    }
                }
                // Una sola llamada realiza la invalidacion y el reintento; no se cambia la salida.
                library.synchronize(&audio).await.unwrap();
                let expected = if mode == "changed" {
                    "available"
                } else if mode == "missing" {
                    "missing"
                } else {
                    "invalid"
                };
                let state = library
                    .access(&audio, |store| {
                        Ok(store.snapshot.effects[0].availability.clone())
                    })
                    .await
                    .unwrap();
                assert_eq!(state, expected, "{mode}");
                let playable = if mode == "changed" {
                    id
                } else {
                    let path = temp.path().join("new.wav");
                    std::fs::write(&path, &replacement).unwrap();
                    let result = library
                        .access(&audio, move |store| Ok(store.import_paths(vec![path])))
                        .await
                        .unwrap();
                    assert!(result.failed.is_empty(), "{mode}");
                    library.synchronize(&audio).await.unwrap();
                    result.imported[0].effect.id.clone()
                };
                audio.request(Operation::Play(playable)).await.unwrap();
                let Reply::Status(status) = audio.request(Operation::Status).await.unwrap() else {
                    panic!("status")
                };
                assert_eq!(status.selected_device.unwrap().id, "fake-output");
                assert_eq!(status.active_playbacks.len(), 1);
                assert!(callback.try_recv().is_err());
            });
            assert_eq!(std::fs::read(source).unwrap(), bytes);
            audio.shutdown();
        }
    }

    #[test]
    fn genuinely_active_original_pcm_blocks_preload_until_stop_all_then_recovers_without_reselection()
     {
        let temp = crate::test_support::tempdir().unwrap();
        let root = temp.path().join("data");
        let source = temp.path().join("old.wav");
        std::fs::write(&source, cache_wave(2, 44100, 2000)).unwrap();
        let library = LibraryService::new(root.clone());
        let (audio, callback) = offline_cache_service();
        let _not_rendered = callback.recv_timeout(Duration::from_secs(2)).unwrap();
        tauri::async_runtime::block_on(async {
            let id = library
                .access(&audio, move |store| {
                    store.pcm_budget = 2 * 1024 * 1024 + 96000 * 5 / 2;
                    Ok(store
                        .import_paths(vec![source])
                        .imported
                        .remove(0)
                        .effect
                        .id)
                })
                .await
                .unwrap();
            library.synchronize(&audio).await.unwrap();
            audio.request(Operation::Play(id.clone())).await.unwrap();
            replace_cached_file(&root, &id, &cache_wave(2, 44100, 4000));
            library.synchronize(&audio).await.unwrap();
            let state = library
                .access(&audio, |store| {
                    Ok(store.snapshot.effects[0].availability.clone())
                })
                .await
                .unwrap();
            assert_eq!(state, "invalid");
            let Reply::Playbacks(voices) = audio.request(Operation::Playbacks).await.unwrap()
            else {
                panic!("voices")
            };
            assert_eq!(voices.len(), 1);
            audio.request(Operation::StopAll).await.unwrap();
            library.synchronize(&audio).await.unwrap();
            let state = library
                .access(&audio, |store| {
                    Ok(store.snapshot.effects[0].availability.clone())
                })
                .await
                .unwrap();
            assert_eq!(state, "available");
            let Reply::Playbacks(voices) = audio.request(Operation::Playbacks).await.unwrap()
            else {
                panic!("voices")
            };
            assert!(voices.is_empty());
            audio.request(Operation::Play(id)).await.unwrap();
            assert!(callback.try_recv().is_err());
        });
        audio.shutdown();
    }

    #[test]
    fn invalidation_releases_only_input_pins_and_keeps_active_conversions_budgeted_until_stop_or_finish()
     {
        for finish in [false, true] {
            let mut driver = NativeDriver::new();
            let (mixer, mut output) = mixer::mixer(2, 44100);
            mixer.add(rodio::source::Zero::new(2, 44100));
            driver.mixer = Some((mixer, 2, 44100));
            let old = PreparedPcm {
                samples: Arc::from([0.1; 12000]),
                channels: 1,
                sample_rate: 8000,
            };
            let new = PreparedPcm {
                samples: Arc::from([0.2; 12000]),
                channels: 1,
                sample_rate: 8000,
            };
            driver
                .start_prepared("old", "managed", old.clone(), 0.5)
                .unwrap();
            driver.start("other", "native-test-low", 0.5).unwrap();
            let used = driver
                .converted
                .values()
                .map(|pcm| pcm.samples.len() * 4)
                .sum::<usize>();
            assert_eq!(Arc::strong_count(&old.samples), 2);
            driver.invalidate_prepared("managed");
            assert!(!driver.conversion_inputs.contains_key("managed"));
            assert_eq!(Arc::strong_count(&old.samples), 1);
            assert_eq!(Arc::strong_count(&driver.converted["managed"].samples), 2);
            assert_eq!(
                driver
                    .converted
                    .values()
                    .map(|pcm| pcm.samples.len() * 4)
                    .sum::<usize>(),
                used
            );
            assert_eq!(
                driver
                    .start_prepared("early", "managed", new.clone(), 0.5)
                    .unwrap_err()
                    .code,
                "effect_reload_pending"
            );
            assert_eq!(driver.voices.len(), 2);
            if finish {
                for _ in 0..44100 * 2 * 2 {
                    output.next().unwrap();
                }
                assert!(driver.finished().contains(&"old".into()));
            } else {
                driver.stop("old");
            }
            assert!(!driver.converted.contains_key("managed"));
            assert!(driver.voices["other"].live.load(Ordering::Acquire));
            assert!(!driver.voices["other"].sink.empty());
            driver.start_prepared("new", "managed", new, 0.5).unwrap();
            driver.close();
        }
    }

    #[test]
    fn changed_pcm_never_reuses_an_old_adaptation_or_discards_pinned_conversion_memory() {
        let mut driver = NativeDriver::new();
        let (mixer, _not_rendered) = mixer::mixer(2, 48000);
        driver.mixer = Some((mixer, 2, 48000));
        let old = PreparedPcm {
            samples: Arc::from([0.1; 4800]),
            channels: 1,
            sample_rate: 48000,
        };
        let new = PreparedPcm {
            samples: Arc::from([0.2; 4800]),
            channels: 1,
            sample_rate: 48000,
        };
        driver
            .start_prepared("old", "managed", old.clone(), 0.5)
            .unwrap();
        assert_eq!(
            driver
                .start_prepared("too-early", "managed", new.clone(), 0.5)
                .unwrap_err()
                .code,
            "effect_reload_pending"
        );
        assert_eq!(driver.voices.len(), 1);
        assert!(Arc::ptr_eq(
            &driver.conversion_inputs["managed"].samples,
            &old.samples
        ));
        driver.stop("old");
        driver
            .start_prepared("new", "managed", new.clone(), 0.5)
            .unwrap();
        assert!(Arc::ptr_eq(
            &driver.conversion_inputs["managed"].samples,
            &new.samples
        ));
        assert_eq!(Arc::strong_count(&old.samples), 1);
        driver.close();
    }

    #[test]
    fn non_consuming_render_has_bounded_retired_metadata_and_explicit_backpressure() {
        let mut driver = NativeDriver::new();
        let (mixer, _not_rendered) = mixer::mixer(1, SAMPLE_RATE);
        driver.mixer = Some((mixer, 1, SAMPLE_RATE));
        for index in 0..128 {
            let id = format!("voice-{index}");
            driver.start(&id, "native-test-chime", 0.5).unwrap();
            driver.stop(&id);
        }
        assert_eq!(driver.render_sources.len(), 128);
        assert!(driver.voices.is_empty());
        assert_eq!(
            driver
                .start("overflow", "native-test-chime", 0.5)
                .unwrap_err()
                .code,
            "render_backpressure"
        );
        driver.close();
        assert!(driver.render_sources.is_empty());
    }

    #[test]
    fn output_adaptation_budget_pins_active_pcm_and_stop_releases_pins_without_rendering() {
        let mut driver = NativeDriver::new();
        let (mixer, _not_rendered) = mixer::mixer(2, 48000);
        driver.mixer = Some((mixer, 2, 48000));
        // Tres recursos mono distintos caben adaptados; un cuarto excede la reserva transitoria.
        let pcm = PreparedPcm {
            samples: Arc::from(vec![0.1; 900_000]),
            channels: 1,
            sample_rate: 48000,
        };
        for index in 0..3 {
            driver
                .start_prepared(
                    &format!("voice-{index}"),
                    &format!("effect-{index}"),
                    pcm.clone(),
                    0.5,
                )
                .unwrap();
        }
        assert_eq!(driver.converted.len(), 3);
        assert_eq!(
            driver
                .start_prepared("overflow", "effect-new", pcm.clone(), 0.5)
                .unwrap_err()
                .code,
            "pcm_budget"
        );
        assert_eq!(driver.voices.len(), 3);
        for index in 0..3 {
            driver.stop(&format!("voice-{index}"));
        }
        assert!(
            driver
                .converted
                .values()
                .all(|pcm| Arc::strong_count(&pcm.samples) == 1)
        );
        // El mixer viejo nunca avanzo: sus Weak no impiden expulsar cache despues de STOP.
        driver
            .start_prepared("fresh", "effect-new", pcm, 0.5)
            .unwrap();
        assert_eq!(driver.converted.len(), 1);
        assert_eq!(driver.voices.len(), 1);
        driver.close();
        assert!(driver.converted.is_empty());
    }

    #[test]
    fn imported_pcm_multiplay_shares_samples_preserves_format_and_releases_voice_handles() {
        let pcm = crate::infrastructure::decoder::decode(
            include_bytes!("../../tests/fixtures/tone.wav").to_vec(),
            "wav",
            crate::infrastructure::decoder::CACHE_LIMIT,
        )
        .unwrap();
        assert_eq!(pcm.channels, 2);
        assert_eq!(pcm.sample_rate, 44100);
        let mut source = PreparedSource {
            pcm: pcm.clone(),
            position: 0,
        };
        assert_eq!(source.channels(), 2);
        assert_eq!(source.sample_rate(), 44100);
        assert!(source.next().is_some());
        drop(source);
        let mut driver = NativeDriver::new();
        let (mixer, mut output) = mixer::mixer(2, 48000);
        mixer.add(rodio::source::Zero::new(2, 48000));
        driver.mixer = Some((mixer, 2, 48000));
        driver
            .start_prepared("first", "managed", pcm.clone(), 0.5)
            .unwrap();
        driver
            .start_prepared("second", "managed", pcm.clone(), 0.5)
            .unwrap();
        assert_eq!(Arc::strong_count(&pcm.samples), 2);
        assert_eq!(driver.converted["managed"].channels, 2);
        assert_eq!(driver.converted["managed"].sample_rate, 48000);
        assert_eq!(Arc::strong_count(&driver.converted["managed"].samples), 3);
        assert!(
            output
                .by_ref()
                .take(2000)
                .any(|sample| sample.abs() > 0.001)
        );
        driver.stop("first");
        driver.close();
        for _ in 0..48000 {
            let _ = output.next();
        }
        assert_eq!(Arc::strong_count(&pcm.samples), 1);
        assert!(driver.voices.is_empty());
        assert!(driver.stream.is_none());
    }

    struct BlockingDriver {
        native: NativeDriver,
        enumerations: usize,
        entered: mpsc::SyncSender<()>,
        release: mpsc::Receiver<()>,
        render: mpsc::SyncSender<ProtectedSource<rodio::mixer::MixerSource>>,
        rate: u32,
    }

    impl AudioDriver for BlockingDriver {
        type Device = ();
        fn enumerate(&mut self) -> Result<Vec<(OutputDevice, ())>, AudioError> {
            self.enumerations += 1;
            if self.enumerations == 2 {
                self.entered.send(()).unwrap();
                self.release.recv_timeout(Duration::from_secs(5)).unwrap();
            }
            Ok(vec![(
                OutputDevice {
                    id: "fake-output".into(),
                    name: "Salida simulada".into(),
                    is_default: false,
                },
                (),
            )])
        }
        fn open(
            &mut self,
            _: &(),
            master: Arc<AtomicU32>,
            cutoff: Arc<AtomicBool>,
        ) -> Result<(), AudioError> {
            let (mixer, source) = mixer::mixer(2, self.rate);
            mixer.add(rodio::source::Zero::new(2, self.rate));
            self.native.mixer = Some((mixer, 2, self.rate));
            self.render
                .send(ProtectedSource {
                    source,
                    master,
                    cutoff,
                })
                .unwrap();
            Ok(())
        }
        fn close(&mut self) {
            self.native.close();
        }
        fn invalidate_prepared(&mut self, effect: &str) {
            self.native.invalidate_prepared(effect);
        }
        fn start_prepared(
            &mut self,
            id: &str,
            effect: &str,
            pcm: PreparedPcm,
            volume: f32,
        ) -> Result<(), AudioError> {
            self.native.start_prepared(id, effect, pcm, volume)
        }
        fn start(&mut self, id: &str, effect: &str, volume: f32) -> Result<(), AudioError> {
            self.native.start(id, effect, volume)
        }
        fn start_with_options(
            &mut self,
            id: &str,
            effect: &str,
            pcm: Option<PreparedPcm>,
            volume: f32,
            options: PlaybackOptions,
        ) -> Result<(), AudioError> {
            self.native
                .start_with_options(id, effect, pcm, volume, options)
        }
        fn set_loop(&mut self, id: &str, looped: bool) {
            self.native.set_loop(id, looped);
        }
        fn fade_out(&mut self, id: &str, duration_ms: u32) {
            self.native.fade_out(id, duration_ms);
        }
        fn stop(&mut self, id: &str) {
            self.native.stop(id);
        }
        fn set_volume(&mut self, id: &str, volume: f32) {
            self.native.set_volume(id, volume);
        }
        fn finished(&mut self) -> Vec<String> {
            self.native.finished()
        }
        fn failed(&mut self) -> bool {
            false
        }
    }

    #[test]
    fn emergency_renders_zero_while_device_enumeration_blocks_worker_and_only_new_play_rearms() {
        let (entered, waiting) = mpsc::sync_channel(1);
        let (release, blocked) = mpsc::sync_channel(1);
        let (render, callback) = mpsc::sync_channel(1);
        let service = Arc::new(
            AudioService::start(
                move || BlockingDriver {
                    native: NativeDriver::new(),
                    enumerations: 0,
                    entered,
                    release: blocked,
                    render,
                    rate: 44_100,
                },
                Box::new(|_, _| {}),
            )
            .unwrap(),
        );
        let request = |operation| tauri::async_runtime::block_on(service.request(operation));
        assert!(matches!(request(Operation::Devices), Ok(Reply::Devices(_))));
        assert!(matches!(
            request(Operation::Select("fake-output".into())),
            Ok(Reply::Selection(_))
        ));
        let mut output = callback.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            request(Operation::Play("native-test-low".into())),
            Ok(Reply::PlaybackId(_))
        ));
        assert!(output.by_ref().take(2000).any(|sample| sample.abs() > 0.01));
        let refreshing = service.clone();
        let refresh =
            tauri::async_runtime::spawn(
                async move { refreshing.request(Operation::Devices).await },
            );
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut stop = Box::pin(service.request(Operation::StopAll));
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(std::future::Future::poll(stop.as_mut(), &mut context).is_pending());
        assert!(output.cutoff.load(Ordering::Acquire));
        // Render independiente: enum sigue bloqueado y todavia no hay confirmacion de STOP.
        for _ in 0..2000 {
            assert_eq!(output.next(), Some(0.0));
        }
        assert!(std::future::Future::poll(stop.as_mut(), &mut context).is_pending());
        release.send(()).unwrap();
        assert!(matches!(
            tauri::async_runtime::block_on(refresh).unwrap(),
            Ok(Reply::Devices(_))
        ));
        assert!(matches!(
            tauri::async_runtime::block_on(stop),
            Ok(Reply::Unit)
        ));
        assert!(output.cutoff.load(Ordering::Acquire));
        for operation in [
            Operation::Status,
            Operation::Selected,
            Operation::Devices,
            Operation::Master(1.0),
            Operation::EffectVolume("native-test-low".into(), 0.6),
            Operation::Limit(2),
        ] {
            assert!(request(operation).is_ok());
            assert!(output.cutoff.load(Ordering::Acquire));
        }
        assert!(request(Operation::Play("missing".into())).is_err());
        assert!(output.cutoff.load(Ordering::Acquire));
        assert!(request(Operation::Select("fake-output".into())).is_ok());
        output = callback.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(output.cutoff.load(Ordering::Acquire));
        assert_eq!(output.next(), Some(0.0));
        assert!(matches!(
            request(Operation::Play("native-test-low".into())),
            Ok(Reply::PlaybackId(_))
        ));
        assert!(!output.cutoff.load(Ordering::Acquire));
        let samples: Vec<_> = output.by_ref().take(2000).collect();
        assert!(samples.iter().all(|s| s.is_finite() && s.abs() <= 0.95));
        assert!(samples.iter().any(|s| s.abs() > 0.01));
        service.shutdown();
        assert_eq!(output.next(), Some(0.0));
    }

    #[test]
    fn engine_restart_uses_real_live_source_gate_and_restarts_pcm_and_envelope_at_first_frame() {
        use crate::application::engine::Engine;
        use crate::domain::audio::{EngineState, NativeEffect, Playback, PlaybackState};
        let mut driver = NativeDriver::new();
        let (mixer, source) = mixer::mixer(2, 1000);
        mixer.add(rodio::source::Zero::new(2, 1000));
        driver.mixer = Some((mixer, 2, 1000));
        let cutoff = Arc::new(AtomicBool::new(false));
        let mut output = ProtectedSource {
            source,
            master: Arc::new(AtomicU32::new(1.0_f32.to_bits())),
            cutoff: cutoff.clone(),
        };
        let pcm = PreparedPcm {
            samples: Arc::from([0.2, 0.2, 0.3, 0.3, 0.4, 0.4, 0.5, 0.5]),
            channels: 2,
            sample_rate: 1000,
        };
        let loop_options = PlaybackOptions {
            looped: true,
            ..Default::default()
        };
        driver
            .start_with_options("old", "target", Some(pcm.clone()), 1.0, loop_options)
            .unwrap();
        let old_live = driver.voices["old"].live.clone();
        assert_eq!(output.next(), Some(protect_peak(0.2, 1.0)));
        // Queda un canal antiguo pendiente; el corte debe impedir que llegue a la nueva mezcla.
        let mut engine = Engine::new(driver, Box::new(|_, _| {}), cutoff);
        engine.status.state = EngineState::Ready;
        engine.register(vec![(
            NativeEffect {
                effect_id: "target".into(),
                name: "Prueba".into(),
                duration_ms: 4,
                default_volume: 1.0,
            },
            Some(pcm),
        )]);
        engine.status.active_playbacks.push(Playback {
            playback_id: "old".into(),
            effect_id: "target".into(),
            volume: 1.0,
            looped: true,
            state: PlaybackState::Playing,
            fade_out_ms: 0,
        });
        engine.fade_out("old", 30).unwrap();
        let options = PlaybackOptions {
            looped: false,
            fade_in_ms: 3,
            fade_out_ms: 0,
        };
        let new = engine.restart("target", options).unwrap();
        assert!(!old_live.load(Ordering::Acquire));
        assert_eq!(engine.status.active_playbacks.len(), 1);
        assert_eq!(engine.status.active_playbacks[0].playback_id, new);
        // El mixer alinea la fuente nueva al proximo frame; el canal antiguo queda en silencio.
        assert_eq!(output.next(), Some(0.0));
        // Primer frame a ganancia cero y segundo a 1/2: ni cursor ni fade heredados.
        let actual: Vec<_> = output.by_ref().take(8).collect();
        let expected = [0.0, 0.0, 0.15, 0.15, 0.4, 0.4, 0.5, 0.5];
        for (actual, expected) in actual.into_iter().zip(expected) {
            assert!(
                (actual - protect_peak(expected, 1.0)).abs() < 0.00001,
                "{actual} != {expected}"
            );
        }
        assert!(output.by_ref().take(100).all(|sample| sample == 0.0));
        engine.poll();
        assert!(engine.status.active_playbacks.is_empty());
        assert!(!old_live.load(Ordering::Acquire));
        engine.shutdown();
    }

    #[test]
    fn stopped_voice_never_revives_on_fast_rearm_with_buffered_resampled_stereo_frame() {
        let mut driver = NativeDriver::new();
        let (mixer, source) = mixer::mixer(2, 44_100);
        mixer.add(rodio::source::Zero::new(2, 44_100));
        driver.mixer = Some((mixer, 2, 44_100));
        let cutoff = Arc::new(AtomicBool::new(false));
        let mut output = ProtectedSource {
            source,
            master: Arc::new(AtomicU32::new(1.0_f32.to_bits())),
            cutoff: cutoff.clone(),
        };
        driver.start("old", "native-test-low", 1.0).unwrap();
        // Numero impar: queda un canal del frame normalizado pendiente, ademas del resampler.
        assert!(
            output
                .by_ref()
                .take(2001)
                .fold(0.0_f32, |peak, sample| peak.max(sample.abs()))
                > 0.01
        );
        let live = driver.voices["old"].live.clone();
        cutoff.store(true, Ordering::Release);
        driver.stop("old");
        assert!(!live.load(Ordering::Acquire));
        // Sin consumir ni una muestra entre stop y rearme: periodic_access no pudo observar stop.
        driver.start("new-silent", "native-test-low", 0.0).unwrap();
        cutoff.store(false, Ordering::Release);
        for _ in 0..1000 {
            assert_eq!(output.next(), Some(0.0));
        }
        assert!(!live.load(Ordering::Acquire));
        driver.stop("new-silent");
        driver.start("new-audible", "native-test-low", 0.7).unwrap();
        let samples: Vec<_> = output.by_ref().take(2000).collect();
        assert!(samples.iter().all(|s| s.is_finite() && s.abs() <= 0.95));
        assert!(samples.iter().any(|s| s.abs() > 0.01));
        driver.close();
        for _ in 0..1000 {
            assert_eq!(output.next(), Some(0.0));
        }
    }

    #[test]
    fn peak_protection_is_finite_bounded_odd_and_silent_at_zero_master() {
        for sample in [-f32::MAX, -64.0, -1.0, -0.1, 0.0, 0.1, 1.0, 64.0, f32::MAX] {
            for gain in [0.0, 0.5, 1.0] {
                let value = protect_peak(sample, gain);
                assert!(value.is_finite() && value.abs() <= 0.95);
                assert_eq!(value, -protect_peak(-sample, gain));
            }
            assert_eq!(protect_peak(sample, 0.0), 0.0);
        }
        assert_eq!(protect_peak(f32::NAN, 1.0), 0.0);
        assert_eq!(protect_peak(f32::INFINITY, 1.0), 0.0);
    }

    #[test]
    fn cache_is_fixed_bounded_enveloped_and_independent_per_instance() {
        let driver = NativeDriver::new();
        assert_eq!(driver.cache.len(), 3);
        assert!(driver.stream.is_none());
        for samples in driver.cache.values() {
            assert_eq!(samples[0], 0.0);
            assert_eq!(samples[samples.len() - 1], 0.0);
            assert!(samples.iter().all(|s| s.is_finite() && s.abs() <= 0.18));
            let mut first = PcmSource {
                samples: samples.clone(),
                position: 0,
            };
            let mut second = PcmSource {
                samples: samples.clone(),
                position: 0,
            };
            for _ in 0..100 {
                first.next();
            }
            assert_eq!(second.next(), Some(0.0));
            assert_eq!(first.current_span_len(), Some(samples.len() - 100));
            assert_eq!(first.by_ref().count(), samples.len() - 100);
            assert_eq!(first.current_span_len(), Some(0));
            assert_eq!(first.next(), None);
        }
        let engine = crate::application::engine::Engine::new(
            crate::application::engine::tests::FakeDriver::default(),
            Box::new(|_, _| {}),
            Arc::new(AtomicBool::new(false)),
        );
        for effect in &engine.status.effects {
            let samples = &driver.cache[effect.effect_id.as_str()];
            assert_eq!(
                samples.len(),
                SAMPLE_RATE as usize * effect.duration_ms as usize / 1000
            );
        }
        assert_eq!(
            engine
                .status
                .effects
                .iter()
                .map(|effect| effect.duration_ms)
                .collect::<Vec<_>>(),
            [450, 300, 4000]
        );
        assert_eq!(driver.cache["native-test-low"].len() * 4, 768_000);
        assert!(driver.cache.values().map(|s| s.len() * 4).sum::<usize>() < 1_100_000);
    }

    #[test]
    fn protected_shared_mixer_survives_idle_and_cleans_finished_sinks() {
        let (mixer, source) = mixer::mixer(1, SAMPLE_RATE);
        mixer.add(rodio::source::Zero::new(1, SAMPLE_RATE));
        let master = Arc::new(AtomicU32::new(1.0_f32.to_bits()));
        let mut output = ProtectedSource {
            source,
            master: master.clone(),
            cutoff: Arc::new(AtomicBool::new(false)),
        };
        for _ in 0..100 {
            assert_eq!(output.next(), Some(0.0));
        }
        let mut sinks = Vec::new();
        for _ in 0..64 {
            let sink = Sink::connect_new(&mixer);
            sink.append(rodio::buffer::SamplesBuffer::new(
                1,
                SAMPLE_RATE,
                vec![0.18; 200],
            ));
            sinks.push(sink);
        }
        for _ in 0..100 {
            assert!(
                output
                    .next()
                    .is_some_and(|s| s.is_finite() && s.abs() <= 0.95)
            );
        }
        master.store(0.0_f32.to_bits(), Ordering::Relaxed);
        for _ in 0..500 {
            assert_eq!(output.next(), Some(0.0));
        }
        assert!(sinks.iter().all(Sink::empty));
        master.store(1.0_f32.to_bits(), Ordering::Relaxed);
        let sink = Sink::connect_new(&mixer);
        sink.append(rodio::buffer::SamplesBuffer::new(
            1,
            SAMPLE_RATE,
            vec![0.1; 100],
        ));
        assert!(output.by_ref().take(1000).any(|s| s > 0.0));
    }

    #[test]
    fn native_pcm_instances_finish_and_release_sinks_after_stereo_resampling() {
        let mut driver = NativeDriver::new();
        let (mixer, source) = mixer::mixer(2, 44_100);
        mixer.add(rodio::source::Zero::new(2, 44_100));
        driver.mixer = Some((mixer, 2, 44_100));
        let mut output = ProtectedSource {
            source,
            master: Arc::new(AtomicU32::new(0.7_f32.to_bits())),
            cutoff: Arc::new(AtomicBool::new(false)),
        };
        let voices = [
            ("chime-a", "native-test-chime"),
            ("chime-b", "native-test-chime"),
            ("pulse", "native-test-pulse"),
            ("low-a", "native-test-low"),
            ("low-b", "native-test-low"),
        ];
        for (id, effect) in voices {
            driver.start(id, effect, 0.5).unwrap();
        }
        assert_eq!(driver.voices.len(), voices.len());
        let mut peak = 0.0_f32;
        // Un segundo conserva ambas voces graves, pero libera chime y pulse.
        for _ in 0..44_100 {
            let left = output.next().unwrap();
            let right = output.next().unwrap();
            assert!(left.is_finite() && left.abs() <= 0.95);
            assert_eq!(left, right);
            peak = peak.max(left.abs());
        }
        assert!(peak > 0.01);
        let mut finished = driver.finished();
        finished.sort();
        assert_eq!(finished, ["chime-a", "chime-b", "pulse"]);
        assert_eq!(driver.voices.len(), 2);
        driver.set_volume("low-a", 0.2);
        // Consume hasta 4,1 segundos: incluye margen acotado para remuestreo y controles del Sink.
        for _ in 0..(44_100 * 2 * 31 / 10) {
            assert!(
                output
                    .next()
                    .is_some_and(|sample| sample.is_finite() && sample.abs() <= 0.95)
            );
        }
        let mut finished = driver.finished();
        finished.sort();
        assert_eq!(finished, ["low-a", "low-b"]);
        assert!(driver.voices.is_empty());
        assert!(driver.finished().is_empty());
        for _ in 0..1000 {
            assert_eq!(output.next(), Some(0.0));
        }
        assert!(driver.stream.is_none());
        driver.close();
    }

    #[test]
    #[ignore = "Requiere seleccion explicita: RADIOFX_TEST_OUTPUT_NAME; abre salida sin reproducir senales"]
    fn explicitly_selected_real_output_opens_without_playing() {
        let name = std::env::var("RADIOFX_TEST_OUTPUT_NAME")
            .expect("Indique el nombre exacto de la salida autorizada");
        let mut driver = NativeDriver::new();
        let devices = driver.enumerate().expect("enumeracion");
        let matches: Vec<_> = devices.iter().filter(|(dto, _)| dto.name == name).collect();
        assert_eq!(matches.len(), 1, "La seleccion debe ser unica");
        driver
            .open(
                &matches[0].1,
                Arc::new(AtomicU32::new(0.0_f32.to_bits())),
                Arc::new(AtomicBool::new(false)),
            )
            .expect("apertura");
        driver.close();
    }
}
