import { z } from "zod";
import { buttonColorSchema } from "../../features/sound-library/models";
import { playbackOptionsSchema } from "./audio";
import { codePointString } from "./text";
import {
  shortcutBindingSchema,
  shortcutProblem,
} from "../../features/keyboard-shortcuts/contracts";

const integer = z.number().int().nonnegative();
const text = codePointString(100)
  .min(1)
  .regex(/^\P{Cc}+$/u)
  .regex(
    /\P{White_Space}/u,
    "El texto no puede contener únicamente espacios Unicode.",
  );
const bankName = text.pipe(codePointString(60));
export const columnsSchema = z.enum(["auto", "3", "4", "6"]);
export const persistentBoardSchema = z
  .strictObject({
    version: z.literal(2),
    keyboardShortcuts: z.array(shortcutBindingSchema).max(512),
    banks: z
      .array(
        z.strictObject({
          id: text,
          name: bankName,
          buttons: z
            .array(
              z.strictObject({
                id: text,
                effectId: text.nullable(),
                name: text,
                durationMs: integer.max(120000),
                color: buttonColorSchema,
                playback: playbackOptionsSchema,
                category: codePointString(80).regex(/^\P{Cc}*$/u),
              }),
            )
            .max(256),
        }),
      )
      .min(1)
      .max(100),
    activeBankId: text,
  })
  .superRefine(
    /** @param board Tablero estructural. @param ctx Incidencias de identidad y selección. */
    (board, ctx) => {
      const ids = new Set<string>();
      const problem = shortcutProblem(board.keyboardShortcuts, board.banks);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
      for (const bank of board.banks) {
        for (const item of [bank, ...bank.buttons]) {
          if (ids.has(item.id))
            ctx.addIssue({
              code: "custom",
              message: "Identificador duplicado.",
            });
          ids.add(item.id);
        }
      }
      if (!board.banks.some((bank) => bank.id === board.activeBankId))
        ctx.addIssue({ code: "custom", message: "Banco activo inexistente." });
    },
  );
export const libraryEffectSchema = z.strictObject({
  id: text,
  name: codePointString(100).min(1),
  durationMs: integer.max(120000),
  format: z.enum(["wav", "mp3", "ogg", "flac"]),
  sampleRate: z.number().int().min(8000).max(192000),
  channels: z.number().int().min(1).max(2),
  byteSize: integer.max(32 * 1024 * 1024),
  defaultVolume: z.number().min(0).max(1),
  availability: z.enum(["available", "missing", "invalid"]),
  error: z.string().nullable(),
});
export const librarySnapshotSchema = z
  .strictObject({
    revision: integer,
    board: persistentBoardSchema,
    effects: z.array(libraryEffectSchema),
    settings: z.strictObject({
      columns: columnsSchema,
      masterVolume: z.number().min(0).max(1),
      maxConcurrentPlaybacks: z.number().int().min(1).max(64),
      preferredDeviceName: z.string().nullable(),
    }),
  })
  .superRefine(
    /** @param snapshot Catálogo y tablero confirmados. @param ctx Incidencias de referencias. */
    (snapshot, ctx) => {
      const effects = new Map(
        snapshot.effects.map((effect) => [effect.id, effect]),
      );
      if (effects.size !== snapshot.effects.length)
        ctx.addIssue({ code: "custom", message: "Efectos duplicados." });
      for (const bank of snapshot.board.banks) {
        for (const button of bank.buttons) {
          const effect =
            button.effectId === null ? null : effects.get(button.effectId);
          if (
            effect === undefined ||
            button.durationMs !== (effect?.durationMs ?? 0)
          )
            ctx.addIssue({
              code: "custom",
              message: "Asignación o duración ajena al catálogo.",
            });
          if (
            !button.playback.looped &&
            button.playback.fadeInMs + button.playback.fadeOutMs >
              (effect?.durationMs ?? 0)
          )
            ctx.addIssue({
              code: "custom",
              message:
                "La suma de fades debe caber en la duración del catálogo.",
            });
        }
      }
    },
  );
export const importResultSchema = z
  .strictObject({
    cancelled: z.boolean(),
    imported: z.array(
      z.strictObject({ effect: libraryEffectSchema, duplicate: z.boolean() }),
    ),
    failed: z.array(z.strictObject({ name: z.string(), message: z.string() })),
    snapshot: librarySnapshotSchema,
  })
  .superRefine(
    /** @param result Resultado parcial de importación. @param ctx Incidencias del catálogo. */
    (result, ctx) => {
      if (result.cancelled && (result.imported.length || result.failed.length))
        ctx.addIssue({ code: "custom", message: "Cancelación incoherente." });
      for (const entry of result.imported) {
        const effect = result.snapshot.effects.find(
          (item) => item.id === entry.effect.id,
        );
        if (!effect || JSON.stringify(effect) !== JSON.stringify(entry.effect))
          ctx.addIssue({
            code: "custom",
            message: "Importación ajena a la instantánea.",
          });
      }
    },
  );
export type LibrarySnapshot = z.infer<typeof librarySnapshotSchema>;
export type LibraryEffect = z.infer<typeof libraryEffectSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;
export type PersistentBoard = LibrarySnapshot["board"];
export type Columns = LibrarySnapshot["settings"]["columns"];
export type PersistentSoundButton =
  PersistentBoard["banks"][number]["buttons"][number];

export const bankImportPreviewSchema = z.strictObject({
  token: text,
  bankNames: z.array(bankName),
  effectCount: integer,
  buttonCount: integer,
  shortcutCount: integer,
  warnings: z.array(z.string()),
});
export const bankImportPreparationSchema = z
  .strictObject({
    cancelled: z.boolean(),
    preview: bankImportPreviewSchema.nullable(),
  })
  .refine(
    (value) => value.cancelled === (value.preview === null),
    "Preparación incoherente.",
  );
export const bankImportCommitSchema = z
  .strictObject({
    snapshot: librarySnapshotSchema,
    importedBankIds: z.array(text),
    reusedEffects: integer,
    warnings: z.array(z.string()),
  })
  .refine(
    (value) =>
      new Set(value.importedBankIds).size === value.importedBankIds.length &&
      value.importedBankIds.every((id) =>
        value.snapshot.board.banks.some((bank) => bank.id === id),
      ),
    "Bancos importados ajenos a la instantánea.",
  );
export const bankExportResultSchema = z
  .strictObject({
    cancelled: z.boolean(),
    exportedBanks: integer,
    exportedEffects: integer,
    byteSize: integer,
    warnings: z.array(z.string()),
  })
  .refine(
    (value) =>
      !value.cancelled ||
      (value.exportedBanks === 0 &&
        value.exportedEffects === 0 &&
        value.byteSize === 0),
    "Exportación cancelada incoherente.",
  );
export type BankImportPreview = z.infer<typeof bankImportPreviewSchema>;
