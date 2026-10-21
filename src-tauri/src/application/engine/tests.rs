use super::*;
use std::{collections::HashMap, sync::Mutex};

const CHIME: &str = "native-test-chime";
const LOW: &str = "native-test-low";

#[test]
fn restart_collapses_legacy_voices_and_500_restarts_keep_other_effect_and_unique_ids() {
    let mut engine = ready();
    let other = engine.play(LOW).unwrap();
    let first = engine.play(CHIME).unwrap();
    let second = engine.play(CHIME).unwrap();
    let mut retired = vec![first, second];
    for _ in 0..500 {
        let id = engine.restart(CHIME, PlaybackOptions::default()).unwrap();
        assert!(!retired.contains(&id));
        assert_eq!(engine.status.active_playbacks.len(), 2);
        assert_eq!(engine.driver.voices.len(), 2);
        assert!(engine.driver.voices.contains_key(&other));
        assert!(
            retired
                .iter()
                .all(|old| !engine.driver.voices.contains_key(old))
        );
        assert_eq!(engine.status.active_playbacks[1].playback_id, id);
        retired.push(id);
    }
}

#[test]
fn restart_at_full_limit_reuses_target_slots_but_never_steals_other_effects() {
    let mut engine = ready();
    for _ in 0..15 {
        engine.play(LOW).unwrap();
    }
    engine.play(CHIME).unwrap();
    engine.restart(CHIME, PlaybackOptions::default()).unwrap();
    assert_eq!(engine.status.active_playbacks.len(), 16);
    let before = engine.status.active_playbacks.clone();
    assert_eq!(
        engine
            .restart("native-test-pulse", PlaybackOptions::default())
            .unwrap_err()
            .code,
        "voice_limit"
    );
    assert_eq!(engine.status.active_playbacks, before);
    assert_eq!(engine.driver.voices.len(), 16);
}

#[test]
fn restart_validates_before_cutting_and_reports_start_failure_after_cutting_only_target() {
    let mut engine = ready();
    let other = engine.play(LOW).unwrap();
    engine.play(CHIME).unwrap();
    let before = engine.status.active_playbacks.clone();
    assert_eq!(
        engine
            .restart("missing", PlaybackOptions::default())
            .unwrap_err()
            .code,
        "unknown_effect"
    );
    assert_eq!(
        engine
            .restart(
                CHIME,
                PlaybackOptions {
                    fade_in_ms: 30001,
                    ..Default::default()
                }
            )
            .unwrap_err()
            .code,
        "invalid_playback_options"
    );
    engine.status.state = EngineState::DeviceError;
    assert_eq!(
        engine
            .restart(CHIME, PlaybackOptions::default())
            .unwrap_err()
            .code,
        "output_not_ready"
    );
    engine.status.state = EngineState::Ready;
    engine.prepared.insert(CHIME.into(), None);
    assert_eq!(
        engine
            .restart(CHIME, PlaybackOptions::default())
            .unwrap_err()
            .code,
        "effect_unavailable"
    );
    engine.prepared.remove(CHIME);
    for invalid in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
        engine.status.effects[0].default_volume = invalid;
        assert_eq!(
            engine
                .restart(CHIME, PlaybackOptions::default())
                .unwrap_err()
                .code,
            "invalid_volume"
        );
    }
    engine.status.effects[0].default_volume = 0.5;
    assert_eq!(engine.status.active_playbacks, before);
    assert_eq!(engine.driver.voices.len(), 2);
    engine.driver.fail_start = true;
    assert_eq!(
        engine
            .restart(CHIME, PlaybackOptions::default())
            .unwrap_err()
            .code,
        "fake_start"
    );
    assert_eq!(
        engine.status.last_error.as_ref().unwrap().code,
        "fake_start"
    );
    assert_eq!(engine.status.active_playbacks, before[..1]);
    assert_eq!(engine.driver.voices.len(), 1);
    assert!(engine.driver.voices.contains_key(&other));
}

