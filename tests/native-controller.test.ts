import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeAudioController } from "../src/features/audio-controls/native-controller";
import type { DeviceSelectionResult } from "../src/shared/contracts/audio";
import { deferred, fakeNative, nativeStatus, output } from "./native-fixtures";

/** @returns Vacía las microtareas de IPC y reconciliación sin esperar hardware. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("native controller", () => {
  /** Comprueba que cien cambios conservan solo el primero y el último por control. */
  it.each(["master", "effect", "playback", "limit"] as const)(
    "coalesces a flood for %s without accumulating queries or waiters",
    async (key) => {
      const fake = fakeNative();
      fake.setStatus(
        nativeStatus({
          state: "ready",
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
      const controller = new NativeAudioController(fake.api);
      const stop = controller.start();
      await settle();
      const queryCount = fake.api.getAudioEngineStatus.mock.calls.length;
      const inflight = deferred<void>();
      const command =
        key === "master"
          ? fake.api.setMasterVolume
          : key === "effect"
            ? fake.api.setEffectVolume
            : key === "playback"
              ? fake.api.setPlaybackVolume
              : fake.api.setMaxConcurrentPlaybacks;
      command.mockReturnValueOnce(inflight.promise);
      /** @param value Última intención del control elegido. @returns Promesa compartida de drenaje. */
      const change = (value: number) =>
        key === "master"
          ? controller.setMasterVolume(value)
          : key === "effect"
            ? controller.setEffectVolume("native-test-chime", value)
            : key === "playback"
              ? controller.setPlaybackVolume("p1", value)
              : controller.setLimit(value);
      const firstValue = key === "limit" ? 1 : 0.1;
      const lastValue = key === "limit" ? 64 : 1;
      const first = change(firstValue);
      for (let index = 1; index <= 100; index++) {
        const pending = change(
          key === "limit" ? Math.min(index, 64) : index / 100,
        );
        expect(pending).toBe(first);
      }
      expect(command).toHaveBeenCalledTimes(1);
      expect(fake.api.getAudioEngineStatus).toHaveBeenCalledTimes(queryCount);
      inflight.resolve();
      await first;
      expect(command).toHaveBeenCalledTimes(2);
      expect(command.mock.calls.map((args) => args[args.length - 1])).toEqual([
        firstValue,
        lastValue,
      ]);
      expect(fake.api.getAudioEngineStatus).toHaveBeenCalledTimes(
        queryCount + 2,
      );
      stop();
    },
  );

  /** Garantiza que silenciar el maestro no espera los cambios de otros controles. */
  it("sends master zero immediately while another control has a hundred pending intentions", async () => {
    const fake = fakeNative();
    const controller = new NativeAudioController(fake.api);
    const stop = controller.start();
    await settle();
    const inflight = deferred<void>();
    fake.api.setEffectVolume.mockReturnValueOnce(inflight.promise);
    const effect = controller.setEffectVolume("native-test-chime", 0.2);
    for (let index = 0; index < 100; index++)
      void controller.setEffectVolume("native-test-chime", index / 100);
    await controller.setMasterVolume(0);
    expect(fake.api.setMasterVolume).toHaveBeenCalledExactlyOnceWith(0);
    expect(fake.api.setEffectVolume).toHaveBeenCalledTimes(1);
    inflight.resolve();
    await effect;
    expect(fake.api.setEffectVolume.mock.calls).toEqual([
      ["native-test-chime", 0.2],
      ["native-test-chime", 0.99],
    ]);
    stop();
  });

  /** STOP ALL descarta pendientes de todas las claves, pero no cancela IPC ya enviado. */
  it("discards queued gains and limits before sending stop all without replaying cancelled requests", async () => {
    const fake = fakeNative();
    fake.setStatus(
      nativeStatus({
        state: "ready",
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
    const controller = new NativeAudioController(fake.api);
    const stop = controller.start();
    await settle();
    const inflight = deferred<void>();
    for (const command of [
      fake.api.setMasterVolume,
      fake.api.setEffectVolume,
      fake.api.setPlaybackVolume,
      fake.api.setMaxConcurrentPlaybacks,
    ])
      command.mockReturnValueOnce(inflight.promise);
    const jobs = [
      controller.setMasterVolume(0.2),
      controller.setEffectVolume("native-test-chime", 0.2),
      controller.setPlaybackVolume("p1", 0.2),
      controller.setLimit(20),
    ];
    void controller.setMasterVolume(0.8);
    void controller.setEffectVolume("native-test-chime", 0.8);
    void controller.setPlaybackVolume("p1", 0.8);
    void controller.setLimit(32);
    await controller.stopAll();
    expect(fake.api.stopAll).toHaveBeenCalledTimes(1);
    inflight.reject({
      code: "request_cancelled",
      message: "Solicitud cancelada por parada de emergencia",
    });
    await Promise.all(jobs);
    for (const command of [
      fake.api.setMasterVolume,
      fake.api.setEffectVolume,
      fake.api.setPlaybackVolume,
      fake.api.setMaxConcurrentPlaybacks,
    ])
      expect(command).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().error).toContain("request_cancelled");
    await controller.refresh();
    expect(controller.getSnapshot().error).toContain("request_cancelled");
    fake.api.setMasterVolume.mockRejectedValueOnce({
      code: "stop_in_progress",
      message: "Parada en curso",
    });
    await controller.setMasterVolume(0.5);
    expect(controller.getSnapshot().error).toContain("stop_in_progress");
    stop();
  });

  /** Los eventos de fin y los IDs ajenos no deben generar ganancias diferidas. */
  it("drops pending gains for finished voices and rejects controls outside the current snapshot", async () => {
    const fake = fakeNative();
    fake.setStatus(
      nativeStatus({
        state: "ready",
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
    const controller = new NativeAudioController(fake.api);
    const stop = controller.start();
    await settle();
    const inflight = deferred<void>();
    fake.api.setPlaybackVolume.mockReturnValueOnce(inflight.promise);
    const first = controller.setPlaybackVolume("p1", 0.2);
    void controller.setPlaybackVolume("p1", 0.8);
    fake.emit(
      nativeStatus({ state: "ready", revision: 2, active_playbacks: [] }),
    );
    await controller.setPlaybackVolume("p1", 0.9);
    for (let index = 0; index < 100; index++) {
      void controller.setPlaybackVolume(`missing-${index}`, 0.5);
      void controller.setEffectVolume(`missing-${index}`, 0.5);
    }
    inflight.resolve();
    await first;
    expect(fake.api.setPlaybackVolume.mock.calls).toEqual([["p1", 0.2]]);
    expect(fake.api.setEffectVolume).not.toHaveBeenCalled();
    stop();
  });

  /** Ni el desmontaje ni un reinicio pueden reactivar intenciones del motor anterior. */
  it("discards pending intentions on unmount and authoritative engine restart", async () => {
    const fake = fakeNative();
    const controller = new NativeAudioController(fake.api);
    let stop = controller.start();
    await settle();
    const firstGate = deferred<void>();
    fake.api.setMasterVolume.mockReturnValueOnce(firstGate.promise);
    const first = controller.setMasterVolume(0.1);
    void controller.setMasterVolume(0.9);
    stop();
    firstGate.resolve();
    await first;
    expect(fake.api.setMasterVolume).toHaveBeenCalledTimes(1);
    stop = controller.start();
    await settle();
    const secondGate = deferred<void>();
    fake.api.setMasterVolume.mockReturnValueOnce(secondGate.promise);
    const second = controller.setMasterVolume(0.2);
    void controller.setMasterVolume(0.8);
    fake.setStatus(
      nativeStatus({ engine_id: "00000000-0000-4000-8000-000000000002" }),
    );
    await controller.refresh();
    secondGate.resolve();
    await second;
    expect(fake.api.setMasterVolume.mock.calls).toEqual([[0.1], [0.2]]);
    stop();
  });

  it("subscribes before querying and preserves newer events against stale initial queries", async () => {
    vi.useFakeTimers();
    const fake = fakeNative();
    const installed = deferred<void>();
    fake.api.subscribeAudio.mockReturnValueOnce({
      ready: installed.promise,
      dispose: fake.dispose,
    });
    const controller = new NativeAudioController(fake.api);
    const stop = controller.start();
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.api.getAudioEngineStatus).not.toHaveBeenCalled();
    stop();
    installed.resolve();
    await settle();
    expect(fake.api.getAudioEngineStatus).not.toHaveBeenCalled();
    expect(fake.dispose).toHaveBeenCalledTimes(1);

    const query = deferred<ReturnType<typeof nativeStatus>>();
    fake.api.getAudioEngineStatus.mockReturnValueOnce(query.promise);
    const cleanup = controller.start();
    await settle();
    fake.emit(nativeStatus({ revision: 5, master_volume: 0.3 }));
    expect(controller.getSnapshot().status).toBeNull();
    query.resolve(nativeStatus({ revision: 1 }));
    await settle();
    expect(controller.getSnapshot().status?.revision).toBe(5);
    expect(controller.getSnapshot().status?.master_volume).toBe(0.3);
    cleanup();
  });

  it("rejects old revisions and gates engine changes on authoritative queries", async () => {
    const fake = fakeNative();
    const controller = new NativeAudioController(fake.api);
    const stop = controller.start();
    await settle();
    const oldQuery = deferred<ReturnType<typeof nativeStatus>>();
    fake.api.getAudioEngineStatus.mockReturnValueOnce(oldQuery.promise);
    const refresh = controller.refresh();
    fake.emit(nativeStatus({ revision: 10, master_volume: 0.1 }));
    oldQuery.resolve(nativeStatus({ revision: 2 }));
    await refresh;
    expect(controller.getSnapshot().status?.revision).toBe(10);

    const unconfirmed = deferred<ReturnType<typeof nativeStatus>>();
    fake.api.getAudioEngineStatus.mockReturnValueOnce(unconfirmed.promise);
    const unconfirmedRefresh = controller.refresh();
    await controller.refresh();
    unconfirmed.resolve(
      nativeStatus({ engine_id: "00000000-0000-4000-8000-000000000003" }),
    );
    await unconfirmedRefresh;
    expect(controller.getSnapshot().status?.revision).toBe(10);

    const engineB = nativeStatus({
      engine_id: "00000000-0000-4000-8000-000000000002",
      revision: 1,
    });
    fake.emit(engineB);
    expect(controller.getSnapshot().status?.engine_id).not.toBe(
      engineB.engine_id,
    );
    const staleA = deferred<ReturnType<typeof nativeStatus>>();
    fake.api.getAudioEngineStatus.mockReturnValueOnce(staleA.promise);
    const staleRefresh = controller.refresh();
    fake.setStatus(engineB);
    await controller.refresh();
    fake.emit(nativeStatus({ revision: 999 }));
    staleA.resolve(nativeStatus({ revision: 1000 }));
    await staleRefresh;
    expect(controller.getSnapshot().status).toEqual(engineB);
    stop();
  });

  it("recovers lost events by polling without re-enumerating or auto-selecting", async () => {
    vi.useFakeTimers();
    const fake = fakeNative();
    const controller = new NativeAudioController(fake.api);
    const stop = controller.start();
    await settle();
    fake.setStatus(nativeStatus({ revision: 2, master_volume: 0.25 }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(controller.getSnapshot().status?.master_volume).toBe(0.25);
    expect(fake.api.listOutputDevices).toHaveBeenCalledTimes(1);
    expect(fake.api.setOutputDevice).not.toHaveBeenCalled();
    stop();
    const count = fake.api.getAudioEngineStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(fake.api.getAudioEngineStatus).toHaveBeenCalledTimes(count);
  });

  it("keeps rapid restarts and STOP nonblocking without publishing optimistic voices or gains", async () => {
    const fake = fakeNative();
    const controller = new NativeAudioController(fake.api);
    const stop = controller.start();
    await settle();
    const play = deferred<string>();
    fake.api.restartEffect.mockReturnValue(play.promise);
    const p1 = controller.play("native-test-chime");
    const p2 = controller.play("native-test-chime");
    expect(fake.api.restartEffect).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().status?.active_playbacks).toEqual([]);
    const voices = ["other", "p2"].map((id) => ({
      playback_id: id,
      looped: false,
      state: "playing" as const,
      fade_out_ms: 0,
      effect_id: id === "other" ? "native-test-pulse" : "native-test-chime",
      volume: 0.5,
    }));
    fake.emit(nativeStatus({ revision: 1, active_playbacks: voices }));
    await controller.stopAll();
    expect(fake.api.stopAll).toHaveBeenCalledTimes(1);
    expect(fake.api.stopEffect).not.toHaveBeenCalled();
    play.resolve("p2");
    await Promise.all([p1, p2]);
    expect(controller.getSnapshot().status?.active_playbacks).toEqual(voices);
    const gain = deferred<void>();
    fake.api.setMasterVolume.mockReturnValueOnce(gain.promise);
    const firstGain = controller.setMasterVolume(0.2);
    const secondGain = controller.setMasterVolume(0.3);
    await settle();
    expect(controller.getSnapshot().status?.master_volume).toBe(0.7);
    expect(fake.api.setMasterVolume).toHaveBeenCalledTimes(1);
    await controller.stopAll();
    expect(fake.api.stopAll).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().status?.active_playbacks).toEqual(voices);
    gain.resolve();
    await Promise.all([firstGain, secondGain]);
    expect(fake.api.setMasterVolume.mock.calls).toEqual([[0.2]]);
    stop();
  });

  it("keeps the latest single target voice when restart ACKs events and queries arrive reversed", async () => {
    const fake = fakeNative();
    const controller = new NativeAudioController(fake.api);
    const stop = controller.start();
    await settle();
    await controller.play("native-test-pulse");
    const initial = await fake.api.getAudioEngineStatus();
    const restart = fake.api.restartEffect.getMockImplementation()!;
    const firstAck = deferred<string>();
    const secondAck = deferred<string>();
    let firstStatus = initial;
    let latestStatus = initial;
    fake.api.restartEffect
      .mockImplementationOnce(async (id, options) => {
        const playbackId = await restart(id, options);
        firstStatus = await fake.api.getAudioEngineStatus();
        await firstAck.promise;
        return playbackId;
      })
      .mockImplementationOnce(async (id, options) => {
        const playbackId = await restart(id, options);
        latestStatus = await fake.api.getAudioEngineStatus();
        await secondAck.promise;
        return playbackId;
      });
    const first = controller.play("native-test-chime");
    await settle();
    const second = controller.play("native-test-chime");
    await settle();
    expect(controller.getSnapshot().status).toEqual(initial);
    fake.emit(latestStatus);
    fake.emit(firstStatus);
    const staleQuery = deferred<ReturnType<typeof nativeStatus>>();
    fake.api.getAudioEngineStatus.mockReturnValueOnce(staleQuery.promise);
    firstAck.resolve("ack-1");
    await settle();
    secondAck.resolve("ack-2");
    await second;
    staleQuery.resolve(firstStatus);
    await first;
    expect(controller.getSnapshot().status).toEqual(latestStatus);
    expect(latestStatus.active_playbacks).toHaveLength(2);
    expect(latestStatus.active_playbacks[0]).toEqual(
      initial.active_playbacks[0],
    );
    expect(
      latestStatus.active_playbacks.filter(
        (voice) => voice.effect_id === "native-test-chime",
      ),
    ).toHaveLength(1);
    expect(latestStatus.active_playbacks[1].playback_id).not.toBe(
      firstStatus.active_playbacks[1].playback_id,
    );
    expect(fake.api.stopEffect).not.toHaveBeenCalled();
    expect(fake.api.playEffect).not.toHaveBeenCalled();
    expect(fake.api.playEffectWithOptions).not.toHaveBeenCalled();
    stop();
  });

  it("serializes route operations but never blocks urgent stops and reports restored output", async () => {
    const fake = fakeNative();
    const transition = deferred<DeviceSelectionResult>();
    const api = {
      ...fake.api,
      setOutputDevice: vi.fn(() => transition.promise),
    };
    const controller = new NativeAudioController(api);
    const stop = controller.start();
    await settle();
    const change = controller.selectDevice(output.id);
    expect(controller.getSnapshot().routeBusy).toBe(true);
    await controller.refreshDevices();
    await controller.selectDevice("another-token");
    await controller.play("native-test-low");
    await controller.stopAll();
    expect(api.setOutputDevice).toHaveBeenCalledTimes(1);
    expect(api.listOutputDevices).toHaveBeenCalledTimes(1);
    expect(api.restartEffect).not.toHaveBeenCalled();
    expect(api.stopAll).toHaveBeenCalledTimes(1);
    transition.resolve({
      status: nativeStatus({
        state: "ready",
        selected_device: output,
        revision: 2,
      }),
      restored_previous: true,
      error: { code: "device_open", message: "No se pudo abrir la salida" },
    });
    await change;
    expect(controller.getSnapshot().routeBusy).toBe(false);
    expect(controller.getSnapshot().selectionNotice).toContain("Se restauró");
    expect(controller.getSnapshot().error).toContain("No se pudo abrir");
    expect(controller.getSnapshot().status?.selected_device).toEqual(output);
    stop();
  });

  it("normalizes command failures and ignores unmounted or previous-session work", async () => {
    const fake = fakeNative();
    const controller = new NativeAudioController(fake.api);
    const stop = controller.start();
    await settle();
    fake.api.restartEffect.mockRejectedValueOnce({
      code: "queue_full",
      message: "Cola del motor llena",
    });
    await controller.play("native-test-chime");
    expect(controller.getSnapshot().error).toContain(
      "Cola del motor llena (queue_full)",
    );
    const query = deferred<ReturnType<typeof nativeStatus>>();
    fake.api.getAudioEngineStatus.mockReturnValueOnce(query.promise);
    const refresh = controller.refresh();
    stop();
    const newStop = controller.start();
    await settle();
    query.resolve(nativeStatus({ revision: 999 }));
    await refresh;
    expect(controller.getSnapshot().status?.revision).toBe(0);
    newStop();
    const view = controller.getSnapshot();
    fake.emit(nativeStatus({ revision: 1000 }));
    expect(controller.getSnapshot()).toBe(view);
  });
});
