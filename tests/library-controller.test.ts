import { describe, expect, it } from "vitest";
import { LibraryController } from "../src/features/sound-library/library-controller";
import { fakeLibrary, librarySnapshot } from "./library-fixtures";
import { deferred } from "./native-fixtures";
import type { LibrarySnapshot } from "../src/shared/contracts/library";

/** @param controller Controlador simulado. @returns Espera de las microtareas serializadas. */
async function loaded(controller: LibraryController) {
  await controller.refresh();
}

describe("persistent library controller", () => {
  it("keeps confirmed columns until server acknowledgement and reports persistence failures", async () => {
    const fake = fakeLibrary();
    const controller = new LibraryController(fake.api);
    const stop = controller.start();
    await loaded(controller);
    const ack = deferred<LibrarySnapshot>();
    fake.api.setColumns.mockImplementationOnce(() => ack.promise);
    const change = controller.setColumns("3");
    await Promise.resolve();
    expect(controller.getSnapshot().snapshot?.settings.columns).toBe("auto");
    const saved = fake.saved();
    saved.settings.columns = "3";
    fake.setSnapshot(saved);
    ack.resolve(saved);
    expect(await change).toBe(true);
    expect(controller.getSnapshot().snapshot?.settings.columns).toBe("3");
    fake.api.setColumns.mockRejectedValueOnce(
      new Error("No se pudo guardar columnas"),
    );
    expect(await controller.setColumns("6")).toBe(false);
    expect(controller.getSnapshot().snapshot?.settings.columns).toBe("3");
    expect(controller.getSnapshot().error).toContain(
      "No se pudo guardar columnas",
    );
    stop();
  });
  it("does not fabricate an empty or demo board after load failure and retries visibly", async () => {
    const fake = fakeLibrary();
    fake.api.getSnapshot.mockRejectedValueOnce(new Error("SQLite inaccesible"));
    const controller = new LibraryController(fake.api);
    const stop = controller.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().snapshot).toBeNull();
    expect(controller.getSnapshot().error).toContain("SQLite inaccesible");
    expect(fake.api.saveBoard).not.toHaveBeenCalled();
    await loaded(controller);
    expect(controller.getSnapshot().snapshot).toEqual(fake.saved());
    expect(controller.getSnapshot().error).toBeNull();
    stop();
  });
  it("serializes edits against the last ACK and never publishes optimistic board state", async () => {
    const fake = fakeLibrary();
    const controller = new LibraryController(fake.api);
    const stop = controller.start();
    await loaded(controller);
    const pending = deferred<LibrarySnapshot>();
    fake.api.saveBoard.mockImplementationOnce(() => pending.promise);
    const first = controller.updateBoard((board) => {
      board.banks[0].name = "Primero";
    });
    const second = controller.updateBoard((board) => {
      board.banks[0].name += " segundo";
    });
    await Promise.resolve();
    expect(fake.api.saveBoard).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().snapshot?.board.banks[0].name).toBe(
      "Principal",
    );
    const ack = librarySnapshot();
    ack.revision = 1;
    ack.board.banks[0].name = "Primero";
    fake.setSnapshot(ack);
    pending.resolve(ack);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(fake.api.saveBoard.mock.calls.map((call) => call[1])).toEqual([
      0, 1,
    ]);
    expect(fake.saved().board.banks[0].name).toBe("Primero segundo");
    stop();
  });
  it("reloads a revision conflict, exposes the error and discards queued obsolete intentions", async () => {
    const fake = fakeLibrary();
    const controller = new LibraryController(fake.api);
    const stop = controller.start();
    await loaded(controller);
    const other = librarySnapshot();
    other.revision = 4;
    other.board.banks[0].name = "Otro cliente";
    fake.setSnapshot(other);
    const first = controller.updateBoard((board) => {
      board.banks[0].name = "Obsoleto";
    });
    const second = controller.updateBoard((board) => {
      board.banks[0].name = "No reenviar";
    });
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(fake.api.saveBoard).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().snapshot).toEqual(other);
    expect(controller.getSnapshot().error).toContain("revision_conflict");
    expect(controller.getSnapshot().busy).toBe(false);
    stop();
  });
  it("preserves confirmed data and reports a failed durable write without false success", async () => {
    const fake = fakeLibrary();
    const controller = new LibraryController(fake.api);
    const stop = controller.start();
    await loaded(controller);
    fake.api.saveBoard.mockRejectedValueOnce(new Error("Disco lleno"));
    expect(
      await controller.updateBoard((board) => {
        board.banks[0].name = "No guardado";
      }),
    ).toBe(false);
    expect(controller.getSnapshot().snapshot).toEqual(fake.saved());
    expect(controller.getSnapshot().error).toContain("Disco lleno");
    stop();
  });
  it("restores board selection ordering bindings and columns after a new controller starts", async () => {
    const fake = fakeLibrary();
    const first = new LibraryController(fake.api);
    const stop = first.start();
    await loaded(first);
    await first.updateBoard((board) => {
      board.banks.push({ id: "new-bank", name: "Segundo", buttons: [] });
      board.activeBankId = "new-bank";
      board.banks[0].buttons.reverse();
    });
    await first.setColumns("6");
    stop();
    const second = new LibraryController(fake.api);
    const dispose = second.start();
    await loaded(second);
    expect(second.getSnapshot().snapshot).toEqual(fake.saved());
    expect(second.getSnapshot().snapshot?.settings.columns).toBe("6");
    expect(second.getSnapshot().snapshot?.board.activeBankId).toBe("new-bank");
    dispose();
  });
  it("ignores an old load across StrictMode cleanup without blocking the new session", async () => {
    const fake = fakeLibrary();
    const late = deferred<LibrarySnapshot>();
    fake.api.getSnapshot.mockImplementationOnce(() => late.promise);
    const controller = new LibraryController(fake.api);
    const firstStop = controller.start();
    await Promise.resolve();
    firstStop();
    const stop = controller.start();
    await loaded(controller);
    const previous = librarySnapshot();
    previous.board.banks[0].name = "Respuesta obsoleta";
    late.resolve(previous);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().snapshot).toEqual(fake.saved());
    stop();
  });
  it("does not notify subscribers or process queued writes after unmount", async () => {
    const fake = fakeLibrary();
    const controller = new LibraryController(fake.api);
    const stop = controller.start();
    await loaded(controller);
    const pending = deferred<LibrarySnapshot>();
    fake.api.saveBoard.mockImplementationOnce(() => pending.promise);
    const first = controller.updateBoard(() => {});
    const second = controller.updateBoard(() => {});
    await Promise.resolve();
    stop();
    const before = controller.getSnapshot();
    pending.resolve(fake.saved());
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(controller.getSnapshot()).toBe(before);
    expect(fake.api.saveBoard).toHaveBeenCalledTimes(1);
  });
  it("reports saved imports whose cache registration failed and reconciles without reimporting", async () => {
    const fake = fakeLibrary();
    const controller = new LibraryController(fake.api);
    const stop = controller.start();
    await loaded(controller);
    fake.api.importAudio.mockRejectedValueOnce({
      code: "catalog_registration_pending",
      message: "Importación guardada; caché pendiente.",
    });
    expect(await controller.importAudio()).toBe(false);
    expect(controller.getSnapshot().error).toContain(
      "catalog_registration_pending",
    );
    expect(fake.api.importAudio).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().snapshot).toEqual(fake.saved());
    stop();
  });
  it("does not publish malformed injected adapter snapshots", async () => {
    const fake = fakeLibrary();
    const invalid = librarySnapshot();
    invalid.revision = -1;
    fake.api.getSnapshot.mockResolvedValue(invalid);
    const controller = new LibraryController(fake.api);
    const stop = controller.start();
    await loaded(controller);
    expect(controller.getSnapshot().snapshot).toBeNull();
    expect(controller.getSnapshot().error).toBeTruthy();
    stop();
  });
});
