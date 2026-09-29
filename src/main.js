const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { SessionManager } = require('./session-manager');

let mainWindow;
let tsWindow = null;
const session = new SessionManager();
let settings = {
  screenshotDir: '',
  tcOffsetMs: 0,
  layout: 'horizontal',
  ssOverlayTC: false,
  showTimeline: true,
  volume: 1.0,
  muted: false,
  showMaster: true,
  showSub: true,
};

// ===== DEFAULT SHORTCUTS =====
const DEFAULT_SHORTCUTS = {
  'open-master':      { label: 'Master動画を開く',           key: 'CmdOrCtrl+1',       category: 'ファイル' },
  'open-sub':         { label: 'Sub動画を開く',              key: 'CmdOrCtrl+2',       category: 'ファイル' },
  'ss-full':          { label: 'スクリーンショット - 全画面',  key: 'CmdOrCtrl+Shift+S', category: 'ファイル' },
  'ss-master':        { label: 'スクリーンショット - Master', key: 'CmdOrCtrl+Shift+1', category: 'ファイル' },
  'ss-sub':           { label: 'スクリーンショット - Sub',    key: 'CmdOrCtrl+Shift+2', category: 'ファイル' },
  'toggle-play':      { label: '再生/一時停止',              key: 'Space',              category: '再生' },
  'stop':             { label: '停止',                       key: 'CmdOrCtrl+.',        category: '再生' },
  'frame-forward':    { label: 'コマ送り',                   key: 'Right',              category: '再生' },
  'frame-backward':   { label: 'コマ戻し',                   key: 'Left',               category: '再生' },
  'sec-forward':      { label: '1秒送り',                    key: 'Shift+Right',        category: '再生' },
  'sec-backward':     { label: '1秒戻し',                    key: 'Shift+Left',         category: '再生' },
  'ten-sec-forward':  { label: '10秒送り',                   key: 'CmdOrCtrl+Right',    category: '再生' },
  'ten-sec-backward': { label: '10秒戻し',                   key: 'CmdOrCtrl+Left',     category: '再生' },
  'go-start':         { label: '先頭へ',                     key: 'Home',               category: '再生' },
  'go-end':           { label: '末尾へ',                     key: 'End',                category: '再生' },
  'speed-up':         { label: '速度+',                      key: 'CmdOrCtrl+=',        category: '再生' },
  'speed-down':       { label: '速度-',                      key: 'CmdOrCtrl+-',        category: '再生' },
  'speed-reset':      { label: '速度リセット',               key: 'CmdOrCtrl+0',        category: '再生' },
  'delay-plus-10':    { label: '遅延+10ms',                  key: 'CmdOrCtrl+]',        category: '音声' },
  'delay-minus-10':   { label: '遅延-10ms',                  key: 'CmdOrCtrl+[',        category: '音声' },
  'delay-plus-100':   { label: '遅延+100ms',                 key: 'CmdOrCtrl+Shift+]',  category: '音声' },
  'delay-minus-100':  { label: '遅延-100ms',                 key: 'CmdOrCtrl+Shift+[',  category: '音声' },
  'delay-reset':      { label: '遅延リセット',               key: 'CmdOrCtrl+Shift+0',  category: '音声' },
  'mute':             { label: 'ミュート',                   key: 'CmdOrCtrl+M',        category: '音声' },
  'vol-up':           { label: '音量+',                      key: 'CmdOrCtrl+Up',       category: '音声' },
  'vol-down':         { label: '音量-',                      key: 'CmdOrCtrl+Down',     category: '音声' },
  'timestamp-add':    { label: 'タイムスタンプ追加',          key: 'CmdOrCtrl+T',        category: 'タイムスタンプ' },
  'timestamp-add-ss': { label: 'タイムスタンプ+スクショ追加',  key: 'CmdOrCtrl+Shift+T',  category: 'タイムスタンプ' },
  'timestamp-popout': { label: 'ポップアウトウィンドウ',       key: 'CmdOrCtrl+P',        category: 'タイムスタンプ' },
  'swap-videos':      { label: 'Master⇄Sub入替',              key: 'CmdOrCtrl+Shift+X',  category: '表示' },
  'shortcut-settings':{ label: 'ショートカット設定',           key: 'F1',                 category: '表示' },
};

// Merged shortcuts: defaults overridden by user customizations
let shortcuts = {};

function getShortcutKey(id) {
  return shortcuts[id] || DEFAULT_SHORTCUTS[id]?.key || '';
}

