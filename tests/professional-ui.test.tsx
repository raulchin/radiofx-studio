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
import type { ShortcutBinding } from "../src/features/keyboard-shortcuts/contracts";
import type {
  LibrarySnapshot,
  BankImportPreview,
} from "../src/shared/contracts/library";
import { fakeLibrary } from "./library-fixtures";
import { deferred, fakeNative } from "./native-fixtures";

afterEach(cleanup);
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    /** Abre el modal de pruebas sin WebView. @param this Diálogo jsdom. */
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
      this.querySelector<HTMLElement>("button,input,select")?.focus();
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    /** Cierra el modal de pruebas. @param this Diálogo jsdom. */
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});
/** @param patch Variación del atajo. @returns Atajo de aplicación reproducible. */
function shortcut(patch: Partial<ShortcutBinding> = {}): ShortcutBinding {
  return {
    id: "shortcut-1",
    scope: "application",
    scopeBankId: null,
    chord: { code: "KeyA", ctrl: false, alt: false, shift: false, meta: false },
    action: { kind: "play_button", targetId: "button-1" },
    enabled: true,
    ...patch,
  };
}
/** @param fake Biblioteca simulada. @param native Motor simulado. @returns Aplicación de producción con ciclo estricto y puertos controlables. */
async function setup(fake = fakeLibrary(), native = fakeNative()) {
  const status = await native.api.getAudioEngineStatus();
  native.setStatus({
    ...status,
    effects: [
      ...status.effects,
      {
        effect_id: "file-1",
        name: "aplauso.wav",
        duration_ms: 1250,
        default_volume: 0.5,
      },
    ],
  });
  const library = new LibraryController(fake.api);
  const audio = new NativeAudioController(native.api);
  const mounted = render(
    <StrictMode>
      <App libraryController={library} nativeController={audio} />
    </StrictMode>,
  );
  await waitFor(() => expect(library.getSnapshot().busy).toBe(false));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Disparar Aplauso",
      }).disabled,
    ).toBe(false),
  );
  return { fake, native, library, audio, user: userEvent.setup(), ...mounted };
}

