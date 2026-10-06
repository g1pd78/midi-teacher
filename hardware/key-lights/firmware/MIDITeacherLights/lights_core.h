// Логика платы «MIDI Teacher Lights» без Arduino: разбор SysEx, геометрия клавиш, что горит на ленте.
// Проверяется на компьютере (lights_core_test.cpp, g++), в прошивке — тот же код.
//
// Протокол (байты SysEx, F0 7D 4D 54 <команда> … F7; 7D — некоммерческий производитель):
//   10 <яркость 0–127> (<клавиша> <цвет>)…  кадр: полный список горящих клавиш (при изменении и раз в секунду)
//   01 <нижняя клавиша> <светодиод lo hi> <верхняя клавиша> <светодиод lo hi>   калибровка (хранится на плате)
//   02 <светодиод lo hi> <цвет>   указка: горит один светодиод (калибровка)
//   03                            проверка: огонёк пробегает по ленте
//   04                            выйти из указки
// Цвет: 1 — правая рука, 2 — левая, 3 — верно, 4 — ошибка, 5 — внимание, 6 — нейтральный, 7 — фиолетовый;
// +16 — тускло. Те же числа — в приложении (src/lib/lights.ts) и в ядре (crates/mt-core/src/devices.rs).

#pragma once
#include <stdint.h>
#include <string.h>

namespace mtl {

constexpr int MAX_LEDS = 400;
constexpr uint32_t FRAME_TIMEOUT_MS = 3000;  // без кадров — лента гаснет (приложение закрыто, кабель выдернут)
constexpr uint32_t TEST_MS = 2500;
constexpr int DIM = 16;
constexpr uint8_t MAX_BRIGHTNESS = 153;  // 60% от 255: свет мягкий, блок питания не перегружается
constexpr uint32_t MAX_MA = 2000;        // потолок тока ленты, мА
constexpr uint32_t MA_PER_CHANNEL = 20;  // ток одного канала светодиода на полной яркости

struct Rgb {
  uint8_t r, g, b;
};

// Цвета как на экране (src/lib/lights.ts, LIGHT_CSS).
inline Rgb palette(uint8_t code) {
  static const Rgb colors[8] = {{0, 0, 0},     {90, 169, 255}, {255, 180, 84}, {76, 195, 138},
                                {255, 92, 92}, {242, 201, 76}, {230, 230, 230}, {199, 146, 234}};
  int base = code % DIM;
  Rgb c = (base >= 1 && base <= 7) ? colors[base] : colors[6];
  if (code >= DIM) c = {uint8_t(c.r * 3 / 10), uint8_t(c.g * 3 / 10), uint8_t(c.b * 3 / 10)};
  return c;
}

// Центр клавиши в долях белой клавиши (белые и чёрные — как на настоящей клавиатуре).
inline double keyCenter(int note) {
  static const int whiteOfPc[12] = {0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6};
  int oct = note / 12, pc = note % 12;
  int w = whiteOfPc[pc];
  if (w >= 0) return oct * 7 + w + 0.5;
  double offset = pc == 1 ? -0.1 : pc == 3 ? 0.1 : pc == 6 ? -0.15 : pc == 8 ? 0.0 : 0.15;
  return oct * 7 + whiteOfPc[pc - 1] + 1 + offset;
}

inline bool isBlack(int note) {
  int pc = note % 12;
  return pc == 1 || pc == 3 || pc == 6 || pc == 8 || pc == 10;
}

struct Calibration {
  uint8_t lowNote = 21;
  uint16_t lowLed = 0;
  uint8_t highNote = 108;
  uint16_t highLed = 194;  // 88 клавиш ≈ 1,23 м, лента 160 светодиодов/м
};

class Lights {
 public:
  explicit Lights(int numLeds) : numLeds_(numLeds > MAX_LEDS ? MAX_LEDS : numLeds) { memset(lit_, 0, sizeof lit_); }

  Calibration cal;
  /** Калибровку поменяли — её надо сохранить во флеш (Preferences). */
  bool calibrationChanged = false;

  /** Сообщение SysEx целиком (F0 … F7). Возвращает true, если это наше сообщение. */
  bool onSysex(const uint8_t* m, int len, uint32_t now) {
    if (len < 6 || m[0] != 0xF0 || m[len - 1] != 0xF7 || m[1] != 0x7D || m[2] != 0x4D || m[3] != 0x54) return false;
    const uint8_t* d = m + 5;
    int n = len - 6;  // байты данных между командой и F7
    switch (m[4]) {
      case 0x10:
        if (n < 1) return false;
        brightness_ = d[0];
        memset(lit_, 0, sizeof lit_);
        for (int i = 1; i + 1 < n; i += 2) lit_[d[i] & 0x7F] = d[i + 1] & 0x7F;
        lastFrame_ = now;
        haveFrame_ = true;
        return true;
      case 0x01:
        if (n < 6) return false;
        cal.lowNote = d[0];
        cal.lowLed = d[1] | (d[2] << 7);
        cal.highNote = d[3];
        cal.highLed = d[4] | (d[5] << 7);
        calibrationChanged = true;
        return true;
      case 0x02:
        if (n < 3) return false;
        pointer_ = d[0] | (d[1] << 7);
        pointerColor_ = d[2];
        return true;
      case 0x03:
        testStart_ = now;
        testing_ = true;
        return true;
      case 0x04:
        pointer_ = -1;
        return true;
    }
    return false;
  }

