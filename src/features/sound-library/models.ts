import { z } from "zod";
import type { PlaybackOptions } from "../../shared/contracts/audio";

export const buttonColorSchema = z.enum(
  ["amber", "coral", "mint", "sky", "violet", "slate"],
  { error: "El color del botón no está permitido." },
);

export type ButtonColor = z.infer<typeof buttonColorSchema>;

export const soundButtonSchema = z.strictObject({
  id: z.string().trim().min(1, "El identificador es obligatorio."),
  effectId: z.string().trim().min(1, "El efecto es obligatorio.").nullable(),
  name: z
    .string()
    .trim()
    .min(1, "El nombre es obligatorio.")
    .max(100, "El nombre no puede superar los 100 caracteres."),
  durationMs: z
    .number({ error: "La duración debe ser un número finito." })
    .int("La duración debe ser un número entero.")
    .nonnegative("La duración no puede ser negativa."),
  color: buttonColorSchema,
  category: z
    .string()
    .trim()
    .min(1, "La categoría es obligatoria.")
    .max(60, "La categoría no puede superar los 60 caracteres."),
});

export type SoundButton = z.infer<typeof soundButtonSchema> & {
  playback?: PlaybackOptions;
};
export type ButtonDraft = Pick<
  SoundButton,
  "name" | "durationMs" | "color" | "category"
>;

export const buttonDraftSchema = soundButtonSchema.pick({
  name: true,
  durationMs: true,
  color: true,
  category: true,
});
