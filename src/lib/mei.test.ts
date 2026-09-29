import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { buildMei, spelledName, type StaffNote } from "./mei";
import { verovioOptions } from "./staffOptions";

let tk: VerovioToolkit;

beforeAll(async () => {
  tk = new VerovioToolkit(await createVerovioModule());
}, 60_000);

function render(notes: StaffNote[], grand: boolean, clef: "treble" | "bass" = "treble") {
  tk.setOptions(verovioOptions("lane", notes.length));
  expect(tk.loadData(buildMei(notes, { grand, clef, naming: "solfege" }))).toBeTruthy();
  return tk.renderToSVG(1);
}

const c4: StaffNote = { id: "t0", midi: 60, clef: "treble", step: "c", alter: 0, octave: 4 };
const fs3: StaffNote = { id: "t1", midi: 54, clef: "bass", step: "f", alter: 1, octave: 3 };
const db4: StaffNote = { id: "t2", midi: 61, clef: "treble", step: "d", alter: -1, octave: 4 };

describe("MEI для тренажёра", () => {
  it("каждая нота получает свой id в SVG", () => {
    const svg = render([c4, { ...c4, id: "t1", midi: 67, step: "g" }], false);
    expect(svg).toContain('id="t0"');
    expect(svg).toContain('id="t1"');
    expect(svg).toContain("<svg");
  });

  it("фортепианная система: ноты попадают на свои станы, знаки рисуются", () => {
    const svg = render([c4, fs3, db4], true);
    for (const id of ["t0", "t1", "t2"]) expect(svg).toContain(`id="${id}"`);
    // Два стана и знаки альтерации.
    expect((svg.match(/class="staff"/g) ?? []).length).toBe(6); // 3 такта × 2 стана
    expect(svg).toContain('class="accid"');
  });

  it("басовый ключ отдельно", () => {
    const svg = render([{ ...fs3, id: "t0", alter: 0, midi: 53 }], false, "bass");
    expect(svg).toContain('id="t0"');
    expect(svg).toContain('class="clef"');
  });

  it("подписи нот с учётом знаков", () => {
    expect(spelledName(c4, "solfege")).toBe("До");
    expect(spelledName(fs3, "solfege")).toBe("Фа♯");
    expect(spelledName(db4, "latin")).toBe("D♭");
    expect(render([db4], false)).toContain("Ре♭");
  });
});