  /** Светодиод над центром клавиши (линейно по калибровке крайних клавиш). */
  double ledOf(int note) const {
    double a = keyCenter(cal.lowNote), b = keyCenter(cal.highNote);
    double t = b == a ? 0 : (keyCenter(note) - a) / (b - a);
    return cal.lowLed + t * (double(cal.highLed) - double(cal.lowLed));
  }

  /** Диапазон светодиодов клавиши: белая — ±0,35 белой клавиши, чёрная — ±0,25; не меньше одного. */
  void ledRange(int note, int& from, int& to) const {
    double a = keyCenter(cal.lowNote), b = keyCenter(cal.highNote);
    double perWhite = b == a ? 1 : (double(cal.highLed) - double(cal.lowLed)) / (b - a);
    if (perWhite < 0) perWhite = -perWhite;
    double half = (isBlack(note) ? 0.25 : 0.35) * perWhite;
    double c = ledOf(note);
    from = int(c - half + 0.5);
    to = int(c + half + 0.5);
    if (to < from) to = from;
    if (from < 0) from = 0;
    if (to >= numLeds_) to = numLeds_ - 1;
  }

  /** Кадр ленты на момент `now`: цвета всех светодиодов (с яркостью и потолком тока). */
  void render(uint32_t now, Rgb* out) {
    for (int i = 0; i < numLeds_; i++) out[i] = {0, 0, 0};
    if (testing_ && now - testStart_ < TEST_MS) {
      int pos = int(uint64_t(now - testStart_) * numLeds_ / TEST_MS);
      for (int k = -2; k <= 2; k++)
        if (pos + k >= 0 && pos + k < numLeds_) out[pos + k] = palette(k == 0 ? 6 : 6 + DIM);
      scale(out, 64);
      return;
    }
    testing_ = false;
    if (pointer_ >= 0) {
      if (pointer_ < numLeds_) out[pointer_] = palette(pointerColor_);
      scale(out, 96);
      return;
    }
    if (!haveFrame_ || now - lastFrame_ > FRAME_TIMEOUT_MS) return;
    for (int note = 0; note < 128; note++) {
      if (!lit_[note]) continue;
      int from, to;
      ledRange(note, from, to);
      Rgb c = palette(lit_[note]);
      for (int i = from; i <= to; i++) out[i] = c;
    }
    scale(out, uint8_t(uint32_t(brightness_) * 255 / 127));
  }

  int numLeds() const { return numLeds_; }
  uint8_t litColor(int note) const { return lit_[note & 0x7F]; }

 private:
  int numLeds_;
  uint8_t lit_[128];
  uint8_t brightness_ = 32;
  uint32_t lastFrame_ = 0;
  bool haveFrame_ = false;
  int pointer_ = -1;
  uint8_t pointerColor_ = 6;
  bool testing_ = false;
  uint32_t testStart_ = 0;

  /** Яркость (0–255, не больше 60%) и потолок тока. */
  void scale(Rgb* out, uint8_t brightness) const {
    uint32_t b = brightness > MAX_BRIGHTNESS ? MAX_BRIGHTNESS : brightness;
    uint32_t sum = 0;
    for (int i = 0; i < numLeds_; i++) {
      out[i] = {uint8_t(out[i].r * b / 255), uint8_t(out[i].g * b / 255), uint8_t(out[i].b * b / 255)};
      sum += out[i].r + out[i].g + out[i].b;
    }
    uint32_t ma = sum * MA_PER_CHANNEL / 255;
    if (ma > MAX_MA) {
      for (int i = 0; i < numLeds_; i++)
        out[i] = {uint8_t(out[i].r * MAX_MA / ma), uint8_t(out[i].g * MAX_MA / ma), uint8_t(out[i].b * MAX_MA / ma)};
    }
  }
};

/** Сборка SysEx из пакетов USB-MIDI (4 байта: CIN + 3 байта данных). */
class SysexAssembler {
 public:
  /** Пакет USB-MIDI; когда сообщение собрано — `done` = true, данные в `data()`/`size()`. */
  bool feed(uint8_t header, uint8_t b1, uint8_t b2, uint8_t b3) {
    uint8_t cin = header & 0x0F;
    uint8_t bytes[3] = {b1, b2, b3};
    int count = cin == 0x4 || cin == 0x7 ? 3 : cin == 0x6 ? 2 : cin == 0x5 ? 1 : 0;
    if (!count) return false;
    for (int i = 0; i < count; i++) {
      if (bytes[i] == 0xF0) len_ = 0;
      if (len_ < int(sizeof buf_)) buf_[len_++] = bytes[i];
    }
    return cin != 0x4 && len_ > 0 && buf_[len_ - 1] == 0xF7;
  }
  const uint8_t* data() const { return buf_; }
  int size() const { return len_; }

 private:
  uint8_t buf_[300];
  int len_ = 0;
};

}  // namespace mtl
