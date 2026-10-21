//! Subconjunto cerrado de ZIP: Stored, sin extras, comentarios, cifrado, descriptores ni ZIP64.
//! Se verifican EOCD y directorio antes de reservar metadatos. Nunca se extraen nombres a disco.
use super::library::failure;
use crate::domain::audio::AudioError;
use std::{
    collections::{HashMap, HashSet},
    ops::Range,
};

pub const PACKAGE_LIMIT: usize = 256 * 1024 * 1024;
pub const MANIFEST_LIMIT: usize = 2 * 1024 * 1024;

fn number(bytes: &[u8], offset: usize, width: usize) -> Result<usize, AudioError> {
    let value = bytes
        .get(
            offset
                ..offset
                    .checked_add(width)
                    .ok_or_else(|| failure("ZIP desbordado."))?,
        )
        .ok_or_else(|| failure("ZIP truncado."))?;
    Ok(value.iter().enumerate().fold(0, |result, (index, byte)| {
        result | (usize::from(*byte) << (index * 8))
    }))
}

/// CRC-32 IEEE sobre bytes almacenados; no hay descompresor ni reservas dependientes del encabezado.
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320_u32 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

/// Acepta exclusivamente manifest.json y audio/<sha256 minusculo>.<formato>.
pub fn valid_name(name: &str) -> bool {
    if name == "manifest.json" {
        return true;
    }
    let Some((hash, extension)) = name
        .strip_prefix("audio/")
        .and_then(|value| value.split_once('.'))
    else {
        return false;
    };
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && ["wav", "mp3", "ogg", "flac"].contains(&extension)
}

/// Valida estructura, tamanos, entradas y CRC antes de publicar ningun recurso.
pub fn inspect(bytes: &[u8]) -> Result<HashMap<String, Range<usize>>, AudioError> {
    let invalid = || failure("Paquete ZIP no admitido o inconsistente.");
    if bytes.len() < 22 || bytes.len() > PACKAGE_LIMIT {
        return Err(invalid());
    }
    let end = bytes.len() - 22;
    if number(bytes, end, 4)? != 0x06054b50
        || number(bytes, end + 4, 4)? != 0
        || number(bytes, end + 20, 2)? != 0
    {
        return Err(invalid());
    }
    let count = number(bytes, end + 10, 2)?;
    let size = number(bytes, end + 12, 4)?;
    let start = number(bytes, end + 16, 4)?;
    if count == 0
        || count > 257
        || number(bytes, end + 8, 2)? != count
        || start.checked_add(size) != Some(end)
        || size < count * 46
    {
        return Err(invalid());
    }
    let mut entries = HashMap::with_capacity(count);
    let mut names = HashSet::with_capacity(count);
    let mut cursor = start;
    let mut local_end = 0;
    for _ in 0..count {
        if number(bytes, cursor, 4)? != 0x02014b50
            || ![10, 20].contains(&number(bytes, cursor + 6, 2)?)
            || ![0, 0x800].contains(&number(bytes, cursor + 8, 2)?)
            || number(bytes, cursor + 10, 2)? != 0
            || number(bytes, cursor + 30, 2)? != 0
            || number(bytes, cursor + 32, 2)? != 0
            || number(bytes, cursor + 34, 2)? != 0
            || number(bytes, cursor + 36, 2)? != 0
        {
            return Err(invalid());
        }
        let attr = number(bytes, cursor + 38, 4)?;
        let mode = (attr >> 16) & 0xf000;
        if ![0, 0x8000].contains(&mode) || attr & 0x18 != 0 {
            return Err(invalid());
        }
        let length = number(bytes, cursor + 24, 4)?;
        if number(bytes, cursor + 20, 4)? != length {
            return Err(invalid());
        }
        let name_len = number(bytes, cursor + 28, 2)?;
        if name_len > 80 || cursor + 46 + name_len > end {
            return Err(invalid());
        }
        let name_bytes = &bytes[cursor + 46..cursor + 46 + name_len];
        let name = std::str::from_utf8(name_bytes).map_err(failure)?;
        if !valid_name(name)
            || !names.insert(name.to_ascii_lowercase())
            || length == 0
            || length
                > if name == "manifest.json" {
                    MANIFEST_LIMIT
                } else {
                    super::decoder::FILE_LIMIT
                }
        {
            return Err(invalid());
        }
        let local = number(bytes, cursor + 42, 4)?;
        if local != local_end
            || number(bytes, local, 4)? != 0x04034b50
            || number(bytes, local + 4, 2)? != number(bytes, cursor + 6, 2)?
            || number(bytes, local + 6, 2)? != number(bytes, cursor + 8, 2)?
            || number(bytes, local + 8, 2)? != 0
            || number(bytes, local + 10, 4)? != number(bytes, cursor + 12, 4)?
            || number(bytes, local + 14, 4)? != number(bytes, cursor + 16, 4)?
            || number(bytes, local + 18, 4)? != length
            || number(bytes, local + 22, 4)? != length
            || number(bytes, local + 26, 2)? != name_len
            || number(bytes, local + 28, 2)? != 0
        {
            return Err(invalid());
        }
        let data = local.checked_add(30 + name_len).ok_or_else(invalid)?;
        let next = data.checked_add(length).ok_or_else(invalid)?;
        if next > start
            || bytes.get(local + 30..data) != Some(name_bytes)
            || crc32(&bytes[data..next]) as usize != number(bytes, cursor + 16, 4)?
        {
            return Err(invalid());
        }
        entries.insert(name.to_owned(), data..next);
        local_end = next;
        cursor += 46 + name_len;
    }
    if cursor != end || local_end != start || !entries.contains_key("manifest.json") {
        return Err(invalid());
    }
    Ok(entries)
}