#[test]
fn restart_resets_loop_fade_and_volume_and_emits_ordered_reconcilable_snapshots() {
    let mut engine = ready();
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    engine.emit = Box::new(move |name, status| {
        captured
            .lock()
            .unwrap()
            .push((name.to_owned(), status.clone()))
    });
    let old = engine
        .play_with_options(
            CHIME,
            PlaybackOptions {
                looped: true,
                fade_in_ms: 20,
                fade_out_ms: 30,
            },
        )
        .unwrap();
    engine.set_playback(&old, 0.1).unwrap();
    engine.fade_out(&old, 100).unwrap();
    let second = engine.play(CHIME).unwrap();
    engine.set_effect(CHIME, 0.8).unwrap();
    events.lock().unwrap().clear();
    let new = engine.restart(CHIME, PlaybackOptions::default()).unwrap();
    let voice = &engine.status.active_playbacks[0];
    assert_eq!(voice.playback_id, new);
    assert_eq!(voice.volume, 0.8);
    assert!(!voice.looped);
    assert_eq!(voice.state, PlaybackState::Playing);
    assert_eq!(voice.fade_out_ms, 0);
    assert!(!engine.driver.voices.contains_key(&old));
    assert!(!engine.driver.voices.contains_key(&second));
    let recorded = events.lock().unwrap();
    assert_eq!(
        recorded
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        [
            "audio:playback-stopped",
            "audio:playback-stopped",
            "audio:playback-started"
        ]
    );
    assert_eq!(recorded[0].1.active_playbacks.len(), 1);
    assert!(recorded[1].1.active_playbacks.is_empty());
    assert_eq!(recorded[2].1, engine.status);
    assert!(
        recorded
            .windows(2)
            .all(|pair| pair[0].1.revision + 1 == pair[1].1.revision)
    );
    drop(recorded);
    engine.driver.fail_start = true;
    engine
        .restart(CHIME, PlaybackOptions::default())
        .unwrap_err();
    let events = events.lock().unwrap();
    assert_eq!(events.last().unwrap().0, "audio:playback-error");
    assert_eq!(events.last().unwrap().1, engine.status);
}

#[test]
fn dynamic_catalog_registration_is_idempotent_and_unavailable_files_do_not_stop_other_voices() {
    let mut engine = ready();
    let pcm = PreparedPcm {
        samples: Arc::from([0.1; 256]),
        channels: 2,
        sample_rate: 44100,
    };
    let effect = NativeEffect {
        effect_id: "managed".into(),
        name: "Importado".into(),
        duration_ms: 3,
        default_volume: 0.2,
    };
    engine.register(vec![(effect.clone(), Some(pcm.clone()))]);
    engine.register(vec![(effect.clone(), Some(pcm.clone()))]);
    assert_eq!(engine.status.effects.len(), 4);
    engine.set_effect("managed", 0.8).unwrap();
    engine.register(vec![(effect, Some(pcm))]);
    engine.play("managed").unwrap();
    engine.play("managed").unwrap();
    let managed = engine
        .status
        .effects
        .iter()
        .find(|effect| effect.effect_id == "managed")
        .unwrap()
        .clone();
    engine.register(vec![(managed, None)]);
    assert_eq!(
        engine.play("managed").unwrap_err().code,
        "effect_unavailable"
    );
    let unavailable = NativeEffect {
        effect_id: "missing".into(),
        name: "Ausente".into(),
        duration_ms: 1,
        default_volume: 0.5,
    };
    engine.register(vec![(unavailable, None)]);
    assert_eq!(
        engine.play("missing").unwrap_err().code,
        "effect_unavailable"
    );
    assert_eq!(engine.status.active_playbacks.len(), 2);
    assert!(
        engine
            .status
            .active_playbacks
            .iter()
            .all(|voice| voice.volume == 0.8)
    );
    engine.stop_all();
    assert!(engine.status.active_playbacks.is_empty());
}

