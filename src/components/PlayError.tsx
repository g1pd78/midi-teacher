import { useCallback, useState } from "react";

/** Ошибка запуска звука (`play_notes`): видимая плашка вместо молчания. */
export function usePlayError() {
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((e: unknown) => setError(String(e)), []);
  const notice = error ? (
    <div className="notice warn" data-play-error>
      Звук не запустился: {error}
    </div>
  ) : null;
  return { report, notice };
}
