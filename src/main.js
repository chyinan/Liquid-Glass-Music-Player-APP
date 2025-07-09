// ES 模块导入
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open } from '@tauri-apps/plugin-dialog';

// DOM Elements
const container = document.querySelector('.container');
const fileSelectContainer = document.querySelector('.file-select-container');
const playerWrapper = document.getElementById('player-wrapper');
const distortedBg = document.getElementById('player-ui-distorted-bg');
const playerUIGlass = document.getElementById('player-ui-glass');
const visualContainer = document.getElementById('visual-container');

const backgroundBlur = document.getElementById('background-blur');
const loadBtn = document.getElementById('loadBtn');
const audioPlayer = document.getElementById('audioPlayer');

const albumArt = document.getElementById('albumArt');
const artistNameEl = document.getElementById('artistName');
const songTitleEl = document.getElementById('songTitle');

const progressBarFill = document.getElementById('progress-bar-fill');
const currentTimeEl = document.getElementById('current-time');
const durationEl = document.getElementById('duration');

const loadingOverlay = document.getElementById('loadingOverlay');

const lyricsContainer = document.getElementById('lyrics-container');
const lyricsLinesContainer = document.getElementById('lyrics-lines');
const noLyricsMessage = document.getElementById('no-lyrics-message');

// 修复：确保加载动画在启动时是隐藏的
loadingOverlay.classList.add('ui-hidden');

// State
let isPlaying = false;
let artworkUrl = null;
// This old variable was causing the issue. It's now removed.
let parsedLyrics = [];
let currentLyricIndex = -1;
// NEW: State for lyrics display mode
// 0: off, 1: translation only, 2: bilingual, 3: original only
let lyricsDisplayMode = 0;

// === 颜色工具函数和自适应主题 ===
function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s; const l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
    }
    return { h, s, l };
}

function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r1, g1, b1;
    if (h < 60) { r1 = c; g1 = x; b1 = 0; }
    else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }
    return {
        r: Math.round((r1 + m) * 255),
        g: Math.round((g1 + m) * 255),
        b: Math.round((b1 + m) * 255)
    };
}

function analyzeImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const { naturalWidth: w, naturalHeight: h } = img;
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);

            const sample = 1200;
            let rSum = 0, gSum = 0, bSum = 0;
            for (let i = 0; i < sample; i++) {
                const x = (Math.random() * w) | 0;
                const y = (Math.random() * h) | 0;
                const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
                rSum += r; gSum += g; bSum += b;
            }
            const r = rSum / sample;
            const g = gSum / sample;
            const b = bSum / sample;
            const luminance = (r + g + b) / 3;
            resolve({ r, g, b, luminance });
        };
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

function applyAdaptiveColors({ text, bgAlpha = 0.2 }) {
    const root = document.documentElement.style;
    root.setProperty('--adaptive-text-color', text);
    root.setProperty('--adaptive-progress-fill', text);

    const m = text.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
        const r = m[1], g = m[2], b = m[3];
        root.setProperty('--adaptive-progress-bg', `rgba(${r},${g},${b},${bgAlpha})`);
    } else {
        root.setProperty('--adaptive-progress-bg', 'rgba(255,255,255,0.2)');
    }
}

function resetToDefault() {
    applyAdaptiveColors({ text: '#f0f0f0' });
}

// 获取当前窗口实例
const appWindow = WebviewWindow.getCurrent();

