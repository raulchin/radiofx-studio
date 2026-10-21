import type {
  LibrarySnapshot,
  ImportResult,
} from "../../shared/contracts/library";
import type { NativeAudio } from "../audio-controls/NativeAudioControls";
import { useState } from "react";
import { normalizeSearch } from "../../shared/search";

/** @param props Catálogo confirmado, importación parcial y motor único. @returns Biblioteca sin acceso a rutas ni reproducción web. */
export function LibraryPanel({
  snapshot,
  imported,
  busy,
  audio,
  onImport,
  onRefresh,
}: {
  snapshot: LibrarySnapshot;
  imported: ImportResult | null;
  busy: boolean;
  audio: NativeAudio;
  onImport: () => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const effects = snapshot.effects.filter((effect) =>
    normalizeSearch(effect.name).includes(normalizeSearch(query)),
  );
  return (
    <section className="native-panel" aria-labelledby="library-title">
      <div className="native-heading">
        <div>
          <p className="eyebrow">ARCHIVOS LOCALES / SQLITE</p>
          <h2 id="library-title">Biblioteca de sonidos</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="control primary"
            disabled={busy}
            onClick={onImport}
          >
            Importar audio
          </button>
          <button className="control" disabled={busy} onClick={onRefresh}>
            Actualizar biblioteca
          </button>
        </div>
      </div>
      <p className="muted text-sm">
        WAV, MP3, OGG y FLAC. Copias gestionadas localmente; los originales no
        se eliminan. Máximo 32 MiB de archivo y PCM, 120 segundos, mono/estéreo,
        8–192 kHz. Caché total 128 MiB con 32 MiB reservados para salida.
      </p>
      {imported && (
        <div role="status" aria-live="polite">
          <p>
            {imported.cancelled
              ? "Importación cancelada. No se modificó la biblioteca."
              : `Importación: ${imported.imported.filter((item) => !item.duplicate).length} nuevos, ${imported.imported.filter((item) => item.duplicate).length} duplicados, ${imported.failed.length} fallidos.`}
          </p>
          <ul>
            {imported.imported.map((item, index) => (
              <li key={`${item.effect.id}-${index}`}>
                {item.effect.name}:{" "}
                {item.duplicate
                  ? item.effect.availability === "available"
                    ? "duplicado: recurso disponible; se conserva su identidad"
                    : "duplicado: recurso no disponible; se conserva su identidad"
                  : "importado"}
              </li>
            ))}
            {imported.failed.map((item, index) => (
              <li key={index} className="error-message">
                {item.name}: {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="field">
        Buscar en la biblioteca
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      {!!snapshot.effects.length && !effects.length && (
        <p role="status">Sin resultados en la biblioteca.</p>
      )}
      {!snapshot.effects.length && (
        <p className="muted">
          Sin archivos importados. Importa audio y asígnalo a un botón.
        </p>
      )}
      <ul className="native-effects">
        {effects.map((effect) => {
          const nativeEffect = audio.status?.effects.find(
            (item) => item.effect_id === effect.id,
          );
          return (
            <li key={effect.id} className="native-effect">
              <h3>{effect.name}</h3>
              <p>
                {effect.format.toUpperCase()} · {effect.durationMs} ms ·{" "}
                {effect.sampleRate} Hz · {effect.channels} canales ·{" "}
                {effect.byteSize} bytes
              </p>
              <p
                className={
                  effect.availability === "available"
                    ? "muted"
                    : "error-message"
                }
              >
                {effect.availability === "available"
                  ? "Disponible"
                  : effect.availability === "missing"
                    ? "Archivo ausente"
                    : "Archivo inválido"}
                {effect.error ? `: ${effect.error}` : ""}
              </p>
              <label className="field">
                Volumen por defecto ·{" "}
                {nativeEffect
                  ? `${Math.round(nativeEffect.default_volume * 100)}%`
                  : "sin estado nativo"}
                <input
                  type="range"
                  aria-label={`Volumen por defecto de ${effect.name}`}
                  min="0"
                  max="1"
                  step="0.01"
                  disabled={!nativeEffect || audio.routeBusy}
                  value={nativeEffect?.default_volume ?? 0}
                  onChange={(event) =>
                    void audio.controller.setEffectVolume(
                      effect.id,
                      event.currentTarget.valueAsNumber,
                    )
                  }
                />
              </label>
              <p className="muted text-xs">
                Solo futuras voces; confirmado y guardado por Rust.
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
