// @vitest-environment jsdom
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/app/App";
import { LibraryController } from "../src/features/sound-library/library-controller";
import { NativeAudioController } from "../src/features/audio-controls/native-controller";
import { createBoardStore } from "../src/features/soundboard/store";
import type { LibrarySnapshot } from "../src/shared/contracts/library";
import { fakeLibrary } from "./library-fixtures";
import { deferred, fakeNative, nativeStatus, output } from "./native-fixtures";

afterEach(cleanup);
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    /** @param this Diálogo jsdom sin implementación nativa. */
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
      this.querySelector<HTMLElement>("button, input, select")?.focus();
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    /** @param this Diálogo jsdom que se cierra. */
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});

/** @param fake Backend local de pruebas. @param native Motor simulado. @returns Vista de producción aislada y usuario. */
async function setup(fake = fakeLibrary(), native = fakeNative()) {
  const catalog = fake.saved().effects[0];
  const current = await native.api.getAudioEngineStatus();
  native.setStatus({
    ...current,
    effects: [
      ...current.effects,
      {
        effect_id: catalog.id,
        name: catalog.name,
        duration_ms: catalog.durationMs,
        default_volume: 0.35,
      },
    ],
  });
  const library = new LibraryController(fake.api);
  const audio = new NativeAudioController(native.api);
  const mounted = render(
    <App libraryController={library} nativeController={audio} />,
  );
  await screen.findByRole("heading", { name: "Principal" });
  await waitFor(() => expect(library.getSnapshot().busy).toBe(false));
  await waitFor(() => expect(native.api.listOutputDevices).toHaveBeenCalled());
  return { fake, native, library, audio, user: userEvent.setup(), ...mounted };
}