function loadShortcuts() {
  shortcuts = {};
  if (settings.shortcuts) {
    shortcuts = { ...settings.shortcuts };
  }
}

function saveShortcuts() {
  settings.shortcuts = { ...shortcuts };
  saveSettings();
}

function getDefaultScreenshotDir() {
  const appDir = path.dirname(app.isPackaged ? process.execPath : __dirname);
  const ssDir = path.join(appDir, 'screenshots');
  if (!fs.existsSync(ssDir)) { try { fs.mkdirSync(ssDir, { recursive: true }); } catch(e) {} }
  return ssDir;
}
function getSettingsPath() {
  const appDir = path.dirname(app.isPackaged ? process.execPath : __dirname);
  return path.join(appDir, 'dvp-settings.json');
}
function loadSettings() {
  try {
    const p = getSettingsPath();
    if (fs.existsSync(p)) { settings = { ...settings, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  } catch(e) {}
  if (!settings.screenshotDir) settings.screenshotDir = getDefaultScreenshotDir();
  loadShortcuts();
}
function saveSettings() {
  try { fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8'); } catch(e) {}
}

// ===== FFMPEG AUTO SETUP =====
const https = require('https');
const http = require('http');
const { createWriteStream, createReadStream } = require('fs');

const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
// Fallback: BtbN GitHub release
const FFMPEG_URL_FALLBACK = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

function getFFmpegDir() {
  const appDir = path.dirname(app.isPackaged ? process.execPath : __dirname);
  return path.join(appDir, 'ffmpeg');
}

function isFFmpegInstalled() {
  const dir = getFFmpegDir();
  return fs.existsSync(path.join(dir, 'ffmpeg.exe')) && fs.existsSync(path.join(dir, 'ffprobe.exe'));
}

/**
 * Check if ffmpeg is on system PATH
 */
function isFFmpegOnPath() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Download file with redirect support, progress callback
 * Returns a Promise that resolves with the local file path
 */
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    let redirectCount = 0;

    function doRequest(reqUrl) {
      const mod = reqUrl.startsWith('https') ? https : http;
      mod.get(reqUrl, { headers: { 'User-Agent': 'DualVideoPlayer/1.0' } }, (res) => {
        // Handle redirects
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
          redirectCount++;
          if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
          res.resume();
          doRequest(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const totalSize = parseInt(res.headers['content-length'], 10) || 0;
        let downloaded = 0;

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress && totalSize > 0) {
            onProgress(Math.round((downloaded / totalSize) * 100), downloaded, totalSize);
          }
        });

        res.pipe(file);
        file.on('finish', () => { file.close(() => resolve(destPath)); });
        file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }

    doRequest(url);
  });
}

/**
 * Extract ffmpeg.exe and ffprobe.exe from zip
 * Uses Node.js built-in zlib + manual zip parsing for essential files only
 */
async function extractFFmpegFromZip(zipPath, destDir) {
  // Use PowerShell on Windows to extract (most reliable for large zips)
  // Extract to temp, then copy the needed binaries
  const tempExtractDir = path.join(path.dirname(zipPath), '_ffmpeg_extract_' + Date.now());

  return new Promise((resolve, reject) => {
    // Use PowerShell Expand-Archive
    const psCmd = `Expand-Archive -Path '${zipPath}' -DestinationPath '${tempExtractDir}' -Force`;
    execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 300000 }, (err) => {
      if (err) {
        // Fallback: try tar (available in Win10+)
        execFile('tar', ['-xf', zipPath, '-C', tempExtractDir], { timeout: 300000 }, (err2) => {
          if (err2) { reject(new Error('ZIP展開に失敗しました')); return; }
          findAndCopyBinaries(tempExtractDir, destDir, resolve, reject);
        });
        // Ensure temp dir exists for tar
        if (!fs.existsSync(tempExtractDir)) fs.mkdirSync(tempExtractDir, { recursive: true });
        return;
      }
      findAndCopyBinaries(tempExtractDir, destDir, resolve, reject);
    });
  });
}

