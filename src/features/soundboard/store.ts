import { z } from "zod";
import { createStore } from "zustand/vanilla";
import {
  boardSnapshotSchema,
  soundBankSchema,
  type BoardSnapshot,
} from "../sound-banks/models";
import {
  createMockRepository,
  type BankRepository,
} from "../sound-banks/mock-repository";
import { buttonDraftSchema, type ButtonDraft } from "../sound-library/models";

export const demoStateSchema = z.enum(
  ["available", "playing", "paused", "error"],
  { error: "El estado visual no está permitido." },
);
export type DemoState = z.infer<typeof demoStateSchema>;
export const columnsSchema = z.enum(["auto", "3", "4", "6"], {
  error: "La distribución de columnas no está permitida.",
});
const directionSchema = z.union([z.literal(-1), z.literal(1)], {
  error: "La dirección debe ser -1 o 1.",
});
const masterVolumeSchema = z
  .number({ error: "El volumen debe ser un número finito." })
  .int("El volumen debe ser entero.")
  .min(0, "El volumen mínimo es 0.")
  .max(100, "El volumen máximo es 100.");
const demoNotice = "Demostración visual: no se reproduce audio real.";

export interface BoardState extends BoardSnapshot {
  masterVolume: number;
  columns: z.infer<typeof columnsSchema>;
  demoStates: Record<string, DemoState>;
  notice: string;
  /**
   * Selecciona y guarda el banco activo.
   * @param id Banco existente.
   * @throws Si el banco no existe o falla el guardado.
   */
  selectBank(id: string): void;
  /**
   * Crea y activa un banco vacío.
   * @param name Nombre no vacío.
   * @returns Identificador creado.
   * @throws Si el nombre o el guardado fallan.
   */
  createBank(name: string): string;
  /**
   * Renombra un banco existente.
   * @param id Banco existente.
   * @param name Nombre nuevo.
   * @throws Si la entrada o el guardado fallan.
   */
  renameBank(id: string, name: string): void;
  /**
   * Elimina un banco y selecciona el primero si era el activo.
   * @param id Banco existente.
   * @throws Si no existe, es el último banco o el guardado falla.
   */
  deleteBank(id: string): void;
  /**
   * Reordena un banco sin sobrepasar los extremos.
   * @param id Banco existente.
   * @param direction Desplazamiento de una posición.
   * @throws Si la entrada o el guardado fallan.
   */
  moveBank(id: string, direction: -1 | 1): void;
  /**
   * Añade un botón sin archivo de audio asociado.
   * @param bankId Banco destino.
   * @param draft Datos editables.
   * @returns Identificador creado.
   * @throws Si la entrada o el guardado fallan.
   */
  addButton(bankId: string, draft: ButtonDraft): string;
  /**
   * Edita un botón conservando sus identificadores.
   * @param bankId Banco propietario.
   * @param buttonId Botón existente.
   * @param draft Datos editables.
   * @throws Si la entrada o el guardado fallan.
   */
  updateButton(bankId: string, buttonId: string, draft: ButtonDraft): void;
  /**
   * Elimina un botón y descarta su estado demo.
   * @param bankId Banco propietario.
   * @param buttonId Botón existente.
   * @throws Si la entrada o el guardado fallan.
   */
  deleteButton(bankId: string, buttonId: string): void;
  /**
   * Mueve el origen a la posición final del destino; IDs iguales no cambian nada.
   * @param bankId Banco propietario.
   * @param sourceId Botón origen.
   * @param targetId Botón destino.
   * @throws Si los botones no pertenecen al banco o el guardado falla.
   */
  moveButton(bankId: string, sourceId: string, targetId: string): void;
  /**
   * Desplaza un botón sin sobrepasar los extremos.
   * @param bankId Banco propietario.
   * @param id Botón existente.
   * @param direction Desplazamiento de una posición.
   * @throws Si la entrada o el guardado fallan.
   */
  nudgeButton(bankId: string, id: string, direction: -1 | 1): void;
  /**
   * Alterna disponible, activo y pausado; conserva el error sin reproducir audio.
   * @param id Botón existente.
   * @throws Si el botón no existe.
   */
  previewButton(id: string): void;
  /**
   * Asigna un estado exclusivamente visual a un botón.
   * @param id Botón existente.
   * @param state Estado exclusivamente visual.
   * @throws Si la entrada no es válida.
   */
  setDemoState(id: string, state: DemoState): void;
  /** Restablece todos los botones visuales, sin enviar órdenes al motor. */
  stopAll(): void;
  /**
   * Ajusta el volumen visual sin enviar órdenes al motor.
   * @param value Porcentaje entero entre 0 y 100.
   * @throws Si el valor no es válido.
   */
  setMasterVolume(value: number): void;
  /**
   * Cambia la distribución visual sin persistirla.
   * @param value Distribución permitida.
   * @throws Si el valor no es válido.
   */
  setColumns(value: BoardState["columns"]): void;
}

