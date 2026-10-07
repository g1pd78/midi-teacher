// Прошивка платы подсветки клавиш «MIDI Teacher Lights» для ESP32-S3 (DevKitC-1 у ленты, Super Mini — свисток).
//
// Плата видна в Windows как USB-MIDI устройство «MIDI Teacher Lights» (без драйверов). Приложение шлёт кадры
// SysEx — полный список горящих клавиш (протокол — в lights_core.h). Лента — адресная WS2812B (FCOB, 5 В).
//
// Прошивка одна на обе платы, роль определяется сама (radio_core.h):
//   - плата в компьютере — кадры зажигают свою ленту (провод) и, если лента связана, уходят по ESP-NOW;
//   - плата без компьютера (блок 5 В или зарядка) — приёмник: кадры приходят по радио.
//
// Сборка: Arduino IDE или arduino-cli, плата «ESP32S3 Dev Module», USB Mode: «USB-OTG (TinyUSB)»;
// библиотека Adafruit NeoPixel. Готовый файл собирает CI (MIDI-Teacher-Lights-esp32s3-<sha>.bin).

#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_random.h>
#include <esp_wifi.h>

#include "USB.h"
#include "USBMIDI.h"
#include "lights_core.h"
#include "radio_core.h"

// Настройки сборки: вывод данных ленты и число светодиодов (88 клавиш ≈ 1,23 м × 160 на метр ≈ 197).
#ifndef LED_PIN
#define LED_PIN 5
#endif
#ifndef LED_COUNT
#define LED_COUNT 200
#endif
// Канал Wi-Fi для ESP-NOW: одинаковый у свистка и ленты.
#ifndef RADIO_CHANNEL
#define RADIO_CHANNEL 1
#endif

USBMIDI MIDI;
Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
Preferences prefs;
mtl::Lights lights(LED_COUNT);
mtl::SysexAssembler assembler;
mtl::Rgb pixels[LED_COUNT];

mtr::RoleTracker role;
mtr::LinkStats stats;
mtr::DonglePairing pairing;
mtr::Mac peer;  // свисток помнит ленту, лента — свисток
bool hasPeer = false;
uint16_t seq = 0;
uint16_t framesReceived = 0;
int lastRssi = 0;  // как приёмник слышит свисток
const mtr::Mac BROADCAST = {{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}};

// Колбэки ESP-NOW работают в задаче Wi-Fi: складываем в очереди, разбираем в loop().
struct RxItem {
  uint8_t mac[6];
  int8_t rssi;
  uint8_t len;
  uint8_t data[mtr::MAX_PACKET];
};
QueueHandle_t rxQueue;
QueueHandle_t sentQueue;

// --- Калибровка и пара в NVS ---

static void loadSettings() {
  prefs.begin("mtlights", true);
  lights.cal.lowNote = prefs.getUChar("lowNote", lights.cal.lowNote);
  lights.cal.lowLed = prefs.getUShort("lowLed", lights.cal.lowLed);
  lights.cal.highNote = prefs.getUChar("highNote", lights.cal.highNote);
  lights.cal.highLed = prefs.getUShort("highLed", lights.cal.highLed);
  hasPeer = prefs.getBytes("peer", peer.b, 6) == 6 && !peer.empty();
  prefs.end();
}

static void saveCalibration() {
  prefs.begin("mtlights", false);
  prefs.putUChar("lowNote", lights.cal.lowNote);
  prefs.putUShort("lowLed", lights.cal.lowLed);
  prefs.putUChar("highNote", lights.cal.highNote);
  prefs.putUShort("highLed", lights.cal.highLed);
  prefs.end();
  lights.calibrationChanged = false;
}

static void addPeer(const mtr::Mac& mac) {
  if (esp_now_is_peer_exist(mac.b)) return;
  esp_now_peer_info_t info = {};
  memcpy(info.peer_addr, mac.b, 6);
  info.channel = RADIO_CHANNEL;
  info.ifidx = WIFI_IF_STA;
  info.encrypt = false;
  esp_now_add_peer(&info);
}

