import {
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import { NativeAudioController } from "./native-controller";

/**
 * Mantiene un controlador por raíz, independiente del ciclo de los ajustes.
 * @param provided Controlador opcional para pruebas con IPC simulado.
 * @param onKeyDown Despacho ordinario opcional del tablero confirmado.
 * @returns Vista autoritativa y acciones del único controlador montado.
 */
export function useNativeAudio(
  provided?: NativeAudioController,
  onKeyDown?: (event: KeyboardEvent) => void,
) {
  const [controller] = useState(() => provided ?? new NativeAudioController());
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const dispatch = useEffectEvent((event: KeyboardEvent) => onKeyDown?.(event));
  useEffect(() => {
    const dispose = controller.start();
    /** @param event Tecla global, también dentro de diálogos o campos. */
    function emergencyStop(event: KeyboardEvent) {
      if (event.ctrlKey && event.shiftKey && event.code === "Space") {
        event.preventDefault();
        void controller.stopAll();
        return;
      }
      dispatch(event);
    }
    window.addEventListener("keydown", emergencyStop, true);
    return () => {
      window.removeEventListener("keydown", emergencyStop, true);
      dispose();
    };
  }, [controller]);
  return { ...view, controller };
}
