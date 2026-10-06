#!/usr/bin/env python3
"""Переводит исходник LilyPond (Mutopia Project) в MusicXML для фортепиано — подмножество языка,
которого хватает встроенным пьесам.

Запуск: python3 scripts/ly2musicxml.py <файл.ly> <выход.musicxml> --title … --composer … --rights …
        [--upper ИМЯ] [--lower ИМЯ] [--fifths N] [--time 3/8] [--pickup 1/8] [--tempo 72]

Понимает: ноты (абсолютные и \\relative), \\transpose c c' (сдвиг на октавы), аккорды <…>, паузы r/R/s,
длительности с точками и множителями (R4.*3), лиги ~, \\times/\\tuplet 3/2, голоса << {…} \\\\ {…} >>,
\\repeat volta/unfold с \\alternative (развёртываются), смену ключа \\clef. Форшлаги (\\grace,
\\appoggiatura), оттенки, педаль, украшения и оформление пропускаются. Станы — по именам переменных
(`right = {…}`) или по `\\new Staff = "up" {…}` в порядке появления.
"""

from __future__ import annotations

import argparse
import re
from fractions import Fraction as F
from xml.sax.saxutils import escape

NOTE_SEMI = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
STEP_OF = "CDEFGAB"
SHARP_ORDER = "FCGDAEB"
FLAT_ORDER = "BEADGCF"
DIV = 24  # делений на четверть: 32-е (3) и триоли шестнадцатых (4) — целые


# --- Разбор ---------------------------------------------------------------------------------------

TOKEN_RE = re.compile(
    r"""
    (?P<comment>%[^\n]*)
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<cmd>\\[a-zA-Z]+(?:\.[a-zA-Z-]+)*|\\\\)
  | (?P<scheme>\#'?\([^()]*(?:\([^()]*\)[^()]*)*\)|\#\#?[^\s{}]+)
  | (?P<open><<|\{|<)
  | (?P<close>>>|\}|>)
  | (?P<note>[a-g](?:isis|eses|is|es)*[',]*!?\??(?![a-zA-Z]))
  | (?P<rest>[rRs])(?![a-zA-Z])
  | (?P<dur>\d+\.*(?:\*\d+(?:/\d+)?)?)
  | (?P<tie>~)
  | (?P<other>[\[\]()|^_\-.:=!>]|[A-Za-z][\w.-]*|\S)
    """,
    re.X,
)


def tokenize(text: str) -> list[tuple[str, str]]:
    out = []
    for m in TOKEN_RE.finditer(text):
        kind = m.lastgroup
        if kind in ("comment",):
            continue
        out.append((kind, m.group()))
    return out


def find_block(tokens, start):
    """Индекс закрывающей скобки для открывающей в tokens[start]."""
    depth = 0
    for i in range(start, len(tokens)):
        k, v = tokens[i]
        if k == "open" and v in ("{", "<<"):
            depth += 1
        elif k == "close" and v in ("}", ">>"):
            depth -= 1
            if depth == 0:
                return i
    raise ValueError("нет закрывающей скобки")


def parse_dur(text: str) -> F:
    m = re.match(r"(\d+)(\.*)(?:\*(\d+)(?:/(\d+))?)?$", text)
    base = F(1, int(m.group(1)))
    d = base
    add = base
    for _ in m.group(2):
        add /= 2
        d += add
    if m.group(3):
        d *= int(m.group(3))
        if m.group(4):
            d /= int(m.group(4))
    return d


def pitch_of(note: str) -> tuple[int, int, int]:
    """Нота LilyPond без октавы → (ступень 0–6, альтерация, сдвиг октавы)."""
    m = re.match(r"([a-g])((?:isis|eses|is|es)*)([',]*)", note)
    step = "cdefgab".index(m.group(1))
    acc = m.group(2)
    alter = acc.count("is") - acc.count("es")
    octs = m.group(3).count("'") - m.group(3).count(",")
    return step, alter, octs


class Ev:
    """Событие голоса: ноты (MIDI, ступень, альтерация, октава) или пауза, длительность в целых."""

    def __init__(self, pitches, dur, tie=False, tuplet=None, clef=None):
        self.pitches = pitches  # список (midi, step, alter, octave); пусто — пауза
        self.dur = dur
        self.tie = tie
        self.tuplet = tuplet
        self.clef = clef


