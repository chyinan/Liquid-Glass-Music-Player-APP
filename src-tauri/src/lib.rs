use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::process::Command;
use tempfile::tempdir;
use encoding_rs::{GBK, UTF_16LE};
use font_kit::source::SystemSource;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
// use font_kit::family::Family; // no longer needed
use font_kit::handle::Handle;
use font_kit::properties::{Style, Weight};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedFonts {
    zh_fonts: Vec<String>,
    ja_fonts: Vec<String>,
    en_fonts: Vec<String>,
    other_fonts: Vec<String>,
}

// Helper function to check for language support in a font
fn check_lang_support(font: &font_kit::font::Font, lang_code: &str) -> bool {
    match lang_code {
        // Simplified Chinese: Check for common characters "你" and "好"
        "zh-Hans" => {
            font.glyph_for_char('你').is_some() && font.glyph_for_char('好').is_some()
        }
        // Japanese: Check for Hiragana "あ" and Katakana "カ"
        "ja" => {
            font.glyph_for_char('あ').is_some() && font.glyph_for_char('カ').is_some()
        }
        _ => false,
    }
}

#[tauri::command]
fn get_system_fonts() -> Result<CategorizedFonts, String> {
    let source = SystemSource::new();
    let mut font_names: HashMap<String, (bool, bool)> = HashMap::new(); // (is_zh, is_ja)

    // First pass: Iterate through all fonts to determine their likely language support
    if let Ok(handles) = source.all_fonts() {
        for handle in handles.iter() {
            if let Ok(font) = handle.load() {
                let family_name = font.family_name();
                let entry = font_names.entry(family_name).or_insert((false, false));
                if !entry.0 && check_lang_support(&font, "zh-Hans") {
                    entry.0 = true;
                }
                if !entry.1 && check_lang_support(&font, "ja") {
                    entry.1 = true;
                }
            }
        }
    } else {
        return Err("Failed to query system fonts.".into());
    }

    // Second pass: Categorize based on the collected information
    let mut zh_fonts = Vec::new();
    let mut ja_fonts = Vec::new();
    let mut en_fonts = Vec::new();
    let mut other_fonts = Vec::new();

    // Helper closures for name pattern checks
    let looks_chinese = |fname: &str| {
        let patterns = [
            "sc", "cn", "gb", "hei", "song", "kai", "fang", "ping", "sim", "msyh", "思源", "方正", "兰亭", "微软雅黑", "华文", "中易", "简" , "宋" , "黑" , "楷" , "体" , "粗" , "细"
        ];
        let lname = fname.to_lowercase();
        patterns.iter().any(|p| lname.contains(p))
    };

    let looks_japanese = |fname: &str| {
        let patterns = [
            "jp", "mincho", "gothic", "hiragino", "meiryo", "yu", "kozuka", "ipa", "hg", "ms pgothic", "ms gothic", "明朝", "ゴシック", "メイリオ","uzura",
            // NEW additions for Fontworks / Morisawa naming
            "kakugo", "marugo", "udkakugo", "udmarugo", "pr6n", "fot-", "morisawa", "kaku", "maru", "honya", "honyaji"
        ];
        let lname = fname.to_lowercase();
        patterns.iter().any(|p| lname.contains(p)) || fname.contains('ゴ') || fname.contains('リ')
    };

    for (name, (is_zh, is_ja)) in font_names {
        match (is_zh, is_ja) {
            (true, false) => {
                if looks_japanese(&name) && !looks_chinese(&name) {
                    ja_fonts.push(name);
                } else if !looks_chinese(&name) {
                    // Name doesn't look Chinese; if it's ascii treat as English, else put to other.
                    if name.chars().all(|c| c.is_ascii()) {
                        en_fonts.push(name);
                    } else {
                        other_fonts.push(name);
                    }
                } else {
                    zh_fonts.push(name);
                }
            },
            (false, true) => ja_fonts.push(name),
            (true, true) => {
                // Both languages detected, decide by heuristics on name
                if looks_chinese(&name) && !looks_japanese(&name) {
                    zh_fonts.push(name);
                } else if looks_japanese(&name) && !looks_chinese(&name) {
                    ja_fonts.push(name);
                } else {
                    // fallback: prefer Chinese to reduce loss
                    zh_fonts.push(name);
                }
            }
            (false, false) => {
                // If neither glyph heuristic matched, fall back to name patterns first.
                if looks_japanese(&name) {
                    ja_fonts.push(name);
                } else if looks_chinese(&name) {
                    zh_fonts.push(name);
                } else if name.chars().all(|c| c.is_ascii()) {
                    en_fonts.push(name);
                } else {
                    other_fonts.push(name);
                }
            }
        }
    }
    
    // Sort the lists alphabetically
    zh_fonts.sort();
    ja_fonts.sort();
    en_fonts.sort();
    other_fonts.sort();

    Ok(CategorizedFonts {
        zh_fonts,
        ja_fonts,
        en_fonts,
        other_fonts,
    })
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
#[serde(rename_all = "camelCase")]
struct Metadata {
    title: Option<String>,
    artist: Option<String>,
    mime_type: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcessedFile {
    metadata: Metadata,
    playback_data_base64: String,
    album_art_base64: Option<String>,
    lyrics: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PreparedFile {
    metadata: Metadata,
    cache_path: String,
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

#[tauri::command]
fn prepare_audio_file(path: String) -> Result<PreparedFile, String> {
    // Decode the URL-encoded path received from the frontend.
    let path_decoded = urlencoding::decode(&path)
        .map_err(|e| format!("Failed to decode path: {}", e))?
        .into_owned();

    let path = path_decoded;

    // Ensure ffmpeg / ffprobe is available
    ffmpeg_sidecar::download::auto_download()
        .map_err(|e| format!("Failed to download ffmpeg: {}", e))?;

    // ========== 1. 获取元数据 & 歌词（重用逻辑） ==========
    // This reuses the same logic from process_audio_file to keep behaviour consistent.
    let mut metadata = Metadata {
        title: None,
        artist: None,
        mime_type: Some("image/jpeg".to_string()),
    };
    let mut lyrics = None;

    // --- ffprobe metadata extraction (copy from existing implementation) ---
    let mut ffprobe_cmd = std::process::Command::new("ffprobe");
    ffprobe_cmd
        .arg("-v")
        .arg("quiet")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg("-i")
        .arg(&path);

    #[cfg(windows)]
    ffprobe_cmd.creation_flags(0x08000000);

    let ffprobe_output = ffprobe_cmd
        .output()
        .map_err(|e| format!("Failed to execute ffprobe: {}", e))?;

    if ffprobe_output.status.success() {
        let ffprobe_json: std::borrow::Cow<'_, str> = if let Ok(s) = std::str::from_utf8(&ffprobe_output.stdout) {
            std::borrow::Cow::Borrowed(s)
        } else {
            let (decoded_utf16, _, had_errors_utf16) = UTF_16LE.decode(&ffprobe_output.stdout);
            if !had_errors_utf16 {
                decoded_utf16
            } else {
                let (decoded_gbk, _, _had_errors_gbk) = GBK.decode(&ffprobe_output.stdout);
                decoded_gbk
            }
        };

        if let Ok(probe_data) = serde_json::from_str::<FFProbeOutput>(&ffprobe_json) {
            let mut combined_tags = probe_data.format.tags;
            for stream in probe_data.streams {
                if stream.codec_type == "audio" {
                    combined_tags.extend(stream.tags);
                    break;
                }
            }

            metadata.title = combined_tags.get("title").cloned();
            metadata.artist = combined_tags
                .get("artist")
                .or_else(|| combined_tags.get("ARTIST"))
                .cloned();

            lyrics = combined_tags
                .get("lyrics")
                .or_else(|| combined_tags.get("LYRICS"))
                .cloned();

            if lyrics.is_none() {
                for (k, v) in &combined_tags {
                    if k.to_lowercase().starts_with("lyrics") {
                        lyrics = Some(v.clone());
                        break;
                    }
                }
            }

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
        }
    }

    // Fallback to filename for title / artist if still missing
    if let Some(file_stem_os) = std::path::Path::new(&path).file_stem() {
        let file_stem_str = file_stem_os.to_string_lossy();
        if metadata.title.is_none() {
            metadata.title = Some(file_stem_str.to_string());
        }
        if metadata.artist.is_none() {
            let parts: Vec<&str> = file_stem_str
                .split('-')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            if parts.len() >= 2 {
                metadata.artist = Some(parts[0].to_string());
                if let Some(ref t) = metadata.title {
                    if t == &file_stem_str {
                        metadata.title = Some(parts[1..].join(" - "));
                    }
                }
            }
        }
    }

    // ========== 2. 提取封面 ==========
    let art_tempdir = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let art_output_path = art_tempdir.path().join("cover.jpg");

    let mut art_cmd = std::process::Command::new("ffmpeg");
    art_cmd
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&path)
        .arg("-an")
        .arg("-vcodec")
        .arg("copy")
        .arg(art_output_path.to_str().unwrap());

    #[cfg(windows)]
    art_cmd.creation_flags(0x08000000);

    let mut album_art_base64 = None;
    if art_cmd.output().map(|o| o.status.success()).unwrap_or(false) {
        if let Ok(data) = std::fs::read(&art_output_path) {
            album_art_base64 = Some(general_purpose::STANDARD.encode(&data));
        }
    }

    // ========== 3. 转码音频为 WAV，并保存到临时文件 ==========
    // 使用系统临时目录，确保路径在 $TEMP 范围，方便 assetProtocol 访问。
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Time error: {}", e))?
        .as_millis();
    let cache_path = std::env::temp_dir().join(format!("imp_cache_{}.wav", timestamp));
    let cache_path_str = cache_path
        .to_str()
        .ok_or_else(|| "Failed to convert cache path to string".to_string())?
        .to_owned();

    let mut wav_cmd = std::process::Command::new("ffmpeg");
    wav_cmd
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&path)
        .arg("-ac")
        .arg("2")
        .arg("-y")
        .arg(&cache_path_str);

    #[cfg(windows)]
    wav_cmd.creation_flags(0x08000000);

    let status = wav_cmd
        .status()
        .map_err(|e| format!("ffmpeg command failed to run: {}", e))?;

    if !status.success() {
        return Err("ffmpeg command for wav failed".to_string());
    }

    Ok(PreparedFile {
        metadata,
        cache_path: cache_path_str,
        album_art_base64,
        lyrics,
    })
}

#[tauri::command]
fn cleanup_cached_file(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Ok(());
    }
    match std::fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to remove cached file: {}", e)),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            process_audio_file,
            get_system_fonts,
            get_font_data,
            prepare_audio_file,
            cleanup_cached_file
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
