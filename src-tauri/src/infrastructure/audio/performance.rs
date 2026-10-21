//! Benchmark opt-in de software: consume el mezclador real sin CPAL, GUI ni datos de usuario.
//! Ejecutar solo con cargo test --release --locked --offline offline_audio_benchmark -- --ignored --nocapture --test-threads=1.

use super::*;
use crate::application::worker::{Operation, Reply};
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    path::Path,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const CHANNELS: u16 = 2;
const BLOCK_FRAMES: usize = 512;
const WARMUP_BLOCKS: usize = 100;
const ITERATIONS: usize = 200;
const STRESS_CYCLES: usize = 500;
const STOP_ITERATIONS: usize = 100;
type Render = ProtectedSource<rodio::mixer::MixerSource>;

/// Interpreta ausencia o cadena vacia como informe desactivado; conserva rutas nativas sin recortar.
fn report_path(value: Option<&OsStr>) -> Option<&Path> {
    value.filter(|path| !path.is_empty()).map(Path::new)
}

/// Calcula muestras por bloque; rechaza formatos vacios y desbordamientos.
fn block_samples(frames: usize, channels: u16) -> Option<usize> {
    (frames > 0 && channels > 0)
        .then(|| frames.checked_mul(usize::from(channels)))
        .flatten()
}

/// Percentil por rango mas cercano, sin interpolacion; rechaza vacios y valores invalidos.
fn percentile(values: &[f64], quantile: f64) -> Option<f64> {
    if values.is_empty()
        || !quantile.is_finite()
        || !(0.0..=1.0).contains(&quantile)
        || values.iter().any(|v| !v.is_finite() || *v < 0.0)
    {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() as f64 * quantile).ceil() as usize).saturating_sub(1);
    sorted.get(index).copied()
}

/// Serializa duraciones en microsegundos usando el mismo estimador para todas las series.
fn distribution(values: &[f64]) -> Value {
    json!({
        "count": values.len(), "unit": "microseconds", "estimator": "nearest-rank",
        "p50": percentile(values, 0.50).unwrap(),
        "p95": percentile(values, 0.95).unwrap(),
        "p99": percentile(values, 0.99).unwrap()
    })
}

/// Consume exactamente un bloque real; comprueba finitud y proteccion sin reservar memoria.
fn render_block(output: &mut impl Iterator<Item = f32>, samples: usize) -> f32 {
    assert!(samples > 0);
    let mut peak = 0.0_f32;
    for _ in 0..samples {
        let value = output
            .next()
            .expect("El render debe mantener la fuente de silencio");
        assert!(value.is_finite() && value.abs() <= 0.950001);
        peak = peak.max(value.abs());
    }
    std::hint::black_box(peak)
}

/// Configura solo el mixer en memoria: nunca llama a enumerate/open del driver nativo.
fn offline_driver() -> (NativeDriver, Render) {
    let mut driver = NativeDriver::new();
    let (mixer, source) = mixer::mixer(CHANNELS, SAMPLE_RATE);
    mixer.add(rodio::source::Zero::new(CHANNELS, SAMPLE_RATE));
    driver.mixer = Some((mixer, CHANNELS, SAMPLE_RATE));
    let output = ProtectedSource {
        source,
        master: Arc::new(AtomicU32::new(0.7_f32.to_bits())),
        cutoff: Arc::new(AtomicBool::new(false)),
    };
    (driver, output)
}

/// Observa recursos propios del driver, no memoria total ni capacidad retenida del allocator.
fn resources(driver: &NativeDriver) -> Value {
    json!({
        "activeVoices": driver.voices.len(),
        "renderSources": driver.render_sources.len(),
        "liveRenderSources": driver.render_sources.iter().filter(|s| s.strong_count() > 0).count(),
        "converted": driver.converted.len(), "conversionInputs": driver.conversion_inputs.len(),
        "convertedSamples": driver.converted.values().map(|p| p.samples.len()).sum::<usize>(),
        "convertedSampleStrongCounts": driver.converted.values().map(|p| Arc::strong_count(&p.samples)).collect::<Vec<_>>()
    })
}

/// Lee RSS solo entre fases y fuera del render; no impone estabilidad al allocator del proceso.
fn rss_kib() -> Option<u64> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("VmRSS:")?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    })
}

