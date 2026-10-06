// Прошивка платы подсветки клавиш «MIDI Teacher Lights» для ESP32-S3.
//
// Плата видна в Windows как USB-MIDI устройство «MIDI Teacher Lights» (без драйверов). Приложение шлёт кадры
// SysEx — полный список горящих клавиш (протокол — в lights_core.h). Лента — адресная WS2812B (FCOB, 5 В).
//
// Сборка: Arduino IDE или arduino-cli, плата «ESP32S3 Dev Module», USB Mode: «USB-OTG (TinyUSB)»;
// библиотека Adafruit NeoPixel. Готовый файл собирает CI (MIDI-Teacher-Lights-esp32s3-<sha>.bin).
//
// Радио потом: кадр приходит в onFrame() — тот же вызов будет и для ESP-NOW.

#include <Adafruit_NeoPixel.h>
#include <Preferences.h>

#include "USB.h"
#include "USBMIDI.h"
#include "lights_core.h"

// Настройки сборки: вывод данных ленты и число светодиодов (88 клавиш ≈ 1,23 м × 160 на метр ≈ 197).
#ifndef LED_PIN
#define LED_PIN 5
#endif
#ifndef LED_COUNT
#define LED_COUNT 200
#endif

USBMIDI MIDI;
Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
Preferences prefs;
mtl::Lights lights(LED_COUNT);
mtl::SysexAssembler assembler;
mtl::Rgb pixels[LED_COUNT];

static void loadCalibration() {
  prefs.begin("mtlights", true);
  lights.cal.lowNote = prefs.getUChar("lowNote", lights.cal.lowNote);
  lights.cal.lowLed = prefs.getUShort("lowLed", lights.cal.lowLed);
  lights.cal.highNote = prefs.getUChar("highNote", lights.cal.highNote);
  lights.cal.highLed = prefs.getUShort("highLed", lights.cal.highLed);
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

/** Сообщение SysEx от приложения (по USB; потом — по радио). */
static void onFrame(const uint8_t* data, int len) {
  lights.onSysex(data, len, millis());
  if (lights.calibrationChanged) saveCalibration();
}

void setup() {
  USB.productName("MIDI Teacher Lights");
  USB.manufacturerName("MIDI Teacher");
  MIDI.begin();
  USB.begin();
  strip.begin();
  strip.clear();
  strip.show();
  loadCalibration();
}

void loop() {
  midiEventPacket_t packet = {0, 0, 0, 0};
  while (MIDI.readPacket(&packet)) {
    if (assembler.feed(packet.header, packet.byte1, packet.byte2, packet.byte3)) onFrame(assembler.data(), assembler.size());
  }
  static uint32_t lastShow = 0;
  uint32_t now = millis();
  if (now - lastShow >= 16) {  // ~60 кадров в секунду
    lastShow = now;
    lights.render(now, pixels);
    for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, pixels[i].r, pixels[i].g, pixels[i].b);
    strip.show();
  }
}
