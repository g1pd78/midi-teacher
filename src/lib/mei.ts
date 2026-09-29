// Генерация MEI (формат нотной записи для Verovio) для тренажёра.
//
// Каждая нота — целая, в отдельном такте с невидимой тактовой чертой: так ноты
// стоят равномерно и не выглядят как ритмический рисунок. Название ноты
// записывается слогом под нотой (<verse>), видимость управляется через CSS.

import { pitchName, type NoteNaming } from "./notes";

export type Clef = "treble" | "bass";

export interface StaffNote {
  id: string;
  midi: number;
  clef: Clef;
  step: string;
  alter: number;
  octave: number;
}

const ACCID: Record<number, string> = { 1: "s", [-1]: "f" };

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Название ноты с учётом записи (до-диез, ре-бемоль), для подписи под нотой. */
export function spelledName(n: StaffNote, naming: NoteNaming): string {
  const whiteMidi = n.midi - n.alter;
  const base = pitchName(whiteMidi, naming);
  if (n.alter === 0) return base;
  return base + (n.alter > 0 ? "♯" : "♭");
}

function noteXml(n: StaffNote, naming: NoteNaming): string {
  const accid = ACCID[n.alter] ? ` accid="${ACCID[n.alter]}"` : "";
  const syl = escapeXml(spelledName(n, naming));
  return (
    `<note xml:id="${n.id}" pname="${n.step}" oct="${n.octave}" dur="1"${accid}>` +
    `<verse n="1"><syl>${syl}</syl></verse></note>`
  );
}

/**
 * Нотный стан с нотами `notes`. `grand` — фортепианная система из двух станов,
 * иначе один стан в ключе `clef`.
 */
export function buildMei(notes: StaffNote[], opts: { grand: boolean; clef: Clef; naming: NoteNaming }): string {
  const { grand, clef, naming } = opts;
  const staffDefs = grand
    ? `<staffGrp symbol="brace" bar.thru="true">` +
      `<staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>` +
      `<staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>` +
      `</staffGrp>`
    : `<staffGrp><staffDef n="1" lines="5" ${
        clef === "treble" ? 'clef.shape="G" clef.line="2"' : 'clef.shape="F" clef.line="4"'
      }/></staffGrp>`;

  const measures = notes
    .map((n, i) => {
      const staffOf = grand ? (n.clef === "treble" ? 1 : 2) : 1;
      const staves = (grand ? [1, 2] : [1])
        .map(
          (s) =>
            `<staff n="${s}"><layer n="1">${s === staffOf ? noteXml(n, naming) : '<space dur="1"/>'}</layer></staff>`,
        )
        .join("");
      return `<measure n="${i + 1}" right="invis">${staves}</measure>`;
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">` +
    `<music><body><mdiv><score>` +
    `<scoreDef>${staffDefs}</scoreDef>` +
    `<section>${measures}</section>` +
    `</score></mdiv></body></music></mei>`
  );
}
