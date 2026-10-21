import {
  keyChordSchema,
  chordLabel,
  type KeyChord,
  type ShortcutBinding,
} from "./contracts";

/** @param event Evento físico. @returns Combinación capturable; ignora IME, AltGraph y repetición. */
export function eventChord(event: KeyboardEvent): KeyChord | null {
  if (event.isComposing || event.repeat || event.getModifierState("AltGraph"))
    return null;
  const parsed = keyChordSchema.safeParse({
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  });
  return parsed.success ? parsed.data : null;
}
/** @param event Evento global. @param bindings Atajos del último ACK. @param activeBankId Banco confirmado. @returns Acción consumible, nunca desde campos ni modales. */
export function resolveShortcut(
  event: KeyboardEvent,
  bindings: ShortcutBinding[],
  activeBankId: string,
): ShortcutBinding | null {
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(
      'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-shortcut-capture],dialog,[role="dialog"]',
    )
  )
    return null;
  if (document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]'))
    return null;
  const chord = eventChord(event);
  if (!chord) return null;
  return (
    bindings.find(
      (binding) =>
        binding.enabled &&
        (binding.scope === "application" ||
          binding.scopeBankId === activeBankId) &&
        chordLabel(binding.chord) === chordLabel(chord),
    ) ?? null
  );
}
