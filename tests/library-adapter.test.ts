import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { libraryApi } from "../src/shared/adapters/library";
import {
  importResultSchema,
  librarySnapshotSchema,
  type LibrarySnapshot,
} from "../src/shared/contracts/library";
import { librarySnapshot } from "./library-fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});

describe("library IPC contract", () => {
  it("uses the four exact commands and camelCase arguments without file paths", async () => {
    const snapshot = librarySnapshot();
    vi.mocked(invoke).mockResolvedValue(snapshot);
    await libraryApi.getSnapshot();
    expect(invoke).toHaveBeenLastCalledWith("get_library_snapshot");
    await libraryApi.saveBoard(snapshot.board, 3);
    expect(invoke).toHaveBeenLastCalledWith("save_board", {
      board: snapshot.board,
      expectedRevision: 3,
    });
    await libraryApi.setColumns("6");
    expect(invoke).toHaveBeenLastCalledWith("set_library_columns", {
      columns: "6",
    });
    vi.mocked(invoke).mockResolvedValue({
      cancelled: true,
      imported: [],
      failed: [],
      snapshot,
    });
    await libraryApi.importAudio();
    expect(invoke).toHaveBeenLastCalledWith("import_audio_files");
  });
  it("refuses browser persistence and invalid outgoing revisions", async () => {
    await expect(
      libraryApi.saveBoard(librarySnapshot().board, -1),
    ).rejects.toThrow();
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(libraryApi.getSnapshot()).rejects.toThrow("escritorio");
    expect(invoke).not.toHaveBeenCalled();
  });
  const corruptions: [string, (snapshot: LibrarySnapshot) => unknown][] = [
    ["negative revision", (s) => ({ ...s, revision: -1 })],
    ["fractional revision", (s) => ({ ...s, revision: 0.1 })],
    [
      "unsafe integer revision",
      (s) => ({ ...s, revision: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["unknown field", (s) => ({ ...s, localPath: "/tmp/private" })],
    [
      "empty banks",
      (s) => {
        s.board.banks = [];
        return s;
      },
    ],
    [
      "foreign active bank",
      (s) => {
        s.board.activeBankId = "absent";
        return s;
      },
    ],
    [
      "duplicate assignment",
      (s) => {
        s.board.banks[0].buttons.push(s.board.banks[0].buttons[0]);
        return s;
      },
    ],
    [
      "bank and assignment shared id",
      (s) => {
        s.board.banks[0].buttons[0].id = "bank-1";
        return s;
      },
    ],
    [
      "foreign effect",
      (s) => {
        s.board.banks[0].buttons[0].effectId = "absent";
        return s;
      },
    ],
    [
      "fake duration",
      (s) => {
        s.board.banks[0].buttons[0].durationMs = 2;
        return s;
      },
    ],
    [
      "unassigned fake duration",
      (s) => {
        s.board.banks[0].buttons[1].durationMs = 2;
        return s;
      },
    ],
    [
      "duplicate effect",
      (s) => {
        s.effects.push(s.effects[0]);
        return s;
      },
    ],
    [
      "invalid color",
      (s) => ({
        ...s,
        board: {
          ...s.board,
          banks: [
            {
              ...s.board.banks[0],
              buttons: [{ ...s.board.banks[0].buttons[0], color: "red-500" }],
            },
          ],
        },
      }),
    ],
    [
      "unsupported format",
      (s) => ({ ...s, effects: [{ ...s.effects[0], format: "aac" }] }),
    ],
    [
      "invalid availability",
      (s) => ({ ...s, effects: [{ ...s.effects[0], availability: "cached" }] }),
    ],
    [
      "sample rate",
      (s) => {
        s.effects[0].sampleRate = 192001;
        return s;
      },
    ],
    [
      "channels",
      (s) => {
        s.effects[0].channels = 3;
        return s;
      },
    ],
    [
      "size",
      (s) => {
        s.effects[0].byteSize = 32 * 1024 * 1024 + 1;
        return s;
      },
    ],
    [
      "duration limit",
      (s) => {
        s.effects[0].durationMs = 120001;
        return s;
      },
    ],
    [
      "gain",
      (s) => {
        s.effects[0].defaultVolume = 1.01;
        return s;
      },
    ],
    [
      "master",
      (s) => {
        s.settings.masterVolume = NaN;
        return s;
      },
    ],
    [
      "voice limit",
      (s) => {
        s.settings.maxConcurrentPlaybacks = 65;
        return s;
      },
    ],
    ["columns", (s) => ({ ...s, settings: { ...s.settings, columns: "5" } })],
    [
      "missing nullable field",
      (s) => ({
        ...s,
        settings: {
          columns: "auto",
          masterVolume: 0.7,
          maxConcurrentPlaybacks: 16,
        },
      }),
    ],
  ];
  it.each(corruptions)(
    "rejects malformed unknown response: %s",
    async (_name, corrupt) => {
      vi.mocked(invoke).mockResolvedValue(corrupt(librarySnapshot()));
      await expect(libraryApi.getSnapshot()).rejects.toThrow();
    },
  );
  it("validates every command response, not just initial loading", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await expect(
      libraryApi.saveBoard(librarySnapshot().board, 0),
    ).rejects.toThrow();
    await expect(libraryApi.setColumns("3")).rejects.toThrow();
    await expect(libraryApi.importAudio()).rejects.toThrow();
  });
  it("accepts backend empty categories and unavailable effects without pretending availability", () => {
    const snapshot = librarySnapshot();
    snapshot.board.banks[0].buttons[0].category = "";
    snapshot.effects[0].availability = "invalid";
    snapshot.effects[0].error = "Caché agotada";
    expect(librarySnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
  it("rejects import entries outside the returned catalog and contradictory cancellation", () => {
    const snapshot = librarySnapshot();
    expect(
      importResultSchema.safeParse({
        cancelled: false,
        imported: [
          {
            effect: { ...snapshot.effects[0], id: "foreign" },
            duplicate: false,
          },
        ],
        failed: [],
        snapshot,
      }).success,
    ).toBe(false);
    expect(
      importResultSchema.safeParse({
        cancelled: true,
        imported: [],
        failed: [{ name: "x", message: "failure" }],
        snapshot,
      }).success,
    ).toBe(false);
  });
});