/// Mide bloques con voces en loop y conversion precalentada; valida silencio y liberacion final.
fn mixing_scenario(voices: usize) -> Value {
    let samples = block_samples(BLOCK_FRAMES, CHANNELS).unwrap();
    let (mut driver, mut output) = offline_driver();
    let ids: Vec<_> = (0..voices).map(|i| format!("voice-{i}")).collect();
    let options = PlaybackOptions {
        looped: true,
        ..Default::default()
    };
    for id in &ids {
        driver
            .start_with_options(id, "native-test-chime", None, 0.5, options)
            .unwrap();
    }
    assert_eq!(driver.voices.len(), voices);
    assert!(driver.stream.is_none());
    assert_eq!(driver.converted.len(), 1);
    let converted = &driver.converted["native-test-chime"].samples;
    let pointer = converted.as_ptr();
    let pins = Arc::strong_count(converted);
    assert_eq!(pins, voices + 1);
    for _ in 0..WARMUP_BLOCKS {
        render_block(&mut output, samples);
    }
    let mut timings = Vec::with_capacity(ITERATIONS);
    let mut peak = 0.0_f32;
    for _ in 0..ITERATIONS {
        let start = Instant::now();
        let block_peak = render_block(&mut output, samples);
        timings.push(start.elapsed().as_secs_f64() * 1e6);
        peak = peak.max(block_peak);
    }
    assert!(peak > 0.0);
    assert_eq!(
        driver.converted["native-test-chime"].samples.as_ptr(),
        pointer
    );
    assert_eq!(
        Arc::strong_count(&driver.converted["native-test-chime"].samples),
        pins
    );
    let active = resources(&driver);
    output.master.store(0.0_f32.to_bits(), Ordering::Relaxed);
    assert_eq!(render_block(&mut output, samples), 0.0);
    for id in ids {
        driver.stop(&id);
    }
    output.master.store(0.7_f32.to_bits(), Ordering::Relaxed);
    assert_eq!(render_block(&mut output, samples), 0.0);
    assert!(driver.voices.is_empty());
    assert!(driver.render_sources.iter().all(|s| s.strong_count() == 0));
    assert_eq!(
        Arc::strong_count(&driver.converted["native-test-chime"].samples),
        1
    );
    let retired = resources(&driver);
    driver.close();
    let closed = resources(&driver);
    assert!(driver.converted.is_empty() && driver.render_sources.is_empty());
    let elapsed_us: f64 = timings.iter().sum();
    let audio_seconds = (ITERATIONS * BLOCK_FRAMES) as f64 / f64::from(SAMPLE_RATE);
    assert!(elapsed_us.is_finite() && elapsed_us > 0.0);
    json!({
        "voices": voices, "blockRender": distribution(&timings), "peakSampleAmplitude": peak,
        "processedSamples": ITERATIONS * samples, "representedAudioSeconds": audio_seconds,
        "softwareRealtimeFactor": audio_seconds / (elapsed_us / 1e6),
        "softwareRealtimeFactorDefinition": "segundos PCM representados / segundos de render medido; no porcentaje CPU",
        "activeResources": active, "retiredResources": retired, "closedResources": closed,
        "masterZeroSilent": true
    })
}

/// Separa coste frio/caliente de adaptacion mono-estereo, sin incluir construccion ni render.
fn conversion_cost() -> Value {
    let (mut driver, _output) = offline_driver();
    let pcm = PreparedPcm {
        samples: driver.cache["native-test-chime"].clone(),
        channels: 1,
        sample_rate: SAMPLE_RATE,
    };
    let start = Instant::now();
    let prepared = driver
        .prepare_output("conversion", pcm.clone(), CHANNELS, SAMPLE_RATE)
        .unwrap();
    let cold = start.elapsed().as_secs_f64() * 1e6;
    let mut warm = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let start = Instant::now();
        let next = driver
            .prepare_output("conversion", pcm.clone(), CHANNELS, SAMPLE_RATE)
            .unwrap();
        warm.push(start.elapsed().as_secs_f64() * 1e6);
        assert!(Arc::ptr_eq(&prepared.samples, &next.samples));
        std::hint::black_box(next);
    }
    assert!(cold.is_finite());
    json!({"coldMicroseconds": cold, "coldCount": 1, "warm": distribution(&warm),
        "inputChannels": 1, "outputChannels": CHANNELS, "inputFrames": pcm.samples.len(),
        "outputSamples": prepared.samples.len(), "scope": "prepare_output mono a estereo; no decode ni arranque"})
}

