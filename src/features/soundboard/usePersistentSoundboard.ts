import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useNativeAudio } from "../audio-controls/useNativeAudio";
import type { NativeAudioController } from "../audio-controls/native-controller";
import { LibraryController } from "../sound-library/library-controller";
import { buttonColorSchema } from "../sound-library/models";
import {
  columnsSchema,
  type PersistentBoard,
} from "../../shared/contracts/library";
import type { BoardDialog } from "./useSoundboard";
import { resolveShortcut } from "../keyboard-shortcuts/dispatch";
import { normalizeSearch } from "../../shared/search";

/**
 * Coordina formularios, ciclos de vida y vistas confirmadas sin duplicar los stores.
 * @param libraryController Controlador de biblioteca sustituible en pruebas.
 * @param nativeController Controlador del único motor nativo de la raíz.
 * @returns Estado de presentación y acciones; las escrituras pasan por la cola de LibraryController.
 */
export function usePersistentSoundboard(
  libraryController?: LibraryController,
  nativeController?: NativeAudioController,
) {
  const [controller] = useState(
    () => libraryController ?? new LibraryController(),
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const audio = useNativeAudio(nativeController, (event) => {
    const current = controller.getSnapshot().snapshot;
    if (!current) return;
    const binding = resolveShortcut(
      event,
      current.board.keyboardShortcuts,
      current.board.activeBankId,
    );
    if (!binding) return;
    event.preventDefault();
    if (binding.action.kind === "stop_all") void audio.controller.stopAll();
    else if (binding.action.kind === "play_button" && binding.action.targetId)
      play(binding.action.targetId);
    else if (binding.action.targetId) selectBank(binding.action.targetId);
  });
  const [query, setQuery] = useState("");
  const [allBanks, setAllBanks] = useState(false);
  const [dialog, setDialog] = useState<BoardDialog | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const session = ++generation.current;
    const dispose = controller.start();
    return () => {
      generation.current = session + 1;
      dispose();
    };
  }, [controller]);
  useEffect(() => {
    if (view.snapshot) void audio.controller.refresh();
  }, [view.snapshot, audio.controller]);
  const snapshot = view.snapshot;
  const bank = snapshot?.board.banks.find(
    (item) => item.id === snapshot.board.activeBankId,
  );

  /** @param next Diálogo solicitado; durante I/O solo se permite cerrar el actual. */
  function openDialog(next: BoardDialog): void {
    if (!view.busy) setDialog(next);
  }
  /** Cierra la presentación sin cancelar una escritura o importación ya enviada a Rust. */
  function closeDialog(): void {
    setDialog(null);
  }
  /** @param edit Edición sobre el último ACK. @param close Cierra solo el diálogo originario. @returns Finalización durable o rechazo visible. */
  async function save(
    edit: (board: PersistentBoard) => void,
    close = false,
  ): Promise<void> {
    if (controller.getSnapshot().busy) return;
    const started = generation.current;
    const accepted = await controller.updateBoard(edit);
    if (accepted && close && generation.current === started)
      setDialog((current) => (current === dialog ? null : current));
  }
  /** @param event Formulario del banco, limitado a 60 caracteres por el contrato. */
  function saveBank(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (dialog?.kind !== "bank") return;
    const name = String(
      new FormData(event.currentTarget).get("name") ?? "",
    ).trim();
    const id = dialog.bank?.id ?? crypto.randomUUID();
    void save((board) => {
      if (dialog.bank) {
        const target = board.banks.find((item) => item.id === id);
        if (!target)
          throw new Error("El banco ya no existe; vuelve a abrir el editor.");
        target.name = name;
      } else {
        board.banks.push({ id, name, buttons: [] });
        board.activeBankId = id;
      }
    }, true);
  }
  /** @param event Metadatos y referencia al catálogo; nunca una duración manual. */
  function saveButton(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (dialog?.kind !== "button" || !snapshot) return;
    const data = new FormData(event.currentTarget);
    const effectId = String(data.get("effectId") ?? "") || null;
    const effect = snapshot.effects.find((item) => item.id === effectId);
    const button = {
      id: dialog.button?.id ?? crypto.randomUUID(),
      effectId,
      name: String(data.get("name") ?? "").trim(),
      category: String(data.get("category") ?? "").trim(),
      color: buttonColorSchema.parse(data.get("color")),
      durationMs: effect?.durationMs ?? 0,
      playback: {
        looped: data.get("looped") === "on",
        fadeInMs: Number(data.get("fadeInMs")),
        fadeOutMs: Number(data.get("fadeOutMs")),
      },
    };
    void save((board) => {
      const target = board.banks.find((item) => item.id === dialog.bankId);
      if (!target)
        throw new Error("El banco ya no existe; vuelve a abrir el editor.");
      if (dialog.button) {
        const index = target.buttons.findIndex((item) => item.id === button.id);
        if (index < 0)
          throw new Error("El botón ya no existe; vuelve a abrir el editor.");
        target.buttons[index] = button;
      } else target.buttons.push(button);
    }, true);
  }
  /** Confirma únicamente la eliminación presentada, sin eliminar archivos de audio. */
  function confirmDelete(): void {
    void save((board) => {
      if (dialog?.kind === "delete-bank") {
        if (board.banks.length === 1)
          throw new Error("No se puede eliminar el último banco.");
        const removed = board.banks.find((item) => item.id === dialog.bank.id);
        const ids = new Set(removed?.buttons.map((button) => button.id));
        board.keyboardShortcuts = board.keyboardShortcuts.filter(
          (binding) =>
            binding.scopeBankId !== dialog.bank.id &&
            binding.action.targetId !== dialog.bank.id &&
            !ids.has(binding.action.targetId ?? ""),
        );
        board.banks = board.banks.filter((item) => item.id !== dialog.bank.id);
        if (board.activeBankId === dialog.bank.id)
          board.activeBankId = board.banks[0].id;
      }
      if (dialog?.kind === "delete-button") {
        board.keyboardShortcuts = board.keyboardShortcuts.filter(
          (binding) => binding.action.targetId !== dialog.button.id,
        );
        const target = board.banks.find((item) => item.id === dialog.bankId);
        if (target)
          target.buttons = target.buttons.filter(
            (item) => item.id !== dialog.button.id,
          );
      }
    }, true);
  }
  /** @param id Identidad movida. @param direction Desplazamiento accesible. @param banks Mueve bancos en vez de asignaciones. */
  function move(id: string, direction: -1 | 1, banks = false): void {
    if (query.trim() && !banks) return;
    void save((board) => {
      const items = banks
        ? board.banks
        : board.banks.find((item) => item.id === bank?.id)?.buttons;
      if (!items) return;
      const index = items.findIndex((item) => item.id === id);
      const next = index + direction;
      if (index >= 0 && next >= 0 && next < items.length)
        [items[index], items[next]] = [items[next], items[index]];
    });
  }
  /** @param source Origen del arrastre. @param target Destino del banco confirmado. */
  function drop(source: string, target: string): void {
    if (query.trim()) return;
    void save((board) => {
      const items = board.banks.find((item) => item.id === bank?.id)?.buttons;
      if (!items) return;
      const from = items.findIndex((item) => item.id === source);
      const to = items.findIndex((item) => item.id === target);
      if (from >= 0 && to >= 0) items.splice(to, 0, items.splice(from, 1)[0]);
    });
  }
  /** @param id Banco cuya selección debe persistirse en el encabezado. */
  function selectBank(id: string): void {
    void save((board) => {
      board.activeBankId = id;
    });
  }
  /** @param event Selección de densidad validada, sin actualización optimista. */
  function changeColumns(event: ChangeEvent<HTMLSelectElement>): void {
    if (!controller.getSnapshot().busy)
      void controller.setColumns(
        columnsSchema.parse(event.currentTarget.value),
      );
  }
  /** Solicita revalidación explícita sin sondeo frecuente de archivos. */
  function refreshLibrary(): void {
    if (!controller.getSnapshot().busy) void controller.refresh();
  }
  /** Abre el selector Rust sin bloquear las operaciones independientes de audio. */
  function importAudio(): void {
    if (!controller.getSnapshot().busy) void controller.importAudio();
  }

  const effectsById = new Map(
    snapshot?.effects.map((effect) => [effect.id, effect]),
  );
  const registeredEffects = new Set(
    audio.status?.effects.map((effect) => effect.effect_id),
  );
  const voiceCounts = new Map<string, number>();
  for (const voice of audio.status?.active_playbacks ?? []) {
    voiceCounts.set(
      voice.effect_id,
      (voiceCounts.get(voice.effect_id) ?? 0) + 1,
    );
  }
  const nativeStates = Object.fromEntries(
    (snapshot?.board.banks.flatMap((item) => item.buttons) ?? []).map(
      (button) => {
        const effect = effectsById.get(button.effectId ?? "");
        const registered = registeredEffects.has(button.effectId ?? "");
        const count = voiceCounts.get(button.effectId ?? "") ?? 0;
        const playable =
          effect?.availability === "available" &&
          registered &&
          audio.status?.state === "ready" &&
          !audio.routeBusy;
        const label = !button.effectId
          ? "Sin audio asignado"
          : !effect
            ? "Recurso desconocido"
            : effect.availability !== "available"
              ? `${effect.availability === "missing" ? "Archivo ausente" : "Archivo inválido"}${effect.error ? `: ${effect.error}` : ""}`
              : !registered
                ? "Preparando recurso en el motor"
                : count
                  ? `${count} instancias activas`
                  : playable
                    ? "Disponible"
                    : "Selecciona una salida disponible";
        return [button.id, { label, playable, count }];
      },
    ),
  );
  /** Reinicia el sonido sin detener otros efectos ni bloquear durante I/O. @param id Asignación pulsada; solo envía recursos disponibles y registrados. @returns Nada; el estado procede del motor. */
  function play(id: string): void {
    const button = snapshot?.board.banks
      .flatMap((item) => item.buttons)
      .find((item) => item.id === id);
    if (button?.effectId && nativeStates[id]?.playable)
      void audio.controller.playWithOptions(button.effectId, button.playback);
  }
  /** @param id Recurso cuyas instancias se detienen independientemente de SQLite. */
  function stopEffect(id: string): void {
    void audio.controller.stopEffect(id);
  }

  const title =
    dialog?.kind === "settings"
      ? "Configuración"
      : dialog?.kind === "banks"
        ? "Organizar bancos"
        : dialog?.kind === "bank"
          ? dialog.bank
            ? "Renombrar banco"
            : "Crear banco"
          : dialog?.kind === "button"
            ? dialog.button
              ? "Editar botón"
              : "Agregar botón"
            : dialog?.kind === "delete-bank"
              ? "Eliminar banco"
              : "Eliminar botón";
  const notice = view.busy
    ? snapshot
      ? "Guardando / actualizando biblioteca... El audio confirmado sigue disponible. Cerrar el diálogo no cancela una operación enviada a Rust."
      : "Cargando biblioteca local..."
    : "Biblioteca local confirmada por SQLite. Audio a cargo de Rust.";
  const outputLabel = `${audio.status?.state === "ready" ? "Salida activa" : "Sin salida disponible"}: ${audio.status?.selected_device?.name ?? "ninguna seleccionada"}`;
  const playbackLabel = audio.status
    ? `${audio.status.active_playbacks.length} voces reales`
    : "Esperando motor nativo";
  const deleteDisabled =
    dialog?.kind === "delete-bank" && snapshot?.board.banks.length === 1;
  const search = normalizeSearch(query);
  const visibleBanks =
    snapshot?.board.banks
      .filter((item) => allBanks || item.id === bank?.id)
      .map((item) => ({
        ...item,
        buttons: item.buttons.filter(
          (button) =>
            !search ||
            normalizeSearch(
              [
                button.name,
                button.category,
                item.name,
                effectsById.get(button.effectId ?? "")?.name ?? "",
              ].join(" "),
            ).includes(search),
        ),
      })) ?? [];
  /** @param buttonId Asignación origen. @param targetBankId Banco destino. @param copy Copia con identidad nueva, nunca archivos ni atajos. @returns Guardado atómico sobre ACK. */
  async function transfer(
    buttonId: string,
    targetBankId: string,
    copy: boolean,
  ): Promise<boolean> {
    return controller.updateBoard((board) => {
      const source = board.banks.find((item) =>
        item.buttons.some((button) => button.id === buttonId),
      );
      const target = board.banks.find((item) => item.id === targetBankId);
      const button = source?.buttons.find((item) => item.id === buttonId);
      if (!source || !target || !button)
        throw new Error("La asignación o el destino ya no existe.");
      if (target.buttons.length >= 256)
        throw new Error("El banco destino admite como máximo 256 botones.");
      if (!copy && source.id === target.id)
        throw new Error("Elige un banco diferente para mover.");
      target.buttons.push({
        ...button,
        id: copy ? crypto.randomUUID() : button.id,
      });
      if (!copy) {
        source.buttons = source.buttons.filter((item) => item.id !== button.id);
        board.keyboardShortcuts = board.keyboardShortcuts.filter(
          (binding) =>
            binding.action.kind !== "play_button" ||
            binding.action.targetId !== button.id,
        );
      }
    });
  }
  return {
    controller,
    query,
    setQuery,
    allBanks,
    setAllBanks,
    visibleBanks,
    transfer,
    view,
    audio,
    snapshot,
    bank,
    dialog,
    title,
    notice,
    outputLabel,
    playbackLabel,
    deleteDisabled,
    nativeStates,
    openDialog,
    closeDialog,
    saveBank,
    saveButton,
    confirmDelete,
    move,
    drop,
    selectBank,
    changeColumns,
    refreshLibrary,
    importAudio,
    play,
    stopEffect,
  };
}
