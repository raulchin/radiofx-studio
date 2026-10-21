import { describe, expect, it, vi } from "vitest";
import {
  boardSnapshotSchema,
  soundBankSchema,
} from "../src/features/sound-banks/models";
import {
  createMockRepository,
  type BankRepository,
} from "../src/features/sound-banks/mock-repository";
import {
  buttonColorSchema,
  buttonDraftSchema,
  soundButtonSchema,
  type ButtonDraft,
} from "../src/features/sound-library/models";
import { createBoardStore } from "../src/features/soundboard/store";

const draft: ButtonDraft = {
  name: "  Entrada propia  ",
  durationMs: 1500,
  color: "amber",
  category: "  Identidad  ",
};

/**
 * Prepara recursos independientes para cada caso.
 * @returns Store aislado e identificadores de los recursos iniciales.
 * @throws Si la carga inicial incumple el contrato.
 */
function setup() {
  const repository = createMockRepository();
  const store = createBoardStore(repository);
  const [first, second, empty] = store.getState().banks;
  return { repository, store, first, second, empty };
}

describe("board_models", /** Registra las verificaciones de esquemas de recursos. */ () => {
  it("exports_strict_schemas_and_trims_editable_fields", /** Comprueba esquemas estrictos y normalización de textos. */ () => {
    expect(buttonDraftSchema.parse(draft)).toEqual({
      ...draft,
      name: "Entrada propia",
      category: "Identidad",
    });
    expect(buttonColorSchema.options).toEqual([
      "amber",
      "coral",
      "mint",
      "sky",
      "violet",
      "slate",
    ]);
    const { first, repository } = setup();
    expect(soundBankSchema.safeParse({ ...first, extra: true }).success).toBe(
      false,
    );
    expect(
      soundButtonSchema.safeParse({ ...first.buttons[0], extra: true }).success,
    ).toBe(false);
    expect(
      boardSnapshotSchema.safeParse({ ...repository.load(), extra: true })
        .success,
    ).toBe(false);
    expect(
      buttonDraftSchema.safeParse({ ...draft, effectId: "injected" }).success,
    ).toBe(false);
  });

  it("rejects_invalid_snapshots_and_duplicate_ids", /** Comprueba invariantes globales de la instantánea. */ () => {
    const original = createMockRepository().load();
    const duplicateBank = structuredClone(original);
    duplicateBank.banks[1].id = duplicateBank.banks[0].id;
    const duplicateLocal = structuredClone(original);
    duplicateLocal.banks[0].buttons.push(duplicateLocal.banks[0].buttons[0]);
    const duplicateGlobal = structuredClone(original);
    duplicateGlobal.banks[1].buttons.push(duplicateGlobal.banks[0].buttons[0]);
    for (const invalid of [
      { ...original, version: 2 },
      { ...original, banks: [] },
      { ...original, activeBankId: "missing" },
      duplicateBank,
      duplicateLocal,
      duplicateGlobal,
    ]) {
      expect(boardSnapshotSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each([
    { name: " " },
    { name: 42 },
    { name: "n".repeat(101) },
    { category: " " },
    { category: "c".repeat(61) },
    { color: "red" },
    { durationMs: -1 },
    { durationMs: 0.5 },
    { durationMs: NaN },
    { durationMs: Infinity },
    { durationMs: -Infinity },
    { durationMs: "100" },
  ])(
    "rejects_invalid_draft_%j",
    /**
     * Comprueba el rechazo de un campo inválido del borrador.
     * @param invalid Campo inválido que sustituye al válido.
     */ (invalid) => {
      expect(
        buttonDraftSchema.safeParse({ ...draft, ...invalid }).success,
      ).toBe(false);
    },
  );

  it("accepts_text_limits_after_trimming_and_rejects_long_bank_names", /** Comprueba máximos inclusivos y mensajes españoles. */ () => {
    const button = {
      ...draft,
      name: ` ${"n".repeat(100)} `,
      category: ` ${"c".repeat(60)} `,
    };
    expect(buttonDraftSchema.parse(button)).toMatchObject({
      name: "n".repeat(100),
      category: "c".repeat(60),
    });
    const { first } = setup();
    expect(
      soundBankSchema.parse({ ...first, name: ` ${"b".repeat(80)} ` }).name,
    ).toHaveLength(80);
    const invalidBank = soundBankSchema.safeParse({
      ...first,
      name: "b".repeat(81),
    });
    expect(invalidBank.success).toBe(false);
    expect(invalidBank.error?.issues[0].message).toBe(
      "El nombre del banco no puede superar los 80 caracteres.",
    );
    expect(
      buttonDraftSchema.safeParse({ ...draft, name: "n".repeat(101) }).error
        ?.issues[0].message,
    ).toBe("El nombre no puede superar los 100 caracteres.");
    expect(
      buttonDraftSchema.safeParse({ ...draft, category: "c".repeat(61) }).error
        ?.issues[0].message,
    ).toBe("La categoría no puede superar los 60 caracteres.");
  });
});

describe("mock_bank_repository", /** Registra las verificaciones del almacenamiento en memoria. */ () => {
  it("seeds_three_banks_without_files_or_audio", /** Comprueba los bancos y recursos iniciales sin acceso a audio. */ () => {
    const snapshot = createMockRepository().load();
    expect(
      snapshot.banks.map(
        /**
         * Extrae el nombre inicial.
         * @param bank Banco inicial.
         * @returns Su nombre.
         */ (bank) => bank.name,
      ),
    ).toEqual(["En antena", "Humor", "Ambientes"]);
    expect(snapshot.banks[0].buttons.length).toBeGreaterThanOrEqual(8);
    expect(snapshot.banks[0].buttons.length).toBeLessThanOrEqual(12);
    expect(snapshot.banks[2].buttons).toEqual([]);
    for (const bank of snapshot.banks) {
      expect(bank.id).toMatch(/^mock/);
      for (const button of bank.buttons) {
        expect(button.id).toMatch(/^mock/);
        expect(button.effectId).toMatch(/^mock/);
        expect(button.durationMs).toBeGreaterThan(0);
      }
    }
  });

  it("isolates_load_save_and_independent_repositories", /** Comprueba copias profundas al cargar y guardar. */ () => {
    const first = createMockRepository();
    const second = createMockRepository();
    const loaded = first.load();
    loaded.banks[0].buttons[0].name = "Modificado fuera";
    expect(first.load().banks[0].buttons[0].name).not.toBe("Modificado fuera");
    first.save(loaded);
    loaded.banks[0].buttons[0].name = "Otra mutación";
    expect(first.load().banks[0].buttons[0].name).toBe("Modificado fuera");
    expect(second.load().banks[0].buttons[0].name).not.toBe("Modificado fuera");
  });

  it("rejects_invalid_save_without_partial_updates", /** Comprueba atomicidad ante instantáneas inválidas. */ () => {
    const repository = createMockRepository();
    const before = repository.load();
    const invalid = repository.load();
    invalid.banks[0].name = "Cambio que no debe guardarse";
    invalid.activeBankId = "missing";
    expect(
      /** @throws Al intentar guardar un banco activo inexistente. */ () =>
        repository.save(invalid),
    ).toThrow();
    expect(repository.load()).toEqual(before);
  });
});

describe("board_store_resources", /** Registra las verificaciones de operaciones sobre recursos. */ () => {
  it("initializes_independent_stores_and_validates_repository_load", /** Comprueba valores iniciales y validación al cargar. */ () => {
    const { store } = setup();
    expect(store.getState()).toMatchObject({
      version: 1,
      masterVolume: 75,
      columns: "auto",
      demoStates: {},
    });
    store.getState().createBank("Nuevo");
    expect(createBoardStore().getState().banks).toHaveLength(3);
    const repository = createMockRepository();
    const invalid = repository.load();
    invalid.banks = [];
    expect(
      /**
       * Intenta cargar recursos inválidos.
       * @returns Store si la validación lo permite.
       * @throws Por la instantánea sin bancos.
       */ () =>
        createBoardStore({
          ...repository,
          load: /** @returns Instantánea inválida para probar la frontera. */ () =>
            invalid,
        }),
    ).toThrow();
  });

  it("creates_selects_renames_and_deletes_banks_with_active_fallback", /** Comprueba CRUD de bancos y resolución del activo al eliminarlo. */ () => {
    const { store, repository, first, second } = setup();
    const actions = store.getState();
    const id = actions.createBank("  Especiales  ");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.getState().activeBankId).toBe(id);
    expect(store.getState().banks[3]).toEqual({
      id,
      name: "Especiales",
      buttons: [],
    });
    actions.renameBank(id, "  Directo  ");
    expect(store.getState().banks[3].name).toBe("Directo");
    actions.selectBank(second.id);
    actions.deleteBank(id);
    expect(store.getState().activeBankId).toBe(second.id);
    actions.deleteBank(second.id);
    expect(store.getState().activeBankId).toBe(first.id);
    expect(repository.load().activeBankId).toBe(first.id);
  });

  it("prevents_deleting_the_last_bank_with_a_spanish_error", /** Comprueba que siempre se conserva al menos un banco. */ () => {
    const { store, first, second, empty } = setup();
    store.getState().deleteBank(second.id);
    store.getState().deleteBank(empty.id);
    const before = store.getState();
    expect(
      /** @throws Por intentar eliminar el último banco. */ () =>
        store.getState().deleteBank(first.id),
    ).toThrow("último banco");
    expect(store.getState()).toBe(before);
  });

  it("reorders_banks_and_keeps_boundary_moves_as_noops", /** Comprueba orden, avisos accesibles y extremos sin cambios. */ () => {
    const { store, first, second, empty } = setup();
    store.getState().moveBank(second.id, -1);
    expect(store.getState().notice).toBe(
      `Banco "${second.name}": posición 1 de 3.`,
    );
    expect(
      store.getState().banks.map(
        /**
         * Consulta el orden tras adelantar el banco.
         * @param bank Banco ordenado.
         * @returns Su ID.
         */ (bank) => bank.id,
      ),
    ).toEqual([second.id, first.id, empty.id]);
    const before = store.getState();
    store.getState().moveBank(second.id, -1);
    store.getState().moveBank(empty.id, 1);
    expect(store.getState()).toBe(before);
    store.getState().moveBank(second.id, 1);
    expect(store.getState().notice).toBe(
      `Banco "${second.name}": posición 2 de 3.`,
    );
    expect(
      store.getState().banks.map(
        /**
         * Consulta el orden tras retrasar el banco.
         * @param bank Banco ordenado.
         * @returns Su ID.
         */ (bank) => bank.id,
      ),
    ).toEqual([first.id, second.id, empty.id]);
    expect(store.getState().activeBankId).toBe(first.id);
  });

  it("adds_updates_and_deletes_buttons_without_changing_resource_identity", /** Comprueba CRUD de botones conservando sus identificadores. */ () => {
    const { store, repository, first, empty } = setup();
    const actions = store.getState();
    const id = actions.addButton(empty.id, draft);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.getState().banks[2].buttons[0]).toEqual({
      id,
      effectId: null,
      name: "Entrada propia",
      category: "Identidad",
      color: "amber",
      durationMs: 1500,
    });
    actions.setDemoState(id, "paused");
    actions.updateButton(empty.id, id, {
      ...draft,
      name: " Cambio ",
      color: "mint",
      durationMs: 0,
    });
    expect(store.getState().banks[2].buttons[0]).toMatchObject({
      id,
      effectId: null,
      name: "Cambio",
      color: "mint",
      durationMs: 0,
    });
    expect(store.getState().demoStates[id]).toBe("paused");
    const original = first.buttons[0];
    actions.updateButton(first.id, original.id, draft);
    expect(store.getState().banks[0].buttons[0].effectId).toBe(
      original.effectId,
    );
    actions.deleteButton(empty.id, id);
    expect(store.getState().demoStates[id]).toBeUndefined();
    expect(repository.load().banks[2].buttons).toEqual([]);
  });

  it("moves_buttons_to_final_target_positions_and_nudges_both_ways", /** Comprueba movimientos y avisos con posiciones finales desde uno. */ () => {
    const { store, first } = setup();
    const [a, b, c] = first.buttons;
    store.getState().moveButton(first.id, a.id, c.id);
    expect(store.getState().notice).toBe(
      `Botón "${a.name}": posición 3 de ${first.buttons.length}.`,
    );
    expect(
      store
        .getState()
        .banks[0].buttons.slice(0, 3)
        .map(
          /**
           * Consulta el orden final de botones.
           * @param button Botón ordenado.
           * @returns Su ID.
           */ (button) => button.id,
        ),
    ).toEqual([b.id, c.id, a.id]);
    store.getState().moveButton(first.id, a.id, b.id);
    expect(store.getState().banks[0].buttons).toEqual(first.buttons);
    store.getState().nudgeButton(first.id, a.id, 1);
    expect(store.getState().notice).toBe(
      `Botón "${a.name}": posición 2 de ${first.buttons.length}.`,
    );
    expect(store.getState().banks[0].buttons[1].id).toBe(a.id);
    store.getState().nudgeButton(first.id, a.id, -1);
    expect(store.getState().notice).toBe(
      `Botón "${a.name}": posición 1 de ${first.buttons.length}.`,
    );
    const before = store.getState();
    store.getState().moveButton(first.id, a.id, a.id);
    store.getState().nudgeButton(first.id, a.id, -1);
    store
      .getState()
      .nudgeButton(first.id, first.buttons[first.buttons.length - 1].id, 1);
    expect(store.getState()).toBe(before);
  });

  it("rejects_unknown_ids_cross_bank_moves_and_invalid_names_atomically", /** Comprueba rechazos sin alterar recursos ni estados visuales. */ () => {
    const { store, repository, first, second } = setup();
    const actions = store.getState();
    const before = store.getState();
    const persisted = repository.load();
    const invalidActions = [
      /** @throws Por seleccionar un banco inexistente. */ () =>
        actions.selectBank("missing"),
      /**
       * Intenta crear un banco sin nombre.
       * @returns ID si se aceptase.
       * @throws Por el nombre vacío.
       */ () => actions.createBank(" "),
      /**
       * Intenta crear un banco con nombre excesivo.
       * @returns ID si se aceptase.
       * @throws Por superar 80 caracteres.
       */ () => actions.createBank("b".repeat(81)),
      /** @throws Por el nombre vacío. */ () =>
        actions.renameBank(first.id, " "),
      /** @throws Por superar 80 caracteres. */ () =>
        actions.renameBank(first.id, "b".repeat(81)),
      /** @throws Por renombrar un banco inexistente. */ () =>
        actions.renameBank("missing", "Nombre"),
      /** @throws Por eliminar un banco inexistente. */ () =>
        actions.deleteBank("missing"),
      /** @throws Por mover un banco inexistente. */ () =>
        actions.moveBank("missing", 1),
      /**
       * Intenta añadir un botón sin banco válido.
       * @returns ID si se aceptase.
       * @throws Por el banco inexistente.
       */ () => actions.addButton("missing", draft),
      /** @throws Por editar un botón inexistente. */ () =>
        actions.updateButton(first.id, "missing", draft),
      /** @throws Por eliminar un botón ajeno al banco. */ () =>
        actions.deleteButton(first.id, second.buttons[0].id),
      /** @throws Por el destino en otro banco. */ () =>
        actions.moveButton(first.id, first.buttons[0].id, second.buttons[0].id),
      /** @throws Por el origen en otro banco. */ () =>
        actions.moveButton(first.id, second.buttons[0].id, first.buttons[0].id),
      /** @throws Por el banco inexistente, incluso con IDs iguales. */ () =>
        actions.moveButton("missing", "same", "same"),
      /** @throws Por los botones inexistentes, incluso con IDs iguales. */ () =>
        actions.moveButton(first.id, "missing", "missing"),
      /** @throws Por desplazar un botón inexistente. */ () =>
        actions.nudgeButton(first.id, "missing", 1),
      /** @throws Por alternar un botón inexistente. */ () =>
        actions.previewButton("missing"),
      /** @throws Por asignar estado a un botón inexistente. */ () =>
        actions.setDemoState("missing", "playing"),
      /**
       * Comprueba una dirección inválida recibida en ejecución.
       * @returns Resultado si se aceptase.
       * @throws Por la dirección cero.
       */ () => Reflect.apply(actions.moveBank, undefined, [first.id, 0]),
      /**
       * Comprueba un desplazamiento inválido recibido en ejecución.
       * @returns Resultado si se aceptase.
       * @throws Por la dirección fuera del contrato.
       */ () =>
        Reflect.apply(actions.nudgeButton, undefined, [
          first.id,
          first.buttons[0].id,
          2,
        ]),
      /**
       * Comprueba un estado inválido recibido en ejecución.
       * @returns Resultado si se aceptase.
       * @throws Por el estado demo desconocido.
       */ () =>
        Reflect.apply(actions.setDemoState, undefined, [
          first.buttons[0].id,
          "invalid",
        ]),
    ];
    for (const action of invalidActions) {
      expect(action).toThrow();
      expect(store.getState()).toBe(before);
      expect(repository.load()).toEqual(persisted);
    }
  });

  it("rejects_invalid_button_updates_without_partial_changes", /** Comprueba borradores inválidos al crear y editar sin cambios parciales. */ () => {
    const { store, repository, first } = setup();
    const before = store.getState();
    const persisted = repository.load();
    for (const invalid of [
      { color: "red" },
      { name: " " },
      { name: "n".repeat(101) },
      { category: " " },
      { category: "c".repeat(61) },
      { durationMs: -1 },
      { durationMs: NaN },
      { durationMs: 1.5 },
    ]) {
      expect(
        /**
         * Intenta crear un botón con campos inválidos.
         * @returns Resultado si se aceptase.
         * @throws Por el borrador inválido al crear.
         */ () =>
          Reflect.apply(before.addButton, undefined, [
            first.id,
            { ...draft, ...invalid },
          ]),
      ).toThrow();
      expect(
        /**
         * Intenta editar un botón con campos inválidos.
         * @returns Resultado si se aceptase.
         * @throws Por el borrador inválido al editar.
         */ () =>
          Reflect.apply(before.updateButton, undefined, [
            first.id,
            first.buttons[0].id,
            { ...draft, ...invalid },
          ]),
      ).toThrow();
      expect(store.getState()).toBe(before);
      expect(repository.load()).toEqual(persisted);
    }
  });

  it("does_not_publish_any_resource_changes_when_save_fails", /** Comprueba que los fallos de persistencia no publican recursos parciales. */ () => {
    const base = createMockRepository();
    const repository: BankRepository = {
      load: /** @returns Copia de los recursos válidos del repositorio base. */ () =>
        base.load(),
      save: vi.fn(
        /** @throws Siempre, para simular almacenamiento no disponible. */ () => {
          throw new Error("No se pudo guardar.");
        },
      ),
    };
    const store = createBoardStore(repository);
    const before = store.getState();
    const [first, second] = before.banks;
    before.setDemoState(first.buttons[0].id, "playing");
    const visualBefore = store.getState();
    for (const action of [
      /**
       * Intenta crear un banco sin almacenamiento disponible.
       * @returns ID si se guardase.
       * @throws Al guardar el banco nuevo.
       */ () => before.createBank("Nuevo"),
      /** @throws Al guardar la selección. */ () =>
        before.selectBank(second.id),
      /** @throws Al guardar el nombre. */ () =>
        before.renameBank(first.id, "Nuevo"),
      /** @throws Al guardar la eliminación del banco. */ () =>
        before.deleteBank(first.id),
      /** @throws Al guardar el orden de bancos. */ () =>
        before.moveBank(first.id, 1),
      /**
       * Intenta crear un botón sin almacenamiento disponible.
       * @returns ID si se guardase.
       * @throws Al guardar el botón nuevo.
       */ () => before.addButton(first.id, draft),
      /** @throws Al guardar los cambios del botón. */ () =>
        before.updateButton(first.id, first.buttons[0].id, draft),
      /** @throws Al guardar la eliminación del botón. */ () =>
        before.deleteButton(first.id, first.buttons[0].id),
      /** @throws Al guardar el orden de botones. */ () =>
        before.moveButton(first.id, first.buttons[0].id, first.buttons[1].id),
    ]) {
      expect(action).toThrow("No se pudo guardar.");
      expect(store.getState()).toBe(visualBefore);
      expect(base.load()).toEqual({
        version: before.version,
        banks: before.banks,
        activeBankId: before.activeBankId,
      });
    }
  });
});

describe("board_store_visual_state", /** Registra las verificaciones visuales sin motor nativo. */ () => {
  it("cycles_only_visual_button_states_and_keeps_errors_until_reset", /** Comprueba el ciclo demo y la conservación del error. */ () => {
    const { store, first } = setup();
    const id = first.buttons[0].id;
    for (const state of ["playing", "paused", "available"] as const) {
      store.getState().previewButton(id);
      expect(store.getState().demoStates[id]).toBe(state);
    }
    store.getState().setDemoState(id, "error");
    store.getState().previewButton(id);
    expect(store.getState().demoStates[id]).toBe("error");
    expect(store.getState().notice).toContain("no se reproduce audio real");
  });

  it("clears_deleted_bank_demo_states_and_preserves_other_banks", /** Comprueba limpieza de estados exclusivamente del banco eliminado. */ () => {
    const { store, first, second } = setup();
    store.getState().setDemoState(first.buttons[0].id, "playing");
    store.getState().setDemoState(second.buttons[0].id, "error");
    store.getState().deleteBank(first.id);
    expect(store.getState().demoStates).toEqual({
      [second.buttons[0].id]: "error",
    });
  });

  it("stop_all_resets_inactive_banks_and_error_states_without_audio", /** Comprueba el restablecimiento global y el aviso sin audio real. */ () => {
    const { store, first, second } = setup();
    store.getState().setDemoState(first.buttons[0].id, "playing");
    store.getState().setDemoState(first.buttons[1].id, "paused");
    store.getState().setDemoState(second.buttons[0].id, "error");
    store.getState().stopAll();
    expect(
      Object.values(store.getState().demoStates).every(
        /**
         * Verifica que no queda ningún estado visual activo o erróneo.
         * @param state Estado demo consultado.
         * @returns Si está restablecido.
         */ (state) => state === "available",
      ),
    ).toBe(true);
    expect(Object.keys(store.getState().demoStates)).toHaveLength(
      store.getState().banks.flatMap(
        /**
         * Cuenta botones de todos los bancos, no instancias de audio.
         * @param bank Banco consultado.
         * @returns Sus botones.
         */ (bank) => bank.buttons,
      ).length,
    );
    expect(store.getState().notice).toContain("No hay audio real");
  });

  it("validates_volume_and_columns_without_persisting_visual_preferences", /** Comprueba límites visuales y persistencia exclusiva de recursos. */ () => {
    const repository = createMockRepository();
    const save = vi.spyOn(repository, "save");
    const store = createBoardStore(repository);
    const state = store.getState();
    for (const value of [0, 50, 100]) {
      state.setMasterVolume(value);
      expect(store.getState().masterVolume).toBe(value);
    }
    for (const value of [-1, 101, 50.5, NaN, Infinity, -Infinity, "75", null]) {
      const before = store.getState();
      expect(
        /**
         * Intenta asignar un volumen fuera del contrato.
         * @returns Resultado si se aceptase.
         * @throws Por el volumen inválido.
         */ () => Reflect.apply(state.setMasterVolume, undefined, [value]),
      ).toThrow();
      expect(store.getState()).toBe(before);
    }
    for (const value of ["auto", "3", "4", "6"] as const) {
      state.setColumns(value);
      expect(store.getState().columns).toBe(value);
    }
    for (const value of ["2", "5", 3, null, "AUTO"]) {
      const before = store.getState();
      expect(
        /**
         * Intenta asignar una distribución desconocida.
         * @returns Resultado si se aceptase.
         * @throws Por las columnas inválidas.
         */ () => Reflect.apply(state.setColumns, undefined, [value]),
      ).toThrow();
      expect(store.getState()).toBe(before);
    }
    state.previewButton(state.banks[0].buttons[0].id);
    state.stopAll();
    expect(save).not.toHaveBeenCalled();
    state.renameBank(state.banks[0].id, "Persistido");
    expect(save).toHaveBeenCalledOnce();
    expect(Object.keys(repository.load()).sort()).toEqual([
      "activeBankId",
      "banks",
      "version",
    ]);
    const reloaded = createBoardStore(repository).getState();
    expect(reloaded).toMatchObject({
      masterVolume: 75,
      columns: "auto",
      demoStates: {},
    });
    expect(reloaded.banks[0].name).toBe("Persistido");
  });
});
