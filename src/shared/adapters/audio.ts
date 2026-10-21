import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import {
  audioEngineStatusSchema,
  audioErrorSchema,
  audioEvents,
  concurrencySchema,
  deviceSelectionResultSchema,
  outputDeviceSchema,
  playbackSchema,
  playbackOptionsSchema,
  fadeDurationSchema,
  type PlaybackOptions,
  volumeSchema,
  type AudioEngineStatus,
} from "../contracts/audio";

/**
 * Convierte errores IPC, validación y transporte en un mensaje visible.
 * @param error Valor rechazado por una operación externa.
 * @returns Mensaje en español con el detalle disponible.
 */
export function audioErrorMessage(error: unknown): string {
  const domain = audioErrorSchema.safeParse(error);
  if (domain.success)
    return `Audio nativo: ${domain.data.message} (${domain.data.code})`;
  if (error instanceof z.ZodError)
    return "Audio nativo: respuesta o parámetro no válido.";
  return `Audio nativo: ${error instanceof Error ? error.message : typeof error === "string" ? error : "no se pudo completar la operación."}`;
}

/**
 * Invoca IPC únicamente en escritorio y valida su resultado desconocido.
 * @param command Comando registrado en Rust.
 * @param schema Contrato del resultado.
 * @param args Argumentos camelCase previamente validados.
 * @returns Resultado validado.
 * @throws Si falta Tauri, falla IPC o el contrato es inválido.
 */
async function request<T>(
  command: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri())
    throw new Error(
      "La consulta nativa requiere abrir la aplicación de escritorio.",
    );
  const payload =
    args === undefined
      ? await invoke<unknown>(command)
      : await invoke<unknown>(command, args);
  return schema.parse(payload);
}

/** @returns Instantánea autoritativa validada. @throws Si falla Tauri o la validación. */
export function getAudioEngineStatus() {
  return request("get_audio_engine_status", audioEngineStatusSchema);
}
/** @returns Dispositivos con tokens de esta enumeración. @throws Si falla IPC o la validación. */
export function listOutputDevices() {
  return request("list_output_devices", z.array(outputDeviceSchema));
}
/** @returns Salida activa o null. @throws Si falla IPC o la validación. */
export function getSelectedOutputDevice() {
  return request("get_selected_output_device", outputDeviceSchema.nullable());
}
/** @param deviceId Token de la enumeración actual. @returns Resultado de transición. @throws Si falla IPC o la validación. */
export function setOutputDevice(deviceId: string) {
  return request("set_output_device", deviceSelectionResultSchema, {
    deviceId: z.string().min(1).parse(deviceId),
  });
}
/** Disparo paralelo explícito de bajo nivel, no usado por la UI. @param effectId Recurso nativo, nunca un ID mock. @returns ID de la nueva instancia. @throws Si falla IPC o la validación. */
export function playEffect(effectId: string) {
  return request("play_effect", z.string().min(1), {
    effectId: z.string().min(1).parse(effectId),
  });
}
/** Disparo paralelo explícito de bajo nivel, no usado por la UI. @param effectId Recurso confirmado. @param options Envolvente y bucle. @returns Nueva voz. @throws Ante fallo IPC o contrato inválido. */
export async function playEffectWithOptions(
  effectId: string,
  options: PlaybackOptions,
) {
  return request("play_effect_with_options", z.string().min(1), {
    effectId: z.string().min(1).parse(effectId),
    options: playbackOptionsSchema.parse(options),
  });
}
/** Reinicia atómicamente solo el efecto indicado, sin detener otros sonidos. @param effectId Recurso confirmado. @param options Envolvente y bucle de la nueva voz. @returns ID de la única voz nueva del efecto. @throws Ante fallo IPC, ausencia de Tauri o contrato inválido. */
export async function restartEffect(
  effectId: string,
  options: PlaybackOptions,
) {
  return request("restart_effect", z.string().min(1), {
    effectId: z.string().min(1).parse(effectId),
    options: playbackOptionsSchema.parse(options),
  });
}
/** @param playbackId Voz activa. @param looped Bucle solicitado; desactivarlo termina la vuelta actual. @returns ACK. @throws Ante fallo IPC o contrato inválido. */
export async function setPlaybackLoop(
  playbackId: string,
  looped: boolean,
): Promise<void> {
  await request("set_playback_loop", z.null(), {
    playbackId: z.string().min(1).parse(playbackId),
    looped: z.boolean().parse(looped),
  });
}
/** @param playbackId Voz activa. @param durationMs Fade; cero detiene inmediatamente. @returns ACK. @throws Ante fallo IPC o contrato inválido. */
export async function fadeOutPlayback(
  playbackId: string,
  durationMs: number,
): Promise<void> {
  await request("fade_out_playback", z.null(), {
    playbackId: z.string().min(1).parse(playbackId),
    durationMs: fadeDurationSchema.parse(durationMs),
  });
}
/** @param playbackId Instancia que detener. @returns Confirmación sin payload. @throws Si falla IPC o la validación. */
export async function stopPlayback(playbackId: string): Promise<void> {
  await request("stop_playback", z.null(), {
    playbackId: z.string().min(1).parse(playbackId),
  });
}
/** @param effectId Recurso cuyas instancias detener. @returns Confirmación sin payload. @throws Si falla IPC o la validación. */
export async function stopEffect(effectId: string): Promise<void> {
  await request("stop_effect", z.null(), {
    effectId: z.string().min(1).parse(effectId),
  });
}
/** @returns Confirmación de parada general. @throws Si falla IPC o la validación. */
export async function stopAll(): Promise<void> {
  await request("stop_all", z.null());
}
/** @param value Ganancia maestra 0..1. @returns Confirmación. @throws Si falla IPC o la validación. */
export async function setMasterVolume(value: number): Promise<void> {
  await request("set_master_volume", z.null(), {
    value: volumeSchema.parse(value),
  });
}
/** @param playbackId Instancia concreta. @param value Ganancia 0..1. @returns Confirmación. @throws Si falla IPC o la validación. */
export async function setPlaybackVolume(
  playbackId: string,
  value: number,
): Promise<void> {
  await request("set_playback_volume", z.null(), {
    playbackId: z.string().min(1).parse(playbackId),
    value: volumeSchema.parse(value),
  });
}
/** @param effectId Recurso para futuras voces. @param value Ganancia 0..1. @returns Confirmación. @throws Si falla IPC o la validación. */
export async function setEffectVolume(
  effectId: string,
  value: number,
): Promise<void> {
  await request("set_effect_volume", z.null(), {
    effectId: z.string().min(1).parse(effectId),
    value: volumeSchema.parse(value),
  });
}
/** @param value Límite entero 1..64. @returns Confirmación. @throws Si falla IPC o la validación. */
export async function setMaxConcurrentPlaybacks(value: number): Promise<void> {
  await request("set_max_concurrent_playbacks", z.null(), {
    value: concurrencySchema.parse(value),
  });
}
/** @returns Instancias activas validadas. @throws Si falla IPC o la validación. */
export function getActivePlaybacks() {
  return request("get_active_playbacks", z.array(playbackSchema));
}

