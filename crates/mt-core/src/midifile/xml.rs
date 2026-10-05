//! Запись станов MusicXML: события, длительности по долям, лиги, ноты.

use super::*;

/// Событие стана: аккорд или пауза на отрезке [start, end).
#[derive(Debug, Clone)]
pub(super) struct Event {
    pub(super) start: i64,
    pub(super) end: i64,
    /// Пусто — пауза.
    pub(super) pitches: Vec<u8>,
}

/// Одноголосный поток аккордов стана: ноты с общим началом — аккорд, он длится до
/// следующего начала (или до своего конца, дальше — пауза).
pub(super) fn staff_events(notes: &[QNote], total: i64) -> Vec<Event> {
    let mut starts: BTreeMap<i64, Vec<&QNote>> = BTreeMap::new();
    for n in notes {
        starts.entry(n.start).or_default().push(n);
    }
    let keys: Vec<i64> = starts.keys().copied().collect();
    let mut out = Vec::new();
    let mut pos = 0;
    for (i, &s) in keys.iter().enumerate() {
        if s > pos {
            out.push(Event {
                start: pos,
                end: s,
                pitches: vec![],
            });
        }
        let next = keys.get(i + 1).copied().unwrap_or(total);
        let chord = &starts[&s];
        let end = chord
            .iter()
            .map(|n| n.end)
            .max()
            .unwrap_or(s + STRAIGHT)
            .min(next)
            .max(s + 1);
        let mut pitches: Vec<u8> = chord.iter().map(|n| n.pitch).collect();
        pitches.sort_unstable();
        pitches.dedup();
        out.push(Event {
            start: s,
            end,
            pitches,
        });
        pos = end;
    }
    if pos < total {
        out.push(Event {
            start: pos,
            end: total,
            pitches: vec![],
        });
    }
    out
}

/// Длительность одного элемента записи.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Piece {
    pub(super) start: i64,
    pub(super) dur: i64,
    pub(super) triplet: bool,
}

pub(super) fn note_type(dur: i64, triplet: bool) -> (&'static str, u8) {
    let d = if triplet { dur * 3 / 2 } else { dur };
    match d {
        48 => ("whole", 0),
        36 => ("half", 1),
        24 => ("half", 0),
        18 => ("quarter", 1),
        12 => ("quarter", 0),
        9 => ("eighth", 1),
        6 => ("eighth", 0),
        3 => ("16th", 0),
        _ => ("16th", 0),
    }
}

/// Разбить отрезок на записываемые длительности (внутри такта).
pub(super) fn pieces(start: i64, end: i64, measure_start: i64, grids: &[i64]) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut p = start;
    while p < end {
        let q = p.div_euclid(DIV);
        let triplet = grids.get(q as usize).copied() == Some(TRIPLET);
        let q_end = (q + 1) * DIV;
        if triplet {
            // Внутри триольной четверти: восьмая-триоль (4) или четверть-триоль (8);
            // целая четверть пишется обычной.
            let e = end.min(q_end);
            let local = p - q * DIV;
            let len = e - p;
            let d = if local == 0 && len >= DIV {
                out.push(Piece {
                    start: p,
                    dur: DIV,
                    triplet: false,
                });
                p += DIV;
                continue;
            } else if len >= 8 && local % 4 == 0 {
                8
            } else {
                4.min(len).max(1)
            };
            out.push(Piece {
                start: p,
                dur: d,
                triplet: true,
            });
            p += d;
            continue;
        }
        // Обычная сетка: самая длинная длительность, которая начинается «на месте»
        // и не заходит в триольную четверть.
        let rel = p - measure_start;
        let mut limit = end;
        let mut qq = q;
        while qq * DIV < end {
            if grids.get(qq as usize).copied() == Some(TRIPLET) && qq * DIV > p {
                limit = limit.min(qq * DIV);
                break;
            }
            qq += 1;
        }
        let rem = limit - p;
        let choice = [48, 36, 24, 18, 12, 9, 6, 3]
            .into_iter()
            .find(|&v| {
                let align = match v {
                    48 => 48,
                    36 | 24 => 24,
                    18 | 12 => 12,
                    9 | 6 => 6,
                    _ => 3,
                };
                v <= rem && rel % align == 0
            })
            .unwrap_or(rem.clamp(1, 3));
        out.push(Piece {
            start: p,
            dur: choice,
            triplet: false,
        });
        p += choice;
    }
    out
}

pub(super) struct StaffWriter<'a> {
    pub(super) staff: u8,
    pub(super) fifths: i8,
    pub(super) minor: bool,
    pub(super) grids: &'a [i64],
}

