// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  keyChordSchema,
  shortcutProblem,
  type ShortcutBinding,
} from "../src/features/keyboard-shortcuts/contracts";
import {
  eventChord,
  resolveShortcut,
} from "../src/features/keyboard-shortcuts/dispatch";
import {
  librarySnapshotSchema,
  bankImportPreparationSchema,
  bankImportCommitSchema,
  bankExportResultSchema,
} from "../src/shared/contracts/library";
import {
  audioEngineStatusSchema,
  playbackOptionsSchema,
} from "../src/shared/contracts/audio";
import { normalizeSearch } from "../src/shared/search";
import { librarySnapshot } from "./library-fixtures";
import { nativeStatus } from "./native-fixtures";

/** @param patch Variación del atajo base. @returns Atajo válido de aplicación. */
function binding(patch: Partial<ShortcutBinding> = {}): ShortcutBinding {
  return {
    id: "shortcut-1",
    scope: "application",
    scopeBankId: null,
    enabled: true,
    chord: { code: "KeyA", ctrl: false, alt: false, shift: false, meta: false },
    action: { kind: "play_button", targetId: "button-1" },
    ...patch,
  };
}
afterEach(() => document.body.replaceChildren());

describe("professional strict contracts", () => {
  it("rejects production v1 without changing the separate demo contract", () => {
    const snapshot = librarySnapshot();
    expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      librarySnapshotSchema.safeParse({
        ...snapshot,
        board: { ...snapshot.board, version: 1 },
      }).success,
    ).toBe(false);
    const { playback: _omitted, ...oldButton } =
      snapshot.board.banks[0].buttons[0];
    expect(_omitted).toEqual({ looped: false, fadeInMs: 0, fadeOutMs: 0 });
    expect(
      librarySnapshotSchema.safeParse({
        ...snapshot,
        board: {
          ...snapshot.board,
          banks: [{ ...snapshot.board.banks[0], buttons: [oldButton] }],
        },
      }).success,
    ).toBe(false);
  });
  it.each([-1, 30001, 1.1, NaN, Infinity])(
    "rejects invalid fade %s",
    (value) => {
      expect(
        playbackOptionsSchema.safeParse({
          looped: false,
          fadeInMs: value,
          fadeOutMs: 0,
        }).success,
      ).toBe(false);
    },
  );
  it("checks one-shot fades against catalog duration but allows loop envelopes", () => {
    const snapshot = librarySnapshot();
    snapshot.board.banks[0].buttons[0].playback = {
      looped: false,
      fadeInMs: 800,
      fadeOutMs: 500,
    };
    expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(false);
    snapshot.board.banks[0].buttons[0].playback.looped = true;
    expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it("requires native loop and finishing fields and rejects unknown voice data", () => {
    const voice = { playback_id: "v", effect_id: "e", volume: 0.5 };
    expect(
      audioEngineStatusSchema.safeParse(nativeStatus({ active_playbacks: [] }))
        .success,
    ).toBe(true);
    expect(
      audioEngineStatusSchema.safeParse({
        ...nativeStatus(),
        active_playbacks: [voice],
      }).success,
    ).toBe(false);
    const full = {
      ...voice,
      looped: true,
      state: "fading_out",
      fade_out_ms: 30000,
    };
    expect(
      audioEngineStatusSchema.safeParse({
        ...nativeStatus(),
        active_playbacks: [full],
      }).success,
    ).toBe(true);
    expect(
      audioEngineStatusSchema.safeParse({
        ...nativeStatus(),
        active_playbacks: [{ ...full, state: "paused" }],
      }).success,
    ).toBe(false);
    expect(
      audioEngineStatusSchema.safeParse({
        ...nativeStatus(),
        active_playbacks: [{ ...full, progress: 0.5 }],
      }).success,
    ).toBe(false);
  });
  it.each([
    "F5",
    "Escape",
    "Enter",
    "KeyAA",
    "F13",
    "NumpadAdd",
    "Unidentified",
  ])("rejects disallowed code %s", (code) => {
    expect(keyChordSchema.safeParse({ ...binding().chord, code }).success).toBe(
      false,
    );
  });
  it.each(["KeyR", "KeyW", "KeyL", "KeyT", "KeyN", "KeyQ"])(
    "rejects Ctrl or Meta plus %s even disabled",
    (code) => {
      const banks = librarySnapshot().board.banks;
      for (const modifier of ["ctrl", "meta"])
        expect(
          shortcutProblem(
            [
              binding({
                enabled: false,
                chord: { ...binding().chord, code, [modifier]: true },
              }),
            ],
            banks,
          ),
        ).not.toBeNull();
    },
  );
  it("reserves emergency with additional modifiers and Alt F4", () => {
    for (const chord of [
      {
        ...binding().chord,
        code: "Space",
        ctrl: true,
        shift: true,
        alt: true,
        meta: true,
      },
      { ...binding().chord, code: "F4", alt: true },
    ])
      expect(keyChordSchema.safeParse(chord).success).toBe(false);
  });
  it("matches backend scope conflicts and permits disabled collisions and distinct banks", () => {
    const banks = [
      ...librarySnapshot().board.banks,
      {
        id: "bank-2",
        name: "Segundo",
        buttons: [
          { ...librarySnapshot().board.banks[0].buttons[0], id: "button-3" },
        ],
      },
    ];
    const a = binding({ scope: "bank", scopeBankId: "bank-1" });
    const b = binding({
      id: "shortcut-2",
      scope: "bank",
      scopeBankId: "bank-2",
      action: { kind: "play_button", targetId: "button-3" },
    });
    expect(shortcutProblem([a, b], banks)).toBeNull();
    expect(
      shortcutProblem(
        [a, { ...b, scope: "application", scopeBankId: null }],
        banks,
      ),
    ).toContain("Conflicto");
    expect(
      shortcutProblem(
        [a, { ...b, scopeBankId: "bank-1", action: a.action }],
        banks,
      ),
    ).toContain("Conflicto");
    expect(
      shortcutProblem(
        [a, { ...b, scopeBankId: "bank-1", action: a.action, enabled: false }],
        banks,
      ),
    ).toBeNull();
    expect(shortcutProblem([a, a], banks)).toContain("únicos");
    expect(
      shortcutProblem([binding({ scopeBankId: "bank-1" })], banks),
    ).not.toBeNull();
    expect(
      shortcutProblem(
        [binding({ action: { kind: "stop_all", targetId: "button-1" } })],
        banks,
      ),
    ).not.toBeNull();
    expect(
      shortcutProblem(
        [binding({ scope: "bank", scopeBankId: "bank-2" })],
        banks,
      ),
    ).not.toBeNull();
    expect(
      shortcutProblem(
        [binding({ action: { kind: "select_bank", targetId: "missing" } })],
        banks,
      ),
    ).not.toBeNull();
  });
  it("limits shortcut count to 512", () => {
    const snapshot = librarySnapshot();
    snapshot.board.keyboardShortcuts = Array.from({ length: 513 }, (_, index) =>
      binding({ id: `s-${index}`, enabled: false }),
    );
    expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
  it("validates package cancellation coherence, snapshot references and unknown payloads", () => {
    expect(
      bankImportPreparationSchema.safeParse({ cancelled: false, preview: null })
        .success,
    ).toBe(false);
    expect(
      bankImportPreparationSchema.safeParse({
        cancelled: true,
        preview: null,
        path: "/tmp/a",
      }).success,
    ).toBe(false);
    expect(
      bankImportCommitSchema.safeParse({
        snapshot: librarySnapshot(),
        importedBankIds: ["missing"],
        reusedEffects: 0,
        warnings: [],
      }).success,
    ).toBe(false);
    expect(
      bankExportResultSchema.safeParse({
        cancelled: true,
        exportedBanks: 1,
        exportedEffects: 0,
        byteSize: 0,
        warnings: [],
      }).success,
    ).toBe(false);
  });
  it("normalizes accents and case for local searches", () => {
    expect(normalizeSearch("  TRANSICIÓN  ")).toBe("transicion");
  });
});

describe("physical shortcut dispatch", () => {
  it("ignores IME repeats and AltGraph", () => {
    for (const init of [{ isComposing: true }, { repeat: true }])
      expect(
        eventChord(new KeyboardEvent("keydown", { code: "KeyA", ...init })),
      ).toBeNull();
    const event = new KeyboardEvent("keydown", { code: "KeyA" });
    Object.defineProperty(event, "getModifierState", {
      value: (key: string) => key === "AltGraph",
    });
    expect(eventChord(event)).toBeNull();
  });
  it.each([
    "input",
    "textarea",
    "select",
    "div[contenteditable]",
    "div[data-shortcut-capture]",
    "div[role=dialog]",
  ])("ignores editable or modal target %s", (selector) => {
    const tag = selector.split("[")[0];
    const target = document.createElement(tag);
    if (selector.includes("contenteditable"))
      target.setAttribute("contenteditable", "true");
    if (selector.includes("data-shortcut-capture"))
      target.setAttribute("data-shortcut-capture", "true");
    if (selector.includes("role=")) target.setAttribute("role", "dialog");
    document.body.append(target);
    let result: ShortcutBinding | null = binding();
    target.addEventListener("keydown", (event) => {
      if (event instanceof KeyboardEvent)
        result = resolveShortcut(event, [binding()], "bank-1");
    });
    target.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyA", bubbles: true }),
    );
    expect(result).toBeNull();
  });
  it("resolves against confirmed active scope and ignores all ordinary actions with a modal open", () => {
    const event = new KeyboardEvent("keydown", { code: "KeyA", key: "q" });
    const scoped = binding({ scope: "bank", scopeBankId: "bank-2" });
    expect(resolveShortcut(event, [scoped], "bank-1")).toBeNull();
    expect(resolveShortcut(event, [scoped], "bank-2")).toEqual(scoped);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(resolveShortcut(event, [binding()], "bank-1")).toBeNull();
  });
});
