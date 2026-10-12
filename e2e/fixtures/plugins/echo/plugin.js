// Тестовый плагин для сквозного теста (не камера): сообщает палец каждой нажатой ноты по аппликатуре
// шага — верно, неверно или молчит, как скажет тест через window.__echo.mode.

export async function activate(host) {
  const echo = { mode: "right", host, reports: 0 };
  window.__echo = echo;

  const prev = (await host.storage.get()) ?? {};
  await host.storage.set({ activated: (prev.activated ?? 0) + 1 });

  host.registerSettings({
    title: "Эхо",
    mount(el) {
      el.innerHTML = '<p data-echo-settings>Тестовый плагин: сообщает пальцы по аппликатуре.</p>';
    },
  });
  host.registerPieceOverlay({
    mount(el) {
      el.innerHTML = '<div data-echo-overlay style="padding:6px 10px;border:1px solid #888;border-radius:6px">эхо</div>';
      return () => (el.innerHTML = "");
    },
  });

  // Пальцы нот двух последних шагов: шаг успевает смениться раньше, чем приходит нажатие.
  let fingers = new Map();
  let older = new Map();
  host.onPieceStep((step) => {
    older = fingers;
    fingers = new Map((step?.notes ?? []).map((n) => [n.pitch, n.finger]));
  });

  host.onMidi((n) => {
    if (n.type !== "on" || echo.mode === "silent") return;
    const finger = fingers.get(n.pitch) ?? older.get(n.pitch);
    if (!finger) return;
    // Как камера: ответ чуть позже нажатия.
    setTimeout(() => {
      echo.reports++;
      host.reportFinger({ pitch: n.pitch, finger: echo.mode === "wrong" ? (finger % 5) + 1 : finger });
    }, 20);
  });
}