static void setPeer(const mtr::Mac& mac) {
  if (hasPeer && peer != mac) esp_now_del_peer(peer.b);
  peer = mac;
  hasPeer = true;
  addPeer(peer);
  stats.reset();
  prefs.begin("mtlights", false);
  prefs.putBytes("peer", peer.b, 6);
  prefs.end();
}

static void forgetPeer() {
  if (hasPeer) esp_now_del_peer(peer.b);
  hasPeer = false;
  peer = mtr::Mac();
  stats.reset();
  pairing.forget();
  prefs.begin("mtlights", false);
  prefs.remove("peer");
  prefs.end();
}

// --- Радио ---

static bool radioSend(const mtr::Mac& to, uint8_t type, const uint8_t* data, int len) {
  uint8_t buf[mtr::MAX_PACKET];
  int n = mtr::encode(type, seq++, data, len, buf);
  return n > 0 && esp_now_send(to.b, buf, n) == ESP_OK;
}

static void onRadioRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  if (len <= 0 || len > mtr::MAX_PACKET) return;
  RxItem item;
  memcpy(item.mac, info->src_addr, 6);
  item.rssi = info->rx_ctrl ? info->rx_ctrl->rssi : 0;
  item.len = uint8_t(len);
  memcpy(item.data, data, len);
  xQueueSend(rxQueue, &item, 0);
}

static void onRadioSent(const uint8_t* mac, esp_now_send_status_t status) {
  // Учитываем только DATA и HEARTBEAT к паре (broadcast связки подтверждения не получает).
  if (!hasPeer || memcmp(mac, peer.b, 6) != 0) return;
  bool ok = status == ESP_NOW_SEND_SUCCESS;
  xQueueSend(sentQueue, &ok, 0);
}

static void setupRadio() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(RADIO_CHANNEL, WIFI_SECOND_CHAN_NONE);
  if (esp_now_init() != ESP_OK) return;
  esp_now_register_recv_cb(onRadioRecv);
  esp_now_register_send_cb(onRadioSent);
  addPeer(BROADCAST);
  if (hasPeer) addPeer(peer);
}

// --- Статус в приложение ---

static void sendStatus() {
  uint8_t m[16];
  uint32_t now = millis();
  int n = mtr::statusSysex(mtr::linkState(hasPeer, stats, now), pairing.state(), hasPeer ? stats.rssi() : 0,
                           hasPeer ? stats.lossPercent(now) : 0, m);
  uint8_t packets[8][4];
  int np = mtr::sysexToUsb(m, n, packets, 8);
  for (int i = 0; i < np; i++) {
    midiEventPacket_t p = {packets[i][0], packets[i][1], packets[i][2], packets[i][3]};
    MIDI.writePacket(&p);
  }
}

// --- Сообщения ---

/** Сообщение для ленты (из USB или по радио). */
static void onFrame(const uint8_t* data, int len) {
  lights.onSysex(data, len, millis());
  if (lights.calibrationChanged) saveCalibration();
}

/** SysEx из приложения по USB. */
static void onUsbSysex(const uint8_t* data, int len) {
  switch (mtr::radioCommand(data, len)) {
    case mtr::CMD_STATUS:
      sendStatus();
      return;
    case mtr::CMD_PAIR:
      pairing.start(millis(), esp_random());
      sendStatus();
      return;
    case mtr::CMD_UNPAIR:
      forgetPeer();
      sendStatus();
      return;
  }
  onFrame(data, len);  // своя лента (провод); у свистка на выводе ленты ничего нет
  if (hasPeer && mtr::ours(data, len)) {
    uint8_t fit[mtr::MAX_DATA];
    int n = mtr::fitSysex(data, len, fit);
    if (!radioSend(peer, mtr::DATA, fit, n)) stats.onSent(false, millis());
  }
}

static uint8_t lastSysex[mtr::MAX_DATA];
static int lastSysexLen = 0;

