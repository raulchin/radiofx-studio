import { useState, type FormEvent } from "react";
import type { PersistentBoard } from "../../shared/contracts/library";
import {
  chordLabel,
  shortcutProblem,
  type KeyChord,
  type ShortcutBinding,
} from "./contracts";
import { eventChord } from "./dispatch";

/** @param props Tablero confirmado y escritura atómica. @returns Editor de atajos físicos, sin ejecutar acciones al guardar. */
export function ShortcutPanel({
  board,
  onSave,
}: {
  board: PersistentBoard;
  onSave: (bindings: ShortcutBinding[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<ShortcutBinding | null>(null);
  const [chord, setChord] = useState<KeyChord | null>(null);
  const [scopeBankId, setScopeBankId] = useState("");
  const [kind, setKind] =
    useState<ShortcutBinding["action"]["kind"]>("play_button");
  const [message, setMessage] = useState<string | null>(null);
  /** @param bindings Propuesta completa. @returns ACK sin alterar el listado antes de confirmación. */
  async function save(bindings: ShortcutBinding[]): Promise<boolean> {
    const problem = shortcutProblem(bindings, board.banks);
    setMessage(problem);
    return !problem && (await onSave(bindings));
  }
  /** @param event Formulario de creación o edición. @returns Finalización visual tras ACK. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!chord) {
      setMessage("Captura una combinación válida antes de guardar.");
      return;
    }
    const data = new FormData(event.currentTarget);
    const binding: ShortcutBinding = {
      id: editing?.id ?? crypto.randomUUID(),
      scope: scopeBankId ? "bank" : "application",
      scopeBankId: scopeBankId || null,
      chord,
      action: {
        kind,
        targetId:
          kind === "stop_all" ? null : String(data.get("targetId") ?? ""),
      },
      enabled: data.get("enabled") === "on",
    };
    const bindings = board.keyboardShortcuts
      .filter((item) => item.id !== binding.id)
      .concat(binding);
    if (await save(bindings)) {
      setEditing(null);
      setChord(null);
      setMessage("Atajo guardado y confirmado. No se ha ejecutado su acción.");
    }
  }
  return (
    <div className="space-y-5">
      <p className="muted">
        Ctrl+Shift+Space es una parada de emergencia fija. Los demás atajos no
        actúan en campos, captura ni diálogos. Las teclas indican posición
        física (KeyboardEvent.code), no el carácter impreso.
      </p>
      {message && <p role="status">{message}</p>}
      <ul className="space-y-5">
        {board.keyboardShortcuts.map((binding) => (
          <li key={binding.id}>
            <strong>{chordLabel(binding.chord)}</strong> ·{" "}
            {binding.scope === "application"
              ? "Aplicación"
              : board.banks.find((bank) => bank.id === binding.scopeBankId)
                  ?.name}{" "}
            ·{" "}
            {binding.action.kind === "stop_all"
              ? "STOP ALL"
              : binding.action.kind === "select_bank"
                ? `Seleccionar ${board.banks.find((bank) => bank.id === binding.action.targetId)?.name}`
                : `Disparar ${board.banks.flatMap((bank) => bank.buttons).find((button) => button.id === binding.action.targetId)?.name}`}{" "}
            · {binding.enabled ? "Activo" : "Deshabilitado"}
            <div className="flex flex-wrap gap-2">
              <button
                className="control"
                onClick={() => {
                  setEditing(binding);
                  setChord(binding.chord);
                  setScopeBankId(binding.scopeBankId ?? "");
                  setKind(binding.action.kind);
                }}
              >
                Editar atajo {chordLabel(binding.chord)}
              </button>
              <button
                className="control"
                onClick={() =>
                  void save(
                    board.keyboardShortcuts.map((item) =>
                      item.id === binding.id
                        ? { ...item, enabled: !item.enabled }
                        : item,
                    ),
                  )
                }
              >
                {binding.enabled ? "Deshabilitar" : "Habilitar"}{" "}
                {chordLabel(binding.chord)}
              </button>
              <button
                className="control destructive"
                onClick={() =>
                  void save(
                    board.keyboardShortcuts.filter(
                      (item) => item.id !== binding.id,
                    ),
                  )
                }
              >
                Eliminar atajo {chordLabel(binding.chord)}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form
        key={editing?.id ?? "new"}
        onSubmit={(event) => void submit(event)}
        className="space-y-5"
      >
        <h3>{editing ? "Editar atajo" : "Crear atajo"}</h3>
        <label className="field">
          Combinación física
          <input
            readOnly
            data-shortcut-capture="true"
            value={chord ? chordLabel(chord) : ""}
            placeholder="Enfoca y pulsa la combinación"
            onKeyDown={(event) => {
              if (
                event.code === "Tab" ||
                event.code === "Escape" ||
                (event.ctrlKey && event.shiftKey && event.code === "Space")
              )
                return;
              event.preventDefault();
              const captured = eventChord(event.nativeEvent);
              if (captured) {
                setChord(captured);
                setMessage(null);
              } else
                setMessage(
                  "Combinación no admitida o reservada; IME, AltGraph y repetición no se capturan.",
                );
            }}
          />
        </label>
        <label className="field">
          Ámbito
          <select
            value={scopeBankId}
            onChange={(event) => setScopeBankId(event.currentTarget.value)}
          >
            <option value="">Aplicación</option>
            {board.banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Acción
          <select
            value={kind}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (
                value === "play_button" ||
                value === "select_bank" ||
                value === "stop_all"
              )
                setKind(value);
            }}
          >
            <option value="play_button">Disparar botón</option>
            <option value="select_bank">Seleccionar banco</option>
            <option value="stop_all">STOP ALL</option>
          </select>
        </label>
        {kind !== "stop_all" && (
          <label className="field">
            Destino
            <select
              key={`${kind}:${scopeBankId}`}
              name="targetId"
              required
              defaultValue={editing?.action.targetId ?? ""}
            >
              <option value="">Elige un destino</option>
              {kind === "select_bank"
                ? board.banks.map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {bank.name}
                    </option>
                  ))
                : board.banks
                    .filter((bank) => !scopeBankId || bank.id === scopeBankId)
                    .flatMap((bank) =>
                      bank.buttons.map((button) => (
                        <option key={button.id} value={button.id}>
                          {bank.name} / {button.name}
                        </option>
                      )),
                    )}
            </select>
          </label>
        )}
        <label>
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={editing?.enabled ?? true}
          />{" "}
          Habilitado
        </label>
        <div className="dialog-actions">
          <button
            type="button"
            className="control"
            onClick={() => {
              setEditing(null);
              setChord(null);
            }}
          >
            Nuevo atajo
          </button>
          <button className="control primary" type="submit">
            Guardar atajo
          </button>
        </div>
      </form>
    </div>
  );
}
