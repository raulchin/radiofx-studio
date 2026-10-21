use super::engine::{AudioDriver, Engine, EventEmitter};
use crate::domain::audio::*;
use std::{
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub enum Operation {
    Initialize(
        Vec<(NativeEffect, Option<crate::domain::library::PreparedPcm>)>,
        f32,
        u16,
        Vec<(String, f32)>,
    ),
    Register(Vec<(NativeEffect, Option<crate::domain::library::PreparedPcm>)>),
    Status,
    Devices,
    Selected,
    Select(String),
    Play(String),
    PlayWithOptions(String, PlaybackOptions),
    Restart(String, PlaybackOptions),
    Loop(String, bool),
    FadeOut(String, u32),
    Stop(String),
    StopEffect(String),
    StopAll,
    Master(f32),
    PlaybackVolume(String, f32),
    EffectVolume(String, f32),
    Limit(u16),
    Playbacks,
}

pub enum Reply {
    Status(AudioEngineStatus),
    Devices(Vec<OutputDevice>),
    Selected(Option<OutputDevice>),
    Selection(DeviceSelectionResult),
    PlaybackId(String),
    Unit,
    Playbacks(Vec<Playback>),
}

struct Request {
    operation: Operation,
    reply: SyncSender<Result<Reply, AudioError>>,
}

const REQUEST_QUEUE_CAPACITY: usize = 64;
const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Default)]
struct EmergencyState {
    requested: u64,
    completed: u64,
    closed: bool,
}

#[derive(Default)]
struct Emergency {
    state: Mutex<EmergencyState>,
    acknowledged: Condvar,
    cutoff: Arc<AtomicBool>,
}

impl Emergency {
    fn lock(&self) -> MutexGuard<'_, EmergencyState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn request(&self) -> Result<u64, AudioError> {
        let mut state = self.lock();
        if state.closed {
            return Err(unavailable());
        }
        self.cutoff.store(true, Ordering::Release);
        // Las paradas concurrentes comparten confirmacion sin otra cola ni lista de respuestas.
        if state.requested == state.completed {
            state.requested += 1;
        }
        Ok(state.requested)
    }

    fn wait(&self, ticket: u64) -> Result<Reply, AudioError> {
        let mut state = self.lock();
        while state.completed < ticket && !state.closed {
            state = self
                .acknowledged
                .wait(state)
                .unwrap_or_else(|poison| poison.into_inner());
        }
        if state.completed >= ticket {
            Ok(Reply::Unit)
        } else {
            Err(unavailable())
        }
    }

    fn close(&self) {
        self.lock().closed = true;
        self.cutoff.store(true, Ordering::Release);
        self.acknowledged.notify_all();
    }
}

struct WorkerExit(Arc<Emergency>);

impl Drop for WorkerExit {
    fn drop(&mut self) {
        self.0.close();
    }
}

pub struct AudioService {
    sender: SyncSender<Request>,
    stopping: Arc<AtomicBool>,
    emergency: Arc<Emergency>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn unavailable() -> AudioError {
    AudioError::new("engine_stopped", "El motor de audio no esta disponible.")
}

impl AudioService {
    /// Crea el controlador dentro del worker: no exige que el stream sea Send entre plataformas.
    pub fn start<D, F>(factory: F, emit: EventEmitter) -> Result<Self, AudioError>
    where
        D: AudioDriver + 'static,
        F: FnOnce() -> D + Send + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(REQUEST_QUEUE_CAPACITY);
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = stopping.clone();
        let emergency = Arc::new(Emergency::default());
        let worker_emergency = emergency.clone();
        let thread = thread::Builder::new()
            .name("radiofx-audio".into())
            .spawn(move || {
                let _exit = WorkerExit(worker_emergency.clone());
                let mut engine = Engine::new(factory(), emit, worker_emergency.cutoff.clone());
                run_worker(&mut engine, receiver, worker_stopping, &worker_emergency);
            })
            .map_err(|e| {
                AudioError::new(
                    "worker_start_failed",
                    format!("No se pudo iniciar el motor: {e}"),
                )
            })?;
        Ok(Self {
            sender,
            stopping,
            emergency,
            thread: Mutex::new(Some(thread)),
        })
    }

