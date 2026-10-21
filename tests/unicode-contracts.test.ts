import { describe, expect, it } from "vitest";
import {
  bankImportCommitSchema,
  bankImportPreparationSchema,
  importResultSchema,
  librarySnapshotSchema,
  type LibrarySnapshot,
} from "../src/shared/contracts/library";
import { codePointString } from "../src/shared/contracts/text";
import {
  keyChordSchema,
  shortcutBindingSchema,
  type ShortcutBinding,
} from "../src/features/keyboard-shortcuts/contracts";
import { LibraryController } from "../src/features/sound-library/library-controller";
import { fakeLibrary, librarySnapshot } from "./library-fixtures";

const nonBmp = "\u{1f3b5}";
const nameFields: [
  string,
  number,
  (snapshot: LibrarySnapshot, value: string) => void,
][] = [
  [
    "bank",
    60,
    (snapshot, value) => {
      snapshot.board.banks[0].name = value;
    },
  ],
  [
    "button",
    100,
    (snapshot, value) => {
      snapshot.board.banks[0].buttons[0].name = value;
    },
  ],
  [
    "category",
    80,
    (snapshot, value) => {
      snapshot.board.banks[0].buttons[0].category = value;
    },
  ],
  [
    "resource",
    100,
    (snapshot, value) => {
      snapshot.effects[0].name = value;
    },
  ],
];

