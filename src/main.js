// ES 模块导入
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
// NEW: 引入语言识别库
import { franc } from 'franc';

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

    const progressBarContainer = document.getElementById('progress-bar-container');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const currentTimeEl = document.getElementById('current-time');
    const durationEl = document.getElementById('duration');
    
    const loadingOverlay = document.getElementById('loadingOverlay');

const lyricsContainer = document.getElementById('lyrics-container');
const lyricsLinesContainer = document.getElementById('lyrics-lines');
const noLyricsMessage = document.getElementById('no-lyrics-message');
// NEW: Settings Elements
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const githubLink = document.getElementById('githubLink'); // Get the GitHub link element
// NEW: 更新为新的选择器ID
const fontChineseSelect = document.getElementById('font-chinese-select');
const fontJapaneseSelect = document.getElementById('font-japanese-select');
const fontEnglishSelect = document.getElementById('font-english-select');
const boldOriginalToggle = document.getElementById('bold-original-toggle');
const boldTranslationToggle = document.getElementById('bold-translation-toggle');
const italicOriginalToggle = document.getElementById('italic-original-toggle');
const italicTranslationToggle = document.getElementById('italic-translation-toggle');
const opacityRange = document.getElementById('lyrics-opacity-range');
const textShadowToggle = document.getElementById('text-shadow-toggle'); // NEW: Get the shadow toggle element

/**
 * Wrap ASCII/latin sequences with span.latin so他们使用英文字体
 * @param {string} text raw text line
 * @returns {string} html string with spans
 */
function wrapEnglish(text) {
    // Simple escaping for < & >
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text.split(/([A-Za-z0-9]+)/).map(seg => {
        if (/^[A-Za-z0-9]+$/.test(seg)) {
            return `<span class="latin">${esc(seg)}</span>`;
        }
        return esc(seg);
    }).join('');
}

// 修复：确保加载动画在启动时是隐藏的
loadingOverlay.classList.add('ui-hidden');

// State
    let isPlaying = false;
    let isSeeking = false;
    let artworkUrl = null;
// This old variable was causing the issue. It's now removed.
let parsedLyrics = [];
let currentLyricIndex = -1;
// NEW: State for lyrics display mode
// 0: off, 1: translation only, 2: bilingual (orig/trans), 3: bilingual-reversed (trans/orig), 4: original only
let lyricsDisplayMode = 0;

// === NEW: Settings and Font Management (Refactored) ===

/**
 * Injects a <style> tag with a @font-face rule for the given font data.
 * @param {string} fontDataB64 - The base64 encoded font data.
 * @param {string} fontFamilyName - The unique name to assign to this font-face.
 */
function injectFontFace(fontDataB64, fontFamilyName) {
    // 移除旧的同名style标签，避免重复注入
    const oldStyle = document.getElementById(`dynamic-font-style-${fontFamilyName}`);
    if (oldStyle) {
        oldStyle.remove();
    }

    const style = document.createElement('style');
    style.id = `dynamic-font-style-${fontFamilyName}`;
    style.textContent = `
        @font-face {
            font-family: '${fontFamilyName}';
            src: url(data:font/truetype;base64,${fontDataB64});
        }
    `;
    document.head.appendChild(style);
}

/**
 * Applies the selected fonts by fetching their data and injecting them.
 */
async function applyLyricsFonts() {
    const fontSelectors = {
        zh: fontChineseSelect,
        ja: fontJapaneseSelect,
        en: fontEnglishSelect,
    };

    for (const [lang, selectElement] of Object.entries(fontSelectors)) {
        const selectedFont = selectElement.value;
        const dynamicFontName = `dynamic-font-${lang}`;

        if (selectedFont) {
            try {
                // 调用后端获取字体文件数据
                const fontDataB64 = await invoke('get_font_data', { fontName: selectedFont });
                // 动态注入 @font-face
                injectFontFace(fontDataB64, dynamicFontName);
                // 应用动态字体
                document.documentElement.style.setProperty(`--font-${lang}`, `'${dynamicFontName}'`);
            } catch (error) {
                console.error(`Failed to load font ${selectedFont}:`, error);
                // 加载失败则回退到无衬线字体
                document.documentElement.style.setProperty(`--font-${lang}`, 'sans-serif');
            }
        } else {
            // 如果选择“默认”，则回退
            document.documentElement.style.setProperty(`--font-${lang}`, 'sans-serif');
        }
    }
}