class Parser:
    def __init__(self, tokens, variables):
        self.t = tokens
        self.vars = variables

    def music(self, i, end, ctx, voice):
        """Разбирает tokens[i:end] в список событий `voice`. ctx: dur, rel (последняя нота), oct, scale."""
        while i < end:
            k, v = self.t[i]
            if k == "note" or k == "rest":
                i = self.note(i, ctx, voice)
                continue
            if k == "open" and v == "<":
                i = self.chord(i, ctx, voice)
                continue
            if k == "open" and v == "{":
                j = find_block(self.t, i)
                self.music(i + 1, j, ctx, voice)
                i = j + 1
                continue
            if k == "open" and v == "<<":
                j = find_block(self.t, i)
                i = self.simultaneous(i + 1, j, ctx, voice)
                continue
            if k == "tie":
                if voice and voice[-1].pitches:
                    voice[-1].tie = True
                i += 1
                continue
            if k == "cmd":
                i = self.command(i, end, ctx, voice)
                continue
            if k == "other" and v in self.vars:
                body = self.vars[v]
                Parser(body, self.vars).music(0, len(body), ctx, voice)
                i += 1
                continue
            i += 1
        return i

    def simultaneous(self, i, end, ctx, voice):
        """<< {…} \\\\ {…} >>: голоса. Первый — в текущий поток, остальные — в отдельные голоса."""
        groups, cur = [], []
        while i < end:
            k, v = self.t[i]
            if k == "cmd" and v == "\\\\":
                groups.append(cur)
                cur = []
                i += 1
                continue
            if k == "open" and v in ("{", "<<"):
                j = find_block(self.t, i)
                cur.append((i, j))
                i = j + 1
                continue
            i += 1
        groups.append(cur)
        start = sum(e.dur for e in voice)
        for gi, blocks in enumerate(groups):
            target = voice if gi == 0 else self.extra_voice(ctx, start)
            sub = dict(ctx)
            for a, b in blocks:
                self.music(a + 1, b, sub, target)
            if gi == 0:
                ctx.update({k: sub[k] for k in ("dur", "rel")})
        return end + 1

    def extra_voice(self, ctx, start):
        voices = ctx["voices"]
        v = [Ev([], start)] if start else []
        voices.append(v)
        return v

    def note(self, i, ctx, voice):
        k, v = self.t[i]
        i += 1
        dur = None
        if i < len(self.t) and self.t[i][0] == "dur":
            dur = parse_dur(self.t[i][1])
            i += 1
        if dur is None:
            dur = ctx["dur"]
        else:
            ctx["dur"] = dur if "*" not in self.t[i - 1][1] else parse_dur(self.t[i - 1][1].split("*")[0])
        scaled = dur * ctx["scale"]
        if k == "rest":
            voice.append(Ev([], scaled, tuplet=ctx.get("tuplet")))
            return i
        voice.append(Ev([self.resolve(v, ctx)], scaled, tuplet=ctx.get("tuplet")))
        return i

    def chord(self, i, ctx, voice):
        j = i + 1
        pitches = []
        rel_save = ctx["rel"]
        first = None
        while self.t[j] != ("close", ">"):
            if self.t[j][0] == "note":
                p = self.resolve(self.t[j][1], ctx)
                if first is None:
                    first = ctx["rel"]
                pitches.append(p)
            j += 1
        j += 1
        if first is not None and ctx.get("relative"):
            ctx["rel"] = first  # в \relative следующая нота считается от первой ноты аккорда
        dur = ctx["dur"]
        if j < len(self.t) and self.t[j][0] == "dur":
            dur = parse_dur(self.t[j][1])
            ctx["dur"] = dur
            j += 1
        del rel_save
        voice.append(Ev(pitches, dur * ctx["scale"], tuplet=ctx.get("tuplet")))
        return j

    def resolve(self, text, ctx):
        step, alter, octs = pitch_of(text)
        if ctx.get("relative"):
            prev_step, prev_oct = ctx["rel"]
            # ближайшая к предыдущей ноте (в пределах кварты) — затем сдвиг октавы
            diff = step - prev_step
            octave = prev_oct
            if diff > 3:
                octave -= 1
            elif diff < -3:
                octave += 1
            octave += octs
            ctx["rel"] = (step, octave)
        else:
            octave = 3 + octs + ctx["oct"]  # c (без штрихов) — до малой октавы
        octave_mt = octave  # научная нотация: c' = C4
        semis = [0, 2, 4, 5, 7, 9, 11][step]
        midi = (octave_mt + 1) * 12 + semis + alter
        return (midi, step, alter, octave_mt)

    def command(self, i, end, ctx, voice):
        k, v = self.t[i]
        name = v[1:]
        nxt = lambda n=1: self.t[i + n] if i + n < len(self.t) else ("", "")

        if name == "relative":
            j = i + 1
            ref = (0, 4)  # без опорной ноты — c'
            if self.t[j][0] == "note":
                s, _a, o = pitch_of(self.t[j][1])
                ref = (s, 3 + o)
                j += 1
            b = find_block(self.t, j)
            sub = dict(ctx, relative=True, rel=ref)
            self.music(j + 1, b, sub, voice)
            ctx["dur"] = sub["dur"]
            return b + 1
        if name == "transpose":
            # только \transpose c c' (и подобное): сдвиг на октавы
            _s1, _a1, o1 = pitch_of(nxt()[1])
            _s2, _a2, o2 = pitch_of(nxt(2)[1])
            j = i + 3
            b = find_block(self.t, j)
            sub = dict(ctx, oct=ctx["oct"] + (o2 - o1))
            self.music(j + 1, b, sub, voice)
            ctx["dur"] = sub["dur"]
            return b + 1
        if name in ("times", "tuplet"):
            j = i + 1
            # "2/3" разбирается токенами: dur(2) other(/) dur(3) или одной строкой
            parts = []
            while self.t[j][0] in ("dur", "other") and self.t[j][1] != "{":
                parts.append(self.t[j][1])
                j += 1
                if len(parts) >= 3:
                    break
            num, den = int(parts[0]), int(parts[-1])
            scale = F(num, den) if name == "times" else F(den, num)
            while self.t[j][0] == "dur":  # \tuplet 3/2 8 { … } — длина групп
                j += 1
            b = find_block(self.t, j)
            sub = dict(ctx, scale=ctx["scale"] * scale, tuplet=(3, 2) if scale == F(2, 3) else None)
            self.music(j + 1, b, sub, voice)
            ctx.update(dur=sub["dur"], rel=sub["rel"])
            return b + 1
        if name == "repeat":
            kind = nxt()[1]
            count = int(nxt(2)[1])
            j = i + 3
            b = find_block(self.t, j)
            alts = []
            after = b + 1
            if after < len(self.t) and self.t[after] == ("cmd", "\\alternative"):
                ab = find_block(self.t, after + 1)
                p = after + 2
                while p < ab:
                    if self.t[p] == ("open", "{"):
                        q = find_block(self.t, p)
                        alts.append((p, q))
                        p = q + 1
                    else:
                        p += 1
                after = ab + 1
            for n in range(count):
                self.music(j + 1, b, ctx, voice)
                if alts:
                    a, q = alts[min(n, len(alts) - 1)] if kind == "volta" else alts[n % len(alts)]
                    self.music(a + 1, q, ctx, voice)
            return after
        if name in ("grace", "appoggiatura", "acciaccatura", "afterGrace"):
            # форшлаги пропускаем (с учётом \relative — опорная нота сдвигается)
            j = i + 1
            if self.t[j] == ("open", "{"):
                b = find_block(self.t, j)
                self.music(j + 1, b, dict(ctx, scale=F(0)), [])
                return b + 1
            sub = dict(ctx, scale=F(0))
            return self.note(j, sub, [])
        if name == "clef":
            val = nxt()[1].strip('"')
            clef = {"treble": "G", "violin": "G", "G": "G", "bass": "F", "F": "F"}.get(val, "G")
            voice.append(Ev([], F(0), clef=clef))
            return i + 2
        if name == "partial":
            ctx["partial"] = parse_dur(nxt()[1])
            return i + 2
        if name in ("key",):
            return i + 3
        if name in ("time", "tempo"):
            j = i + 1
            if self.t[j][0] == "string":
                j += 1
            while j < end and (self.t[j][0] == "dur" or self.t[j][1] in ("/", "=")):
                j += 1
            return j
        if name in ("set", "override", "once", "unset", "revert", "tweak"):
            # \set X.y = #… / \override X.y = #… / \once \override …
            j = i + 1
            while j < end:
                kk, vv = self.t[j]
                if kk in ("scheme", "string"):
                    return j + 1
                if kk == "cmd" and vv not in ("\\override", "\\set"):
                    return j + 1 if vv == "\\markup" else j
                if kk == "dur" and self.t[j - 1][1] == "=":
                    return j + 1
                j += 1
            return j
        if name in ("markup",):
            j = i + 1
            if self.t[j] == ("open", "{"):
                return find_block(self.t, j) + 1
            return j + 1
        if name in ("bar", "ottava", "tupletSpan", "mark", "label"):
            return i + 2
        if name in ("new", "context"):
            # \new Staff = "x" { … } внутри музыки — разворачиваем тело
            j = i + 2
            if self.t[j][1] == "=":
                j += 2
            return j
        if name == "skip":
            d = parse_dur(nxt()[1])
            voice.append(Ev([], d * ctx["scale"]))
            return i + 2
        return i + 1


