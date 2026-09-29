#!/usr/bin/env python3
"""Генерирует MusicXML встроенных пьес из компактной записи.

Запуск: python3 scripts/gen_pieces.py  (пишет файлы в src/pieces/)

Запись такта — токены через пробел:
  D5:4        нота ре второй октавы, четверть (1, 2, 4, 8, 16; с точкой: 2. 4. 8.)
  F#5:8       диез; бемоль — Bb4
  G3+B3+D4:2  аккорд
  r:4         пауза
  ...:4/3     аппликатура (палец 3)
  ...:4~      лига к следующей ноте той же высоты
  ...!        показать знак альтерации принудительно
  [ ... ]     группа под одним ребром (восьмые)
"""

from __future__ import annotations

import re
from pathlib import Path
from xml.sax.saxutils import escape

DIV = 4  # делений на четверть
DURS = {"1": 16, "2.": 12, "2": 8, "4.": 6, "4": 4, "8.": 3, "8": 2, "16": 1}
TYPES = {16: ("whole", 0), 12: ("half", 1), 8: ("half", 0), 6: ("quarter", 1), 4: ("quarter", 0),
         3: ("eighth", 1), 2: ("eighth", 0), 1: ("16th", 0)}
STEP_SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# Знаки при ключе: число диезов → какие ступени повышены.
SHARP_ORDER = "FCGDAEB"
FLAT_ORDER = "BEADGCF"

TOKEN = re.compile(r"^(?P<pitches>r|[A-G][#b]?\d(?:\+[A-G][#b]?\d)*)(?P<force>!?):(?P<dur>\d+\.?)(?:/(?P<fing>\d(?:\+\d)*))?(?P<tie>~?)$")
PITCH = re.compile(r"^([A-G])([#b]?)(\d)$")


def key_alters(fifths: int) -> dict[str, int]:
    if fifths >= 0:
        return {s: 1 for s in SHARP_ORDER[:fifths]}
    return {s: -1 for s in FLAT_ORDER[:-fifths]}


def parse_pitch(p: str) -> tuple[str, int, int]:
    m = PITCH.match(p)
    assert m, p
    return m.group(1), {"": 0, "#": 1, "b": -1}[m.group(2)], int(m.group(3))


def note_xml(step, alter, octave, dur, *, chord, staff, voice, show_accid, fing, tie_start, tie_stop, beam):
    t, dots = TYPES[dur]
    out = ["<note>"]
    if chord:
        out.append("<chord/>")
    out.append(f"<pitch><step>{step}</step>{f'<alter>{alter}</alter>' if alter else ''}<octave>{octave}</octave></pitch>")
    out.append(f"<duration>{dur}</duration>")
    if tie_stop:
        out.append('<tie type="stop"/>')
    if tie_start:
        out.append('<tie type="start"/>')
    out.append(f"<voice>{voice}</voice><type>{t}</type>" + "<dot/>" * dots)
    if show_accid is not None:
        out.append(f"<accidental>{show_accid}</accidental>")
    out.append(f"<staff>{staff}</staff>")
    if beam and not chord:
        out.append(f'<beam number="1">{beam}</beam>')
    notations = []
    if tie_stop:
        notations.append('<tied type="stop"/>')
    if tie_start:
        notations.append('<tied type="start"/>')
    if fing:
        notations.append(f"<technical><fingering>{fing}</fingering></technical>")
    if notations:
        out.append("<notations>" + "".join(notations) + "</notations>")
    out.append("</note>")
    return "".join(out)


def rest_xml(dur, staff, voice):
    t, dots = TYPES[dur]
    return (f"<note><rest/><duration>{dur}</duration><voice>{voice}</voice>"
            f"<type>{t}</type>{'<dot/>' * dots}<staff>{staff}</staff></note>")


