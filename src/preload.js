const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openVideoDialog: (side) => ipcRenderer.invoke('open-video-dialog', side),
  saveScreenshot: (data) => ipcRenderer.invoke('save-screenshot', data),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (s) => ipcRenderer.invoke('update-settings', s),
  exportTimestamps: (data) => ipcRenderer.invoke('export-timestamps', data),
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),

  // Shortcut settings
  getShortcutDefaults: () => ipcRenderer.invoke('get-shortcut-defaults'),
  getShortcutOverrides: () => ipcRenderer.invoke('get-shortcut-overrides'),
  saveShortcutOverrides: (o) => ipcRenderer.invoke('save-shortcut-overrides', o),

  // Main -> Renderer
  onLoadVideo: (cb) => ipcRenderer.on('load-video', (e, d) => cb(d)),
  onPlaybackCommand: (cb) => ipcRenderer.on('playback-command', (e, cmd) => cb(cmd)),
  onAudioDelay: (cb) => ipcRenderer.on('audio-delay', (e, d) => cb(d)),
  onMuteToggle: (cb) => ipcRenderer.on('mute-toggle', () => cb()),
  onVolumeChange: (cb) => ipcRenderer.on('volume-change', (e, delta) => cb(delta)),
  onTakeScreenshot: (cb) => ipcRenderer.on('take-screenshot', (e, t) => cb(t)),
  onShowShortcutEditor: (cb) => ipcRenderer.on('show-shortcut-editor', () => cb()),
  onSettingsUpdated: (cb) => ipcRenderer.on('settings-updated', (e, s) => cb(s)),
  onTimestampAdd: (cb) => ipcRenderer.on('timestamp-add', () => cb()),
  onTimestampAddSS: (cb) => ipcRenderer.on('timestamp-add-ss', () => cb()),
  onTimestampCopyAll: (cb) => ipcRenderer.on('timestamp-copy-all', () => cb()),
  onTimestampClear: (cb) => ipcRenderer.on('timestamp-clear', () => cb()),
  onTimestampExport: (cb) => ipcRenderer.on('timestamp-export', (e, fmt) => cb(fmt)),
  onTimestampSyncRequest: (cb) => ipcRenderer.on('timestamp-sync-request', () => cb()),
  onTimestampSeekTo: (cb) => ipcRenderer.on('timestamp-seek-to', (e, s) => cb(s)),
  onTimestampDeleteFromPopup: (cb) => ipcRenderer.on('timestamp-delete-from-popup', (e, idx) => cb(idx)),
  onTimestampNoteFromPopup: (cb) => ipcRenderer.on('timestamp-note-from-popup', (e, d) => cb(d)),
  onTcOffsetDialog: (cb) => ipcRenderer.on('tc-offset-dialog', () => cb()),
  onVidOffset: (cb) => ipcRenderer.on('vid-offset', (e, d) => cb(d)),
  onVidOffsetReset: (cb) => ipcRenderer.on('vid-offset-reset', (e, side) => cb(side)),
  onVidOffsetDialog: (cb) => ipcRenderer.on('vid-offset-dialog', (e, side) => cb(side)),
  onSwapVideos: (cb) => ipcRenderer.on('swap-videos', () => cb()),
  onUnloadVideo: (cb) => ipcRenderer.on('unload-video', (e, side) => cb(side)),
  onLayoutChange: (cb) => ipcRenderer.on('layout-change', (e, l) => cb(l)),

  // Renderer -> Main (for popup sync)
  sendTimestampSync: (data) => ipcRenderer.send('timestamp-sync-data', data),

  // Popup window specific
  onTimestampData: (cb) => ipcRenderer.on('timestamp-data', (e, d) => cb(d)),
  sendTimestampSeek: (seconds) => ipcRenderer.send('timestamp-seek', seconds),
  sendTimestampPopupAdd: () => ipcRenderer.send('timestamp-popup-add'),
  sendTimestampPopupAddSS: () => ipcRenderer.send('timestamp-popup-add-ss'),
  sendTimestampDelete: (index) => ipcRenderer.send('timestamp-popup-delete', index),
  sendTimestampNoteUpdate: (data) => ipcRenderer.send('timestamp-popup-note', data),
  sendTimestampExportFromPopup: (format) => ipcRenderer.send('timestamp-popup-export', format),
  openTimestampPopup: () => ipcRenderer.send('open-timestamp-popup'),

  // ===== FFMPEG SETUP =====
  ffmpegCheck: () => ipcRenderer.invoke('ffmpeg-check'),
  ffmpegSetup: () => ipcRenderer.invoke('ffmpeg-setup'),
  onFFmpegSetupProgress: (cb) => ipcRenderer.on('ffmpeg-setup-progress', (e, d) => cb(d)),

  // ===== TRANSCODE =====
  probeVideo: (filePath) => ipcRenderer.invoke('probe-video', filePath),
  transcodeVideo: (filePath) => ipcRenderer.invoke('transcode-video', filePath),
  onTranscodeProgress: (cb) => ipcRenderer.on('transcode-progress', (e, d) => cb(d)),

  // ===== SESSION =====
  sessionStartHost: (opts) => ipcRenderer.invoke('session-start-host', opts),
  sessionJoin: (opts) => ipcRenderer.invoke('session-join', opts),
  sessionStop: () => ipcRenderer.invoke('session-stop'),
  sessionGetInfo: () => ipcRenderer.invoke('session-get-info'),

  // Session: Main → Renderer
  onSessionShowDialog: (cb) => ipcRenderer.on('session-show-dialog', (e, mode) => cb(mode)),
  onSessionStatus: (cb) => ipcRenderer.on('session-status', (e, d) => cb(d)),
  onSessionUsers: (cb) => ipcRenderer.on('session-users', (e, d) => cb(d)),
  onSessionNotification: (cb) => ipcRenderer.on('session-notification', (e, d) => cb(d)),
  onSessionStateRequest: (cb) => ipcRenderer.on('session-state-request', (e, d) => cb(d)),
  onSessionStateReceived: (cb) => ipcRenderer.on('session-state-received', (e, d) => cb(d)),
  onSessionPlayback: (cb) => ipcRenderer.on('session-playback', (e, d) => cb(d)),
  onSessionSpeedChange: (cb) => ipcRenderer.on('session-speed-change', (e, d) => cb(d)),
  onSessionTimestamp: (cb) => ipcRenderer.on('session-timestamp', (e, d) => cb(d)),

  // Session: Renderer → Main
  sendSessionStateResponse: (state) => ipcRenderer.send('session-state-response', state),
  sendSessionBroadcastPlayback: (d) => ipcRenderer.send('session-broadcast-playback', d),
  sendSessionBroadcastSpeed: (speed) => ipcRenderer.send('session-broadcast-speed', speed),
  sendSessionBroadcastTimestamp: (d) => ipcRenderer.send('session-broadcast-timestamp', d),
  sendSessionTimestamp: (msg) => ipcRenderer.send('session-send-timestamp', msg),
  sendSessionFileInfo: (info) => ipcRenderer.send('session-send-file-info', info),
});
