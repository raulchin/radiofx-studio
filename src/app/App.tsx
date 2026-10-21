import { Modal } from "../components/ui/Modal";
import { AudioControls } from "../features/audio-controls/AudioControls";
import { NativeAudioControls } from "../features/audio-controls/NativeAudioControls";
import { useNativeAudio } from "../features/audio-controls/useNativeAudio";
import type { NativeAudioController } from "../features/audio-controls/native-controller";
import { BankManager } from "../features/sound-banks/BankManager";
import { BankTabs } from "../features/sound-banks/BankTabs";
import { ButtonEditor } from "../features/sound-library/ButtonEditor";
import { Soundboard } from "../features/soundboard/Soundboard";
import {
  useSoundboard,
  type BoardStore,
} from "../features/soundboard/useSoundboard";
import { SettingsPanel } from "../features/settings/SettingsPanel";
import { isTauri } from "@tauri-apps/api/core";
import { PersistentStudio } from "./PersistentStudio";
import type { LibraryController } from "../features/sound-library/library-controller";

interface AppProps {
  store?: BoardStore;
  nativeController?: NativeAudioController;
  libraryController?: LibraryController;
}

/**
 * Selecciona biblioteca persistente en Tauri o demo explícita en navegador.
 * @param props Store y controlador opcionales para aislar pruebas.
 * @returns Estudio persistente; un store inyectado fuerza la demo aislada.
 */
export default function App({
  store,
  nativeController,
  libraryController,
}: AppProps) {
  return !store && (libraryController || isTauri()) ? (
    <PersistentStudio
      nativeController={nativeController}
      libraryController={libraryController}
    />
  ) : (
    <DemoStudio store={store} nativeController={nativeController} />
  );
}

