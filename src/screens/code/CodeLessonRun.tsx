import { useRef, useState } from "react";
import { api } from "../../api";
import { useBackLabel } from "../../components/BackLabel";
import { checkLesson, playCheck, type CheckResult, type CodeLesson } from "../../lib/codeLessons";
import { CodeEditor, type CodeEditorHandle } from "./CodeEditor";

/** Текст с `кодом` в обратных кавычках. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>))}
    </>
  );
}

/** Урок «Музыка кодом»: теория, задание, редактор, подсказки, проверка. */
export function CodeLessonRun({ lesson, onBack }: { lesson: CodeLesson; onBack: () => void }) {
  const back = useBackLabel("← Курс");
  const handle = useRef<CodeEditorHandle | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [hints, setHints] = useState(0);
  const [busy, setBusy] = useState(false);
  const live = lesson.check.kind === "play" || lesson.check.kind === "improv";

  const record = (r: CheckResult, accuracy = r.ok ? 1 : 0) => {
    setResult(r);
    void api.exerciseRecord({ exercise: lesson.id, tempo: 1, accuracy, timingSdMs: 0, loudness: 1, passed: r.ok }).catch(() => {});
  };

  const check = async () => {
    const h = handle.current;
    if (!h) return;
    setBusy(true);
    try {
      record(await checkLesson(lesson, h.code()));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="code-lesson" data-code-lesson={lesson.id}>
      <div className="code-lesson-head">
        <button className="ghost" onClick={onBack}>
          {back}
        </button>
        <h2>{lesson.title}</h2>
        <span className={lesson.portable ? "chip good small" : "chip small"} title={lesson.portable ? "Этот код работает и на strudel.cc" : "Использует функции MIDI Teacher"}>
          {lesson.portable ? "работает и на strudel.cc" : "только в MIDI Teacher"}
        </span>
      </div>
      <div className="code-lesson-body">
        <aside className="code-lesson-text">
          {lesson.theory.map((t, i) => (
            <p key={i}>
              <Rich text={t} />
            </p>
          ))}
          <div className="code-lesson-task">
            <b>Задание.</b> <Rich text={lesson.task} />
          </div>
          {lesson.hints.slice(0, hints).map((h, i) => (
            <p key={i} className="hint">
              💡 <Rich text={h} />
            </p>
          ))}
          <div className="buttons">
            {hints < lesson.hints.length && (
              <button className="ghost small" onClick={() => setHints((n) => n + 1)} data-code-lesson-hint>
                Подсказка
              </button>
            )}
            {lesson.answer && (
              <button className="ghost small" onClick={() => handle.current?.setCode(lesson.answer)} data-code-lesson-answer>
                Показать ответ
              </button>
            )}
          </div>
          {result && (
            <div className={result.ok ? "notice good" : "notice warn"} data-code-lesson-result={result.ok ? "ok" : "fail"}>
              {result.message}
              {result.ok && (
                <>
                  {" "}
                  <button className="link" onClick={onBack} data-code-lesson-next>
                    Дальше
                  </button>
                </>
              )}
            </div>
          )}
        </aside>
        <div className="code-lesson-editor">
          <CodeEditor
            initialCode={lesson.starter}
            panel={{}}
            compact
            onReady={(h) => (handle.current = h)}
            onSummary={(s) => {
              const r = playCheck(lesson, { you: { accuracy: s.accuracy, expected: s.expected } });
              if (r) record(r, s.accuracy);
            }}
            onImprov={(s) => {
              const r = playCheck(lesson, { improv: s });
              if (r) record(r, s.total ? s.inKey / s.total : 0);
            }}
            toolbar={
              !live && (
                <button className="primary" onClick={() => void check()} disabled={busy} data-code-lesson-check>
                  ✓ Проверить
                </button>
              )
            }
          />
        </div>
      </div>
    </div>
  );
}