    fn enqueue(
        &self,
        operation: Operation,
    ) -> Result<Receiver<Result<Reply, AudioError>>, AudioError> {
        if self.stopping.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        // Serializa la admision con STOP ALL, nunca con el callback de audio.
        let state = self.emergency.lock();
        if state.closed {
            return Err(unavailable());
        }
        if state.requested != state.completed {
            return Err(AudioError::new(
                "stop_in_progress",
                "Hay una parada general en curso. Espere su confirmacion.",
            ));
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .try_send(Request { operation, reply })
            .map_err(|e| match e {
                TrySendError::Full(_) => AudioError::new(
                    "request_queue_full",
                    "El motor esta ocupado. Reintente la operacion.",
                ),
                TrySendError::Disconnected(_) => unavailable(),
            })?;
        Ok(receiver)
    }

    /// Encola sin bloquear; espera la respuesta unica fuera del hilo principal y del audio.
    /// STOP ALL evita la cola, cancela ordenes pendientes y confirma solo tras detener las voces.
    /// Durante esa barrera se rechazan ordenes normales; las paradas concurrentes se agrupan.
    /// El corte atomico silencia el render incluso si el worker esta bloqueado en un driver.
    pub async fn request(&self, operation: Operation) -> Result<Reply, AudioError> {
        if matches!(operation, Operation::StopAll) {
            let ticket = self.emergency.request()?;
            let emergency = self.emergency.clone();
            return tauri::async_runtime::spawn_blocking(move || emergency.wait(ticket))
                .await
                .map_err(|_| unavailable())?;
        }
        let receiver = self.enqueue(operation)?;
        tauri::async_runtime::spawn_blocking(move || receiver.recv().map_err(|_| unavailable())?)
            .await
            .map_err(|_| unavailable())?
    }

    /// Solicita parada fuera de la cola y espera la liberacion del stream en su hilo propietario.
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        self.emergency.close();
        let mut guard = match self.thread.lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        if let Some(thread) = guard.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for AudioService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_worker<D: AudioDriver>(
    engine: &mut Engine<D>,
    receiver: Receiver<Request>,
    stopping: Arc<AtomicBool>,
    emergency: &Emergency,
) {
    let mut next_poll = Instant::now();
    while !stopping.load(Ordering::Acquire) {
        handle_emergency(engine, &receiver, emergency, None);
        if Instant::now() >= next_poll {
            engine.poll();
            next_poll = Instant::now() + POLL_INTERVAL;
        }
        match receiver.recv_timeout(next_poll.saturating_duration_since(Instant::now())) {
            Ok(request) => {
                // Tambien reconcilia antes de cada orden para no aceptar voces en una salida fallida.
                engine.poll();
                if handle_emergency(engine, &receiver, emergency, Some(&request)) {
                    continue;
                }
                let rearm_ticket = if matches!(
                    request.operation,
                    Operation::Play(_)
                        | Operation::PlayWithOptions(_, _)
                        | Operation::Restart(_, _)
                ) {
                    let state = emergency.lock();
                    (state.requested == state.completed && !state.closed).then_some(state.completed)
                } else {
                    None
                };
                let result = dispatch(engine, request.operation);
                if result.is_ok()
                    && let Some(ticket) = rearm_ticket
                {
                    let state = emergency.lock();
                    // Nunca deshacer una parada llegada durante start o la emision de su evento.
                    if !state.closed && state.requested == ticket && state.completed == ticket {
                        emergency.cutoff.store(false, Ordering::Release);
                    }
                }
                let _ = request.reply.send(result);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    engine.shutdown();
}

fn handle_emergency<D: AudioDriver>(
    engine: &mut Engine<D>,
    receiver: &Receiver<Request>,
    emergency: &Emergency,
    current: Option<&Request>,
) -> bool {
    let ticket = {
        let state = emergency.lock();
        if state.requested == state.completed {
            return false;
        }
        state.requested
    };
    engine.stop_all();
    let cancel = |request: &Request| {
        let _ = request.reply.send(Err(AudioError::new(
            "request_cancelled",
            "La parada general cancelo esta orden pendiente. Vuelva a solicitarla si procede.",
        )));
    };
    if let Some(request) = current {
        cancel(request);
    }
    // No se admiten nuevas ordenes durante la parada: el drenaje es acotado a 64.
    // Se cancelan tambien consultas y ajustes pendientes para conservar una barrera simple.
    while let Ok(request) = receiver.try_recv() {
        cancel(&request);
    }
    emergency.lock().completed = ticket;
    emergency.acknowledged.notify_all();
    true
}

fn dispatch<D: AudioDriver>(
    engine: &mut Engine<D>,
    operation: Operation,
) -> Result<Reply, AudioError> {
    Ok(match operation {
        Operation::Initialize(entries, master, limit, diagnostics) => {
            engine.set_master(master)?;
            engine.set_limit(limit)?;
            for (id, volume) in diagnostics {
                engine.set_effect(&id, volume)?;
            }
            engine.register(entries);
            Reply::Unit
        }
        Operation::Register(entries) => {
            engine.register(entries);
            Reply::Unit
        }
        Operation::Status => Reply::Status(engine.status.clone()),
        Operation::Devices => Reply::Devices(engine.list_devices()?),
        Operation::Selected => Reply::Selected(engine.status.selected_device.clone()),
        Operation::Select(id) => Reply::Selection(engine.select(&id)?),
        Operation::Play(id) => Reply::PlaybackId(engine.play(&id)?),
        Operation::PlayWithOptions(id, options) => {
            Reply::PlaybackId(engine.play_with_options(&id, options)?)
        }
        Operation::Restart(id, options) => Reply::PlaybackId(engine.restart(&id, options)?),
        Operation::Loop(id, looped) => {
            engine.set_loop(&id, looped)?;
            Reply::Unit
        }
        Operation::FadeOut(id, duration) => {
            engine.fade_out(&id, duration)?;
            Reply::Unit
        }
        Operation::Stop(id) => {
            engine.stop(&id);
            Reply::Unit
        }
        Operation::StopEffect(id) => {
            engine.stop_effect(&id);
            Reply::Unit
        }
        Operation::StopAll => {
            engine.stop_all();
            Reply::Unit
        }
        Operation::Master(value) => {
            engine.set_master(value)?;
            Reply::Unit
        }
        Operation::PlaybackVolume(id, value) => {
            engine.set_playback(&id, value)?;
            Reply::Unit
        }
        Operation::EffectVolume(id, value) => {
            engine.set_effect(&id, value)?;
            Reply::Unit
        }
        Operation::Limit(value) => {
            engine.set_limit(value)?;
            Reply::Unit
        }
        Operation::Playbacks => Reply::Playbacks(engine.status.active_playbacks.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::engine::tests::FakeDriver;

    #[test]
    fn late_preloaded_registration_and_initialization_never_rearm_emergency_or_start_voices() {
        let service = AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap();
        tauri::async_runtime::block_on(async {
            service.request(Operation::StopAll).await.unwrap();
            assert!(service.emergency.cutoff.load(Ordering::Acquire));
            let effect = NativeEffect {
                effect_id: "managed".into(),
                name: "Preparado".into(),
                duration_ms: 100,
                default_volume: 0.5,
            };
            let pcm = crate::domain::library::PreparedPcm {
                samples: Arc::from([0.1; 4800]),
                channels: 1,
                sample_rate: 48000,
            };
            service
                .request(Operation::Initialize(
                    vec![(effect.clone(), Some(pcm.clone()))],
                    0.4,
                    8,
                    vec![],
                ))
                .await
                .unwrap();
            service
                .request(Operation::Register(vec![(effect, Some(pcm))]))
                .await
                .unwrap();
            assert!(service.emergency.cutoff.load(Ordering::Acquire));
            let Reply::Devices(devices) = service.request(Operation::Devices).await.unwrap() else {
                panic!("devices")
            };
            service
                .request(Operation::Select(devices[0].id.clone()))
                .await
                .unwrap();
            assert!(service.emergency.cutoff.load(Ordering::Acquire));
            let Reply::Status(status) = service.request(Operation::Status).await.unwrap() else {
                panic!("status")
            };
            assert!(status.active_playbacks.is_empty());
            service
                .request(Operation::Play("managed".into()))
                .await
                .unwrap();
            assert!(!service.emergency.cutoff.load(Ordering::Acquire));
        });
        service.shutdown();
    }

    #[test]
    fn bounded_queue_rejects_without_waiting() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let service = AudioService {
            sender,
            stopping: Arc::new(AtomicBool::new(false)),
            emergency: Arc::new(Emergency::default()),
            thread: Mutex::new(None),
        };
        let _first = service.enqueue(Operation::Status).unwrap();
        assert_eq!(
            service.enqueue(Operation::Status).unwrap_err().code,
            "request_queue_full"
        );
        service.shutdown();
        assert_eq!(
            service.enqueue(Operation::Status).unwrap_err().code,
            "engine_stopped"
        );
    }

    #[test]
    fn stop_arriving_during_accepted_play_cannot_be_undone_by_its_rearm() {
        for (mode, during_start) in [(0, false), (1, false), (2, false), (2, true)] {
            let (entered, waiting) = mpsc::sync_channel(1);
            let (release, blocked) = mpsc::sync_channel(1);
            let (start_gate, event_gate) = if during_start {
                (Some((entered, blocked)), None)
            } else {
                (None, Some((entered, blocked)))
            };
            let service = Arc::new(
                AudioService::start(
                    move || match start_gate {
                        Some((entered, blocked)) => FakeDriver::blocking_start(entered, blocked),
                        None => FakeDriver::default(),
                    },
                    Box::new(move |name, _| {
                        if name == "audio:playback-started"
                            && let Some((entered, blocked)) = &event_gate
                        {
                            entered.send(()).unwrap();
                            blocked.recv_timeout(Duration::from_secs(5)).unwrap();
                        }
                    }),
                )
                .unwrap(),
            );
            let request = |operation| tauri::async_runtime::block_on(service.request(operation));
            let Ok(Reply::Devices(devices)) = request(Operation::Devices) else {
                panic!("devices")
            };
            assert!(request(Operation::Select(devices[0].id.clone())).is_ok());
            let playing = service.clone();
            let play = tauri::async_runtime::spawn(async move {
                playing
                    .request(if mode == 2 {
                        Operation::Restart("native-test-low".into(), PlaybackOptions::default())
                    } else if mode == 1 {
                        Operation::PlayWithOptions(
                            "native-test-low".into(),
                            PlaybackOptions {
                                looped: true,
                                ..Default::default()
                            },
                        )
                    } else {
                        Operation::Play("native-test-low".into())
                    })
                    .await
            });
            waiting.recv_timeout(Duration::from_secs(2)).unwrap();
            let ticket = service.emergency.request().unwrap();
            assert!(service.emergency.cutoff.load(Ordering::Acquire));
            release.send(()).unwrap();
            assert!(matches!(
                tauri::async_runtime::block_on(play).unwrap(),
                Ok(Reply::PlaybackId(_))
            ));
            assert!(matches!(service.emergency.wait(ticket), Ok(Reply::Unit)));
            assert!(service.emergency.cutoff.load(Ordering::Acquire));
            let Ok(Reply::Status(status)) = request(Operation::Status) else {
                panic!("status")
            };
            assert!(status.active_playbacks.is_empty());
            service.shutdown();
        }
    }

    #[test]
    fn emergency_bypasses_full_queue_cancels_pending_before_ack_and_allows_fresh_play() {
        let (sender, receiver) = mpsc::sync_channel(REQUEST_QUEUE_CAPACITY);
        let service = AudioService {
            sender,
            stopping: Arc::new(AtomicBool::new(false)),
            emergency: Arc::new(Emergency::default()),
            thread: Mutex::new(None),
        };
        let mut engine = Engine::new(
            FakeDriver::default(),
            Box::new(|_, _| {}),
            service.emergency.cutoff.clone(),
        );
        let devices = engine.list_devices().unwrap();
        engine.select(&devices[0].id).unwrap();
        engine.play("native-test-low").unwrap();
        let mut replies = Vec::new();
        for index in 0..REQUEST_QUEUE_CAPACITY {
            replies.push(
                service
                    .enqueue(if index % 2 == 0 {
                        Operation::Restart("native-test-low".into(), PlaybackOptions::default())
                    } else {
                        Operation::Play("native-test-low".into())
                    })
                    .unwrap(),
            );
        }
        assert!(
            matches!(service.enqueue(Operation::Status), Err(error) if error.code == "request_queue_full")
        );
        let current = receiver.try_recv().unwrap();
        // La orden ya extraida por el worker tambien debe cancelarse antes de confirmar.
        let ticket = service.emergency.request().unwrap();
        assert_eq!(ticket, service.emergency.request().unwrap());
        assert!(
            matches!(service.enqueue(Operation::Play("native-test-low".into())), Err(error) if error.code == "stop_in_progress")
        );
        assert!(handle_emergency(
            &mut engine,
            &receiver,
            &service.emergency,
            Some(&current)
        ));
        for reply in replies {
            assert!(
                matches!(reply.try_recv(), Ok(Err(error)) if error.code == "request_cancelled")
            );
        }
        assert!(matches!(service.emergency.wait(ticket), Ok(Reply::Unit)));
        assert!(engine.status.active_playbacks.is_empty());
        assert!(receiver.try_recv().is_err());
        let reply = service
            .enqueue(Operation::Play("native-test-low".into()))
            .unwrap();
        let request = receiver.try_recv().unwrap();
        request
            .reply
            .send(dispatch(&mut engine, request.operation))
            .ok();
        assert!(matches!(reply.recv().unwrap(), Ok(Reply::PlaybackId(_))));
        assert_eq!(engine.status.active_playbacks.len(), 1);
        engine.shutdown();
    }

    #[test]
    fn concurrent_restarts_are_serialized_and_only_last_accepted_id_remains_after_rearm() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let service = Arc::new(
            AudioService::start(
                FakeDriver::default,
                Box::new(move |name, status| {
                    if name == "audio:playback-started" {
                        captured.lock().unwrap().push(status.clone());
                    }
                }),
            )
            .unwrap(),
        );
        let request = |operation| tauri::async_runtime::block_on(service.request(operation));
        let Ok(Reply::Devices(devices)) = request(Operation::Devices) else {
            panic!("devices")
        };
        request(Operation::Select(devices[0].id.clone())).unwrap();
        request(Operation::StopAll).unwrap();
        assert!(service.emergency.cutoff.load(Ordering::Acquire));
        let barrier = Arc::new(std::sync::Barrier::new(17));
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let service = service.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    let Ok(Reply::PlaybackId(id)) =
                        tauri::async_runtime::block_on(service.request(Operation::Restart(
                            "native-test-low".into(),
                            PlaybackOptions::default(),
                        )))
                    else {
                        panic!("restart")
                    };
                    id
                })
            })
            .collect();
        barrier.wait();
        let ids: std::collections::HashSet<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(ids.len(), 16);
        assert!(!service.emergency.cutoff.load(Ordering::Acquire));
        let Ok(Reply::Status(status)) = request(Operation::Status) else {
            panic!("status")
        };
        assert_eq!(status.active_playbacks.len(), 1);
        let recorded = events.lock().unwrap();
        assert_eq!(recorded.len(), 16);
        assert!(
            recorded
                .iter()
                .all(|status| status.active_playbacks.len() == 1)
        );
        assert_eq!(recorded.last().unwrap(), &status);
        assert!(ids.contains(&status.active_playbacks[0].playback_id));
        drop(recorded);
        request(Operation::StopAll).unwrap();
        assert!(service.emergency.cutoff.load(Ordering::Acquire));
        service.shutdown();
    }

    #[test]
    fn shutdown_and_worker_exit_release_emergency_waiters() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let service = AudioService {
            sender,
            stopping: Arc::new(AtomicBool::new(false)),
            emergency: Arc::new(Emergency::default()),
            thread: Mutex::new(None),
        };
        let ticket = service.emergency.request().unwrap();
        service.shutdown();
        assert!(
            matches!(service.emergency.wait(ticket), Err(error) if error.code == "engine_stopped")
        );
        assert_eq!(
            service.emergency.request().unwrap_err().code,
            "engine_stopped"
        );
        let emergency = Arc::new(Emergency::default());
        let ticket = emergency.request().unwrap();
        drop(WorkerExit(emergency.clone()));
        assert!(matches!(emergency.wait(ticket), Err(error) if error.code == "engine_stopped"));
    }

    #[test]
    fn async_stop_all_is_accepted_when_worker_queue_is_full() {
        let (release, ready) = mpsc::sync_channel(1);
        let service = AudioService::start(
            move || {
                ready.recv_timeout(Duration::from_secs(2)).unwrap();
                FakeDriver::default()
            },
            Box::new(|_, _| {}),
        )
        .unwrap();
        let replies: Vec<_> = (0..REQUEST_QUEUE_CAPACITY)
            .map(|_| {
                service
                    .enqueue(Operation::Play("native-test-low".into()))
                    .unwrap()
            })
            .collect();
        let mut first = Box::pin(service.request(Operation::StopAll));
        let mut second = Box::pin(service.request(Operation::StopAll));
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        // El primer sondeo registra ambas paradas, aun con el worker detenido y la cola llena.
        assert!(std::future::Future::poll(first.as_mut(), &mut context).is_pending());
        assert!(std::future::Future::poll(second.as_mut(), &mut context).is_pending());
        assert_eq!(service.emergency.lock().requested, 1);
        release.send(()).unwrap();
        assert!(matches!(
            tauri::async_runtime::block_on(first),
            Ok(Reply::Unit)
        ));
        assert!(matches!(
            tauri::async_runtime::block_on(second),
            Ok(Reply::Unit)
        ));
        for reply in replies {
            assert!(
                matches!(reply.try_recv(), Ok(Err(error)) if error.code == "request_cancelled")
            );
        }
        service.shutdown();
    }

    #[test]
    fn worker_replies_reconciles_and_shutdown_is_idempotent() {
        let service = AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap();
        let reply = service
            .enqueue(Operation::Status)
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
        assert!(
            matches!(reply, Reply::Status(status) if status.state == EngineState::NotInitialized)
        );
        let devices = service
            .enqueue(Operation::Devices)
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
        assert!(matches!(devices, Reply::Devices(devices) if devices.len() == 2));
        service.shutdown();
        service.shutdown();
        assert_eq!(
            service.enqueue(Operation::StopAll).unwrap_err().code,
            "engine_stopped"
        );
    }

    #[test]
    fn async_requests_cover_all_operations_and_snapshot_reconciliation() {
        tauri::async_runtime::block_on(async {
            let service = AudioService::start(FakeDriver::default, Box::new(|_, _| {})).unwrap();
            assert!(matches!(
                service.request(Operation::Selected).await,
                Ok(Reply::Selected(None))
            ));
            let Ok(Reply::Devices(devices)) = service.request(Operation::Devices).await else {
                panic!("devices")
            };
            let Ok(Reply::Selection(selection)) = service
                .request(Operation::Select(devices[0].id.clone()))
                .await
            else {
                panic!("selection")
            };
            assert_eq!(selection.status.state, EngineState::Ready);
            for operation in [
                Operation::Master(0.3),
                Operation::Limit(2),
                Operation::EffectVolume("native-test-chime".into(), 0.4),
            ] {
                assert!(matches!(service.request(operation).await, Ok(Reply::Unit)));
            }
            let Ok(Reply::PlaybackId(id)) = service
                .request(Operation::Play("native-test-chime".into()))
                .await
            else {
                panic!("play")
            };
            assert!(matches!(
                service
                    .request(Operation::PlaybackVolume(id.clone(), 0.6))
                    .await,
                Ok(Reply::Unit)
            ));
            let Ok(Reply::Playbacks(playbacks)) = service.request(Operation::Playbacks).await
            else {
                panic!("playbacks")
            };
            assert_eq!(playbacks[0].volume, 0.6);
            let Ok(Reply::Status(status)) = service.request(Operation::Status).await else {
                panic!("status")
            };
            assert_eq!(status.active_playbacks, playbacks);
            assert_eq!(status.master_volume, 0.3);
            assert_eq!(status.max_concurrent_playbacks, 2);
            for operation in [
                Operation::Stop(id),
                Operation::StopEffect("native-test-chime".into()),
                Operation::StopAll,
            ] {
                assert!(matches!(service.request(operation).await, Ok(Reply::Unit)));
            }
            assert!(
                matches!(service.request(Operation::Play("unknown".into())).await, Err(error) if error.code == "unknown_effect")
            );
            service.shutdown();
            assert!(
                matches!(service.request(Operation::Status).await, Err(error) if error.code == "engine_stopped")
            );
        });
    }

    #[test]
    fn idle_worker_polls_completion_without_any_followup_request() {
        let (events, receiver) = mpsc::channel();
        let service = AudioService::start(
            FakeDriver::auto_finishing,
            Box::new(move |name, status| {
                if name == "audio:playback-finished" {
                    let _ = events.send(status.clone());
                }
            }),
        )
        .unwrap();
        let Reply::Devices(devices) = service
            .enqueue(Operation::Devices)
            .unwrap()
            .recv()
            .unwrap()
            .unwrap()
        else {
            panic!("devices")
        };
        service
            .enqueue(Operation::Select(devices[0].id.clone()))
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
        service
            .enqueue(Operation::Play("native-test-chime".into()))
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
        let status = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(status.active_playbacks.is_empty());
        assert_eq!(status.state, EngineState::Ready);
        assert_eq!(status.revision, 3);
        service.shutdown();
    }
}
