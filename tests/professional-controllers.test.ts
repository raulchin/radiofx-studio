import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryController } from "../src/features/sound-library/library-controller";
import { NativeAudioController } from "../src/features/audio-controls/native-controller";
import type {
  BankImportPreview,
  LibrarySnapshot,
} from "../src/shared/contracts/library";
import { fakeLibrary } from "./library-fixtures";
import { deferred, fakeNative, nativeStatus, output } from "./native-fixtures";

const preview: BankImportPreview = {
  token: "prepared-token",
  bankNames: ["Noticias"],
  effectCount: 1,
  buttonCount: 1,
  shortcutCount: 1,
  warnings: ["Revisar origen"],
};
const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));
/** @returns Controlador montado con biblioteca temporal simulada. */
async function setup() {
  const fake = fakeLibrary();
  const controller = new LibraryController(fake.api);
  const dispose = controller.start();
  disposers.push(dispose);
  await controller.refresh();
  return { fake, controller, dispose };
}

describe("bank package stages", () => {
  it("publishes a preview only on ACK without editing the confirmed board", async () => {
    const { fake, controller } = await setup();
    const pending = deferred<{
      cancelled: boolean;
      preview: BankImportPreview | null;
    }>();
    fake.api.prepareBankImport.mockReturnValueOnce(pending.promise);
    const before = controller.getSnapshot().snapshot;
    const done = controller.prepareBankImport();
    await Promise.resolve();
    expect(controller.getSnapshot().preview).toBeNull();
    expect(controller.getSnapshot().snapshot).toBe(before);
    pending.resolve({ cancelled: false, preview });
    await done;
    expect(controller.getSnapshot().preview).toEqual(preview);
    expect(controller.getSnapshot().snapshot).toEqual(before);
    expect(fake.api.commitBankImport).not.toHaveBeenCalled();
  });
  it("releases a current token once across repeated close and unmount", async () => {
    const { fake, controller, dispose } = await setup();
    fake.api.prepareBankImport.mockResolvedValueOnce({
      cancelled: false,
      preview,
    });
    await controller.prepareBankImport();
    await controller.cancelBankImport();
    await controller.cancelBankImport();
    dispose();
    expect(fake.api.cancelBankImport).toHaveBeenCalledExactlyOnceWith(
      preview.token,
    );
  });
  it("releases a late prepare reply after closing without waiting for the native picker", async () => {
    const { fake, controller } = await setup();
    const pending = deferred<{
      cancelled: boolean;
      preview: BankImportPreview | null;
    }>();
    const began = deferred<void>();
    fake.api.prepareBankImport.mockImplementationOnce(() => {
      began.resolve();
      return pending.promise;
    });
    const done = controller.prepareBankImport();
    await began.promise;
    await controller.cancelBankImport();
    expect(controller.getSnapshot().busy).toBe(true);
    pending.resolve({ cancelled: false, preview });
    await done;
    expect(controller.getSnapshot().preview).toBeNull();
    expect(fake.api.cancelBankImport).toHaveBeenCalledExactlyOnceWith(
      preview.token,
    );
  });
  it("does not start preparation if closed before its first await resumes", async () => {
    const { fake, controller } = await setup();
    const done = controller.prepareBankImport();
    await controller.cancelBankImport();
    await done;
    expect(fake.api.prepareBankImport).not.toHaveBeenCalled();
  });
  it("releases late tokens after unmount and ignores old replies across a StrictMode restart", async () => {
    const { fake, controller, dispose } = await setup();
    const pending = deferred<{
      cancelled: boolean;
      preview: BankImportPreview | null;
    }>();
    const began = deferred<void>();
    fake.api.prepareBankImport.mockImplementationOnce(() => {
      began.resolve();
      return pending.promise;
    });
    const done = controller.prepareBankImport();
    await began.promise;
    dispose();
    disposers.push(controller.start());
    await controller.refresh();
    pending.resolve({ cancelled: false, preview });
    await done;
    expect(controller.getSnapshot().preview).toBeNull();
    expect(fake.api.cancelBankImport).toHaveBeenCalledExactlyOnceWith(
      preview.token,
    );
  });
  it("cancels the previous token before preparing another package", async () => {
    const { fake, controller } = await setup();
    fake.api.prepareBankImport.mockResolvedValueOnce({
      cancelled: false,
      preview,
    });
    await controller.prepareBankImport();
    const cancellation = deferred<void>();
    fake.api.cancelBankImport.mockReturnValueOnce(cancellation.promise);
    const next = controller.prepareBankImport();
    await Promise.resolve();
    expect(fake.api.prepareBankImport).toHaveBeenCalledTimes(1);
    cancellation.resolve();
    await next;
    expect(fake.api.prepareBankImport).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().preview).toBeNull();
    expect(controller.getSnapshot().packageNotice).toContain("cancelada");
  });
  it("accepts additive bank imports only on a single confirmed commit", async () => {
    const { fake, controller } = await setup();
    fake.api.prepareBankImport.mockResolvedValueOnce({
      cancelled: false,
      preview,
    });
    await controller.prepareBankImport();
    const snapshot = fake.saved();
    snapshot.revision++;
    snapshot.board.banks.push({
      id: "imported-bank",
      name: "Noticias",
      buttons: [],
    });
    const pending = deferred<{
      snapshot: LibrarySnapshot;
      importedBankIds: string[];
      reusedEffects: number;
      warnings: string[];
    }>();
    fake.api.commitBankImport.mockReturnValueOnce(pending.promise);
    const done = controller.commitBankImport(false);
    await Promise.resolve();
    expect(controller.getSnapshot().snapshot?.board.banks).toHaveLength(1);
    expect(controller.getSnapshot().preview).toBeNull();
    await controller.cancelBankImport();
    expect(fake.api.cancelBankImport).not.toHaveBeenCalled();
    pending.resolve({
      snapshot,
      importedBankIds: ["imported-bank"],
      reusedEffects: 1,
      warnings: ["Valores locales conservados"],
    });
    await done;
    expect(fake.api.commitBankImport).toHaveBeenCalledExactlyOnceWith(
      preview.token,
      0,
      false,
    );
    expect(controller.getSnapshot().snapshot).toEqual(snapshot);
    expect(controller.getSnapshot().packageNotice).toContain(
      "Valores locales conservados",
    );
  });
  it.each([
    "revision_conflict",
    "catalog_registration_pending",
    "persistence_partial_failure",
    "invalid_package",
  ])(
    "reloads after %s without retrying or keeping an unusable preview",
    async (code) => {
      const { fake, controller } = await setup();
      fake.api.prepareBankImport.mockResolvedValueOnce({
        cancelled: false,
        preview,
      });
      await controller.prepareBankImport();
      const saved = fake.saved();
      saved.revision = 5;
      saved.board.banks[0].name = "Cambio confirmado";
      fake.setSnapshot(saved);
      fake.api.commitBankImport.mockRejectedValueOnce({
        code,
        message: "Revisar biblioteca",
      });
      expect(await controller.commitBankImport(true)).toBe(false);
      expect(fake.api.commitBankImport).toHaveBeenCalledTimes(1);
      expect(fake.api.cancelBankImport).toHaveBeenCalledExactlyOnceWith(
        preview.token,
      );
      expect(controller.getSnapshot().preview).toBeNull();
      expect(controller.getSnapshot().snapshot).toEqual(saved);
      expect(controller.getSnapshot().error).toContain("Se recargó");
    },
  );
  it("does not publish a committed result into a new mounting generation", async () => {
    const { fake, controller, dispose } = await setup();
    fake.api.prepareBankImport.mockResolvedValueOnce({
      cancelled: false,
      preview,
    });
    await controller.prepareBankImport();
    const began = deferred<void>();
    const pending = deferred<{
      snapshot: LibrarySnapshot;
      importedBankIds: string[];
      reusedEffects: number;
      warnings: string[];
    }>();
    fake.api.commitBankImport.mockImplementationOnce(() => {
      began.resolve();
      return pending.promise;
    });
    const done = controller.commitBankImport(false);
    await began.promise;
    dispose();
    disposers.push(controller.start());
    await controller.refresh();
    pending.resolve({
      snapshot: fake.saved(),
      importedBankIds: [],
      reusedEffects: 0,
      warnings: [],
    });
    await done;
    expect(controller.getSnapshot().packageNotice).toBeNull();
    expect(fake.api.commitBankImport).toHaveBeenCalledTimes(1);
  });
  it("reports malformed preparations without presenting a fake preview", async () => {
    const { fake, controller } = await setup();
    fake.api.prepareBankImport.mockResolvedValueOnce({
      cancelled: false,
      preview: null,
    });
    expect(await controller.prepareBankImport()).toBe(false);
    expect(controller.getSnapshot().preview).toBeNull();
    expect(controller.getSnapshot().error).toContain("no válido");
  });
  it("serializes export behind saved board ACK and reports cancellation and warnings truthfully", async () => {
    const { fake, controller } = await setup();
    const pending = deferred<LibrarySnapshot>();
    fake.api.saveBoard.mockReturnValueOnce(pending.promise);
    const save = controller.updateBoard((board) => {
      board.banks[0].name = "Nuevo";
    });
    const exporting = controller.exportSoundBanks(["bank-1"], true);
    await Promise.resolve();
    expect(fake.api.exportSoundBanks).not.toHaveBeenCalled();
    const snapshot = fake.saved();
    snapshot.revision = 1;
    pending.resolve(snapshot);
    await save;
    await exporting;
    expect(fake.api.exportSoundBanks).toHaveBeenCalledExactlyOnceWith(
      ["bank-1"],
      1,
      true,
    );
    expect(controller.getSnapshot().packageNotice).toBe(
      "Exportación cancelada.",
    );
    fake.api.exportSoundBanks.mockResolvedValueOnce({
      cancelled: false,
      exportedBanks: 1,
      exportedEffects: 1,
      byteSize: 512,
      warnings: ["Aviso exportado"],
    });
    await controller.exportSoundBanks(["bank-1"], false);
    expect(controller.getSnapshot().packageNotice).toContain(
      "512 bytes. Aviso exportado",
    );
  });
  it("surfaces export failures and does not silently retry", async () => {
    const { fake, controller } = await setup();
    fake.api.exportSoundBanks.mockRejectedValueOnce({
      code: "already_exists",
      message: "No se sobrescribe el destino",
    });
    expect(await controller.exportSoundBanks(["bank-1"], false)).toBe(false);
    expect(controller.getSnapshot().error).toContain("No se sobrescribe");
    expect(fake.api.exportSoundBanks).toHaveBeenCalledTimes(1);
  });
});

