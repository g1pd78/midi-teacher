// Радио платы «MIDI Teacher Lights» без Arduino: роль платы, пакеты ESP-NOW, связка свистка с лентой,
// качество связи, статус для приложения. Проверяется на компьютере (radio_core_test.cpp, g++).
//
// Роли (прошивка одна, роль определяется сама):
//   «USB»      — плата в компьютере (есть USB-хост): кадры из приложения зажигают свою ленту и, если лента
//                связана, уходят по радио. Свисток — та же плата без ленты.
//   «приёмник» — USB-хоста нет (питание от блока 5 В или от зарядки): кадры приходят по радио.
//
// Пакет ESP-NOW: 'M' 'T' 'L' <версия> <тип> <номер lo> <номер hi> <данные…> (не больше 250 байт).
//   DATA      свисток → лента: SysEx целиком (кадр, калибровка, указка, проверка)
//   HEARTBEAT лента → свисток раз в секунду: <сила сигнала свистка у ленты, −дБм> <принято кадров lo hi>
//   PAIR_REQ  свисток → все (broadcast) каждые 300 мс в течение 10 с: <nonce 4 байта>
//   PAIR_ACK  лента → свисток: тот же nonce. Лента отвечает только первые 2 минуты после включения.
//
// SysEx приложения для радио (F0 7D 4D 54 <команда> … F7):
//   05 — запросить статус, 06 — связать с лентой, 07 — забыть ленту.
// Статус от платы в приложение (раз в секунду и по запросу):
//   F0 7D 4D 54 20 <версия> <связь> <связка> <−дБм> <потери %> F7
//   связь: 0 — ленты по радио нет (по проводу), 1 — на связи, 2 — не отвечает;
//   связка: 0 — нет, 1 — ищу ленту, 2 — связано, 3 — лента не нашлась; −дБм: 0 — неизвестно.

#pragma once
#include <stdint.h>
#include <string.h>