/// Alterna final natural y STOP de 16 voces cortas; compara handles y pools tras cada limpieza.
fn stress() -> Value {
    let samples = block_samples(BLOCK_FRAMES, CHANNELS).unwrap();
    let (mut driver, mut output) = offline_driver();
    let pcm = PreparedPcm {
        samples: Arc::from([0.1; 128]),
        channels: 1,
        sample_rate: SAMPLE_RATE,
    };
    let ids: Vec<_> = (0..16).map(|i| format!("stress-{i}")).collect();
    let mut baseline = Value::Null;
    let mut rss_warmup = None;
    let mut stopped_active_cycles = 0;
    let mut natural_finish_cycles = 0;
    for cycle in 0..STRESS_CYCLES + 1 {
        for id in &ids {
            driver
                .start_prepared(id, "stress", pcm.clone(), 0.5)
                .unwrap();
        }
        assert_eq!(driver.voices.len(), 16);
        assert_eq!(Arc::strong_count(&driver.converted["stress"].samples), 17);
        if cycle % 2 == 0 {
            assert!(render_block(&mut output, samples) > 0.0);
            assert_eq!(driver.finished().len(), 16);
            if cycle > 0 {
                natural_finish_cycles += 1;
            }
        } else {
            assert!(render_block(&mut output, block_samples(32, CHANNELS).unwrap()) > 0.0);
            assert_eq!(driver.voices.len(), 16);
            assert!(driver.voices.values().all(|voice| !voice.sink.empty()));
            for id in &ids {
                driver.stop(id);
            }
            stopped_active_cycles += 1;
        }
        assert_eq!(render_block(&mut output, samples), 0.0);
        // Misma poda de metadatos muertos que start_with_options; no borra fuentes vivas.
        driver.render_sources.retain(|s| s.strong_count() > 0);
        assert!(driver.voices.is_empty() && driver.render_sources.is_empty());
        assert_eq!(Arc::strong_count(&driver.converted["stress"].samples), 1);
        assert_eq!(Arc::strong_count(&pcm.samples), 2);
        if cycle == 0 {
            baseline = resources(&driver);
            rss_warmup = rss_kib();
        } else {
            assert_eq!(resources(&driver), baseline);
        }
    }
    let end = resources(&driver);
    let rss_end = rss_kib();
    assert_eq!(stopped_active_cycles, STRESS_CYCLES / 2);
    assert_eq!(natural_finish_cycles, STRESS_CYCLES / 2);
    assert_eq!(stopped_active_cycles + natural_finish_cycles, STRESS_CYCLES);
    driver.close();
    assert_eq!(Arc::strong_count(&pcm.samples), 1);
    assert!(driver.conversion_inputs.is_empty() && driver.converted.is_empty());
    json!({"cycles": STRESS_CYCLES, "warmupCycles": 1, "voicesPerCycle": 16,
        "stoppedActiveCycles": stopped_active_cycles, "naturalFinishCycles": natural_finish_cycles,
        "sourceFrames": 128, "framesBeforeActiveStop": 32,
        "baseline": baseline, "end": end, "closed": resources(&driver),
        "rssWarmupKiB": rss_warmup, "rssEndKiB": rss_end,
        "rssScope": "proceso completo; observacion, no asercion de estabilidad ni propiedad del heap"})
}

