// Короткие нотные примеры для карточек теории: компактная запись → MEI для Verovio.
//
// Такты разделяются «|», ноты — пробелами:
//   c4:4        до первой октавы, четверть (1, 2, 4, 8, 16; точки: c4:2.)
//   f#4:4 bb4:8 бекар: bn4:4
//   c4+e4+g4:2  аккорд
//   r:4  R      пауза / пауза на весь такт
//   суффиксы: ~ лига к следующей такой же ноте, ' стаккато, > акцент, ^ фермата,
//             ( начало и ) конец лиги legato, * педаль вниз, @ педаль вверх, /3 палец
//   !p !mf !f   динамика у следующей ноты; !< !> вилка от следующей ноты до «!.»
//   [ ]         восьмые под одним ребром; 3{ } триоль
//   «|:» в начале такта и «:|» в конце — реприза; «dbl» в конце такта — двойная черта

export interface SnippetOptions {
  clef?: "G" | "F";
  meter?: string | null;
  /** Знаки при ключе: «0», «1s», «2f»… */
  key?: string;
  /** Обозначение темпа: [текст, удары в минуту]. */
  tempo?: [string, number];
}

const TOKEN =
  /^(?<pitches>r|R|[a-g](?:#|b|n)?\d(?:\+[a-g](?:#|b|n)?\d)*)(?::(?<dur>1|2|4|8|16)(?<dots>\.*))?(?<mods>[~'>^()*@]*)(?:\/(?<fing>[1-5]))?$/;
const PITCH = /^([a-g])(#|b|n)?(\d)$/;
const ACC: Record<string, string> = { "#": "s", b: "f", n: "n" };

export function snippetMei(src: string, opts: SnippetOptions = {}): string {
  const { clef = "G", meter = "4/4", key = "0", tempo } = opts;
  let id = 0;
  const nid = () => `s${++id}`;
  const control: string[][] = [];
  const measures = src.split("|").map((m) => m.trim()).filter((m) => m.length);
  let pendingDyn: string | null = null;
  let pendingHairpin: { form: string; start: string | null } | null = null;
  let openHairpin: { form: string; start: string } | null = null;
  let slurStart: string | null = null;
  let tieFrom: { id: string; pitch: string } | null = null;
  let lastNote: string | null = null;
  const out: string[] = [];

  measures.forEach((raw, mi) => {
    let text = raw;
    let left = "";
    let right = mi === measures.length - 1 ? ' right="end"' : "";
    if (text.startsWith(":")) {
      left = ' left="rptstart"';
      text = text.slice(1).trim();
    }
    if (text.endsWith(":")) {
      right = ' right="rptend"';
      text = text.slice(0, -1).trim();
    } else if (/(^|\s)dbl$/.test(text)) {
      right = ' right="dbl"';
      text = text.slice(0, -3).trim();
    }
    const ctl: string[] = [];
    control.push(ctl);
    const parts: string[] = [];
    const stack: { open: string; items: string[] }[] = [];
    const push = (xml: string) => (stack.length ? stack[stack.length - 1].items.push(xml) : parts.push(xml));
    for (const tok of text.split(/\s+/).filter(Boolean)) {
      if (tok === "[") stack.push({ open: "<beam>", items: [] });
      else if (tok === "3{") stack.push({ open: '<tuplet num="3" numbase="2">', items: [] });
      else if (tok === "]" || tok === "}") {
        const g = stack.pop()!;
        const close = g.open.startsWith("<beam") ? "</beam>" : "</tuplet>";
        push(g.open + g.items.join("") + close);
      } else if (tok.startsWith("!")) {
        const d = tok.slice(1);
        if (d === "<" || d === ">") pendingHairpin = { form: d === "<" ? "cres" : "dim", start: null };
        else if (d === ".") {
          if (openHairpin && lastNote) ctl.push(`<hairpin form="${openHairpin.form}" startid="#${openHairpin.start}" endid="#${lastNote}" staff="1"/>`);
          openHairpin = null;
        } else pendingDyn = d;
      } else {
        const m = TOKEN.exec(tok);
        if (!m?.groups) throw new Error(`пример: не разобран токен «${tok}»`);
        const { pitches, dur = "4", dots = "", mods = "", fing } = m.groups;
        const dotAttr = dots.length ? ` dots="${dots.length}"` : "";
        if (pitches === "R") {
          push(`<mRest/>`);
          continue;
        }
        if (pitches === "r") {
          push(`<rest dur="${dur}"${dotAttr}/>`);
          continue;
        }
        const ps = pitches.split("+");
        const noteXml = (p: string, i: string, inChord: boolean) => {
          const [, pname, acc, oct] = PITCH.exec(p)!;
          const artic = [mods.includes("'") ? "stacc" : "", mods.includes(">") ? "acc" : ""].filter(Boolean).join(" ");
          return (
            `<note xml:id="${i}" pname="${pname}" oct="${oct}"${inChord ? "" : ` dur="${dur}"${dotAttr}`}` +
            `${acc ? ` accid="${ACC[acc]}"` : ""}${artic && !inChord ? ` artic="${artic}"` : ""}/>`
          );
        };
        let first: string;
        if (ps.length === 1) {
          first = nid();
          push(noteXml(ps[0], first, false));
        } else {
          const ids = ps.map(() => nid());
          first = ids[0];
          push(`<chord dur="${dur}"${dotAttr}>${ps.map((p, i) => noteXml(p, ids[i], true)).join("")}</chord>`);
        }
        if (tieFrom) {
          ctl.push(`<tie startid="#${tieFrom.id}" endid="#${first}"/>`);
          tieFrom = null;
        }
        if (mods.includes("~")) tieFrom = { id: first, pitch: ps[0] };
        if (pendingDyn) {
          ctl.push(`<dynam startid="#${first}" staff="1" place="below">${pendingDyn}</dynam>`);
          pendingDyn = null;
        }
        if (pendingHairpin) {
          openHairpin = { form: pendingHairpin.form, start: first };
          pendingHairpin = null;
        }
        if (mods.includes("(")) slurStart = first;
        if (mods.includes(")") && slurStart) {
          ctl.push(`<slur startid="#${slurStart}" endid="#${first}" staff="1"/>`);
          slurStart = null;
        }
        if (mods.includes("^")) ctl.push(`<fermata startid="#${first}" staff="1"/>`);
        if (mods.includes("*")) ctl.push(`<pedal startid="#${first}" dir="down" staff="1"/>`);
        if (mods.includes("@")) ctl.push(`<pedal startid="#${first}" dir="up" staff="1"/>`);
        if (fing) ctl.push(`<fing startid="#${first}" staff="1" place="above">${fing}</fing>`);
        lastNote = first;
      }
    }
    if (mi === 0 && tempo) ctl.push(`<tempo tstamp="1" staff="1" mm="${tempo[1]}" mm.unit="4">${tempo[0]}</tempo>`);
    out.push(`<measure n="${mi + 1}"${left}${right}><staff n="1"><layer n="1">${parts.join("")}</layer></staff>${ctl.join("")}</measure>`);
  });

  const [count, unit] = meter ? meter.split("/") : [null, null];
  const clefAttr = clef === "G" ? 'clef.shape="G" clef.line="2"' : 'clef.shape="F" clef.line="4"';
  const meterAttr = count ? ` meter.count="${count}" meter.unit="${unit}"` : ' meter.form="invis"';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><music><body><mdiv><score>` +
    `<scoreDef key.sig="${key}"${meterAttr}><staffGrp><staffDef n="1" lines="5" ${clefAttr}/></staffGrp></scoreDef>` +
    `<section>${out.join("")}</section></score></mdiv></body></music></mei>`
  );
}

/** Фортепианная система: правая рука сверху, левая снизу (для карточки о двух станах). */
export function grandStaffMei(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><music><body><mdiv><score>` +
    `<scoreDef meter.count="4" meter.unit="4"><staffGrp symbol="brace" bar.thru="true">` +
    `<staffDef n="1" lines="5" clef.shape="G" clef.line="2"/><staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>` +
    `</staffGrp></scoreDef><section>` +
    `<measure n="1"><staff n="1"><layer n="1"><note pname="e" oct="4" dur="4"/><note pname="d" oct="4" dur="4"/><note pname="c" oct="4" dur="2"/></layer></staff>` +
    `<staff n="2"><layer n="1"><chord dur="1"><note pname="c" oct="3"/><note pname="g" oct="3"/></chord></layer></staff></measure>` +
    `<measure n="2" right="end"><staff n="1"><layer n="1"><note pname="g" oct="4" dur="1"/></layer></staff>` +
    `<staff n="2"><layer n="1"><note pname="c" oct="3" dur="1"/></layer></staff></measure>` +
    `</section></score></mdiv></body></music></mei>`
  );
}