describe("professional persistent UI", () => {
  it("saves button loop and fades only on ACK and plays the confirmed options on every click", async () => {
    const { fake, native, user, library } = await setup();
    await user.click(screen.getByRole("button", { name: "Editar Aplauso" }));
    await user.clear(screen.getByLabelText("Entrada gradual (ms)"));
    await user.type(screen.getByLabelText("Entrada gradual (ms)"), "800");
    await user.clear(screen.getByLabelText("Salida gradual por defecto (ms)"));
    await user.type(
      screen.getByLabelText("Salida gradual por defecto (ms)"),
      "500",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Guardar cambios" })
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "duración del catálogo",
    );
    await user.click(screen.getByLabelText("Repetir en bucle"));
    const pending = deferred<LibrarySnapshot>();
    fake.api.saveBoard.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(
      library.getSnapshot().snapshot?.board.banks[0].buttons[0].playback.looped,
    ).toBe(false);
    expect(native.api.restartEffect).not.toHaveBeenCalled();
    const saved = fake.saved();
    saved.revision++;
    saved.board = fake.api.saveBoard.mock.calls[0][0];
    fake.setSnapshot(saved);
    await act(async () => pending.resolve(saved));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Disparar Aplauso" }));
    await user.click(screen.getByRole("button", { name: "Disparar Aplauso" }));
    expect(native.api.restartEffect.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        "file-1",
        { looped: true, fadeInMs: 800, fadeOutMs: 500 },
      ]),
    );
    expect(native.api.playEffect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Editar Aplauso" }));
    await user.clear(screen.getByLabelText("Nombre del efecto"));
    await user.type(
      screen.getByLabelText("Nombre del efecto"),
      "Nuevo aplauso",
    );
    await user.click(screen.getByLabelText("Menta"));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() =>
      expect(fake.saved().board.banks[0].buttons[0].name).toBe("Nuevo aplauso"),
    );
    expect(fake.saved().board.banks[0].buttons[0].playback).toEqual({
      looped: true,
      fadeInMs: 800,
      fadeOutMs: 500,
    });
  });
  it("captures a physical shortcut without firing an old one and waits for ACK before showing it", async () => {
    const { fake, native, user } = await setup();
    await user.click(screen.getByRole("button", { name: "Atajos" }));
    const capture = screen.getByLabelText("Combinación física");
    fireEvent.keyDown(capture, { code: "KeyA", key: "q" });
    expect((capture as HTMLInputElement).value).toBe("KeyA");
    await user.selectOptions(screen.getByLabelText("Destino"), "button-1");
    const pending = deferred<LibrarySnapshot>();
    fake.api.saveBoard.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole("button", { name: "Guardar atajo" }));
    expect(
      screen.queryByRole("button", { name: "Editar atajo KeyA" }),
    ).toBeNull();
    expect(native.api.restartEffect).not.toHaveBeenCalled();
    const saved = fake.saved();
    saved.revision++;
    saved.board = fake.api.saveBoard.mock.calls[0][0];
    fake.setSnapshot(saved);
    await act(async () => pending.resolve(saved));
    expect(
      await screen.findByRole("button", { name: "Editar atajo KeyA" }),
    ).toBeTruthy();
    fireEvent.keyDown(capture, { code: "KeyA" });
    expect(native.api.restartEffect).not.toHaveBeenCalled();
    fireEvent.keyDown(capture, {
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      metaKey: true,
    });
    expect(native.api.stopAll).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cerrar diálogo" }));
    fireEvent.keyDown(window, { code: "KeyA", key: "q" });
    expect(native.api.restartEffect).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { code: "KeyA", repeat: true });
    fireEvent.keyDown(window, { code: "KeyA", isComposing: true });
    expect(native.api.restartEffect).toHaveBeenCalledTimes(1);
  });
  it("validates shortcut conflicts and supports edit disable enable and delete without autoplay", async () => {
    const fake = fakeLibrary();
    const saved = fake.saved();
    saved.board.keyboardShortcuts = [shortcut()];
    fake.setSnapshot(saved);
    const { native, user } = await setup(fake);
    await user.click(screen.getByRole("button", { name: "Atajos" }));
    fireEvent.keyDown(screen.getByLabelText("Combinación física"), {
      code: "KeyA",
    });
    await user.selectOptions(screen.getByLabelText("Destino"), "button-2");
    await user.click(screen.getByRole("button", { name: "Guardar atajo" }));
    expect(screen.getByText(/Conflicto:/)).toBeTruthy();
    expect(fake.api.saveBoard).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Editar atajo KeyA" }));
    fireEvent.keyDown(screen.getByLabelText("Combinación física"), {
      code: "KeyB",
      shiftKey: true,
    });
    await user.click(screen.getByRole("button", { name: "Guardar atajo" }));
    await screen.findByRole("button", { name: "Deshabilitar Shift+KeyB" });
    await user.click(
      screen.getByRole("button", { name: "Deshabilitar Shift+KeyB" }),
    );
    await screen.findByRole("button", { name: "Habilitar Shift+KeyB" });
    expect(fake.saved().board.keyboardShortcuts[0].enabled).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Habilitar Shift+KeyB" }),
    );
    await screen.findByRole("button", { name: "Deshabilitar Shift+KeyB" });
    await user.click(
      screen.getByRole("button", { name: "Eliminar atajo Shift+KeyB" }),
    );
    await waitFor(() =>
      expect(fake.saved().board.keyboardShortcuts).toHaveLength(0),
    );
    expect(native.api.restartEffect).not.toHaveBeenCalled();
  });
  it("dispatches only consumed physical keys from the latest confirmed active scope and cleans up on unmount", async () => {
    const fake = fakeLibrary();
    const saved = fake.saved();
    saved.board.banks.push({ id: "bank-2", name: "Noticias", buttons: [] });
    saved.board.keyboardShortcuts = [
      shortcut(),
      shortcut({
        id: "switch",
        chord: { ...shortcut().chord, code: "Digit2" },
        action: { kind: "select_bank", targetId: "bank-2" },
      }),
      shortcut({
        id: "stop",
        scope: "bank",
        scopeBankId: "bank-2",
        chord: { ...shortcut().chord, code: "KeyS" },
        action: { kind: "stop_all", targetId: null },
      }),
    ];
    fake.setSnapshot(saved);
    const { native, library, unmount } = await setup(fake);
    const unused = new KeyboardEvent("keydown", {
      code: "KeyZ",
      cancelable: true,
    });
    window.dispatchEvent(unused);
    expect(unused.defaultPrevented).toBe(false);
    const play = new KeyboardEvent("keydown", {
      code: "KeyA",
      cancelable: true,
    });
    window.dispatchEvent(play);
    expect(play.defaultPrevented).toBe(true);
    fireEvent.keyDown(window, { code: "KeyS" });
    expect(native.api.stopAll).not.toHaveBeenCalled();
    act(() => fireEvent.keyDown(window, { code: "Digit2" }));
    await waitFor(() =>
      expect(library.getSnapshot().snapshot?.board.activeBankId).toBe("bank-2"),
    );
    fireEvent.keyDown(window, { code: "KeyS" });
    expect(native.api.stopAll).toHaveBeenCalledTimes(1);
    expect(native.api.restartEffect).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(window, { code: "KeyA" });
    fireEvent.keyDown(window, { code: "Space", ctrlKey: true, shiftKey: true });
    expect(native.api.restartEffect).toHaveBeenCalledTimes(1);
    expect(native.api.stopAll).toHaveBeenCalledTimes(1);
  });
  it("searches accents resource category and banks without saving subsets or changing global voice counts", async () => {
    const fake = fakeLibrary();
    const saved = fake.saved();
    saved.board.banks.push({
      id: "bank-2",
      name: "Transición",
      buttons: [
        {
          ...saved.board.banks[0].buttons[0],
          id: "remote",
          name: "Cortinilla",
          category: "Música",
        },
      ],
    });
    fake.setSnapshot(saved);
    const { user, native } = await setup(fake);
    const status = await native.api.getAudioEngineStatus();
    act(() =>
      native.emit({
        ...status,
        revision: 1,
        active_playbacks: [
          {
            playback_id: "voice",
            effect_id: "file-1",
            volume: 0.5,
            looped: true,
            state: "playing",
            fade_out_ms: 1000,
          },
        ],
      }),
    );
    await user.type(screen.getByLabelText("Buscar en la paleta"), "TRANSICION");
    expect(
      screen.getByRole("heading", { name: "Sin resultados" }),
    ).toBeTruthy();
    await user.selectOptions(
      screen.getByLabelText("Ámbito de búsqueda"),
      "all",
    );
    const remote = screen.getByRole("button", { name: "Disparar Cortinilla" });
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Mover Cortinilla después",
      }).disabled,
    ).toBe(true);
    const handle = remote.closest("li")?.querySelector(".drag-handle");
    expect(handle?.getAttribute("draggable")).toBe("false");
    const setData = vi.fn();
    if (handle) fireEvent.dragStart(handle, { dataTransfer: { setData } });
    expect(setData).not.toHaveBeenCalled();
    await user.click(remote);
    expect(native.api.restartEffect).toHaveBeenCalledExactlyOnceWith(
      "file-1",
      saved.board.banks[1].buttons[0].playback,
    );
    expect(fake.saved().board.activeBankId).toBe("bank-1");
    expect(fake.api.saveBoard).not.toHaveBeenCalled();
    expect(screen.getByText("1 voces reales")).toBeTruthy();
    await user.clear(screen.getByLabelText("Buscar en la paleta"));
    await user.type(screen.getByLabelText("Buscar en la paleta"), "musica");
    expect(
      screen.getByRole("button", { name: "Disparar Cortinilla" }),
    ).toBeTruthy();
    await user.clear(screen.getByLabelText("Buscar en la paleta"));
    await user.type(
      screen.getByLabelText("Buscar en la paleta"),
      "aplauso.wav",
    );
    expect(
      screen.getByRole("button", { name: "Disparar Aplauso" }),
    ).toBeTruthy();
    await user.type(
      screen.getByLabelText("Buscar en la biblioteca"),
      "no existe",
    );
    expect(screen.getByText("Sin resultados en la biblioteca.")).toBeTruthy();
    expect(screen.getByText("1 voces reales")).toBeTruthy();
    await user.clear(screen.getByLabelText("Buscar en la biblioteca"));
    expect(screen.getByRole("heading", { name: "aplauso.wav" })).toBeTruthy();
    expect(fake.saved().board).toEqual(saved.board);
  });
  it.each(["copy", "move"] as const)(
    "confirms %s across banks with distinct identities and explicit shortcut policy",
    async (mode) => {
      const fake = fakeLibrary();
      const saved = fake.saved();
      saved.board.banks.push({ id: "bank-2", name: "Noticias", buttons: [] });
      saved.board.keyboardShortcuts = [
        shortcut({ scope: "bank", scopeBankId: "bank-1" }),
      ];
      fake.setSnapshot(saved);
      const { user, native, library } = await setup(fake);
      await user.click(
        screen.getByRole("button", { name: "Mover o copiar Aplauso" }),
      );
      expect(screen.getByText(/Atajos afectados: 1/)).toBeTruthy();
      await user.selectOptions(
        screen.getByLabelText("Banco destino"),
        "bank-2",
      );
      await user.selectOptions(screen.getByLabelText("Operación"), mode);
      const pending = deferred<LibrarySnapshot>();
      fake.api.saveBoard.mockReturnValueOnce(pending.promise);
      await user.click(
        screen.getByRole("button", { name: "Confirmar traslado" }),
      );
      expect(library.getSnapshot().snapshot?.board).toEqual(saved.board);
      const next = fake.saved();
      next.revision++;
      next.board = fake.api.saveBoard.mock.calls[0][0];
      fake.setSnapshot(next);
      await act(async () => pending.resolve(next));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const copied = fake.saved().board.banks[1].buttons[0];
      expect(copied.effectId).toBe("file-1");
      expect(copied.playback).toEqual(saved.board.banks[0].buttons[0].playback);
      expect(copied.id === "button-1").toBe(mode === "move");
      expect(
        fake
          .saved()
          .board.banks[0].buttons.some((button) => button.id === "button-1"),
      ).toBe(mode === "copy");
      expect(fake.saved().board.keyboardShortcuts).toHaveLength(
        mode === "copy" ? 1 : 0,
      );
      expect(native.api.restartEffect).not.toHaveBeenCalled();
    },
  );
  it("rejects moving into the source bank without losing the assignment or shortcuts", async () => {
    const { user, fake } = await setup();
    await user.click(
      screen.getByRole("button", { name: "Mover o copiar Aplauso" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirmar traslado" }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByText(/Elige un banco diferente/).length,
      ).toBeGreaterThan(0),
    );
    expect(fake.api.saveBoard).not.toHaveBeenCalled();
    expect(fake.saved().board.banks[0].buttons).toHaveLength(2);
  });
  it("cleans button shortcut references in the same confirmed deletion", async () => {
    const fake = fakeLibrary();
    const saved = fake.saved();
    saved.board.keyboardShortcuts = [shortcut()];
    fake.setSnapshot(saved);
    const { user } = await setup(fake);
    await user.click(screen.getByRole("button", { name: "Eliminar Aplauso" }));
    expect(screen.getByText(/Los atajos afectados se eliminan/)).toBeTruthy();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Eliminar botón",
      }),
    );
    await waitFor(() =>
      expect(fake.saved().board.keyboardShortcuts).toHaveLength(0),
    );
    expect(
      fake.api.saveBoard.mock.calls[0][0].banks[0].buttons.some(
        (button) => button.id === "button-1",
      ),
    ).toBe(false);
    expect(fake.saved().effects).toHaveLength(1);
  });
  it("shows native loop and fade state only after authoritative events and keeps immediate STOP available", async () => {
    const { user, native } = await setup();
    const status = await native.api.getAudioEngineStatus();
    const voice = {
      playback_id: "voice",
      effect_id: "file-1",
      volume: 0.5,
      looped: true,
      state: "playing" as const,
      fade_out_ms: 750,
    };
    act(() =>
      native.emit({ ...status, revision: 1, active_playbacks: [voice] }),
    );
    const pending = deferred<void>();
    native.api.setPlaybackLoop.mockReturnValueOnce(pending.promise);
    await user.click(
      screen.getByRole("button", {
        name: "Terminar al acabar la vuelta · voice",
      }),
    );
    expect(screen.getByText("Bucle activo")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Salida gradual (750 ms) · voice" }),
    );
    expect(native.api.fadeOutPlayback).toHaveBeenCalledWith("voice", 750);
    await user.click(
      screen.getByRole("button", { name: "Aplicar fade alternativo · voice" }),
    );
    expect(native.api.fadeOutPlayback).toHaveBeenCalledWith("voice", 1000);
    await user.clear(
      screen.getByLabelText("Duración de fade alternativa (ms)"),
    );
    await user.type(
      screen.getByLabelText("Duración de fade alternativa (ms)"),
      "30001",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Aplicar fade alternativo · voice",
      }).disabled,
    ).toBe(true);
    act(() =>
      native.emit({
        ...status,
        revision: 2,
        active_playbacks: [{ ...voice, state: "fading_out" }],
      }),
    );
    expect(
      screen.getByText("Finalizando: salida gradual en curso"),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Salida gradual (750 ms) · voice",
      }).disabled,
    ).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Detener instancia voice" }),
    );
    expect(native.api.stopPlayback).toHaveBeenCalledWith("voice");
    await act(async () => pending.resolve());
  });
});

