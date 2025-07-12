use base64::{engine::general_purpose, Engine as _};
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::process::Command;
use tempfile::tempdir;
use encoding_rs::{GBK, UTF_16LE};
use font_kit::source::SystemSource;
use std::collections::HashSet;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
// use font_kit::family::Family; // no longer needed
use font_kit::handle::Handle;
use font_kit::properties::{Weight, Style};

// The platform-specific `enumerate_localized_fonts` functions have been removed
// in favor of the simpler, cross-platform `get_system_fonts` command below.

#[tauri::command]
fn get_system_fonts() -> Result<Vec<String>, String> {
    let source = SystemSource::new();
    let mut names: Vec<String> = source
        .all_families()
        .map_err(|e| format!("Failed to enumerate fonts: {e}"))?;

    // Deduplicate & sort.
    names.sort();
    names.dedup();
    Ok(names)
}

/// A command that takes a font family name and returns the font data as a Base64 string.
#[tauri::command]
fn get_font_data(font_name: String) -> Result<String, String> {
    let source = SystemSource::new();
    let family = source
        .select_family_by_name(&font_name)
        .map_err(|e| format!("Font family '{}' not found: {}", font_name, e))?;

    // Pick the first font in the family that is Normal style & weight if possible.
    let mut chosen_handle: Option<Handle> = None;

    for handle in family.fonts() {
        // Attempt to load to inspect properties. Ignore errors.
        if let Ok(font) = handle.load() {
            let props = font.properties();
            if props.style == Style::Normal && props.weight == Weight::NORMAL {
                chosen_handle = Some(handle.clone());
                break;
            }
            // Fallback candidate
            if chosen_handle.is_none() {
                chosen_handle = Some(handle.clone());
            }
        }
    }

    let handle = chosen_handle.ok_or_else(|| format!("No fonts found in family '{}'.", font_name))?;

    // Extract bytes from the handle.
    let font_bytes = match handle {
        Handle::Path { ref path, .. } => std::fs::read(path)
            .map_err(|e| format!("Failed to read font file: {}", e))?,
        Handle::Memory { bytes, .. } => bytes.to_vec(),
    };

    Ok(general_purpose::STANDARD.encode(&font_bytes))
}


#[derive(Deserialize, Debug)]
struct FFProbeOutput {
    streams: Vec<Stream>,
    format: Format,
}

#[derive(Deserialize, Debug)]
struct Stream {
    codec_type: String,
    // The `tags` field might be missing if there are no tags.
    #[serde(default)]
    tags: HashMap<String, String>,
}

#[derive(Deserialize, Debug)]
struct Format {
    // The `tags` field might be missing if there are no tags.
    #[serde(default)]
    tags: HashMap<String, String>,
}

