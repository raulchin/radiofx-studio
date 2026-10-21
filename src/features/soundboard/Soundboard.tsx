import type { DragEvent } from "react";
import type { SoundBank } from "../sound-banks/models";
import type { SoundButton } from "../sound-library/models";
import type { BoardState, DemoState } from "./store";
import { formatDuration, stateLabels } from "./presentation";

interface SoundboardProps {
  bank: SoundBank;
  demoStates: Record<string, DemoState>;
  columns: BoardState["columns"];
  onPreview: (id: string) => void;
  onEdit: (button: SoundButton) => void;
  onDelete: (button: SoundButton) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onDrop: (sourceId: string, targetId: string) => void;
  onAdd: () => void;
  nativeStates?: Record<
    string,
    { label: string; playable: boolean; count: number }
  >;
  onStopEffect?: (effectId: string) => void;
  editingDisabled?: boolean;
  orderingDisabled?: boolean;
  filtered?: boolean;
  onTransfer?: (button: SoundButton) => void;
}

const dragType = "application/x-radiofx-button";

/**
 * Presenta asignaciones con arrastre y alternativa por teclado o táctil.
 * @param props Banco, estados demo o derivados de Rust y acciones del controlador.
 * @returns Cuadrícula adaptable o estado vacío del banco.
 */
export function Soundboard({
  bank,
  demoStates,
  columns,
  onPreview,
  onEdit,
  onDelete,
  onMove,
  onDrop,
  onAdd,
  nativeStates,
  onStopEffect,
  editingDisabled = false,
  orderingDisabled = false,
  filtered = false,
  onTransfer,
}: SoundboardProps) {
  /** @param event Inicio del arrastre. @param id Identificador del botón de origen. */
  function startDrag(event: DragEvent<HTMLElement>, id: string): void {
    if (editingDisabled || orderingDisabled) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(dragType, id);
    event.dataTransfer.effectAllowed = "move";
  }
  /** @param event Arrastre sobre un destino que acepta botones de la paleta. */
  function allowDrop(event: DragEvent<HTMLElement>): void {
    if (
      !editingDisabled &&
      !orderingDisabled &&
      event.dataTransfer.types.includes(dragType)
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  }
  /** @param event Botón soltado. @param targetId Posición final solicitada. */
  function finishDrop(event: DragEvent<HTMLElement>, targetId: string): void {
    event.preventDefault();
    if (editingDisabled || orderingDisabled) return;
    const source = event.dataTransfer.getData(dragType);
    if (source) onDrop(source, targetId);
  }

  if (bank.buttons.length === 0)
    return (
      <div className="empty-board">
        <span aria-hidden="true" className="empty-symbol">
          +
        </span>
        <h3 className="text-xl font-semibold">
          {filtered ? "Sin resultados" : "Este banco está por estrenar"}
        </h3>
        <p className="muted mt-2">
          {filtered
            ? "Prueba otra búsqueda. El orden guardado no ha cambiado."
            : "Añade el primer botón para preparar tu próxima sesión."}
        </p>
        {!filtered && (
          <button
            type="button"
            className="control primary mt-6"
            onClick={onAdd}
            disabled={editingDisabled}
          >
            Agregar primer botón
          </button>
        )}
      </div>
    );

  return (
    <ol
      aria-label={`Efectos de ${bank.name}`}
      className={`sound-grid columns-${columns}`}
    >
      {bank.buttons.map((button, index) => {
        const native = nativeStates?.[button.id];
        const status = native
          ? native.count > 0
            ? "playing"
            : native.playable
              ? "available"
              : "error"
          : (demoStates[button.id] ?? "available");
        return (
          <li
            key={button.id}
            className={`sound-card tone-${button.color} state-${status}`}
            onDragOver={allowDrop}
            onDrop={(event) => finishDrop(event, button.id)}
          >
            <div className="pad-heading">
              <span className="pad-position">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="truncate text-xs">{button.category}</span>
              <span
                draggable={!editingDisabled && !orderingDisabled}
                onDragStart={(event) => startDrag(event, button.id)}
                className="drag-handle"
                title="Arrastra para reordenar; también puedes usar los botones de posición"
                aria-hidden="true"
              >
                ⠿
              </span>
            </div>
            <button
              type="button"
              className="sound-trigger"
              onClick={() => onPreview(button.id)}
              aria-label={`${nativeStates ? "Disparar" : "Demostrar"} ${button.name}`}
              disabled={nativeStates !== undefined && !native?.playable}
              aria-pressed={nativeStates ? undefined : status === "playing"}
              aria-describedby={`state-${button.id}`}
            >
              <span className="pad-name">{button.name}</span>
              <span className="pad-bottom">
                <span className="pad-time">
                  {formatDuration(button.durationMs)}
                </span>
                <span className="pad-state" id={`state-${button.id}`}>
                  <span className="state-dot" aria-hidden="true" />
                  {native?.label ?? stateLabels[status]}
                </span>
              </span>
            </button>
            <div className="pad-tools">
              {onStopEffect && button.effectId && (
                <button
                  type="button"
                  aria-label={`Detener todas de ${button.name}`}
                  onClick={() => {
                    if (button.effectId) onStopEffect(button.effectId);
                  }}
                >
                  Detener
                </button>
              )}
              <button
                type="button"
                aria-label={`Mover ${button.name} antes`}
                disabled={editingDisabled || orderingDisabled || index === 0}
                onClick={() => onMove(button.id, -1)}
              >
                ←
              </button>
              <button
                type="button"
                aria-label={`Mover ${button.name} después`}
                disabled={
                  editingDisabled ||
                  orderingDisabled ||
                  index === bank.buttons.length - 1
                }
                onClick={() => onMove(button.id, 1)}
              >
                →
              </button>
              <button
                type="button"
                className="ml-auto"
                aria-label={`Editar ${button.name}`}
                disabled={editingDisabled}
                onClick={() => onEdit(button)}
              >
                Editar
              </button>
              {onTransfer && (
                <button
                  type="button"
                  disabled={editingDisabled}
                  aria-label={`Mover o copiar ${button.name}`}
                  onClick={() => onTransfer(button)}
                >
                  Mover / copiar
                </button>
              )}
              <button
                type="button"
                aria-label={`Eliminar ${button.name}`}
                disabled={editingDisabled}
                onClick={() => onDelete(button)}
              >
                Eliminar
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
