// Параметры отрисовки Verovio для тренажёра.

export type StaffLayout = "single" | "lane";

export function verovioOptions(layout: StaffLayout, notes: number): Record<string, unknown> {
  const single = layout === "single";
  return {
    // Ширина страницы в единицах Verovio (по умолчанию 1 = 0,1 мм); высота подгоняется.
    pageWidth: single ? 900 : Math.max(1400, 360 + notes * 300),
    pageHeight: 2000,
    adjustPageHeight: true,
    adjustPageWidth: true,
    scale: single ? 120 : 80,
    pageMarginTop: 60,
    pageMarginBottom: 40,
    pageMarginLeft: 40,
    pageMarginRight: 40,
    breaks: "none",
    header: "none",
    footer: "none",
    svgViewBox: true,
    svgRemoveXlink: true,
    lyricSize: 3.2,
    // Плотность нот по горизонтали: по одной — компактно, лентой — с воздухом для чтения.
    spacingLinear: single ? 0.2 : 0.18,
    spacingNonLinear: single ? 0.4 : 0.5,
  };
}
