import { vi } from "vitest";
import type { LibraryApi } from "../src/shared/adapters/library";
import {
  librarySnapshotSchema,
  type ImportResult,
  type LibrarySnapshot,
} from "../src/shared/contracts/library";

/** @returns Instantánea persistente mínima con una asignación reproducible y otra sin audio. */
export function librarySnapshot(): LibrarySnapshot {
  return {
    revision: 0,
    board: {
      version: 2,
      keyboardShortcuts: [],
      activeBankId: "bank-1",
      banks: [
        {
          id: "bank-1",
          name: "Principal",
          buttons: [
            {
              id: "button-1",
              effectId: "file-1",
              name: "Aplauso",
              category: "General",
              color: "amber",
              durationMs: 1250,
              playback: { looped: false, fadeInMs: 0, fadeOutMs: 0 },
            },
            {
              id: "button-2",
              effectId: null,
              name: "Sin asignar",
              category: "General",
              color: "sky",
              durationMs: 0,
              playback: { looped: false, fadeInMs: 0, fadeOutMs: 0 },
            },
          ],
        },
      ],
    },
    effects: [
      {
        id: "file-1",
        name: "aplauso.wav",
        durationMs: 1250,
        format: "wav",
        sampleRate: 48000,
        channels: 1,
        byteSize: 120044,
        defaultVolume: 0.5,
        availability: "available",
        error: null,
      },
    ],
    settings: {
      columns: "auto",
      masterVolume: 0.7,
      maxConcurrentPlaybacks: 16,
      preferredDeviceName: "Interfaz USB",
    },
  };
}

/** @returns Backend en memoria reutilizable entre montajes; no toca SQLite ni archivos. */
export function fakeLibrary() {
  let saved = librarySnapshot();
  const api = {
    prepareBankImport: vi.fn<LibraryApi["prepareBankImport"]>(async () => ({
      cancelled: true,
      preview: null,
    })),
    cancelBankImport: vi.fn<LibraryApi["cancelBankImport"]>(async () => {}),
    commitBankImport: vi.fn<LibraryApi["commitBankImport"]>(async () => ({
      snapshot: structuredClone(saved),
      importedBankIds: [],
      reusedEffects: 0,
      warnings: [],
    })),
    exportSoundBanks: vi.fn<LibraryApi["exportSoundBanks"]>(async () => ({
      cancelled: true,
      exportedBanks: 0,
      exportedEffects: 0,
      byteSize: 0,
      warnings: [],
    })),
    getSnapshot: vi.fn(async () => structuredClone(saved)),
    saveBoard: vi.fn<LibraryApi["saveBoard"]>(async (board, revision) => {
      if (revision !== saved.revision)
        throw { code: "revision_conflict", message: "El tablero cambió." };
      saved = librarySnapshotSchema.parse({
        ...saved,
        board,
        revision: revision + 1,
      });
      return structuredClone(saved);
    }),
    setColumns: vi.fn<LibraryApi["setColumns"]>(async (columns) => {
      saved.settings.columns = columns;
      return structuredClone(saved);
    }),
    importAudio: vi.fn<LibraryApi["importAudio"]>(
      async (): Promise<ImportResult> => ({
        cancelled: true,
        imported: [],
        failed: [],
        snapshot: structuredClone(saved),
      }),
    ),
  } satisfies LibraryApi;
  return {
    api,
    /** @param snapshot Estado durable simulado modificado por otro cliente. */
    setSnapshot(snapshot: LibrarySnapshot) {
      saved = structuredClone(snapshot);
    },
    /** @returns Copia del almacenamiento simulado. */
    saved() {
      return structuredClone(saved);
    },
  };
}
