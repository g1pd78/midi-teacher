//! Архив PSARC (Rocksmith 2014): заголовок и оглавление (big-endian; оглавление
//! зашифровано AES-256-CFB), данные — блоками до 64 КБ, сжатыми zlib.
//!
//! Формат — по открытой реализации Rocksmith2014.NET (MIT).

use aes::Aes256;
use anyhow::{bail, Context, Result};
use cfb_mode::cipher::{AsyncStreamCipher, KeyIvInit};
use flate2::read::ZlibDecoder;
use std::io::Read;

const PSARC_KEY: [u8; 32] = [
    0xC5, 0x3D, 0xB2, 0x38, 0x70, 0xA1, 0xA2, 0xF7, 0x1C, 0xAE, 0x64, 0x06, 0x1F, 0xDD, 0x0E, 0x11,
    0x57, 0x30, 0x9D, 0xC8, 0x52, 0x04, 0xD4, 0xC5, 0xBF, 0xDF, 0x25, 0x09, 0x0D, 0xF2, 0x57, 0x2C,
];
const HEADER_LEN: usize = 32;

#[derive(Debug, Clone)]
struct Entry {
    z_index: u32,
    length: u64,
    offset: u64,
}

/// Открытый архив: оглавление и имена файлов; содержимое распаковывается по запросу.
pub struct Psarc {
    data: Vec<u8>,
    block_size: usize,
    entries: Vec<Entry>,
    block_sizes: Vec<u32>,
    names: Vec<String>,
}

fn be(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0u64, |acc, &b| (acc << 8) | b as u64)
}

impl Psarc {
    pub fn parse(data: Vec<u8>) -> Result<Self> {
        if data.len() < HEADER_LEN || &data[0..4] != b"PSAR" {
            bail!("это не архив PSARC");
        }
        if &data[8..12] != b"zlib" {
            bail!("неизвестное сжатие PSARC");
        }
        let toc_len = be(&data[12..16]) as usize;
        let entry_size = be(&data[16..20]) as usize;
        let count = be(&data[20..24]) as usize;
        let block_size = be(&data[24..28]) as usize;
        let flags = be(&data[28..32]);
        if toc_len < HEADER_LEN || toc_len > data.len() || entry_size < 30 || block_size == 0 {
            bail!("повреждённое оглавление PSARC");
        }
        let mut toc = data[HEADER_LEN..toc_len].to_vec();
        if flags == 4 {
            cfb_mode::Decryptor::<Aes256>::new(&PSARC_KEY.into(), &[0u8; 16].into())
                .decrypt(&mut toc);
        }
        if count * entry_size > toc.len() {
            bail!("повреждённое оглавление PSARC");
        }
        let entries: Vec<Entry> = (0..count)
            .map(|i| {
                let e = &toc[i * entry_size..i * entry_size + 30];
                Entry {
                    z_index: be(&e[16..20]) as u32,
                    length: be(&e[20..25]),
                    offset: be(&e[25..30]),
                }
            })
            .collect();
        // Размер записи в таблице блоков: 2 байта при блоках 64 КБ, 3 — до 16 МБ, 4 — больше.
        let z_type = match block_size {
            0..=65536 => 2,
            65537..=16_777_216 => 3,
            _ => 4,
        };
        let table = &toc[count * entry_size..];
        let block_sizes = table.chunks_exact(z_type).map(|c| be(c) as u32).collect();
        let mut psarc = Psarc {
            data,
            block_size,
            entries,
            block_sizes,
            names: Vec::new(),
        };
        // Первая запись — список имён остальных.
        if let Some(first) = psarc.entries.first().cloned() {
            let listing = psarc.inflate(&first)?;
            psarc.names = String::from_utf8_lossy(&listing)
                .split(['\n', '\r'])
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
        }
        Ok(psarc)
    }

    /// Имена файлов архива.
    pub fn names(&self) -> &[String] {
        &self.names
    }

    /// Содержимое файла по имени.
    pub fn read(&self, name: &str) -> Result<Vec<u8>> {
        let i = self
            .names
            .iter()
            .position(|n| n == name)
            .with_context(|| format!("в архиве нет {name}"))?;
        let entry = self
            .entries
            .get(i + 1)
            .context("оглавление короче списка имён")?
            .clone();
        self.inflate(&entry)
    }

    fn inflate(&self, e: &Entry) -> Result<Vec<u8>> {
        let mut out = Vec::with_capacity(e.length as usize);
        let mut pos = e.offset as usize;
        let mut z = e.z_index as usize;
        while (out.len() as u64) < e.length {
            let size = *self
                .block_sizes
                .get(z)
                .context("таблица блоков короче файла")? as usize;
            let len = if size == 0 { self.block_size } else { size };
            let block = self.data.get(pos..pos + len).context("архив обрезан")?;
            // Блок сжат, если начинается с заголовка zlib; иначе (или если распаковка не удалась) — как есть.
            let mut done = false;
            if size != 0
                && block.len() > 2
                && block[0] == 0x78
                && (u16::from(block[0]) << 8 | u16::from(block[1])) % 31 == 0
            {
                let mut buf = Vec::new();
                if ZlibDecoder::new(block).read_to_end(&mut buf).is_ok() {
                    out.extend_from_slice(&buf);
                    done = true;
                }
            }
            if !done {
                out.extend_from_slice(block);
            }
            pos += len;
            z += 1;
        }
        out.truncate(e.length as usize);
        Ok(out)
    }
}
