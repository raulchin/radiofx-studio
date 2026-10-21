import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { libraryApi } from "../src/shared/adapters/library";
import { nativeAudio } from "../src/shared/adapters/audio";
import { librarySnapshot } from "./library-fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
beforeEach(() => vi.clearAllMocks());

describe("phase five exact IPC", () => {
  it("sends all seven new commands with camelCase validated arguments", async () => {
    const options = { looped: true, fadeInMs: 123, fadeOutMs: 456 };
    vi.mocked(invoke).mockResolvedValueOnce("voice");
    await expect(
      nativeAudio.playEffectWithOptions("file-1", options),
    ).resolves.toBe("voice");
    expect(invoke).toHaveBeenLastCalledWith("play_effect_with_options", {
      effectId: "file-1",
      options,
    });
    vi.mocked(invoke).mockResolvedValue(null);
    await nativeAudio.setPlaybackLoop("voice", false);
    expect(invoke).toHaveBeenLastCalledWith("set_playback_loop", {
      playbackId: "voice",
      looped: false,
    });
    await nativeAudio.fadeOutPlayback("voice", 0);
    expect(invoke).toHaveBeenLastCalledWith("fade_out_playback", {
      playbackId: "voice",
      durationMs: 0,
    });
    await libraryApi.cancelBankImport("token");
    expect(invoke).toHaveBeenLastCalledWith("cancel_bank_import", {
      token: "token",
    });
    vi.mocked(invoke).mockResolvedValueOnce({ cancelled: true, preview: null });
    await libraryApi.prepareBankImport();
    expect(invoke).toHaveBeenLastCalledWith("prepare_bank_import");
    vi.mocked(invoke).mockResolvedValueOnce({
      snapshot: librarySnapshot(),
      importedBankIds: ["bank-1"],
      reusedEffects: 1,
      warnings: [],
    });
    await libraryApi.commitBankImport("token", 7, false);
    expect(invoke).toHaveBeenLastCalledWith("commit_bank_import", {
      token: "token",
      expectedRevision: 7,
      enableShortcuts: false,
    });
    vi.mocked(invoke).mockResolvedValueOnce({
      cancelled: false,
      exportedBanks: 1,
      exportedEffects: 1,
      byteSize: 512,
      warnings: [],
    });
    await libraryApi.exportSoundBanks(["bank-1"], 8, true);
    expect(invoke).toHaveBeenLastCalledWith("export_sound_banks", {
      bankIds: ["bank-1"],
      expectedRevision: 8,
      includeShortcuts: true,
    });
  });
  it("rejects bad outgoing values before IPC and malformed unknown replies", async () => {
    for (const durationMs of [NaN, Infinity, -1, 30001, 1.2])
      await expect(
        nativeAudio.fadeOutPlayback("voice", durationMs),
      ).rejects.toThrow();
    await expect(libraryApi.commitBankImport("", 0, false)).rejects.toThrow();
    await expect(libraryApi.exportSoundBanks([], 0, false)).rejects.toThrow();
    await expect(
      libraryApi.exportSoundBanks(["a", "a"], 0, false),
    ).rejects.toThrow();
    await expect(
      libraryApi.commitBankImport("token", -1, false),
    ).rejects.toThrow();
    await expect(
      nativeAudio.playEffectWithOptions("e", {
        looped: false,
        fadeInMs: 0.5,
        fadeOutMs: 0,
      }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockResolvedValue({ unexpected: true });
    await expect(libraryApi.prepareBankImport()).rejects.toThrow();
    await expect(
      libraryApi.commitBankImport("token", 0, true),
    ).rejects.toThrow();
    await expect(
      libraryApi.exportSoundBanks(["bank-1"], 0, false),
    ).rejects.toThrow();
    await expect(libraryApi.cancelBankImport("token")).rejects.toThrow();
    await expect(nativeAudio.setPlaybackLoop("voice", true)).rejects.toThrow();
    await expect(nativeAudio.fadeOutPlayback("voice", 1000)).rejects.toThrow();
    await expect(
      nativeAudio.playEffectWithOptions("e", {
        looped: false,
        fadeInMs: 0,
        fadeOutMs: 0,
      }),
    ).rejects.toThrow();
  });
});
