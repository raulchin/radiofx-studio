import { vi } from "vitest";
import type { AudioEngineStatus } from "../src/shared/contracts/audio";
import type { NativeAudioAdapter } from "../src/shared/adapters/audio";

/** @param patch Cambios del estado seguro inicial. @returns Instantánea nativa completa. */
export function nativeStatus(
  patch: Partial<AudioEngineStatus> = {},
): AudioEngineStatus {
  return {
    engine_id: "00000000-0000-4000-8000-000000000001",
    revision: 0,
    state: "not_initialized",
    selected_device: null,
    active_playbacks: [],
    master_volume: 0.7,
    max_concurrent_playbacks: 16,
    last_error: null,
    effects: [
      {
        effect_id: "native-test-chime",
        name: "Señal de prueba aguda",
        duration_ms: 450,
        default_volume: 0.5,
      },
      {
        effect_id: "native-test-pulse",
        name: "Señal de prueba pulsada",
        duration_ms: 300,
        default_volume: 0.5,
      },
      {
        effect_id: "native-test-low",
        name: "Señal de prueba grave",
        duration_ms: 4000,
        default_volume: 0.5,
      },
    ],
    ...patch,
  };
}

/** @returns Promesa cuyo resultado controla la prueba, sin temporizadores reales. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export const output = {
  id: "session-token-1",
  name: "Interfaz USB",
  is_default: true,
};

/** @returns Adaptador con eventos y respuestas controlables sin Tauri. */
export function fakeNative() {
  let status = nativeStatus({ state: "ready", selected_device: output });
  let playbackSequence = 0;
  let receive: (value: AudioEngineStatus) => void = () => {};
  const dispose = vi.fn();
  const api = {
    getAudioEngineStatus: vi.fn(async () => status),
    listOutputDevices: vi.fn(async () => [output]),
    getSelectedOutputDevice: vi.fn(async () => status.selected_device),
    setOutputDevice: vi.fn(async () => ({
      status,
      restored_previous: false,
      error: null,
    })),
    playEffect: vi.fn(async () => "playback-new"),
    playEffectWithOptions: vi.fn<NativeAudioAdapter["playEffectWithOptions"]>(
      async () => "playback-new",
    ),
    restartEffect: vi.fn<NativeAudioAdapter["restartEffect"]>(
      /** @param effectId Efecto que sustituir. @param options Opciones confirmadas. @returns ID nuevo tras aplicar el reinicio al estado autoritativo simulado. */
      async (effectId, options) => {
        const playbackId = `restart-${++playbackSequence}`;
        status = {
          ...status,
          revision: status.revision + 1,
          active_playbacks: [
            ...status.active_playbacks.filter(
              (voice) => voice.effect_id !== effectId,
            ),
            {
              playback_id: playbackId,
              effect_id: effectId,
              volume:
                status.effects.find((effect) => effect.effect_id === effectId)
                  ?.default_volume ?? 0.5,
              looped: options.looped,
              state: "playing",
              fade_out_ms: options.fadeOutMs,
            },
          ],
        };
        return playbackId;
      },
    ),
    setPlaybackLoop: vi.fn<NativeAudioAdapter["setPlaybackLoop"]>(
      async () => {},
    ),
    fadeOutPlayback: vi.fn<NativeAudioAdapter["fadeOutPlayback"]>(
      async () => {},
    ),
    stopPlayback: vi.fn(async () => {}),
    stopEffect: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
    setMasterVolume: vi.fn<NativeAudioAdapter["setMasterVolume"]>(
      async () => {},
    ),
    setPlaybackVolume: vi.fn<NativeAudioAdapter["setPlaybackVolume"]>(
      async () => {},
    ),
    setEffectVolume: vi.fn<NativeAudioAdapter["setEffectVolume"]>(
      async () => {},
    ),
    setMaxConcurrentPlaybacks: vi.fn<
      NativeAudioAdapter["setMaxConcurrentPlaybacks"]
    >(async () => {}),
    getActivePlaybacks: vi.fn(async () => status.active_playbacks),
    subscribeAudio: vi.fn((onStatus: (value: AudioEngineStatus) => void) => {
      receive = onStatus;
      return { ready: Promise.resolve(), dispose };
    }),
  } satisfies NativeAudioAdapter;
  return {
    api,
    dispose,
    /** @param value Nueva respuesta de consulta, sin emitir evento. */
    setStatus(value: AudioEngineStatus) {
      status = value;
    },
    /** @param value Instantánea de evento; no cambia automáticamente las consultas. */
    emit(value: AudioEngineStatus) {
      receive(value);
    },
  };
}