describe("persistent desktop studio", () => {
  it.each(["import", "refresh", "save"] as const)(
    "keeps confirmed audio playable and stoppable while %s is pending but locks all editing",
    async (operation) => {
      const { user, fake, native, library } = await setup();
      const pending = deferred<LibrarySnapshot>();
      const confirmed = fake.saved();
      if (operation === "import") {
        fake.api.importAudio.mockImplementationOnce(async () => ({
          cancelled: false,
          imported: [],
          failed: [],
          snapshot: await pending.promise,
        }));
        await user.click(
          screen.getByRole("button", { name: "Importar audio" }),
        );
      } else if (operation === "refresh") {
        fake.api.getSnapshot.mockImplementationOnce(() => pending.promise);
        await user.click(
          screen.getByRole("button", { name: "Actualizar biblioteca" }),
        );
      } else {
        fake.api.saveBoard.mockImplementationOnce(() => pending.promise);
        await user.click(
          screen.getByRole("button", { name: "Mover Aplauso después" }),
        );
      }
      expect(library.getSnapshot().busy).toBe(true);
      expect(library.getSnapshot().snapshot).toEqual(confirmed);
      expect(
        screen.getByText(/El audio confirmado sigue disponible/),
      ).toBeTruthy();
      for (const name of [
        "Editar Aplauso",
        "Eliminar Aplauso",
        "Mover Aplauso después",
        "+ Agregar botón",
        "+ Banco",
        "Organizar bancos",
        "Configuración",
        "Importar audio",
        "Actualizar biblioteca",
      ]) {
        expect(screen.getByRole("button", { name }).matches(":disabled")).toBe(
          true,
        );
      }
      expect(
        screen
          .getByRole("combobox", { name: "Banco activo" })
          .matches(":disabled"),
      ).toBe(true);
      const list = screen.getByRole("list", { name: "Efectos de Principal" });
      const cards = within(list).getAllByRole("listitem");
      const handle = cards[0].querySelector<HTMLElement>(".drag-handle");
      expect(handle?.getAttribute("draggable")).toBe("false");
      const setData = vi.fn();
      if (!handle) throw new Error("Falta el asa de ordenación.");
      fireEvent.dragStart(handle, { dataTransfer: { setData } });
      fireEvent.drop(cards[1], { dataTransfer: { getData: () => "button-1" } });
      expect(setData).not.toHaveBeenCalled();
      expect(fake.api.saveBoard).toHaveBeenCalledTimes(
        operation === "save" ? 1 : 0,
      );
      const trigger = screen.getByRole<HTMLButtonElement>("button", {
        name: "Disparar Aplauso",
      });
      expect(trigger.disabled).toBe(false);
      await user.click(trigger);
      await user.click(trigger);
      await user.click(
        screen.getByRole("button", { name: "Detener todas de Aplauso" }),
      );
      expect(native.api.restartEffect.mock.calls).toEqual([
        ["file-1", { looped: false, fadeInMs: 0, fadeOutMs: 0 }],
        ["file-1", { looped: false, fadeInMs: 0, fadeOutMs: 0 }],
      ]);
      expect(native.api.stopEffect).toHaveBeenCalledExactlyOnceWith("file-1");
      expect(library.getSnapshot().busy).toBe(true);
      expect(library.getSnapshot().snapshot).toEqual(confirmed);
      await act(async () => pending.resolve(confirmed));
      await waitFor(() => expect(library.getSnapshot().busy).toBe(false));
      expect(
        screen
          .getByRole("button", { name: "Editar Aplauso" })
          .matches(":disabled"),
      ).toBe(false);
    },
  );
  it("keeps assignments unchanged until save ACK and permits closing the editor without cancelling the write or audio", async () => {
    const { user, fake, native, library } = await setup();
    const pending = deferred<LibrarySnapshot>();
    fake.api.saveBoard.mockImplementationOnce(() => pending.promise);
    await user.click(
      screen.getByRole("button", { name: "Editar Sin asignar" }),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Archivo de la biblioteca" }),
      "file-1",
    );
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(
      screen
        .getByRole("button", { name: "Guardar cambios" })
        .matches(":disabled"),
    ).toBe(true);
    expect(
      screen.getByText(/Cerrar el diálogo no cancela una operación/),
    ).toBeTruthy();
    expect(
      library.getSnapshot().snapshot?.board.banks[0].buttons[1].effectId,
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cerrar diálogo" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const unassigned = screen.getByRole<HTMLButtonElement>("button", {
      name: "Disparar Sin asignar",
    });
    expect(unassigned.disabled).toBe(true);
    await user.click(unassigned);
    await user.click(screen.getByRole("button", { name: "Disparar Aplauso" }));
    await user.click(screen.getByRole("button", { name: "Disparar Aplauso" }));
    await user.click(
      screen.getByRole("button", { name: "Detener todas de Aplauso" }),
    );
    expect(native.api.restartEffect.mock.calls).toEqual([
      ["file-1", { looped: false, fadeInMs: 0, fadeOutMs: 0 }],
      ["file-1", { looped: false, fadeInMs: 0, fadeOutMs: 0 }],
    ]);
    expect(native.api.stopEffect).toHaveBeenCalledWith("file-1");
    const saved = fake.saved();
    saved.revision++;
    saved.board = fake.api.saveBoard.mock.calls[0][0];
    fake.setSnapshot(saved);
    await act(async () => pending.resolve(saved));
    await waitFor(() => expect(unassigned.disabled).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      library.getSnapshot().snapshot?.board.banks[0].buttons[1],
    ).toMatchObject({ effectId: "file-1", durationMs: 1250 });
  });
  it("waits for native registration instead of sending an unknown catalog effect id", async () => {
    const { user, native } = await setup();
    const current = await native.api.getAudioEngineStatus();
    const waiting = {
      ...current,
      revision: current.revision + 1,
      effects: current.effects.filter(
        (effect) => effect.effect_id !== "file-1",
      ),
    };
    native.setStatus(waiting);
    act(() => native.emit(waiting));
    expect(screen.getByText("Preparando recurso en el motor")).toBeTruthy();
    const trigger = screen.getByRole<HTMLButtonElement>("button", {
      name: "Disparar Aplauso",
    });
    expect(trigger.disabled).toBe(true);
    await user.click(trigger);
    expect(native.api.restartEffect).not.toHaveBeenCalled();
    const ready = { ...current, revision: waiting.revision + 1 };
    native.setStatus(ready);
    act(() => native.emit(ready));
    expect(trigger.disabled).toBe(false);
    await user.click(trigger);
    expect(native.api.restartEffect).toHaveBeenCalledExactlyOnceWith("file-1", {
      looped: false,
      fadeInMs: 0,
      fadeOutMs: 0,
    });
  });
  it.each(["available", "invalid"] as const)(
    "describes a duplicate reimport with %s status without claiming it merely reused the file",
    async (availability) => {
      const fake = fakeLibrary();
      const missing = fake.saved();
      missing.effects[0].availability = "missing";
      missing.effects[0].error = "Copia ausente";
      fake.setSnapshot(missing);
      const { user, native, library } = await setup(fake);
      const pending = deferred<LibrarySnapshot>();
      const repaired = fake.saved();
      repaired.effects[0].availability = availability;
      repaired.effects[0].error =
        availability === "available" ? null : "No se pudo cargar PCM";
      fake.api.importAudio.mockImplementationOnce(async () => ({
        cancelled: false,
        imported: [{ effect: repaired.effects[0], duplicate: true }],
        failed: [],
        snapshot: await pending.promise,
      }));
      await user.click(screen.getByRole("button", { name: "Importar audio" }));
      const trigger = screen.getByRole<HTMLButtonElement>("button", {
        name: "Disparar Aplauso",
      });
      expect(trigger.disabled).toBe(true);
      await user.click(trigger);
      expect(native.api.restartEffect).not.toHaveBeenCalled();
      fake.setSnapshot(repaired);
      await act(async () => pending.resolve(repaired));
      expect(
        await screen.findByText(
          `aplauso.wav: duplicado: recurso ${availability === "available" ? "disponible" : "no disponible"}; se conserva su identidad`,
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/se reutilizó/)).toBeNull();
      expect(library.getSnapshot().snapshot?.board).toEqual(missing.board);
      expect(library.getSnapshot().snapshot?.effects).toHaveLength(1);
      expect(fake.api.saveBoard).not.toHaveBeenCalled();
      expect(trigger.disabled).toBe(availability !== "available");
      if (availability === "available") {
        await user.click(trigger);
        expect(native.api.restartEffect).toHaveBeenCalledExactlyOnceWith(
          "file-1",
          {
            looped: false,
            fadeInMs: 0,
            fadeOutMs: 0,
          },
        );
      }
    },
  );
  it("remounts a renamed-bank modal with focus inside the new dialog and restores focus on close", async () => {
    const { user } = await setup();
    const manage = screen.getByRole("button", { name: "Organizar bancos" });
    await user.click(manage);
    const previous = screen.getByRole("dialog");
    await user.click(
      screen.getByRole("button", { name: "Renombrar Principal" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toBe(previous);
    expect(dialog.contains(document.activeElement)).toBe(true);
    const name =
      within(dialog).getByLabelText<HTMLInputElement>("Nombre del banco");
    expect(name.maxLength).toBe(60);
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(document.activeElement).toBe(manage);
    const edit = screen.getByRole("button", { name: "Editar Aplauso" });
    await user.click(edit);
    expect(screen.getByLabelText<HTMLInputElement>("Categoría").maxLength).toBe(
      80,
    );
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(document.activeElement).toBe(edit);
  });
  it("does not mislabel a changed native output as a saved preference after persistence failure", async () => {
    const { user, native } = await setup();
    native.api.setOutputDevice.mockImplementationOnce(async () => {
      const status = await native.api.getAudioEngineStatus();
      native.setStatus({
        ...status,
        revision: status.revision + 1,
        selected_device: { ...output, name: "Otra salida" },
      });
      throw {
        code: "persistence_partial_failure",
        message: "Salida abierta pero no guardada",
      };
    });
    await user.selectOptions(
      screen.getByLabelText("Dispositivo de salida nativo"),
      output.id,
    );
    await user.click(
      screen.getByRole("button", { name: "Seleccionar salida" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Salida abierta pero no guardada",
    );
    await waitFor(() =>
      expect(screen.getByText(/Salida activa: Otra salida/)).toBeTruthy(),
    );
    expect(screen.getByText(/Preferencia guardada: Interfaz USB/)).toBeTruthy();
    expect(screen.queryByText(/Preferencia guardada: Otra salida/)).toBeNull();
  });
  it("publishes successful imports as confirmed catalog entries ready for assignment", async () => {
    const { user, fake } = await setup();
    const snapshot = fake.saved();
    const effect = {
      ...snapshot.effects[0],
      id: "file-2",
      name: "nuevo.flac",
      format: "flac" as const,
    };
    snapshot.effects.push(effect);
    fake.api.importAudio.mockResolvedValueOnce({
      cancelled: false,
      imported: [{ effect, duplicate: false }],
      failed: [],
      snapshot,
    });
    await user.click(screen.getByRole("button", { name: "Importar audio" }));
    expect(
      await screen.findByText(
        "Importación: 1 nuevos, 0 duplicados, 0 fallidos.",
      ),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Editar Sin asignar" }),
    );
    expect(
      screen.getByRole("option", { name: "nuevo.flac · disponible" }),
    ).toBeTruthy();
    expect(fake.api.saveBoard).not.toHaveBeenCalled();
  });
  it("displays native gains after partial persistence failure without saving them again through library IPC", async () => {
    const { fake, native } = await setup();
    native.api.setMasterVolume.mockImplementationOnce(async () => {
      const status = await native.api.getAudioEngineStatus();
      native.setStatus({
        ...status,
        revision: status.revision + 1,
        master_volume: 0.2,
      });
      throw {
        code: "persistence_partial_failure",
        message: "Audio aplicado, preferencia no guardada",
      };
    });
    fireEvent.change(screen.getByLabelText("Volumen maestro nativo"), {
      target: { value: "0.2" },
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "persistence_partial_failure",
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText<HTMLInputElement>("Volumen maestro nativo").value,
      ).toBe("0.2"),
    );
    expect(fake.saved().settings.masterVolume).toBe(0.7);
    expect(fake.api.saveBoard).not.toHaveBeenCalled();
    expect(fake.api.setColumns).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText<HTMLInputElement>(
        "Volumen por defecto de aplauso.wav",
      ).value,
    ).toBe("0.35");
  });
  it("restarts on every click and displays only acknowledged voices while preserving other effects", async () => {
    const { user, native } = await setup();
    const otherId = await native.api.restartEffect("native-test-pulse", {
      looped: true,
      fadeInMs: 0,
      fadeOutMs: 0,
    });
    native.api.restartEffect.mockClear();
    const trigger = screen.getByRole("button", { name: "Disparar Aplauso" });
    await user.click(trigger);
    const first = await native.api.getAudioEngineStatus();
    expect(
      first.active_playbacks.filter((voice) => voice.effect_id === "file-1"),
    ).toHaveLength(1);
    expect(screen.getByText("1 instancias activas")).toBeTruthy();
    await user.click(trigger);
    expect(native.api.restartEffect.mock.calls).toEqual([
      ["file-1", { looped: false, fadeInMs: 0, fadeOutMs: 0 }],
      ["file-1", { looped: false, fadeInMs: 0, fadeOutMs: 0 }],
    ]);
    const current = await native.api.getAudioEngineStatus();
    expect(current.active_playbacks).toHaveLength(2);
    expect(current.active_playbacks[0].playback_id).toBe(otherId);
    expect(current.active_playbacks[1].playback_id).not.toBe(
      first.active_playbacks[1].playback_id,
    );
    expect(
      current.active_playbacks.filter((voice) => voice.effect_id === "file-1"),
    ).toHaveLength(1);
    expect(screen.getByText("1 instancias activas")).toBeTruthy();
    expect(native.api.playEffect).not.toHaveBeenCalled();
    expect(native.api.playEffectWithOptions).not.toHaveBeenCalled();
    expect(native.api.stopEffect).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Volumen visual de la demo")).toBeNull();
    expect(screen.queryByText("MODO MOCK")).toBeNull();
    expect(
      screen.getAllByRole("heading", { name: "aplauso.wav" }),
    ).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: "Detener todas de Aplauso" }),
    );
    expect(native.api.stopEffect).toHaveBeenCalledWith("file-1");
  });
  it("never plays unassigned or unavailable files even with an old cached native resource", async () => {
    const fake = fakeLibrary();
    const saved = fake.saved();
    saved.effects[0].availability = "missing";
    saved.effects[0].error = "No existe";
    fake.setSnapshot(saved);
    const { user, native } = await setup(fake);
    await user.click(
      screen.getByRole("button", { name: "Disparar Sin asignar" }),
    );
    await user.click(screen.getByRole("button", { name: "Disparar Aplauso" }));
    expect(native.api.restartEffect).not.toHaveBeenCalled();
    expect(screen.getByText("Sin audio asignado")).toBeTruthy();
    expect(
      screen.getByText("Archivo ausente: No existe", {
        selector: ".pad-state",
      }),
    ).toBeTruthy();
  });
  it("loads no demo board when SQLite fails and offers a visible retry", async () => {
    const fake = fakeLibrary();
    fake.api.getSnapshot.mockRejectedValueOnce(
      new Error("SQLite no accesible"),
    );
    const native = fakeNative();
    render(
      <App
        libraryController={new LibraryController(fake.api)}
        nativeController={new NativeAudioController(native.api)}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "SQLite no accesible",
    );
    expect(screen.queryByRole("heading", { name: "Principal" })).toBeNull();
    expect(screen.queryByText("MODO MOCK")).toBeNull();
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Reintentar carga de biblioteca" }),
      );
    expect(
      await screen.findByRole("heading", { name: "Principal" }),
    ).toBeTruthy();
  });
  it("uses catalog durations and persists binding edits without demo or duration fields", async () => {
    const { user, fake } = await setup();
    await user.click(
      screen.getByRole("button", { name: "Editar Sin asignar" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByLabelText("Duración mock (segundos)"),
    ).toBeNull();
    expect(within(dialog).queryByLabelText("Estado visual (mock)")).toBeNull();
    await user.selectOptions(
      within(dialog).getByRole("combobox", {
        name: "Archivo de la biblioteca",
      }),
      "file-1",
    );
    expect(
      within(dialog).getByText("Duración del catálogo: 1250 ms"),
    ).toBeTruthy();
    await user.clear(within(dialog).getByLabelText("Nombre del efecto"));
    await user.type(
      within(dialog).getByLabelText("Nombre del efecto"),
      "Segundo aplauso",
    );
    await user.click(within(dialog).getByLabelText("Menta"));
    await user.click(
      within(dialog).getByRole("button", { name: "Guardar cambios" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.saved().board.banks[0].buttons[1]).toMatchObject({
      effectId: "file-1",
      durationMs: 1250,
      name: "Segundo aplauso",
      color: "mint",
    });
    await user.click(
      screen.getByRole("button", { name: "Editar Segundo aplauso" }),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Archivo de la biblioteca" }),
      "",
    );
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() =>
      expect(fake.saved().board.banks[0].buttons[1].effectId).toBeNull(),
    );
    expect(fake.saved().board.banks[0].buttons[1].durationMs).toBe(0);
  });
  it("persists bank creation selection renaming ordering and deletion with server confirmations", async () => {
    const { user, fake } = await setup();
    await user.click(screen.getByRole("button", { name: "+ Banco" }));
    await user.type(screen.getByLabelText("Nombre del banco"), "Noticias");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Crear banco",
      }),
    );
    await screen.findByRole("heading", { name: "Noticias" });
    expect(fake.saved().board.activeBankId).toBe(
      fake.saved().board.banks[1].id,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Banco activo" }),
      "bank-1",
    );
    await screen.findByRole("heading", { name: "Principal" });
    expect(fake.saved().board.activeBankId).toBe("bank-1");
    await user.click(screen.getByRole("button", { name: /Organizar bancos/ }));
    await user.click(
      screen.getByRole("button", { name: "Subir banco Noticias" }),
    );
    await waitFor(() =>
      expect(fake.saved().board.banks[0].name).toBe("Noticias"),
    );
    await user.click(
      screen.getByRole("button", { name: "Renombrar Noticias" }),
    );
    await user.clear(screen.getByLabelText("Nombre del banco"));
    await user.type(screen.getByLabelText("Nombre del banco"), "Informativos");
    await user.click(screen.getByRole("button", { name: "Guardar nombre" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.saved().board.banks[0].name).toBe("Informativos");
    await user.click(screen.getByRole("button", { name: /Organizar bancos/ }));
    await user.click(
      screen.getByRole("button", { name: "Eliminar banco Informativos" }),
    );
    expect(fake.saved().board.banks).toHaveLength(2);
    expect(screen.getByText(/No se eliminará ningún archivo/)).toBeTruthy();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Eliminar banco",
      }),
    );
    await waitFor(() => expect(fake.saved().board.banks).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: /Organizar bancos/ }));
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Eliminar banco Principal",
      }).disabled,
    ).toBe(true);
  });
  it("persists assignment creation ordering and confirmed deletion without deleting catalog audio", async () => {
    const { user, fake } = await setup();
    await user.click(screen.getByRole("button", { name: "+ Agregar botón" }));
    await user.type(screen.getByLabelText("Nombre del efecto"), "Nuevo");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Archivo de la biblioteca" }),
      "file-1",
    );
    await user.click(screen.getByRole("button", { name: "Crear botón" }));
    await waitFor(() =>
      expect(fake.saved().board.banks[0].buttons).toHaveLength(3),
    );
    await user.click(screen.getByRole("button", { name: "Mover Nuevo antes" }));
    await waitFor(() =>
      expect(fake.saved().board.banks[0].buttons[1].name).toBe("Nuevo"),
    );
    await user.click(screen.getByRole("button", { name: "Eliminar Nuevo" }));
    expect(fake.saved().board.banks[0].buttons).toHaveLength(3);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Eliminar botón",
      }),
    );
    await waitFor(() =>
      expect(fake.saved().board.banks[0].buttons).toHaveLength(2),
    );
    expect(fake.saved().effects).toHaveLength(1);
  });
  it("keeps ordering unchanged until ACK and reports conflicts without silently retrying", async () => {
    const { user, fake } = await setup();
    const pending = deferred<LibrarySnapshot>();
    fake.api.saveBoard.mockImplementationOnce(() => pending.promise);
    await user.click(
      screen.getByRole("button", { name: "Mover Aplauso después" }),
    );
    const list = screen.getByRole("list", { name: "Efectos de Principal" });
    expect(
      within(list).getAllByRole("button", { name: /^Disparar/ })[0].textContent,
    ).toContain("Aplauso");
    const other = fake.saved();
    other.revision = 1;
    other.board.banks[0].buttons.reverse();
    fake.setSnapshot(other);
    act(() =>
      pending.reject({
        code: "revision_conflict",
        message: "Tablero modificado",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "revision_conflict",
    );
    expect(fake.api.saveBoard).toHaveBeenCalledTimes(1);
    expect(
      within(list).getAllByRole("button", { name: /^Disparar/ })[0].textContent,
    ).toContain("Sin asignar");
  });
  it("shows import cancellation duplicates and per-file failures then refreshes native state", async () => {
    const { user, fake, native } = await setup();
    await user.click(screen.getByRole("button", { name: "Importar audio" }));
    expect(
      await screen.findByText(
        "Importación cancelada. No se modificó la biblioteca.",
      ),
    ).toBeTruthy();
    const snapshot = fake.saved();
    fake.api.importAudio.mockResolvedValueOnce({
      cancelled: false,
      imported: [{ effect: snapshot.effects[0], duplicate: true }],
      failed: [{ name: "roto.mp3", message: "Decodificación inválida" }],
      snapshot,
    });
    const queries = native.api.getAudioEngineStatus.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Importar audio" }));
    expect(
      await screen.findByText(
        "Importación: 0 nuevos, 1 duplicados, 1 fallidos.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("roto.mp3: Decodificación inválida")).toBeTruthy();
    expect(
      screen.getByText(
        "aplauso.wav: duplicado: recurso disponible; se conserva su identidad",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(native.api.getAudioEngineStatus.mock.calls.length).toBeGreaterThan(
        queries,
      ),
    );
    const saved = fake.saved();
    saved.effects[0].availability = "invalid";
    saved.effects[0].error = "Sin presupuesto PCM";
    fake.setSnapshot(saved);
    await user.click(
      screen.getByRole("button", { name: "Actualizar biblioteca" }),
    );
    expect(
      await screen.findByText("Archivo inválido: Sin presupuesto PCM", {
        selector: ".pad-state",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Disparar Aplauso",
      }).disabled,
    ).toBe(true);
  });
  it("awaits column persistence and restores it after remount", async () => {
    const { user, fake, unmount } = await setup();
    await user.click(screen.getByRole("button", { name: "Configuración" }));
    await user.selectOptions(
      screen.getByLabelText("Distribución de la cuadrícula"),
      "4",
    );
    await waitFor(() => expect(fake.saved().settings.columns).toBe("4"));
    expect(fake.api.setColumns).toHaveBeenCalledWith("4");
    unmount();
    await setup(fake);
    expect(
      screen.getByRole("list", { name: "Efectos de Principal" }).className,
    ).toContain("columns-4");
  });
  it.each([0, 1, 2])(
    "resolves saved device names explicitly with %i matches and never auto-selects",
    async (matches) => {
      const native = fakeNative();
      native.setStatus(nativeStatus());
      native.api.listOutputDevices.mockResolvedValue(
        Array.from({ length: matches }, (_, index) => ({
          ...output,
          id: `token-${index}`,
        })),
      );
      const { user } = await setup(fakeLibrary(), native);
      expect(
        screen.getByText(/Preferencia guardada: Interfaz USB/).textContent,
      ).toContain(
        matches === 1
          ? "Coincidencia única"
          : matches === 2
            ? "Nombre ambiguo"
            : "No se encuentra",
      );
      expect(native.api.setOutputDevice).not.toHaveBeenCalled();
      if (matches === 1) {
        await user.selectOptions(
          screen.getByLabelText("Dispositivo de salida nativo"),
          "token-0",
        );
        expect(native.api.setOutputDevice).not.toHaveBeenCalled();
        await user.click(
          screen.getByRole("button", { name: "Seleccionar salida" }),
        );
        expect(native.api.setOutputDevice).toHaveBeenCalledWith("token-0");
      }
    },
  );
  it("ignores stale StrictMode responses and preserves injected demo store precedence", async () => {
    const fake = fakeLibrary();
    const native = fakeNative();
    const late = deferred<LibrarySnapshot>();
    fake.api.getSnapshot.mockImplementationOnce(() => late.promise);
    const library = new LibraryController(fake.api);
    const audio = new NativeAudioController(native.api);
    const initial = render(
      <StrictMode>
        <App libraryController={library} nativeController={audio} />
      </StrictMode>,
    );
    await waitFor(() => expect(fake.api.getSnapshot).toHaveBeenCalledTimes(1));
    initial.unmount();
    const mounted = render(
      <StrictMode>
        <App libraryController={library} nativeController={audio} />
      </StrictMode>,
    );
    await screen.findByRole("heading", { name: "Principal" });
    const obsolete = fake.saved();
    obsolete.board.banks[0].name = "Obsoleto";
    await act(async () => late.resolve(obsolete));
    expect(screen.queryByRole("heading", { name: "Obsoleto" })).toBeNull();
    mounted.unmount();
    render(
      <App
        store={createBoardStore()}
        libraryController={library}
        nativeController={audio}
      />,
    );
    expect(screen.getByText("MODO MOCK")).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Biblioteca de sonidos" }),
    ).toBeNull();
  });
  it("persists native drag reorder using only internal assignment ids", async () => {
    const { fake } = await setup();
    const list = screen.getByRole("list", { name: "Efectos de Principal" });
    const cards = within(list).getAllByRole("listitem");
    fireEvent.drop(cards[1], { dataTransfer: { getData: () => "button-1" } });
    await waitFor(() =>
      expect(fake.saved().board.banks[0].buttons[0].id).toBe("button-2"),
    );
  });
});