#[derive(Default)]
pub(crate) struct FakeDriver {
    unique_names: bool,
    auto_finish: bool,
    generation: u64,
    open_device: Option<u8>,
    fail_open: Vec<u8>,
    fail_start: bool,
    start_gate: Option<(
        std::sync::mpsc::SyncSender<()>,
        std::sync::mpsc::Receiver<()>,
    )>,
    disconnected: bool,
    no_devices: bool,
    voices: HashMap<String, f32>,
    completed: Vec<String>,
    opens: Vec<u8>,
    closes: usize,
}

impl FakeDriver {
    /// Bloquea el arranque hasta recibir permiso para probar STOP ALL dentro del driver.
    pub(crate) fn blocking_start(
        entered: std::sync::mpsc::SyncSender<()>,
        release: std::sync::mpsc::Receiver<()>,
    ) -> Self {
        Self {
            start_gate: Some((entered, release)),
            ..Default::default()
        }
    }

    /// Simula dos nombres distintos y un fallo de apertura en la segunda salida.
    pub(crate) fn failing_second_output() -> Self {
        Self {
            unique_names: true,
            fail_open: vec![2],
            ..Self::default()
        }
    }
    /// Simula finalizacion autonoma para comprobar el sondeo del worker en reposo.
    pub(crate) fn auto_finishing() -> Self {
        Self {
            auto_finish: true,
            ..Self::default()
        }
    }
}

impl AudioDriver for FakeDriver {
    type Device = u8;
    fn enumerate(&mut self) -> Result<Vec<(OutputDevice, u8)>, AudioError> {
        self.generation += 1;
        if self.no_devices {
            return Ok(Vec::new());
        }
        Ok((1..=2)
            .map(|index| {
                (
                    OutputDevice {
                        id: format!("{}:{index}", self.generation),
                        name: if self.unique_names {
                            format!("Salida {index}")
                        } else {
                            "Nombre duplicado".into()
                        },
                        is_default: false,
                    },
                    index,
                )
            })
            .collect())
    }
    fn open(
        &mut self,
        device: &u8,
        _: Arc<AtomicU32>,
        _: Arc<AtomicBool>,
    ) -> Result<(), AudioError> {
        assert!(
            self.open_device.is_none(),
            "Nunca debe haber dos streams activos"
        );
        self.opens.push(*device);
        if self.fail_open.contains(device) {
            return Err(AudioError::new("fake_open", "Fallo simulado."));
        }
        self.open_device = Some(*device);
        Ok(())
    }
    fn close(&mut self) {
        self.open_device = None;
        self.voices.clear();
        self.closes += 1;
    }
    fn start(&mut self, id: &str, _: &str, value: f32) -> Result<(), AudioError> {
        assert!(self.open_device.is_some());
        if let Some((entered, release)) = self.start_gate.take() {
            entered.send(()).unwrap();
            release
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
        }
        if self.fail_start {
            return Err(AudioError::new("fake_start", "Fallo de voz simulado."));
        }
        self.voices.insert(id.into(), value);
        Ok(())
    }
    fn stop(&mut self, id: &str) {
        self.voices.remove(id);
    }
    fn set_volume(&mut self, id: &str, volume: f32) {
        self.voices.insert(id.into(), volume);
    }
    fn finished(&mut self) -> Vec<String> {
        if self.auto_finish {
            return self.voices.drain().map(|(id, _)| id).collect();
        }
        let completed = std::mem::take(&mut self.completed);
        for id in &completed {
            self.voices.remove(id);
        }
        completed
    }
    fn failed(&mut self) -> bool {
        std::mem::take(&mut self.disconnected)
    }
}

fn engine() -> Engine<FakeDriver> {
    Engine::new(
        FakeDriver::default(),
        Box::new(|_, _| {}),
        Arc::new(AtomicBool::new(false)),
    )
}

fn ready() -> Engine<FakeDriver> {
    let mut engine = engine();
    let devices = engine.list_devices().unwrap();
    engine.select(&devices[0].id).unwrap();
    engine
}