def staff_measure(text: str, staff: int, fifths: int, ties: dict, measure_len: int, label: str) -> tuple[list[str], int]:
    """XML нот одного стана в такте; возвращает (элементы, длительность)."""
    voice = 1 if staff == 1 else 5
    alters_key = key_alters(fifths)
    measure_alters: dict[tuple[str, int], int] = {}
    tokens = text.replace("[", " [ ").replace("]", " ] ").split()
    # Разметка рёбер: для каждой ноты begin/continue/end.
    beams: list[str | None] = []
    group: list[int] = []
    notes: list[str] = []
    in_group = False
    for tok in tokens:
        if tok == "[":
            in_group, group = True, []
            continue
        if tok == "]":
            for k, idx in enumerate(group):
                beams[idx] = "begin" if k == 0 else ("end" if k == len(group) - 1 else "continue")
            in_group = False
            continue
        notes.append(tok)
        beams.append(None)
        if in_group:
            group.append(len(notes) - 1)

    out: list[str] = []
    total = 0
    for tok, beam in zip(notes, beams):
        m = TOKEN.match(tok)
        assert m, f"{label}: не разобран токен {tok!r}"
        dur = DURS[m.group("dur")]
        total += dur
        if m.group("pitches") == "r":
            out.append(rest_xml(dur, staff, voice))
            continue
        pitches = m.group("pitches").split("+")
        fings = (m.group("fing") or "").split("+") if m.group("fing") else []
        tie_start = bool(m.group("tie"))
        for i, p in enumerate(pitches):
            step, alter, octave = parse_pitch(p)
            expected = measure_alters.get((step, octave), alters_key.get(step, 0))
            show = None
            if alter != expected or m.group("force"):
                show = {1: "sharp", -1: "flat", 0: "natural"}[alter]
            measure_alters[(step, octave)] = alter
            midi = (octave + 1) * 12 + STEP_SEMI[step] + alter
            tie_stop = ties.pop((staff, midi), False)
            if tie_start:
                ties[(staff, midi)] = True
            out.append(note_xml(step, alter, octave, dur, chord=i > 0, staff=staff, voice=voice,
                                show_accid=show, fing=fings[i] if i < len(fings) else None,
                                tie_start=tie_start, tie_stop=tie_stop, beam=beam))
    assert total == measure_len, f"{label}: длительность {total}, нужно {measure_len}"
    return out, total


def build(piece: dict) -> str:
    beats, beat_type = piece["time"]
    measure_len = beats * DIV * 4 // beat_type
    fifths = piece["fifths"]
    rh, lh = piece["rh"], piece["lh"]
    assert len(rh) == len(lh), "число тактов в руках различается"
    ties: dict = {}
    measures = []
    for i, (r, l) in enumerate(zip(rh, lh), start=1):
        parts = [f'<measure number="{i}">']
        if i == 1:
            parts.append(
                f"<attributes><divisions>{DIV}</divisions><key><fifths>{fifths}</fifths></key>"
                f"<time><beats>{beats}</beats><beat-type>{beat_type}</beat-type></time><staves>2</staves>"
                '<clef number="1"><sign>G</sign><line>2</line></clef>'
                '<clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
                f'<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>'
                f'<per-minute>{piece["tempo"]}</per-minute></metronome></direction-type>'
                f'<sound tempo="{piece["tempo"]}"/></direction>'
            )
        right, _ = staff_measure(r, 1, fifths, ties, measure_len, f"такт {i}, правая")
        left, _ = staff_measure(l, 2, fifths, ties, measure_len, f"такт {i}, левая")
        parts += right
        parts.append(f"<backup><duration>{measure_len}</duration></backup>")
        parts += left
        if i == len(rh):
            parts.append('<barline location="right"><bar-style>light-heavy</bar-style></barline>')
        parts.append("</measure>")
        measures.append("".join(parts))

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
        '"http://www.musicxml.org/dtds/partwise.dtd">\n'
        '<score-partwise version="4.0">'
        f'<work><work-title>{escape(piece["title"])}</work-title></work>'
        f'<identification><creator type="composer">{escape(piece["composer"])}</creator>'
        f'<rights>{escape(piece["rights"])}</rights></identification>'
        '<part-list><score-part id="P1"><part-name print-object="no">Фортепиано</part-name></score-part></part-list>'
        '<part id="P1">' + "".join(measures) + "</part></score-partwise>\n"
    )


ODE = {
    "title": "Ода к радости",
    "composer": "Л. ван Бетховен",
    "rights": "Общественное достояние. Упрощённое переложение для начинающих, MIDI Teacher.",
    "time": (4, 4),
    "fifths": 0,
    "tempo": 100,
    # Правая рука в позиции «до»: до=1, ре=2, ми=3, фа=4, соль=5.
    "rh": [
        "E4:4/3 E4:4 F4:4/4 G4:4/5",
        "G4:4 F4:4 E4:4 D4:4/2",
        "C4:4/1 C4:4 D4:4 E4:4",
        "E4:4./3 D4:8/2 D4:2",
        "E4:4/3 E4:4 F4:4 G4:4",
        "G4:4 F4:4 E4:4 D4:4",
        "C4:4/1 C4:4 D4:4 E4:4",
        "D4:4./2 C4:8/1 C4:2",
        "D4:4/2 D4:4 E4:4 C4:4/1",
        "D4:4/2 [E4:8/3 F4:8/4] E4:4/3 C4:4/1",
        "D4:4/2 [E4:8 F4:8] E4:4 D4:4/2",
        "C4:4/1 D4:4/2 G3:2/1",
        "E4:4/3 E4:4 F4:4 G4:4/5",
        "G4:4 F4:4 E4:4 D4:4",
        "C4:4/1 C4:4 D4:4 E4:4",
        "D4:4./2 C4:8/1 C4:2",
    ],
    # Левая рука: до малой (5), ре малой (4), соль малой (1).
    "lh": [
        "C3:1/5", "G3:1/1", "C3:1/5", "G3:1/1",
        "C3:1", "G3:1", "C3:1", "G3:2/1 C3:2/5",
        "G3:1/1", "C3:1/5", "G3:1/1", "C3:2/5 D3:2/4",
        "C3:1/5", "G3:1/1", "C3:1/5", "G3:2/1 C3:2/5",
    ],
}

