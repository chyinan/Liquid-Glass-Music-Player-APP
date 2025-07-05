import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

document.addEventListener('DOMContentLoaded', () => {
    // ... (你之前的 DOM 元素引用和大部分函数都可以保留) ...

    const loadBtn = document.getElementById('loadBtn');
    const audio = document.getElementById('audioPlayer');

    const backgroundBlur = document.getElementById('background-blur');
    const fileSelectContainer = document.querySelector('.file-select-container');
    
    const playerWrapper = document.getElementById('player-wrapper');
    const distortedBg = document.getElementById('player-ui-distorted-bg');
    const playerUIGlass = document.getElementById('player-ui-glass');
    const visualContainer = document.getElementById('visual-container');
    
    const albumArt = document.getElementById('albumArt');
    const artistNameEl = document.getElementById('artistName');
    const songTitleEl = document.getElementById('songTitle');

    const progressBarFill = document.getElementById('progress-bar-fill');
    const currentTimeEl = document.getElementById('current-time');
    const durationEl = document.getElementById('duration');
    
    const loadingOverlay = document.getElementById('loadingOverlay');

    let isPlaying = false;
    let artworkUrl = null;

    function formatTime(seconds) {
        const floorSeconds = Math.floor(seconds);
        const min = Math.floor(floorSeconds / 60);
        const sec = floorSeconds % 60;
        return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }

    // === Event Listeners for Audio Player ===
    audio.addEventListener('loadedmetadata', () => {
        durationEl.textContent = formatTime(audio.duration);
    });

    audio.addEventListener('timeupdate', () => {
        currentTimeEl.textContent = formatTime(audio.currentTime);
        const progress = (audio.currentTime / audio.duration) * 100;
        progressBarFill.style.width = `${progress}%`;
    });

    // === Core Logic: File Upload & Processing (Adapted for Tauri V2) ===
    loadBtn.addEventListener('click', async () => {
        loadingOverlay.style.opacity = '1';
        loadingOverlay.style.pointerEvents = 'auto';

        try {
            const selected = await open({
                multiple: false,
                filters: [{
                    name: 'Audio',
                    extensions: ['mp3', 'wav', 'flac', 'm4a']
                }]
            });

            if (selected) {
                console.log('选择的文件:', selected);
                
                const result = await invoke('process_audio_file', { path: selected });
                console.log('处理结果:', result);

                artistNameEl.textContent = result.metadata.artist || 'Unknown Artist';
                songTitleEl.textContent = result.metadata.title || 'Unknown Title';

                if (result.album_art_base64) {
                    const mimeType = result.metadata.mime_type || 'image/jpeg';
                    artworkUrl = `data:${mimeType};base64,${result.album_art_base64}`;
                    
                    backgroundBlur.style.backgroundImage = `url(${artworkUrl})`;
                    distortedBg.style.backgroundImage = `url(${artworkUrl})`;
                    backgroundBlur.classList.add('active');
                    albumArt.src = artworkUrl;
                    albumArt.style.display = 'block';

                    // Your color analysis logic can go here
                    // getImageDominantColor(artworkUrl, setTextColorBasedOnBackground);

                } else {
                    // Handle no artwork
                    backgroundBlur.style.backgroundImage = 'none';
                    distortedBg.style.backgroundImage = 'none';
                    backgroundBlur.classList.remove('active');
                    albumArt.src = '';
                    albumArt.style.display = 'none';
                }

                audio.src = `data:audio/wav;base64,${result.playback_data_base64}`;
                audio.load();
                audio.play().catch(e => console.error("Audio playback failed:", e));

                fileSelectContainer.style.display = 'none';
                playerWrapper.classList.remove('hidden');

            }
        } catch (error) {
            console.error('处理音频时出错:', error);
            alert(`Error: ${error}`);
        } finally {
            loadingOverlay.style.opacity = '0';
            loadingOverlay.style.pointerEvents = 'none';
        }
    });

    // === Keyboard Shortcuts ===
    document.addEventListener('keydown', async (event) => {
        // Ignore shortcuts if typing in an input field
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
            return;
        }
        
        switch (event.key.toLowerCase()) {
            case ' ':
                event.preventDefault(); // Prevent page from scrolling
                if (audio.paused) {
                    audio.play().catch(e => console.error("Audio playback failed:", e));
                } else {
                    audio.pause();
                }
                break;
            case 'r':
                audio.currentTime = 0;
                break;
            case 'f':
                const appWindow = WebviewWindow.getCurrent();
                appWindow.setFullscreen(!await appWindow.isFullscreen());
                break;
            case 'v':
                // Toggle minimal mode class for advanced glass UI
                const isActive = playerUIGlass.classList.toggle('minimal-mode');

                // Fallback classes for browsers without :has() support
                const containerEl = document.querySelector('.container');
                if (isActive) {
                    containerEl.classList.add('minimal-active');
                    playerWrapper.classList.add('minimal-active');
                } else {
                    containerEl.classList.remove('minimal-active');
                    playerWrapper.classList.remove('minimal-active');
                }
                break;
        }
    });
});