describe("native professional operations", () => {
  it("does not serialize plays loops or fades in front of urgent stops or invent playback state", async () => {
    const fake = fakeNative();
    const status = nativeStatus({
      state: "ready",
      selected_device: output,
      active_playbacks: [
        {
          playback_id: "voice",
          effect_id: "native-test-chime",
          volume: 0.5,
          looped: true,
          state: "playing",
          fade_out_ms: 750,
        },
      ],
    });
    fake.setStatus(status);
    const controller = new NativeAudioController(fake.api);
    disposers.push(controller.start());
    await controller.refresh();
    await vi.waitFor(() => {
      expect(fake.api.listOutputDevices).toHaveBeenCalled();
      expect(controller.getSnapshot().routeBusy).toBe(false);
    });
    const pending = deferred<void>();
    fake.api.setPlaybackLoop.mockReturnValueOnce(pending.promise);
    fake.api.fadeOutPlayback.mockReturnValueOnce(pending.promise);
    const looping = controller.setPlaybackLoop("voice", false);
    const fading = controller.fadeOutPlayback("voice", 750);
    await controller.playWithOptions("native-test-chime", {
      looped: true,
      fadeInMs: 50,
      fadeOutMs: 750,
    });
    await controller.stopPlayback("voice");
    await controller.stopEffect("native-test-chime");
    await controller.stopAll();
    expect(fake.api.restartEffect).toHaveBeenCalledExactlyOnceWith(
      "native-test-chime",
      { looped: true, fadeInMs: 50, fadeOutMs: 750 },
    );
    expect(fake.api.stopAll).toHaveBeenCalledTimes(1);
    expect(fake.api.stopPlayback).toHaveBeenCalledWith("voice");
    expect(controller.getSnapshot().status?.active_playbacks[0]).toMatchObject({
      looped: true,
      state: "playing",
    });
    pending.resolve();
    await looping;
    await fading;
    const finished = {
      ...status,
      revision: 1,
      active_playbacks: [
        { ...status.active_playbacks[0], state: "fading_out" as const },
      ],
    };
    fake.emit(finished);
    expect(controller.getSnapshot().status).toEqual(finished);
  });
});
