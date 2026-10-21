import { useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { z } from "zod";
import type { SoundBank } from "../sound-banks/models";
import { buttonColorSchema, type SoundButton } from "../sound-library/models";
import {
  boardStore,
  demoStateSchema,
  type BoardState,
  type createBoardStore,
} from "./store";

export type BoardStore = ReturnType<typeof createBoardStore>;
export type BoardDialog =
  | { kind: "button"; bankId: string; button?: SoundButton }
  | { kind: "bank"; bank?: SoundBank }
  | { kind: "banks" }
  | { kind: "delete-button"; bankId: string; button: SoundButton }
  | { kind: "delete-bank"; bank: SoundBank }
  | { kind: "settings" };

/**
 * Coordina formularios y operaciones mock sin introducir reglas en la vista.
 * @param store Estado aislable para la aplicación o para pruebas.
 * @returns Estado visual y manejadores de edición, selección y errores.
 */
export function useSoundboard(store: BoardStore = boardStore) {
  const state = useStore(store);
  const [dialog, setDialog] = useState<BoardDialog | null>(null);
  const [error, setError] = useState("");
  const activeBank =
    state.banks.find((bank) => bank.id === state.activeBankId) ??
    state.banks[0];

  /**
   * Traduce errores de validación al estado visible de la interfaz.
   * @param operation Acción síncrona ya validada por su servicio o store.
   * @param close Indica si se cierra el diálogo tras una operación correcta.
   */
  function run(operation: () => void, close = false): void {
    try {
      operation();
      setError("");
      if (close) setDialog(null);
    } catch (cause) {
      setError(
        cause instanceof z.ZodError
          ? (cause.issues[0]?.message ?? "Revisa los datos del formulario.")
          : cause instanceof Error
            ? cause.message
            : "No se pudo completar la operación.",
      );
    }
  }

  /** @param next Diálogo que se abre, sin conservar errores anteriores. */
  function openDialog(next: BoardDialog): void {
    setError("");
    setDialog(next);
  }

  /** Cierra el editor sin guardar los cambios de formulario. */
  function closeDialog(): void {
    setDialog(null);
    setError("");
  }

  /**
   * Envía los metadatos editados al store mock y aplica el estado demo separado.
   * @param event Envío del formulario de botón.
   */
  function saveButton(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (dialog?.kind !== "button") return;
    const data = new FormData(event.currentTarget);
    run(() => {
      const draft = {
        name: String(data.get("name") ?? ""),
        category: String(data.get("category") ?? ""),
        durationMs: Math.round(Number(data.get("duration")) * 1000),
        color: buttonColorSchema.parse(data.get("color")),
      };
      const demoState = demoStateSchema.parse(data.get("demoState"));
      const id = dialog.button?.id ?? state.addButton(dialog.bankId, draft);
      if (dialog.button) state.updateButton(dialog.bankId, id, draft);
      state.setDemoState(id, demoState);
    }, true);
  }

  /** @param event Envío del nombre de un banco nuevo o existente. */
  function saveBank(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (dialog?.kind !== "bank") return;
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    run(() => {
      if (dialog.bank) state.renameBank(dialog.bank.id, name);
      else state.createBank(name);
    }, true);
  }

  /** Confirma únicamente la eliminación que se muestra en el diálogo activo. */
  function confirmDelete(): void {
    run(() => {
      if (dialog?.kind === "delete-button")
        state.deleteButton(dialog.bankId, dialog.button.id);
      if (dialog?.kind === "delete-bank") state.deleteBank(dialog.bank.id);
    }, true);
  }

  /** @param id Banco existente seleccionado en la barra o las pestañas. */
  function selectBank(id: string): void {
    run(() => state.selectBank(id));
  }
  /** @param id Botón para mostrar un estado demo, nunca para reproducir audio. */
  function previewButton(id: string): void {
    run(() => state.previewButton(id));
  }
  /** @param id Banco movido. @param direction Paso relativo en la lista. */
  function moveBank(id: string, direction: -1 | 1): void {
    run(() => state.moveBank(id, direction));
  }
  /** @param id Botón movido. @param direction Paso relativo dentro del banco activo. */
  function nudgeButton(id: string, direction: -1 | 1): void {
    run(() => state.nudgeButton(activeBank.id, id, direction));
  }
  /** @param sourceId Botón arrastrado. @param targetId Botón de la posición de destino. */
  function dropButton(sourceId: string, targetId: string): void {
    run(() => state.moveButton(activeBank.id, sourceId, targetId));
  }
  /** @param columns Distribución seleccionada, validada por el store. */
  function setColumns(columns: BoardState["columns"]): void {
    run(() => state.setColumns(columns));
  }
  /** @param value Porcentaje visual sin efecto sobre el motor. */
  function setMasterVolume(value: number): void {
    run(() => state.setMasterVolume(value));
  }
  /** Restablece la demostración de todos los bancos, sin invocar audio nativo. */
  function stopAll(): void {
    run(state.stopAll);
  }

  return {
    state,
    activeBank,
    dialog,
    error,
    openDialog,
    closeDialog,
    saveButton,
    saveBank,
    confirmDelete,
    selectBank,
    previewButton,
    moveBank,
    nudgeButton,
    dropButton,
    setColumns,
    setMasterVolume,
    stopAll,
  };
}