#[test]
fn startup_does_not_enumerate_or_open_and_catalog_is_explicit() {
    let mut engine = engine();
    assert_eq!(engine.status.state, EngineState::NotInitialized);
    assert_eq!(engine.status.revision, 0);
    assert_eq!(engine.status.max_concurrent_playbacks, 16);
    assert_eq!(engine.driver.generation, 0);
    assert!(engine.driver.opens.is_empty());
    assert!(engine.status.selected_device.is_none());
    assert_eq!(
        engine
            .status
            .effects
            .iter()
            .map(|e| e.effect_id.as_str())
            .collect::<Vec<_>>(),
        vec![CHIME, "native-test-pulse", LOW]
    );
    assert_eq!(engine.play(CHIME).unwrap_err().code, "output_not_ready");
    assert_eq!(engine.status.revision, 1);
    assert_ne!(
        engine.status.engine_id,
        super::Engine::new(
            FakeDriver::default(),
            Box::new(|_, _| {}),
            Arc::new(AtomicBool::new(false))
        )
        .status
        .engine_id
    );
}

#[test]
fn same_effect_instances_are_independent_and_voice_seventeen_does_not_steal() {
    let mut engine = ready();
    let ids: Vec<_> = (0..16).map(|_| engine.play(CHIME).unwrap()).collect();
    assert!(ids.windows(2).all(|ids| ids[0] != ids[1]));
    let before = engine.status.active_playbacks.clone();
    assert_eq!(engine.play(CHIME).unwrap_err().code, "voice_limit");
    assert_eq!(engine.status.active_playbacks, before);
    assert_eq!(engine.driver.voices.len(), 16);
    engine.stop(&ids[0]);
    assert!(engine.play(CHIME).is_ok());
}

#[test]
fn stops_by_instance_effect_and_all_are_idempotent() {
    let mut engine = ready();
    let first = engine.play(CHIME).unwrap();
    engine.play(CHIME).unwrap();
    let low = engine.play(LOW).unwrap();
    engine.stop(&first);
    let revision = engine.status.revision;
    engine.stop(&first);
    assert_eq!(revision, engine.status.revision);
    engine.stop_effect(CHIME);
    assert_eq!(engine.status.active_playbacks.len(), 1);
    assert_eq!(engine.status.active_playbacks[0].playback_id, low);
    engine.stop_effect("unknown");
    engine.stop_all();
    engine.stop_all();
    assert!(engine.driver.voices.is_empty());
    assert!(engine.status.active_playbacks.is_empty());
}

#[test]
fn completed_instances_release_capacity_without_duplicate_events() {
    let mut engine = ready();
    engine.set_limit(1).unwrap();
    let id = engine.play(CHIME).unwrap();
    engine.driver.completed.push(id.clone());
    engine.poll();
    assert!(engine.status.active_playbacks.is_empty());
    assert!(engine.driver.voices.is_empty());
    let revision = engine.status.revision;
    engine.driver.completed.push(id.clone());
    engine.poll();
    engine.stop(&id);
    assert_eq!(engine.status.revision, revision);
    engine.play(CHIME).unwrap();
}

#[test]
fn volumes_follow_future_effect_active_instance_and_shared_master_semantics() {
    let mut engine = ready();
    let first = engine.play(CHIME).unwrap();
    engine.set_effect(CHIME, 0.2).unwrap();
    let second = engine.play(CHIME).unwrap();
    assert_eq!(engine.driver.voices[&first], 0.5);
    assert_eq!(engine.driver.voices[&second], 0.2);
    engine.set_playback(&first, 0.8).unwrap();
    assert_eq!(engine.driver.voices[&first], 0.8);
    engine.set_master(0.1).unwrap();
    assert_eq!(
        f32::from_bits(engine.master.load(std::sync::atomic::Ordering::Relaxed)),
        0.1
    );
    assert_eq!(engine.driver.voices[&second], 0.2);
    engine.stop(&first);
    assert_eq!(
        engine.set_playback(&first, 0.4).unwrap_err().code,
        "unknown_playback"
    );
}