def variables_of(tokens):
    """name = { … } и name = \\relative … { … } → токены тела."""
    out = {}
    i = 0
    while i < len(tokens) - 2:
        k, v = tokens[i]
        if k == "other" and re.match(r"^[A-Za-z]+$", v) and tokens[i + 1] == ("other", "="):
            j = i + 2
            if tokens[j] == ("open", "{") or tokens[j] in (("cmd", "\\relative"), ("cmd", "\\transpose")):
                start = j
                while tokens[j] != ("open", "{"):
                    j += 1
                b = find_block(tokens, j)
                out[v] = tokens[start : b + 1]
                i = b + 1
                continue
        i += 1
    return out


def staff_blocks(tokens):
    """\\new Staff = "имя" { … } на верхнем уровне \\score — по порядку."""
    out = []
    for i, (k, v) in enumerate(tokens):
        if k == "cmd" and v in ("\\new", "\\context") and i + 1 < len(tokens) and tokens[i + 1][1] == "Staff":
            j = i + 2
            if tokens[j][1] == "=":
                j += 2
            if tokens[j][0] == "open" and tokens[j][1] == "{":
                b = find_block(tokens, j)
                out.append(tokens[j : b + 1])
            elif tokens[j][0] == "other":
                out.append([tokens[j]])
    return out


