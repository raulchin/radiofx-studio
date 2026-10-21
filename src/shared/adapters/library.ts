import { invoke, isTauri } from "@tauri-apps/api/core";
import { z } from "zod";
import {
  columnsSchema,
  importResultSchema,
  librarySnapshotSchema,
  persistentBoardSchema,
  bankImportPreparationSchema,
  bankImportCommitSchema,
  bankExportResultSchema,
  type Columns,
  type PersistentBoard,
} from "../contracts/library";

/** @param command Comando Rust. @param schema Contrato de respuesta. @param args Argumentos validados. @returns Respuesta validada. @throws Ante errores IPC o datos inválidos. */
async function request<T>(
  command: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri())
    throw new Error(
      "La biblioteca persistente requiere la aplicación de escritorio.",
    );
  const result =
    args === undefined
      ? await invoke<unknown>(command)
      : await invoke<unknown>(command, args);
  return schema.parse(result);
}
export const libraryApi = {
  /** @returns Vista previa del selector Rust, sin rutas JS. @throws Ante fallo IPC o contrato inválido. */
  prepareBankImport() {
    return request("prepare_bank_import", bankImportPreparationSchema);
  },
  /** @param token Preparación vigente. @param expectedRevision Revisión confirmada. @param enableShortcuts Activación explícita. @returns Importación atómica confirmada. @throws Ante conflicto o fallo parcial; no reintentar automáticamente. */
  async commitBankImport(
    token: string,
    expectedRevision: number,
    enableShortcuts: boolean,
  ) {
    return request("commit_bank_import", bankImportCommitSchema, {
      token: z.string().min(1).parse(token),
      expectedRevision: z.number().int().nonnegative().parse(expectedRevision),
      enableShortcuts: z.boolean().parse(enableShortcuts),
    });
  },
  /** @param token Preparación a liberar. @returns ACK. @throws Ante fallo IPC o contrato inválido. */
  async cancelBankImport(token: string): Promise<void> {
    await request("cancel_bank_import", z.null(), {
      token: z.string().min(1).parse(token),
    });
  },
  /** @param bankIds Bancos seleccionados. @param expectedRevision Revisión confirmada. @param includeShortcuts Incluye atajos. @returns Resultado del selector Rust. @throws Ante fallo IPC o contrato inválido. */
  async exportSoundBanks(
    bankIds: string[],
    expectedRevision: number,
    includeShortcuts: boolean,
  ) {
    return request("export_sound_banks", bankExportResultSchema, {
      bankIds: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length)
        .parse(bankIds),
      expectedRevision: z.number().int().nonnegative().parse(expectedRevision),
      includeShortcuts: z.boolean().parse(includeShortcuts),
    });
  },
  /** @returns Biblioteca revalidada por Rust. @throws Si falla la lectura o el contrato. */
  getSnapshot() {
    return request("get_library_snapshot", librarySnapshotSchema);
  },
  /** @param board Tablero completo. @param expectedRevision Revisión confirmada anterior. @returns Instantánea guardada. @throws Ante conflicto, fallo durable o contrato inválido. */
  async saveBoard(board: PersistentBoard, expectedRevision: number) {
    return request("save_board", librarySnapshotSchema, {
      board: persistentBoardSchema.parse(board),
      expectedRevision: z.number().int().nonnegative().parse(expectedRevision),
    });
  },
  /** @returns Selección nativa y resultados parciales, sin rutas JS. @throws Ante fallo IPC o contrato inválido. */
  importAudio() {
    return request("import_audio_files", importResultSchema);
  },
  /** @param columns Densidad permitida. @returns Instantánea confirmada. @throws Ante fallo de guardado o validación. */
  async setColumns(columns: Columns) {
    return request("set_library_columns", librarySnapshotSchema, {
      columns: columnsSchema.parse(columns),
    });
  },
};
export type LibraryApi = typeof libraryApi;
