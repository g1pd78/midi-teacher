// Тест радио платы на компьютере: g++ -std=c++17 -I ../MIDITeacherLights radio_core_test.cpp && ./a.out
#include <cassert>
#include <cstdio>
#include <vector>

#include "lights_core.h"
#include "radio_core.h"

using namespace mtr;

int main() {
  // Пакет: сборка и разбор.
  uint8_t sys[] = {0xF0, 0x7D, 0x4D, 0x54, 0x10, 32, 60, 1, 0xF7};
  uint8_t buf[MAX_PACKET];
  int n = encode(DATA, 513, sys, sizeof sys, buf);
  assert(n == HEADER + int(sizeof sys));
  Packet p;
  assert(decode(buf, n, p));
  assert(p.type == DATA && p.seq == 513 && p.len == int(sizeof sys) && p.data[6] == 60);
  buf[3] = VERSION + 1;
  assert(!decode(buf, n, p));  // другая версия
  assert(!decode(buf, 3, p));
  std::vector<uint8_t> big(MAX_DATA + 1, 0);
  assert(encode(DATA, 0, big.data(), int(big.size()), buf) == -1);

  // Кадр на все 88 клавиш влезает целиком; длинный — укорачивается по парам, F7 в конце.
  std::vector<uint8_t> frame = {0xF0, 0x7D, 0x4D, 0x54, 0x10, 64};
  for (int k = 21; k <= 108; k++) {
    frame.push_back(uint8_t(k));
    frame.push_back(1);
  }
  frame.push_back(0xF7);
  uint8_t fit[MAX_DATA];
  assert(fitSysex(frame.data(), int(frame.size()), fit) == int(frame.size()) && frame.size() == 183);
  std::vector<uint8_t> huge = {0xF0, 0x7D, 0x4D, 0x54, 0x10, 64};
  for (int k = 0; k < 128; k++) {
    huge.push_back(uint8_t(k));
    huge.push_back(2);
  }
  huge.push_back(0xF7);
  int fl = fitSysex(huge.data(), int(huge.size()), fit);
  assert(fl <= MAX_DATA && fit[fl - 1] == 0xF7 && (fl - 7) % 2 == 0);
  mtl::Lights l(200);
  assert(l.onSysex(fit, fl, 0) && l.litColor(0) == 2 && l.litColor(127) == 0);

  // Команды радио отделяются от сообщений для ленты.
  uint8_t pair[] = {0xF0, 0x7D, 0x4D, 0x54, CMD_PAIR, 0xF7};
  uint8_t test[] = {0xF0, 0x7D, 0x4D, 0x54, 0x03, 0xF7};
  assert(radioCommand(pair, sizeof pair) == CMD_PAIR);
  assert(radioCommand(test, sizeof test) == 0 && ours(test, sizeof test));

  // Статус: F0 7D 4D 54 20 <версия> <связь> <связка> <−дБм> <потери> F7.
  uint8_t st[16];
  assert(statusSysex(LINK_ONLINE, PAIR_DONE, -58, 3, st) == 11);
  const uint8_t want[] = {0xF0, 0x7D, 0x4D, 0x54, 0x20, VERSION, 1, 2, 58, 3, 0xF7};
  assert(memcmp(st, want, sizeof want) == 0);
  statusSysex(LINK_NONE, PAIR_IDLE, 0, 250, st);
  assert(st[8] == 0 && st[9] == 100);

  // SysEx → пакеты USB-MIDI и обратно через сборщик прошивки.
  uint8_t pk[8][4];
  for (int len : {6, 7, 8, 11}) {
    std::vector<uint8_t> m(st, st + 11);
    m.resize(len - 1);
    m.push_back(0xF7);
    m[0] = 0xF0;
    int np = sysexToUsb(m.data(), len, pk, 8);
    assert(np == (len + 2) / 3);
    mtl::SysexAssembler a;
    bool done = false;
    for (int i = 0; i < np; i++) done = a.feed(pk[i][0], pk[i][1], pk[i][2], pk[i][3]);
    assert(done && a.size() == len && memcmp(a.data(), m.data(), len) == 0);
  }

  // Роль: без USB-хоста — приёмник; хост подключил — «USB»; усыпил — снова приёмник.
  RoleTracker role;
  assert(role.role() == Role::Receiver && !role.settledReceiver(1000) && role.settledReceiver(ROLE_SETTLE_MS));
  role.usbStarted();
  assert(role.role() == Role::Usb && !role.settledReceiver(10000));
  role.usbSuspended(20000);
  assert(role.role() == Role::Receiver && !role.settledReceiver(21000) && role.settledReceiver(20000 + ROLE_SETTLE_MS));
  role.usbResumed();
  assert(role.role() == Role::Usb);
  role.usbStopped(30000);
  role.usbStopped(31000);  // повторное событие не сдвигает момент
  assert(role.role() == Role::Receiver && role.settledReceiver(30000 + ROLE_SETTLE_MS));

  // Связка: окно ленты — 2 минуты после включения.
  assert(receiverAcceptsPairing(0) && receiverAcceptsPairing(PAIR_WINDOW_MS - 1) && !receiverAcceptsPairing(PAIR_WINDOW_MS));
  DonglePairing dp;
  assert(dp.state() == PAIR_IDLE && !dp.shouldBroadcast(0));
  dp.start(1000, 0xCAFE);
  assert(dp.state() == PAIR_SEARCHING);
  assert(dp.shouldBroadcast(1000) && !dp.shouldBroadcast(1100) && dp.shouldBroadcast(1300));
  assert(!dp.onAck(0xBEEF));  // чужой nonce
  assert(dp.onAck(0xCAFE) && dp.state() == PAIR_DONE);
  assert(!dp.onAck(0xCAFE));  // повторный ответ — не новая связка
  dp.start(5000, 7);
  int sent = 0;
  for (uint32_t t = 5000; t <= 5000 + PAIR_SEARCH_MS + 500; t += 50) sent += dp.shouldBroadcast(t);
  assert(dp.state() == PAIR_NOT_FOUND && sent >= 30 && sent <= 35);
  uint8_t nb[4];
  writeU32(0xA1B2C3D4, nb);
  assert(readU32(nb) == 0xA1B2C3D4);

  // Качество связи: потери за 10 секунд, сигнал, тайм-аут.
  LinkStats s;
  assert(!s.online(0) && s.lossPercent(0) == 0 && s.rssi() == 0);
  assert(linkState(false, s, 0) == LINK_NONE && linkState(true, s, 0) == LINK_LOST);
  for (int i = 0; i < 20; i++) s.onSent(i % 10 != 0, 10000 + i * 100);  // 2 из 20 не дошли
  assert(s.lossPercent(12000) == 10);
  assert(s.lossPercent(10000 + 25000) == 0);  // старые секунды не считаются
  s.onHeartbeat(-60, -50, 12000);
  assert(s.rssi() == -55 && s.online(12000 + LINK_TIMEOUT_MS) && !s.online(12000 + LINK_TIMEOUT_MS + 1));
  assert(linkState(true, s, 12500) == LINK_ONLINE);
  s.onHeartbeat(-80, 0, 13000);  // лента не знает свой сигнал — учитывается только свой
  assert(s.rssi() == (-65 + -50) / 2);
  s.reset();
  assert(s.rssi() == 0 && !s.online(13000));

  Mac a, b;
  assert(a.empty() && a == b);
  b.b[5] = 1;
  assert(!b.empty() && a != b);

  std::puts("radio_core: все проверки пройдены");
  return 0;
}