/**
 * Applies font weight based on bold toggle
 * @param {boolean} isBold
 */
function applyLyricsBold(originalBold, translationBold) {
    document.documentElement.style.setProperty('--lyrics-font-weight-original', originalBold ? '700' : '400');
    document.documentElement.style.setProperty('--lyrics-font-weight-translation', translationBold ? '700' : '400');
}

/**
 * Applies font style (italic) based on italic toggle
 * @param {boolean} originalItalic
 * @param {boolean} translationItalic
 */
function applyLyricsItalic(originalItalic, translationItalic) {
    document.documentElement.style.setProperty('--lyrics-font-style-original', originalItalic ? 'italic' : 'normal');
    document.documentElement.style.setProperty('--lyrics-font-style-translation', translationItalic ? 'italic' : 'normal');
}

/**
 * Applies opacity based on the range value.
 * @param {number} value - The value from the range input (0-100).
 */
function applyLyricsOpacity(value) {
    const alpha = Math.max(0, Math.min(100, value)) / 100;
    document.documentElement.style.setProperty('--lyrics-global-alpha', alpha.toString());
}

/**
 * Applies text shadow based on the toggle's state.
 * @param {boolean} isEnabled - Whether the shadow should be enabled.
 */
function applyTextShadow(isEnabled) {
    const shadowStyle = isEnabled 
        ? '0 1px 8px rgba(0, 0, 0, 0.7)' 
        : 'none';
    document.documentElement.style.setProperty('--adaptive-text-shadow', shadowStyle);
}

function populateFontSelectors(categorizedFonts) {
    const { zhFonts, jaFonts, enFonts, otherFonts } = categorizedFonts;

    const groups = [
        { label: '中文', list: zhFonts },
        { label: '日文', list: jaFonts },
        { label: '英文字体', list: enFonts },
        { label: '其他', list: otherFonts },
    ];

    const populateWithGroups = (select) => {
        select.innerHTML = '<option value="">默认</option>';
        groups.forEach(group => {
            if (!group.list || group.list.length === 0) return;
            const optgroup = document.createElement('optgroup');
            optgroup.label = group.label;
            group.list.forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                // Use localized display name when available
                option.textContent = getLocalizedFontName(name);
                // NEW: Render each option using its own font family for live preview
                option.style.fontFamily = `'${name}', sans-serif`;
                // Optional: Slightly larger font size for better visibility
                option.style.fontSize = '16px';
                optgroup.appendChild(option);
            });
            select.appendChild(optgroup);
        });
    };

    populateWithGroups(fontChineseSelect);
    populateWithGroups(fontJapaneseSelect);
    populateWithGroups(fontEnglishSelect);
}

async function loadAndPopulateFonts() {
    try {
        const categorizedFonts = await invoke('get_system_fonts');
        populateFontSelectors(categorizedFonts);
        
        // Restore saved font preferences after populating
        const savedZhFont = localStorage.getItem('font-zh');
        const savedJaFont = localStorage.getItem('font-ja');
        const savedEnFont = localStorage.getItem('font-en');

        if (savedZhFont) {
            fontChineseSelect.value = savedZhFont;
            updateFontVariable('--font-zh', savedZhFont);
        }
        if (savedJaFont) {
            fontJapaneseSelect.value = savedJaFont;
            updateFontVariable('--font-ja', savedJaFont);
        }
        if (savedEnFont) {
            fontEnglishSelect.value = savedEnFont;
            updateFontVariable('--font-en', savedEnFont);
        }

    } catch (error) {
        console.error("Failed to load system fonts:", error);
    }
}

function updateFontVariable(variable, fontName) {
    if (fontName) {
        document.documentElement.style.setProperty(variable, `'${fontName}', sans-serif`);
    } else {
        // Revert to default
        document.documentElement.style.removeProperty(variable);
    }
}

// Event Listeners for font selection
fontChineseSelect.addEventListener('change', (e) => {
    const fontName = e.target.value;
    localStorage.setItem('font-zh', fontName);
    updateFontVariable('--font-zh', fontName);
});

fontJapaneseSelect.addEventListener('change', (e) => {
    const fontName = e.target.value;
    localStorage.setItem('font-ja', fontName);
    updateFontVariable('--font-ja', fontName);
});

fontEnglishSelect.addEventListener('change', (e) => {
    const fontName = e.target.value;
    localStorage.setItem('font-en', fontName);
    updateFontVariable('--font-en', fontName);
});

/**
 * Sets up all event listeners and initial state for the settings panel.
 */
