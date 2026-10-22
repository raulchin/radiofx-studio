// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Soundboard } from "../src/features/soundboard/Soundboard";
import { createBoardStore } from "../src/features/soundboard/store";

afterEach(cleanup);

/** Conserva las etiquetas completas cuando los nombres y estados se presentan en tarjetas compactas. */
function preservesFullLabelsInCompactCards() {
  const initial = createBoardStore().getState().banks[0];
  const button = {
    ...initial.buttons[0],
    name: "Cortinilla con un nombre largo para identificar el efecto sin perder su etiqueta completa",
    category: "Identidad de la emisora y transiciones entre programas",
  };
  const error =
    "Archivo ausente: vuelve a importar el original para recuperar el sonido sin perder su asignación.";
  const { container } = render(
    <Soundboard
      bank={{ ...initial, buttons: [button] }}
      demoStates={{}}
      nativeStates={{
        [button.id]: { label: error, playable: false, count: 0 },
      }}
      columns="auto"
      onPreview={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onMove={vi.fn()}
      onDrop={vi.fn()}
      onAdd={vi.fn()}
    />,
  );

  const trigger = screen.getByRole<HTMLButtonElement>("button", {
    name: `Disparar ${button.name}`,
  });
  expect(trigger.disabled).toBe(true);
  expect(container.querySelector(".pad-name")?.getAttribute("title")).toBe(
    button.name,
  );
  expect(screen.getByTitle(button.category).textContent).toBe(button.category);
  expect(screen.getByTitle(error).textContent).toBe(error);
  expect(trigger.getAttribute("aria-describedby")).toBe(`state-${button.id}`);
}

it(
  "preserves_full_labels_and_error_descriptions_in_compact_cards",
  preservesFullLabelsInCompactCards,
);
