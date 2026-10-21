import { boardSnapshotSchema, type BoardSnapshot } from "./models";

export interface BankRepository {
  /**
   * Carga una copia validada de los recursos.
   * @returns Instantánea independiente del almacenamiento.
   * @throws Si los recursos almacenados no son válidos.
   */
  load(): BoardSnapshot;
  /**
   * Guarda una copia validada sin modificar el almacenamiento ante errores.
   * @param snapshot Recursos que se deben conservar.
   * @throws Si la instantánea no cumple el contrato.
   */
  save(snapshot: BoardSnapshot): void;
}

/**
 * Crea un repositorio aislado de demostración, sin archivos ni audio.
 * @returns Repositorio con tres bancos propios almacenados en memoria.
 * @throws Si los datos iniciales incumplen el contrato.
 */
export function createMockRepository(): BankRepository {
  let stored = boardSnapshotSchema.parse({
    version: 1,
    activeBankId: "mock-bank-on-air",
    banks: [
      {
        id: "mock-bank-on-air",
        name: "En antena",
        buttons: [
          {
            id: "mock-button-opener",
            effectId: "mock-effect-opener",
            name: "Cortinilla de entrada",
            durationMs: 4200,
            color: "amber",
            category: "Identidad",
          },
          {
            id: "mock-button-applause",
            effectId: "mock-effect-applause",
            name: "Aplausos",
            durationMs: 3100,
            color: "coral",
            category: "Público",
          },
          {
            id: "mock-button-transition",
            effectId: "mock-effect-transition",
            name: "Transición",
            durationMs: 1200,
            color: "sky",
            category: "Identidad",
          },
          {
            id: "mock-button-news",
            effectId: "mock-effect-news",
            name: "Boletín",
            durationMs: 2600,
            color: "violet",
            category: "Informativos",
          },
          {
            id: "mock-button-bell",
            effectId: "mock-effect-bell",
            name: "Campanilla",
            durationMs: 850,
            color: "mint",
            category: "Señales",
          },
          {
            id: "mock-button-drumroll",
            effectId: "mock-effect-drumroll",
            name: "Redoble",
            durationMs: 2300,
            color: "amber",
            category: "Percusión",
          },
          {
            id: "mock-button-countdown",
            effectId: "mock-effect-countdown",
            name: "Cuenta atrás",
            durationMs: 3000,
            color: "slate",
            category: "Señales",
          },
          {
            id: "mock-button-closing",
            effectId: "mock-effect-closing",
            name: "Cierre de bloque",
            durationMs: 3800,
            color: "sky",
            category: "Identidad",
          },
          {
            id: "mock-button-success",
            effectId: "mock-effect-success",
            name: "Acierto",
            durationMs: 950,
            color: "mint",
            category: "Concurso",
          },
          {
            id: "mock-button-alert",
            effectId: "mock-effect-alert",
            name: "Aviso breve",
            durationMs: 650,
            color: "coral",
            category: "Señales",
          },
        ],
      },
      {
        id: "mock-bank-humor",
        name: "Humor",
        buttons: [
          {
            id: "mock-button-laugh",
            effectId: "mock-effect-laugh",
            name: "Risa cómplice",
            durationMs: 1800,
            color: "coral",
            category: "Humor",
          },
          {
            id: "mock-button-boing",
            effectId: "mock-effect-boing",
            name: "Rebote",
            durationMs: 700,
            color: "violet",
            category: "Humor",
          },
          {
            id: "mock-button-crickets",
            effectId: "mock-effect-crickets",
            name: "Grillos",
            durationMs: 2400,
            color: "mint",
            category: "Humor",
          },
        ],
      },
      { id: "mock-bank-ambience", name: "Ambientes", buttons: [] },
    ],
  });

  return {
    /**
     * Carga los recursos sin compartir referencias internas.
     * @returns Copia profunda validada.
     * @throws Si los recursos almacenados incumplen el contrato.
     */
    load() {
      return boardSnapshotSchema.parse(stored);
    },
    /**
     * Sustituye los recursos solo después de validarlos y copiarlos.
     * @param snapshot Recursos nuevos.
     * @throws Si la instantánea no es válida.
     */
    save(snapshot) {
      stored = boardSnapshotSchema.parse(snapshot);
    },
  };
}
