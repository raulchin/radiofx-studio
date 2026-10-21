// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../src/app/App";
import { createBoardStore } from "../src/features/soundboard/store";

/**
 * Suple la apertura modal ausente en jsdom y su foco inicial, no su top layer.
 * La restauración al invocador corresponde al componente Modal real.
 * @param this Diálogo que se abre.
 */
function showModal(this: HTMLDialogElement): void {
  this.setAttribute("open", "");
  this.querySelector<HTMLElement>("button, input, select")?.focus();
}

/**
 * Suple el cierre nativo sin simular restauración de foco ni eventos de usuario.
 * @param this Diálogo que se cierra.
 */
function closeDialog(this: HTMLDialogElement): void {
  this.removeAttribute("open");
}

/** Prepara únicamente las APIs de diálogo ausentes y una aplicación aislada. */
function setupBoard(): void {
  if (!HTMLDialogElement.prototype.showModal) {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: showModal,
    });
  }
  if (!HTMLDialogElement.prototype.close) {
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: closeDialog,
    });
  }
  render(<App store={createBoardStore()} />);
}

/** Desmonta React y limpia el DOM incluso cuando una aserción falla. */
function cleanupBoard(): void {
  cleanup();
}

/**
 * Consulta los nombres en el orden accesible de la cuadrícula real.
 * @returns Nombres de los disparadores, sin incluir herramientas de edición.
 */
function buttonOrder(): (string | null)[] {
  return within(screen.getByRole("list", { name: "Efectos de En antena" }))
    .getAllByRole("button", { name: /^Demostrar / })
    .map(
      /** @param button Disparador de una tarjeta. @returns Nombre accesible. */
      (button) => button.getAttribute("aria-label"),
    );
}

beforeEach(setupBoard);
afterEach(cleanupBoard);

