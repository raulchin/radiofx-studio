import type { ButtonColor } from "../sound-library/models";
import type { DemoState } from "./store";

export const colorLabels: Record<ButtonColor, string> = {
  amber: "Ámbar",
  coral: "Coral",
  mint: "Menta",
  sky: "Cielo",
  violet: "Violeta",
  slate: "Pizarra",
};

export const stateLabels: Record<DemoState, string> = {
  available: "Disponible",
  playing: "Reproduciendo · demo",
  paused: "Pausado · demo",
  error: "Error · demo",
};

/**
 * Formatea la duración declarada de un recurso mock con precisión de décimas.
 * @param durationMs Duración no negativa en milisegundos.
 * @returns Tiempo en minutos y segundos, sin implicar audio cargado.
 */
export function formatDuration(durationMs: number): string {
  const tenths = Math.floor(durationMs / 100);
  return `${Math.floor(tenths / 600)
    .toString()
    .padStart(2, "0")}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}
