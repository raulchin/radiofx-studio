import { z } from "zod";
import { soundButtonSchema } from "../sound-library/models";

export const soundBankSchema = z.strictObject({
  id: z.string().trim().min(1, "El identificador es obligatorio."),
  name: z
    .string()
    .trim()
    .min(1, "El nombre del banco es obligatorio.")
    .max(80, "El nombre del banco no puede superar los 80 caracteres."),
  buttons: z.array(soundButtonSchema),
});

export type SoundBank = z.infer<typeof soundBankSchema>;

export const boardSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    banks: z.array(soundBankSchema).min(1, "Debe existir al menos un banco."),
    activeBankId: z.string().trim().min(1, "El banco activo es obligatorio."),
  })
  .superRefine(
    /**
     * Registra IDs repetidos y referencias a bancos activos inexistentes.
     * @param snapshot Recursos ya validados estructuralmente.
     * @param context Receptor de incidencias de validación.
     */
    (snapshot, context) => {
      const bankIds = new Set<string>();
      const buttonIds = new Set<string>();
      for (const bank of snapshot.banks) {
        if (bankIds.has(bank.id)) {
          context.addIssue({
            code: "custom",
            message: "Hay bancos duplicados.",
          });
        }
        bankIds.add(bank.id);
        for (const button of bank.buttons) {
          if (buttonIds.has(button.id)) {
            context.addIssue({
              code: "custom",
              message:
                "Hay identificadores de botón duplicados entre los bancos.",
            });
          }
          buttonIds.add(button.id);
        }
      }
      if (!bankIds.has(snapshot.activeBankId)) {
        context.addIssue({
          code: "custom",
          message: "El banco activo no existe.",
        });
      }
    },
  );

export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;