/// Escribe el mismo subconjunto canonico, con limite comprobado antes de cada copia.
pub fn encode(entries: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, AudioError> {
    let total = entries
        .iter()
        .try_fold(22usize, |size, (name, data)| {
            size.checked_add(76 + name.len() * 2 + data.len())
        })
        .ok_or_else(|| failure("Paquete demasiado grande."))?;
    if total > PACKAGE_LIMIT || entries.len() > 257 {
        return Err(failure("Paquete demasiado grande."));
    }
    let mut bytes = Vec::with_capacity(total);
    let mut central = Vec::new();
    for (name, data) in &entries {
        if !valid_name(name) {
            return Err(failure("Nombre de paquete invalido."));
        }
        let offset = bytes.len() as u32;
        let crc = crc32(data);
        let length = data.len() as u32;
        let name_len = name.len() as u16;
        bytes.extend_from_slice(&0x04034b50u32.to_le_bytes());
        for n in [20u16, 0, 0, 0, 0] {
            bytes.extend_from_slice(&n.to_le_bytes());
        }
        for n in [crc, length, length] {
            bytes.extend_from_slice(&n.to_le_bytes());
        }
        bytes.extend_from_slice(&name_len.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(data);
        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        for n in [20u16, 20, 0, 0, 0, 0] {
            central.extend_from_slice(&n.to_le_bytes());
        }
        for n in [crc, length, length] {
            central.extend_from_slice(&n.to_le_bytes());
        }
        for n in [name_len, 0, 0, 0, 0] {
            central.extend_from_slice(&n.to_le_bytes());
        }
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let start = bytes.len() as u32;
    bytes.extend_from_slice(&central);
    bytes.extend_from_slice(&0x06054b50u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    for _ in 0..2 {
        bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    }
    bytes.extend_from_slice(&(central.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&start.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Archivo Stored minimo y valido para mutar campos sin decodificar audio ni crear archivos.
    fn archive() -> Vec<u8> {
        encode(vec![("manifest.json".into(), b"{}".to_vec())]).unwrap()
    }

    #[test]
    fn strict_zip_roundtrip_and_crc_known_vector() {
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
        let bytes = archive();
        let entries = inspect(&bytes).unwrap();
        assert_eq!(&bytes[entries["manifest.json"].clone()], b"{}");
        for name in [
            "../manifest.json",
            "/manifest.json",
            "C:manifest.json",
            "audio\\x.wav",
            "\\\\server\\audio",
            "manifest.json\0",
            "MANIFEST.JSON",
            "audio/../x.wav",
            "audio/foo.wav",
        ] {
            assert!(!valid_name(name), "{name}");
        }
    }

    #[test]
    fn malicious_headers_crc_truncation_encryption_descriptors_zip64_multidisk_links_and_extras_reject()
     {
        let original = archive();
        let end = original.len() - 22;
        let central = number(&original, end + 16, 4).unwrap();
        for (offset, width, value) in [
            (end + 10, 2, 65535),
            (end + 8, 2, 2),
            (end + 4, 2, 1),
            (end + 12, 4, u32::MAX),
            (end + 16, 4, u32::MAX),
            (central + 8, 2, 1),
            (central + 8, 2, 8),
            (central + 10, 2, 8),
            (central + 24, 4, u32::MAX),
            (central + 30, 2, 1),
            (central + 32, 2, 1),
            (central + 34, 2, 1),
            (central + 38, 4, 0xa0000000),
            (central + 38, 4, 0x10000000),
            (central + 38, 4, 0x10),
            (central + 42, 4, 1),
            (central + 6, 2, 45),
            (6, 2, 1),
            (8, 2, 8),
            (28, 2, 1),
            (14, 4, 0),
            (18, 4, u32::MAX),
            (22, 4, 0),
        ] {
            let mut bytes = original.clone();
            bytes[offset..offset + width].copy_from_slice(&value.to_le_bytes()[..width]);
            assert!(inspect(&bytes).is_err(), "{offset} {value}");
        }
        for length in 0..original.len() {
            assert!(inspect(&original[..length]).is_err());
        }
        let mut bytes = original.clone();
        bytes[43] ^= 1;
        assert!(inspect(&bytes).is_err());
        let duplicate = encode(vec![
            ("manifest.json".into(), b"{}".to_vec()),
            ("manifest.json".into(), b"{}".to_vec()),
        ])
        .unwrap();
        assert!(inspect(&duplicate).is_err());
    }

    #[test]
    fn arbitrary_single_byte_header_mutations_never_panic_or_allocate_from_claimed_counts() {
        let original = archive();
        for index in 0..original.len() {
            for value in [0, 1, 127, 255] {
                let mut bytes = original.clone();
                bytes[index] = value;
                let _ = inspect(&bytes);
            }
        }
    }
}
