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

    // === --- Color utilities ----------------------------------------------------------

    // 将 rgb 转换为 hsl (r,g,b 0-255 -> h 0-360, s,l 0-1)
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

    // 将 hsl 转换为 rgb (h 0-360, s,l 0-1) -> {r,g,b}
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

    // 获取图片平均颜色及亮度信息
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
                const luminance = (r + g + b) / 3; // 简化亮度
                resolve({ r, g, b, luminance });
            };
            img.onerror = () => resolve(null);
            img.src = url;
        });
    }

    // 应用自适应颜色方案
    function applyAdaptiveColors({ text, bgAlpha = 0.2 }) {
        const root = document.documentElement.style;
        root.setProperty('--adaptive-text-color', text);
        root.setProperty('--adaptive-progress-fill', text);
        // 解析 text rgb
        const m = text.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
            const r = m[1], g = m[2], b = m[3];
            root.setProperty('--adaptive-progress-bg', `rgba(${r},${g},${b},${bgAlpha})`);
        } else {
            // fallback
            root.setProperty('--adaptive-progress-bg', 'rgba(255,255,255,0.2)');
        }
    }

    function resetToDefault() {
        applyAdaptiveColors({ text: '#f0f0f0' });
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

                    // 检测封面平均色并应用自适应主题
                    analyzeImage(artworkUrl).then((info) => {
                        if (!info) return resetToDefault();
                        const { r, g, b, luminance } = info;
                        if (luminance < 150) {
                            // 深色封面 -> 使用白色方案
                            resetToDefault();
                        } else {
                            const { h, s, l } = rgbToHsl(r, g, b);
                            if (s < 0.15) {
                                // 低饱和度：用统一深灰色
                                applyAdaptiveColors({ text: '#222222bf' });
                            } else {
                                // 生成稍深一档颜色
                                const newL = Math.max(0, l - 0.35);
                                const { r: dr, g: dg, b: db } = hslToRgb(h, s, newL);
                                const textColor = `rgb(${dr},${dg},${db})`;
                                applyAdaptiveColors({ text: textColor });
                            }
                        }
                    });

                } else {
                    // Handle no artwork
                    backgroundBlur.style.backgroundImage = 'none';
                    distortedBg.style.backgroundImage = 'none';
                    backgroundBlur.classList.remove('active');
                    albumArt.src = '';
                    albumArt.style.display = 'none';
                    resetToDefault(); // 无封面恢复
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
                // Toggle fullscreen using the browser Fullscreen API for wider compatibility
                if (!document.fullscreenElement) {
                    try {
                        await document.documentElement.requestFullscreen();
                    } catch (e) {
                        console.error('Failed to enter fullscreen:', e);
                    }
                } else {
                    try {
                        await document.exitFullscreen();
                    } catch (e) {
                        console.error('Failed to exit fullscreen:', e);
                    }
                }
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
