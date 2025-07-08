use tauri_plugin_dialog;
use std::sync::Mutex;
use base64::{Engine as _, engine::general_purpose};
use lofty::file::TaggedFileExt;
use lofty::tag::{Accessor, ItemKey, Tag};
use lofty::id3::v2::FrameValue;
use ffmpeg_sidecar::command::FfmpegCommand;
use tempfile::{tempdir, TempDir};

// A lazy_static Mutex is no longer needed with this approach, 
// but we still need to manage the TempDir.
// We'll manage it inside the command and rely on RAII to clean it up when the app closes,
// though for a more robust app we might want a more sophisticated cleanup strategy.
#[allow(dead_code)]
static TEMP_DIR_HANDLE: Mutex<Option<TempDir>> = Mutex::new(None);

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
    let tag = lofty::read_from_path(&path)
        .map_err(|e| e.to_string())?
        .primary_tag()
        .cloned();

    let mut metadata = Metadata {
        title: None,
        artist: None,
        mime_type: None,
    };

    let mut album_art_base64 = None;
    let mut lyrics = None;

    if let Some(t) = tag {
        metadata.title = t.title().map(|s| s.to_string());
        metadata.artist = t.artist().map(|s| s.to_string());

        if let Some(picture) = t.pictures().first() {
            if let Some(mime) = picture.mime_type() {
                metadata.mime_type = Some(mime.to_string());
            }
            album_art_base64 = Some(general_purpose::STANDARD.encode(picture.data()));
        }
        
        // FINAL ATTEMPT: Simplified lyrics extraction using the generic ItemKey::Lyrics
        // This avoids all version-specific Id3v2 logic that was causing compilation errors.
        if let Some(lyrics_item) = t.get(&ItemKey::Lyrics) {
            // Using .text() as hinted by a previous compiler error message
            if let Some(lyrics_text) = lyrics_item.value().text() {
                 lyrics = Some(lyrics_text.to_string());
            }
        }
    }
    
    let temp_dir = tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let output_path = temp_dir.path().join("playback.wav");
    
    // In ffmpeg-sidecar v2, the `ffmpeg` command itself will handle downloading
    // FFmpeg if it's not found, thanks to the `download_ffmpeg` feature.
    let output_path_str = output_path.to_str().ok_or("Invalid output path")?.to_string();

    let status = FfmpegCommand::new()
        .arg("-i")
        .arg(&path)
        .arg("-ac")
        .arg("2")
        .arg("-y")
        .arg(&output_path_str)
        .spawn()
        .map_err(|e| format!("ffmpeg command failed to spawn: {}", e))?
        .wait()
        .map_err(|e| format!("ffmpeg command failed to run: {}", e))?;

    if !status.success() {
        return Err("ffmpeg command failed".to_string());
    }

    let wav_data = std::fs::read(&output_path)
        .map_err(|e| format!("Failed to read temporary wav file: {}", e))?;
    
    let playback_data_base64 = general_purpose::STANDARD.encode(&wav_data);

    // The TempDir will be automatically dropped (and the file deleted) 
    // when this function returns, which is what we want.

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
    .invoke_handler(tauri::generate_handler![process_audio_file])
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