namespace mtr {

constexpr uint8_t VERSION = 1;
constexpr int MAX_PACKET = 250;  // предел ESP-NOW v1
constexpr int HEADER = 7;
constexpr int MAX_DATA = MAX_PACKET - HEADER;

constexpr uint32_t PAIR_WINDOW_MS = 120000;  // лента соглашается на связку 2 минуты после включения
constexpr uint32_t PAIR_SEARCH_MS = 10000;   // свисток ищет ленту 10 секунд
constexpr uint32_t PAIR_REPEAT_MS = 300;
constexpr uint32_t HEARTBEAT_MS = 1000;
constexpr uint32_t LINK_TIMEOUT_MS = 3000;  // нет HEARTBEAT дольше — лента не отвечает
constexpr int LOSS_WINDOW_S = 10;
constexpr uint32_t ROLE_SETTLE_MS = 3000;  // приёмник соглашается на связку, пробыв приёмником 3 с

constexpr uint8_t CMD_STATUS = 0x05;
constexpr uint8_t CMD_PAIR = 0x06;
constexpr uint8_t CMD_UNPAIR = 0x07;
constexpr uint8_t MSG_STATUS = 0x20;

enum PacketType : uint8_t { DATA = 1, HEARTBEAT = 2, PAIR_REQ = 3, PAIR_ACK = 4 };
enum Link : uint8_t { LINK_NONE = 0, LINK_ONLINE = 1, LINK_LOST = 2 };
enum PairState : uint8_t { PAIR_IDLE = 0, PAIR_SEARCHING = 1, PAIR_DONE = 2, PAIR_NOT_FOUND = 3 };
enum class Role : uint8_t { Usb, Receiver };

struct Mac {
  uint8_t b[6] = {0, 0, 0, 0, 0, 0};
  bool operator==(const Mac& o) const { return memcmp(b, o.b, 6) == 0; }
  bool operator!=(const Mac& o) const { return !(*this == o); }
  bool empty() const {
    for (uint8_t x : b)
      if (x) return false;
    return true;
  }
};

// --- Пакеты ---

struct Packet {
  uint8_t type = 0;
  uint16_t seq = 0;
  const uint8_t* data = nullptr;
  int len = 0;
};

/** Пакет в `out` (не меньше MAX_PACKET байт); размер или -1, если данные не влезают. */
inline int encode(uint8_t type, uint16_t seq, const uint8_t* data, int len, uint8_t* out) {
  if (len < 0 || len > MAX_DATA) return -1;
  out[0] = 'M';
  out[1] = 'T';
  out[2] = 'L';
  out[3] = VERSION;
  out[4] = type;
  out[5] = uint8_t(seq & 0xFF);
  out[6] = uint8_t(seq >> 8);
  if (len) memcpy(out + HEADER, data, len);
  return HEADER + len;
}

inline bool decode(const uint8_t* buf, int len, Packet& p) {
  if (len < HEADER || buf[0] != 'M' || buf[1] != 'T' || buf[2] != 'L' || buf[3] != VERSION) return false;
  p.type = buf[4];
  p.seq = uint16_t(buf[5] | (buf[6] << 8));
  p.data = buf + HEADER;
  p.len = len - HEADER;
  return true;
}

/**
 * SysEx под размер пакета: кадр длиннее MAX_DATA укорачивается по парам (клавиша, цвет), F7 остаётся в конце.
 * Возвращает новую длину (88 клавиш — 183 байта, укорачивать не приходится).
 */
inline int fitSysex(const uint8_t* in, int len, uint8_t* out, int max = MAX_DATA) {
  if (len <= max) {
    memcpy(out, in, len);
    return len;
  }
  int keep = max - 1;
  if (len > 5 && in[4] == 0x10) keep = 6 + ((max - 7) / 2) * 2;  // заголовок кадра + целые пары
  memcpy(out, in, keep);
  out[keep] = 0xF7;
  return keep + 1;
}

inline uint32_t readU32(const uint8_t* d) { return uint32_t(d[0]) | uint32_t(d[1]) << 8 | uint32_t(d[2]) << 16 | uint32_t(d[3]) << 24; }
inline void writeU32(uint32_t v, uint8_t* d) {
  for (int i = 0; i < 4; i++) d[i] = uint8_t(v >> (8 * i));
}

// --- SysEx приложения ---

/** Наш SysEx (F0 7D 4D 54 … F7). */
inline bool ours(const uint8_t* m, int len) {
  return len >= 6 && m[0] == 0xF0 && m[1] == 0x7D && m[2] == 0x4D && m[3] == 0x54 && m[len - 1] == 0xF7;
}

/** Команда радио (05/06/07) или 0 — тогда сообщение для ленты. */
inline uint8_t radioCommand(const uint8_t* m, int len) {
  if (!ours(m, len)) return 0;
  return (m[4] == CMD_STATUS || m[4] == CMD_PAIR || m[4] == CMD_UNPAIR) ? m[4] : 0;
}

/** Статус в приложение; размер (11 байт). `rssi` — дБм (отрицательное) или 0. */
inline int statusSysex(uint8_t link, uint8_t pair, int rssi, uint8_t loss, uint8_t* out) {
  int dbm = rssi < 0 ? -rssi : 0;
  if (dbm > 127) dbm = 127;
  const uint8_t m[] = {0xF0, 0x7D, 0x4D, 0x54, MSG_STATUS, VERSION, uint8_t(link & 0x7F), uint8_t(pair & 0x7F), uint8_t(dbm), uint8_t(loss > 100 ? 100 : loss), 0xF7};
  memcpy(out, m, sizeof m);
  return int(sizeof m);
}

/**
 * SysEx → пакеты USB-MIDI (кабель 0): по 3 байта с CIN 4, последний — CIN 5/6/7 (1/2/3 байта).
 * Возвращает число пакетов (не больше `max`).
 */
inline int sysexToUsb(const uint8_t* m, int len, uint8_t (*out)[4], int max) {
  int n = 0;
  int i = 0;
  while (i < len && n < max) {
    int rest = len - i;
    int take = rest > 3 ? 3 : rest;
    uint8_t cin = rest > 3 ? 0x4 : take == 1 ? 0x5 : take == 2 ? 0x6 : 0x7;
    out[n][0] = cin;
    for (int k = 0; k < 3; k++) out[n][1 + k] = k < take ? m[i + k] : 0;
    i += take;
    n++;
  }
  return n;
}

// --- Роль платы ---

/**
 * Роль по USB-событиям: хост подключил плату — «USB»; отключил или усыпил — «приёмник».
 * Сразу после включения USB ещё не поднялся (до ~1 с), поэтому на связку приёмник соглашается, только
 * пробыв приёмником ROLE_SETTLE_MS: свисток, который только что воткнули, не примет чужую связку за свою.
 */
class RoleTracker {
 public:
  void usbStarted() { host_ = true; }
  void usbStopped(uint32_t now) { toReceiver(now); }
  void usbSuspended(uint32_t now) { toReceiver(now); }
  void usbResumed() { host_ = true; }
  Role role() const { return host_ ? Role::Usb : Role::Receiver; }
  bool settledReceiver(uint32_t now) const { return !host_ && now - since_ >= ROLE_SETTLE_MS; }

