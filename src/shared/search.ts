/** @param value Texto local. @returns Texto sin acentos, con espacios normalizados y minúsculas. */
export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("es")
    .trim();
}