async function handleFile(filePath) {
    showLoading('Analyzing Audio...');
    try {
        console.log('选择的文件:', filePath);

        parsedLyrics = [];
        lyricsLinesContainer.innerHTML = '';
        noLyricsMessage.classList.add('hidden');
        currentLyricIndex = -1;
        
        const result = await invoke('process_audio_file', { path: filePath });
        console.log('处理结果:', result);

        if (result.lyrics) {
            const lyricText = result.lyrics;
            parsedLyrics = parseLRC(lyricText);
            console.log(`Parsed ${parsedLyrics.length} lines of lyrics.`);
            noLyricsMessage.classList.toggle('hidden', parsedLyrics.length > 0);
            renderAllLyricsOnce();
        } else {
            console.log('No embedded lyrics found from backend.');
            parsedLyrics = [];
            renderAllLyricsOnce();
            noLyricsMessage.classList.remove('hidden');
        }
        updateLyrics(0);

        artistNameEl.textContent = result.metadata.artist || 'Unknown Artist';
        songTitleEl.textContent = result.metadata.title || 'Unknown Title';

        // Manually trigger check after new text is set.
        // A small timeout helps ensure scrollWidth is updated.
        setTimeout(() => {
            // applyMarquee(songTitleEl);
            // applyMarquee(artistNameEl);
        }, 100);

        if (result.album_art_base64) {
            const mimeType = result.metadata.mime_type || 'image/jpeg';
            artworkUrl = `data:${mimeType};base64,${result.album_art_base64}`;

            backgroundBlur.style.backgroundImage = `url(${artworkUrl})`;
            distortedBg.style.backgroundImage = `url(${artworkUrl})`;
            backgroundBlur.classList.add('active');
            albumArt.src = artworkUrl;
            albumArt.style.display = 'block';

            // 自适应颜色
            analyzeImage(artworkUrl).then((info) => {
                if (!info) return resetToDefault();
                const { r, g, b, luminance } = info;
                if (luminance < 150) {
                    resetToDefault();
                } else {
                    const { h, s, l } = rgbToHsl(r, g, b);
                    if (s < 0.15) {
                        applyAdaptiveColors({ text: '#222222bf' });
                    } else {
                        const newL = Math.max(0, l - 0.35);
                        const { r: dr, g: dg, b: db } = hslToRgb(h, s, newL);
                        const textColor = `rgb(${dr},${dg},${db})`;
                        applyAdaptiveColors({ text: textColor });
                    }
                }
            });
        } else {
            // No album art
            backgroundBlur.style.backgroundImage = 'none';
            distortedBg.style.backgroundImage = 'none';
            backgroundBlur.classList.remove('active');
            albumArt.src = '';
            albumArt.style.display = 'none';

            resetToDefault();
        }

        audioPlayer.src = `data:audio/wav;base64,${result.playback_data_base64}`;
        audioPlayer.load();
        audioPlayer.play().catch(e => console.error('Audio playback failed:', e));

        fileSelectContainer.style.display = 'none';
        playerWrapper.classList.remove('hidden');

    } catch (error) {
        console.error('处理音频时出错:', error);
        alert(`Error: ${error}`);
    } finally {
        hideLoading();
    }
}

function formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

audioPlayer.addEventListener('loadedmetadata', () => {
    durationEl.textContent = formatTime(audioPlayer.duration);
});

audioPlayer.addEventListener('timeupdate', () => {
    currentTimeEl.textContent = formatTime(audioPlayer.currentTime);
    const progress = (audioPlayer.currentTime / audioPlayer.duration) * 100;
    progressBarFill.style.width = `${progress}%`;
    updateLyrics(audioPlayer.currentTime);
});

loadBtn.addEventListener('click', async () => {
    try {
        const selected = await open({
            multiple: false,
            filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'm4a'] }]
        });
        if (selected) {
            await handleFile(selected);
        }
    } catch (e) {
        console.error("Error opening file dialog", e);
    }
});

const currentWindow = appWindow;
currentWindow.onDragDropEvent(async (evt) => {
    const { type, paths } = evt.payload;

    if (type === 'enter') {
        document.body.classList.add('drag-over');
    } else if (type === 'leave') {
        document.body.classList.remove('drag-over');
    } else if (type === 'drop') {
        document.body.classList.remove('drag-over');
        if (paths && paths.length) {
            const audioPath = paths.find(p => /\.(mp3|wav|flac|m4a)$/i.test(p));
            if (audioPath) {
                showLoading('Analyzing Audio...');
                await handleFile(audioPath);
            } else {
                alert('Please drop a valid audio file (mp3, wav, flac, m4a).');
            }
        }
    }
});