/**
 * Crea un store independiente de recursos y estados visuales de Fase 2.
 * @param repository Persistencia síncrona de recursos, por defecto en memoria.
 * @returns Store vanilla sin reproducción ni persistencia de estados demo.
 * @throws Si la carga inicial no es válida o el repositorio falla.
 */
export function createBoardStore(
  repository: BankRepository = createMockRepository(),
) {
  const initial = boardSnapshotSchema.parse(repository.load());
  return createStore<BoardState>()(
    /**
     * Inicializa recursos, preferencias visuales y acciones independientes del motor.
     * @param set Publica cambios validados en Zustand.
     * @param get Consulta el estado actual para cada operación.
     * @returns Estado inicial y acciones del tablero.
     */
    (set, get) => {
      /**
       * Extrae exclusivamente los recursos persistibles.
       * @returns Copia validada sin acciones ni preferencias visuales.
       * @throws Si los recursos actuales incumplen el contrato.
       */
      function snapshot(): BoardSnapshot {
        const { version, banks, activeBankId } = get();
        return boardSnapshotSchema.parse({ version, banks, activeBankId });
      }

      /**
       * Guarda antes de publicar y elimina estados de botones borrados.
       * @param next Recursos propuestos.
       * @param notice Aviso de la operación.
       * @throws Si la validación o el repositorio fallan, sin actualizar el store.
       */
      function commit(next: BoardSnapshot, notice: string): void {
        const valid = boardSnapshotSchema.parse(next);
        repository.save(boardSnapshotSchema.parse(valid));
        const ids = new Set(
          valid.banks.flatMap(
            /**
             * Enumera botones conservados.
             * @param bank Banco conservado.
             * @returns IDs de sus botones.
             */
            (bank) =>
              bank.buttons.map(
                /**
                 * Extrae la identidad del botón.
                 * @param button Botón conservado.
                 * @returns Su identificador.
                 */
                (button) => button.id,
              ),
          ),
        );
        const demoStates = Object.fromEntries(
          Object.entries(get().demoStates).filter(
            /**
             * Descarta estados de botones eliminados.
             * @param entry Estado demo existente.
             * @returns Si pertenece a un botón conservado.
             */
            ([id]) => ids.has(id),
          ),
        );
        set({ ...valid, demoStates, notice });
      }

      /**
       * Resuelve un banco dentro de una instantánea.
       * @param board Recursos consultados.
       * @param id Identificador exacto.
       * @returns Banco encontrado.
       * @throws Si no existe el banco.
       */
      function requireBank(board: BoardSnapshot, id: string) {
        const bank = board.banks.find(
          /**
           * Localiza el banco solicitado.
           * @param candidate Banco consultado.
           * @returns Si coincide con el ID buscado.
           */
          (candidate) => candidate.id === id,
        );
        if (!bank) throw new Error("El banco indicado no existe.");
        return bank;
      }

      /**
       * Resuelve un botón sin permitir movimientos entre bancos.
       * @param bank Banco propietario.
       * @param id Identificador exacto del botón.
       * @returns Posición del botón.
       * @throws Si el botón no pertenece al banco.
       */
      function requireButton(bank: BoardSnapshot["banks"][number], id: string) {
        const index = bank.buttons.findIndex(
          /**
           * Localiza el botón solicitado.
           * @param button Botón consultado.
           * @returns Si coincide con el ID buscado.
           */
          (button) => button.id === id,
        );
        if (index < 0)
          throw new Error("El botón indicado no pertenece al banco.");
        return index;
      }

      return {
        ...initial,
        masterVolume: 75,
        columns: "auto",
        demoStates: {},
        notice: demoNotice,
        /**
         * Activa un banco existente.
         * @param id Banco que se activa.
         * @throws Si no existe o falla el guardado.
         */
        selectBank(id) {
          const next = snapshot();
          requireBank(next, id);
          next.activeBankId = id;
          commit(next, "Banco seleccionado.");
        },
        /**
         * Crea y activa un banco vacío.
         * @param name Nombre del banco.
         * @returns ID nuevo.
         * @throws Si el nombre o el guardado fallan.
         */
        createBank(name) {
          const bank = soundBankSchema.parse({
            id: crypto.randomUUID(),
            name,
            buttons: [],
          });
          const next = snapshot();
          next.banks.push(bank);
          next.activeBankId = bank.id;
          commit(next, "Banco creado.");
          return bank.id;
        },
        /**
         * Renombra un banco.
         * @param id Banco editado.
         * @param name Nombre nuevo.
         * @throws Si la entrada o el guardado fallan.
         */
        renameBank(id, name) {
          const next = snapshot();
          requireBank(next, id).name = soundBankSchema.shape.name.parse(name);
          commit(next, "Banco renombrado.");
        },
        /**
         * Elimina un banco y resuelve el activo.
         * @param id Banco eliminado.
         * @throws Si no existe, es el último o falla el guardado.
         */
        deleteBank(id) {
          const next = snapshot();
          requireBank(next, id);
          if (next.banks.length === 1)
            throw new Error("No se puede eliminar el último banco.");
          next.banks = next.banks.filter(
            /**
             * Excluye el banco eliminado.
             * @param bank Banco consultado.
             * @returns Si debe conservarse.
             */
            (bank) => bank.id !== id,
          );
          if (next.activeBankId === id) next.activeBankId = next.banks[0].id;
          commit(next, "Banco eliminado.");
        },
        /**
         * Reordena un banco y anuncia su posición final.
         * @param id Banco movido.
         * @param direction Paso relativo.
         * @throws Si la entrada o el guardado fallan.
         */
        moveBank(id, direction) {
          directionSchema.parse(direction);
          const next = snapshot();
          const bank = requireBank(next, id);
          const source = next.banks.indexOf(bank);
          const target = source + direction;
          if (target < 0 || target >= next.banks.length) return;
          next.banks.splice(source, 1);
          next.banks.splice(target, 0, bank);
          commit(
            next,
            `Banco "${bank.name}": posición ${target + 1} de ${next.banks.length}.`,
          );
        },
        /**
         * Añade un botón sin archivo asociado.
         * @param bankId Banco destino.
         * @param draft Datos nuevos.
         * @returns ID nuevo.
         * @throws Si la entrada o el guardado fallan.
         */
        addButton(bankId, draft) {
          const fields = buttonDraftSchema.parse(draft);
          const next = snapshot();
          const bank = requireBank(next, bankId);
          const id = crypto.randomUUID();
          bank.buttons.push({ ...fields, id, effectId: null });
          commit(next, "Botón creado sin archivo de audio.");
          return id;
        },
        /**
         * Edita los campos de un botón.
         * @param bankId Banco propietario.
         * @param buttonId Botón editado.
         * @param draft Datos nuevos.
         * @throws Si la entrada o el guardado fallan.
         */
        updateButton(bankId, buttonId, draft) {
          const fields = buttonDraftSchema.parse(draft);
          const next = snapshot();
          const bank = requireBank(next, bankId);
          const index = requireButton(bank, buttonId);
          bank.buttons[index] = { ...bank.buttons[index], ...fields };
          commit(next, "Botón actualizado.");
        },
        /**
         * Elimina un botón y su estado demo.
         * @param bankId Banco propietario.
         * @param buttonId Botón eliminado.
         * @throws Si la entrada o el guardado fallan.
         */
        deleteButton(bankId, buttonId) {
          const next = snapshot();
          const bank = requireBank(next, bankId);
          bank.buttons.splice(requireButton(bank, buttonId), 1);
          commit(next, "Botón eliminado.");
        },
        /**
         * Mueve un botón y anuncia su posición final.
         * @param bankId Banco propietario.
         * @param sourceId Botón movido.
         * @param targetId Posición final.
         * @throws Si la entrada o el guardado fallan.
         */
        moveButton(bankId, sourceId, targetId) {
          const next = snapshot();
          const bank = requireBank(next, bankId);
          const source = requireButton(bank, sourceId);
          const target = requireButton(bank, targetId);
          if (source === target) return;
          const [button] = bank.buttons.splice(source, 1);
          bank.buttons.splice(target, 0, button);
          commit(
            next,
            `Botón "${button.name}": posición ${target + 1} de ${bank.buttons.length}.`,
          );
        },
        /**
         * Desplaza un botón una posición.
         * @param bankId Banco propietario.
         * @param id Botón movido.
         * @param direction Paso relativo.
         * @throws Si la entrada o el guardado fallan.
         */
        nudgeButton(bankId, id, direction) {
          directionSchema.parse(direction);
          const bank = requireBank(get(), bankId);
          const target = requireButton(bank, id) + direction;
          if (target < 0 || target >= bank.buttons.length) return;
          get().moveButton(bankId, id, bank.buttons[target].id);
        },
        /**
         * Alterna el estado visual sin reproducir audio.
         * @param id Botón que cambia de estado visual.
         * @throws Si no existe.
         */
        previewButton(id) {
          const current = get().demoStates[id] ?? "available";
          const next: Record<DemoState, DemoState> = {
            available: "playing",
            playing: "paused",
            paused: "available",
            error: "error",
          };
          get().setDemoState(id, next[current]);
        },
        /**
         * Asigna un estado exclusivamente visual.
         * @param id Botón existente.
         * @param state Estado visual nuevo.
         * @throws Si la entrada no es válida.
         */
        setDemoState(id, state) {
          if (
            !get().banks.some(
              /**
               * Busca el banco propietario del botón.
               * @param bank Banco consultado.
               * @returns Si contiene el botón solicitado.
               */
              (bank) =>
                bank.buttons.some(
                  /**
                   * Reconoce el botón solicitado.
                   * @param button Botón consultado.
                   * @returns Si coincide con el ID solicitado.
                   */
                  (button) => button.id === id,
                ),
            )
          ) {
            throw new Error("El botón indicado no existe.");
          }
          const valid = demoStateSchema.parse(state);
          set({
            demoStates: { ...get().demoStates, [id]: valid },
            notice: demoNotice,
          });
        },
        /** Restablece todos los botones, incluidos los de bancos inactivos. */
        stopAll() {
          const demoStates = Object.fromEntries(
            get().banks.flatMap(
              /**
               * Restablece los botones de un banco.
               * @param bank Banco que se restablece.
               * @returns Pares de ID y estado disponible.
               */
              (bank) =>
                bank.buttons.map(
                  /**
                   * Asigna el estado demo inicial.
                   * @param button Botón que se restablece.
                   * @returns Par de ID y estado disponible.
                   */
                  (button) => [button.id, "available" as const],
                ),
            ),
          );
          set({
            demoStates,
            notice:
              "Estados visuales restablecidos. No hay audio real que detener.",
          });
        },
        /**
         * Ajusta el volumen visual.
         * @param value Porcentaje entero.
         * @throws Si no está entre 0 y 100 o no es finito.
         */
        setMasterVolume(value) {
          set({
            masterVolume: masterVolumeSchema.parse(value),
            notice: demoNotice,
          });
        },
        /**
         * Ajusta la distribución visual.
         * @param value Distribución de columnas.
         * @throws Si no está permitida.
         */
        setColumns(value) {
          set({ columns: columnsSchema.parse(value) });
        },
      };
    },
  );
}

export const boardStore = createBoardStore();
