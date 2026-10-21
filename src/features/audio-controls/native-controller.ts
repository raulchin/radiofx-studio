import {
  audioErrorMessage,
  nativeAudio,
  type NativeAudioAdapter,
} from "../../shared/adapters/audio";
import type {
  AudioEngineStatus,
  OutputDevice,
  PlaybackOptions,
} from "../../shared/contracts/audio";

export interface NativeAudioView {
  status: AudioEngineStatus | null;
  devices: OutputDevice[];
  routeBusy: boolean;
  error: string | null;
  selectionNotice: string | null;
}

type GainKey = "master" | "limit" | `effect:${string}` | `playback:${string}`;
interface GainEntry {
  engineId: string;
  pending: (() => Promise<unknown>) | null;
  done: Promise<void>;
}

/** Espejo del motor; nunca crea voces, ganancias ni selecciones optimistas. */
export class NativeAudioController {
  private view: NativeAudioView = {
    status: null,
    devices: [],
    routeBusy: false,
    error: null,
    selectionNotice: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private session: ReturnType<NativeAudioController["createSession"]> | null =
    null;

  /** @param api Adaptador sustituible en pruebas sin hardware. */
  constructor(private api: NativeAudioAdapter = nativeAudio) {}

  /** @returns Vista inmutable vigente para useSyncExternalStore. */
  getSnapshot = (): NativeAudioView => this.view;

  /** @param listener Receptor de cambios. @returns Cancelación de la suscripción React. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** @param patch Campos recibidos o estado visual de una operación. */
  private publish(patch: Partial<NativeAudioView>): void {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** @returns Sesión aislada para que StrictMode no reutilice solicitudes antiguas. */
  private createSession() {
    const generation = ++this.generation;
    let requestSequence = 0;
    let acceptedQuery = 0;
    let engineEpoch = 0;
    const gains = new Map<GainKey, GainEntry>();
    const retired = new Set<string>();
    const pendingEvents = new Map<string, AudioEngineStatus>();
    /** @returns Si esta sesión sigue montada. */
    const alive = () => generation === this.generation;
    /** @param key Control solicitado. @returns Si pertenece a la instantánea vigente. */
    const validGain = (key: GainKey) => {
      const status = this.view.status;
      if (!status) return false;
      if (key === "master" || key === "limit") return true;
      return key.startsWith("effect:")
        ? status.effects.some((effect) => effect.effect_id === key.slice(7))
        : status.active_playbacks.some(
            (playback) => playback.playback_id === key.slice(9),
          );
    };
    /** Descarta pendientes de voces finalizadas o de otro motor; no cancela IPC en curso. */
    const pruneGains = () => {
      for (const [key, entry] of gains) {
        if (!validGain(key) || entry.engineId !== this.view.status?.engine_id) {
          entry.pending = null;
          gains.delete(key);
        }
      }
    };
    /** @param error Error externo que se normaliza sin publicar tras desmontar. */
    const fail = (error: unknown) => {
      if (alive()) this.publish({ error: audioErrorMessage(error) });
    };
    /** @param status Instantánea recibida por evento, sin autoridad para cambiar engine_id. */
    const event = (status: AudioEngineStatus) => {
      if (!alive() || retired.has(status.engine_id)) return;
      const current = this.view.status;
      if (!current || current.engine_id !== status.engine_id) {
        const previous = pendingEvents.get(status.engine_id);
        if (!previous || previous.revision < status.revision)
          pendingEvents.set(status.engine_id, status);
      } else if (
        status.engine_id === current.engine_id &&
        status.revision >= current.revision
      ) {
        this.publish({ status });
        pruneGains();
      }
    };
    /** @returns Consulta explícita protegida por secuencia, época y revisión. */
    const refresh = async () => {
      const sequence = ++requestSequence;
      const epoch = engineEpoch;
      try {
        let status = await this.api.getAudioEngineStatus();
        if (!alive() || retired.has(status.engine_id)) return;
        const current = this.view.status;
        if (!current || current.engine_id !== status.engine_id) {
          if (epoch !== engineEpoch || sequence < acceptedQuery) return;
          if (current) retired.add(current.engine_id);
          engineEpoch++;
          const buffered = pendingEvents.get(status.engine_id);
          if (buffered && buffered.revision > status.revision)
            status = buffered;
          pendingEvents.clear();
          this.publish({
            status,
            ...(current ? { devices: [], selectionNotice: null } : {}),
          });
        } else if (status.revision >= current.revision) {
          this.publish({ status });
        }
        acceptedQuery = Math.max(sequence, acceptedQuery);
        pruneGains();
      } catch (error) {
        fail(error);
      }
    };
    /** @param operation Solicitud sin cambios locales de audio. @returns Finalización reconciliada. */
    const run = async (operation: () => Promise<unknown>) => {
      if (!alive()) return;
      this.publish({ error: null });
      try {
        await operation();
      } catch (error) {
        fail(error);
      }
      if (alive()) await refresh();
    };
    /**
     * Conserva una operación en curso y solo la última pendiente por control.
     * @param key Control vigente; el registro se limita al maestro, límite, efectos y voces activos.
     * @param operation Cambio de ganancia o límite, sin estado optimista.
     * @returns Finalización del control, compartida sin acumular una lista de esperas.
     */
    const gain = (
      key: GainKey,
      operation: () => Promise<unknown>,
    ): Promise<void> => {
      if (!alive() || !validGain(key)) return Promise.resolve();
      const current = gains.get(key);
      if (current) {
        current.pending = operation;
        return current.done;
      }
      const entry: GainEntry = {
        engineId: this.view.status?.engine_id ?? "",
        pending: null,
        done: Promise.resolve(),
      };
      gains.set(key, entry);
      /** @returns Ejecución coalescida; los demás controles y las paradas no esperan. */
      const drain = async () => {
        let next: (() => Promise<unknown>) | null = operation;
        while (next && alive() && gains.get(key) === entry && validGain(key)) {
          await run(next);
          next = entry.pending;
          entry.pending = null;
        }
        if (gains.get(key) === entry) gains.delete(key);
      };
      entry.done = drain();
      return entry.done;
    };
    /** @param deviceId Token a seleccionar; undefined solicita enumeración. @returns Transición exclusiva de ruta. */
    const route = async (deviceId?: string) => {
      if (!alive() || this.view.routeBusy) return;
      const routeEpoch = engineEpoch;
      this.publish({ routeBusy: true, error: null, selectionNotice: null });
      try {
        if (deviceId === undefined) {
          this.publish({ devices: [] });
          const devices = await this.api.listOutputDevices();
          if (alive() && routeEpoch === engineEpoch) this.publish({ devices });
        } else {
          const result = await this.api.setOutputDevice(deviceId);
          if (!alive()) return;
          event(result.status);
          this.publish({
            selectionNotice: result.restored_previous
              ? "No se pudo cambiar la salida. Se restauró la salida anterior; las voces detenidas no se reanudan."
              : result.error
                ? "No se pudo seleccionar la salida solicitada."
                : "Salida seleccionada para esta sesión.",
            error: result.error ? audioErrorMessage(result.error) : null,
          });
        }
      } catch (error) {
        fail(error);
      }
      if (alive()) {
        await refresh();
        if (alive()) this.publish({ routeBusy: false });
      }
    };
    const subscription = this.api.subscribeAudio(event, fail);
    let timer: ReturnType<typeof setInterval> | undefined;
    void subscription.ready.then(async () => {
      if (!alive()) return;
      timer = setInterval(() => {
        if (alive()) void refresh();
      }, 1500);
      await refresh();
      if (alive()) await route();
    });
    return {
      alive,
      refresh,
      run,
      gain,
      /** Descarta intenciones anteriores a STOP ALL sin cancelar el IPC ya enviado. */
      discardGains() {
        for (const entry of gains.values()) entry.pending = null;
      },
      route,
      /** Cancela trabajo visual y escuchas, sin detener audio implícitamente. */
      dispose() {
        gains.clear();
        clearInterval(timer);
        subscription.dispose();
      },
    };
  }

  /** @returns Limpieza que invalida respuestas tardías, incluso con StrictMode. */
  start(): () => void {
    this.publish({
      status: null,
      devices: [],
      routeBusy: false,
      error: null,
      selectionNotice: null,
    });
    const session = this.createSession();
    this.session = session;
    return () => {
      if (this.session === session) {
        this.generation++;
        this.session = null;
      }
      session.dispose();
    };
  }

  /** @returns Reconciliación explícita sin enumerar dispositivos. */
  refresh = async () => {
    await this.session?.refresh();
  };
  /** @returns Enumeración exclusiva; no selecciona ninguna salida. */
  refreshDevices = async () => {
    await this.session?.route();
  };
  /** @param id Token vigente. @returns Cambio controlado de salida. */
  selectDevice = async (id: string) => {
    await this.session?.route(id);
  };
  /** @param id Recurso nativo que reiniciar sin afectar otros efectos. @returns Reinicio atómico sin bloqueo entre clics. */
  play = async (id: string) => {
    if (!this.view.routeBusy)
      await this.session?.run(() =>
        this.api.restartEffect(id, {
          looped: false,
          fadeInMs: 0,
          fadeOutMs: 0,
        }),
      );
  };
  /** @param id Recurso nativo que reiniciar sin afectar otros efectos. @param options Opciones del último ACK del botón. @returns Reinicio atómico inmediato, nunca encolado. */
  playWithOptions = async (id: string, options: PlaybackOptions) => {
    if (!this.view.routeBusy)
      await this.session?.run(() => this.api.restartEffect(id, options));
  };
  /** @param id Voz concreta. @param looped Nuevo estado de bucle. @returns Reconciliación sin cambio optimista. */
  setPlaybackLoop = async (id: string, looped: boolean) => {
    await this.session?.run(() => this.api.setPlaybackLoop(id, looped));
  };
  /** @param id Voz concreta. @param durationMs Duración; repetir no extiende el fade. @returns Reconciliación del motor. */
  fadeOutPlayback = async (id: string, durationMs: number) => {
    await this.session?.run(() => this.api.fadeOutPlayback(id, durationMs));
  };
  /** @returns Parada urgente que descarta ganancias y límites pendientes sin cancelar IPC en curso. */
  stopAll = async () => {
    this.session?.discardGains();
    await this.session?.run(() => this.api.stopAll());
  };
  /** @param id Instancia concreta. @returns Parada independiente. */
  stopPlayback = async (id: string) => {
    await this.session?.run(() => this.api.stopPlayback(id));
  };
  /** @param id Recurso nativo. @returns Parada de todas sus voces. */
  stopEffect = async (id: string) => {
    await this.session?.run(() => this.api.stopEffect(id));
  };
  /** @param value Ganancia 0..1. @returns Última intención maestra coalescida. */
  setMasterVolume = (value: number) => {
    return (
      this.session?.gain("master", () => this.api.setMasterVolume(value)) ??
      Promise.resolve()
    );
  };
  /** @param id Recurso nativo. @param value Ganancia de futuras voces. @returns Última intención coalescida del efecto. */
  setEffectVolume = (id: string, value: number) => {
    return (
      this.session?.gain(`effect:${id}`, () =>
        this.api.setEffectVolume(id, value),
      ) ?? Promise.resolve()
    );
  };
  /** @param id Instancia vigente. @param value Ganancia 0..1. @returns Última intención coalescida; se descarta al finalizar la voz. */
  setPlaybackVolume = (id: string, value: number) => {
    return (
      this.session?.gain(`playback:${id}`, () =>
        this.api.setPlaybackVolume(id, value),
      ) ?? Promise.resolve()
    );
  };
  /** @param value Límite entero 1..64. @returns Última intención de límite coalescida, validada por Rust. */
  setLimit = (value: number) => {
    return (
      this.session?.gain("limit", () =>
        this.api.setMaxConcurrentPlaybacks(value),
      ) ?? Promise.resolve()
    );
  };
}
