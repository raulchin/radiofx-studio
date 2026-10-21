import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import App from "../src/app/App";
import { SettingsPanel } from "../src/features/settings/SettingsPanel";
import { createBoardStore } from "../src/features/soundboard/store";

/** Comprueba la demo y el panel nativo sin iniciar audio durante SSR. */
function rendersMockAndNativePanelWithoutBrowserAudio() {
  const html = renderToStaticMarkup(<App store={createBoardStore()} />);
  expect(html).toContain("RadioFX");
  expect(html).toContain("Demo visual, no representa motor nativo");
  expect(html).toContain("MODO MOCK");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("<audio");
  expect(html).toContain("STOP ALL");
  expect(html).toContain("Audio nativo no disponible / conectando");
}

/** Conserva el diagnóstico explícito sin atribuir un estado al motor en SSR. */
function preservesNativeDiagnosticInSettings() {
  /** No cambia preferencias durante un renderizado estático. */
  function ignoreColumnsChange() {}
  const html = renderToStaticMarkup(
    <SettingsPanel columns="auto" onColumnsChange={ignoreColumnsChange} />,
  );
  expect(html).toContain("Comprobar backend nativo");
  expect(html).toContain(
    "Diagnóstico manual pendiente; el panel nativo muestra el estado de la sesión.",
  );
}

it(
  "renders_mock_and_native_panel_without_browser_audio",
  rendersMockAndNativePanelWithoutBrowserAudio,
);
it(
  "preserves_native_diagnostic_in_settings",
  preservesNativeDiagnosticInSettings,
);
