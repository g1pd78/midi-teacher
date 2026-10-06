import { describe, expect, it } from "vitest";
import { bankOptions, contextAt, docFor, functionNames, soundOptions } from "./complete";
import { DOCS_RU } from "./docsRu";
import { evalCode } from "./evaluate";
import { patternNotes } from "./haps";
import { partColor, playedPoint, rollLayout, PART_COLORS } from "./roll";
import { defaultSoundName } from "./sounds";

describe("автодополнение и справка", () => {
  it("функции Strudel и наши, основные — по-русски", () => {
    const names = functionNames();
    expect(names.length).toBeGreaterThan(400);
    for (const n of ["s", "note", "lpf", "every", "jux", "you", "echo", "harmony", "kb"]) expect(names).toContain(n);
    expect(Object.keys(DOCS_RU).length).toBeGreaterThanOrEqual(80);
    expect(docFor("lpf")!.ru).toMatch(/фильтр/i);
    expect(docFor("lpf")!.en).toMatch(/low-pass/i);
    expect(docFor("you")!.mt).toBe(true);
    expect(docFor("you")!.en).toBeUndefined();
    // Без русского описания — английская справка Strudel.
    const enOnly = names.find((n) => !DOCS_RU[n] && docFor(n)?.en);
    expect(enOnly).toBeTruthy();
    expect(docFor("нет_такой")).toBeNull();
  });

  it("контекст: функция, звук в s(\"…\"), банк, лад", () => {
    expect(contextAt('note("c e").lp')).toEqual({ kind: "function", word: "lp" });
    expect(contextAt("stac")).toEqual({ kind: "function", word: "stac" });
    expect(contextAt('s("bd ')).toEqual({ kind: "sound", word: "" });
    expect(contextAt('s("bd [gm_pi')).toEqual({ kind: "sound", word: "gm_pi" });
    expect(contextAt('sound("hh*4 o')).toEqual({ kind: "sound", word: "o" });
    expect(contextAt('s("bd").bank("Rol')).toEqual({ kind: "bank", word: "Rol" });
    expect(contextAt('n("0 2").scale("A:mi')).toEqual({ kind: "scaleMode", word: "mi" });
    expect(contextAt('n("0 2").scale("')).toEqual({ kind: "scale", word: "" });
    expect(contextAt('note("c4 e')).toBeNull(); // мини-нотация нот — без подсказок
  });

  it("звуки и банки из загруженных", () => {
    const loaded = ["bd", "sd", "hh", "gm_piano", "gm_acoustic_bass", "RolandTR909_bd", "RolandTR909_sd", "whatUneed"];
    expect(soundOptions(loaded, "gm_")).toEqual(["gm_piano", "gm_acoustic_bass"]);
    expect(soundOptions(loaded, "wh")).toEqual(["whatUneed"]);
    expect(bankOptions(loaded, "")).toEqual(["RolandTR909"]);
  });
});

describe("нотная лента", () => {
  it("ноты партий цветом, ударные строками снизу, моя партия — контуром", async () => {
    const r = await evalCode(`drums: s("bd sd")\nmelody: note("c4 g4").you()`);
    const notes = patternNotes(r.pattern, 0, 2);
    const l = rollLayout(notes, 1, Object.keys(r.parts));
    expect(l.from).toBe(0);
    expect(l.to).toBe(2);
    expect(l.boxes).toHaveLength(8);
    expect(l.drumRows.map((d) => d.name)).toEqual(["bd", "sd"]);
    expect(l.drumRows[0].y).toBeGreaterThan(l.drumRows[1].y); // бочка ниже
    const mel = l.boxes.filter((b) => b.you);
    expect(mel).toHaveLength(4);
    expect(mel.every((b) => b.color === PART_COLORS[1])).toBe(true);
    // Соль выше до.
    const [c, g] = [mel.find((b) => b.x === 0)!, mel.find((b) => b.x === 0.25)!];
    expect(g.y).toBeLessThan(c.y);
    expect(partColor(null, ["a"])).toBe(PART_COLORS[PART_COLORS.length - 1]);
    // Нажатие в окне — точка, вне окна — нет.
    expect(playedPoint(0.5, 60, l)).not.toBeNull();
    expect(playedPoint(3, 60, l)).toBeNull();
  });
});

describe("перетаскивание сэмплов", () => {
  it("имя звука по папке или файлу", () => {
    expect(defaultSoundName(["C:\\Users\\me\\Kicks"])).toBe("kicks");
    expect(defaultSoundName(["/home/me/My Snare 01.wav"])).toBe("my_snare_01");
    expect(defaultSoundName(["/x/808.wav"])).toBe("s_808");
    expect(defaultSoundName(["/x/Барабан.wav"])).toBe("mysample");
  });
});