function setupSettings() {
    // 切换面板显示
    settingsBtn.addEventListener('click', () => {
        settingsPanel.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
        if (!settingsPanel.contains(e.target) && !settingsBtn.contains(e.target)) {
            settingsPanel.classList.add('hidden');
        }
    });

    // 下拉变更事件
    const onChange = async () => {
        // NEW: 保存到新的本地存储键名
        localStorage.setItem('lyricsFontChinese', fontChineseSelect.value);
        localStorage.setItem('lyricsFontJapanese', fontJapaneseSelect.value);
        localStorage.setItem('lyricsFontEnglish', fontEnglishSelect.value);
        await applyLyricsFonts();
    };

    // NEW: 监听新的下拉框
    fontChineseSelect.addEventListener('change', onChange);
    fontJapaneseSelect.addEventListener('change', onChange);
    fontEnglishSelect.addEventListener('change', onChange);

    // Bold toggle listeners
    const onBoldChange = () => {
        localStorage.setItem('lyricsBoldOriginal', boldOriginalToggle.checked ? '1' : '0');
        localStorage.setItem('lyricsBoldTranslation', boldTranslationToggle.checked ? '1' : '0');
        applyLyricsBold(boldOriginalToggle.checked, boldTranslationToggle.checked);
    };
    boldOriginalToggle.addEventListener('change', onBoldChange);
    boldTranslationToggle.addEventListener('change', onBoldChange);

    // Italic toggle listeners
    const onItalicChange = () => {
        localStorage.setItem('lyricsItalicOriginal', italicOriginalToggle.checked ? '1' : '0');
        localStorage.setItem('lyricsItalicTranslation', italicTranslationToggle.checked ? '1' : '0');
        applyLyricsItalic(italicOriginalToggle.checked, italicTranslationToggle.checked);
    };
    italicOriginalToggle.addEventListener('change', onItalicChange);
    italicTranslationToggle.addEventListener('change', onItalicChange);

    // Opacity range listener
    opacityRange.addEventListener('input', () => {
        const val = parseInt(opacityRange.value, 10);
        localStorage.setItem('lyricsOpacity', val.toString());
        applyLyricsOpacity(val);
    });

    // NEW: Text shadow listener
    textShadowToggle.addEventListener('change', () => {
        const isEnabled = textShadowToggle.checked;
        localStorage.setItem('textShadowEnabled', isEnabled ? '1' : '0');
        applyTextShadow(isEnabled);
    });

    loadAndPopulateFonts();

    // === Restore Bold / Italic / Opacity settings ===
    const savedBoldOriginal = localStorage.getItem('lyricsBoldOriginal') === '1';
    const savedBoldTranslation = localStorage.getItem('lyricsBoldTranslation') === '1';
    boldOriginalToggle.checked = savedBoldOriginal;
    boldTranslationToggle.checked = savedBoldTranslation;
    applyLyricsBold(savedBoldOriginal, savedBoldTranslation);

    const savedItalicOriginal = localStorage.getItem('lyricsItalicOriginal') === '1';
    const savedItalicTranslation = localStorage.getItem('lyricsItalicTranslation') === '1';
    italicOriginalToggle.checked = savedItalicOriginal;
    italicTranslationToggle.checked = savedItalicTranslation;
    applyLyricsItalic(savedItalicOriginal, savedItalicTranslation);

    const savedOpacity = parseInt(localStorage.getItem('lyricsOpacity'), 10);
    if (!isNaN(savedOpacity)) {
        opacityRange.value = savedOpacity;
        applyLyricsOpacity(savedOpacity);
    }
    
    // NEW: Restore text shadow setting
    const savedTextShadow = localStorage.getItem('textShadowEnabled') === '1';
    textShadowToggle.checked = savedTextShadow;
    applyTextShadow(savedTextShadow);
}


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

    function applyAdaptiveColors({ text, bgAlpha = 0.2 }) {
        const root = document.documentElement.style;
        root.setProperty('--adaptive-text-color', text);
        root.setProperty('--adaptive-progress-fill', text);

        let r = 255, g = 255, b = 255; // Default to white components

        const rgbMatch = text.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgbMatch) {
            r = parseInt(rgbMatch[1], 10);
            g = parseInt(rgbMatch[2], 10);
            b = parseInt(rgbMatch[3], 10);
        } else if (text.startsWith('#')) {
            const hex = text.substring(1);
            if (hex.length === 3) {
                r = parseInt(hex[0] + hex[0], 16);
                g = parseInt(hex[1] + hex[1], 16);
                b = parseInt(hex[2] + hex[2], 16);
            } else if (hex.length === 6) {
                r = parseInt(hex.substring(0, 2), 16);
                g = parseInt(hex.substring(2, 4), 16);
                b = parseInt(hex.substring(4, 6), 16);
            }
        }
        
        root.setProperty('--adaptive-progress-bg', `rgba(${r},${g},${b},${bgAlpha})`);
    }

    function resetToDefault() {
        // As requested, default to pure white for better contrast on dark backgrounds.
        applyAdaptiveColors({ text: '#ffffff' });
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

                // NEW: Sample from a central rectangle in the bottom half of the image,
                // as requested, to improve accuracy by focusing where text is.
                const sampleXStart = w * 0.25; // Start 25% from the left
                const sampleWidth = w * 0.5;   // Sample a 50% horizontal slice
                const sampleYStart = h * 0.55; // Start from 55% down
                const sampleHeight = h * 0.35; // Sample a 35% vertical slice

                for (let i = 0; i < sample; i++) {
                    const x = (sampleXStart + (Math.random() * sampleWidth)) | 0;
                    const y = (sampleYStart + (Math.random() * sampleHeight)) | 0;
                    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
                    rSum += r; gSum += g; bSum += b;
                }
                const r = rSum / sample;
                const g = gSum / sample;
                const b = bSum / sample;
                // Use perceptive luminance for better accuracy
                const luminance = (r * 0.299 + g * 0.587 + b * 0.114);
                resolve({ r, g, b, luminance });
            };
            img.onerror = () => resolve(null);
            img.src = url;
        });
    }

