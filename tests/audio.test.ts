import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getAudioEngineStatus } from "../src/shared/adapters/audio";
import { audioEngineStatusSchema } from "../src/shared/contracts/audio";
import { nativeStatus } from "./native-fixtures";

/** @returns Dobles del límite IPC para no depender de hardware nativo. */
function mockTauri() {
  return { invoke: vi.fn(), isTauri: vi.fn() };
}

vi.mock("@tauri-apps/api/core", mockTauri);

const initialStatus = nativeStatus();

/** Restablece el entorno nativo simulado antes de cada caso. */
function resetMocks() {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
}

/** Verifica el contrato inicial y el rechazo de datos no autorizados. */
function contractSuite() {
  /** Comprueba el estado documentado de Fase 1. */
  function acceptsInitialState() {
    expect(audioEngineStatusSchema.parse(initialStatus)).toEqual(initialStatus);
  }
  /** Rechaza estados incompatibles sin simular un motor funcional. */
  function rejectsInvalidPayloads() {
    for (const payload of [
      null,
      {},
      { ...initialStatus, state: "playing" },
      { ...initialStatus, selected_device: "fake-device" },
      { ...initialStatus, engine_id: "invalid" },
      { ...initialStatus, revision: -1 },
      { ...initialStatus, master_volume: 1.1 },
      { ...initialStatus, max_concurrent_playbacks: 65 },
      { ...initialStatus, effects: [{ effect_id: "x", default_volume: NaN }] },
      { ...initialStatus, max_concurrent_playbacks: 0 },
      { ...initialStatus, active_playbacks: ["fake-playback"] },
      { ...initialStatus, extra: true },
    ]) {
      expect(audioEngineStatusSchema.safeParse(payload).success).toBe(false);
    }
  }
  it("accepts_initial_state", acceptsInitialState);
  it("rejects_invalid_payloads", rejectsInvalidPayloads);
}

/** Comprueba el adaptador de consulta y sus errores de frontera. */
function adapterSuite() {
  beforeEach(resetMocks);

  /** @returns Promesa de verificación del nombre y resultado del comando. */
  async function invokesReadOnlyCommand() {
    vi.mocked(invoke).mockResolvedValue(initialStatus);
    await expect(getAudioEngineStatus()).resolves.toEqual(initialStatus);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("get_audio_engine_status");
  }
  /** @returns Promesa de rechazo de un payload IPC inválido. */
  async function rejectsInvalidResponse() {
    vi.mocked(invoke).mockResolvedValue({ state: "ready" });
    await expect(getAudioEngineStatus()).rejects.toThrow();
  }
  /** @returns Promesa de propagación de un fallo de transporte. */
  async function propagatesIpcFailure() {
    vi.mocked(invoke).mockRejectedValue(new Error("IPC no disponible"));
    await expect(getAudioEngineStatus()).rejects.toThrow("IPC no disponible");
  }
  /** @returns Promesa de rechazo sin IPC en una vista de navegador. */
  async function rejectsBrowserPreview() {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(getAudioEngineStatus()).rejects.toThrow(
      "aplicación de escritorio",
    );
    expect(invoke).not.toHaveBeenCalled();
  }

  it("invokes_read_only_command", invokesReadOnlyCommand);
  it("rejects_invalid_response", rejectsInvalidResponse);
  it("propagates_ipc_failure", propagatesIpcFailure);
  it("rejects_browser_preview", rejectsBrowserPreview);
}

describe("audio_contract", contractSuite);
describe("audio_adapter", adapterSuite);