describe("professional edit boundaries", () => {
  it("cleans a deleted bank's scoped and target references atomically while retaining unrelated shortcuts", async () => {
    const fake = fakeLibrary();
    const saved = fake.saved();
    saved.board.banks.push({ id: "bank-2", name: "Noticias", buttons: [] });
    saved.board.keyboardShortcuts = [
      shortcut(),
      shortcut({
        id: "select",
        chord: { ...shortcut().chord, code: "KeyB" },
        action: { kind: "select_bank", targetId: "bank-1" },
      }),
      shortcut({
        id: "scoped",
        scope: "bank",
        scopeBankId: "bank-1",
        chord: { ...shortcut().chord, code: "KeyC" },
        action: { kind: "stop_all", targetId: null },
      }),
      shortcut({
        id: "retained",
        chord: { ...shortcut().chord, code: "KeyD" },
        action: { kind: "stop_all", targetId: null },
      }),
    ];
    fake.setSnapshot(saved);
    const { user } = await setup(fake);
    await user.click(screen.getByRole("button", { name: "Organizar bancos" }));
    await user.click(
      screen.getByRole("button", { name: "Eliminar banco Principal" }),
    );
    expect(screen.getByText(/Los atajos afectados se eliminan/)).toBeTruthy();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Eliminar banco",
      }),
    );
    await waitFor(() => expect(fake.saved().board.banks).toHaveLength(1));
    expect(
      fake.saved().board.keyboardShortcuts.map((binding) => binding.id),
    ).toEqual(["retained"]);
    expect(
      fake.api.saveBoard.mock.calls[0][0].keyboardShortcuts.map(
        (binding) => binding.id,
      ),
    ).toEqual(["retained"]);
    expect(fake.saved().board.activeBankId).toBe("bank-2");
  });
  it("rejects transfers to a bank with 256 assignments without duplicating files or saving", async () => {
    const fake = fakeLibrary();
    const saved = fake.saved();
    saved.board.banks.push({
      id: "full",
      name: "Completo",
      buttons: Array.from({ length: 256 }, (_, index) => ({
        ...saved.board.banks[0].buttons[0],
        id: `full-${index}`,
      })),
    });
    fake.setSnapshot(saved);
    const { user } = await setup(fake);
    await user.click(
      screen.getByRole("button", { name: "Mover o copiar Aplauso" }),
    );
    await user.selectOptions(screen.getByLabelText("Banco destino"), "full");
    await user.selectOptions(screen.getByLabelText("Operación"), "copy");
    await user.click(
      screen.getByRole("button", { name: "Confirmar traslado" }),
    );
    await waitFor(() =>
      expect(screen.getAllByText(/máximo 256/).length).toBeGreaterThan(0),
    );
    expect(fake.api.saveBoard).not.toHaveBeenCalled();
    expect(fake.saved().effects).toHaveLength(1);
  });
  it("resolves hidden shortcut targets against the full ACK and refuses drag/drop during filtering", async () => {
    const fake = fakeLibrary();
    const saved = fake.saved();
    saved.board.keyboardShortcuts = [shortcut()];
    fake.setSnapshot(saved);
    const { user, native } = await setup(fake);
    await user.type(
      screen.getByLabelText("Buscar en la paleta"),
      "Sin asignar",
    );
    expect(
      screen.queryByRole("button", { name: "Disparar Aplauso" }),
    ).toBeNull();
    const heading = screen.getByRole("heading", { name: "Principal" });
    heading.focus();
    fireEvent.keyDown(heading, { code: "KeyA" });
    expect(native.api.restartEffect).toHaveBeenCalledExactlyOnceWith(
      "file-1",
      saved.board.banks[0].buttons[0].playback,
    );
    const card = screen
      .getByRole("button", { name: "Editar Sin asignar" })
      .closest("li");
    if (!card) throw new Error("Falta la tarjeta filtrada.");
    fireEvent.drop(card, { dataTransfer: { getData: () => "button-1" } });
    expect(fake.api.saveBoard).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Editar Sin asignar" }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("distinguishes a zero-duration fade from STOP and can enable loop from a confirmed simple voice", async () => {
    const { user, native } = await setup();
    const status = await native.api.getAudioEngineStatus();
    act(() =>
      native.emit({
        ...status,
        revision: 1,
        active_playbacks: [
          {
            playback_id: "zero",
            effect_id: "file-1",
            volume: 0.5,
            looped: false,
            state: "playing",
            fade_out_ms: 0,
          },
        ],
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Salida inmediata (0 ms) · zero" }),
    );
    expect(native.api.fadeOutPlayback).toHaveBeenCalledExactlyOnceWith(
      "zero",
      0,
    );
    expect(native.api.stopPlayback).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Activar bucle · zero" }),
    );
    expect(native.api.setPlaybackLoop).toHaveBeenCalledExactlyOnceWith(
      "zero",
      true,
    );
    expect(
      screen.getByText("Reproducción simple / última vuelta"),
    ).toBeTruthy();
  });
});

