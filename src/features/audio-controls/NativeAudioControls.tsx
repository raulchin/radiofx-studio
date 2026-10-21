import { useState, type FormEvent } from "react";
import type { useNativeAudio } from "./useNativeAudio";
import { fadeDurationSchema } from "../../shared/contracts/audio";

export type NativeAudio = ReturnType<typeof useNativeAudio>;

/**
 * Presenta controles y voces reales; limita las tarjetas de diagnóstico si se solicita.
 * @param props Motor, controlador raíz y preferencia de nombre sin selección automática.
 * @returns Panel nativo; en navegador no impide usar los bancos mock.
 */
export function NativeAudioControls({
  audio,
  diagnosticsOnly = false,
  preferredDeviceName,
}: {
  audio: NativeAudio;
  diagnosticsOnly?: boolean;
  preferredDeviceName?: string | null;
}) {
  const { status, controller, devices, routeBusy, error, selectionNotice } =
    audio;
  const [choice, setChoice] = useState("");
  const [fadeDuration, setFadeDuration] = useState("1000");
  const fade = fadeDuration.trim()
    ? fadeDurationSchema.safeParse(Number(fadeDuration))
    : null;
  const ready = status?.state === "ready" && !routeBusy;
  const selected = status?.selected_device;
  const preferredMatches = devices.filter(
    (device) => device.name === preferredDeviceName,
  );
  const validChoice = devices.some((device) => device.id === choice)
    ? choice
    : "";

  /**
   * Confirma el borrador completo sin alterar el límite autoritativo mostrado.
   * @param event Envío explícito por botón o Enter; las restricciones nativas validan el número.
   * @returns Nada; Rust confirma o rechaza el cambio mediante la instantánea.
   */
  function applyLimit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("limit");
    if (input instanceof HTMLInputElement && input.reportValidity()) {
      void controller.setLimit(input.valueAsNumber);
    }
  }

  return (
    <section className="native-panel" aria-labelledby="native-title">
      <div className="native-heading">
        <div>
          <p className="eyebrow">MOTOR RUST / SALIDA ÚNICA</p>
          <h2 id="native-title">
            {diagnosticsOnly
              ? "Audio nativo · biblioteca local"
              : "Audio nativo · señales de prueba"}
          </h2>
          <p className="muted text-sm">
            {diagnosticsOnly
              ? "Estado y voces reales del motor. Las señales de prueba quedan en el diagnóstico."
              : "Recursos precargados de Rust. Cada pulsación reinicia ese sonido; los demás siguen sonando. No son los botones mock ni archivos importados."}
          </p>
        </div>
        <div className="native-emergency">
          <button
            className="stop-button"
            type="button"
            onClick={() => void controller.stopAll()}
            disabled={!status}
          >
            STOP ALL · audio nativo
          </button>
          <span className="muted text-xs">
            Ctrl+Shift+Space · incluso con un diálogo abierto
          </span>
        </div>
      </div>
      <div className="native-strip" role="status" aria-live="polite">
        <strong>
          {!status
            ? "Audio nativo no disponible / conectando"
            : status.state === "ready"
              ? "Motor listo"
              : status.state === "device_error"
                ? "Error de dispositivo"
                : "Motor sin inicializar"}
        </strong>
        <span>
          {status?.state === "device_error" ? "Salida no disponible" : "Salida"}
          : {selected?.name ?? "ninguna seleccionada"}
        </span>
        <span>
          {status
            ? `${status.active_playbacks.length} / ${status.max_concurrent_playbacks} voces`
            : "Sin instantánea nativa"}
        </span>
      </div>
      {!status && (
        <p className="muted text-sm">
          En navegador, abre la aplicación de escritorio para usar audio. Los
          bancos mock siguen disponibles.
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {status?.last_error && (
        <p role="alert" className="error-message">
          Último error del motor: {status.last_error.message} (
          {status.last_error.code})
        </p>
      )}
      {selectionNotice && <p role="status">{selectionNotice}</p>}
      {preferredDeviceName && (
        <p role="status" className="muted">
          Preferencia guardada: {preferredDeviceName}.{" "}
          {preferredMatches.length === 1
            ? "Coincidencia única disponible; elígela y confirme con Seleccionar salida."
            : preferredMatches.length > 1
              ? "Nombre ambiguo: hay varios dispositivos; elige uno explícitamente y confirme."
              : "No se encuentra en la enumeración actual; actualiza o elige otra salida."}{" "}
          Según la última lectura de biblioteca; no acredita una salida activa.
        </p>
      )}
      <div className="native-routing">
        <label className="field">
          Dispositivo de salida nativo
          <select
            className="control"
            value={validChoice}
            disabled={!status || routeBusy}
            onChange={(event) => setChoice(event.currentTarget.value)}
          >
            <option value="">
              {selected
                ? `${status?.state === "device_error" ? "Salida no disponible" : "Salida activa actual"}: ${selected.name} · elige para cambiar`
                : "Elige una salida explícitamente"}
            </option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
                {device.is_default ? " (predeterminada)" : ""}
                {preferredMatches.length === 1 &&
                device.name === preferredDeviceName
                  ? " · preferencia guardada (confirmar)"
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          className="control primary"
          type="button"
          disabled={!validChoice || routeBusy || !status}
          onClick={() => {
            setChoice("");
            void controller.selectDevice(validChoice);
          }}
        >
          Seleccionar salida
        </button>
        <button
          className="control"
          type="button"
          disabled={!status || routeBusy}
          onClick={() => {
            setChoice("");
            void controller.refreshDevices();
          }}
        >
          {routeBusy ? "Actualizando salida..." : "Actualizar dispositivos"}
        </button>
        <button
          className="control"
          type="button"
          onClick={() => void controller.refresh()}
        >
          Consultar estado
        </button>
      </div>
      <p className="muted text-xs">
        Una sola salida. Cambiarla detiene las voces. No se selecciona ni
        redirige automáticamente. El nombre de una selección confirmada se
        guarda en escritorio.
      </p>
      <div className="native-levels">
        <label className="field">
          Volumen maestro nativo ·{" "}
          {status ? `${Math.round(status.master_volume * 100)}%` : "sin datos"}
          <input
            aria-label="Volumen maestro nativo"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={status?.master_volume ?? 0}
            disabled={!status || routeBusy}
            onChange={(event) =>
              void controller.setMasterVolume(event.currentTarget.valueAsNumber)
            }
          />
        </label>
        <form className="field" onSubmit={applyLimit}>
          <label className="field">
            Límite de voces nativas (1–64)
            <input
              key={`${status?.engine_id}:${status?.max_concurrent_playbacks}`}
              name="limit"
              type="number"
              required
              min="1"
              max="64"
              step="1"
              defaultValue={status?.max_concurrent_playbacks ?? ""}
              disabled={!status || routeBusy}
            />
          </label>
          <p className="muted text-xs">
            Borrador; límite confirmado por Rust:{" "}
            {status?.max_concurrent_playbacks ?? "sin datos"}.
          </p>
          <button
            className="control"
            type="submit"
            disabled={!status || routeBusy}
          >
            Aplicar límite
          </button>
        </form>
      </div>
      <div className="native-effects">
        {status?.effects
          .filter(
            (effect) =>
              !diagnosticsOnly || effect.effect_id.startsWith("native-test-"),
          )
          .map((effect) => (
            <article className="native-effect" key={effect.effect_id}>
              <span className="eyebrow">
                SEÑAL RUST / {effect.duration_ms} ms
              </span>
              <h3>{effect.name}</h3>
              <button
                className="control primary"
                type="button"
                disabled={!ready}
                onClick={() => void controller.play(effect.effect_id)}
              >
                Disparar {effect.name}
              </button>
              <label className="field">
                Volumen por defecto · {Math.round(effect.default_volume * 100)}%
                <input
                  aria-label={`Volumen por defecto de ${effect.name}`}
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={effect.default_volume}
                  disabled={!status || routeBusy}
                  onChange={(event) =>
                    void controller.setEffectVolume(
                      effect.effect_id,
                      event.currentTarget.valueAsNumber,
                    )
                  }
                />
              </label>
              <span className="muted text-xs">
                Solo futuras voces; no altera las instancias activas.
              </span>
              <button
                className="control"
                type="button"
                disabled={!status}
                onClick={() => void controller.stopEffect(effect.effect_id)}
              >
                Detener todas de {effect.name}
              </button>
            </article>
          ))}
      </div>
      <div className="native-playbacks">
        <h3>Instancias activas · Rust</h3>
        <label className="field">
          Duración de fade alternativa (ms)
          <input
            type="number"
            min="0"
            max="30000"
            step="1"
            required
            value={fadeDuration}
            onChange={(event) => setFadeDuration(event.currentTarget.value)}
          />
        </label>
        {(!fade || !fade.success) && (
          <p role="alert">La duración debe ser un entero entre 0 y 30000 ms.</p>
        )}
        <p className="muted text-xs">
          Desactivar bucle termina la vuelta actual. Repetir una salida gradual
          no la prolonga. STOP y Detener siempre son inmediatos; un fade de 0 ms
          también.
        </p>
        {status?.active_playbacks.length ? (
          <ul>
            {status.active_playbacks.map((playback) => (
              <li key={playback.playback_id}>
                <div>
                  <strong>
                    {status.effects.find(
                      (effect) => effect.effect_id === playback.effect_id,
                    )?.name ?? playback.effect_id}
                  </strong>
                  <code>{playback.playback_id}</code>
                </div>
                <p role="status">
                  {playback.state === "fading_out"
                    ? "Finalizando: salida gradual en curso"
                    : playback.looped
                      ? "Bucle activo"
                      : "Reproducción simple / última vuelta"}
                </p>
                <button
                  className="control"
                  type="button"
                  disabled={routeBusy || playback.state === "fading_out"}
                  onClick={() =>
                    void controller.setPlaybackLoop(
                      playback.playback_id,
                      !playback.looped,
                    )
                  }
                >
                  {playback.looped
                    ? "Terminar al acabar la vuelta"
                    : "Activar bucle"}{" "}
                  · {playback.playback_id}
                </button>
                <button
                  className="control"
                  type="button"
                  disabled={routeBusy || playback.state === "fading_out"}
                  onClick={() =>
                    void controller.fadeOutPlayback(
                      playback.playback_id,
                      playback.fade_out_ms,
                    )
                  }
                >
                  {playback.fade_out_ms === 0
                    ? "Salida inmediata (0 ms)"
                    : `Salida gradual (${playback.fade_out_ms} ms)`}{" "}
                  · {playback.playback_id}
                </button>
                <button
                  className="control"
                  type="button"
                  disabled={
                    routeBusy ||
                    playback.state === "fading_out" ||
                    !fade?.success
                  }
                  onClick={() => {
                    if (fade?.success)
                      void controller.fadeOutPlayback(
                        playback.playback_id,
                        fade.data,
                      );
                  }}
                >
                  Aplicar fade alternativo · {playback.playback_id}
                </button>
                <label className="field">
                  Volumen de instancia · {Math.round(playback.volume * 100)}%
                  <input
                    aria-label={`Volumen de instancia ${playback.playback_id}`}
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={playback.volume}
                    disabled={routeBusy}
                    onChange={(event) =>
                      void controller.setPlaybackVolume(
                        playback.playback_id,
                        event.currentTarget.valueAsNumber,
                      )
                    }
                  />
                </label>
                <button
                  className="control destructive"
                  type="button"
                  onClick={() =>
                    void controller.stopPlayback(playback.playback_id)
                  }
                >
                  Detener instancia {playback.playback_id}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted text-sm">
            {status
              ? "Sin reproducciones nativas activas."
              : "Esperando el estado de Rust."}
          </p>
        )}
      </div>
    </section>
  );
}