#[test]
fn invalid_inputs_do_not_change_state_or_revision_except_failed_play() {
    let mut engine = ready();
    let id = engine.play(CHIME).unwrap();
    let before = engine.status.clone();
    for volume in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -0.01, 1.01] {
        assert!(engine.set_master(volume).is_err());
        assert!(engine.set_effect(CHIME, volume).is_err());
        assert!(engine.set_playback(&id, volume).is_err());
    }
    assert!(engine.set_effect("missing", 0.5).is_err());
    assert!(engine.select("missing").is_err());
    assert!(engine.set_limit(0).is_err());
    assert!(engine.set_limit(65).is_err());
    assert_eq!(engine.status, before);
    assert_eq!(engine.play("missing").unwrap_err().code, "unknown_effect");
    assert_eq!(engine.status.active_playbacks, before.active_playbacks);
    assert_eq!(engine.status.revision, before.revision + 1);
}

#[test]
fn limits_are_configurable_without_cutting_active_voices() {
    let mut engine = ready();
    engine.set_limit(64).unwrap();
    for _ in 0..64 {
        engine.play(CHIME).unwrap();
    }
    assert!(engine.set_limit(63).is_err());
    assert!(engine.play(CHIME).is_err());
    assert_eq!(engine.driver.voices.len(), 64);
    engine.stop_all();
    engine.set_limit(1).unwrap();
}

#[test]
fn stale_ids_never_select_different_devices_after_refresh() {
    let mut engine = ready();
    let old = engine.status.selected_device.clone().unwrap();
    let devices = engine.list_devices().unwrap();
    assert!(engine.select(&old.id).is_err());
    assert_eq!(engine.status.selected_device.as_ref(), Some(&old));
    assert_ne!(devices[0].id, old.id);
    engine.select(&devices[1].id).unwrap();
    assert_eq!(engine.driver.open_device, Some(2));
}

#[test]
fn change_closes_old_stream_stops_voices_and_does_not_autoresume() {
    let mut engine = ready();
    engine.play(CHIME).unwrap();
    let devices = engine.list_devices().unwrap();
    let result = engine.select(&devices[1].id).unwrap();
    assert!(!result.restored_previous);
    assert!(result.error.is_none());
    assert_eq!(result.status.state, EngineState::Ready);
    assert!(result.status.active_playbacks.is_empty());
    assert!(engine.driver.voices.is_empty());
    assert_eq!(engine.driver.opens, vec![1, 2]);
}

#[test]
fn failed_change_restores_cached_previous_even_after_registry_refresh() {
    let mut engine = ready();
    let previous = engine.status.selected_device.clone();
    engine.play(CHIME).unwrap();
    engine.driver.fail_open.push(2);
    let devices = engine.list_devices().unwrap();
    let result = engine.select(&devices[1].id).unwrap();
    assert!(result.restored_previous);
    assert!(result.error.is_some());
    assert_eq!(result.status.state, EngineState::Ready);
    assert_eq!(result.status.selected_device, previous);
    assert_eq!(engine.driver.opens, vec![1, 2, 1]);
    assert!(result.status.active_playbacks.is_empty());
}

#[test]
fn failed_restore_is_visible_and_never_opens_default() {
    let mut engine = ready();
    engine.driver.fail_open = vec![1, 2];
    let devices = engine.list_devices().unwrap();
    let result = engine.select(&devices[1].id).unwrap();
    assert!(!result.restored_previous);
    assert_eq!(result.status.state, EngineState::DeviceError);
    assert!(result.error.unwrap().message.contains("Tampoco"));
    assert!(engine.driver.open_device.is_none());
    assert_eq!(engine.driver.opens, vec![1, 2, 1]);
    assert!(engine.play(CHIME).is_err());
}

#[test]
fn first_open_failure_and_empty_enumeration_remain_safe() {
    let mut engine = engine();
    engine.driver.no_devices = true;
    assert!(engine.list_devices().unwrap().is_empty());
    assert!(engine.driver.opens.is_empty());
    engine.driver.no_devices = false;
    let devices = engine.list_devices().unwrap();
    engine.driver.fail_open.push(1);
    let result = engine.select(&devices[0].id).unwrap();
    assert_eq!(result.status.state, EngineState::DeviceError);
    assert!(!result.restored_previous);
    assert_eq!(engine.driver.opens, vec![1]);
}