const preview: BankImportPreview = {
  token: "token-ui",
  bankNames: ["Banco externo"],
  effectCount: 1,
  buttonCount: 1,
  shortcutCount: 1,
  warnings: ["Revisar recursos externos"],
};
describe("bank package UI", () => {
  it.each(["close", "escape", "unmount"])(
    "releases late picker preparations on %s and allows emergency stop while pending",
    async (closing) => {
      const { fake, native, user, unmount } = await setup();
      const pending = deferred<{
        cancelled: boolean;
        preview: BankImportPreview | null;
      }>();
      fake.api.prepareBankImport.mockReturnValueOnce(pending.promise);
      await user.click(screen.getByRole("button", { name: "Importar bancos" }));
      await waitFor(() =>
        expect(fake.api.prepareBankImport).toHaveBeenCalledTimes(1),
      );
      await user.click(
        screen.getByRole("button", { name: "STOP ALL · emergencia" }),
      );
      expect(native.api.stopAll).toHaveBeenCalledTimes(1);
      if (closing === "unmount") unmount();
      else if (closing === "escape")
        fireEvent(
          screen.getByRole("dialog"),
          new Event("cancel", { bubbles: false, cancelable: true }),
        );
      else
        await user.click(
          screen.getByRole("button", { name: "Cerrar diálogo" }),
        );
      await act(async () => pending.resolve({ cancelled: false, preview }));
      await waitFor(() =>
        expect(fake.api.cancelBankImport).toHaveBeenCalledExactlyOnceWith(
          preview.token,
        ),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(fake.api.commitBankImport).not.toHaveBeenCalled();
    },
  );
  it("shows preview warnings with opt-in shortcuts and imports additive banks only after confirmation", async () => {
    const { fake, native, user } = await setup();
    fake.api.prepareBankImport.mockResolvedValueOnce({
      cancelled: false,
      preview,
    });
    const saved = fake.saved();
    saved.revision++;
    saved.board.banks.push({
      id: "bank-imported",
      name: "Banco externo",
      buttons: [],
    });
    fake.api.commitBankImport.mockResolvedValueOnce({
      snapshot: saved,
      importedBankIds: ["bank-imported"],
      reusedEffects: 1,
      warnings: ["Valores locales preservados"],
    });
    await user.click(screen.getByRole("button", { name: "Importar bancos" }));
    await screen.findByRole("heading", { name: "Vista previa" });
    expect(screen.getByText("Revisar recursos externos")).toBeTruthy();
    expect(screen.getByText(/no autenticidad/)).toBeTruthy();
    const enable = screen.getByLabelText<HTMLInputElement>(
      /Activar atajos importados/,
    );
    expect(enable.checked).toBe(false);
    expect(fake.api.commitBankImport).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /02 Banco externo/ }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Confirmar importación de bancos" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.api.commitBankImport).toHaveBeenCalledExactlyOnceWith(
      preview.token,
      0,
      false,
    );
    expect(
      screen.getByRole("button", { name: /02 Banco externo/ }),
    ).toBeTruthy();
    expect(screen.getByText(/Valores locales preservados/)).toBeTruthy();
    expect(native.api.restartEffect).not.toHaveBeenCalled();
  });
  it("clears a failed import preview and offers explicit re-preparation without auto-retry", async () => {
    const { fake, user } = await setup();
    fake.api.prepareBankImport.mockResolvedValueOnce({
      cancelled: false,
      preview,
    });
    fake.api.commitBankImport.mockRejectedValueOnce({
      code: "revision_conflict",
      message: "El tablero cambió",
    });
    await user.click(screen.getByRole("button", { name: "Importar bancos" }));
    await screen.findByRole("heading", { name: "Vista previa" });
    await user.click(screen.getByLabelText(/Activar atajos importados/));
    await user.click(
      screen.getByRole("button", { name: "Confirmar importación de bancos" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: "Elegir paquete",
        }).disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole("heading", { name: "Vista previa" })).toBeNull();
    expect(fake.api.commitBankImport).toHaveBeenCalledExactlyOnceWith(
      preview.token,
      0,
      true,
    );
    expect(
      screen.getAllByText(/Se recargó el estado confirmado/).length,
    ).toBeGreaterThan(0);
    expect(fake.api.prepareBankImport).toHaveBeenCalledTimes(1);
  });
  it("exports selected banks with shortcuts and reports picker cancellation without claiming success", async () => {
    const { fake, user } = await setup();
    await user.click(screen.getByRole("button", { name: "Exportar bancos" }));
    const modal = within(screen.getByRole("dialog"));
    expect(modal.getByText(/rechaza sobrescribir/)).toBeTruthy();
    expect(modal.getByLabelText<HTMLInputElement>("Principal").checked).toBe(
      true,
    );
    await user.click(modal.getByLabelText("Principal"));
    await user.click(
      modal.getByRole("button", { name: "Elegir destino y exportar" }),
    );
    expect(modal.getByRole("alert").textContent).toContain(
      "Selecciona al menos un banco",
    );
    expect(fake.api.exportSoundBanks).not.toHaveBeenCalled();
    await user.click(modal.getByLabelText("Principal"));
    await user.click(modal.getByLabelText("Incluir atajos"));
    await user.click(
      modal.getByRole("button", { name: "Elegir destino y exportar" }),
    );
    await waitFor(() =>
      expect(modal.getByText("Exportación cancelada.")).toBeTruthy(),
    );
    expect(fake.api.exportSoundBanks).toHaveBeenCalledExactlyOnceWith(
      ["bank-1"],
      0,
      true,
    );
    expect(screen.queryByText(/Exportación confirmada:/)).toBeNull();
  });
  it.each(["prepare", "commit", "export"])(
    "keeps confirmed pad playback and stop independent while package %s is in flight",
    async (operation) => {
      const { fake, native, user, library } = await setup();
      const pending = deferred<void>();
      if (operation === "prepare")
        fake.api.prepareBankImport.mockImplementationOnce(async () => {
          await pending.promise;
          return { cancelled: false, preview };
        });
      else if (operation === "commit") {
        fake.api.prepareBankImport.mockResolvedValueOnce({
          cancelled: false,
          preview,
        });
        fake.api.commitBankImport.mockImplementationOnce(async () => {
          await pending.promise;
          return {
            snapshot: fake.saved(),
            importedBankIds: [],
            reusedEffects: 0,
            warnings: [],
          };
        });
      } else
        fake.api.exportSoundBanks.mockImplementationOnce(async () => {
          await pending.promise;
          return {
            cancelled: true,
            exportedBanks: 0,
            exportedEffects: 0,
            byteSize: 0,
            warnings: [],
          };
        });
      await user.click(
        screen.getByRole("button", {
          name: operation === "export" ? "Exportar bancos" : "Importar bancos",
        }),
      );
      if (operation === "commit") {
        await screen.findByRole("heading", { name: "Vista previa" });
        await user.click(
          screen.getByRole("button", {
            name: "Confirmar importación de bancos",
          }),
        );
      }
      if (operation === "export")
        await user.click(
          screen.getByRole("button", { name: "Elegir destino y exportar" }),
        );
      await waitFor(() => expect(library.getSnapshot().busy).toBe(true));
      await user.click(screen.getByRole("button", { name: "Cerrar diálogo" }));
      await user.click(
        screen.getByRole("button", { name: "Disparar Aplauso" }),
      );
      await user.click(
        screen.getByRole("button", { name: "STOP ALL · audio nativo" }),
      );
      expect(native.api.restartEffect).toHaveBeenCalledTimes(1);
      expect(native.api.stopAll).toHaveBeenCalledTimes(1);
      expect(
        screen
          .getByRole("button", { name: "Editar Aplauso" })
          .matches(":disabled"),
      ).toBe(true);
      await act(async () => pending.resolve());
      await waitFor(() => expect(library.getSnapshot().busy).toBe(false));
      expect(native.api.restartEffect).toHaveBeenCalledTimes(1);
    },
  );
});
