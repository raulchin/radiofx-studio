import { useId, type ChangeEvent } from "react";

export interface AudioControlsProps {
  masterVolume: number;
  activeDemoCount: number;
  effectCount: number;
  /**
   * Solicita un volumen exclusivamente visual.
   * @param value Porcentaje entero entre 0 y 100.
   * @returns Nada; el propietario actualiza el estado de demo.
   */
  onVolumeChange: (value: number) => void;
  /**
   * Solicita restablecer los estados de demo sin detener audio real.
   * @returns Nada; el propietario restablece la demostración.
   */
  onStopAll: () => void;
}

/**
 * Presenta controles y contadores de demostración sin conectar un motor de audio.
 * @param props Volumen porcentual, contadores visuales y callbacks de la demo.
 * @returns Pie adaptable con volumen y restablecimiento accesibles por teclado.
 */
export function AudioControls({
  masterVolume,
  activeDemoCount,
  effectCount,
  onVolumeChange,
  onStopAll,
}: AudioControlsProps) {
  const id = useId();

  /**
   * Comunica el porcentaje elegido sin modificar ningún recurso de audio.
   * @param event Cambio del control nativo de volumen visual.
   * @returns Nada; delega la actualización al propietario.
   */
  function handleVolumeChange(event: ChangeEvent<HTMLInputElement>): void {
    onVolumeChange(event.currentTarget.valueAsNumber);
  }

  return (
    <footer className="transport">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div className="volume-control">
          <label htmlFor={`${id}-volume`}>Volumen maestro (demo)</label>
          <input
            id={`${id}-volume`}
            className="control max-w-full accent-amber-300"
            type="range"
            min={0}
            max={100}
            step={1}
            value={masterVolume}
            onChange={handleVolumeChange}
            aria-describedby={`${id}-notice`}
          />
          <output htmlFor={`${id}-volume`} className="tabular-nums">
            {masterVolume}%
          </output>
        </div>
        <button
          type="button"
          className="control flex flex-col items-center gap-1 px-6 py-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200"
          onClick={onStopAll}
        >
          <span className="text-sm">Restablecer demo</span>
        </button>
      </div>
      <div className="muted mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <span>
          {effectCount} {effectCount === 1 ? "efecto" : "efectos"} en este banco
        </span>
        <span>
          {activeDemoCount}{" "}
          {activeDemoCount === 1 ? "botón activo" : "botones activos"} en demo
        </span>
        <span>Demo visual, no representa motor nativo</span>
      </div>
      <p id={`${id}-notice`} className="muted mt-3 text-sm">
        Controles mock: solo modifican la demostración visual, no controlan
        audio.
      </p>
    </footer>
  );
}