/// Mide ACK del worker real y corte al siguiente render, no latencia OS/audible ni IPC WebView.
fn command_latency() -> Value {
    let (service, callback) = super::tests::offline_cache_service_at_rate(SAMPLE_RATE);
    let mut output = callback.recv_timeout(Duration::from_secs(5)).unwrap();
    let samples = block_samples(BLOCK_FRAMES, CHANNELS).unwrap();
    let request = |operation| tauri::async_runtime::block_on(service.request(operation)).unwrap();
    request(Operation::Limit(64));
    let Reply::Status(status) = request(Operation::Status) else {
        panic!("Instantanea requerida")
    };
    assert_eq!(status.state, crate::domain::audio::EngineState::Ready);
    assert_eq!(status.max_concurrent_playbacks, 64);
    for _ in 0..64 {
        request(Operation::PlayWithOptions(
            "native-test-chime".into(),
            PlaybackOptions {
                looped: true,
                ..Default::default()
            },
        ));
    }
    let Reply::Status(status) = request(Operation::Status) else {
        panic!("Instantanea requerida")
    };
    assert_eq!(status.active_playbacks.len(), 64);
    assert_eq!(
        tauri::async_runtime::block_on(
            service.request(Operation::Play("native-test-chime".into()))
        )
        .err()
        .unwrap()
        .code,
        "voice_limit"
    );
    assert!(render_block(&mut output, samples) > 0.0);
    request(Operation::StopAll);
    let mut plays = Vec::with_capacity(STOP_ITERATIONS);
    let mut stops = Vec::with_capacity(STOP_ITERATIONS);
    let mut cuts = Vec::with_capacity(STOP_ITERATIONS);
    // Precalienta runtime, worker, conversion y render antes de recoger tiempos.
    for iteration in 0..WARMUP_BLOCKS + STOP_ITERATIONS {
        let start = Instant::now();
        assert!(matches!(
            request(Operation::PlayWithOptions(
                "native-test-chime".into(),
                PlaybackOptions {
                    looped: true,
                    ..Default::default()
                }
            )),
            Reply::PlaybackId(_)
        ));
        let play_us = start.elapsed().as_secs_f64() * 1e6;
        assert!(render_block(&mut output, samples) > 0.0);
        let start = Instant::now();
        assert!(matches!(request(Operation::StopAll), Reply::Unit));
        let stop_us = start.elapsed().as_secs_f64() * 1e6;
        assert_eq!(render_block(&mut output, samples), 0.0);
        // Otro disparo separa el ensayo de corte de la medida de ACK sin render intermedio.
        request(Operation::PlayWithOptions(
            "native-test-chime".into(),
            PlaybackOptions {
                looped: true,
                ..Default::default()
            },
        ));
        assert!(render_block(&mut output, samples) > 0.0);
        let mut stop = Box::pin(service.request(Operation::StopAll));
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        let start = Instant::now();
        let polled = std::future::Future::poll(stop.as_mut(), &mut context);
        assert!(output.cutoff.load(Ordering::Acquire));
        assert_eq!(render_block(&mut output, samples), 0.0);
        let cut_us = start.elapsed().as_secs_f64() * 1e6;
        match polled {
            std::task::Poll::Ready(reply) => {
                assert!(matches!(reply.unwrap(), Reply::Unit));
            }
            std::task::Poll::Pending => {
                assert!(matches!(
                    tauri::async_runtime::block_on(stop).unwrap(),
                    Reply::Unit
                ));
            }
        }
        let Reply::Status(status) = request(Operation::Status) else {
            panic!("Instantanea requerida")
        };
        assert!(status.active_playbacks.is_empty());
        if iteration >= WARMUP_BLOCKS {
            plays.push(play_us);
            stops.push(stop_us);
            cuts.push(cut_us);
        }
    }
    service.shutdown();
    json!({"playAck": distribution(&plays), "stopAck": distribution(&stops),
        "stopCutThroughNextBlock": distribution(&cuts), "configuredVoiceLimit": 64,
        "scope": "AudioService + Engine + NativeDriver offline; ACK y corte medidos en ensayos separados; sin latencia fisica"})
}