/**
 * Suscribe los siete eventos y libera también listeners que resuelvan tarde.
 * @param onStatus Receptor de instantáneas válidas.
 * @param onError Receptor de fallos de suscripción o payload.
 * @returns Cancelación inmediata y promesa de instalación de todas las escuchas.
 */
export function subscribeAudio(
  onStatus: (status: AudioEngineStatus) => void,
  onError: (error: unknown) => void,
) {
  let closed = false;
  const removers: (() => void)[] = [];
  const ready = Promise.allSettled(
    audioEvents.map(async (name) => {
      if (!isTauri())
        throw new Error(
          "El audio nativo requiere la aplicación de escritorio.",
        );
      const remove = await listen<unknown>(name, (event) => {
        if (closed) return;
        const parsed = audioEngineStatusSchema.safeParse(event.payload);
        if (parsed.success) onStatus(parsed.data);
        else onError(parsed.error);
      });
      if (closed) remove();
      else removers.push(remove);
    }),
  ).then((results) => {
    for (const result of results) {
      if (!closed && result.status === "rejected") onError(result.reason);
    }
  });
  return {
    ready,
    /** Libera las escuchas actuales y marca las pendientes para liberación. */
    dispose() {
      closed = true;
      removers.splice(0).forEach((remove) => remove());
    },
  };
}

export const nativeAudio = {
  getAudioEngineStatus,
  listOutputDevices,
  getSelectedOutputDevice,
  setOutputDevice,
  playEffect,
  playEffectWithOptions,
  restartEffect,
  setPlaybackLoop,
  fadeOutPlayback,
  stopPlayback,
  stopEffect,
  stopAll,
  setMasterVolume,
  setPlaybackVolume,
  setEffectVolume,
  setMaxConcurrentPlaybacks,
  getActivePlaybacks,
  subscribeAudio,
};
export type NativeAudioAdapter = typeof nativeAudio;