// 获取当前窗口实例
const appWindow = WebviewWindow.getCurrent();

async function handleFile(filePath) {
    if (!filePath) {
        // This case handles when the user cancels the dialog
        console.log("File selection was cancelled.");
        return;
    }
    showLoading('Processing Audio...');

    try {
        const metadata = await invoke("load_audio_file", { filePath });

        // --- UI TRANSITION ---
        // Hide file select, show player
        fileSelectContainer.classList.add('hidden');
        githubLink.classList.add('hidden'); // Hide the GitHub link
        playerWrapper.classList.remove('hidden');

        // Reset UI from previous track
        resetPlayerUI();

        console.log('选择的文件:', filePath);

        parsedLyrics = [];
        lyricsLinesContainer.innerHTML = '';
        noLyricsMessage.classList.add('hidden');
        currentLyricIndex = -1;
        
        const result = await invoke('process_audio_file', { path: encodeURIComponent(filePath) });
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
                if (!info) {
                    // Fallback to white if analysis fails
                    return resetToDefault();
                }
                
                const { r, g, b, luminance } = info;

                // If the bottom half is dark (luminance < 140), use white text.
                // The threshold was increased from 128 to 140 to be more sensitive
                // to darker backgrounds, ensuring white text is used more appropriately.
                if (luminance < 140) {
                    resetToDefault(); // Uses white text
                } else {
                    // If the bottom half is light, find a contrasting dark color.
                    const { h, s, l } = rgbToHsl(r, g, b);
                    if (s < 0.2) {
                        // For low saturation colors (grays), just use a dark gray.
                        applyAdaptiveColors({ text: '#222222' });
                    } else {
                        // For saturated colors, make it much darker.
                        const newL = Math.max(0, l - 0.45);
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

        // fileSelectContainer.style.display = 'none'; // This line is now handled by the new UI transition
        // playerWrapper.classList.remove('hidden'); // This line is now handled by the new UI transition

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
    if (isSeeking) return; // 拖动时不更新
    currentTimeEl.textContent = formatTime(audioPlayer.currentTime);
    const progress = (audioPlayer.currentTime / audioPlayer.duration) * 100;
        progressBarFill.style.width = `${progress}%`;
    updateLyrics(audioPlayer.currentTime);
    });

    loadBtn.addEventListener('click', async () => {
        try {
            const selected = await dialogOpen({
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

// --- 进度条拖动逻辑 ---
function seek(e) {
    if (audioPlayer.duration) {
        const rect = progressBarContainer.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const width = progressBarContainer.clientWidth;
        const progress = Math.max(0, Math.min(1, offsetX / width));
        
        const newTime = progress * audioPlayer.duration;
        audioPlayer.currentTime = newTime;

        // 拖动时立即手动更新UI
        progressBarFill.style.width = `${progress * 100}%`;
        currentTimeEl.textContent = formatTime(newTime);
    }
}

progressBarContainer.addEventListener('mousedown', (e) => {
    isSeeking = true;
    seek(e); // 立即跳转到点击位置
});

document.addEventListener('mousemove', (e) => {
    if (isSeeking) {
        // 使用 requestAnimationFrame 优化性能，避免过于频繁的更新
        requestAnimationFrame(() => seek(e));
    }
});

document.addEventListener('mouseup', () => {
    isSeeking = false;
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
            // 在进入极简模式前，如果歌词模式处于激活状态，则强制先完全关闭歌词模式
            if (lyricsDisplayMode !== 0) {
                /*
                 * 由于循环顺序是 0→2→3→4→1→0，想要“一步到位”关闭歌词，
                 * 只需把 state 预设为 1（translation），toggleLyrics() 会立刻跳到 0(off)。
                 */
                lyricsDisplayMode = 1;
                toggleLyrics();
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
    // NEW: Define regex here to check for metadata lines like '作词', '作曲', '译' etc.
    const metaRegex = /(作[词詞]|作曲|编曲|編曲|詞|曲|译|arranger|composer|lyricist|lyrics|ti|ar|al|by)/i;
    // UPDATED: A song is considered to have translations only if there's at least one
    // translated line that isn't just metadata.
    const hasTranslation = parsedLyrics.some(l => l.translation && !metaRegex.test(l.text));

    // If there's no translation, just toggle between off (0) and original (4).
    if (!hasTranslation) {
        if (lyricsDisplayMode === 0) {
            lyricsDisplayMode = 4; // From off, go to original
        } else {
            lyricsDisplayMode = 0; // From original, go to off
        }
    } else {
        // Corrected Cycle: Off(0) -> Bilingual(2) -> Reversed(3) -> Original(4) -> Translation(1) -> Off(0)
        const nextModeMap = {
            0: 2, // Off -> Bilingual
            2: 3, // Bilingual -> Bilingual Reversed
            3: 4, // Bilingual Reversed -> Original
            4: 1, // Original -> Translation
            1: 0  // Translation -> Off
        };
        lyricsDisplayMode = nextModeMap[lyricsDisplayMode] ?? 0; // Default to Off if state is weird
    }

    const lyricsActive = lyricsDisplayMode !== 0;
    let modeString = ''; // String name for the current mode for the indicator

    // This is the missing line that controls the visibility of the entire lyrics panel.
    lyricsContainer.classList.toggle('hidden', !lyricsActive);

    // Remove all mode classes before adding the new one
    document.body.classList.remove('lyrics-active', 'lyrics-mode-translation', 'lyrics-mode-bilingual', 'lyrics-mode-bilingual-reversed', 'lyrics-mode-original');

    if (lyricsActive) {
        document.body.classList.add('lyrics-active');
        switch (lyricsDisplayMode) {
            case 1: // Translation only
                modeString = 'translation';
                document.body.classList.add('lyrics-mode-translation');
                break;
            case 2: // Bilingual (orig/trans)
                modeString = 'bilingual';
                document.body.classList.add('lyrics-mode-bilingual');
                break;
            case 3: // Bilingual (trans/orig)
                modeString = 'bilingual-reversed';
                document.body.classList.add('lyrics-mode-bilingual-reversed');
                break;
            case 4: // Original only
                modeString = 'original';
                document.body.classList.add('lyrics-mode-original');
                break;
        }
        // Now that we have the correct mode string, show the indicator.
        showLyricsModeIndicator(modeString);
    }
    
    const settings = document.querySelector('.settings-wrapper');
    if (settings) {
        settings.classList.toggle('visually-hidden', lyricsActive);
    }
    
    // 修复：切换时立即更新歌词，但延迟到下一帧，确保新CSS生效后再计算位置
    currentLyricIndex = -1;
    requestAnimationFrame(() => updateLyrics(audioPlayer.currentTime, true));
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

function updateLyrics(currentTime, forceRecalc = false) {
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
    if (forceRecalc || newLyricIndex !== currentLyricIndex) {
        currentLyricIndex = newLyricIndex;

        // --- CORE LOGIC MOVED ---
        // This entire block now ONLY runs when the lyric line changes,
        // preventing the high-frequency updates that caused the flickering.
        
        const allLines = lyricsLinesContainer.querySelectorAll('.lyrics-line');

        // First, reset any special state from the previous line to prevent flickering.
        // This is a more robust way to clean up.
        allLines.forEach(line => line.classList.remove('move-up-more'));

        // === 1. Main Update Loop: Set intended positions ===
        allLines.forEach(line => {
            const absIndex = parseInt(line.dataset.absIndex, 10);
            const relativeIndex = absIndex - currentLyricIndex;

            if (line.classList.contains('skip-line')) {
                if (relativeIndex === 0 || !isActive || Math.abs(relativeIndex) > 1) {
                    line.classList.remove('skip-line');
                }
            }
            
            if (line.classList.contains('skip-line')) {
                 delete line.dataset.lineIndex;
                 return;
            }

            if (isActive && Math.abs(relativeIndex) <= 1) {
                line.dataset.lineIndex = relativeIndex;
            } else {
                delete line.dataset.lineIndex;
            }
        });

        // === 2. Force Layout Flush ===
        void lyricsLinesContainer.offsetHeight;

        // === 3. DYNAMICALLY SET TRANSFORMS (NEW LOGIC) ===
        if (isActive) {
            const getLineByRelIdx = (idx) => lyricsLinesContainer.querySelector(`.lyrics-line[data-line-index="${idx}"]`);
            
            // Utility to get the computed scale for a line
            const getScale = (el) => {
                if (!el) return 0;
                // We can get the CSS variable value.
                return parseFloat(getComputedStyle(el).getPropertyValue('--scale'));
            };

            const line0 = getLineByRelIdx(0);
            if (!line0) return;

            // Define a base gap, reduced for a more pronounced dynamic effect.
            const baseGap = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2.0; 

            // Set current line's position
            line0.style.setProperty('--translate-y', '0px');
            
            // --- Calculate positions downwards ---
            let lastLine = line0;
            let lastTranslateY = 0;

            const line1 = getLineByRelIdx(1);
            if (line1) {
                // NEW: Dynamic gap based on the SUM of heights for a stronger effect
                const dynamicGap = baseGap + (lastLine.offsetHeight + line1.offsetHeight) * 0.15;
                const distance = (lastLine.offsetHeight / 2) * getScale(lastLine) + (line1.offsetHeight / 2) * getScale(line1) + dynamicGap;
                const translateY = lastTranslateY + distance;
                line1.style.setProperty('--translate-y', `${translateY}px`);

                lastLine = line1;
                lastTranslateY = translateY;
                
                const line2 = getLineByRelIdx(2);
                if (line2) {
                    const dynamicGap2 = baseGap + (lastLine.offsetHeight + line2.offsetHeight) * 0.15;
                    const distance2 = (lastLine.offsetHeight / 2) * getScale(lastLine) + (line2.offsetHeight / 2) * getScale(line2) + dynamicGap2;
                    const translateY2 = lastTranslateY + distance2;
                    line2.style.setProperty('--translate-y', `${translateY2}px`);
                }
            }

            // --- Calculate positions upwards ---
            lastLine = line0;
            lastTranslateY = 0;

            const line_minus_1 = getLineByRelIdx(-1);
            if (line_minus_1) {
                const dynamicGap = baseGap + (lastLine.offsetHeight + line_minus_1.offsetHeight) * 0.15;
                const distance = (lastLine.offsetHeight / 2) * getScale(lastLine) + (line_minus_1.offsetHeight / 2) * getScale(line_minus_1) + dynamicGap;
                const translateY = lastTranslateY - distance;
                line_minus_1.style.setProperty('--translate-y', `${translateY}px`);

                lastLine = line_minus_1;
                lastTranslateY = translateY;

                const line_minus_2 = getLineByRelIdx(-2);
                if (line_minus_2) {
                    const dynamicGap2 = baseGap + (lastLine.offsetHeight + line_minus_2.offsetHeight) * 0.15;
                    const distance2 = (lastLine.offsetHeight / 2) * getScale(lastLine) + (line_minus_2.offsetHeight / 2) * getScale(line_minus_2) + dynamicGap2;
                    const translateY2 = lastTranslateY - distance2;
                    line_minus_2.style.setProperty('--translate-y', `${translateY2}px`);
                }
            }
        }
    }
}

// --- 新增函数 ---
// 在加载时一次性渲染所有歌词行到 DOM 中
function renderAllLyricsOnce() {
    lyricsLinesContainer.innerHTML = ''; // 清空
    if (!parsedLyrics || parsedLyrics.length === 0) {
        noLyricsMessage.classList.remove('hidden');
        return;
    }
    noLyricsMessage.classList.add('hidden');

    parsedLyrics.forEach((line, index) => {
        const li = document.createElement('li');
        li.className = 'lyrics-line';
        li.dataset.time = line.time;
        // FIX: Add the absolute index back for the updateLyrics function to find the element.
        li.dataset.absIndex = index;

        const originalSpan = document.createElement('span');
        originalSpan.className = 'original-lyric';
        
        // FIX: Reverted to using `line.text` and added a fallback for empty lines.
        let originalText = line.text || '';
        // REMOVED: The confusing and ineffective meta-regex check block is gone.
        // The logic for determining "hasTranslation" is now correctly handled in toggleLyrics.
        
        const langCode = franc(originalText, { minLength: 1 });
        if (langCode === 'cmn' || langCode === 'nan') {
            originalSpan.lang = 'zh-CN';
        } else if (langCode === 'jpn') {
            originalSpan.lang = 'ja';
        } else {
            originalSpan.lang = 'en';
        }

        originalSpan.innerHTML = wrapEnglish(originalText);

        li.appendChild(originalSpan);
        const translationSpan = document.createElement('span');
        translationSpan.className = 'translated-lyric';
        translationSpan.lang = 'zh-CN';
        if (line.translation) {
            translationSpan.innerHTML = wrapEnglish(line.translation);
        } else {
            translationSpan.innerHTML = '';
        }
        li.appendChild(translationSpan);
        lyricsLinesContainer.appendChild(li);
    });
}

// --- NEW: Lyrics Mode Indicator ---
const lyricsModeIndicator = document.getElementById('lyrics-mode-indicator');
const indicatorIcon = lyricsModeIndicator.querySelector('.indicator-icon');
const indicatorText = lyricsModeIndicator.querySelector('.indicator-text');
let indicatorTimeout;

function showLyricsModeIndicator(mode) {
    clearTimeout(indicatorTimeout);

    const modeMap = {
        'original': { icon: 'Aあ', text: '原文模式' },
        'translation': { icon: '译', text: '译文模式' },
        'bilingual': { icon: 'Aあ<br>译', text: '双语模式' },
        'bilingual-reversed': { icon: '译<br>Aあ', text: '双语模式 (反转)' }
    };

    const config = modeMap[mode] || { icon: '?', text: '未知模式' };
    
    indicatorIcon.innerHTML = config.icon;
    indicatorText.textContent = config.text;

    lyricsModeIndicator.classList.add('visible');

    indicatorTimeout = setTimeout(() => {
        lyricsModeIndicator.classList.remove('visible');
    }, 1500); // Keep it visible for 1.5 seconds
}

// === Initialization ===
document.addEventListener('DOMContentLoaded', () => {
    // All initial setup calls can go here.
    setupSettings();

    // GitHub link click → open in system browser
    const githubLinkEl = document.getElementById('githubLink');
    if (githubLinkEl) {
        githubLinkEl.addEventListener('click', (e) => {
            e.preventDefault();
            const url = githubLinkEl.getAttribute('href');
            if (window.__TAURI__) {
                // NEW: Correctly import from the shell plugin
                import('@tauri-apps/plugin-shell').then(({ open }) => {
                    open(url).catch(() => window.open(url, '_blank'));
                }).catch(() => window.open(url, '_blank'));
            } else {
                window.open(url, '_blank');
            }
        });
    }
});

// === NEW: Localized Font Name Mapping ===
// Map English family names to their localized (Japanese/Chinese) display names for better readability in the dropdowns.
const LOCALIZED_FONT_NAME_MAP = {
    // Japanese fonts
    "Yu Mincho": "游明朝",
    "YuMincho": "游明朝",
    "Yu Mincho UI": "游明朝 UI",
    "YuMincho UI": "游明朝 UI",
    "Yu Gothic": "游ゴシック",
    "YuGothic": "游ゴシック",
    "Yu Gothic UI": "游ゴシック UI",
    "YuGothic UI": "游ゴシック UI",
    "MS Mincho": "ＭＳ 明朝",
    "MS Gothic": "ＭＳ ゴシック",
    "MS PGothic": "ＭＳ Ｐゴシック",
    "Meiryo": "メイリオ",
    "SoukouMincho": "装甲明朝",
    "Rounded M+ 1p": "Rounded M+ 1p",
    // Chinese common aliases (optional)
    "Noto Sans SC": "思源黑体 SC",
    "Noto Serif SC": "思源宋体 SC",
    "Source Han Sans SC": "思源黑体 SC",
    "Source Han Serif SC": "思源宋体 SC",
    // Add more mappings as needed...
    "Sarasa Fixed J": "更纱等距 J",
    "Sarasa Fixed SC": "更纱等距 SC",
    "Sarasa Fixed Slab J": "更纱等距 Slab J",
    "Sarasa Fixed Slab SC": "更纱等距 Slab SC",
    "Sarasa Term SC": "更纱等宽 SC",
    "Sarasa Term J": "更纱等宽 J",
    "Sarasa Term Slab J": "更纱等宽 Slab J",
    "Sarasa Term Slab SC": "更纱等宽 Slab SC",
    "Sarasa Term Slab J": "更纱等宽 Slab J",
    "Sarasa Term Slab TC": "更纱等宽 Slab TC",
    "Sarasa Fixed": "更纱等距",
    "Sarasa Gothic SC": "更纱黑体 SC",
    "Sarasa Gothic TC": "更纱黑体 TC",
    "Sarasa Gothic J": "更纱黑体 J",
    "Sarasa Gothic K": "更纱黑体 K",
    "Microsoft JhengHei": "微软正黑体",
    // === Japanese Fonts (new entries) ===
    "A-OTF Ryumin Pr6N B-KL": "リュウミン Pr6N B-KL",
    "A-OTF Ryumin Pr6N H-KL": "リュウミン Pr6N H-KL",
    "BIZ UDGothic": "BIZ UDゴシック",
    "BIZ UDMincho": "BIZ UD明朝",
    "BestTen-CRT": "ベストテン CRT",
    "Century Gothic": "センチュリーゴシック",
    "Copperplate Gothic": "コッパープレート ゴシック",
    "DFCraftYu-W5": "DFクラフト游 W5",
    "DFGanKaiSho-W7": "DF岩楷書 W7",
    "DFMaruMoji-SL": "DF丸文字 SL",
    "DFMaruMojiRD-W7": "DF丸文字 RD W7",
    "FOT-Comet Std": "FOT-コメット Std",
    "FOT-MatisseEleganto Pro DB": "FOT-マティスエレガント Pro DB",
    "FOT-Skip Std": "FOT-スキップ Std",
    "FOT-UDKakugo_Large Pr6N DB": "FOT-UD角ゴ_Large Pr6N DB",
    "UD Digi Kyokasho N": "UDデジタル教科書体 N",
    "UD Digi Kyokasho NP": "UDデジタル教科書体 NP",
    "UD Digi Kyokasho NK-R": "UDデジタル教科書体 NK-R",
    "UD Digi Kyokasho N-R": "UDデジタル教科書体 N-R",
    "Meiryo UI": "メイリオ UI",
    "Noto Sans JP": "Noto Sans JP",
    "Noto Serif JP": "Noto Serif JP",
    "Nico Moji": "ニコ文字",
    "Rounded M+ 1p": "Rounded M+ 1p",
    "Showcard Gothic": "SHOWCARD ゴシック",
    "Source Han Serif JP": "源ノ明朝 JP",
    // Add more as needed...
    "Meiryo with Source Han Sans": "メイリオ + 思源黑体",
    "MZhiHei PRC": "M正黑体 PRC",
    "HonyaJi-Re": "ホンヤジ Re",
    "SimSun-ExtB": "宋体 扩展B",
    "SimSun-ExtG": "宋体 扩展G",
};

// Heuristic replacements for Japanese -> native script
const JP_REPLACEMENTS = [
    [/(?:^|\s)Gothic/gi, " ゴシック"],
    [/(?:^|\s)Mincho/gi, " 明朝"],
    [/Ryumin/gi, "リュウミン"],
    [/Maru/gi, "丸"],
    [/Kaku/gi, "角"],
    [/UD/gi, "UD"],
];

function autoJapaneseName(name) {
    let result = name;
    JP_REPLACEMENTS.forEach(([regex, rep]) => {
        result = result.replace(regex, rep);
    });
    return result;
}

/**
 * Returns localized display name.
 */
function getLocalizedFontName(name) {
    if (LOCALIZED_FONT_NAME_MAP[name]) return LOCALIZED_FONT_NAME_MAP[name];
    // If looks Japanese (simple heuristic) apply autop replace
    if (/Gothic|Mincho|Ryumin|Kaku|Maru|ゴシック|明朝/i.test(name)) {
        return autoJapaneseName(name);
    }
    return name;
}