window.addEventListener('keydown', (event) => {
    switch (event.key.toLowerCase()) {
        case ' ':
            event.preventDefault();
            if (audioPlayer.paused) {
                audioPlayer.play().catch(e => console.error("Audio playback failed:", e));
            } else {
                audioPlayer.pause();
            }
            break;
        case 'r':
            audioPlayer.currentTime = 0;
            break;
        case 'f':
            // 使用浏览器的 Fullscreen API，避免额外权限配置
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen().catch(() => {});
            }
            break;
        case 'l':
            // 在进入歌词模式前，如果极简模式是激活的，则先退出极简模式
            if (playerUIGlass.classList.contains('minimal-mode')) {
                playerUIGlass.classList.remove('minimal-mode');
                container.classList.remove('minimal-active');
                playerWrapper.classList.remove('minimal-active');
            }
            toggleLyrics();
            break;
        case 'v':
            // 在进入极简模式前，如果歌词模式是激活的，则先退出歌词模式
            if (lyricsDisplayMode !== 0) { // Check against the new state
                // Set mode to the last state (original) so the next toggle turns it off.
                lyricsDisplayMode = 3; 
                toggleLyrics(); // This will now cycle to 0 (off) and update the UI correctly.
            }
            // 切换极简模式
            const minimalActive = playerUIGlass.classList.toggle('minimal-mode');

            // 兼容不支持 :has() 选择器的浏览器，手动给容器和 wrapper 加备份类
            if (minimalActive) {
                container.classList.add('minimal-active');
                playerWrapper.classList.add('minimal-active');
            } else {
                container.classList.remove('minimal-active');
                playerWrapper.classList.remove('minimal-active');
            }
            break;
    }
});

function showLoading(message) {
    loadingOverlay.querySelector('p').textContent = message;
    loadingOverlay.classList.remove('ui-hidden');
}

function hideLoading() {
    loadingOverlay.classList.add('ui-hidden');
}

function toggleLyrics() {
    // Cycle through modes: 0 (off) -> 1 (translation) -> 2 (bilingual) -> 3 (original) -> 0 (off)
    lyricsDisplayMode = (lyricsDisplayMode + 1) % 4;

    const lyricsActive = lyricsDisplayMode !== 0;

    // This is the missing line that controls the visibility of the entire lyrics panel.
    lyricsContainer.classList.toggle('hidden', !lyricsActive);

    // Remove all mode classes before adding the new one
    document.body.classList.remove('lyrics-active', 'lyrics-mode-translation', 'lyrics-mode-bilingual', 'lyrics-mode-original');

    if (lyricsActive) {
        document.body.classList.add('lyrics-active');
        switch (lyricsDisplayMode) {
            case 1: // Translation only
                document.body.classList.add('lyrics-mode-translation');
                break;
            case 2: // Bilingual
                document.body.classList.add('lyrics-mode-bilingual');
                break;
            case 3: // Original only
                document.body.classList.add('lyrics-mode-original');
                break;
        }
    }

    // NEW: Show a friendly notice if user switches to translation-only mode but no translation exists
    if (lyricsDisplayMode === 1) { // translation-only
        const hasTranslation = parsedLyrics.some(l => l.translation);
        if (!hasTranslation) {
            noLyricsMessage.textContent = '此歌曲暂无翻译';
            noLyricsMessage.classList.remove('hidden');
        } else {
            noLyricsMessage.classList.add('hidden');
        }
    } else {
        // Hide the "no translation" notice when leaving translation-only mode (but keep it visible if it was the original no-lyrics message)
        if (noLyricsMessage.textContent === '此歌曲暂无翻译') {
            noLyricsMessage.classList.add('hidden');
        }
    }
    
    const settings = document.querySelector('.settings-wrapper');
    if (settings) {
        settings.classList.toggle('visually-hidden', lyricsActive);
    }
    
    // 修复：切换时立即更新歌词
    currentLyricIndex = -1;
    updateLyrics(audioPlayer.currentTime);

    // Re-check marquee status after toggling lyrics mode.
    // applyMarquee(songTitleEl);
    // applyMarquee(artistNameEl);
}

// All marquee-related JavaScript has been removed for simplicity.
// Text will now wrap by default based on CSS rules.

function parseLRC(lrcText) {
    const lines = lrcText.split(/\r\n|\n|\r/);
    const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/;
    const intermediate = [];

    for (const line of lines) {
        const match = line.match(timeRegex);
        if (match) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
            const time = minutes * 60 + seconds + milliseconds / 1000;
            const text = line.replace(timeRegex, '').trim();
            if (text) {
                intermediate.push({ time, text });
            }
        }
    }

    if (intermediate.length === 0) return [];

    const finalLyrics = [];
    for (let i = 0; i < intermediate.length; i++) {
        const current = intermediate[i];
        const next = i + 1 < intermediate.length ? intermediate[i + 1] : null;

        if (next && next.time === current.time) {
            finalLyrics.push({ time: current.time, text: current.text, translation: next.text });
            i++; // 跳过下一行，因为它已经是翻译
        } else {
            finalLyrics.push({ time: current.time, text: current.text, translation: null });
        }
    }
    return finalLyrics;
}

