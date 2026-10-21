import type { SoundBank } from "./models";

interface BankManagerProps {
  banks: SoundBank[];
  onRename: (bank: SoundBank) => void;
  onDelete: (bank: SoundBank) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  persistent?: boolean;
}

/**
 * Presenta el orden de bancos con acciones equivalentes por ratón y teclado.
 * @param props Bancos, modo de almacenamiento y operaciones delegadas al controlador.
 * @returns Lista editable sin reglas de persistencia en la presentación.
 */
export function BankManager({
  banks,
  onRename,
  onDelete,
  onMove,
  persistent = false,
}: BankManagerProps) {
  return (
    <div className="space-y-3">
      <p className="muted">
        {persistent
          ? "Los cambios se guardan en SQLite tras confirmación."
          : "Los cambios solo duran esta sesión."}{" "}
        El último banco no se puede eliminar.
      </p>
      <ol className="space-y-3">
        {banks.map((bank, index) => (
          <li key={bank.id} className="bank-manager-row">
            <span className="min-w-0 flex-1 break-words font-semibold">
              {bank.name}
              <span className="muted block text-xs">
                {bank.buttons.length} efectos
              </span>
            </span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="control"
                disabled={index === 0}
                aria-label={`Subir banco ${bank.name}`}
                onClick={() => onMove(bank.id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="control"
                disabled={index === banks.length - 1}
                aria-label={`Bajar banco ${bank.name}`}
                onClick={() => onMove(bank.id, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="control"
                onClick={() => onRename(bank)}
              >
                Renombrar <span className="sr-only">{bank.name}</span>
              </button>
              <button
                type="button"
                className="control danger-text"
                disabled={banks.length === 1}
                onClick={() => onDelete(bank)}
              >
                Eliminar <span className="sr-only">banco {bank.name}</span>
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