#[test]
fn disconnect_clears_voices_preserves_visible_selection_and_requires_user_recovery() {
    let mut engine = ready();
    engine.play(CHIME).unwrap();
    let selected = engine.status.selected_device.clone();
    engine.driver.disconnected = true;
    engine.poll();
    assert_eq!(engine.status.state, EngineState::DeviceError);
    assert_eq!(engine.status.selected_device, selected);
    assert_eq!(
        engine.status.last_error.as_ref().unwrap().code,
        "device_disconnected"
    );
    assert!(engine.driver.open_device.is_none());
    assert!(engine.status.active_playbacks.is_empty());
    for _ in 0..10 {
        engine.poll();
    }
    assert_eq!(engine.driver.opens, vec![1]);
    assert!(engine.play(CHIME).is_err());
    let devices = engine.list_devices().unwrap();
    engine.select(&devices[0].id).unwrap();
    assert!(engine.status.last_error.is_none());
    assert_eq!(engine.status.state, EngineState::Ready);
}

#[test]
fn isolated_voice_failure_leaves_other_instances_running() {
    let mut engine = ready();
    let id = engine.play(CHIME).unwrap();
    engine.driver.fail_start = true;
    assert_eq!(engine.play(LOW).unwrap_err().code, "fake_start");
    assert_eq!(engine.status.active_playbacks.len(), 1);
    assert!(engine.driver.voices.contains_key(&id));
    assert_eq!(engine.status.state, EngineState::Ready);
}

#[test]
fn hundreds_of_lifecycles_leave_no_handles_and_shutdown_closes_output() {
    let mut engine = ready();
    for _ in 0..500 {
        let id = engine.play(CHIME).unwrap();
        engine.driver.completed.push(id);
        engine.poll();
    }
    assert!(engine.status.active_playbacks.is_empty());
    assert!(engine.driver.voices.is_empty());
    engine.play(CHIME).unwrap();
    engine.shutdown();
    assert!(engine.driver.open_device.is_none());
    assert!(engine.driver.voices.is_empty());
}

#[test]
fn events_are_full_reconcilable_snapshots_with_monotonic_revisions() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = events.clone();
    let mut engine = Engine::new(
        FakeDriver::default(),
        Box::new(move |name, status| {
            recorded
                .lock()
                .unwrap()
                .push((name.to_string(), status.clone()));
        }),
        Arc::new(AtomicBool::new(false)),
    );
    let devices = engine.list_devices().unwrap();
    engine.select(&devices[0].id).unwrap();
    let id = engine.play(CHIME).unwrap();
    engine.set_master(0.4).unwrap();
    engine.driver.completed.push(id);
    engine.poll();
    engine.play("unknown").unwrap_err();
    engine.play(LOW).unwrap();
    engine.stop_all();
    engine.driver.disconnected = true;
    engine.poll();
    let events = events.lock().unwrap();
    for (index, (_, status)) in events.iter().enumerate() {
        assert_eq!(status.revision, index as u64 + 1);
        assert_eq!(status.engine_id, engine.status.engine_id);
    }
    assert_eq!(events.last().unwrap().1, engine.status);
    for name in [
        "audio:device-changed",
        "audio:playback-started",
        "audio:state-changed",
        "audio:playback-finished",
        "audio:playback-error",
        "audio:playback-stopped",
        "audio:device-error",
    ] {
        assert!(events.iter().any(|(event, _)| event == name));
    }
}

