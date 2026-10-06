// Тест логики платы на компьютере: g++ -std=c++17 -I ../MIDITeacherLights lights_core_test.cpp && ./a.out
#include <cassert>
#include <cmath>
#include <cstdio>
#include <vector>

#include "lights_core.h"

using namespace mtl;

static std::vector<uint8_t> frame(uint8_t bright, std::vector<std::pair<int, int>> keys) {
  std::vector<uint8_t> m = {0xF0, 0x7D, 0x4D, 0x54, 0x10, bright};
  for (auto [n, c] : keys) {
    m.push_back(n);
    m.push_back(c);
  }
  m.push_back(0xF7);
  return m;
}

static int lit(const Rgb* out, int n) {
  int k = 0;
  for (int i = 0; i < n; i++) k += (out[i].r || out[i].g || out[i].b);
  return k;
}

int main() {
  Lights l(200);
  Rgb out[MAX_LEDS];

  // Геометрия совпадает с приложением (src/lib/lights.test.ts): до первой октавы — центр 35.5 белых клавиш.
  assert(std::fabs(keyCenter(60) - 35.5) < 1e-9);
  assert(std::fabs(keyCenter(61) - 36.0 + 0.1) < 1e-9);
  // Калибровка по умолчанию: ля субконтроктавы над 0-м, до пятой октавы — над 194-м.
  assert(std::lround(l.ledOf(21)) == 0);
  assert(std::lround(l.ledOf(108)) == 194);
  int from, to;
  l.ledRange(60, from, to);
  assert(to - from >= 2 && from > 80 && to < 95);  // до1 — около 87-го светодиода; белая клавиша ≈ 3,8 светодиода, горят ~3
  int bf, bt;
  l.ledRange(61, bf, bt);
  assert(bt - bf <= to - from);  // чёрная уже белой

  // До кадра — темно; кадр: до (правая) и соль (левая).
  l.render(0, out);
  assert(lit(out, 200) == 0);
  auto f = frame(127, {{60, 1}, {67, 2}});
  assert(l.onSysex(f.data(), int(f.size()), 1000));
  assert(l.litColor(60) == 1 && l.litColor(67) == 2 && l.litColor(62) == 0);
  l.render(1000, out);
  assert(out[(from + to) / 2].b > out[(from + to) / 2].r);  // голубой
  assert(lit(out, 200) >= 4);
  // Яркость не выше 60%.
  for (int i = 0; i < 200; i++) assert(out[i].r <= MAX_BRIGHTNESS && out[i].g <= MAX_BRIGHTNESS && out[i].b <= MAX_BRIGHTNESS);

  // Новый кадр заменяет старый целиком.
  auto f2 = frame(64, {{64, 3}});
  l.onSysex(f2.data(), int(f2.size()), 1500);
  assert(l.litColor(60) == 0 && l.litColor(64) == 3);

  // Без кадров 3 секунды — гаснет.
  l.render(1500 + FRAME_TIMEOUT_MS + 1, out);
  assert(lit(out, 200) == 0);

  // Калибровка: ноты и 14-битные светодиоды; флаг сохранения.
  uint8_t cal[] = {0xF0, 0x7D, 0x4D, 0x54, 0x01, 21, 3, 0, 108, 175 & 0x7F, 1, 0xF7};
  assert(l.onSysex(cal, sizeof cal, 2000));
  assert(l.calibrationChanged && l.cal.lowLed == 3 && l.cal.highLed == 175);
  assert(std::lround(l.ledOf(108)) == 175);

  // Указка: горит один светодиод; выход из указки.
  uint8_t ptr[] = {0xF0, 0x7D, 0x4D, 0x54, 0x02, 50, 0, 2, 0xF7};
  l.onSysex(ptr, sizeof ptr, 3000);
  l.render(3000, out);
  assert(lit(out, 200) == 1 && (out[50].r || out[50].g));
  uint8_t off[] = {0xF0, 0x7D, 0x4D, 0x54, 0x04, 0xF7};
  l.onSysex(off, sizeof off, 3100);

  // Проверка: огонёк бежит, через 2,5 с — снова кадр.
  uint8_t test[] = {0xF0, 0x7D, 0x4D, 0x54, 0x03, 0xF7};
  l.onSysex(test, sizeof test, 4000);
  l.render(4000 + TEST_MS / 2, out);
  assert(lit(out, 200) >= 3 && lit(out, 200) <= 5);

  // Чужой SysEx — не наш.
  uint8_t foreign[] = {0xF0, 0x41, 0x10, 0x42, 0xF7};
  assert(!l.onSysex(foreign, sizeof foreign, 5000));

  // Потолок тока: все 88 клавиш белым на полной яркости — не больше 2 А.
  std::vector<std::pair<int, int>> all;
  for (int n = 21; n <= 108; n++) all.push_back({n, 6});
  auto big = frame(127, all);
  l.onSysex(big.data(), int(big.size()), 6000);
  l.render(6000, out);
  uint32_t sum = 0;
  for (int i = 0; i < 200; i++) sum += out[i].r + out[i].g + out[i].b;
  assert(sum * MA_PER_CHANNEL / 255 <= MAX_MA + 10);

  // Сборка SysEx из пакетов USB-MIDI: F0 7D 4D | 54 03 F7.
  SysexAssembler a;
  assert(!a.feed(0x04, 0xF0, 0x7D, 0x4D));
  assert(a.feed(0x07, 0x54, 0x03, 0xF7));
  assert(a.size() == 6 && a.data()[4] == 0x03);
  // Окончание одним байтом: F0 7D 4D | 54 10 20 | F7 — пустой кадр.
  assert(!a.feed(0x04, 0xF0, 0x7D, 0x4D));
  assert(!a.feed(0x04, 0x54, 0x10, 0x20));
  assert(a.feed(0x05, 0xF7, 0, 0));
  assert(a.size() == 7 && l.onSysex(a.data(), a.size(), 7000));
  l.render(7000, out);
  assert(lit(out, 200) == 0);

  std::puts("lights_core: все проверки пройдены");
  return 0;
}
