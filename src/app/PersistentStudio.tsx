import { Modal } from "../components/ui/Modal";
import { NativeAudioControls } from "../features/audio-controls/NativeAudioControls";
import type { NativeAudioController } from "../features/audio-controls/native-controller";
import { BankTabs } from "../features/sound-banks/BankTabs";
import { BankManager } from "../features/sound-banks/BankManager";
import { Soundboard } from "../features/soundboard/Soundboard";
import { usePersistentSoundboard } from "../features/soundboard/usePersistentSoundboard";
import { ButtonEditor } from "../features/sound-library/ButtonEditor";
import { LibraryPanel } from "../features/sound-library/LibraryPanel";
import type { LibraryController } from "../features/sound-library/library-controller";
import { useState } from "react";
import { ShortcutPanel } from "../features/keyboard-shortcuts/ShortcutPanel";
import { BankPackages } from "../features/sound-banks/BankPackages";

/** @param props Controladores sustituibles sin datos ni hardware reales. @returns Composición de vistas; el hook coordina estado, formularios y persistencia. */
export function PersistentStudio({
  libraryController,
  nativeController,
}: {
  libraryController?: LibraryController;
  nativeController?: NativeAudioController;
}) {
  const board = usePersistentSoundboard(libraryController, nativeController);
  const { view, audio, snapshot, bank, dialog, title } = board;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [transferId, setTransferId] = useState<string | null>(null);
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  return (
    <div className="studio-shell">
      <a href="#board-title" className="skip-link">
        Saltar a la paleta
      </a>
      <header className="studio-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            fx
            <span />
          </span>
          <div>
            <h1>
              RadioFX <span>Studio</span>
            </h1>
            <p>BIBLIOTECA LOCAL / ESCRITORIO</p>
          </div>
        </div>
        <div className="header-actions">
          {snapshot && (
            <label className="header-bank">
              <span className="sr-only">Banco activo</span>
              <select
                disabled={view.busy}
                value={snapshot.board.activeBankId}
                onChange={(event) =>
                  board.selectBank(event.currentTarget.value)
                }
              >
                {snapshot.board.banks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="device-indicator">{board.outputLabel}</p>
          <button
            className="control"
            disabled={!snapshot || view.busy}
            onClick={() => setShortcutsOpen(true)}
          >
            Atajos
          </button>
          <button
            className="control"
            disabled={!snapshot || view.busy}
            onClick={() => board.openDialog({ kind: "settings" })}
          >
            Configuración
          </button>
        </div>
      </header>
      <p className="demo-banner" role="status">
        {board.notice}
      </p>
      {view.error && (
        <div className="native-panel">
          <p role="alert" className="error-message">
            {view.error}
          </p>
          <button
            className="control"
            disabled={view.busy}
            onClick={board.refreshLibrary}
          >
            Reintentar carga de biblioteca
          </button>
        </div>
      )}
      {!snapshot && !view.busy && (
        <p className="native-panel">
          Biblioteca no disponible. No se han cargado bancos de demostración.
        </p>
      )}
      {snapshot && bank && (
        <>
          <div className="persistent-workspace">
            <fieldset disabled={view.busy}>
              <legend className="sr-only">
                Edición de bancos persistentes
              </legend>
              <BankTabs
                banks={snapshot.board.banks}
                activeBankId={snapshot.board.activeBankId}
                onSelect={board.selectBank}
                onManage={() => board.openDialog({ kind: "banks" })}
                onCreate={() => board.openDialog({ kind: "bank" })}
              />
            </fieldset>
            <main
              className="studio-main"
              aria-labelledby="board-title"
              aria-busy={view.busy}
            >
              <div className="board-toolbar">
                <div>
                  <p className="eyebrow">PALETA / ARCHIVOS LOCALES</p>
                  <h2 id="board-title" tabIndex={-1}>
                    {bank.name}
                  </h2>
                  <p className="muted">
                    Cada pulsación reinicia ese sonido. Los demás efectos siguen
                    sonando. Arrastra desde ⠿ o usa las flechas para ordenar.
                  </p>
                </div>
                <button
                  className="control primary"
                  disabled={view.busy}
                  onClick={() =>
                    board.openDialog({ kind: "button", bankId: bank.id })
                  }
                >
                  + Agregar botón
                </button>
              </div>
              <div className="native-routing mb-5">
                <label className="field">
                  Buscar en la paleta
                  <input
                    type="search"
                    value={board.query}
                    onChange={(event) =>
                      board.setQuery(event.currentTarget.value)
                    }
                  />
                </label>
                <label className="field">
                  Ámbito de búsqueda
                  <select
                    value={board.allBanks ? "all" : "active"}
                    onChange={(event) =>
                      board.setAllBanks(event.currentTarget.value === "all")
                    }
                  >
                    <option value="active">Banco activo</option>
                    <option value="all">Todos los bancos</option>
                  </select>
                </label>
              </div>
              {(!!board.query.trim() || board.allBanks) && (
                <p role="status" className="muted mb-3">
                  Ordenación y arrastre deshabilitados durante la búsqueda o la
                  vista de todos los bancos. La selección guardada y las voces
                  no cambian.
                </p>
              )}
              {board.visibleBanks.map((visibleBank) => (
                <section
                  key={visibleBank.id}
                  aria-label={`Paleta de ${visibleBank.name}`}
                >
                  {board.allBanks && <h3>{visibleBank.name}</h3>}
                  <Soundboard
                    bank={visibleBank}
                    demoStates={{}}
                    nativeStates={board.nativeStates}
                    columns={snapshot.settings.columns}
                    editingDisabled={view.busy}
                    orderingDisabled={!!board.query.trim() || board.allBanks}
                    filtered={!!board.query.trim()}
                    onTransfer={(button) => {
                      setTransferId(button.id);
                      setTransferMessage(null);
                    }}
                    onPreview={board.play}
                    onStopEffect={board.stopEffect}
                    onEdit={(button) =>
                      board.openDialog({
                        kind: "button",
                        bankId: visibleBank.id,
                        button,
                      })
                    }
                    onDelete={(button) =>
                      board.openDialog({
                        kind: "delete-button",
                        bankId: visibleBank.id,
                        button,
                      })
                    }
                    onMove={(id, direction) => {
                      if (!board.allBanks) board.move(id, direction);
                    }}
                    onDrop={(source, target) => {
                      if (!board.allBanks) board.drop(source, target);
                    }}
                    onAdd={() =>
                      board.openDialog({
                        kind: "button",
                        bankId: visibleBank.id,
                      })
                    }
                  />
                </section>
              ))}
              <div className="board-status">
                <span>
                  Revisión {snapshot.revision} · {bank.buttons.length}{" "}
                  asignaciones
                </span>
                <span>{board.playbackLabel}</span>
              </div>
            </main>
          </div>
          <LibraryPanel
            snapshot={snapshot}
            imported={view.imported}
            busy={view.busy}
            audio={audio}
            onImport={board.importAudio}
            onRefresh={board.refreshLibrary}
          />
          <BankPackages
            controller={board.controller}
            snapshot={snapshot}
            busy={view.busy}
            preview={view.preview}
            notice={view.packageNotice}
            error={view.error}
            onStopAll={() => void audio.controller.stopAll()}
          />
        </>
      )}
      <NativeAudioControls
        audio={audio}
        diagnosticsOnly
        preferredDeviceName={snapshot?.settings.preferredDeviceName}
      />
      {shortcutsOpen && snapshot && (
        <Modal
          title="Atajos de teclado"
          onClose={() => setShortcutsOpen(false)}
          onEmergencyStop={() => void audio.controller.stopAll()}
        >
          {view.error && <p role="alert">{view.error}</p>}
          <fieldset disabled={view.busy}>
            <legend className="sr-only">Atajos persistentes</legend>
            <ShortcutPanel
              board={snapshot.board}
              onSave={(bindings) =>
                board.controller.updateBoard((draft) => {
                  draft.keyboardShortcuts = bindings;
                })
              }
            />
          </fieldset>
        </Modal>
      )}
      {transferId && snapshot && (
        <Modal
          title="Mover o copiar asignación"
          onClose={() => setTransferId(null)}
          onEmergencyStop={() => void audio.controller.stopAll()}
        >
          {view.error && <p role="alert">{view.error}</p>}
          {transferMessage && <p role="alert">{transferMessage}</p>}
          <p>
            <strong>
              {
                snapshot.board.banks
                  .flatMap((item) => item.buttons)
                  .find((item) => item.id === transferId)?.name
              }
            </strong>
            . Se conserva el recurso de audio, sin duplicar archivos. Copiar
            crea un ID nuevo y no copia atajos. Al mover, los atajos afectados
            se eliminan de forma atómica; revisa tus asignaciones antes de
            confirmar. Atajos afectados:{" "}
            {
              snapshot.board.keyboardShortcuts.filter(
                (binding) =>
                  binding.action.kind === "play_button" &&
                  binding.action.targetId === transferId,
              ).length
            }
            .
          </p>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void board
                .transfer(
                  transferId,
                  String(data.get("targetBankId") ?? ""),
                  data.get("mode") === "copy",
                )
                .then((accepted) => {
                  if (accepted) setTransferId(null);
                  else
                    setTransferMessage(
                      "No se confirmó el traslado. Revisa el error y la biblioteca recargada.",
                    );
                });
            }}
          >
            <fieldset disabled={view.busy}>
              <legend className="sr-only">Traslado de asignación</legend>
              <label className="field">
                Banco destino
                <select name="targetBankId" required>
                  {snapshot.board.banks.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Operación
                <select name="mode">
                  <option value="move">Mover (elimina atajos afectados)</option>
                  <option value="copy">Copiar (sin atajos)</option>
                </select>
              </label>
              <button className="control primary" type="submit">
                Confirmar traslado
              </button>
            </fieldset>
          </form>
        </Modal>
      )}
      {dialog && snapshot && (
        <Modal
          key={dialog.kind}
          title={title}
          onClose={board.closeDialog}
          onEmergencyStop={() => void audio.controller.stopAll()}
        >
          {view.error && (
            <p role="alert" className="error-message">
              {view.error}
            </p>
          )}
          <fieldset disabled={view.busy} className="space-y-5">
            <legend className="sr-only">{title}</legend>
            {dialog.kind === "settings" && (
              <label className="field">
                Distribución de la cuadrícula
                <select
                  aria-label="Distribución de la cuadrícula"
                  value={snapshot.settings.columns}
                  onChange={board.changeColumns}
                >
                  <option value="auto">Automática</option>
                  <option value="3">3 columnas</option>
                  <option value="4">4 columnas</option>
                  <option value="6">6 columnas</option>
                </select>
                <span className="muted">
                  Se guarda tras confirmación de SQLite.
                </span>
              </label>
            )}
            {dialog.kind === "banks" && (
              <BankManager
                persistent
                banks={snapshot.board.banks}
                onRename={(item) =>
                  board.openDialog({ kind: "bank", bank: item })
                }
                onDelete={(item) =>
                  board.openDialog({ kind: "delete-bank", bank: item })
                }
                onMove={(id, direction) => board.move(id, direction, true)}
              />
            )}
            {dialog.kind === "bank" && (
              <form onSubmit={board.saveBank} className="space-y-5">
                <label className="field">
                  Nombre del banco
                  <input
                    name="name"
                    required
                    maxLength={60}
                    defaultValue={dialog.bank?.name ?? ""}
                  />
                </label>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="control"
                    onClick={board.closeDialog}
                  >
                    Cancelar
                  </button>
                  <button className="control primary" type="submit">
                    {dialog.bank ? "Guardar nombre" : "Crear banco"}
                  </button>
                </div>
              </form>
            )}
            {dialog.kind === "button" && (
              <ButtonEditor
                key={dialog.button?.id ?? "new"}
                button={dialog.button}
                effects={snapshot.effects}
                onSubmit={board.saveButton}
                onCancel={board.closeDialog}
              />
            )}
            {(dialog.kind === "delete-bank" ||
              dialog.kind === "delete-button") && (
              <div className="space-y-5">
                <p>
                  ¿Eliminar{" "}
                  <strong>
                    {dialog.kind === "delete-bank"
                      ? dialog.bank.name
                      : dialog.button.name}
                  </strong>
                  {dialog.kind === "delete-bank"
                    ? " y sus asignaciones"
                    : " de este banco"}
                  ?
                </p>
                <p className="muted">
                  Los atajos afectados se eliminan junto a sus destinos. No se
                  eliminará ningún archivo de audio. Esta acción no se puede
                  deshacer.
                </p>
                <div className="dialog-actions">
                  <button className="control" onClick={board.closeDialog}>
                    Cancelar
                  </button>
                  <button
                    className="control destructive"
                    disabled={board.deleteDisabled}
                    onClick={board.confirmDelete}
                  >
                    {dialog.kind === "delete-bank"
                      ? "Eliminar banco"
                      : "Eliminar botón"}
                  </button>
                </div>
              </div>
            )}
          </fieldset>
        </Modal>
      )}
    </div>
  );
}
