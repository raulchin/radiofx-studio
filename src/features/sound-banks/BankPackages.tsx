import { useEffect, useState } from "react";
import { Modal } from "../../components/ui/Modal";
import type { LibraryController } from "../sound-library/library-controller";
import type {
  LibrarySnapshot,
  BankImportPreview,
} from "../../shared/contracts/library";

/** @param props Controlador único y última vista confirmada. @returns Selectores de paquetes; nunca recibe rutas ni bytes en JavaScript. */
export function BankPackages({
  controller,
  snapshot,
  busy,
  preview,
  notice,
  error,
  onStopAll,
}: {
  controller: LibraryController;
  snapshot: LibrarySnapshot;
  busy: boolean;
  preview: BankImportPreview | null;
  notice: string | null;
  error: string | null;
  onStopAll: () => void;
}) {
  const [mode, setMode] = useState<"import" | "export" | null>(null);
  const [enableShortcuts, setEnableShortcuts] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(
    () => () => {
      void controller.cancelBankImport();
    },
    [controller],
  );
  /** Libera una preparación presente o futura; un commit ya enviado no se puede deshacer. */
  function close(): void {
    setMode(null);
    void controller.cancelBankImport();
  }
  return (
    <section className="native-panel" aria-label="Paquetes de bancos">
      <div className="flex flex-wrap gap-2">
        <button
          className="control"
          disabled={busy}
          onClick={() => {
            setMode("import");
            setEnableShortcuts(false);
            void controller.prepareBankImport();
          }}
        >
          Importar bancos
        </button>
        <button
          className="control"
          disabled={busy}
          onClick={() => setMode("export")}
        >
          Exportar bancos
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {mode && (
        <Modal
          title={
            mode === "import"
              ? "Importar paquete de bancos"
              : "Exportar paquete de bancos"
          }
          onClose={close}
          onEmergencyStop={onStopAll}
        >
          {error && <p role="alert">{error}</p>}
          <p className="muted">
            Paquete .rfxbank local. El hash verifica integridad, no
            autenticidad: importa solo archivos de confianza. Máximo 256 MiB,
            ZIP sin compresión. No se sobrescriben bancos ni archivos
            existentes.
          </p>
          {mode === "import" ? (
            <div className="space-y-5">
              {preview ? (
                <>
                  <h3>Vista previa</h3>
                  <ul>
                    {preview.bankNames.map((name, index) => (
                      <li key={index}>{name}</li>
                    ))}
                  </ul>
                  <p>
                    {preview.effectCount} recursos · {preview.buttonCount}{" "}
                    botones · {preview.shortcutCount} atajos. Los bancos se
                    añaden con identidades nuevas; los recursos idénticos se
                    reutilizan conservando sus valores locales.
                  </p>
                  <ul>
                    {preview.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                  <p className="muted">
                    La preparación caduca a los 10 minutos. Si hay un conflicto,
                    revisa la biblioteca recargada y vuelve a preparar el
                    paquete; nunca se reintenta el commit automáticamente.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={enableShortcuts}
                      disabled={busy}
                      onChange={(event) =>
                        setEnableShortcuts(event.currentTarget.checked)
                      }
                    />{" "}
                    Activar atajos importados (pueden causar conflictos y
                    rechazar toda la importación)
                  </label>
                  <button
                    className="control primary"
                    disabled={busy}
                    onClick={() =>
                      void controller
                        .commitBankImport(enableShortcuts)
                        .then((accepted) => {
                          if (accepted) setMode(null);
                        })
                    }
                  >
                    Confirmar importación de bancos
                  </button>
                </>
              ) : (
                <>
                  <p role="status">
                    {busy
                      ? "Preparando paquete / esperando selector nativo..."
                      : "Sin preparación vigente. Revisa el resultado y vuelve a elegir el archivo si es necesario."}
                  </p>
                  <button
                    className="control"
                    disabled={busy}
                    onClick={() => {
                      setEnableShortcuts(false);
                      void controller.prepareBankImport();
                    }}
                  >
                    Elegir paquete
                  </button>
                </>
              )}
              <button className="control" onClick={close}>
                Cancelar importación
              </button>
            </div>
          ) : (
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const ids = data
                  .getAll("bankIds")
                  .filter(
                    (value): value is string => typeof value === "string",
                  );
                setExportError(
                  ids.length
                    ? null
                    : "Selecciona al menos un banco para exportar.",
                );
                if (ids.length)
                  void controller.exportSoundBanks(
                    ids,
                    data.get("includeShortcuts") === "on",
                  );
              }}
            >
              <fieldset disabled={busy}>
                <legend>Bancos a exportar (selecciona al menos uno)</legend>
                {snapshot.board.banks.map((bank) => (
                  <label className="field" key={bank.id}>
                    <input
                      type="checkbox"
                      name="bankIds"
                      value={bank.id}
                      defaultChecked={bank.id === snapshot.board.activeBankId}
                    />
                    {bank.name}
                  </label>
                ))}
              </fieldset>
              <label>
                <input
                  type="checkbox"
                  name="includeShortcuts"
                  disabled={busy}
                />{" "}
                Incluir atajos
              </label>
              <p>
                Elige un nombre de destino nuevo: Rust rechaza sobrescribir
                archivos existentes, incluso si el selector permite confirmarlo.
              </p>
              {exportError && <p role="alert">{exportError}</p>}
              {notice && <p role="status">{notice}</p>}
              <button className="control primary" disabled={busy}>
                Elegir destino y exportar
              </button>
              <button className="control" type="button" onClick={close}>
                Cerrar
              </button>
            </form>
          )}
        </Modal>
      )}
    </section>
  );
}
