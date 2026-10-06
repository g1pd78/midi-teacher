// Имитация ядра для вкладки «Код» (разработка в браузере): файлы-треки и настройки панели в памяти.

const START = `// Мой первый трек. Ctrl+Enter — играть, Ctrl+. — стоп.
setcps(0.5)

drums: s("bd ~ sd ~, hh*8").gain(0.8)
bass: note("<a1 f1 c2 g1>").s("sawtooth").lpf(600)
melody: note("a3 c4 e4 c4").s("triangle").gain(0.6)
`;

export function createCodeMock() {
  const files = new Map<string, { text: string; modified: number }>([["Первый трек.js", { text: START, modified: Date.now() }]]);
  const unique = (name: string) => {
    if (!files.has(name)) return name;
    const stem = name.replace(/\.js$/, "");
    for (let i = 2; ; i++) if (!files.has(`${stem} (${i}).js`)) return `${stem} (${i}).js`;
  };
  const wavs: string[] = [];
  return {
    handlers: {
      code_folder: () => "Документы/MIDI Teacher/Код",
      code_list: () =>
        [...files.entries()]
          .filter(([n]) => n.endsWith(".js"))
          .map(([name, f]) => ({ name, modified: f.modified }))
          .sort((a, b) => b.modified - a.modified),
      code_read: ({ name }: { name: string }) => {
        const f = files.get(name);
        return f ? [f.text, f.modified] : null;
      },
      code_write: ({ name, text }: { name: string; text: string }) => {
        const modified = Date.now();
        files.set(name, { text, modified });
        return modified;
      },
      code_create: ({ name, text }: { name: string; text: string }) => {
        const file = unique(`${name.trim() || "трек"}.js`);
        files.set(file, { text, modified: Date.now() });
        return file;
      },
      code_rename: ({ from, to }: { from: string; to: string }) => {
        const f = files.get(from);
        const file = unique(`${to.replace(/\.js$/, "").trim()}.js`);
        if (f) {
          files.delete(from);
          files.set(file, f);
        }
        const cfg = files.get(from.replace(/\.js$/, ".mt.json"));
        if (cfg) files.set(file.replace(/\.js$/, ".mt.json"), cfg);
        return file;
      },
      code_delete: ({ name }: { name: string }) => {
        files.delete(name);
        files.delete(name.replace(/\.js$/, ".mt.json"));
      },
      code_open_folder: () => undefined,
      code_sample_banks: () => ({ user: {}, rec: [] }),
      code_import_samples: ({ folder }: { folder: string }) => folder,
      code_save_wav: ({ name, data }: { name: string; data: string }) => {
        wavs.push(`${name}:${data.length}`);
        return `Документы/MIDI Teacher/Треки/${name}.wav`;
      },
      code_net_text: () => {
        throw new Error("нет сети в имитации");
      },
    },
    /** Для проверок в браузере. */
    savedWavs: () => wavs.slice(),
  };
}
