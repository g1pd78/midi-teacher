// «В код» с других экранов: открыть вкладку «Код» с новым треком.

export interface CodeRequest {
  name: string;
  text: string;
}

let pending: CodeRequest | null = null;

/** Попросить вкладку «Код» создать трек; App переключится на неё. */
export function requestCode(req: CodeRequest) {
  pending = req;
  window.dispatchEvent(new CustomEvent("mt-open-code"));
}

/** Забрать запрос (вкладка «Код» при открытии). */
export function takeCodeRequest(): CodeRequest | null {
  const r = pending;
  pending = null;
  return r;
}
