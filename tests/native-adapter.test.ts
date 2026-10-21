import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import * as audio from "../src/shared/adapters/audio";
import { audioEvents } from "../src/shared/contracts/audio";
import { deferred, nativeStatus, output } from "./native-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});

describe("native adapter", () => {
  it("validates all command responses and camelCase arguments", async () => {
    const status = nativeStatus();
    for (const [command, args, payload, call, expected] of [
      [
        "list_output_devices",
        undefined,
        [output],
        () => audio.listOutputDevices(),
        [output],
      ],
      [
        "get_selected_output_device",
        undefined,
        output,
        () => audio.getSelectedOutputDevice(),
        output,
      ],
      [
        "get_selected_output_device",
        undefined,
        null,
        () => audio.getSelectedOutputDevice(),
        null,
      ],
      [
        "set_output_device",
        { deviceId: output.id },
        { status, restored_previous: false, error: null },
        () => audio.setOutputDevice(output.id),
        { status, restored_previous: false, error: null },
      ],
      [
        "play_effect",
        { effectId: "native-test-chime" },
        "p1",
        () => audio.playEffect("native-test-chime"),
        "p1",
      ],
      [
        "stop_playback",
        { playbackId: "p1" },
        null,
        () => audio.stopPlayback("p1"),
        undefined,
      ],
      [
        "stop_effect",
        { effectId: "native-test-chime" },
        null,
        () => audio.stopEffect("native-test-chime"),
        undefined,
      ],
      ["stop_all", undefined, null, () => audio.stopAll(), undefined],
      [
        "set_master_volume",
        { value: 0.2 },
        null,
        () => audio.setMasterVolume(0.2),
        undefined,
      ],
      [
        "set_playback_volume",
        { playbackId: "p1", value: 0.3 },
        null,
        () => audio.setPlaybackVolume("p1", 0.3),
        undefined,
      ],
      [
        "set_effect_volume",
        { effectId: "native-test-chime", value: 0.4 },
        null,
        () => audio.setEffectVolume("native-test-chime", 0.4),
        undefined,
      ],
      [
        "set_max_concurrent_playbacks",
        { value: 64 },
        null,
        () => audio.setMaxConcurrentPlaybacks(64),
        undefined,
      ],
      [
        "get_active_playbacks",
        undefined,
        [
          {
            playback_id: "p1",
            effect_id: "e1",
            volume: 0.5,
            looped: false,
            state: "playing",
            fade_out_ms: 0,
          },
        ],
        () => audio.getActivePlaybacks(),
        [
          {
            playback_id: "p1",
            effect_id: "e1",
            volume: 0.5,
            looped: false,
            state: "playing",
            fade_out_ms: 0,
          },
        ],
      ],
    ] as const) {
      vi.mocked(invoke).mockResolvedValueOnce(payload);
      await expect(call()).resolves.toEqual(expected);
      if (args === undefined) expect(invoke).toHaveBeenLastCalledWith(command);
      else expect(invoke).toHaveBeenLastCalledWith(command, args);
    }
  });

  it("validates atomic restart arguments results and desktop availability independently of legacy parallel commands", async () => {
    const options = { looped: true, fadeInMs: 50, fadeOutMs: 750 };
    vi.mocked(invoke).mockResolvedValueOnce("fresh-voice");
    await expect(audio.restartEffect("e1", options)).resolves.toBe(
      "fresh-voice",
    );
    expect(invoke).toHaveBeenLastCalledWith("restart_effect", {
      effectId: "e1",
      options,
    });
    vi.mocked(invoke).mockClear();
    await expect(audio.restartEffect("", options)).rejects.toThrow();
    for (const invalid of [
      { ...options, fadeInMs: NaN },
      { ...options, fadeInMs: Infinity },
      { ...options, fadeOutMs: -1 },
      { ...options, fadeOutMs: 30001 },
      { ...options, fadeOutMs: 0.5 },
      { ...options, unknown: true },
    ])
      await expect(audio.restartEffect("e1", invalid)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    for (const payload of ["", null, undefined, 42, {}]) {
      vi.mocked(invoke).mockResolvedValueOnce(payload);
      await expect(audio.restartEffect("e1", options)).rejects.toThrow();
    }
    vi.mocked(invoke).mockClear();
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(audio.restartEffect("e1", options)).rejects.toThrow(
      "aplicación de escritorio",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects invalid gains limits and void payloads without hiding IPC failures", async () => {
    for (const value of [-1, 1.1, NaN, Infinity]) {
      await expect(audio.setMasterVolume(value)).rejects.toThrow();
      await expect(audio.setPlaybackVolume("p1", value)).rejects.toThrow();
      await expect(audio.setEffectVolume("e1", value)).rejects.toThrow();
    }
    for (const value of [0, 65, 1.5, NaN])
      await expect(audio.setMaxConcurrentPlaybacks(value)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    for (const payload of [undefined, {}, true]) {
      vi.mocked(invoke).mockResolvedValueOnce(payload);
      await expect(audio.stopAll()).rejects.toThrow();
    }
    vi.mocked(invoke).mockRejectedValueOnce({
      code: "voice_limit",
      message: "Límite de voces alcanzado",
    });
    await expect(audio.playEffect("e1")).rejects.toEqual({
      code: "voice_limit",
      message: "Límite de voces alcanzado",
    });
    vi.mocked(invoke).mockResolvedValueOnce([
      { playback_id: "p1", effect_id: "e1", volume: 2 },
    ]);
    await expect(audio.getActivePlaybacks()).rejects.toThrow();
    vi.mocked(invoke).mockResolvedValueOnce({
      id: "x",
      name: "USB",
      is_default: "true",
    });
    await expect(audio.getSelectedOutputDevice()).rejects.toThrow();
  });

  it("validates full snapshots on all seven events and removes late listeners", async () => {
    const status = nativeStatus();
    const callbacks: ((event: Event<unknown>) => void)[] = [];
    const late = deferred<() => void>();
    const remove = vi.fn();
    vi.mocked(listen).mockImplementation((_name, callback) => {
      callbacks.push(callback);
      return late.promise;
    });
    const receive = vi.fn();
    const fail = vi.fn();
    const subscription = audio.subscribeAudio(receive, fail);
    expect(listen).toHaveBeenCalledTimes(7);
    expect(vi.mocked(listen).mock.calls.map(([name]) => name)).toEqual(
      audioEvents,
    );
    callbacks.forEach((callback) =>
      callback({ event: "test", id: 1, payload: status }),
    );
    expect(receive).toHaveBeenCalledTimes(7);
    callbacks[0]({ event: "test", id: 1, payload: { state: "ready" } });
    expect(fail).toHaveBeenCalledTimes(1);
    subscription.dispose();
    callbacks[0]({ event: "test", id: 1, payload: status });
    expect(receive).toHaveBeenCalledTimes(7);
    late.resolve(remove);
    await subscription.ready;
    expect(remove).toHaveBeenCalledTimes(7);
  });

  it("reports subscription errors and browser unavailability without native calls", async () => {
    vi.mocked(listen).mockRejectedValue(new Error("No se pudo escuchar"));
    const fail = vi.fn();
    const subscription = audio.subscribeAudio(vi.fn(), fail);
    await subscription.ready;
    expect(fail).toHaveBeenCalledTimes(7);
    subscription.dispose();
    vi.mocked(isTauri).mockReturnValue(false);
    vi.mocked(listen).mockClear();
    const browser = audio.subscribeAudio(vi.fn(), fail);
    await browser.ready;
    await expect(audio.stopAll()).rejects.toThrow("aplicación de escritorio");
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    browser.dispose();
    expect(
      audio.audioErrorMessage({ code: "queue_full", message: "Cola llena" }),
    ).toContain("Cola llena (queue_full)");
    expect(audio.audioErrorMessage(null)).toContain("no se pudo completar");
  });
});
