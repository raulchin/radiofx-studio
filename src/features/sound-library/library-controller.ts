import { libraryApi, type LibraryApi } from "../../shared/adapters/library";
import { audioErrorMessage } from "../../shared/adapters/audio";
import {
  librarySnapshotSchema,
  importResultSchema,
  bankImportPreparationSchema,
  bankImportCommitSchema,
  bankExportResultSchema,
  type BankImportPreview,
  type Columns,
  type ImportResult,
  type LibrarySnapshot,
  type PersistentBoard,
} from "../../shared/contracts/library";

interface LibraryView {
  snapshot: LibrarySnapshot | null;
  busy: boolean;
  error: string | null;
  imported: ImportResult | null;
  preview: BankImportPreview | null;
  packageNotice: string | null;
}

/** Coordina instantáneas atómicas sin persistencia simulada ni escrituras optimistas. */
export class LibraryController {
  private view: LibraryView = {
    snapshot: null,
    busy: true,
    error: null,
    imported: null,
    preview: null,
    packageNotice: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private mounted = false;
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private pending = 0;
  private previewEpoch = 0;

  /** @param api Puerto IPC sustituible sin SQLite ni hardware. */
  constructor(private api: LibraryApi = libraryApi) {}
  /** @returns Última vista confirmada y estable para React. */
  getSnapshot = (): LibraryView => this.view;
  /** @param listener Receptor React. @returns Cancelación local. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** @param patch Estado de UI o instantánea completa confirmada. */
  private publish(patch: Partial<LibraryView>): void {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  /** @returns Limpieza que invalida respuestas y operaciones pendientes del montaje. */
  start = (): (() => void) => {
    const generation = ++this.generation;
    this.mounted = true;
    this.pending = 0;
    this.queue = Promise.resolve();
    this.publish({
      snapshot: null,
      busy: true,
      error: null,
      imported: null,
      packageNotice: null,
    });
    void this.refresh();
    return () => {
      if (generation === this.generation) {
        void this.cancelBankImport();
        this.mounted = false;
        this.generation++;
        this.epoch++;
      }
    };
  };
  /** @param operation Operación serializada. @param reloadOnError Reconcilia escrituras de resultado incierto. @returns Aceptación confirmada, nunca optimista. */
  private enqueue(
    operation: () => Promise<LibrarySnapshot>,
    reloadOnError = true,
  ): Promise<boolean> {
    if (!this.mounted) return Promise.resolve(false);
    const generation = this.generation;
    const epoch = this.epoch;
    this.pending++;
    this.publish({ busy: true });
    /** @returns Ejecución protegida contra desmontaje y conflictos anteriores. */
    const run = async (): Promise<boolean> => {
      if (!this.mounted || generation !== this.generation) return false;
      try {
        if (epoch !== this.epoch) return false;
        this.publish({ error: null });
        const snapshot = librarySnapshotSchema.parse(await operation());
        if (!this.mounted || generation !== this.generation) return false;
        this.publish({ snapshot });
        return true;
      } catch (error) {
        if (!this.mounted || generation !== this.generation) return false;
        // Invalida intenciones encoladas; no reenvía una edición sobre otro tablero.
        this.epoch++;
        const message = `Biblioteca: ${audioErrorMessage(error)}`;
        this.publish({ error: message });
        if (!reloadOnError) return false;
        try {
          const snapshot = librarySnapshotSchema.parse(
            await this.api.getSnapshot(),
          );
          if (this.mounted && generation === this.generation)
            this.publish({
              snapshot,
              error: `${message} Se recargó el estado confirmado; revisa los cambios antes de volver a guardar.`,
            });
        } catch (reloadError) {
          if (this.mounted && generation === this.generation)
            this.publish({
              error: `${message} Tampoco se pudo actualizar: ${audioErrorMessage(reloadError)}`,
            });
        }
        return false;
      } finally {
        if (this.mounted && generation === this.generation) {
          this.pending--;
          this.publish({ busy: this.pending > 0 });
        }
      }
    };
    const done = this.queue.then(run);
    this.queue = done;
    return done;
  }
  /** @returns Lectura explícita, sin sondeo de archivos. */
  refresh = (): Promise<boolean> =>
    this.enqueue(() => this.api.getSnapshot(), false);
  /** @param edit Transformación aplicada sobre el último ACK, no sobre un borrador obsoleto. @returns Resultado durable. */
  updateBoard = (edit: (board: PersistentBoard) => void): Promise<boolean> =>
    this.enqueue(async () => {
      const snapshot = this.view.snapshot;
      if (!snapshot)
        throw new Error("No hay un tablero confirmado para guardar.");
      const board = structuredClone(snapshot.board);
      edit(board);
      return this.api.saveBoard(
        librarySnapshotSchema.parse({ ...snapshot, board }).board,
        snapshot.revision,
      );
    });
  /** @param columns Densidad solicitada. @returns Confirmación de SQLite. */
  setColumns = (columns: Columns): Promise<boolean> =>
    this.enqueue(() => this.api.setColumns(columns));
  /** @returns Resultado del selector Rust; cancelación y duplicados permanecen visibles. */
  importAudio = (): Promise<boolean> =>
    this.enqueue(async () => {
      const generation = this.generation;
      const result = importResultSchema.parse(await this.api.importAudio());
      if (this.mounted && generation === this.generation)
        this.publish({ imported: result, snapshot: result.snapshot });
      return result.snapshot;
    });
  /** @returns Libera inmediatamente el token sin esperar a selectores o escrituras en cola. */
  cancelBankImport = async (): Promise<void> => {
    this.previewEpoch++;
    const generation = this.generation;
    const token = this.view.preview?.token;
    this.publish({ preview: null });
    if (token) {
      try {
        await this.api.cancelBankImport(token);
      } catch (error) {
        if (this.mounted && generation === this.generation)
          this.publish({ error: audioErrorMessage(error) });
      }
    }
  };
  /** @returns Preparación serializada; una respuesta tardía siempre libera su token. */
  prepareBankImport = async (): Promise<boolean> => {
    const cancelled = this.cancelBankImport();
    const epoch = this.previewEpoch;
    const generation = this.generation;
    await cancelled;
    if (
      !this.mounted ||
      generation !== this.generation ||
      epoch !== this.previewEpoch
    )
      return false;
    return this.enqueue(async () => {
      if (epoch !== this.previewEpoch) {
        if (!this.view.snapshot)
          throw new Error("No hay biblioteca confirmada.");
        return this.view.snapshot;
      }
      this.publish({ packageNotice: null });
      const result = bankImportPreparationSchema.parse(
        await this.api.prepareBankImport(),
      );
      if (
        result.preview &&
        (!this.mounted ||
          generation !== this.generation ||
          epoch !== this.previewEpoch)
      ) {
        await this.api.cancelBankImport(result.preview.token);
      } else if (
        this.mounted &&
        generation === this.generation &&
        epoch === this.previewEpoch
      ) {
        this.publish({
          preview: result.preview,
          packageNotice: result.cancelled
            ? "Importación de bancos cancelada."
            : null,
        });
      }
      if (!this.view.snapshot) throw new Error("No hay biblioteca confirmada.");
      return this.view.snapshot;
    }, false);
  };
  /** @param enableShortcuts Opt-in de activación. @returns Commit único; ante cualquier error recarga sin repetirlo. */
  commitBankImport = (enableShortcuts: boolean): Promise<boolean> =>
    this.enqueue(async () => {
      const token = this.view.preview?.token;
      const snapshot = this.view.snapshot;
      if (!token || !snapshot)
        throw new Error("Vuelve a preparar el paquete antes de importar.");
      const generation = this.generation;
      this.publish({ preview: null });
      try {
        const result = bankImportCommitSchema.parse(
          await this.api.commitBankImport(
            token,
            snapshot.revision,
            enableShortcuts,
          ),
        );
        if (this.mounted && generation === this.generation)
          this.publish({
            packageNotice: `Importación confirmada: ${result.importedBankIds.length} bancos; ${result.reusedEffects} recursos reutilizados. ${result.warnings.join(" ")}`,
          });
        return result.snapshot;
      } catch (error) {
        // Un fallo posterior al commit puede haber guardado datos: nunca repetirlo automáticamente.
        await this.api.cancelBankImport(token).catch(() => {});
        throw error;
      }
    });
  /** @param bankIds Selección explícita. @param includeShortcuts Incluye asignaciones de teclado. @returns Resultado visible, sin anunciar éxito si se cancela. */
  exportSoundBanks = (
    bankIds: string[],
    includeShortcuts: boolean,
  ): Promise<boolean> =>
    this.enqueue(async () => {
      const snapshot = this.view.snapshot;
      if (!snapshot) throw new Error("No hay biblioteca confirmada.");
      const generation = this.generation;
      this.publish({ packageNotice: null });
      const result = bankExportResultSchema.parse(
        await this.api.exportSoundBanks(
          bankIds,
          snapshot.revision,
          includeShortcuts,
        ),
      );
      if (this.mounted && generation === this.generation)
        this.publish({
          packageNotice: result.cancelled
            ? "Exportación cancelada."
            : `Exportación confirmada: ${result.exportedBanks} bancos, ${result.exportedEffects} recursos, ${result.byteSize} bytes. ${result.warnings.join(" ")}`,
        });
      return snapshot;
    });
}