#[derive(serde::Serialize, Clone)]
struct Metadata {
    title: Option<String>,
    artist: Option<String>,
    mime_type: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct ProcessedFile {
    metadata: Metadata,
    playback_data_base64: String,
    album_art_base64: Option<String>,
    lyrics: Option<String>,
}

#[tauri::command]
fn process_audio_file(path: String) -> Result<ProcessedFile, String> {
    // Decode the URL-encoded path received from the frontend to prevent corruption.
    let path_decoded = urlencoding::decode(&path)
        .map_err(|e| format!("Failed to decode path: {}", e))?
        .into_owned();

    let path = path_decoded;

    // 1. Download ffmpeg/ffprobe if not already present.
    // This also adds the binaries to the PATH for the current process.
    ffmpeg_sidecar::download::auto_download()
        .map_err(|e| format!("Failed to download ffmpeg: {}", e))?;

    // 2. Run ffprobe to get metadata
    let mut ffprobe_cmd = Command::new("ffprobe");
    ffprobe_cmd.arg("-v")
        .arg("quiet")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg("-i")
        .arg(&path);
    
    #[cfg(windows)]
    ffprobe_cmd.creation_flags(0x08000000);

    let ffprobe_output = ffprobe_cmd.output()
        .map_err(|e| format!("Failed to execute ffprobe: {}", e))?;

    let mut metadata = Metadata {
        title: None,
        artist: None,
        mime_type: Some("image/jpeg".to_string()), // Default, might be overwritten
    };
    let mut lyrics = None;

    if ffprobe_output.status.success() {
        // Here we attempt to decode the output from ffprobe.
        // The output could be in UTF-8, UTF-16 (on Windows), or a legacy
        // codepage like GBK (on Chinese Windows systems). We try them in order.
        let ffprobe_json: Cow<'_, str> = 
            // 1. Try UTF-8 first.
            if let Ok(s) = std::str::from_utf8(&ffprobe_output.stdout) {
                Cow::Borrowed(s)
            } else {
                // 2. If not UTF-8, try UTF-16LE.
                let (decoded_utf16, _, had_errors_utf16) = UTF_16LE.decode(&ffprobe_output.stdout);
                if !had_errors_utf16 {
                    // If decoding as UTF-16LE had no errors, it was likely the correct encoding.
                    decoded_utf16
                } else {
                    // 3. If UTF-16LE also had errors, fall back to GBK as the last resort.
                    let (decoded_gbk, _, had_errors_gbk) = GBK.decode(&ffprobe_output.stdout);
                    if had_errors_gbk {
                        eprintln!("[WARN] Failed to decode metadata as UTF-8, UTF-16LE, or GBK. Some characters may be incorrect.");
                    }
                    decoded_gbk
                }
            };

        if let Ok(probe_data) = serde_json::from_str::<FFProbeOutput>(&ffprobe_json) {
            // Combine tags from format and streams (sometimes metadata is in one or the other)
            let mut combined_tags = probe_data.format.tags;
            for stream in probe_data.streams {
                if stream.codec_type == "audio" {
                    combined_tags.extend(stream.tags);
                    break; // Assume first audio stream is the one we want
                }
            }

            metadata.title = combined_tags.get("title").cloned();
            metadata.artist = combined_tags.get("artist").or_else(|| combined_tags.get("ARTIST")).cloned();
            // 1) Try common keys
            lyrics = combined_tags
                .get("lyrics")
                .or_else(|| combined_tags.get("LYRICS"))
                .cloned();

            // 2) If still none, search for any key that starts with "lyrics" (case-insensitive),
            //    e.g. "lyrics-XXX" which is often produced by some DAWs.
            if lyrics.is_none() {
                for (k, v) in &combined_tags {
                    if k.to_lowercase().starts_with("lyrics") {
                        lyrics = Some(v.clone());
                        break;
                    }
                }
            }

            // If ffprobe returns an empty or whitespace-only string for title or artist, treat it as missing.
            if metadata
                .title
                .as_ref()
                .map(|t| t.trim().is_empty() || t.contains('\u{FFFD}'))
                .unwrap_or(false)
            {
                metadata.title = None;
            }
            if metadata
                .artist
                .as_ref()
                .map(|a| a.trim().is_empty() || a.contains('\u{FFFD}'))
                .unwrap_or(false)
            {
                metadata.artist = None;
            }

        } else {
            eprintln!("Failed to parse ffprobe JSON output.");
        }
    } else {
        eprintln!(
            "ffprobe exited with non-zero status: {}",
            String::from_utf8_lossy(&ffprobe_output.stderr)
        );
    }
    
    // Fallback if title or artist is still None
    if let Some(file_stem_os) = std::path::Path::new(&path).file_stem() {
        let file_stem_str = file_stem_os.to_string_lossy();

        // Fallback for title
        if metadata.title.is_none() {
            metadata.title = Some(file_stem_str.to_string());
        }

        // If artist missing or invalid, and filename contains dash, attempt to parse "artist - title"
        if metadata.artist.is_none() {
            let parts: Vec<&str> = file_stem_str
                .split('-')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            if parts.len() >= 2 {
                metadata.artist = Some(parts[0].to_string());

                // If our title still等于整个文件名，把它替换为去掉 artist 的剩余部分
                if let Some(ref t) = metadata.title {
                    if t == &file_stem_str {
                        metadata.title = Some(parts[1..].join(" - "));
                    }
                }
            }
        }
    }

    // 3. Extract album art using ffmpeg
    let temp_dir_art = tempdir().map_err(|e| format!("Failed to create temp dir for art: {}", e))?;
    let art_output_path = temp_dir_art.path().join("cover.jpg");

    let mut art_cmd = Command::new("ffmpeg");
    art_cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&path)
        .arg("-an") // no audio
        .arg("-vcodec")
        .arg("copy")
        .arg(art_output_path.to_str().unwrap());

    #[cfg(windows)]
    art_cmd.creation_flags(0x08000000);

    let art_output = art_cmd.output();

    let mut album_art_base64 = None;
    if let Ok(output) = art_output {
        if output.status.success() {
            if let Ok(art_data) = std::fs::read(&art_output_path) {
                album_art_base64 = Some(general_purpose::STANDARD.encode(&art_data));
            }
        }
    }

    // 4. Transcode audio to WAV for playback
    let temp_dir_wav = tempdir().map_err(|e| format!("Failed to create temp dir for wav: {}", e))?;
    let wav_output_path = temp_dir_wav.path().join("playback.wav");

    let mut wav_cmd = Command::new("ffmpeg");
    wav_cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&path)
        .arg("-ac")
        .arg("2")
        .arg("-y")
        .arg(wav_output_path.to_str().unwrap());

    #[cfg(windows)]
    wav_cmd.creation_flags(0x08000000);
        
    let wav_status = wav_cmd.status()
        .map_err(|e| format!("ffmpeg command for wav failed to run: {}", e))?;

    if !wav_status.success() {
        return Err("ffmpeg command for wav failed".to_string());
    }

    let wav_data = std::fs::read(&wav_output_path)
        .map_err(|e| format!("Failed to read temporary wav file: {}", e))?;

    let playback_data_base64 = general_purpose::STANDARD.encode(&wav_data);

    Ok(ProcessedFile {
        metadata,
        playback_data_base64,
        album_art_base64,
        lyrics,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            process_audio_file,
            get_system_fonts,
            get_font_data
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