static void onRadioPacket(const RxItem& item) {
  mtr::Packet p;
  if (!mtr::decode(item.data, item.len, p)) return;
  mtr::Mac from;
  memcpy(from.b, item.mac, 6);
  uint32_t now = millis();

  if (role.role() == mtr::Role::Usb) {
    // Свисток: ответ ленты на связку и её HEARTBEAT.
    if (p.type == mtr::PAIR_ACK && p.len >= 4 && pairing.onAck(mtr::readU32(p.data))) {
      setPeer(from);
      if (lastSysexLen) radioSend(peer, mtr::DATA, lastSysex, lastSysexLen);  // сразу текущий кадр
      sendStatus();
    } else if (p.type == mtr::HEARTBEAT && hasPeer && from == peer) {
      stats.onHeartbeat(item.rssi, p.len >= 1 && p.data[0] ? -int(p.data[0]) : 0, now);
    }
    return;
  }

  // Приёмник у ленты.
  if (p.type == mtr::PAIR_REQ && p.len >= 4 && mtr::receiverAcceptsPairing(now) && role.settledReceiver(now)) {
    setPeer(from);
    uint8_t nonce[4];
    memcpy(nonce, p.data, 4);
    radioSend(peer, mtr::PAIR_ACK, nonce, 4);
  } else if (p.type == mtr::DATA && hasPeer && from == peer) {
    lastRssi = item.rssi;
    framesReceived++;
    onFrame(p.data, p.len);
  }
}

static void onUsbEvent(void*, esp_event_base_t base, int32_t id, void*) {
  if (base != ARDUINO_USB_EVENTS) return;
  switch (id) {
    case ARDUINO_USB_STARTED_EVENT:
      role.usbStarted();
      break;
    case ARDUINO_USB_STOPPED_EVENT:
      role.usbStopped(millis());
      break;
    case ARDUINO_USB_SUSPEND_EVENT:
      role.usbSuspended(millis());
      break;
    case ARDUINO_USB_RESUME_EVENT:
      role.usbResumed();
      break;
  }
}

void setup() {
  rxQueue = xQueueCreate(8, sizeof(RxItem));
  sentQueue = xQueueCreate(32, sizeof(bool));
  USB.onEvent(onUsbEvent);
  USB.productName("MIDI Teacher Lights");
  USB.manufacturerName("MIDI Teacher");
  MIDI.begin();
  USB.begin();
  strip.begin();
  strip.clear();
  strip.show();
  loadSettings();
  setupRadio();
}

void loop() {
  uint32_t now = millis();

  midiEventPacket_t packet = {0, 0, 0, 0};
  while (MIDI.readPacket(&packet)) {
    if (assembler.feed(packet.header, packet.byte1, packet.byte2, packet.byte3)) {
      if (mtr::ours(assembler.data(), assembler.size()) && !mtr::radioCommand(assembler.data(), assembler.size())) {
        lastSysexLen = mtr::fitSysex(assembler.data(), assembler.size(), lastSysex);
      }
      onUsbSysex(assembler.data(), assembler.size());
    }
  }

  RxItem item;
  while (xQueueReceive(rxQueue, &item, 0) == pdTRUE) onRadioPacket(item);
  bool ok;
  while (xQueueReceive(sentQueue, &ok, 0) == pdTRUE) stats.onSent(ok, now);

  static uint32_t lastTick = 0;
  if (role.role() == mtr::Role::Usb) {
    if (pairing.shouldBroadcast(now)) {
      uint8_t nonce[4];
      mtr::writeU32(pairing.nonce(), nonce);
      radioSend(BROADCAST, mtr::PAIR_REQ, nonce, 4);
    }
    if (now - lastTick >= mtr::HEARTBEAT_MS) {
      lastTick = now;
      sendStatus();
    }
  } else if (hasPeer && now - lastTick >= mtr::HEARTBEAT_MS) {
    // Приёмник: HEARTBEAT свистку — как слышно и сколько кадров пришло.
    lastTick = now;
    int dbm = lastRssi < 0 ? -lastRssi : 0;
    uint8_t hb[3] = {uint8_t(dbm > 127 ? 127 : dbm), uint8_t(framesReceived & 0xFF), uint8_t(framesReceived >> 8)};
    radioSend(peer, mtr::HEARTBEAT, hb, 3);
  }

  static uint32_t lastShow = 0;
  if (now - lastShow >= 16) {  // ~60 кадров в секунду
    lastShow = now;
    lights.render(now, pixels);
    for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, pixels[i].r, pixels[i].g, pixels[i].b);
    strip.show();
  }
}
