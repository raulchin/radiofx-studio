import { z } from "zod";
import { codePointString } from "../../shared/contracts/text";

const chordFieldsSchema = z.strictObject({
  code: z
    .string()
    .regex(
      /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-2])|Space|Arrow(Up|Down|Left|Right))$/,
    ),
  ctrl: z.boolean(),
  alt: z.boolean(),
  shift: z.boolean(),
  meta: z.boolean(),
});
export const keyChordSchema = chordFieldsSchema.refine(
  (chord) => !isReservedChord(chord),
  "Combinación reservada por la aplicación o el navegador.",
);
export const shortcutBindingSchema = z.strictObject({
  id: codePointString(100)
    .min(1)
    .regex(/^\P{Cc}+$/u)
    .regex(
      /\P{White_Space}/u,
      "El identificador no puede contener únicamente espacios Unicode.",
    ),
  scope: z.enum(["application", "bank"]),
  scopeBankId: z.string().nullable(),
  chord: keyChordSchema,
  action: z.strictObject({
    kind: z.enum(["play_button", "select_bank", "stop_all"]),
    targetId: z.string().nullable(),
  }),
  enabled: z.boolean(),
});
export type KeyChord = z.infer<typeof chordFieldsSchema>;
export type ShortcutBinding = z.infer<typeof shortcutBindingSchema>;

/** @param chord Combinación física. @returns Si está reservada incluso estando deshabilitada. */
export function isReservedChord(chord: KeyChord): boolean {
  return (
    (chord.ctrl && chord.shift && chord.code === "Space") ||
    ((chord.ctrl || chord.meta) &&
      ["KeyR", "KeyW", "KeyL", "KeyT", "KeyN", "KeyQ"].includes(chord.code)) ||
    chord.code === "F5" ||
    (chord.alt && chord.code === "F4")
  );
}
/** @param chord Combinación física. @returns Identidad estable y etiqueta independiente del carácter impreso. */
export function chordLabel(chord: KeyChord): string {
  return [
    chord.ctrl && "Ctrl",
    chord.alt && "Alt",
    chord.shift && "Shift",
    chord.meta && "Meta",
    chord.code,
  ]
    .filter(Boolean)
    .join("+");
}
/** @param bindings Atajos confirmados o propuestos. @param banks Referencias del tablero. @returns Primer error de referencias o colisión activa. */
export function shortcutProblem(
  bindings: ShortcutBinding[],
  banks: { id: string; buttons: { id: string }[] }[],
): string | null {
  if (
    bindings.length > 512 ||
    new Set(bindings.map((binding) => binding.id)).size !== bindings.length
  )
    return "Máximo 512 atajos con identificadores únicos.";
  for (const [index, binding] of bindings.entries()) {
    if (!shortcutBindingSchema.safeParse(binding).success)
      return "Atajo inválido o combinación reservada.";
    const bank = banks.find((item) => item.id === binding.scopeBankId);
    if (binding.scope === "application" ? binding.scopeBankId !== null : !bank)
      return "Ámbito de banco inexistente.";
    const { kind, targetId } = binding.action;
    const valid =
      kind === "stop_all"
        ? targetId === null
        : kind === "select_bank"
          ? banks.some((item) => item.id === targetId)
          : banks
              .filter(
                (item) =>
                  binding.scope === "application" || item.id === bank?.id,
              )
              .some((item) =>
                item.buttons.some((button) => button.id === targetId),
              );
    if (!valid) return "El destino no pertenece al ámbito seleccionado.";
    if (
      binding.enabled &&
      bindings
        .slice(0, index)
        .some(
          (other) =>
            other.enabled &&
            chordLabel(other.chord) === chordLabel(binding.chord) &&
            (binding.scope === "application" ||
              other.scope === "application" ||
              binding.scopeBankId === other.scopeBankId),
        )
    )
      return "Conflicto: la combinación ya está activa en ese ámbito.";
  }
  return null;
}
