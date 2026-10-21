import { z } from "zod";

export const volumeSchema = z.number().finite().min(0).max(1);
export const concurrencySchema = z.number().int().min(1).max(64);
export const fadeDurationSchema = z.number().int().min(0).max(30000);
export const playbackOptionsSchema = z.strictObject({
  looped: z.boolean(),
  fadeInMs: fadeDurationSchema,
  fadeOutMs: fadeDurationSchema,
});
export type PlaybackOptions = z.infer<typeof playbackOptionsSchema>;
export const outputDeviceSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  is_default: z.boolean(),
});
export const nativeEffectSchema = z.strictObject({
  effect_id: z.string().min(1),
  name: z.string(),
  duration_ms: z.number().int().nonnegative(),
  default_volume: volumeSchema,
});
export const playbackSchema = z.strictObject({
  playback_id: z.string().min(1),
  effect_id: z.string().min(1),
  volume: volumeSchema,
  looped: z.boolean(),
  state: z.enum(["playing", "fading_out"]),
  fade_out_ms: fadeDurationSchema,
});
export const audioErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
});
export const audioEngineStatusSchema = z.strictObject({
  engine_id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  state: z.enum(["not_initialized", "ready", "device_error"]),
  selected_device: outputDeviceSchema.nullable(),
  active_playbacks: z.array(playbackSchema),
  master_volume: volumeSchema,
  max_concurrent_playbacks: concurrencySchema,
  last_error: audioErrorSchema.nullable(),
  effects: z.array(nativeEffectSchema),
});
export const deviceSelectionResultSchema = z.strictObject({
  status: audioEngineStatusSchema,
  restored_previous: z.boolean(),
  error: audioErrorSchema.nullable(),
});

export const audioEvents = [
  "audio:playback-started",
  "audio:playback-finished",
  "audio:playback-stopped",
  "audio:playback-error",
  "audio:device-changed",
  "audio:device-error",
  "audio:state-changed",
] as const;

export type AudioEngineStatus = z.infer<typeof audioEngineStatusSchema>;
export type OutputDevice = z.infer<typeof outputDeviceSchema>;
export type DeviceSelectionResult = z.infer<typeof deviceSelectionResultSchema>;
