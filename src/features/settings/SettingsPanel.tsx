import { useId, useState, type ChangeEvent } from "react";
import { getAudioEngineStatus } from "../../shared/adapters/audio";
import { columnsSchema } from "../soundboard/store";

export interface SettingsPanelProps {
  columns: "auto" | "3" | "4" | "6";
  /**
   * Solicita una distribución validada sin persistirla en este componente.
   * @param value Distribución permitida de la cuadrícula.
   * @returns Nada; el propietario actualiza el estado visual.
   */
  onColumnsChange: (value: "auto" | "3" | "4" | "6") => void;
}

/**
 * Presenta ajustes visuales de demo y el diagnóstico nativo sin iniciar audio.
 * @param props Distribución controlada y callback de actualización.
 * @returns Panel accesible de ajustes y estado del backend.
 */
export function SettingsPanel({
  columns,
  onColumnsChange,
}: SettingsPanelProps) {
  const id = useId();
  const [connection, setConnection] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [message, setMessage] = useState(
    "Diagnóstico manual pendiente; el panel nativo muestra el estado de la sesión.",
  );

  /**
   * Valida la selección antes de notificar un cambio de distribución visual.
   * @param event Cambio del selector de columnas.
   * @returns Nada; ignora valores no admitidos por el esquema.
   */
  function handleColumnsChange(event: ChangeEvent<HTMLSelectElement>): void {
    const result = columnsSchema.safeParse(event.currentTarget.value);
    if (result.success) onColumnsChange(result.data);
  }

  /**
   * Comprueba el contrato IPC sin simular dispositivos o reproducciones.
   * @returns Promesa resuelta al mostrar el resultado o un error visible.
   */
  async function checkBackend(): Promise<void> {
    setConnection("loading");
    setMessage("Consultando el estado de Rust...");
    try {
      const status = await getAudioEngineStatus();
      setConnection("ready");
      setMessage(
        `Backend conectado. Motor: ${status.state === "ready" ? "listo" : status.state === "device_error" ? "error de dispositivo" : "sin inicializar"}. Salida: ${status.selected_device?.name ?? "ninguna"}. Instancias activas: ${status.active_playbacks.length}. Volumen maestro: ${Math.round(status.master_volume * 100)}%.${status.last_error ? ` Último error: ${status.last_error.message}` : ""}`,
      );
    } catch {
      setConnection("error");
      setMessage(
        "No se pudo verificar el backend. Abre la aplicación de escritorio y vuelve a intentarlo.",
      );
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="eyebrow">
          Ajustes de la demo
        </h2>
        <span className="muted text-sm">
          Bancos mock / diagnóstico real de Rust
        </span>
      </div>
      <div className="field flex flex-col gap-2">
        <label htmlFor={`${id}-columns`}>Distribución de la cuadrícula</label>
        <select
          id={`${id}-columns`}
          className="control"
          value={columns}
          onChange={handleColumnsChange}
          aria-describedby={`${id}-notice`}
        >
          <option value="auto">Automática</option>
          <option value="3">3 columnas</option>
          <option value="4">4 columnas</option>
          <option value="6">6 columnas</option>
        </select>
      </div>
      <p id={`${id}-notice`} className="muted text-sm">
        Ajustes mock de demostración: la distribución no se persiste. Estos
        controles no reproducen audio.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          className="control disabled:cursor-wait disabled:opacity-60"
          onClick={checkBackend}
          disabled={connection === "loading"}
          aria-describedby={`${id}-backend-status`}
        >
          {connection === "loading"
            ? "Comprobando..."
            : "Comprobar backend nativo"}
        </button>
        <p
          id={`${id}-backend-status`}
          role="status"
          aria-live="polite"
          className="muted min-w-0 text-sm"
        >
          {message}
        </p>
      </div>
    </section>
  );
}