/** @param props Dependencias de demostración aisladas. @returns Demo explícita en memoria sin persistencia. */
function DemoStudio({ store, nativeController }: AppProps) {
  const board = useSoundboard(store);
  const native = useNativeAudio(nativeController);
  const { state, activeBank, dialog } = board;
  const activeDemoCount = Object.values(state.demoStates).filter(
    (status) => status === "playing",
  ).length;
  const dialogTitle =
    dialog?.kind === "settings"
      ? "Configuración visual"
      : dialog?.kind === "banks"
        ? "Organizar bancos"
        : dialog?.kind === "bank"
          ? dialog.bank
            ? "Renombrar banco"
            : "Crear banco"
          : dialog?.kind === "button"
            ? dialog.button
              ? "Editar botón"
              : "Agregar botón"
            : dialog?.kind === "delete-bank"
              ? "Eliminar banco"
              : "Eliminar botón";

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
            <p>PALETA DE EFECTOS / SESIÓN LOCAL</p>
          </div>
        </div>
        <div className="header-actions">
          <label className="header-bank">
            <span className="sr-only">Banco activo</span>
            <select
              value={activeBank.id}
              onChange={(event) => board.selectBank(event.currentTarget.value)}
            >
              {state.banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name}
                </option>
              ))}
            </select>
          </label>
          <div className="device-indicator">
            <span className="device-dot" aria-hidden="true" />
            <div>
              <span className="block text-xs text-slate-400">
                Audio nativo ·{" "}
                {native.status?.state === "ready"
                  ? "listo"
                  : native.status?.state === "device_error"
                    ? "error de dispositivo"
                    : native.status
                      ? "sin inicializar"
                      : "no disponible / conectando"}
              </span>
              <span className="text-sm">
                {native.status?.state === "device_error" &&
                  "Salida no disponible: "}
                {native.status?.selected_device?.name ??
                  "Sin salida seleccionada"}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="control"
            onClick={() => board.openDialog({ kind: "settings" })}
          >
            Configuración
          </button>
        </div>
      </header>

      <div className="demo-banner">
        <span className="demo-tag">MODO MOCK</span>
        <p>
          Bancos mock en memoria; panel nativo con señales de prueba de Rust.
          Los bancos se pierden al recargar.
        </p>
        <span className="hidden text-xs text-slate-400 lg:block">
          DEMO + AUDIO NATIVO
        </span>
      </div>

      <BankTabs
        banks={state.banks}
        activeBankId={state.activeBankId}
        onSelect={board.selectBank}
        onManage={() => board.openDialog({ kind: "banks" })}
        onCreate={() => board.openDialog({ kind: "bank" })}
      />

      <main className="studio-main" aria-labelledby="board-title">
        <div className="board-toolbar">
          <div>
            <p className="eyebrow">PALETA DE RECURSOS MOCK / SIN AUDIO</p>
            <h2 id="board-title" tabIndex={-1}>
              {activeBank.name}
            </h2>
            <p className="muted text-sm">
              Pulsa para alternar estados demo. Arrastra desde ⠿ o usa las
              flechas para ordenar.
            </p>
          </div>
          <button
            type="button"
            className="control primary"
            onClick={() =>
              board.openDialog({ kind: "button", bankId: activeBank.id })
            }
          >
            + Agregar botón
          </button>
        </div>
        <Soundboard
          bank={activeBank}
          demoStates={state.demoStates}
          columns={state.columns}
          onPreview={board.previewButton}
          onEdit={(button) =>
            board.openDialog({ kind: "button", bankId: activeBank.id, button })
          }
          onDelete={(button) =>
            board.openDialog({
              kind: "delete-button",
              bankId: activeBank.id,
              button,
            })
          }
          onMove={board.nudgeButton}
          onDrop={board.dropButton}
          onAdd={() =>
            board.openDialog({ kind: "button", bankId: activeBank.id })
          }
        />
        <div className="board-status">
          <p role="status" aria-live="polite">
            {state.notice}
          </p>
          <span className="shrink-0 text-xs">
            Demo visual, no representa motor nativo
          </span>
        </div>
        {board.error && !dialog && (
          <p role="alert" className="error-message">
            {board.error}
          </p>
        )}
      </main>

      <NativeAudioControls audio={native} />

      <AudioControls
        masterVolume={state.masterVolume}
        activeDemoCount={activeDemoCount}
        effectCount={activeBank.buttons.length}
        onVolumeChange={board.setMasterVolume}
        onStopAll={board.stopAll}
      />

      {dialog && (
        <Modal
          key={dialog.kind}
          title={dialogTitle}
          onClose={board.closeDialog}
        >
          {board.error && (
            <p role="alert" className="error-message mb-4">
              {board.error}
            </p>
          )}
          {dialog.kind === "settings" && (
            <SettingsPanel
              columns={state.columns}
              onColumnsChange={board.setColumns}
            />
          )}
          {dialog.kind === "banks" && (
            <BankManager
              banks={state.banks}
              onRename={(bank) => board.openDialog({ kind: "bank", bank })}
              onDelete={(bank) =>
                board.openDialog({ kind: "delete-bank", bank })
              }
              onMove={board.moveBank}
            />
          )}
          {dialog.kind === "bank" && (
            <form onSubmit={board.saveBank} className="space-y-5">
              <label className="field">
                Nombre del banco
                <input
                  name="name"
                  required
                  maxLength={80}
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
                <button type="submit" className="control primary">
                  {dialog.bank ? "Guardar nombre" : "Crear banco"}
                </button>
              </div>
            </form>
          )}
          {dialog.kind === "button" && (
            <ButtonEditor
              button={dialog.button}
              demoState={
                dialog.button
                  ? (state.demoStates[dialog.button.id] ?? "available")
                  : "available"
              }
              onSubmit={board.saveButton}
              onCancel={board.closeDialog}
            />
          )}
          {(dialog.kind === "delete-button" ||
            dialog.kind === "delete-bank") && (
            <div className="space-y-5">
              <p className="break-words">
                ¿Eliminar{" "}
                <strong>
                  {dialog.kind === "delete-button"
                    ? dialog.button.name
                    : dialog.bank.name}
                </strong>
                {dialog.kind === "delete-bank"
                  ? " y todos sus botones"
                  : " de este banco"}
                ?
              </p>
              <p className="muted">
                Esta acción no se puede deshacer durante la sesión. No se
                eliminará ningún archivo de audio.
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="control"
                  onClick={board.closeDialog}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="control destructive"
                  onClick={board.confirmDelete}
                >
                  {dialog.kind === "delete-button"
                    ? "Eliminar botón"
                    : "Eliminar banco"}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
