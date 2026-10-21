import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onEmergencyStop?: () => void;
}

/**
 * Abre un diálogo nativo con foco contenido, Escape y restauración del foco.
 * @param props Título, contenido y cierre del diálogo.
 * @returns Superficie modal accesible.
 */
export function Modal({
  title,
  children,
  onClose,
  onEmergencyStop,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  /** @returns Limpieza que cierra el diálogo y restaura el foco al invocador. */
  function openDialog() {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    /** Cierra el modal al desmontarlo, sin desplazar la página. */
    function restoreFocus() {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      } else {
        document.getElementById("board-title")?.focus({ preventScroll: true });
      }
    }
    return restoreFocus;
  }

  useEffect(openDialog, []);

  /**
   * Cierra el ciclo de tabulación incluso en WebViews con foco modal incompleto.
   * @param event Pulsación dentro del diálogo; Escape conserva su acción nativa.
   */
  function containTabFocus(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key !== "Tab") return;
    const controls = event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
    );
    const first = controls[0];
    const last = controls[controls.length - 1];
    const target = event.shiftKey
      ? document.activeElement === first
        ? last
        : null
      : document.activeElement === last
        ? first
        : null;
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      onCancel={onClose}
      onKeyDown={containTabFocus}
      className="modal"
    >
      <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <p className="eyebrow">RADIOFX / ESPACIO DE TRABAJO</p>
          <h2 id="modal-title" className="mt-2 text-2xl font-semibold">
            {title}
          </h2>
        </div>
        <button
          type="button"
          className="control"
          onClick={onClose}
          aria-label="Cerrar diálogo"
        >
          ×
        </button>
      </div>
      <div className="pt-5">{children}</div>
      {onEmergencyStop && (
        <button
          type="button"
          className="stop-button mt-5"
          onClick={onEmergencyStop}
        >
          STOP ALL · emergencia
        </button>
      )}
    </dialog>
  );
}