function updateLyrics(currentTime) {
    if (parsedLyrics.length === 0) {
        return;
    }

    // 计算新索引：找到第一句时间大于 currentTime 的行
    const firstLaterIdx = parsedLyrics.findIndex(line => line.time > currentTime);
    let newLyricIndex;
    if (firstLaterIdx === -1) {
        // 已经超过最后一句歌词时间，保持在最后一句
        newLyricIndex = parsedLyrics.length - 1;
    } else {
        newLyricIndex = firstLaterIdx - 1;
        if (newLyricIndex < 0) newLyricIndex = 0;
    }

    const isActive = lyricsDisplayMode !== 0;

    // The condition should ONLY update the index.
    // The DOM update logic must run every time to handle mode switches.
    if (newLyricIndex !== currentLyricIndex) {
        currentLyricIndex = newLyricIndex;
    }

    const allLines = lyricsLinesContainer.querySelectorAll('.lyrics-line');

    // === 1. Main Update Loop: Set intended positions and clean up old states ===
    allLines.forEach(line => {
        const absIndex = parseInt(line.dataset.absIndex, 10);
        const relativeIndex = absIndex - currentLyricIndex;

        // A line should be made visible again if it becomes the current line,
        // or if lyrics are turned off, or it scrolls far away.
        if (line.classList.contains('skip-line')) {
            if (relativeIndex === 0 || !isActive || Math.abs(relativeIndex) > 1) {
                line.classList.remove('skip-line');
            }
        }
        
        // If, after cleanup, it's still marked to be skipped, keep it hidden and do nothing else.
        if (line.classList.contains('skip-line')) {
             delete line.dataset.lineIndex;
             return;
        }

        // Set the data-line-index for all potentially visible neighbors.
        // The CSS will position them, making them ready for measurement.
        if (isActive && Math.abs(relativeIndex) <= 2) {
            line.dataset.lineIndex = relativeIndex;
        } else {
            delete line.dataset.lineIndex;
        }
    });

    // === 2. Force Layout Flush ===
    // This is the key to fixing the "flash". It forces the browser to apply all the
    // style changes from setting data-line-index above, so that getBoundingClientRect
    // will return the final, correct positions in the next step.
    void lyricsLinesContainer.offsetHeight;

    // === 3. Overlap Check & Final Hide ===
    // Now, read the just-calculated positions and hide any lines that collide.
    if (isActive) {
        const currentLi = lyricsLinesContainer.querySelector('.lyrics-line[data-line-index="0"]');
        if (!currentLi) return;
        const currRect = currentLi.getBoundingClientRect();

        // Check previous line for overlap.
        const prevLi = lyricsLinesContainer.querySelector('.lyrics-line[data-line-index="-1"]');
        if (prevLi) {
            const prevRect = prevLi.getBoundingClientRect();
            if (prevRect.bottom > currRect.top + 10) {
                prevLi.classList.add('skip-line', 'fade-out-up');
                prevLi.addEventListener('animationend', () => prevLi.classList.remove('fade-out-up'), { once: true });
            }
        }

        // Check next line for overlap.
        const nextLi = lyricsLinesContainer.querySelector('.lyrics-line[data-line-index="1"]');
        if (nextLi) {
            const nextRect = nextLi.getBoundingClientRect();
            if (nextRect.top < currRect.bottom - 10) {
                nextLi.classList.add('skip-line', 'fade-out-down');
                nextLi.addEventListener('animationend', () => nextLi.classList.remove('fade-out-down'), { once: true });
            }
        }
    }
}

// --- 新增函数 ---
// 在加载时一次性渲染所有歌词行到 DOM 中
function renderAllLyricsOnce() {
    lyricsLinesContainer.innerHTML = ''; // 清空旧的
    parsedLyrics.forEach((line, index) => {
        const li = document.createElement('li');
        li.classList.add('lyrics-line');
        li.dataset.absIndex = index; // 存储其在数组中的绝对索引

        const originalSpan = document.createElement('span');
        originalSpan.classList.add('original-lyric');
        originalSpan.textContent = line.text;

        const translatedSpan = document.createElement('span');
        translatedSpan.classList.add('translated-lyric');
        // Only add translation if it exists
        if (line.translation) {
            translatedSpan.textContent = line.translation;
        }
        // If no translation, the span will be empty, and the CSS ':empty' selector will hide it.

        li.appendChild(originalSpan);
        li.appendChild(translatedSpan);

        lyricsLinesContainer.appendChild(li);
    });
}