#[test]
fn serialized_contract_has_exact_fields_and_snake_case_state() {
    let engine = engine();
    let value = serde_json::to_value(&engine.status).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "engine_id": engine.status.engine_id, "revision": 0, "state": "not_initialized",
            "selected_device": null, "active_playbacks": [], "master_volume": engine.status.master_volume,
            "max_concurrent_playbacks": 16, "last_error": null, "effects": engine.status.effects,
        })
    );
    assert_eq!(
        serde_json::to_value(EngineState::DeviceError).unwrap(),
        "device_error"
    );
    assert_eq!(serde_json::to_value(EngineState::Ready).unwrap(), "ready");
    assert_eq!(
        serde_json::to_value(AudioError::new("code", "mensaje")).unwrap(),
        serde_json::json!({"code":"code", "message":"mensaje"})
    );
    assert_eq!(
        serde_json::to_value(Playback {
            playback_id: "p".into(),
            effect_id: "e".into(),
            volume: 0.5,
            looped: false,
            state: PlaybackState::Playing,
            fade_out_ms: 0,
        })
        .unwrap(),
        serde_json::json!({"playback_id":"p", "effect_id":"e", "volume":0.5, "looped":false, "state":"playing", "fade_out_ms":0})
    );
    assert_eq!(
        serde_json::to_value(OutputDevice {
            id: "d".into(),
            name: "n".into(),
            is_default: false
        })
        .unwrap(),
        serde_json::json!({"id":"d", "name":"n", "is_default":false})
    );
    let result = DeviceSelectionResult {
        status: engine.status.clone(),
        restored_previous: false,
        error: None,
    };
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        serde_json::json!({"status":value, "restored_previous":false, "error":null})
    );
}

#[test]
fn options_validate_all_diagnostic_durations_and_fading_voices_keep_capacity_until_stopped() {
    let mut engine = engine();
    let devices = engine.list_devices().unwrap();
    engine.select(&devices[0].id).unwrap();
    for effect in engine.status.effects.clone() {
        assert!(
            engine
                .play_with_options(
                    &effect.effect_id,
                    PlaybackOptions {
                        looped: false,
                        fade_in_ms: effect.duration_ms,
                        fade_out_ms: 1
                    }
                )
                .is_err()
        );
        let id = engine
            .play_with_options(
                &effect.effect_id,
                PlaybackOptions {
                    looped: true,
                    fade_in_ms: 30000,
                    fade_out_ms: 30000,
                },
            )
            .unwrap();
        engine.stop(&id);
    }
    engine.set_limit(1).unwrap();
    let id = engine.play("native-test-low").unwrap();
    engine.fade_out(&id, 100).unwrap();
    let revision = engine.status.revision;
    engine.fade_out(&id, 200).unwrap();
    assert_eq!(engine.status.revision, revision);
    assert_eq!(engine.status.active_playbacks[0].fade_out_ms, 100);
    assert_eq!(
        engine.play("native-test-low").unwrap_err().code,
        "voice_limit"
    );
    engine.set_loop(&id, true).unwrap();
    assert_eq!(
        engine.status.active_playbacks[0].state,
        PlaybackState::FadingOut
    );
    engine.fade_out(&id, 0).unwrap();
    assert!(engine.status.active_playbacks.is_empty());
}

#[test]
fn explicit_fade_completion_publishes_stopped_once_and_natural_completion_stays_distinct() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let mut engine = ready();
    engine.emit = Box::new(move |name, status| {
        captured
            .lock()
            .unwrap()
            .push((name.to_owned(), status.clone()))
    });
    let id = engine
        .play_with_options(
            LOW,
            PlaybackOptions {
                looped: true,
                fade_in_ms: 10,
                fade_out_ms: 50,
            },
        )
        .unwrap();
    engine.fade_out(&id, 20).unwrap();
    engine.driver.completed.push(id);
    engine.poll();
    engine.poll();
    let id = engine.play(CHIME).unwrap();
    engine.driver.completed.push(id);
    engine.poll();
    engine.poll();
    let events = events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|(name, _)| name == "audio:playback-stopped")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|(name, _)| name == "audio:playback-finished")
            .count(),
        1
    );
    let fading = events
        .iter()
        .find(|(name, status)| {
            name == "audio:state-changed"
                && status
                    .active_playbacks
                    .iter()
                    .any(|p| p.state == PlaybackState::FadingOut)
        })
        .unwrap();
    assert_eq!(fading.1.active_playbacks[0].fade_out_ms, 20);
}