# Менуэт соль мажор, BWV Anh. 114 (приписывается Кр. Петцольду).
# Источник: Mutopia Project №75 (Bach-Gesellschaft), общественное достояние.
# Для начинающих: без форшлага (т. 8), мордентов и трели (т. 30); двухголосие
# левой руки в тт. 25, 26, 29 записано аккордами с лигами.
MINUET = {
    "title": "Менуэт соль мажор, BWV Anh. 114",
    "composer": "Кр. Петцольд (из «Нотной тетради Анны Магдалены Бах»)",
    "rights": "Общественное достояние. По изданию Mutopia Project №75 (Bach-Gesellschaft), без украшений.",
    "time": (3, 4),
    "fifths": 1,
    "tempo": 100,
    "rh": [
        "D5:4 [G4:8 A4:8 B4:8 C5:8]",
        "D5:4 G4:4 G4:4",
        "E5:4 [C5:8 D5:8 E5:8 F#5:8]",
        "G5:4 G4:4 G4:4",
        "C5:4 [D5:8 C5:8 B4:8 A4:8]",
        "B4:4 [C5:8 B4:8 A4:8 G4:8]",
        "F#4:4 [G4:8 A4:8 B4:8 G4:8]",
        "A4:2.",
        "D5:4 [G4:8 A4:8 B4:8 C5:8]",
        "D5:4 G4:4 G4:4",
        "E5:4 [C5:8 D5:8 E5:8 F#5:8]",
        "G5:4 G4:4 G4:4",
        "C5:4 [D5:8 C5:8 B4:8 A4:8]",
        "B4:4 [C5:8 B4:8 A4:8 G4:8]",
        "A4:4 [B4:8 A4:8 G4:8 F#4:8]",
        "G4:2.",
        "B5:4 [G5:8 A5:8 B5:8 G5:8]",
        "A5:4 [D5:8 E5:8 F#5:8 D5:8]",
        "G5:4 [E5:8 F#5:8 G5:8 D5:8]",
        "C#5:4 [B4:8 C#5:8] A4:4",
        "[A4:8 B4:8 C#5:8 D5:8 E5:8 F#5:8]",
        "G5:4 F#5:4 E5:4",
        "F#5:4 A4:4 C#5:4",
        "D5:2.",
        "D5:4 [G4:8 F#4:8] G4:4",
        "E5:4 [G4:8 F#4:8] G4:4",
        "D5:4 C5:4 B4:4",
        "[A4:8 G4:8 F#4:8 G4:8] A4:4",
        "[D4:8 E4:8 F#4:8 G4:8 A4:8 B4:8]",
        "C5:4 B4:4 A4:4",
        "[B4:8 D5:8] G4:4 F#4:4",
        "B3+D4+G4:2.",
    ],
    "lh": [
        "G3+B3+D4:2 A3:4",
        "B3:2.",
        "C4:2.",
        "B3:2.",
        "A3:2.",
        "G3:2.",
        "D4:4 B3:4 G3:4",
        "D4:4 [D3:8 C4:8 B3:8 A3:8]",
        "B3:2 A3:4",
        "G3:4 B3:4 G3:4",
        "C4:2.",
        "B3:4 [C4:8 B3:8 A3:8 G3:8]",
        "A3:2 F#3:4",
        "G3:2 B3:4",
        "C4:4 D4:4 D3:4",
        "G3:2 G2:4",
        "G3:2.",
        "F#3:2.",
        "E3:4 G3:4 E3:4",
        "A3:2 A2:4",
        "A3:2.",
        "B3:4 D4:4 C#4:4",
        "D4:4 F#3:4 A3:4",
        "D4:4 D3:4 C4!:4",
        "B3:4~ B3+D4:2",
        "C4:4~ C4+E4:2",
        "B3:4 A3:4 G3:4",
        "D4:2 r:4",
        "D3:2 F#3:4",
        "E3:4 G3:4 F#3:4",
        "G3:4 B2:4 D3:4",
        "G3:4 D3:4 G2:4",
    ],
}


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "src" / "pieces"
    out.mkdir(parents=True, exist_ok=True)
    for name, piece in [("ode-to-joy", ODE), ("minuet-g-anh114", MINUET)]:
        path = out / f"{name}.musicxml"
        path.write_text(build(piece), encoding="utf-8")
        print(f"{path.relative_to(out.parent.parent)}: {len(piece['rh'])} тактов")


if __name__ == "__main__":
    main()