describe("soundboard DOM interactions", () => {
  /** Comprueba que navegación y selector comparten el banco activo. */
  it("switches banks through navigation and the header selector", async () => {
    const user = userEvent.setup();
    const navigation = within(
      screen.getByRole("navigation", { name: "Bancos de sonidos" }),
    );
    expect(screen.getByRole("heading", { name: "En antena" })).toBeTruthy();
    await user.click(navigation.getByRole("button", { name: /Humor/ }));
    expect(screen.getByRole("heading", { name: "Humor" })).toBeTruthy();
    expect(
      navigation
        .getByRole("button", { name: /Humor/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByLabelText<HTMLSelectElement>("Banco activo").value).toBe(
      "mock-bank-humor",
    );
    expect(screen.getByRole("list", { name: "Efectos de Humor" })).toBeTruthy();

    await user.selectOptions(
      screen.getByLabelText("Banco activo"),
      "Ambientes",
    );
    expect(screen.getByRole("heading", { name: "Ambientes" })).toBeTruthy();
    expect(
      navigation
        .getByRole("button", { name: /Ambientes/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("heading", { name: "Este banco está por estrenar" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Agregar primer botón" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("list", { name: "Efectos de Ambientes" }),
    ).toBeNull();
    expect(screen.getByText("0 efectos en este banco")).toBeTruthy();
  });

  /** Verifica creación, renombrado y reordenación sin acceder a acciones del store. */
  it("creates renames and reorders a bank", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ Banco" }));
    let dialog = within(screen.getByRole("dialog", { name: "Crear banco" }));
    await user.type(dialog.getByLabelText("Nombre del banco"), "Directo");
    await user.click(dialog.getByRole("button", { name: "Crear banco" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Directo" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Organizar bancos" }));
    dialog = within(screen.getByRole("dialog", { name: "Organizar bancos" }));
    expect(
      dialog.getByRole<HTMLButtonElement>("button", {
        name: "Bajar banco Directo",
      }).disabled,
    ).toBe(true);
    await user.click(
      dialog.getByRole("button", { name: "Subir banco Directo" }),
    );
    expect(dialog.getAllByRole("listitem")[2].textContent).toContain("Directo");
    await user.click(dialog.getByRole("button", { name: "Renombrar Directo" }));
    dialog = within(screen.getByRole("dialog", { name: "Renombrar banco" }));
    await user.clear(dialog.getByLabelText("Nombre del banco"));
    await user.type(dialog.getByLabelText("Nombre del banco"), "Especial");
    await user.click(dialog.getByRole("button", { name: "Guardar nombre" }));
    expect(screen.getByRole("heading", { name: "Especial" })).toBeTruthy();
    const navigation = within(
      screen.getByRole("navigation", { name: "Bancos de sonidos" }),
    );
    expect(navigation.getAllByRole("button")[2].textContent).toContain(
      "Especial",
    );
    expect(screen.queryByRole("option", { name: "Directo" })).toBeNull();
  });

  /** Comprueba cancelación, confirmación, fallback activo y protección del último banco. */
  it("cancels bank deletion and prevents deleting the final bank", async () => {
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByLabelText("Banco activo"),
      "Ambientes",
    );
    await user.click(screen.getByRole("button", { name: "Organizar bancos" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Eliminar banco Ambientes",
      }),
    );
    let dialog = within(screen.getByRole("dialog", { name: "Eliminar banco" }));
    expect(dialog.getByText("Ambientes", { selector: "strong" })).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByRole("heading", { name: "Ambientes" })).toBeTruthy();

    for (const name of ["Ambientes", "Humor"]) {
      await user.click(
        screen.getByRole("button", { name: "Organizar bancos" }),
      );
      await user.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: `Eliminar banco ${name}`,
        }),
      );
      dialog = within(screen.getByRole("dialog", { name: "Eliminar banco" }));
      await user.click(dialog.getByRole("button", { name: "Eliminar banco" }));
      expect(screen.queryByRole("option", { name })).toBeNull();
    }
    expect(screen.getByRole("heading", { name: "En antena" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Organizar bancos" }));
    dialog = within(screen.getByRole("dialog", { name: "Organizar bancos" }));
    const remove = dialog.getByRole<HTMLButtonElement>("button", {
      name: "Eliminar banco En antena",
    });
    expect(remove.disabled).toBe(true);
    await user.click(remove);
    expect(
      screen.getByRole("dialog", { name: "Organizar bancos" }),
    ).toBeTruthy();
    expect(dialog.getAllByRole("listitem")).toHaveLength(1);
  });

  /** Crea y edita metadatos y estados demo antes de cancelar y confirmar el borrado. */
  it("adds edits and deletes a button in an empty bank", async () => {
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByLabelText("Banco activo"),
      "Ambientes",
    );
    await user.click(
      screen.getByRole("button", { name: "Agregar primer botón" }),
    );
    let dialog = within(screen.getByRole("dialog", { name: "Agregar botón" }));
    await user.type(dialog.getByLabelText("Nombre del efecto"), "Lluvia");
    await user.clear(dialog.getByLabelText("Categoría"));
    await user.type(dialog.getByLabelText("Categoría"), "Naturaleza");
    await user.clear(dialog.getByLabelText("Duración mock (segundos)"));
    await user.type(
      dialog.getByLabelText("Duración mock (segundos)"),
      "12.345",
    );
    await user.click(dialog.getByRole("radio", { name: "Menta" }));
    await user.selectOptions(
      dialog.getByLabelText("Estado visual (mock)"),
      "playing",
    );
    await user.click(dialog.getByRole("button", { name: "Crear botón" }));
    const card = screen.getByRole("listitem");
    expect(card.classList.contains("tone-mint")).toBe(true);
    expect(card.classList.contains("state-playing")).toBe(true);
    expect(within(card).getByText("Naturaleza")).toBeTruthy();
    expect(within(card).getByText("00:12.3")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Demostrar Lluvia" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "Editar Lluvia" }));
    dialog = within(screen.getByRole("dialog", { name: "Editar botón" }));
    expect(
      dialog.getByLabelText<HTMLInputElement>("Duración mock (segundos)").value,
    ).toBe("12.345");
    expect(
      dialog.getByRole<HTMLInputElement>("radio", { name: "Menta" }).checked,
    ).toBe(true);
    await user.clear(dialog.getByLabelText("Nombre del efecto"));
    await user.type(dialog.getByLabelText("Nombre del efecto"), "Tormenta");
    await user.click(dialog.getByRole("radio", { name: "Violeta" }));
    await user.selectOptions(
      dialog.getByLabelText("Estado visual (mock)"),
      "error",
    );
    await user.click(dialog.getByRole("button", { name: "Guardar cambios" }));
    expect(card.classList.contains("tone-violet")).toBe(true);
    expect(within(card).getByText("Error · demo")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Editar Tormenta" }));
    dialog = within(screen.getByRole("dialog"));
    await user.clear(dialog.getByLabelText("Nombre del efecto"));
    await user.type(dialog.getByLabelText("Nombre del efecto"), "Descartado");
    await user.click(dialog.getByRole("button", { name: "Cancelar" }));
    expect(
      screen.queryByRole("button", { name: "Demostrar Descartado" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Eliminar Tormenta" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Eliminar botón" })).getByRole(
        "button",
        { name: "Cancelar" },
      ),
    );
    expect(
      screen.getByRole("button", { name: "Demostrar Tormenta" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Eliminar Tormenta" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Eliminar botón" })).getByRole(
        "button",
        { name: "Eliminar botón" },
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Demostrar Tormenta" }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Este banco está por estrenar" }),
    ).toBeTruthy();
    expect(screen.getByText("0 botones activos en demo")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Ambientes" }),
    );
  });

  /** Rechaza nombres de efecto vacíos tras trim sin cerrar el formulario. */
  it("keeps the button dialog open with a visible Zod validation error", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ Agregar botón" }));
    const element = screen.getByRole("dialog", { name: "Agregar botón" });
    const dialog = within(element);
    await user.type(dialog.getByLabelText("Nombre del efecto"), "   ");
    await user.click(dialog.getByRole("button", { name: "Crear botón" }));
    expect(dialog.getByRole("alert").textContent).toBe(
      "El nombre es obligatorio.",
    );
    expect(element.hasAttribute("open")).toBe(true);
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    await user.type(dialog.getByLabelText("Nombre del efecto"), "Válido");
    await user.click(dialog.getByRole("button", { name: "Crear botón" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Demostrar Válido" }),
    ).toBeTruthy();
  });

  /** Comprueba también la validación Zod del formulario de bancos. */
  it("rejects a whitespace bank name without closing its dialog", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ Banco" }));
    const dialog = within(screen.getByRole("dialog", { name: "Crear banco" }));
    await user.type(dialog.getByLabelText("Nombre del banco"), "   ");
    await user.click(dialog.getByRole("button", { name: "Crear banco" }));
    expect(dialog.getByRole("alert").textContent).toMatch(
      /nombre.*obligatorio/i,
    );
    expect(
      screen.getByRole("dialog", { name: "Crear banco" }).hasAttribute("open"),
    ).toBe(true);
    expect(
      within(screen.getByLabelText("Banco activo")).getAllByRole("option"),
    ).toHaveLength(3);
  });

  /** Usa Tab, Enter y espacio sobre controles reales para mover una tarjeta. */
  it("reorders buttons using keyboard controls and respects boundaries", async () => {
    const user = userEvent.setup();
    const initial = buttonOrder();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Mover Cortinilla de entrada antes",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Mover Aviso breve después",
      }).disabled,
    ).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Demostrar Cortinilla de entrada" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: "Mover Cortinilla de entrada después",
      }),
    );
    await user.keyboard("{Enter}");
    expect(buttonOrder()).toEqual([
      initial[1],
      initial[0],
      ...initial.slice(2),
    ]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Mover Cortinilla de entrada antes" }),
    );
    await user.keyboard(" ");
    expect(buttonOrder()).toEqual(initial);
  });

  /** Verifica el payload de arrastre real y la nueva posición de las tarjetas. */
  it("reorders buttons by dragging their handle onto a target card", () => {
    const initial = buttonOrder();
    const cards = screen.getAllByRole("listitem");
    const handle = cards[0].querySelector(".drag-handle");
    if (!handle) throw new Error("No se encontró el asa de arrastre.");
    const payload = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "uninitialized",
      dropEffect: "none",
      /** @returns Formatos escritos por el manejador real de arrastre. */
      get types() {
        return [...payload.keys()];
      },
      /** @param type Formato solicitado. @returns Dato transferido o cadena vacía. */
      getData(type: string): string {
        return payload.get(type) ?? "";
      },
      /** @param type Formato escrito. @param value Identificador de origen. */
      setData(type: string, value: string): void {
        payload.set(type, value);
      },
    };
    fireEvent.dragStart(handle, { dataTransfer });
    expect(dataTransfer.types).toEqual(["application/x-radiofx-button"]);
    expect(dataTransfer.getData("application/x-radiofx-button")).toBe(
      "mock-button-opener",
    );
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(fireEvent.dragOver(cards[2], { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("move");
    fireEvent.drop(cards[2], { dataTransfer });
    expect(buttonOrder()).toEqual([
      initial[1],
      initial[2],
      initial[0],
      ...initial.slice(3),
    ]);
    const moved = screen.getAllByRole("listitem")[2];
    expect(within(moved).getByText("03")).toBeTruthy();
    expect(
      within(moved)
        .getByRole("button", { name: "Demostrar Cortinilla de entrada" })
        .getAttribute("aria-describedby"),
    ).toBe("state-mock-button-opener");
  });

  /** Alterna demo y pausa; restablecer demo afecta también bancos no visibles. */
  it("cycles demo states and resets all banks without real playbacks", async () => {
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Demostrar Aplausos" });
    await user.click(trigger);
    expect(trigger.getAttribute("aria-pressed")).toBe("true");
    expect(within(trigger).getByText("Reproduciendo · demo")).toBeTruthy();
    await user.click(trigger);
    expect(trigger.getAttribute("aria-pressed")).toBe("false");
    expect(within(trigger).getByText("Pausado · demo")).toBeTruthy();
    expect(screen.getByText("0 botones activos en demo")).toBeTruthy();
    await user.click(trigger);
    expect(within(trigger).getByText("Disponible")).toBeTruthy();
    await user.click(trigger);
    await user.selectOptions(screen.getByLabelText("Banco activo"), "Humor");
    await user.click(
      screen.getByRole("button", { name: "Demostrar Risa cómplice" }),
    );
    expect(screen.getByText("2 botones activos en demo")).toBeTruthy();
    expect(
      within(screen.getByRole("contentinfo")).getByText(
        "Demo visual, no representa motor nativo",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restablecer demo" }));
    expect(screen.getByText("0 botones activos en demo")).toBeTruthy();
    expect(
      within(
        screen.getByRole("button", { name: "Demostrar Risa cómplice" }),
      ).getByText("Disponible"),
    ).toBeTruthy();
    await user.selectOptions(
      screen.getByLabelText("Banco activo"),
      "En antena",
    );
    expect(
      within(
        screen.getByRole("button", { name: "Demostrar Aplausos" }),
      ).getByText("Disponible"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("contentinfo")).getByText(
        "Demo visual, no representa motor nativo",
      ),
    ).toBeTruthy();
  });

  /** Cambia el range sin APIs de audio y comprueba el porcentaje presentado. */
  it("updates the demo master volume through its range input", () => {
    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: "Volumen maestro (demo)",
    });
    expect(slider.value).toBe("75");
    for (const value of [32, 0, 100]) {
      fireEvent.change(slider, { target: { value: String(value) } });
      expect(slider.value).toBe(String(value));
      expect(screen.getByText(`${value}%`)).toBeTruthy();
    }
    expect(
      within(screen.getByRole("contentinfo")).getByText(
        "Demo visual, no representa motor nativo",
      ),
    ).toBeTruthy();
  });

  /** Ajusta columnas y muestra el diagnóstico real de navegador sin mocks IPC. */
  it("changes grid columns and reports unavailable native diagnostics", async () => {
    const user = userEvent.setup();
    const opener = screen.getByRole("button", { name: "Configuración" });
    await user.click(opener);
    const dialog = within(
      screen.getByRole("dialog", { name: "Configuración visual" }),
    );
    const close = dialog.getByRole("button", { name: "Cerrar diálogo" });
    const diagnostic = dialog.getByRole("button", {
      name: "Comprobar backend nativo",
    });
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(diagnostic);
    await user.tab();
    expect(document.activeElement).toBe(close);
    const columns = dialog.getByLabelText("Distribución de la cuadrícula");
    for (const value of ["3", "4", "6", "auto"]) {
      await user.selectOptions(columns, value);
      expect(
        screen
          .getByRole("list", { name: "Efectos de En antena" })
          .classList.contains(`columns-${value}`),
      ).toBe(true);
    }
    await user.click(
      dialog.getByRole("button", { name: "Comprobar backend nativo" }),
    );
    expect(
      (
        await dialog.findByText(
          "No se pudo verificar el backend. Abre la aplicación de escritorio y vuelve a intentarlo.",
        )
      ).getAttribute("role"),
    ).toBe("status");
    expect(
      dialog.getByRole<HTMLButtonElement>("button", {
        name: "Comprobar backend nativo",
      }).disabled,
    ).toBe(false);
    await user.click(dialog.getByRole("button", { name: "Cerrar diálogo" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
