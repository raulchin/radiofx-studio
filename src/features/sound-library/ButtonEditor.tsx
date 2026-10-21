import { useState, type FormEvent } from "react";
import type { LibraryEffect } from "../../shared/contracts/library";
import { buttonColorSchema, type SoundButton } from "./models";
import { colorLabels, stateLabels } from "../soundboard/presentation";
import { demoStateSchema, type DemoState } from "../soundboard/store";

interface ButtonEditorProps {
  button?: SoundButton;
  demoState?: DemoState;
  effects?: LibraryEffect[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}

/**
 * Edita metadatos y, en escritorio, una referencia al catálogo confirmado.
 * @param props Datos iniciales y acciones de envío y cancelación.
 * @returns Formulario sin acceso a archivos; duración y estados mock solo en demo.
 */
export function ButtonEditor({
  button,
  demoState = "available",
  effects,
  onSubmit,
  onCancel,
}: ButtonEditorProps) {
  const [effectId, setEffectId] = useState(button?.effectId ?? "");
  const effect = effects?.find((item) => item.id === effectId);
  const [looped, setLooped] = useState(button?.playback?.looped ?? false);
  const [fadeInDraft, setFadeIn] = useState(
    String(button?.playback?.fadeInMs ?? 0),
  );
  const [fadeOutDraft, setFadeOut] = useState(
    String(button?.playback?.fadeOutMs ?? 0),
  );
  const fadeIn = Number(fadeInDraft);
  const fadeOut = Number(fadeOutDraft);
  const invalidPlayback =
    !!effects &&
    (!fadeInDraft.trim() ||
      !fadeOutDraft.trim() ||
      !Number.isInteger(fadeIn) ||
      !Number.isInteger(fadeOut) ||
      fadeIn < 0 ||
      fadeOut < 0 ||
      fadeIn > 30000 ||
      fadeOut > 30000 ||
      (!looped && fadeIn + fadeOut > (effect?.durationMs ?? 0)));
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <p className="muted">
        {effects
          ? "Asigna un recurso de la biblioteca local. La duración procede del catálogo; no se modifica manualmente."
          : "Metadatos de demostración. No se importa ni se asocia ningún archivo de audio."}
      </p>
      {effects && (
        <label className="field">
          Archivo de la biblioteca
          <select
            name="effectId"
            aria-label="Archivo de la biblioteca"
            value={effectId}
            onChange={(event) => setEffectId(event.currentTarget.value)}
          >
            <option value="">Sin audio asignado</option>
            {effects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ·{" "}
                {item.availability === "available"
                  ? "disponible"
                  : item.availability === "missing"
                    ? "ausente"
                    : "inválido"}
              </option>
            ))}
          </select>
          <span>Duración del catálogo: {effect?.durationMs ?? 0} ms</span>
        </label>
      )}
      <label className="field">
        Nombre del efecto
        <input
          name="name"
          required
          maxLength={100}
          defaultValue={button?.name ?? ""}
          placeholder="Por ejemplo, cortinilla de cierre"
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">
          Categoría
          <input
            name="category"
            required={!effects}
            maxLength={effects ? 80 : 60}
            defaultValue={button?.category ?? "General"}
          />
        </label>
        {!effects && (
          <label className="field">
            Duración mock (segundos)
            <input
              name="duration"
              type="number"
              min="0"
              step="0.001"
              required
              defaultValue={(button?.durationMs ?? 1000) / 1000}
            />
          </label>
        )}
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Color del botón</legend>
        <div className="color-options">
          {buttonColorSchema.options.map((color) => (
            <label key={color} className={`color-option tone-${color}`}>
              <input
                type="radio"
                name="color"
                value={color}
                defaultChecked={color === (button?.color ?? "amber")}
                required
              />
              <span>{colorLabels[color]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {effects && (
        <fieldset className="space-y-5">
          <legend>Reproducción del botón</legend>
          <label>
            <input
              name="looped"
              type="checkbox"
              checked={looped}
              onChange={(event) => setLooped(event.currentTarget.checked)}
            />{" "}
            Repetir en bucle
          </label>
          <label className="field">
            Entrada gradual (ms)
            <input
              name="fadeInMs"
              type="number"
              min="0"
              max="30000"
              step="1"
              required
              value={fadeInDraft}
              onChange={(event) => setFadeIn(event.currentTarget.value)}
            />
          </label>
          <label className="field">
            Salida gradual por defecto (ms)
            <input
              name="fadeOutMs"
              type="number"
              min="0"
              max="30000"
              step="1"
              required
              value={fadeOutDraft}
              onChange={(event) => setFadeOut(event.currentTarget.value)}
            />
          </label>
          <p className="muted">
            La entrada se aplica una sola vez. En reproducción simple, la suma
            de fades no puede superar la duración del catálogo. Cero significa
            inmediato. STOP siempre es inmediato.
          </p>
          {invalidPlayback && (
            <p role="alert">
              Fades inválidos: enteros entre 0 y 30000 ms; sin bucle deben caber
              en la duración del catálogo.
            </p>
          )}
        </fieldset>
      )}
      {!effects && (
        <label className="field">
          Estado visual (mock)
          <select name="demoState" defaultValue={demoState}>
            {demoStateSchema.options.map((state) => (
              <option key={state} value={state}>
                {stateLabels[state]}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="dialog-actions">
        <button type="button" className="control" onClick={onCancel}>
          Cancelar
        </button>
        <button
          type="submit"
          className="control primary"
          disabled={invalidPlayback}
        >
          {button ? "Guardar cambios" : "Crear botón"}
        </button>
      </div>
    </form>
  );
}