 private:
  bool host_ = false;
  uint32_t since_ = 0;
  void toReceiver(uint32_t now) {
    if (host_) since_ = now;
    host_ = false;
  }
};

// --- Качество связи (на свистке) ---

class LinkStats {
 public:
  /** Итог отправки DATA (подтверждение ESP-NOW). */
  void onSent(bool ok, uint32_t now) {
    Bucket& b = bucket(now);
    b.sent++;
    if (!ok) b.failed++;
  }

  /** HEARTBEAT ленты: `rssiHere` — как свисток слышит ленту, `rssiThere` — как лента слышит свисток (дБм). */
  void onHeartbeat(int rssiHere, int rssiThere, uint32_t now) {
    smooth(here_, rssiHere);
    smooth(there_, rssiThere);
    lastHeartbeat_ = now;
    heard_ = true;
  }

  bool online(uint32_t now) const { return heard_ && now - lastHeartbeat_ <= LINK_TIMEOUT_MS; }

  /** Доля неуспешных отправок за последние 10 секунд, %. */
  uint8_t lossPercent(uint32_t now) const {
    uint32_t sec = now / 1000, sent = 0, failed = 0;
    for (const Bucket& b : buckets_) {
      if (b.sent && sec - b.sec < uint32_t(LOSS_WINDOW_S)) {
        sent += b.sent;
        failed += b.failed;
      }
    }
    return sent ? uint8_t((failed * 100 + sent / 2) / sent) : 0;
  }

  /** Сила сигнала, дБм (среднее двух сторон); 0 — неизвестно. */
  int rssi() const {
    if (here_ && there_) return (here_ + there_) / 2;
    return here_ ? here_ : there_;
  }

  void reset() { *this = LinkStats(); }

 private:
  struct Bucket {
    uint32_t sec = 0;
    uint16_t sent = 0, failed = 0;
  };
  Bucket buckets_[LOSS_WINDOW_S];
  int here_ = 0, there_ = 0;
  uint32_t lastHeartbeat_ = 0;
  bool heard_ = false;

  Bucket& bucket(uint32_t now) {
    uint32_t sec = now / 1000;
    Bucket& b = buckets_[sec % LOSS_WINDOW_S];
    if (b.sec != sec || !b.sent) b = {sec, 0, 0};
    return b;
  }
  static void smooth(int& acc, int v) {
    if (v >= 0) return;  // 0 — неизвестно
    acc = acc ? (acc * 3 + v) / 4 : v;
  }
};

// --- Связка ---

/** Связка на свистке: 10 секунд broadcast PAIR_REQ, первая ответившая лента с тем же nonce — наша. */
class DonglePairing {
 public:
  void start(uint32_t now, uint32_t nonce) {
    state_ = PAIR_SEARCHING;
    started_ = now;
    lastSent_ = 0;
    sentOnce_ = false;
    nonce_ = nonce;
  }

  /** Пора ли разослать PAIR_REQ (и не истекло ли время поиска). */
  bool shouldBroadcast(uint32_t now) {
    if (state_ != PAIR_SEARCHING) return false;
    if (now - started_ > PAIR_SEARCH_MS) {
      state_ = PAIR_NOT_FOUND;
      return false;
    }
    if (sentOnce_ && now - lastSent_ < PAIR_REPEAT_MS) return false;
    sentOnce_ = true;
    lastSent_ = now;
    return true;
  }

  /** PAIR_ACK; true — лента наша, её адрес надо сохранить. */
  bool onAck(uint32_t nonce) {
    if (state_ != PAIR_SEARCHING || nonce != nonce_) return false;
    state_ = PAIR_DONE;
    return true;
  }

  void forget() { state_ = PAIR_IDLE; }
  uint8_t state() const { return state_; }
  uint32_t nonce() const { return nonce_; }

 private:
  uint8_t state_ = PAIR_IDLE;
  uint32_t started_ = 0, lastSent_ = 0, nonce_ = 0;
  bool sentOnce_ = false;
};

/** Лента соглашается на связку только первые 2 минуты после включения. */
inline bool receiverAcceptsPairing(uint32_t now) { return now < PAIR_WINDOW_MS; }

/** Связь для статуса: пары нет — по проводу; есть — на связи или не отвечает. */
inline uint8_t linkState(bool paired, const LinkStats& s, uint32_t now) {
  if (!paired) return LINK_NONE;
  return s.online(now) ? LINK_ONLINE : LINK_LOST;
}

}  // namespace mtr