/// Ejecuta solo en perfil sin debug_assertions y escribe informe unicamente por opt-in del desarrollador.
#[test]
#[ignore = "Benchmark offline opt-in; requiere --release y filtro offline_audio_benchmark"]
fn offline_audio_benchmark() {
    if cfg!(debug_assertions) {
        panic!(
            "Benchmark rechazado en debug: use cargo test --release --locked --offline offline_audio_benchmark -- --ignored --nocapture --test-threads=1"
        );
    }
    let report = json!({
        "schemaVersion": 1, "benchmark": "offline_audio_benchmark",
        "timestampUnixMilliseconds": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(),
        "targetOS": std::env::consts::OS, "targetArch": std::env::consts::ARCH,
        "profile": {"debugAssertions": cfg!(debug_assertions), "optimizedProfileRequired": true},
        "parameters": {"sampleRate": SAMPLE_RATE, "channels": CHANNELS, "blockFrames": BLOCK_FRAMES,
            "blockSamples": block_samples(BLOCK_FRAMES, CHANNELS).unwrap(), "warmupBlocks": WARMUP_BLOCKS,
            "iterations": ITERATIONS, "stopIterations": STOP_ITERATIONS},
        "conversion": conversion_cost(),
        "mixing": [mixing_scenario(1), mixing_scenario(16), mixing_scenario(64)],
        "commands": command_latency(), "stress": stress(),
        "limitations": ["Solo software offline; no salida, CPAL, GUI ni datos de usuario",
            "No garantiza p95 audible <50 ms, CPU porcentual, RSS estable ni soporte de hardware",
            "Render cronometrado incluye comprobaciones numericas; no incluye compilacion ni arranque del worker",
            "Versiones de herramientas y flags adicionales deben registrarse por el runner"]
    });
    let line = serde_json::to_string(&report).unwrap();
    let destination = std::env::var_os("RADIOFX_BENCH_REPORT");
    if let Some(path) = report_path(destination.as_deref()) {
        // Ruta de desarrollador confiable, no IPC. Solo informes temporales, sin sobrescritura.
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .expect("RADIOFX_BENCH_REPORT debe ser una ruta nueva de informe temporal");
        writeln!(file, "{line}").unwrap();
    }
    println!("{line}");
}

/// Comprueba rangos cercanos, extremos y singleton con datos deterministas.
#[test]
fn percentile_uses_nearest_rank() {
    let values: Vec<_> = (1..=100).rev().map(f64::from).collect();
    for (quantile, expected) in [
        (0.0, 1.0),
        (0.5, 50.0),
        (0.95, 95.0),
        (0.99, 99.0),
        (1.0, 100.0),
    ] {
        assert_eq!(percentile(&values, quantile), Some(expected));
    }
    assert_eq!(percentile(&[3.0], 0.99), Some(3.0));
}

/// Rechaza series vacias, negativas/no finitas y cuantiles fuera de dominio.
#[test]
fn percentile_rejects_invalid_input() {
    assert_eq!(percentile(&[], 0.5), None);
    for value in [f64::NAN, f64::INFINITY, -1.0] {
        assert_eq!(percentile(&[value], 0.5), None);
    }
    for q in [f64::NAN, f64::INFINITY, -0.01, 1.01] {
        assert_eq!(percentile(&[1.0], q), None);
    }
}

/// Impide confundir frames con muestras y bloquea tamanos nulos/desbordados.
#[test]
fn block_sample_count_is_checked() {
    assert_eq!(block_samples(512, 2), Some(1024));
    assert_eq!(block_samples(0, 2), None);
    assert_eq!(block_samples(512, 0), None);
    assert_eq!(block_samples(usize::MAX, 2), None);
}

/// Valida el recorrido de estres y sus invariantes sin ejecutar ni publicar tiempos de benchmark.
#[test]
fn offline_stress_releases_handles_and_keeps_conversion_pool_bounded() {
    let report = stress();
    assert_eq!(report["stoppedActiveCycles"], 250);
    assert_eq!(report["naturalFinishCycles"], 250);
    assert_eq!(report["baseline"], report["end"]);
    assert_eq!(report["closed"]["activeVoices"], 0);
    assert_eq!(report["closed"]["renderSources"], 0);
    assert_eq!(report["closed"]["converted"], 0);
}

/// Ausencia y vacio desactivan el informe sin alterar rutas validas ni consultar el entorno global.
#[test]
fn report_path_skips_missing_and_empty_values_and_preserves_paths() {
    assert_eq!(report_path(None), None);
    assert_eq!(report_path(Some(OsStr::new(""))), None);
    for path in ["report.json", "/tmp/report.json", " report.json "] {
        assert_eq!(report_path(Some(OsStr::new(path))), Some(Path::new(path)));
    }
}
