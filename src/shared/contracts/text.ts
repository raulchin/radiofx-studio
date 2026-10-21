import { z } from "zod";

/**
 * Limita texto por puntos de código Unicode, igual que chars().count() en Rust.
 * @param max Número máximo de puntos de código, no de unidades UTF-16 ni grafemas.
 * @returns Esquema sin recorte ni normalización; el llamador conserva sus reglas de contenido.
 */
export function codePointString(max: number) {
  return z.string().refine(
    /** @param value Texto recibido. @returns Si su longitud respeta el límite de Rust. */
    (value) => [...value].length <= max,
    `El texto no puede superar los ${max} puntos de código Unicode.`,
  );
}
