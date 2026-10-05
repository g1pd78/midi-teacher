import { createContext, useContext } from "react";

/** Подпись кнопки «назад» в тренажёрах: курс подменяет её на «← Курс». */
export const BackLabelContext = createContext<string | null>(null);

export function useBackLabel(fallback: string): string {
  return useContext(BackLabelContext) ?? fallback;
}