def staff_voices(tokens, variables):
    ctx = {"dur": F(1, 4), "rel": (0, 4), "oct": 0, "scale": F(1), "voices": []}
    main: list[Ev] = []
    Parser(tokens, variables).music(0, len(tokens), ctx, main)
    return [main] + ctx["voices"], ctx.get("partial")


# --- Запись MusicXML -------------------------------------------------------------------------------

TYPES = [(96, "whole"), (48, "half"), (24, "quarter"), (12, "eighth"), (6, "16th"), (3, "32nd")]


def note_type(dur: int, tuplet) -> tuple[str, int]:
    if tuplet:
        dur = dur * 3 // 2
    for base, name in TYPES:
        if dur == base:
            return name, 0
        if dur == base * 3 // 2:
            return name, 1
        if dur == base * 7 // 4:
            return name, 2
    raise ValueError(f"длительность {dur} не записывается")


WRITABLE = sorted({v for base, _ in TYPES for v in (base, base * 3 // 2) if v == int(v)}, reverse=True)


def split_dur(d: int) -> list[int]:
    """Длительность → сумма записываемых (с точкой или без)."""
    out = []
    while d > 0:
        c = next((v for v in WRITABLE if v <= d), None)
        if c is None:
            raise ValueError(f"не делится: {d}")
        out.append(c)
        d -= c
    return out


def key_alters(fifths):
    if fifths >= 0:
        return {s: 1 for s in SHARP_ORDER[:fifths]}
    return {s: -1 for s in FLAT_ORDER[:-fifths]}


def bar_events(voice: list[Ev], measure: int, pickup: int):
    """События голоса → по тактам: [(начало в такте, длит., ноты, лига-начало, лига-конец, триоль, ключ)]."""
    bars: list[list] = []
    pos = 0
    tie_in: set[int] = set()

    def bar_of(p):
        if pickup:
            if p < pickup:
                return 0, 0, pickup
            n = (p - pickup) // measure + 1
            start = pickup + (n - 1) * measure
        else:
            n = p // measure
            start = n * measure
        return n, start, measure

    for ev in voice:
        d = int(ev.dur * 4 * DIV)
        if ev.clef:
            n, start, _ = bar_of(pos)
            while len(bars) <= n:
                bars.append([])
            bars[n].append(("clef", pos - start, ev.clef))
            continue
        if d == 0:
            continue
        left = d
        p = pos
        first = True
        while left > 0:
            n, start, length = bar_of(p)
            room = start + length - p
            take = min(room, left)
            while len(bars) <= n:
                bars.append([])
            pieces = [take] if (ev.tuplet and take == left) else split_dur(take)
            for k, piece in enumerate(pieces):
                last_piece = (left - piece) == 0 and k == len(pieces) - 1
                midis = [x[0] for x in ev.pitches]
                tstop = (not first) or any(m in tie_in for m in midis)
                tstart = (not last_piece) or ev.tie
                bars[n].append(("note", p - start, piece, ev.pitches, tstart and bool(ev.pitches), tstop and bool(ev.pitches), ev.tuplet))
                first = False
                p += piece
                left -= piece
        tie_in = set(x[0] for x in ev.pitches) if ev.tie else set()
        pos += d
    return bars


def beam_groups(items, measure, beat):
    """Номера нот под одним ребром: ноты короче четверти в пределах доли, паузы разрывают."""
    groups = {}
    cur = []
    cur_beat = None
    for idx, it in enumerate(items):
        if it[0] != "note":
            continue
        _, off, dur, pitches, *_rest = it
        tuplet = it[6]
        written = dur * 3 // 2 if tuplet else dur
        b = off // beat
        if not pitches or written >= 24 or b != cur_beat:
            if len(cur) > 1:
                for k, j in enumerate(cur):
                    groups[j] = "begin" if k == 0 else ("end" if k == len(cur) - 1 else "continue")
            cur = []
            cur_beat = b
        if pitches and written < 24:
            cur.append(idx)
    if len(cur) > 1:
        for k, j in enumerate(cur):
            groups[j] = "begin" if k == 0 else ("end" if k == len(cur) - 1 else "continue")
    return groups


def write_xml(staves, *, title, composer, rights, fifths, time, pickup, tempo):
    beats, beat_type = time
    measure = beats * 4 * DIV // beat_type
    beat = measure if beat_type == 8 else DIV
    pk = int(pickup * 4 * DIV) if pickup else 0
    # голоса: стан 1 — 1..4, стан 2 — 5..8
    per_staff = []
    nbars = 0
    for voices in staves:
        bv = [bar_events(v, measure, pk) for v in voices]
        nbars = max(nbars, *(len(b) for b in bv))
        per_staff.append(bv)
    alters_key = key_alters(fifths)
    out_measures = []
    for n in range(nbars):
        length = pk if (pk and n == 0) else measure
        implicit = ' implicit="yes"' if pk and n == 0 else ""
        parts = [f'<measure number="{n if pk else n + 1}"{implicit}>']
        if n == 0:
            parts.append(
                f"<attributes><divisions>{DIV}</divisions><key><fifths>{fifths}</fifths></key>"
                f"<time><beats>{beats}</beats><beat-type>{beat_type}</beat-type></time><staves>2</staves>"
                '<clef number="1"><sign>G</sign><line>2</line></clef>'
                '<clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
                f'<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>'
                f"<per-minute>{tempo}</per-minute></metronome></direction-type>"
                f'<sound tempo="{tempo}"/></direction>'
            )
        first_voice = True
        for si, bv in enumerate(per_staff):
            staff = si + 1
            measure_alters: dict = {}
            for vi, bars in enumerate(bv):
                items = bars[n] if n < len(bars) else []
                notes = [it for it in items if it[0] == "note"]
                if vi > 0 and not any(it[3] for it in notes):
                    continue  # пустой второй голос не пишем
                if not first_voice:
                    parts.append(f"<backup><duration>{length}</duration></backup>")
                first_voice = False
                voice_no = staff * 4 - 3 + vi
                beams = beam_groups(items, length, beat)
                filled = 0
                tuplet_count = 0
                for idx, it in enumerate(items):
                    if it[0] == "clef":
                        sign, line = ("G", 2) if it[2] == "G" else ("F", 4)
                        parts.append(f'<attributes><clef number="{staff}"><sign>{sign}</sign><line>{line}</line></clef></attributes>')
                        continue
                    _, off, dur, pitches, tstart, tstop, tuplet = it
                    if off > filled:  # дыра (второй голос начинается позже) — невидимая пауза
                        for piece in split_dur(off - filled):
                            t, dots = note_type(piece, None)
                            parts.append(f'<forward><duration>{piece}</duration><voice>{voice_no}</voice><staff>{staff}</staff></forward>')
                        filled = off
                    t, dots = note_type(dur, tuplet)
                    tm = "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>" if tuplet else ""
                    tup_note = ""
                    if tuplet:
                        if tuplet_count % 3 == 0:
                            tup_note = '<tuplet type="start" bracket="no"/>'
                        elif tuplet_count % 3 == 2:
                            tup_note = '<tuplet type="stop"/>'
                        tuplet_count += 1
                    if not pitches:
                        parts.append(f"<note><rest/><duration>{dur}</duration><voice>{voice_no}</voice><type>{t}</type>{'<dot/>' * dots}{tm}<staff>{staff}</staff>"
                                     + (f"<notations>{tup_note}</notations>" if tup_note else "") + "</note>")
                        filled += dur
                        continue
                    for pi, (midi, step, alter, octave) in enumerate(sorted(pitches)):
                        s = STEP_OF[step]
                        expected = measure_alters.get((s, octave), alters_key.get(s, 0))
                        acc = ""
                        if alter != expected and not tstop:
                            acc = "<accidental>" + {1: "sharp", -1: "flat", 0: "natural", 2: "double-sharp", -2: "flat-flat"}[alter] + "</accidental>"
                        measure_alters[(s, octave)] = alter
                        x = ["<note>"]
                        if pi > 0:
                            x.append("<chord/>")
                        x.append(f"<pitch><step>{s}</step>{f'<alter>{alter}</alter>' if alter else ''}<octave>{octave}</octave></pitch>")
                        x.append(f"<duration>{dur}</duration>")
                        if tstop:
                            x.append('<tie type="stop"/>')
                        if tstart:
                            x.append('<tie type="start"/>')
                        x.append(f"<voice>{voice_no}</voice><type>{t}</type>" + "<dot/>" * dots + acc + tm)
                        x.append(f"<staff>{staff}</staff>")
                        if pi == 0 and idx in beams:
                            x.append(f'<beam number="1">{beams[idx]}</beam>')
                        nots = []
                        if tstop:
                            nots.append('<tied type="stop"/>')
                        if tstart:
                            nots.append('<tied type="start"/>')
                        if pi == 0 and tup_note:
                            nots.append(tup_note)
                        if nots:
                            x.append("<notations>" + "".join(nots) + "</notations>")
                        x.append("</note>")
                        parts.append("".join(x))
                    filled += dur
                if filled < length and (vi == 0):
                    for piece in split_dur(length - filled):
                        t, dots = note_type(piece, None)
                        parts.append(f"<note><rest/><duration>{piece}</duration><voice>{voice_no}</voice><type>{t}</type>{'<dot/>' * dots}<staff>{staff}</staff></note>")
                elif filled < length:
                    parts.append(f'<forward><duration>{length - filled}</duration><voice>{voice_no}</voice><staff>{staff}</staff></forward>')
        if n == nbars - 1:
            parts.append('<barline location="right"><bar-style>light-heavy</bar-style></barline>')
        parts.append("</measure>")
        out_measures.append("".join(parts))
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
        '"http://www.musicxml.org/dtds/partwise.dtd">\n'
        '<score-partwise version="4.0">'
        f"<work><work-title>{escape(title)}</work-title></work>"
        f'<identification><creator type="composer">{escape(composer)}</creator>'
        f"<rights>{escape(rights)}</rights></identification>"
        '<part-list><score-part id="P1"><part-name print-object="no">Фортепиано</part-name></score-part></part-list>'
        '<part id="P1">' + "".join(out_measures) + "</part></score-partwise>\n"
    )


def load_staves(path, upper=None, lower=None):
    text = open(path, encoding="utf-8").read()
    tokens = tokenize(text)
    variables = variables_of(tokens)
    if upper and lower:
        blocks = [variables[upper], variables[lower]]
    else:
        blocks = staff_blocks(tokens)[:2]
    staves = []
    partial = None
    for b in blocks:
        voices, p = staff_voices(b, variables)
        partial = partial or p
        staves.append(voices)
    return staves, partial


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--title", required=True)
    ap.add_argument("--composer", required=True)
    ap.add_argument("--rights", required=True)
    ap.add_argument("--upper")
    ap.add_argument("--lower")
    ap.add_argument("--fifths", type=int, default=0)
    ap.add_argument("--time", default="4/4")
    ap.add_argument("--tempo", type=int, default=72)
    a = ap.parse_args()
    staves, partial = load_staves(a.src, a.upper, a.lower)
    num, den = (int(x) for x in a.time.split("/"))
    for si, voices in enumerate(staves):
        for vi, v in enumerate(voices):
            print(f"стан {si + 1}, голос {vi + 1}: {float(sum(e.dur for e in v) * 4):.3f} четвертей")
    xml = write_xml(staves, title=a.title, composer=a.composer, rights=a.rights, fifths=a.fifths, time=(num, den), pickup=partial, tempo=a.tempo)
    open(a.out, "w", encoding="utf-8").write(xml)


if __name__ == "__main__":
    main()