function findAndCopyBinaries(extractDir, destDir, resolve, reject) {
  // Recursively find ffmpeg.exe and ffprobe.exe in extracted dir
  const binaries = ['ffmpeg.exe', 'ffprobe.exe'];
  const found = {};

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (binaries.includes(e.name.toLowerCase()) && !found[e.name.toLowerCase()]) {
          found[e.name.toLowerCase()] = full;
        }
      }
    } catch {}
  }

  walk(extractDir);

  if (!found['ffmpeg.exe'] || !found['ffprobe.exe']) {
    // Cleanup
    fs.rm(extractDir, { recursive: true, force: true }, () => {});
    reject(new Error('ZIPからffmpeg.exe/ffprobe.exeが見つかりません'));
    return;
  }

  // Copy to destDir
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  try {
    fs.copyFileSync(found['ffmpeg.exe'], path.join(destDir, 'ffmpeg.exe'));
    fs.copyFileSync(found['ffprobe.exe'], path.join(destDir, 'ffprobe.exe'));
  } catch (e) {
    reject(new Error(`コピー失敗: ${e.message}`));
    fs.rm(extractDir, { recursive: true, force: true }, () => {});
    return;
  }

  // Cleanup extracted dir and zip
  fs.rm(extractDir, { recursive: true, force: true }, () => {});
  resolve();
}

/**
 * Full ffmpeg setup flow
 * Returns { success, message }
 */
async function setupFFmpeg(onProgress) {
  const ffmpegDir = getFFmpegDir();
  if (isFFmpegInstalled()) return { success: true, message: 'Already installed' };

  // Check system PATH first
  const onPath = await isFFmpegOnPath();
  if (onPath) return { success: true, message: 'Found on system PATH' };

  // Download
  const tempZip = path.join(path.dirname(ffmpegDir), 'ffmpeg-download.zip');

  try {
    if (onProgress) onProgress('downloading', 0, 'ダウンロード中...');
    await downloadFile(FFMPEG_URL, tempZip, (pct, dl, total) => {
      const mb = (dl / 1024 / 1024).toFixed(1);
      const totalMb = (total / 1024 / 1024).toFixed(1);
      if (onProgress) onProgress('downloading', pct, `ダウンロード中... ${mb}MB / ${totalMb}MB`);
    });
  } catch (err) {
    // Try fallback URL
    try {
      if (onProgress) onProgress('downloading', 0, 'フォールバックURLからダウンロード中...');
      await downloadFile(FFMPEG_URL_FALLBACK, tempZip, (pct, dl, total) => {
        const mb = (dl / 1024 / 1024).toFixed(1);
        const totalMb = (total / 1024 / 1024).toFixed(1);
        if (onProgress) onProgress('downloading', pct, `ダウンロード中... ${mb}MB / ${totalMb}MB`);
      });
    } catch (err2) {
      return { success: false, message: `ダウンロード失敗: ${err2.message}` };
    }
  }

  // Extract
  try {
    if (onProgress) onProgress('extracting', 50, 'ZIPを展開中...');
    await extractFFmpegFromZip(tempZip, ffmpegDir);
  } catch (err) {
    return { success: false, message: `展開失敗: ${err.message}` };
  }

  // Cleanup zip
  try { fs.unlinkSync(tempZip); } catch {}

  if (onProgress) onProgress('done', 100, 'セットアップ完了');
  return { success: true, message: 'セットアップ完了' };
}

// ===== CODEC DETECTION & TRANSCODE =====
// Codecs natively supported by Chromium/Electron
const CHROMIUM_VIDEO_CODECS = ['h264', 'vp8', 'vp9', 'av1', 'theora'];

// Temp directory for transcoded files
function getTranscodeDir() {
  const appDir = path.dirname(app.isPackaged ? process.execPath : __dirname);
  const dir = path.join(appDir, '.transcode-cache');
  if (!fs.existsSync(dir)) try { fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
  return dir;
}

// Find ffprobe/ffmpeg binary — check bundled location, PATH, and common install paths
function findBinary(name) {
  const appDir = path.dirname(app.isPackaged ? process.execPath : __dirname);
  // Check bundled alongside exe
  const bundledPaths = [
    path.join(appDir, `${name}.exe`),
    path.join(appDir, 'ffmpeg', `${name}.exe`),
    path.join(appDir, name),
  ];
  for (const p of bundledPaths) {
    if (fs.existsSync(p)) return p;
  }
  // Fall back to system PATH
  return name;
}

/**
 * Probe video codec using ffprobe
 * Returns { videoCodec, audioCodec, needsTranscode }
 */
function probeCodec(filePath) {
  return new Promise((resolve) => {
    const ffprobe = findBinary('ffprobe');
    execFile(ffprobe, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'v:0',
      filePath,
    ], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        // ffprobe not available — assume needs transcode for non-mp4, let Electron try
        const ext = path.extname(filePath).toLowerCase();
        resolve({
          videoCodec: 'unknown',
          audioCodec: 'unknown',
          needsTranscode: ['.mov', '.mxf', '.avi'].includes(ext),
          ffprobeAvailable: false,
        });
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const vstream = data.streams?.[0];
        const codec = (vstream?.codec_name || '').toLowerCase();
        const needsTranscode = !CHROMIUM_VIDEO_CODECS.includes(codec);
        resolve({
          videoCodec: codec,
          audioCodec: '', // not needed for decision
          needsTranscode,
          ffprobeAvailable: true,
        });
      } catch {
        resolve({ videoCodec: 'unknown', needsTranscode: true, ffprobeAvailable: true });
      }
    });
  });
}