impl StaffWriter<'_> {
    pub(super) fn measure_xml(
        &self,
        events: &[Event],
        m_start: i64,
        m_end: i64,
        tie_in: &mut Vec<u8>,
    ) -> String {
        let voice = if self.staff == 1 { 1 } else { 5 };
        let mut alters: HashMap<(char, i32), i8> = HashMap::new();
        let mut items: Vec<(Piece, Vec<u8>, bool, bool)> = Vec::new(); // (длительность, высоты, лига-конец, лига-начало)
        for ev in events.iter().filter(|e| e.end > m_start && e.start < m_end) {
            let s = ev.start.max(m_start);
            let e = ev.end.min(m_end);
            let ps = pieces(s, e, m_start, self.grids);
            let n = ps.len();
            for (k, piece) in ps.into_iter().enumerate() {
                let first_of_event = k == 0 && s == ev.start;
                let tie_stop = !ev.pitches.is_empty() && !first_of_event;
                let tie_start = !ev.pitches.is_empty() && (k + 1 < n || e < ev.end);
                items.push((piece, ev.pitches.clone(), tie_stop, tie_start));
            }
        }
        tie_in.clear();
        // Рёбра: восьмые и шестнадцатые внутри одной четверти.
        let mut beams: Vec<Option<&str>> = vec![None; items.len()];
        let mut i = 0;
        while i < items.len() {
            let q = items[i].0.start.div_euclid(DIV);
            let mut j = i;
            while j < items.len()
                && items[j].0.start.div_euclid(DIV) == q
                && !items[j].1.is_empty()
                && note_type(items[j].0.dur, items[j].0.triplet).0 != "quarter"
                && items[j].0.dur < DIV
            {
                j += 1;
            }
            if j - i >= 2 {
                for (k, b) in beams.iter_mut().enumerate().take(j).skip(i) {
                    *b = Some(if k == i {
                        "begin"
                    } else if k == j - 1 {
                        "end"
                    } else {
                        "continue"
                    });
                }
                i = j;
            } else {
                i += 1;
            }
        }
        // Триольные группы: начало и конец скобки в каждой триольной четверти.
        let mut xml = String::new();
        for (idx, (piece, pitches, tie_stop, tie_start)) in items.iter().enumerate() {
            let (ty, dots) = note_type(piece.dur, piece.triplet);
            let tq = piece.start.div_euclid(DIV);
            let tuplet_first = piece.triplet
                && (idx == 0
                    || !items[idx - 1].0.triplet
                    || items[idx - 1].0.start.div_euclid(DIV) != tq);
            let tuplet_last = piece.triplet
                && (idx + 1 == items.len()
                    || !items[idx + 1].0.triplet
                    || items[idx + 1].0.start.div_euclid(DIV) != tq);
            let time_mod = if piece.triplet {
                "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>"
            } else {
                ""
            };
            let tuplet = match (tuplet_first, tuplet_last) {
                (true, _) => r#"<notations><tuplet type="start" bracket="yes"/></notations>"#,
                (_, true) => r#"<notations><tuplet type="stop"/></notations>"#,
                _ => "",
            };
            let dot_xml = "<dot/>".repeat(dots as usize);
            if pitches.is_empty() {
                xml.push_str(&format!(
                    "<note><rest/><duration>{}</duration><voice>{voice}</voice><type>{ty}</type>{dot_xml}{time_mod}<staff>{}</staff>{tuplet}</note>",
                    piece.dur, self.staff
                ));
                continue;
            }
            for (k, &p) in pitches.iter().enumerate() {
                let (step, alter, oct) = spell(p, self.fifths, self.minor);
                let key_default = spell_default(step, self.fifths);
                let current = alters.get(&(step, oct)).copied().unwrap_or(key_default);
                let accidental = if alter != current && !tie_stop {
                    alters.insert((step, oct), alter);
                    format!(
                        "<accidental>{}</accidental>",
                        match alter {
                            1 => "sharp",
                            -1 => "flat",
                            2 => "double-sharp",
                            -2 => "flat-flat",
                            _ => "natural",
                        }
                    )
                } else {
                    String::new()
                };
                let alter_xml = if alter != 0 {
                    format!("<alter>{alter}</alter>")
                } else {
                    String::new()
                };
                let ties = format!(
                    "{}{}",
                    if *tie_stop {
                        r#"<tie type="stop"/>"#
                    } else {
                        ""
                    },
                    if *tie_start {
                        r#"<tie type="start"/>"#
                    } else {
                        ""
                    }
                );
                let tied = format!(
                    "{}{}",
                    if *tie_stop {
                        r#"<tied type="stop"/>"#
                    } else {
                        ""
                    },
                    if *tie_start {
                        r#"<tied type="start"/>"#
                    } else {
                        ""
                    }
                );
                let tuplet_inner = tuplet
                    .trim_start_matches("<notations>")
                    .trim_end_matches("</notations>");
                let notations = if tied.is_empty() && (k > 0 || tuplet.is_empty()) {
                    String::new()
                } else {
                    format!(
                        "<notations>{tied}{}</notations>",
                        if k == 0 { tuplet_inner } else { "" }
                    )
                };
                let beam = match (k, beams[idx]) {
                    (0, Some(b)) => format!(r#"<beam number="1">{b}</beam>"#),
                    _ => String::new(),
                };
                xml.push_str(&format!(
                    "<note>{}<pitch><step>{step}</step>{alter_xml}<octave>{oct}</octave></pitch><duration>{}</duration>{ties}<voice>{voice}</voice><type>{ty}</type>{dot_xml}{time_mod}{accidental}<staff>{}</staff>{beam}{notations}</note>",
                    if k > 0 { "<chord/>" } else { "" },
                    piece.dur,
                    self.staff
                ));
                if *tie_start && idx + 1 == items.len() {
                    tie_in.push(p);
                }
            }
        }
        xml
    }
}

pub(super) fn spell_default(step: char, fifths: i8) -> i8 {
    let i = STEPS.iter().position(|&c| c == step).unwrap_or(0);
    let order = if fifths >= 0 { "FCGDAEB" } else { "BEADGCF" };
    let idx = order.find(step).unwrap_or(7);
    let _ = i;
    if idx < fifths.unsigned_abs() as usize {
        if fifths > 0 {
            1
        } else {
            -1
        }
    } else {
        0
    }
}

pub(super) fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