describe("production Unicode code point limits", () => {
  /** Compara White_Space de Unicode con trim de Rust, sin el BOM que trim de JavaScript sí elimina. */
  it("matches Rust Unicode whitespace semantics for persisted names and shortcut IDs", () => {
    for (const value of ["\uFEFF", "\u200B", "\uFEFF "]) {
      const snapshot = librarySnapshot();
      snapshot.board.banks[0].name = value;
      snapshot.board.banks[0].id = value;
      snapshot.board.activeBankId = value;
      snapshot.board.keyboardShortcuts = [
        {
          id: value,
          scope: "application",
          scopeBankId: null,
          chord: {
            code: "KeyA",
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
          },
          action: { kind: "stop_all", targetId: null },
          enabled: false,
        },
      ];
      expect(librarySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    }
    for (const value of ["\u00A0", "\u2007", "\u202F", "\u3000"]) {
      const snapshot = librarySnapshot();
      snapshot.board.banks[0].name = value;
      expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(false);
    }
  });
  it.each(nameFields)(
    "counts %s names by Rust code points instead of UTF-16 units",
    (_field, max, change) => {
      const snapshot = librarySnapshot();
      for (const count of [max / 2 + 1, max]) {
        const name = nonBmp.repeat(count);
        expect(name.length).toBe(count * 2);
        change(snapshot, name);
        expect(librarySnapshotSchema.parse(snapshot)).toEqual(snapshot);
      }
      change(snapshot, nonBmp.repeat(max + 1));
      const parsed = librarySnapshotSchema.safeParse(snapshot);
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues.map((issue) => issue.message)).toContain(
          `El texto no puede superar los ${max} puntos de código Unicode.`,
        );
    },
  );

  it.each([31, 60, 61])(
    "validates a package preview bank name with %i non-BMP code points",
    (count) => {
      const parsed = bankImportPreparationSchema.safeParse({
        cancelled: false,
        preview: {
          token: "unicode-preview",
          bankNames: [nonBmp.repeat(count)],
          effectCount: 1,
          buttonCount: 1,
          shortcutCount: 0,
          warnings: [],
        },
      });
      expect(parsed.success).toBe(count <= 60);
      if (!parsed.success)
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({
            path: ["preview", "bankNames", 0],
            message:
              "El texto no puede superar los 60 puntos de código Unicode.",
          }),
        );
    },
  );

  it("counts combining marks separately without normalizing or counting graphemes", () => {
    const value = "e\u0301";
    expect(codePointString(2).parse(value)).toBe(value);
    expect(codePointString(1).safeParse(value).success).toBe(false);
    const snapshot = librarySnapshot();
    snapshot.board.banks[0].name = value.repeat(30);
    expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(true);
    snapshot.board.banks[0].name = value.repeat(31);
    expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it.each(["bank", "button", "effect"])(
    "accepts 100 Unicode code points for a %s ID and rejects 101",
    (field) => {
      const snapshot = librarySnapshot();
      for (const count of [100, 101]) {
        const id = nonBmp.repeat(count);
        if (field === "bank") {
          snapshot.board.banks[0].id = id;
          snapshot.board.activeBankId = id;
        } else if (field === "button")
          snapshot.board.banks[0].buttons[0].id = id;
        else {
          snapshot.effects[0].id = id;
          snapshot.board.banks[0].buttons[0].effectId = id;
        }
        const parsed = librarySnapshotSchema.safeParse(snapshot);
        expect(parsed.success).toBe(count === 100);
        if (!parsed.success)
          expect(parsed.error.issues.map((issue) => issue.message)).toContain(
            "El texto no puede superar los 100 puntos de código Unicode.",
          );
      }
    },
  );

  it("accepts Unicode shortcut IDs and references without relaxing ASCII physical codes", () => {
    const snapshot = librarySnapshot();
    const bank = snapshot.board.banks[0];
    bank.id = nonBmp.repeat(100);
    snapshot.board.activeBankId = bank.id;
    bank.buttons[0].id = `b${nonBmp.repeat(99)}`;
    const binding: ShortcutBinding = {
      id: nonBmp.repeat(100),
      scope: "bank",
      scopeBankId: bank.id,
      chord: {
        code: "KeyA",
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
      },
      action: { kind: "play_button", targetId: bank.buttons[0].id },
      enabled: true,
    };
    snapshot.board.keyboardShortcuts = [binding];
    expect(librarySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      shortcutBindingSchema.safeParse({ ...binding, id: nonBmp.repeat(101) })
        .success,
    ).toBe(false);
    expect(
      shortcutBindingSchema.safeParse({ ...binding, id: "s".repeat(100) })
        .success,
    ).toBe(true);
    expect(
      shortcutBindingSchema.safeParse({ ...binding, id: "s".repeat(101) })
        .success,
    ).toBe(false);
    expect(
      keyChordSchema.safeParse({ ...binding.chord, code: `Key${nonBmp}` })
        .success,
    ).toBe(false);
  });

  it("preserves blank and control rules while allowing an empty category", () => {
    for (const value of ["", "   ", "\n", "a\u0000"]) {
      const snapshot = librarySnapshot();
      snapshot.board.banks[0].name = value;
      expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(false);
      snapshot.board.banks[0].name = "Principal";
      snapshot.board.banks[0].buttons[0].name = value;
      expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(false);
      expect(
        shortcutBindingSchema.safeParse({
          id: value,
          scope: "application",
          scopeBankId: null,
          chord: {
            code: "KeyA",
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
          },
          action: { kind: "stop_all", targetId: null },
          enabled: false,
        }).success,
      ).toBe(false);
    }
    const snapshot = librarySnapshot();
    for (const category of ["", "   "]) {
      snapshot.board.banks[0].buttons[0].category = category;
      expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(true);
    }
    snapshot.board.banks[0].buttons[0].category = "a\u0000";
    expect(librarySnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("accepts bounded Unicode names through library import and package commit response contracts", () => {
    const snapshot = librarySnapshot();
    for (const [, max, change] of nameFields)
      change(snapshot, nonBmp.repeat(max));
    expect(
      importResultSchema.parse({
        cancelled: false,
        imported: [{ effect: snapshot.effects[0], duplicate: false }],
        failed: [],
        snapshot,
      }).snapshot,
    ).toEqual(snapshot);
    expect(
      bankImportCommitSchema.parse({
        snapshot,
        importedBankIds: [snapshot.board.activeBankId],
        reusedEffects: 0,
        warnings: [],
      }).snapshot,
    ).toEqual(snapshot);
  });

  it("keeps a Unicode package commit readable and editable after remounting the controller", async () => {
    const fake = fakeLibrary();
    const controller = new LibraryController(fake.api);
    const dispose = controller.start();
    let remount: (() => void) | undefined;
    try {
      await controller.refresh();
      const snapshot = fake.saved();
      const name = nonBmp.repeat(31);
      snapshot.revision++;
      snapshot.board.banks.push({
        id: "unicode-bank",
        name,
        buttons: [
          {
            ...snapshot.board.banks[0].buttons[0],
            id: "unicode-button",
            name: nonBmp.repeat(51),
            category: nonBmp.repeat(41),
          },
        ],
      });
      snapshot.effects[0].name = nonBmp.repeat(51);
      fake.api.prepareBankImport.mockResolvedValueOnce({
        cancelled: false,
        preview: {
          token: "unicode-token",
          bankNames: [name],
          effectCount: 1,
          buttonCount: 1,
          shortcutCount: 0,
          warnings: [],
        },
      });
      fake.api.commitBankImport.mockImplementationOnce(async () => {
        fake.setSnapshot(snapshot);
        return {
          snapshot,
          importedBankIds: ["unicode-bank"],
          reusedEffects: 1,
          warnings: [],
        };
      });
      expect(await controller.prepareBankImport()).toBe(true);
      expect(controller.getSnapshot().preview?.bankNames).toEqual([name]);
      expect(await controller.commitBankImport(false)).toBe(true);
      expect(controller.getSnapshot().error).toBeNull();
      expect(controller.getSnapshot().snapshot).toEqual(snapshot);
      expect(fake.api.commitBankImport).toHaveBeenCalledTimes(1);
      dispose();
      remount = controller.start();
      expect(await controller.refresh()).toBe(true);
      expect(controller.getSnapshot().error).toBeNull();
      expect(controller.getSnapshot().snapshot).toEqual(snapshot);
      expect(
        await controller.updateBoard((board) => {
          board.activeBankId = "unicode-bank";
        }),
      ).toBe(true);
      expect(fake.saved().board.banks[1].name).toBe(name);
      expect(controller.getSnapshot().snapshot?.board.activeBankId).toBe(
        "unicode-bank",
      );
    } finally {
      remount?.();
      dispose();
    }
  });
});