/**
 * Transcode video to H.264 MP4 using ffmpeg
 * Sends progress updates via IPC
 * Returns path to transcoded file
 */
function transcodeToH264(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const ffmpeg = findBinary('ffmpeg');
    const basename = path.basename(filePath, path.extname(filePath));
    const outPath = path.join(getTranscodeDir(), `${basename}_h264_${Date.now()}.mp4`);

    // First get duration for progress calculation
    const ffprobe = findBinary('ffprobe');
    execFile(ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', filePath
    ], { timeout: 10000 }, (err, stdout) => {
      let duration = 0;
      try {
        const fmt = JSON.parse(stdout);
        duration = parseFloat(fmt.format?.duration) || 0;
      } catch {}

      const args = [
        '-i', filePath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',          // High quality
        '-pix_fmt', 'yuv420p', // Broad compatibility
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-y',                  // Overwrite
        '-progress', 'pipe:1', // Progress to stdout
        outPath,
      ];

      const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let lastPercent = 0;

      proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          // Parse "out_time_us=12345678" for progress
          const match = line.match(/out_time_us=(\d+)/);
          if (match && duration > 0) {
            const currentSec = parseInt(match[1]) / 1000000;
            const pct = Math.min(99, Math.round((currentSec / duration) * 100));
            if (pct > lastPercent) {
              lastPercent = pct;
              if (onProgress) onProgress(pct);
            }
          }
        }
      });

      proc.stderr.on('data', () => {}); // Suppress stderr

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outPath)) {
          if (onProgress) onProgress(100);
          resolve(outPath);
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`ffmpegの起動に失敗: ${err.message}\nffmpegがインストールされているか確認してください。`));
      });
    });
  });
}

// Track active transcodes so we can cancel if needed
const activeTranscodes = new Map();

