//! Precarga completa, no LRU: 128 MiB PCM incluyendo 912000 bytes diagnosticos,
//! voces fijadas por Arc y reserva transitoria (2 MiB de bloques + Vec y Arc de salida).
//! Se reservan 32 MiB del total para adaptaciones de salida compartidas, fuera del callback.
//! Cada decode admite como maximo min(32 MiB, (presupuesto libre - 2 MiB) / 2),
//! 120 s, 1..2 canales y 8..192 kHz. Los bytes comprimidos tienen otro limite de 32 MiB.
//! No representa un limite del RSS: metadatos, buffers de formato y del dispositivo son adicionales.
//! No se hace I/O ni decodificacion en el worker o en el callback de audio.

use crate::domain::{audio::AudioError, library::PreparedPcm};
use std::{io::Cursor, sync::Arc};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{CODEC_TYPE_FLAC, CODEC_TYPE_MP3, CODEC_TYPE_VORBIS, DecoderOptions},
    errors::Error,
    formats::FormatOptions,
    io::{MediaSourceStream, MediaSourceStreamOptions},
    meta::MetadataOptions,
    probe::Hint,
};

pub const FILE_LIMIT: usize = 32 * 1024 * 1024;
pub const CONVERSION_LIMIT: usize = 32 * 1024 * 1024;
pub const CACHE_LIMIT: usize = 128 * 1024 * 1024 - 912_000 - CONVERSION_LIMIT;

/// Decodifica fuera del worker; limita PCM antes de ampliar el buffer y conserva el formato.
pub fn decode(bytes: Vec<u8>, extension: &str, budget: usize) -> Result<PreparedPcm, AudioError> {
    let invalid = || {
        AudioError::new(
            "invalid_audio",
            "Audio corrupto, truncado o formato no admitido.",
        )
    };
    let declared_mp3_frames = extension == "mp3"
        && bytes[..bytes.len().min(4096)]
            .windows(4)
            .any(|tag| matches!(tag, b"Xing" | b"Info" | b"VBRI"));
    if extension == "ogg" {
        let mut position = 0;
        let mut eos = false;
        while position < bytes.len() {
            let header = bytes.get(position..position + 27).ok_or_else(invalid)?;
            if !header.starts_with(b"OggS") || eos {
                return Err(invalid());
            }
            let lacing = bytes
                .get(position + 27..position + 27 + usize::from(header[26]))
                .ok_or_else(invalid)?;
            let length = 27 + lacing.len() + lacing.iter().map(|v| usize::from(*v)).sum::<usize>();
            if length > bytes.len() - position {
                return Err(invalid());
            }
            eos = header[5] & 4 != 0;
            position += length;
        }
        if !eos {
            return Err(invalid());
        }
    }
    let signature = match extension {
        "wav" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE"),
        "flac" => bytes.starts_with(b"fLaC"),
        "ogg" => bytes.starts_with(b"OggS"),
        "mp3" => bytes.starts_with(b"ID3") || bytes.first() == Some(&0xff),
        _ => false,
    };
    if !signature {
        return Err(invalid());
    }
    let mut hint = Hint::new();
    hint.with_extension(extension);
    let source = MediaSourceStream::new(
        Box::new(Cursor::new(bytes)),
        MediaSourceStreamOptions::default(),
    );
    let mut format = symphonia::default::get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| invalid())?
        .format;
    let track = format.default_track().ok_or_else(invalid)?;
    let params = track.codec_params.clone();
    let track_id = track.id;
    if match extension {
        "mp3" => params.codec != CODEC_TYPE_MP3,
        "ogg" => params.codec != CODEC_TYPE_VORBIS,
        "flac" => params.codec != CODEC_TYPE_FLAC,
        _ => false,
    } {
        return Err(invalid());
    }
    let rate = params.sample_rate.ok_or_else(invalid)?;
    let channels = params.channels.ok_or_else(invalid)?.count();
    if !(8000..=192000).contains(&rate) || !(1..=2).contains(&channels) {
        return Err(AudioError::new(
            "audio_limits",
            "Solo se admiten 1 o 2 canales y frecuencias de 8 a 192 kHz.",
        ));
    }
    // Reserva 2 MiB para bloques PCM del decoder y dos copias durante Vec -> Arc.
    // El catálogo y las voces comparten Arc: nunca se multiplica la reserva por instancia.
    let limit = (budget.saturating_sub(2 * 1024 * 1024) / 2)
        .min(FILE_LIMIT)
        .min(rate as usize * channels * 120 * 4)
        / 4;
    if limit == 0 {
        return Err(AudioError::new(
            "pcm_budget",
            "No queda memoria para preparar otro audio de forma segura.",
        ));
    }
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions { verify: true })
        .map_err(|_| invalid())?;
    let mut samples = Vec::new();
    samples
        .try_reserve_exact(limit)
        .map_err(|_| AudioError::new("pcm_budget", "No se pudo reservar memoria para el audio."))?;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(_) => return Err(invalid()),
        };
        if packet.track_id() != track_id {
            return Err(invalid());
        }
        let decoded = decoder.decode(&packet).map_err(|_| invalid())?;
        if decoded.spec().rate != rate || decoded.spec().channels.count() != channels {
            return Err(invalid());
        }
        let count = decoded.frames().checked_mul(channels).ok_or_else(invalid)?;
        if count > limit.saturating_sub(samples.len())
            || decoded.capacity() * channels * 4 > 1024 * 1024
        {
            return Err(AudioError::new(
                "pcm_budget",
                "Se excede el limite de 120 s, 32 MiB PCM por archivo o 128 MiB de biblioteca precargada.",
            ));
        }
        let mut buffer = SampleBuffer::<f32>::new(decoded.frames() as u64, *decoded.spec());
        buffer.copy_interleaved_ref(decoded);
        if buffer.samples().iter().any(|sample| !sample.is_finite()) {
            return Err(invalid());
        }
        samples.extend_from_slice(buffer.samples());
    }
    if samples.is_empty() || decoder.finalize().verify_ok == Some(false) {
        return Err(invalid());
    }
    if (matches!(extension, "wav" | "flac") || declared_mp3_frames)
        && params
            .n_frames
            .is_some_and(|frames| frames != (samples.len() / channels) as u64)
    {
        return Err(invalid());
    }
    drop(decoder);
    drop(format);
    Ok(PreparedPcm {
        samples: Arc::from(samples),
        channels: channels as u16,
        sample_rate: rate,
    })
}
