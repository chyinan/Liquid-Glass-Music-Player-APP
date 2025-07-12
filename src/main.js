// ES 模块导入
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open } from '@tauri-apps/plugin-dialog';
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
// NEW: 更新为新的选择器ID
const fontChineseSelect = document.getElementById('font-chinese-select');
const fontJapaneseSelect = document.getElementById('font-japanese-select');
const fontEnglishSelect = document.getElementById('font-english-select');
const boldOriginalToggle = document.getElementById('bold-original-toggle');
const boldTranslationToggle = document.getElementById('bold-translation-toggle');
const opacityRange = document.getElementById('lyrics-opacity-range');

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
 * Applies opacity based on the range value.
 * @param {number} value - The value from the range input (0-100).
 */
function applyLyricsOpacity(value) {
    const alpha = Math.max(0, Math.min(100, value)) / 100;
    document.documentElement.style.setProperty('--lyrics-global-alpha', alpha.toString());
}

/**
 * Fetches system fonts, populates the dropdowns, and applies the saved fonts.
 */
async function populateFontSelectors() {
    try {
        console.log('Attempting to fetch system fonts...');
        const fonts = await invoke('get_system_fonts');
        console.log('Received fonts from backend:', fonts);
        if (!Array.isArray(fonts) || fonts.length === 0) return;

        // 分组排序
        // 基本汉字 & 日文假名检测
        const chineseRegex = /[\u4e00-\u9fff]/;
        const japaneseRegex = /[\u3040-\u30ff]/;
        // 常见日文字体英文家族名关键字（Meiryo / MS Gothic / Yu Gothic / Noto Sans JP ...）
        const japaneseKeywordRegex = /(Meiryo|Noto\s(?:Sans|Serif).*JP|Yu\s?Gothic|Yu\s?Mincho|MS\s(?:Gothic|Mincho|PMincho|PGothic|UI\sGothic)|Hiragino|IPA\s(?:Gothic|Mincho))/i;

        const chineseFonts = [];
        const japaneseFonts = [];
        const otherFonts = [];

        fonts.forEach(f => {
            if (japaneseRegex.test(f) || japaneseKeywordRegex.test(f)) {
                japaneseFonts.push(f);
            } else if (chineseRegex.test(f)) {
                chineseFonts.push(f);
            } else {
                otherFonts.push(f);
            }
        });

        const groupedFonts = [
            { label: '中文', list: chineseFonts.sort() },
            { label: '日本語', list: japaneseFonts.sort() },
            { label: '其他', list: otherFonts.sort() },
        ];

        // NEW: 更新本地存储的键名
        const savedChinese = localStorage.getItem('lyricsFontChinese') || '';
        const savedJapanese = localStorage.getItem('lyricsFontJapanese') || '';
        const savedEnglish = localStorage.getItem('lyricsFontEnglish') || '';
        const savedBoldOriginal = localStorage.getItem('lyricsBoldOriginal') === '1';
        const savedBoldTranslation = localStorage.getItem('lyricsBoldTranslation') === '1';
        const savedOpacity = parseInt(localStorage.getItem('lyricsOpacity') || '100', 10);

        const fillSelect = (selectEl, selectedValue) => {
            selectEl.innerHTML = '<option value="">默认</option>';
            groupedFonts.forEach(group => {
                if (group.list.length === 0) return;
                const optgroup = document.createElement('optgroup');
                optgroup.label = group.label;
                group.list.forEach(name => {
                    const option = document.createElement('option');
                    option.value = name;
                    option.textContent = name;
                    if (name === selectedValue) option.selected = true;
                    optgroup.appendChild(option);
                });
                selectEl.appendChild(optgroup);
            });
        };

        // NEW: 填充新的下拉框
        fillSelect(fontChineseSelect, savedChinese);
        fillSelect(fontJapaneseSelect, savedJapanese);
        fillSelect(fontEnglishSelect, savedEnglish);

        boldOriginalToggle.checked = savedBoldOriginal;
        boldTranslationToggle.checked = savedBoldTranslation;
        applyLyricsBold(savedBoldOriginal, savedBoldTranslation);

        // 应用字体设置
        await applyLyricsFonts();

        // set range value and apply
        opacityRange.value = savedOpacity;
        applyLyricsOpacity(savedOpacity);

    } catch (err) {
        console.error('Failed to get system fonts:', err);
    }
}

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

    // Opacity range listener
    opacityRange.addEventListener('input', () => {
        const val = parseInt(opacityRange.value, 10);
        localStorage.setItem('lyricsOpacity', val.toString());
        applyLyricsOpacity(val);
    });

    populateFontSelectors();
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
    if (isSeeking) return; // 拖动时不更新
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
            // 在进入极简模式前，如果歌词模式是激活的，则先退出歌词模式
            if (lyricsDisplayMode !== 0) { // Check against the new state
                // Set mode to the last state (original) so the next toggle turns it off.
                lyricsDisplayMode = 4; 
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
    const hasTranslation = parsedLyrics.some(l => l.translation);

    // If there's no translation, just toggle between off (0) and original (4).
    if (!hasTranslation) {
        if (lyricsDisplayMode === 0) {
            lyricsDisplayMode = 4; // From off, go to original
        } else {
            lyricsDisplayMode = 0; // From original, go to off
        }
    } else {
        // If there IS a translation, cycle through all five modes.
        lyricsDisplayMode = (lyricsDisplayMode + 1) % 5;
    }

    const lyricsActive = lyricsDisplayMode !== 0;

    // This is the missing line that controls the visibility of the entire lyrics panel.
    lyricsContainer.classList.toggle('hidden', !lyricsActive);

    // Remove all mode classes before adding the new one
    document.body.classList.remove('lyrics-active', 'lyrics-mode-translation', 'lyrics-mode-bilingual', 'lyrics-mode-bilingual-reversed', 'lyrics-mode-original');

    if (lyricsActive) {
        document.body.classList.add('lyrics-active');
        switch (lyricsDisplayMode) {
            case 1: // Translation only
                document.body.classList.add('lyrics-mode-translation');
                break;
            case 2: // Bilingual (orig/trans)
                document.body.classList.add('lyrics-mode-bilingual');
                break;
            case 3: // Bilingual (trans/orig)
                document.body.classList.add('lyrics-mode-bilingual-reversed');
                break;
            case 4: // Original only
                document.body.classList.add('lyrics-mode-original');
                break;
        }
    }
    
    const settings = document.querySelector('.settings-wrapper');
    if (settings) {
        settings.classList.toggle('visually-hidden', lyricsActive);
    }
    
    // 修复：切换时立即更新歌词
    currentLyricIndex = -1;
    updateLyrics(audioPlayer.currentTime);
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
        let translationText = line.translation || null;
        const metaRegex = /(作词|作曲|编曲)/;
        if (!translationText && metaRegex.test(originalText)) {
            // Treat meta lines as translation only
            translationText = originalText;
            originalText = '';
        }
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
        if (translationText) {
            const translationSpan = document.createElement('span');
            translationSpan.className = 'translated-lyric';
            translationSpan.lang = 'zh-CN';
            translationSpan.innerHTML = wrapEnglish(translationText);
            li.appendChild(translationSpan);
        }
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


function setupLyrics(parsedLrc) {
    if (!parsedLrc || !parsedLrc.lines || parsedLrc.lines.length === 0) {
        lyricsContainer.classList.add('hidden');
        document.body.classList.remove('lyrics-active');
        document.body.classList.remove('lyrics-mode-original', 'lyrics-mode-translation', 'lyrics-mode-bilingual', 'lyrics-mode-bilingual-reversed');
        localStorage.removeItem('lyricsMode'); // Clear saved mode if no lyrics
        return;
    }
    lyricsContainer.classList.remove('hidden');
    document.body.classList.add('lyrics-active');
    
    // --- Apply saved lyrics mode ---
    const savedLyricsMode = localStorage.getItem('lyricsMode') || 'bilingual';
    setLyricsDisplayMode(savedLyricsMode);
    showLyricsModeIndicator(savedLyricsMode); // Show indicator on initial load

    // The keyboard listener is now handled globally, so it's removed from here.
}

function handleLyricsModeSwitch(event) {
    // NEW: Only run the switcher if lyrics are currently active.
    if (!document.body.classList.contains('lyrics-active')) {
        return;
    }

    // Cycle through modes: bilingual -> original -> translation -> bilingual-reversed
    if (event.key === 'l' || event.key === 'L') {
        const modes = ['bilingual', 'bilingual-reversed', 'original', 'translation'];
        const currentMode = document.body.className.match(/lyrics-mode-(\S+)/)?.[1] || 'bilingual';
        const currentIndex = modes.indexOf(currentMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        const nextMode = modes[nextIndex];
        setLyricsDisplayMode(nextMode);
        showLyricsModeIndicator(nextMode); // <-- SHOW INDICATOR ON SWITCH
    }
}

function setLyricsDisplayMode(mode) {
    // Remove all mode classes
    document.body.classList.remove('lyrics-mode-original', 'lyrics-mode-translation', 'lyrics-mode-bilingual', 'lyrics-mode-bilingual-reversed');
    // Add the new mode class
    document.body.classList.add(`lyrics-mode-${mode}`);
    // Save the new mode
    localStorage.setItem('lyricsMode', mode);
}

// === Initialization ===
document.addEventListener('DOMContentLoaded', () => {
    // All initial setup calls can go here.
    setupSettings();
});

// NEW: Add a single, global event listener for lyrics mode switching.
window.addEventListener('keydown', handleLyricsModeSwitch);