// ===== MENU BUILDER (uses dynamic shortcuts) =====
function buildMenu() {
  const k = id => getShortcutKey(id) || undefined;

  const menuTemplate = [
    { label: 'ファイル', submenu: [
      { label: 'Master動画を開く', accelerator: k('open-master'), click: () => openVideoDialog('left') },
      { label: 'Sub動画を開く', accelerator: k('open-sub'), click: () => openVideoDialog('right') },
      { type: 'separator' },
      { label: 'Master動画を取り除く', click: () => mainWindow.webContents.send('unload-video', 'left') },
      { label: 'Sub動画を取り除く', click: () => mainWindow.webContents.send('unload-video', 'right') },
      { type: 'separator' },
      { label: 'スクリーンショット - 全画面', accelerator: k('ss-full'), click: () => mainWindow.webContents.send('take-screenshot', 'full') },
      { label: 'スクリーンショット - Master', accelerator: k('ss-master'), click: () => mainWindow.webContents.send('take-screenshot', 'left') },
      { label: 'スクリーンショット - Sub', accelerator: k('ss-sub'), click: () => mainWindow.webContents.send('take-screenshot', 'right') },
      { type: 'separator' },
      { label: 'スクリーンショット保存先...', click: () => changeScreenshotDir() },
      { type: 'separator' },
      { label: 'SSにTC焼き込み', type: 'checkbox', checked: settings.ssOverlayTC, click: (mi) => {
        settings.ssOverlayTC = mi.checked;
        saveSettings();
        mainWindow.webContents.send('settings-updated', settings);
      }},
      { type: 'separator' },
      { role: 'quit', label: '終了' }
    ]},
    { label: '再生', submenu: [
      { label: '再生/一時停止', accelerator: k('toggle-play'), click: () => mainWindow.webContents.send('playback-command', 'toggle') },
      { label: '停止', accelerator: k('stop'), click: () => mainWindow.webContents.send('playback-command', 'stop') },
      { type: 'separator' },
      { label: 'コマ送り', accelerator: k('frame-forward'), click: () => mainWindow.webContents.send('playback-command', 'frame-forward') },
      { label: 'コマ戻し', accelerator: k('frame-backward'), click: () => mainWindow.webContents.send('playback-command', 'frame-backward') },
      { label: '1秒送り', accelerator: k('sec-forward'), click: () => mainWindow.webContents.send('playback-command', 'sec-forward') },
      { label: '1秒戻し', accelerator: k('sec-backward'), click: () => mainWindow.webContents.send('playback-command', 'sec-backward') },
      { label: '10秒送り', accelerator: k('ten-sec-forward'), click: () => mainWindow.webContents.send('playback-command', 'ten-sec-forward') },
      { label: '10秒戻し', accelerator: k('ten-sec-backward'), click: () => mainWindow.webContents.send('playback-command', 'ten-sec-backward') },
      { type: 'separator' },
      { label: '先頭へ', accelerator: k('go-start'), click: () => mainWindow.webContents.send('playback-command', 'go-start') },
      { label: '末尾へ', accelerator: k('go-end'), click: () => mainWindow.webContents.send('playback-command', 'go-end') },
      { type: 'separator' },
      { label: '速度+', accelerator: k('speed-up'), click: () => mainWindow.webContents.send('playback-command', 'speed-up') },
      { label: '速度-', accelerator: k('speed-down'), click: () => mainWindow.webContents.send('playback-command', 'speed-down') },
      { label: '速度リセット', accelerator: k('speed-reset'), click: () => mainWindow.webContents.send('playback-command', 'speed-reset') },
    ]},
    { label: '音声', submenu: [
      { label: '遅延+10ms', accelerator: k('delay-plus-10'), click: () => mainWindow.webContents.send('audio-delay', 10) },
      { label: '遅延-10ms', accelerator: k('delay-minus-10'), click: () => mainWindow.webContents.send('audio-delay', -10) },
      { label: '遅延+100ms', accelerator: k('delay-plus-100'), click: () => mainWindow.webContents.send('audio-delay', 100) },
      { label: '遅延-100ms', accelerator: k('delay-minus-100'), click: () => mainWindow.webContents.send('audio-delay', -100) },
      { label: '遅延リセット', accelerator: k('delay-reset'), click: () => mainWindow.webContents.send('audio-delay', 'reset') },
      { type: 'separator' },
      { label: 'ミュート', accelerator: k('mute'), click: () => mainWindow.webContents.send('mute-toggle') },
      { type: 'separator' },
      { label: '音量+', accelerator: k('vol-up'), click: () => mainWindow.webContents.send('volume-change', 0.05) },
      { label: '音量-', accelerator: k('vol-down'), click: () => mainWindow.webContents.send('volume-change', -0.05) },
    ]},
    { label: 'オフセット', submenu: [
      { label: 'Sub +1フレーム', accelerator: 'Alt+Right', click: () => mainWindow.webContents.send('vid-offset', { side: 'right', delta: 1 }) },
      { label: 'Sub -1フレーム', accelerator: 'Alt+Left', click: () => mainWindow.webContents.send('vid-offset', { side: 'right', delta: -1 }) },
      { label: 'Sub +10フレーム', accelerator: 'Alt+Shift+Right', click: () => mainWindow.webContents.send('vid-offset', { side: 'right', delta: 10 }) },
      { label: 'Sub -10フレーム', accelerator: 'Alt+Shift+Left', click: () => mainWindow.webContents.send('vid-offset', { side: 'right', delta: -10 }) },
      { type: 'separator' },
      { label: 'Subオフセットリセット', accelerator: 'Alt+0', click: () => mainWindow.webContents.send('vid-offset-reset', 'right') },
      { label: '全オフセットリセット', click: () => mainWindow.webContents.send('vid-offset-reset', 'all') },
      { type: 'separator' },
      { label: 'Subオフセット設定...', click: () => mainWindow.webContents.send('vid-offset-dialog', 'right') },
      { label: 'Masterオフセット設定...', click: () => mainWindow.webContents.send('vid-offset-dialog', 'left') },
    ]},
    { label: 'タイムスタンプ', submenu: [
      { label: 'タイムスタンプ追加', accelerator: k('timestamp-add'), click: () => mainWindow.webContents.send('timestamp-add') },
      { label: 'タイムスタンプ+スクショ追加', accelerator: k('timestamp-add-ss'), click: () => mainWindow.webContents.send('timestamp-add-ss') },
      { type: 'separator' },
      { label: 'ポップアウトウィンドウ', accelerator: k('timestamp-popout'), click: () => openTimestampWindow() },
      { type: 'separator' },
      { label: 'CSVエクスポート...', click: () => mainWindow.webContents.send('timestamp-export', 'csv') },
      { label: 'TSVエクスポート...', click: () => mainWindow.webContents.send('timestamp-export', 'tsv') },
      { label: 'クリップボードにコピー', click: () => mainWindow.webContents.send('timestamp-copy-all') },
      { type: 'separator' },
      { label: 'クリア', click: () => mainWindow.webContents.send('timestamp-clear') },
      { type: 'separator' },
      { label: 'TCオフセット設定...', click: () => mainWindow.webContents.send('tc-offset-dialog') },
    ]},
    { label: '表示', submenu: [
      { label: '横並び', type: 'radio', checked: settings.layout === 'horizontal', click: () => { settings.layout='horizontal'; saveSettings(); mainWindow.webContents.send('layout-change','horizontal'); }},
      { label: '縦並び', type: 'radio', checked: settings.layout === 'vertical', click: () => { settings.layout='vertical'; saveSettings(); mainWindow.webContents.send('layout-change','vertical'); }},
      { label: '自由配置', type: 'radio', checked: settings.layout === 'free', click: () => { settings.layout='free'; saveSettings(); mainWindow.webContents.send('layout-change','free'); }},
      { type: 'separator' },
      { label: 'Master ⇄ Sub 入替', accelerator: k('swap-videos'), click: () => mainWindow.webContents.send('swap-videos') },
      { type: 'separator' },
      { label: 'タイムライン表示', type: 'checkbox', checked: settings.showTimeline, click: (mi) => {
        settings.showTimeline = mi.checked;
        saveSettings();
        mainWindow.webContents.send('settings-updated', settings);
      }},
      { type: 'separator' },
      { label: 'Master表示', type: 'checkbox', checked: settings.showMaster, click: (mi) => {
        settings.showMaster = mi.checked;
        saveSettings();
        mainWindow.webContents.send('settings-updated', settings);
      }},
      { label: 'Sub表示', type: 'checkbox', checked: settings.showSub, click: (mi) => {
        settings.showSub = mi.checked;
        saveSettings();
        mainWindow.webContents.send('settings-updated', settings);
      }},
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'フルスクリーン' },
      { role: 'toggleDevTools', label: 'DevTools' },
      { type: 'separator' },
      { label: 'ショートカット設定...', accelerator: k('shortcut-settings'), click: () => mainWindow.webContents.send('show-shortcut-editor') },
    ]},
    { label: 'セッション', submenu: [
      { label: 'セッション開始（ホスト）', click: () => mainWindow.webContents.send('session-show-dialog', 'host') },
      { label: 'セッション参加', click: () => mainWindow.webContents.send('session-show-dialog', 'client') },
      { type: 'separator' },
      { label: 'セッション終了 / 離脱', click: () => { session.stopSession(); }, enabled: session.isInSession },
      { type: 'separator' },
      { label: 'ユーザー名設定', click: () => mainWindow.webContents.send('session-show-dialog', 'username') },
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

function createWindow() {
  loadSettings();
  mainWindow = new BrowserWindow({
    width: 1600, height: 950, minWidth: 1000, minHeight: 600,
    backgroundColor: '#0a0a14', title: 'Dual Video Player',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webSecurity: false }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  buildMenu();

  // メインウィンドウが閉じたらポップアップも閉じる + セッション終了
  mainWindow.on('closed', () => {
    if (tsWindow && !tsWindow.isDestroyed()) tsWindow.close();
    if (session.isInSession) session.stopSession();
    mainWindow = null;
  });
}

// ---- Timestamp Popup Window ----
function openTimestampWindow() {
  if (tsWindow && !tsWindow.isDestroyed()) { tsWindow.focus(); return; }

  // Position to the right of main window, not overlapping
  const mainBounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(mainBounds);
  const workArea = display.workArea;
  const tsWidth = 420;
  const tsHeight = 600;

  let tsX = mainBounds.x + mainBounds.width + 8;
  let tsY = mainBounds.y;

  // If it goes off-screen to the right, place it to the left of the main window
  if (tsX + tsWidth > workArea.x + workArea.width) {
    tsX = mainBounds.x - tsWidth - 8;
  }
  // If still off-screen (left), just place at the right edge of work area
  if (tsX < workArea.x) {
    tsX = workArea.x + workArea.width - tsWidth;
  }
  // Clamp Y
  if (tsY + tsHeight > workArea.y + workArea.height) {
    tsY = workArea.y + workArea.height - tsHeight;
  }
  if (tsY < workArea.y) tsY = workArea.y;

  tsWindow = new BrowserWindow({
    width: tsWidth, height: tsHeight, minWidth: 320, minHeight: 300,
    x: tsX, y: tsY,
    title: 'タイムスタンプ',
    backgroundColor: '#0a0a14',
    // No parent → independent window, does not stay on top of main
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  tsWindow.setMenuBarVisibility(false);
  tsWindow.loadFile(path.join(__dirname, 'timestamp-window.html'));
  tsWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('timestamp-sync-request');
  });
  tsWindow.on('closed', () => { tsWindow = null; });
}

async function openVideoDialog(side) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `動画を開く - ${side === 'left' ? 'Master' : 'Sub'}`,
    filters: [
      { name: 'Video/Audio', extensions: ['mp4', 'mov', 'wav', 'wave', 'avi', 'webm'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('load-video', { side, filePath: result.filePaths[0] });
  }
}

async function changeScreenshotDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'スクリーンショット保存先を選択', defaultPath: settings.screenshotDir, properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    settings.screenshotDir = result.filePaths[0]; saveSettings();
    mainWindow.webContents.send('settings-updated', settings);
  }
}

// ---- IPC ----
// ===== FFMPEG SETUP IPC =====
ipcMain.handle('ffmpeg-check', async () => {
  if (isFFmpegInstalled()) return { installed: true, path: getFFmpegDir() };
  const onPath = await isFFmpegOnPath();
  return { installed: onPath, path: onPath ? 'system PATH' : null };
});

ipcMain.handle('ffmpeg-setup', async () => {
  try {
    const result = await setupFFmpeg((stage, pct, message) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ffmpeg-setup-progress', { stage, percent: pct, message });
      }
    });
    return result;
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ===== TRANSCODE IPC =====
ipcMain.handle('probe-video', async (e, filePath) => {
  try {
    const result = await probeCodec(filePath);
    return result;
  } catch (err) {
    return { videoCodec: 'unknown', needsTranscode: false, error: err.message };
  }
});

ipcMain.handle('transcode-video', async (e, filePath) => {
  try {
    const transcodedPath = await transcodeToH264(filePath, (pct) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcode-progress', { filePath, percent: pct });
      }
    });
    return { success: true, path: transcodedPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('read-file-buffer', async (e, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (err) { return null; }
});
ipcMain.handle('open-video-dialog', async (e, side) => { await openVideoDialog(side); });
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('update-settings', (e, s) => { settings = { ...settings, ...s }; saveSettings(); return settings; });

ipcMain.handle('save-screenshot', async (e, { dataUrl, filename }) => {
  try {
    const dir = settings.screenshotDir || getDefaultScreenshotDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);
    clipboard.writeImage(nativeImage.createFromBuffer(buffer));
    return { success: true, path: filePath };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('export-timestamps', async (e, { content, ext }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'タイムスタンプをエクスポート',
    defaultPath: `timestamps.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { success: true, path: result.filePath };
  }
  return { success: false };
});

// ---- Shortcut settings IPC ----
ipcMain.handle('get-shortcut-defaults', () => DEFAULT_SHORTCUTS);
ipcMain.handle('get-shortcut-overrides', () => shortcuts);
ipcMain.handle('save-shortcut-overrides', (e, overrides) => {
  shortcuts = overrides;
  saveShortcuts();
  buildMenu(); // Rebuild menu with new shortcuts
  return true;
});

// Forward timestamp data to popup window
ipcMain.on('timestamp-sync-data', (e, data) => {
  if (tsWindow && !tsWindow.isDestroyed()) {
    tsWindow.webContents.send('timestamp-data', data);
  }
});

ipcMain.on('timestamp-seek', (e, seconds) => {
  mainWindow.webContents.send('timestamp-seek-to', seconds);
});

ipcMain.on('open-timestamp-popup', () => {
  openTimestampWindow();
});

ipcMain.on('timestamp-popup-add', () => {
  mainWindow.webContents.send('timestamp-add');
});
ipcMain.on('timestamp-popup-add-ss', () => {
  mainWindow.webContents.send('timestamp-add-ss');
});

ipcMain.on('timestamp-popup-delete', (e, index) => {
  mainWindow.webContents.send('timestamp-delete-from-popup', index);
});

ipcMain.on('timestamp-popup-note', (e, data) => {
  mainWindow.webContents.send('timestamp-note-from-popup', data);
});

ipcMain.on('timestamp-popup-export', (e, format) => {
  mainWindow.webContents.send('timestamp-export', format);
});

// ===== SESSION MANAGER EVENTS → Renderer =====
session.onEvent = (eventType, data) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  switch (eventType) {
    case 'session-started':
      mainWindow.webContents.send('session-status', { type: 'started', ...data });
      buildMenu(); // update menu enabled states
      break;
    case 'session-joined':
      mainWindow.webContents.send('session-status', { type: 'joined', ...data });
      buildMenu();
      break;
    case 'session-stopped':
      mainWindow.webContents.send('session-status', { type: 'stopped' });
      buildMenu();
      break;
    case 'session-disconnected':
      mainWindow.webContents.send('session-status', { type: 'disconnected', reason: data.reason });
      buildMenu();
      break;
    case 'session-error':
      mainWindow.webContents.send('session-notification', { message: data.message, level: 'error' });
      break;
    case 'user-joined':
      mainWindow.webContents.send('session-users', { users: data.users });
      mainWindow.webContents.send('session-notification', { message: `${data.userName} さんが参加しました` });
      // Request session state from renderer to send to new client
      if (session.isHost && data.ws) {
        mainWindow.webContents.send('session-state-request', { targetClientId: Date.now() });
        // Store ws temporarily for sending state
        session._pendingStateWs = data.ws;
      }
      break;
    case 'user-left':
      mainWindow.webContents.send('session-users', { users: data.users || session.users });
      mainWindow.webContents.send('session-notification', { message: `${data.userName} さんが離脱しました` });
      break;
    case 'session-state':
      // Client received session state from host
      mainWindow.webContents.send('session-state-received', data);
      break;
    case 'playback-sync':
      mainWindow.webContents.send('session-playback', data);
      break;
    case 'speed-change':
      mainWindow.webContents.send('session-speed-change', data);
      break;
    case 'session-message':
      mainWindow.webContents.send('session-timestamp', data);
      break;
    case 'file-mismatch':
      mainWindow.webContents.send('session-notification', { message: data.message || '動画ファイルが一致しません', level: 'warning' });
      break;
    case 'session-notification':
      mainWindow.webContents.send('session-notification', data);
      break;
  }
};

// ===== SESSION IPC HANDLERS =====
ipcMain.handle('session-start-host', async (e, { userName, port, password }) => {
  try {
    const result = await session.startHost(userName, port, password);
    // Save username to settings
    settings.sessionUserName = userName;
    settings.sessionPort = port;
    saveSettings();
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('session-join', async (e, { userName, host, port, password }) => {
  try {
    const result = await session.joinSession(userName, host, port, password);
    settings.sessionUserName = userName;
    settings.lastHostIP = host;
    settings.sessionPort = port;
    saveSettings();
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('session-stop', async () => {
  await session.stopSession();
  return { success: true };
});

ipcMain.handle('session-get-info', () => {
  return session.sessionInfo;
});

// Host: send session state to newly connected client
ipcMain.on('session-state-response', (e, state) => {
  if (session.isHost && session._pendingStateWs) {
    session.sendSessionState(session._pendingStateWs, state);
    session._pendingStateWs = null;
  }
});

// Host: broadcast playback sync
ipcMain.on('session-broadcast-playback', (e, { action, currentTime, direction }) => {
  session.broadcastPlayback(action, currentTime, { direction });
});

// Host: broadcast speed change
ipcMain.on('session-broadcast-speed', (e, speed) => {
  session.broadcastSpeed(speed);
});

// Host: broadcast timestamp operations
ipcMain.on('session-broadcast-timestamp', (e, { type, payload }) => {
  session.broadcastTimestamp(type, payload);
});

// Client: send timestamp to host
ipcMain.on('session-send-timestamp', (e, msg) => {
  session.sendToHost(msg);
});

// Client: send file info to host
ipcMain.on('session-send-file-info', (e, fileInfo) => {
  session.sendToHost({ type: 'file-info', payload: fileInfo });
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
