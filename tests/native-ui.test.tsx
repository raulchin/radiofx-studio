// @vitest-environment jsdom
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/app/App";
import { NativeAudioController } from "../src/features/audio-controls/native-controller";
import { createBoardStore } from "../src/features/soundboard/store";
import { SettingsPanel } from "../src/features/settings/SettingsPanel";
import * as adapter from "../src/shared/adapters/audio";
import { deferred, fakeNative, nativeStatus, output } from "./native-fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** @returns Vista aislada y dobles de IPC para comprobar la integración completa. */
async function setupNative() {
  const fake = fakeNative();
  const controller = new NativeAudioController(fake.api);
  const store = createBoardStore();
  render(<App store={store} nativeController={controller} />);
  await waitFor(() =>
    expect(fake.api.listOutputDevices).toHaveBeenCalledTimes(1),
  );
  return { fake, controller, store };
}

describe("native audio UI", () => {
  /** Conserva el borrador durante las consultas, muestra rechazos y confirma el valor solo desde Rust. */
  it("types the complete limit draft and applies by button or Enter without optimistic confirmation", async () => {
    const user = userEvent.setup();
    const { fake } = await setupNative();
    const input = screen.getByLabelText<HTMLInputElement>(
      "Límite de voces nativas (1–64)",
    );
    await user.clear(input);
    await user.type(input, "32");
    expect(input.value).toBe("32");
    expect(fake.api.setMaxConcurrentPlaybacks).not.toHaveBeenCalled();
    const snapshot = nativeStatus({
      state: "ready",
      selected_device: output,
      revision: 2,
    });
    fake.setStatus(snapshot);
    act(() => fake.emit(snapshot));
    await user.click(screen.getByRole("button", { name: "Consultar estado" }));
    expect(input.value).toBe("32");
    fake.api.setMaxConcurrentPlaybacks.mockRejectedValueOnce({
      code: "stop_in_progress",
      message: "Parada de emergencia en curso",
    });
    await user.click(screen.getByRole("button", { name: "Aplicar límite" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Parada de emergencia en curso",
      ),
    );
    expect(fake.api.setMaxConcurrentPlaybacks).toHaveBeenCalledExactlyOnceWith(
      32,
    );
    expect(
      screen.getByText("Borrador; límite confirmado por Rust: 16."),
    ).toBeTruthy();
    expect(input.value).toBe("32");
    fake.api.setMaxConcurrentPlaybacks.mockImplementationOnce(async (value) => {
      fake.setStatus(
        nativeStatus({
          state: "ready",
          selected_device: output,
          max_concurrent_playbacks: value,
          revision: 3,
        }),
      );
    });
    await user.click(input);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.getByText("Borrador; límite confirmado por Rust: 32."),
      ).toBeTruthy(),
    );
    expect(fake.api.setMaxConcurrentPlaybacks.mock.calls).toEqual([[32], [32]]);
    expect(
      screen.getByLabelText<HTMLInputElement>("Límite de voces nativas (1–64)")
        .value,
    ).toBe("32");
    act(() =>
      fake.emit(
        nativeStatus({
          state: "ready",
          revision: 4,
          max_concurrent_playbacks: 24,
        }),
      ),
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("Límite de voces nativas (1–64)")
        .value,
    ).toBe("24");
  });

  /** Las restricciones nativas mantienen el borrador inválido sin enviarlo ni alterar el límite confirmado. */
  it("keeps invalid limit drafts constrained without sending native commands", async () => {
    const user = userEvent.setup();
    const { fake } = await setupNative();
    const input = screen.getByLabelText<HTMLInputElement>(
      "Límite de voces nativas (1–64)",
    );
    for (const value of ["", "0", "65", "1.5"]) {
      await user.clear(input);
      if (value) await user.type(input, value);
      await user.click(screen.getByRole("button", { name: "Aplicar límite" }));
      expect(input.validity.valid).toBe(false);
      expect(input.validationMessage).not.toBe("");
      expect(input.value).toBe(value);
    }
    expect(fake.api.setMaxConcurrentPlaybacks).not.toHaveBeenCalled();
    expect(
      screen.getByText("Borrador; límite confirmado por Rust: 16."),
    ).toBeTruthy();
  });

  /** Los metadatos de una salida fallida nunca se presentan como una ruta activa. */
  it("marks selected metadata as unavailable after device failure and preserves errors across queries", async () => {
    const { fake } = await setupNative();
    const failed = nativeStatus({
      state: "device_error",
      selected_device: output,
      revision: 2,
      last_error: { code: "device_lost", message: "Se desconectó la interfaz" },
    });
    fake.setStatus(failed);
    act(() => fake.emit(failed));
    expect(
      within(screen.getByRole("banner")).getByText(
        "Audio nativo · error de dispositivo",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("banner")).getByText(
        "Salida no disponible: Interfaz USB",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", {
        name: "Salida no disponible: Interfaz USB · elige para cambiar",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: /Salida activa actual/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Consultar estado" }));
    await waitFor(() =>
      expect(fake.api.getAudioEngineStatus).toHaveBeenCalledTimes(3),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Se desconectó la interfaz",
    );
  });

  it("renders Rust resources and separates mock actions and native commands", async () => {
    const { fake } = await setupNative();
    expect(
      screen.getByRole("heading", { name: "Audio nativo · señales de prueba" }),
    ).toBeTruthy();
    expect(
      screen.getByText("PALETA DE RECURSOS MOCK / SIN AUDIO"),
    ).toBeTruthy();
    expect(screen.getAllByText("Interfaz USB").length).toBeGreaterThan(0);
    expect(screen.getByText("SEÑAL RUST / 4000 ms")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /^Demostrar / })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Restablecer demo" }));
    expect(fake.api.restartEffect).not.toHaveBeenCalled();
    expect(fake.api.stopAll).not.toHaveBeenCalled();
    const play = screen.getByRole("button", {
      name: "Disparar Señal de prueba aguda",
    });
    fireEvent.click(play);
    fireEvent.click(play);
    expect(fake.api.restartEffect.mock.calls).toEqual([
      ["native-test-chime", { looped: false, fadeInMs: 0, fadeOutMs: 0 }],
      ["native-test-chime", { looped: false, fadeInMs: 0, fadeOutMs: 0 }],
    ]);
    await waitFor(() => expect(screen.getByText("1 / 16 voces")).toBeTruthy());
    expect(fake.api.playEffect).not.toHaveBeenCalled();
    expect(fake.api.playEffectWithOptions).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "STOP ALL · audio nativo" }),
    );
    await waitFor(() => expect(fake.api.stopAll).toHaveBeenCalledTimes(1));
  });

  it("renders explicit legacy parallel playback IDs and routes gain and stop commands separately", async () => {
    const { fake } = await setupNative();
    const voices = ["voice-1", "voice-2"].map((id) => ({
      playback_id: id,
      looped: false,
      state: "playing" as const,
      fade_out_ms: 0,
      effect_id: "native-test-chime",
      volume: 0.5,
    }));
    act(() =>
      fake.emit(
        nativeStatus({
          revision: 4,
          state: "ready",
          selected_device: output,
          active_playbacks: voices,
        }),
      ),
    );
    expect(screen.getByText("voice-1")).toBeTruthy();
    expect(screen.getByText("voice-2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Volumen maestro nativo"), {
      target: { value: "0.2" },
    });
    fireEvent.change(
      screen.getByLabelText("Volumen por defecto de Señal de prueba aguda"),
      { target: { value: "0.3" } },
    );
    fireEvent.change(screen.getByLabelText("Volumen de instancia voice-2"), {
      target: { value: "0.4" },
    });
    await waitFor(() =>
      expect(fake.api.setPlaybackVolume).toHaveBeenCalledWith("voice-2", 0.4),
    );
    expect(fake.api.setMasterVolume).toHaveBeenCalledWith(0.2);
    expect(fake.api.setEffectVolume).toHaveBeenCalledWith(
      "native-test-chime",
      0.3,
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("Volumen maestro nativo").value,
    ).toBe("0.7");
    expect(
      screen.getByLabelText<HTMLInputElement>("Volumen de instancia voice-2")
        .value,
    ).toBe("0.5");
    fireEvent.change(screen.getByLabelText("Límite de voces nativas (1–64)"), {
      target: { value: "32" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar límite" }));
    await waitFor(() =>
      expect(fake.api.setMaxConcurrentPlaybacks).toHaveBeenCalledWith(32),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Detener instancia voice-1" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Detener todas de Señal de prueba aguda",
      }),
    );
    expect(fake.api.stopPlayback).toHaveBeenCalledWith("voice-1");
    expect(fake.api.stopEffect).toHaveBeenCalledWith("native-test-chime");
    expect(screen.getByText("voice-1")).toBeTruthy();
  });

  it("keeps active output visible when enumeration renews tokens and locks routing during selection", async () => {
    const { fake } = await setupNative();
    const renewed = { ...output, id: "session-token-2" };
    fake.api.listOutputDevices.mockResolvedValueOnce([renewed]);
    fireEvent.click(
      screen.getByRole("button", { name: "Actualizar dispositivos" }),
    );
    const select = screen.getByLabelText<HTMLSelectElement>(
      "Dispositivo de salida nativo",
    );
    await waitFor(() =>
      expect(
        within(select).getByRole<HTMLOptionElement>("option", {
          name: "Interfaz USB (predeterminada)",
        }).value,
      ).toBe(renewed.id),
    );
    expect(select.value).toBe("");
    expect(
      within(select).getByRole("option", {
        name: /Salida activa actual: Interfaz USB/,
      }),
    ).toBeTruthy();
    expect(fake.api.setOutputDevice).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: renewed.id } });
    const transition =
      deferred<Awaited<ReturnType<typeof fake.api.setOutputDevice>>>();
    fake.api.setOutputDevice.mockReturnValueOnce(transition.promise);
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar salida" }));
    expect(fake.api.setOutputDevice).toHaveBeenCalledWith(renewed.id);
    expect(select.disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Actualizando salida...",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "STOP ALL · audio nativo",
      }).disabled,
    ).toBe(false);
    await act(async () => {
      transition.resolve({
        status: nativeStatus({
          state: "ready",
          selected_device: renewed,
          revision: 2,
        }),
        restored_previous: false,
        error: null,
      });
    });
    expect(select.value).toBe("");
    expect(
      screen.getByText("Salida seleccionada para esta sesión."),
    ).toBeTruthy();
  });

  it("stops native audio from within a modal without resetting mock states or using Escape", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    });
    const { fake, store } = await setupNative();
    fireEvent.click(screen.getAllByRole("button", { name: /^Demostrar / })[0]);
    const states = store.getState().demoStates;
    fireEvent.click(screen.getByRole("button", { name: "Configuración" }));
    const dialog = screen.getByRole("dialog");
    const prevented = !fireEvent.keyDown(
      within(dialog).getByLabelText("Distribución de la cuadrícula"),
      { key: " ", code: "Space", ctrlKey: true, shiftKey: true },
    );
    expect(prevented).toBe(true);
    expect(fake.api.stopAll).toHaveBeenCalledTimes(1);
    expect(store.getState().demoStates).toBe(states);
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    expect(fake.api.stopAll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("leaves CRUD usable without Tauri and displays backend errors without inventing state", async () => {
    render(<App store={createBoardStore()} />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "aplicación de escritorio",
      ),
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "STOP ALL · audio nativo",
      }).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "+ Banco" }));
    fireEvent.change(screen.getByLabelText("Nombre del banco"), {
      target: { value: "Sin conexión" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Crear banco" }).closest("form")!,
    );
    expect(screen.getByRole("heading", { name: "Sin conexión" })).toBeTruthy();
    cleanup();
    const { fake } = await setupNative();
    act(() =>
      fake.emit(
        nativeStatus({
          revision: 4,
          state: "device_error",
          last_error: {
            code: "device_lost",
            message: "Se desconectó la interfaz",
          },
        }),
      ),
    );
    expect(screen.getByText("Error de dispositivo")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Se desconectó la interfaz",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Disparar Señal de prueba aguda",
      }).disabled,
    ).toBe(true);
  });

  it("survives StrictMode teardown and removes the emergency listener on unmount", async () => {
    const fake = fakeNative();
    const controller = new NativeAudioController(fake.api);
    const mounted = render(
      <StrictMode>
        <App nativeController={controller} store={createBoardStore()} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText("Motor listo")).toBeTruthy());
    expect(fake.api.subscribeAudio).toHaveBeenCalledTimes(2);
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    mounted.unmount();
    fireEvent.keyDown(window, { code: "Space", ctrlKey: true, shiftKey: true });
    expect(fake.api.stopAll).not.toHaveBeenCalled();
    expect(fake.dispose).toHaveBeenCalledTimes(2);
  });

  it("reports the actual diagnostic snapshot rather than a fixed uninitialized message", async () => {
    vi.spyOn(adapter, "getAudioEngineStatus").mockResolvedValue(
      nativeStatus({
        state: "ready",
        selected_device: output,
        active_playbacks: [
          {
            playback_id: "p1",
            effect_id: "native-test-chime",
            volume: 0.5,
            looped: false,
            state: "playing",
            fade_out_ms: 0,
          },
        ],
      }),
    );
    render(<SettingsPanel columns="auto" onColumnsChange={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Comprobar backend nativo" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Motor: listo. Salida: Interfaz USB. Instancias activas: 1. Volumen maestro: 70%",
      ),
    );
  });
});
