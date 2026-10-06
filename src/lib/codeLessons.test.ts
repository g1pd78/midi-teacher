import { describe, expect, it } from "vitest";
import { CODE_LESSONS, checkLesson, playCheck } from "./codeLessons";
import { portableCode } from "./strudel/portable";

describe("уроки «Музыка кодом»", () => {
  it("21 урок, id по порядку", () => {
    expect(CODE_LESSONS).toHaveLength(21);
    CODE_LESSONS.forEach((l, i) => expect(l.id).toBe(`code-${i + 1}`));
  });

  for (const l of CODE_LESSONS) {
    if (l.check.kind === "play" || l.check.kind === "improv") continue;
    it(`${l.id} «${l.title}»: ответ засчитан, стартовый код — нет`, async () => {
      const good = await checkLesson(l, l.answer);
      expect(good.ok, good.message).toBe(true);
      const bad = await checkLesson(l, l.starter);
      expect(bad.ok, `стартовый код не должен проходить: ${bad.message}`).toBe(false);
    });
  }

  it("уроки, работающие на strudel.cc, не используют функции MIDI Teacher в ответе", () => {
    for (const l of CODE_LESSONS.filter((x) => x.portable && x.answer)) {
      expect(l.answer, l.id).not.toMatch(/\.you\(|echo\(|harmony\(|kb\(/);
      expect(portableCode(l.answer)).toContain(l.answer.trim().split("\n").pop()!);
    }
  });

  it("уроки с игрой засчитываются по итогу", () => {
    const play = CODE_LESSONS.find((l) => l.id === "code-17")!;
    expect(playCheck(play, { you: { accuracy: 0.9, expected: 12 } })?.ok).toBe(true);
    expect(playCheck(play, { you: { accuracy: 0.6, expected: 12 } })?.ok).toBe(false);
    expect(playCheck(play, { you: { accuracy: 1, expected: 3 } })?.ok).toBe(false);
    const improv = CODE_LESSONS.find((l) => l.id === "code-18")!;
    expect(playCheck(improv, { improv: { total: 20, inKey: 17 } })?.ok).toBe(true);
    expect(playCheck(improv, { improv: { total: 20, inKey: 10 } })?.ok).toBe(false);
  });

  it("стартовый код уроков с игрой выполняется и содержит «мою» партию", async () => {
    const { evalCode } = await import("./strudel/evaluate");
    const { patternNotes } = await import("./strudel/haps");
    for (const id of ["code-17", "code-19"]) {
      const l = CODE_LESSONS.find((x) => x.id === id)!;
      const r = await evalCode(l.starter);
      expect(patternNotes(r.pattern, 0, 4).some((n) => n.you), id).toBe(true);
    }
  });
});
