(function () {
  'use strict';

  // ===== STATE =====
  const S = {
    playing: false,
    speed: 1.0,
    fps: { left: 30, right: 30 },
    loaded: { left: false, right: false },
    muted: false,
    audioSource: 'master', // 'master' or 'sub'
    audioDelay: 0,         // ms
    audioCtx: null,
    audioNodes: { left: null, right: null }, // { source, delay, gain }
    tcOffsetFrames: 0,     // offset in total frames at master fps
    tcOffsetStr: '00:00:00:00',
    videoOffset: { left: 0, right: 0 }, // per-side time offset in seconds
    timestamps: [],        // [ { tc, seconds, note, thumbnail } ]
    settings: {},
    masterFilePath: '',
    subFilePath: '',
  };

  // ===== DOM =====
  const $ = id => document.getElementById(id);
  const el = {
    vidL: $('vidL'), vidR: $('vidR'),
    wrapL: $('wrapL'), wrapR: $('wrapR'),
    fnameL: $('fnameL'), fnameR: $('fnameR'),
    delayBadge: $('delayBadge'),
    tlBar: $('tlBar'), tlCanvas: $('tlCanvas'),
    tlRuler: $('tlRuler'), tlRulerCanvas: $('tlRulerCanvas'),
    tlPlayhead: $('tlPlayhead'),
    panelL: $('panelLeft'), panelR: $('panelRight'),
    splitter: $('videoSplitter'),
    seekBar: $('seekBar'), seekFill: $('seekFill'),
    tTime: $('tTime'), tDur: $('tDur'),
    btnPlay: $('btnPlay'), btnStop: $('btnStop'), btnFB: $('btnFB'), btnFF: $('btnFF'),
    speedBadge: $('speedBadge'), topStatus: $('topStatus'),
    audioSrc: $('audioSrc'), volSlider: $('volSlider'), volLabel: $('volLabel'),
    infoFps: $('infoFps'), infoRes: $('infoRes'), infoDelay: $('infoDelay'), infoSsDir: $('infoSsDir'),
    scEditorModal: $('shortcutEditorModal'), scTableBody: $('scTableBody'),
    tcOffsetModal: $('tcOffsetModal'), tcOffsetInput: $('tcOffsetInput'),
    vidOffsetL: $('vidOffsetL'), vidOffsetR: $('vidOffsetR'),
    vidOffsetModal: $('vidOffsetModal'), vidOffsetSideLabel: $('vidOffsetSideLabel'),
    vidOffsetInput: $('vidOffsetInput'),
    tsPanel: $('tsPanel'), tsList: $('tsList'),
    toast: $('toast'), btnTS: $('btnTS'),
  };

  // ===== HELPERS =====
  function toast(msg, dur = 2000) {
    el.toast.textContent = msg;
    el.toast.classList.add('vis');
    setTimeout(() => el.toast.classList.remove('vis'), dur);
  }

  function toSMPTE(seconds, fps, offsetFrames = 0) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    fps = Math.round(fps) || 30;
    let totalFrames = Math.floor(seconds * fps) + offsetFrames;
    if (totalFrames < 0) totalFrames = 0;
    const f = totalFrames % fps;
    const s = Math.floor(totalFrames / fps) % 60;
    const m = Math.floor(totalFrames / fps / 60) % 60;
    const h = Math.floor(totalFrames / fps / 3600);
    return [h, m, s, f].map(v => String(v).padStart(2, '0')).join(':');
  }

  function parseSMPTE(str, fps) {
    fps = Math.round(fps) || 30;
    const parts = str.split(':').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return 0;
    return parts[0] * 3600 * fps + parts[1] * 60 * fps + parts[2] * fps + parts[3];
  }

  // ===== FPS DETECTION =====
  function detectFPS(video) {
    return new Promise(resolve => {
      if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) { resolve(30); return; }
      let count = 0, startMT = null;
      const origTime = video.currentTime;
      const wasMuted = video.muted;
      video.muted = true;
      video.currentTime = 0;

      function onFrame(now, meta) {
        if (startMT === null) startMT = meta.mediaTime;
        count++;
        if (count >= 12) {
          const elapsed = meta.mediaTime - startMT;
          const raw = elapsed > 0 ? (count - 1) / elapsed : 30;
          const stds = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
          let best = 30, minD = Infinity;
          for (const s of stds) { const d = Math.abs(raw - s); if (d < minD) { minD = d; best = s; } }
          video.pause(); video.currentTime = origTime; video.muted = wasMuted;
          resolve(best); return;
        }
        video.requestVideoFrameCallback(onFrame);
      }
      video.play().then(() => video.requestVideoFrameCallback(onFrame)).catch(() => resolve(30));
      setTimeout(() => resolve(30), 4000);
    });
  }

  // ===== AUDIO SETUP =====
  function initAudioCtx() {
    if (S.audioCtx) return;
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  // Track which video elements already have a MediaElementSource
  const _mediaSourceMap = new WeakMap();

  function connectAudio(side) {
    initAudioCtx();
    const video = side === 'left' ? el.vidL : el.vidR;

    // Disconnect old nodes (but keep source reference in WeakMap)
    if (S.audioNodes[side]) {
      try { S.audioNodes[side].source.disconnect(); } catch(e) {}
      S.audioNodes[side] = null;
    }

    // createMediaElementSource can only be called ONCE per element.
    // Reuse existing source if already created for this video element.
    let source = _mediaSourceMap.get(video);
    if (!source) {
      source = S.audioCtx.createMediaElementSource(video);
      _mediaSourceMap.set(video, source);
    }

    const delay = S.audioCtx.createDelay(5);
    delay.delayTime.value = Math.max(0, S.audioDelay / 1000);
    const gain = S.audioCtx.createGain();

    source.connect(delay);
    delay.connect(gain);
    gain.connect(S.audioCtx.destination);

    S.audioNodes[side] = { source, delay, gain };
    updateAudioRouting();
  }

  function updateAudioRouting() {
    // Master = left, Sub = right
    const active = S.audioSource === 'master' ? 'left' : 'right';
    const inactive = active === 'left' ? 'right' : 'left';
    if (S.audioNodes[active]) S.audioNodes[active].gain.gain.value = S.muted ? 0 : parseFloat(el.volSlider.value);
    if (S.audioNodes[inactive]) S.audioNodes[inactive].gain.gain.value = 0;
  }

  // ===== TIMELINE RULER =====
  function drawTimeRuler() {
    const canvas = el.tlRulerCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#12161e';
    ctx.fillRect(0, 0, w, h);

    const dur = S.loaded.left ? el.vidL.duration : 0;
    if (!dur) return;

    let majorSec;
    if (dur < 30) majorSec = 5;
    else if (dur < 120) majorSec = 10;
    else if (dur < 600) majorSec = 30;
    else if (dur < 1800) majorSec = 60;
    else majorSec = 300;
    const minorSec = majorSec / 5;

    ctx.textBaseline = 'bottom';
    ctx.font = `${Math.max(8, 9 * dpr)}px Consolas, monospace`;

    ctx.strokeStyle = 'rgba(90,100,120,0.3)';
    ctx.lineWidth = 1;
    for (let t = 0; t <= dur; t += minorSec) {
      const x = (t / dur) * w;
      ctx.beginPath(); ctx.moveTo(x, h * 0.6); ctx.lineTo(x, h); ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(140,150,170,0.5)';
    ctx.fillStyle = '#8a92a4';
    for (let t = 0; t <= dur; t += majorSec) {
      const x = (t / dur) * w;
      ctx.beginPath(); ctx.moveTo(x, h * 0.2); ctx.lineTo(x, h); ctx.stroke();
      const totalS = Math.floor(t);
      const hh = Math.floor(totalS / 3600);
      const mm = Math.floor((totalS % 3600) / 60);
      const ss = totalS % 60;
      let label;
      if (dur >= 3600) label = `${hh}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
      else if (dur >= 60) label = `${mm}:${String(ss).padStart(2,'0')}`;
      else label = `${ss}s`;
      ctx.fillText(label, x + 3 * dpr, h - 1 * dpr);
    }

    ctx.strokeStyle = 'rgba(90,100,120,0.4)';
    ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
  }

  // ===== TIMELINE BAR (background + played region) =====
  // Use a throttled approach: skip redraws if called too frequently
  let _tlLastPx = -1;
  function drawTimelineBar() {
    const dur = S.loaded.left ? el.vidL.duration : 0;
    if (!dur) return;

    const canvas = el.tlCanvas;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const w = Math.floor(cw * dpr);
    const h = Math.floor(ch * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      _tlLastPx = -1;
    }

    const progress = el.vidL.currentTime / dur;
    const px = Math.floor(progress * w);
    if (px === _tlLastPx) return; // skip if no visual change
    _tlLastPx = px;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0e1118';
    ctx.fillRect(0, 0, w, h);
    if (px > 0) {
      ctx.fillStyle = 'rgba(91,138,245,0.10)';
      ctx.fillRect(0, 0, px, h);
    }
  }

  // ===== TIMELINE MARKERS (DOM-based, clickable) =====
  let _markerEls = [];
  function renderTimelineMarkers() {
    // Remove old markers
    for (const m of _markerEls) m.remove();
    _markerEls = [];

    if (!S.loaded.left || !el.vidL.duration) return;
    const dur = el.vidL.duration;

    for (let i = 0; i < S.timestamps.length; i++) {
      const ts = S.timestamps[i];
      const pct = (ts.seconds / dur) * 100;
      const marker = document.createElement('div');
      marker.className = 'tl-marker';
      marker.style.left = `${pct}%`;
      marker.title = `${ts.tc}${ts.note ? ' — ' + ts.note : ''}`;
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        seekAbs(ts.seconds / dur);
        toast(`ジャンプ: ${ts.tc}`);
      });
      el.tlBar.appendChild(marker);
      _markerEls.push(marker);
    }
  }

  function updatePlayhead() {
    if (!S.loaded.left || !el.vidL.duration) return;
    const pct = (el.vidL.currentTime / el.vidL.duration) * 100;
    el.tlPlayhead.style.left = `${pct}%`;
  }

  // ===== VIDEO LOADING =====
  // Track original file paths (before transcode) for display
  const _originalPaths = { left: '', right: '' };
  // Track transcoded paths for cleanup
  const _transcodedPaths = { left: '', right: '' };

  async function loadVideo(side, filePath) {
    const video = side === 'left' ? el.vidL : el.vidR;
    const wrapper = side === 'left' ? el.wrapL : el.wrapR;
    const fnameEl = side === 'left' ? el.fnameL : el.fnameR;
    const filename = filePath.split(/[\\/]/).pop();

    _originalPaths[side] = filePath;

    // Disconnect existing audio node BEFORE changing src (prevents dangling MediaElementSource)
    if (S.audioNodes[side]) {
      try { S.audioNodes[side].source.disconnect(); } catch(e) {}
      S.audioNodes[side] = null;
    }

    // Show loading state
    fnameEl.textContent = `${filename} (読込中...)`;
    fnameEl.title = filePath;

    // Probe codec to check if transcode is needed
    let actualPath = filePath;
    try {
      const probe = await window.electronAPI.probeVideo(filePath);
      if (probe.needsTranscode) {
        const codecLabel = probe.videoCodec || '不明';
        fnameEl.textContent = `${filename} (${codecLabel} → H.264 変換中...)`;
        toast(`${filename}: ${codecLabel}コーデック検出 — H.264に変換中...`, 5000);

        // Show transcode progress overlay
        showTranscodeOverlay(side, filename);

        const result = await window.electronAPI.transcodeVideo(filePath);
        hideTranscodeOverlay(side);

        if (result.success) {
          actualPath = result.path;
          _transcodedPaths[side] = result.path;
          toast(`${filename}: 変換完了`, 2000);
        } else {
          hideTranscodeOverlay(side);
          toast(`変換失敗: ${result.error}`, 5000);
          fnameEl.textContent = `${filename} (変換失敗)`;
          return;
        }
      } else if (!probe.ffprobeAvailable) {
        // ffprobe not found — try loading directly, may fail for ProRes etc.
        // No action needed, will try direct load
      }
    } catch (err) {
      // Probe failed — try loading directly
    }

    // Cache-busting: use fragment hash (not query param) to avoid tainted canvas on file:// URLs
    video.src = `file://${actualPath}#_t=${Date.now()}`;
    video.load();
    fnameEl.textContent = filename;

    video.onloadedmetadata = async () => {
      wrapper.classList.add('has-video');
      S.loaded[side] = true;
      S.fps[side] = await detectFPS(video);
      video.currentTime = 0;
      video.pause();

      connectAudio(side);
      updateStatusBar();

      if (side === 'left') {
        S.masterFilePath = filePath; // Keep original path for display/session
        drawTimeRuler();
        renderTimelineMarkers();
      } else {
        S.subFilePath = filePath;
      }

      toast(`${filename} (${S.fps[side]}fps)`);
      if (!S.playing) { el.vidL.pause(); el.vidR.pause(); }
    };
    video.onerror = () => {
      hideTranscodeOverlay(side);
      toast(`読込エラー: ${filename}`, 3000);
      fnameEl.textContent = `${filename} (読込エラー)`;
    };
  }

  // Transcode progress overlay
  function showTranscodeOverlay(side, filename) {
    const wrapper = side === 'left' ? el.wrapL : el.wrapR;
    let overlay = wrapper.querySelector('.transcode-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'transcode-overlay';
      overlay.innerHTML = `
        <div class="transcode-info">
          <div class="transcode-title">コーデック変換中</div>
          <div class="transcode-file"></div>
          <div class="transcode-bar-bg"><div class="transcode-bar-fill"></div></div>
          <div class="transcode-pct">0%</div>
        </div>`;
      wrapper.appendChild(overlay);
    }
    overlay.querySelector('.transcode-file').textContent = filename;
    overlay.querySelector('.transcode-bar-fill').style.width = '0%';
    overlay.querySelector('.transcode-pct').textContent = '0%';
    overlay.style.display = 'flex';
  }

  function hideTranscodeOverlay(side) {
    const wrapper = side === 'left' ? el.wrapL : el.wrapR;
    const overlay = wrapper.querySelector('.transcode-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  // Listen for transcode progress from main process
  window.electronAPI.onTranscodeProgress((data) => {
    // Update progress for matching side
    for (const side of ['left', 'right']) {
      const wrapper = side === 'left' ? el.wrapL : el.wrapR;
      const overlay = wrapper.querySelector('.transcode-overlay');
      if (overlay && overlay.style.display !== 'none') {
        overlay.querySelector('.transcode-bar-fill').style.width = `${data.percent}%`;
        overlay.querySelector('.transcode-pct').textContent = `${data.percent}%`;
      }
    }
  });

  function unloadVideo(side) {
    const video = side === 'left' ? el.vidL : el.vidR;
    const wrapper = side === 'left' ? el.wrapL : el.wrapR;
    const fnameEl = side === 'left' ? el.fnameL : el.fnameR;

    if (S.playing) { el.vidL.pause(); el.vidR.pause(); S.playing = false; el.btnPlay.innerHTML = '&#9654;'; el.btnPlay.classList.remove('active'); }

    // Disconnect audio
    if (S.audioNodes[side]) {
      try { S.audioNodes[side].source.disconnect(); } catch(e) {}
      S.audioNodes[side] = null;
    }

    video.src = '';
    video.load();
    wrapper.classList.remove('has-video');
    S.loaded[side] = false;
    fnameEl.textContent = 'ファイル未読込';
    fnameEl.title = '';

    if (side === 'left') {
      S.masterFilePath = '';
      drawTimeRuler();
      renderTimelineMarkers();
    } else {
      S.subFilePath = '';
    }

    updateStatusBar();
    toast(`${side === 'left' ? 'Master' : 'Sub'} 動画を取り除きました`);
  }

  function updateStatusBar() {
    el.infoFps.textContent = `FPS: ${S.fps.left}${S.loaded.right ? ' / ' + S.fps.right : ''}`;
    if (S.loaded.left && el.vidL.videoWidth) {
      el.infoRes.textContent = `解像度: ${el.vidL.videoWidth}x${el.vidL.videoHeight}`;
    }
    el.infoSsDir.textContent = `SS: ${S.settings.screenshotDir || '--'}`;
  }

  // ===== SWAP MASTER / SUB =====
  function swapMasterSub() {
    // Save current state
    const wasPlaying = S.playing;
    const timeL = S.loaded.left ? el.vidL.currentTime : 0;
    const timeR = S.loaded.right ? el.vidR.currentTime : 0;
    const pathL = S.masterFilePath;
    const pathR = S.subFilePath;
    const fpsL = S.fps.left;
    const fpsR = S.fps.right;
    const loadedL = S.loaded.left;
    const loadedR = S.loaded.right;

    // Pause during swap
    if (wasPlaying) { el.vidL.pause(); el.vidR.pause(); S.playing = false; }

    // Disconnect existing audio nodes
    ['left', 'right'].forEach(side => {
      if (S.audioNodes[side]) {
        try { S.audioNodes[side].source.disconnect(); } catch(e) {}
        S.audioNodes[side] = null;
      }
    });

    // Swap video sources (with cache-busting via fragment hash)
    const swapTs = Date.now();
    if (loadedL) {
      el.vidR.src = `file://${pathL}#_t=${swapTs}`;
      el.vidR.load();
      S.subFilePath = pathL;
      el.fnameR.textContent = pathL.split(/[\\/]/).pop();
      el.fnameR.title = pathL;
    } else {
      el.vidR.src = '';
      S.subFilePath = '';
      el.fnameR.textContent = 'ファイル未読込';
      el.wrapR.classList.remove('has-video');
    }

    if (loadedR) {
      el.vidL.src = `file://${pathR}#_t=${swapTs}`;
      el.vidL.load();
      S.masterFilePath = pathR;
      el.fnameL.textContent = pathR.split(/[\\/]/).pop();
      el.fnameL.title = pathR;
    } else {
      el.vidL.src = '';
      S.masterFilePath = '';
      el.fnameL.textContent = 'ファイル未読込';
      el.wrapL.classList.remove('has-video');
    }

    // Swap loaded state, FPS, and video offsets
    S.loaded.left = loadedR;
    S.loaded.right = loadedL;
    S.fps.left = fpsR;
    S.fps.right = fpsL;
    const tmpOffset = S.videoOffset.left;
    S.videoOffset.left = S.videoOffset.right;
    S.videoOffset.right = tmpOffset;
    updateOffsetBadge('left');
    updateOffsetBadge('right');

    // Restore playback positions and reconnect audio after metadata loads
    const restoreSide = (video, wrapper, side, wasLoaded, restoreTime) => {
      if (!wasLoaded) return;
      video.onloadedmetadata = () => {
        wrapper.classList.add('has-video');
        video.currentTime = restoreTime;
        video.pause();
        connectAudio(side);
        if (wasPlaying) {
          video.play();
        }
      };
    };

    restoreSide(el.vidL, el.wrapL, 'left', loadedR, timeR);
    restoreSide(el.vidR, el.wrapR, 'right', loadedL, timeL);

    // Resume playing state
    if (wasPlaying && (S.loaded.left || S.loaded.right)) {
      S.playing = true;
      el.btnPlay.innerHTML = '&#10074;&#10074;';
      el.btnPlay.classList.add('active');
    }

    // Redraw timeline for new master
    drawTimeRuler();
    renderTimelineMarkers();

    updateStatusBar();
    toast('Master ⇄ Sub 入れ替え');
  }

  // ===== TIMECODE LOOP =====
  let tcInputMode = false; // true while user is editing TC in the transport bar
  let _tcLastTime = -1;    // cache to skip redundant DOM writes
  let _tcLastDurStr = '';   // cache duration string (rarely changes)
  const _seekHandle = $('seekHandle'); // cache DOM reference

  function tcLoop() {
    const mFps = S.fps.left;
    const offset = S.tcOffsetFrames;

    const vid = S.loaded.left ? el.vidL : (S.loaded.right ? el.vidR : null);
    const fps = S.loaded.left ? mFps : S.fps.right;
    if (vid) {
      const curTime = vid.currentTime;
      const dur = vid.duration;

      // Only update DOM when time actually changed (big win on frame step)
      const curFrame = Math.floor(curTime * (Math.round(fps) || 30));
      if (curFrame !== _tcLastTime) {
        _tcLastTime = curFrame;

        if (!tcInputMode) {
          el.tTime.textContent = toSMPTE(curTime, fps, offset);
        }

        if (dur) {
          const pct = (curTime / dur) * 100;
          el.seekFill.style.width = `${pct}%`;
          _seekHandle.style.left = `${pct}%`;
        }

        updatePlayhead();
        drawTimelineBar();
      }

      // Duration string — only update when it changes (load / swap)
      const durStr = `/ ${toSMPTE(dur, fps, 0)}`;
      if (durStr !== _tcLastDurStr) {
        _tcLastDurStr = durStr;
        el.tDur.textContent = durStr;
      }
    }

    requestAnimationFrame(tcLoop);
  }
  requestAnimationFrame(tcLoop);

  // ===== PLAYBACK =====
  let _toggleLock = false;
  function togglePlay() {
    if (_toggleLock) return; // prevent key-repeat rapid toggling
    _toggleLock = true;
    setTimeout(() => { _toggleLock = false; }, 150);

    if (!S.loaded.left && !S.loaded.right) return;
    if (S.audioCtx && S.audioCtx.state === 'suspended') S.audioCtx.resume();

    // Client cannot control playback
    if (sessionState.role === 'client') return;

    if (S.playing) {
      if (S.loaded.left) el.vidL.pause();
      if (S.loaded.right) el.vidR.pause();
      S.playing = false;
      el.btnPlay.innerHTML = '&#9654;';
      el.btnPlay.classList.remove('active');
      // Broadcast pause
      if (sessionState.role === 'host') {
        window.electronAPI.sendSessionBroadcastPlayback({ action: 'pause', currentTime: el.vidL.currentTime || 0 });
      }
    } else {
      if (S.loaded.left) el.vidL.play();
      if (S.loaded.right) el.vidR.play();
      S.playing = true;
      el.btnPlay.innerHTML = '&#10074;&#10074;';
      el.btnPlay.classList.add('active');
      // Broadcast play
      if (sessionState.role === 'host') {
        window.electronAPI.sendSessionBroadcastPlayback({ action: 'play', currentTime: el.vidL.currentTime || 0 });
      }
    }
  }

  function stop() {
    if (sessionState.role === 'client') return;
    if (S.loaded.left) { el.vidL.pause(); el.vidL.currentTime = 0; }
    if (S.loaded.right) { el.vidR.pause(); el.vidR.currentTime = Math.max(0, getOffsetDelta()); }
    S.playing = false;
    el.btnPlay.innerHTML = '&#9654;';
    el.btnPlay.classList.remove('active');
    if (sessionState.role === 'host') {
      window.electronAPI.sendSessionBroadcastPlayback({ action: 'seek', currentTime: 0 });
    }
  }

  // Frame step with queuing: accumulate rapid key presses, apply after seek completes
  let _framePending = 0;
  let _frameSeeking = false;

  function frameStep(dir) {
    if (sessionState.role === 'client') return;
    if (S.playing) togglePlay();
    if (_frameSeeking) {
      _framePending += dir;
      return;
    }
    _applyFrameStep(dir);
  }

  function _applyFrameStep(dir) {
    if (!S.loaded.left && !S.loaded.right) return;
    _frameSeeking = true;
    _framePending = 0;

    const hasBoth = S.loaded.left && S.loaded.right;
    const primary = S.loaded.left ? el.vidL : el.vidR;
    const primaryFps = S.loaded.left ? S.fps.left : S.fps.right;

    // Step primary video
    primary.currentTime = Math.max(0, primary.currentTime + dir / primaryFps);

    const finishStep = () => {
      _frameSeeking = false;
      // Broadcast frame position
      if (sessionState.role === 'host') {
        window.electronAPI.sendSessionBroadcastPlayback({ action: 'frame-step', currentTime: primary.currentTime, direction: dir });
      }
      if (_framePending !== 0) {
        const pending = _framePending;
        _framePending = 0;
        _applyFrameStep(pending);
      }
    };

    const onPrimarySeeked = () => {
      primary.removeEventListener('seeked', onPrimarySeeked);
      // After primary finishes, seek secondary with offset
      if (hasBoth) {
        const secondary = S.loaded.left ? el.vidR : el.vidL;
        if (S.loaded.left) {
          // Sub follows master + offset
          secondary.currentTime = Math.max(0, subTargetTime());
        } else {
          const secFps = S.fps.left;
          secondary.currentTime = Math.max(0, secondary.currentTime + dir / secFps);
        }
      }
      finishStep();
    };

    primary.addEventListener('seeked', onPrimarySeeked);
    setTimeout(() => {
      if (_frameSeeking) {
        primary.removeEventListener('seeked', onPrimarySeeked);
        if (hasBoth) {
          const secondary = S.loaded.left ? el.vidR : el.vidL;
          if (S.loaded.left) {
            secondary.currentTime = Math.max(0, subTargetTime());
          } else {
            const secFps = S.fps.left;
            secondary.currentTime = Math.max(0, secondary.currentTime + dir / secFps);
          }
        }
        finishStep();
      }
    }, 200);
  }

  function seekRel(sec) {
    if (sessionState.role === 'client') return;
    if (S.loaded.left) el.vidL.currentTime = Math.max(0, Math.min(el.vidL.duration, el.vidL.currentTime + sec));
    if (S.loaded.right) {
      const target = S.loaded.left ? subTargetTime() : Math.max(0, Math.min(el.vidR.duration, el.vidR.currentTime + sec));
      el.vidR.currentTime = target;
    }
    if (sessionState.role === 'host') {
      window.electronAPI.sendSessionBroadcastPlayback({ action: 'seek', currentTime: el.vidL.currentTime || el.vidR.currentTime || 0 });
    }
  }

  function seekAbs(frac) {
    if (sessionState.role === 'client') return;
    if (S.loaded.left) el.vidL.currentTime = el.vidL.duration * frac;
    if (S.loaded.right) {
      if (S.loaded.left) {
        // Sub follows master position + offset
        el.vidR.currentTime = Math.max(0, Math.min(el.vidR.duration, el.vidL.currentTime + getOffsetDelta()));
      } else {
        el.vidR.currentTime = el.vidR.duration * frac;
      }
    }
    if (sessionState.role === 'host') {
      window.electronAPI.sendSessionBroadcastPlayback({ action: 'seek', currentTime: el.vidL.currentTime || el.vidR.currentTime || 0 });
    }
  }

  function setSpeed(spd) {
    if (sessionState.role === 'client') return;
    S.speed = Math.max(0.25, Math.min(4, spd));
    if (S.loaded.left) el.vidL.playbackRate = S.speed;
    if (S.loaded.right) el.vidR.playbackRate = S.speed;
    el.speedBadge.textContent = `${S.speed.toFixed(2)}x`;
    if (sessionState.role === 'host') {
      window.electronAPI.sendSessionBroadcastSpeed(S.speed);
    }
  }

  // ===== AUDIO DELAY =====
  function adjustDelay(delta) {
    if (delta === 'reset') S.audioDelay = 0;
    else S.audioDelay += delta;
    ['left', 'right'].forEach(side => {
      if (S.audioNodes[side]) S.audioNodes[side].delay.delayTime.value = Math.max(0, S.audioDelay / 1000);
    });
    el.infoDelay.textContent = `音声遅延: ${S.audioDelay}ms`;
    // Sync delay input field
    const di = $('delayInput');
    if (di) di.value = S.audioDelay;
    if (S.audioDelay !== 0) {
      el.delayBadge.textContent = `Delay: ${S.audioDelay}ms`;
      el.delayBadge.classList.add('vis');
    } else {
      el.delayBadge.classList.remove('vis');
    }
    toast(`音声遅延: ${S.audioDelay}ms`);
  }

  // ===== SCREENSHOTS (auto-save + clipboard) =====
  function burnTCOverlay(canvas, tcText) {
    const ctx = canvas.getContext('2d');
    const h = canvas.height;
    const fontSize = Math.max(16, Math.round(h * 0.04));
    const padding = Math.round(fontSize * 0.6);
    const margin = Math.round(fontSize * 0.5);

    ctx.font = `bold ${fontSize}px Consolas, 'SF Mono', monospace`;
    const metrics = ctx.measureText(tcText);
    const boxW = metrics.width + padding * 2;
    const boxH = fontSize + padding * 1.2;

    // Top-left corner
    const bx = margin;
    const by = margin;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 4);
    ctx.fill();

    ctx.fillStyle = '#00e6a0';
    ctx.textBaseline = 'middle';
    ctx.fillText(tcText, bx + padding, by + boxH / 2);
  }

  async function takeScreenshot(target) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let canvas, filename;

    const mFps = S.fps.left;
    const offset = S.tcOffsetFrames;

    if (target === 'full') {
      const videos = [];
      if (S.loaded.left) videos.push(el.vidL);
      if (S.loaded.right) videos.push(el.vidR);
      if (!videos.length) { toast('動画が読み込まれていません'); return; }

      // Normalize both videos to the same height, scaling width proportionally
      const targetH = Math.max(...videos.map(v => v.videoHeight));
      const rects = videos.map(v => {
        const scale = targetH / v.videoHeight;
        return { w: Math.round(v.videoWidth * scale), h: targetH };
      });
      const totalW = rects.reduce((s, r) => s + r.w, 0);

      canvas = document.createElement('canvas');
      canvas.width = totalW; canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, totalW, targetH);
      let ox = 0;
      for (let i = 0; i < videos.length; i++) {
        ctx.drawImage(videos[i], ox, 0, rects[i].w, rects[i].h);
        ox += rects[i].w;
      }
      if (S.settings.ssOverlayTC && S.loaded.left) {
        const tc = toSMPTE(el.vidL.currentTime, mFps, offset);
        burnTCOverlay(canvas, tc);
      }
      filename = `SS_Full_${ts}.png`;
    } else {
      const video = target === 'left' ? el.vidL : el.vidR;
      if (!S.loaded[target]) { toast('動画が読み込まれていません'); return; }
      canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      // TC overlay burn-in
      if (S.settings.ssOverlayTC) {
        const fps = target === 'left' ? mFps : S.fps.right;
        const tc = toSMPTE(video.currentTime, fps, offset);
        burnTCOverlay(canvas, tc);
      }
      filename = `SS_${target === 'left' ? 'Master' : 'Sub'}_${ts}.png`;
    }

    const dataUrl = canvas.toDataURL('image/png');
    const result = await window.electronAPI.saveScreenshot({ dataUrl, filename });
    if (result.success) {
      toast(`保存+クリップボード: ${filename}${S.settings.ssOverlayTC ? ' (TC付)' : ''}`);
    } else {
      toast(`保存エラー: ${result.error}`, 3000);
    }
  }

  // ===== TIMESTAMPS =====
  function captureThumbnail() {
    if (!S.loaded.left) return null;
    const c = document.createElement('canvas');
    const scale = 120 / el.vidL.videoWidth;
    c.width = 120; c.height = Math.round(el.vidL.videoHeight * scale);
    c.getContext('2d').drawImage(el.vidL, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  }

  function sortTimestamps() {
    S.timestamps.sort((a, b) => a.seconds - b.seconds);
  }

  function ensureTimestampMetadata(ts) {
    const validId = /^y[0-9a-f]{7}$/;
    if (!validId.test(ts.id) && !validId.test(ts.exportId)) {
      let id;
      do {
        id = 'y' + (crypto.getRandomValues(new Uint32Array(1))[0] & 0x0fffffff).toString(16).padStart(7, '0');
      } while (S.timestamps.some(item => item.id === id || item.exportId === id));
      if (ts.id) ts.exportId = id;
      else ts.id = id;
    }
    ts.author ??= ts.by ?? '';
    ts.createdAt ??= ts.created_at ?? '';
    ts.updatedAt ??= ts.updated_at ?? '';
    ts.native ??= false;
    ts.deleted ??= false;
    return ts;
  }

  function updateTimestampNote(ts, note, updatedAt) {
    if (ts.note === note) return;
    ts.note = note;
    ts.updatedAt = updatedAt ?? Date.now();
  }

  function timestampDate(value) {
    if (value === '' || value == null) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function timestampCsvRow(ts) {
    ensureTimestampMetadata(ts);
    const milliseconds = Math.round(ts.seconds * 1000);
    const seconds = Math.floor(milliseconds / 1000);
    const fraction = milliseconds % 1000;
    const timecode = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, '0')).join(':')
      + (fraction ? '.' + String(fraction).padStart(3, '0').replace(/0+$/, '') : '');
    return [
      /^y[0-9a-f]{7}$/.test(ts.id) ? ts.id : ts.exportId,
      timecode, milliseconds / 1000, ts.author, ts.note ?? '', ts.native,
      ts.channel ?? '', ts.stream_id ?? '', ts.started_at ?? '',
      timestampDate(ts.createdAt), timestampDate(ts.updatedAt), ts.deleted, ts.clock_skew_ms ?? '',
    ].map(value => {
      const text = String(value ?? '');
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }).join(',');
  }

  async function addTimestamp(withSS = false) {
    if (!S.loaded.left) { toast('Master動画を読み込んでください'); return; }
    const tc = toSMPTE(el.vidL.currentTime, S.fps.left, S.tcOffsetFrames);
    const sec = el.vidL.currentTime;
    const thumbnail = withSS ? captureThumbnail() : null;
    const now = Date.now();
    S.timestamps.push(ensureTimestampMetadata({
      tc, seconds: sec, note: '', thumbnail,
      author: (sessionState.role ? sessionState.userName : '') || S.settings.sessionUserName || '',
      createdAt: now, updatedAt: now,
    }));
    sortTimestamps();
    renderTimestamps();
    syncTimestampsToPopup();

    // withSS: save full-size screenshot to file + clipboard (same as takeScreenshot)
    if (withSS && S.loaded.left) {
      try {
        const tsStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const ssCanvas = document.createElement('canvas');
        ssCanvas.width = el.vidL.videoWidth;
        ssCanvas.height = el.vidL.videoHeight;
        ssCanvas.getContext('2d').drawImage(el.vidL, 0, 0);
        burnTCOverlay(ssCanvas, tc);
        const filename = `TS_${tc.replace(/:/g, '-')}_${tsStr}.png`;
        const dataUrl = ssCanvas.toDataURL('image/png');
        if (!dataUrl || dataUrl === 'data:,') {
          toast(`TS追加: ${tc} (SS: canvas取得失敗)`, 3000);
        } else {
          const result = await window.electronAPI.saveScreenshot({ dataUrl, filename });
          if (result.success) {
            toast(`TS+SS保存+クリップボード: ${tc}`);
          } else {
            toast(`TS追加 (SS保存エラー: ${result.error})`, 3000);
          }
        }
      } catch (ssErr) {
        console.error('TS+SS error:', ssErr);
        toast(`TS追加: ${tc} (SS: ${ssErr.message})`, 3000);
      }
    } else {
      toast(`TS追加: ${tc}`);
    }
  }

  function deleteTimestamp(index) {
    if (index >= 0 && index < S.timestamps.length) {
      S.timestamps.splice(index, 1);
      renderTimestamps();
      syncTimestampsToPopup();
    }
  }

  function renderTimestamps() {
    el.tsList.innerHTML = '';
    S.timestamps.forEach((ts, i) => {
      const div = document.createElement('div');
      div.className = 'ts-item';
      const thumbHtml = ts.thumbnail
        ? `<img class="ts-thumb" src="${ts.thumbnail}" alt="">`
        : `<div class="ts-thumb-empty">--</div>`;
      div.innerHTML = `
        ${thumbHtml}
        <span class="ts-tc">${ts.tc}</span>
        <input class="ts-note" placeholder="メモ...">
        <button class="ts-del" title="削除">&times;</button>
      `;
      div.querySelector('.ts-tc').addEventListener('click', () => {
        if (el.vidL.duration) seekAbs(ts.seconds / el.vidL.duration);
        toast(`シーク: ${ts.tc}`);
      });
      if (ts.thumbnail) {
        div.querySelector('.ts-thumb').addEventListener('click', () => {
          if (el.vidL.duration) seekAbs(ts.seconds / el.vidL.duration);
        });
      }
      div.querySelector('.ts-note').value = ts.note || '';
      div.querySelector('.ts-note').addEventListener('change', (e) => {
        updateTimestampNote(S.timestamps[i], e.target.value);
        syncTimestampsToPopup();
      });
      div.querySelector('.ts-del').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTimestamp(i);
      });
      el.tsList.appendChild(div);
    });
    renderTimelineMarkers();
  }

  function syncTimestampsToPopup() {
    window.electronAPI.sendTimestampSync(S.timestamps);
  }

  function copyAllTimestamps() {
    if (!S.timestamps.length) { toast('タイムスタンプがありません'); return; }
    // Build plain text and HTML version
    const textLines = S.timestamps.map(ts => `${ts.tc}${ts.note ? '\t' + ts.note : ''}`);
    const plainText = textLines.join('\n');

    // Try to write HTML with thumbnails to clipboard
    try {
      let html = '<table style="border-collapse:collapse;font-family:monospace;font-size:12px;">';
      html += '<tr><th>SS</th><th>Timecode</th><th>Seconds</th><th>Note</th></tr>';
      for (const ts of S.timestamps) {
        html += '<tr>';
        if (ts.thumbnail) {
          html += `<td><img src="${ts.thumbnail}" width="80" height="45" style="object-fit:cover;"></td>`;
        } else {
          html += '<td>--</td>';
        }
        html += `<td>${ts.tc}</td><td>${ts.seconds.toFixed(3)}</td><td>${ts.note || ''}</td>`;
        html += '</tr>';
      }
      html += '</table>';

      const blob = new Blob([html], { type: 'text/html' });
      const textBlob = new Blob([plainText], { type: 'text/plain' });
      navigator.clipboard.write([
        new ClipboardItem({ 'text/html': blob, 'text/plain': textBlob })
      ]).then(() => toast('タイムスタンプをコピー (HTML+テキスト)'));
    } catch (e) {
      // Fallback to plain text
      navigator.clipboard.writeText(plainText).then(() => toast('タイムスタンプをコピーしました'));
    }
  }

  async function exportTimestamps(format) {
    if (!S.timestamps.length) { toast('タイムスタンプがありません'); return; }
    let content;
    if (format === 'csv') {
      if (S.timestamps.some(ts => !Number.isFinite(ts.seconds) || ts.seconds < 0
        || !Number.isSafeInteger(Math.round(ts.seconds * 1000)))) {
        toast('時刻が無効なタイムスタンプがあるため、CSVを出力できません');
        return;
      }
      content = ['id,timecode,offset_sec,by,memo,native,channel,stream_id,started_at,created_at,updated_at,deleted,clock_skew_ms',
        ...S.timestamps.map(timestampCsvRow)].join('\r\n');
    } else {
      const sep = '\t';
      const header = ['Timecode', 'Seconds', 'Note', 'Has Screenshot', 'Thumbnail (Base64)'].join(sep);
      const rows = S.timestamps.map(ts => {
        const note = '"' + (ts.note || '').replace(/"/g, '""') + '"';
        const hasSS = ts.thumbnail ? 'Yes' : 'No';
        const thumbData = ts.thumbnail ? '"' + ts.thumbnail + '"' : '""';
        return [ts.tc, ts.seconds.toFixed(3), note, hasSS, thumbData].join(sep);
      });
      content = [header, ...rows].join('\n');
    }
    const result = await window.electronAPI.exportTimestamps({ content, ext: format });
    if (result.success) toast(`エクスポート完了: ${result.path}`);
  }

  // ===== SYNC (with per-video time offset) =====
  // Sub video target = master.currentTime + offsetDelta
  // offsetDelta = S.videoOffset.right - S.videoOffset.left
  function getOffsetDelta() {
    return S.videoOffset.right - S.videoOffset.left;
  }

  function subTargetTime() {
    const t = el.vidL.currentTime + getOffsetDelta();
    return Math.max(0, Math.min(t, el.vidR.duration || Infinity));
  }

  function syncVideos() {
    if (!S.loaded.left || !S.loaded.right) return;
    const target = subTargetTime();
    const drift = Math.abs(el.vidR.currentTime - target);
    if (drift > 0.05) el.vidR.currentTime = target;
  }
  setInterval(() => { if (S.playing) syncVideos(); }, 500);
  el.vidL.addEventListener('seeked', () => {
    if (S.loaded.right) el.vidR.currentTime = subTargetTime();
  });

  // ===== VIDEO TIME OFFSET =====
  function setVideoOffset(side, seconds) {
    S.videoOffset[side] = seconds;
    updateOffsetBadge(side);
    // Re-sync sub to master with new offset
    if (S.loaded.left && S.loaded.right && !S.playing) {
      el.vidR.currentTime = subTargetTime();
    }
  }

  function adjustVideoOffset(side, deltaSec) {
    setVideoOffset(side, S.videoOffset[side] + deltaSec);
  }

  function updateOffsetBadge(side) {
    const badge = side === 'left' ? el.vidOffsetL : el.vidOffsetR;
    if (!badge) return;
    const sec = S.videoOffset[side];
    if (Math.abs(sec) < 0.001) {
      badge.classList.remove('vis');
    } else {
      const sign = sec >= 0 ? '+' : '';
      // Show in frames if we have fps
      const fps = side === 'left' ? S.fps.left : S.fps.right;
      const frames = Math.round(sec * fps);
      badge.textContent = `Offset: ${sign}${frames}f (${sign}${sec.toFixed(3)}s)`;
      badge.classList.add('vis');
    }
  }

  function openVideoOffsetModal(side) {
    const label = side === 'left' ? 'Master' : 'Sub';
    el.vidOffsetSideLabel.textContent = label;
    el.vidOffsetInput.dataset.side = side;
    // Show current offset in frames
    const fps = side === 'left' ? S.fps.left : S.fps.right;
    const frames = Math.round(S.videoOffset[side] * fps);
    el.vidOffsetInput.value = frames;
    el.vidOffsetModal.classList.add('vis');
    el.vidOffsetInput.select();
  }

  // ===== DRAG & DROP + CONTEXT MENU =====
  function setupDrop(wrapper) {
    const side = wrapper.dataset.side;
    wrapper.addEventListener('dragover', e => { e.preventDefault(); wrapper.classList.add('drag-over'); });
    wrapper.addEventListener('dragleave', e => { e.preventDefault(); wrapper.classList.remove('drag-over'); });
    wrapper.addEventListener('drop', e => {
      e.preventDefault(); wrapper.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) { const ext = f.name.split('.').pop().toLowerCase();
        if (['mp4','mov','wav','wave','avi','webm'].includes(ext)) loadVideo(side, f.path);
        else toast(`非対応形式: .${ext}`);
      }
    });
    wrapper.addEventListener('dblclick', () => window.electronAPI.openVideoDialog(side));

    // Right-click context menu
    wrapper.addEventListener('contextmenu', e => {
      e.preventDefault();
      // Remove any existing context menu
      const old = document.querySelector('.ctx-menu');
      if (old) old.remove();

      const label = side === 'left' ? 'Master' : 'Sub';
      const menu = document.createElement('div');
      menu.className = 'ctx-menu';
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;

      const items = [];
      items.push({ text: `${label}動画を開く...`, action: () => window.electronAPI.openVideoDialog(side) });
      if (S.loaded[side]) {
        items.push({ text: `${label}動画を取り除く`, action: () => unloadVideo(side) });
        items.push({ sep: true });
        items.push({ text: `スクリーンショット - ${label}`, action: () => takeScreenshot(side === 'left' ? 'left' : 'right') });
        items.push({ sep: true });
        items.push({ text: `タイムオフセット設定...`, action: () => openVideoOffsetModal(side) });
        const fps = side === 'left' ? S.fps.left : S.fps.right;
        items.push({ text: `+1フレーム オフセット`, action: () => { adjustVideoOffset(side, 1 / fps); toast(`${label} オフセット: ${Math.round(S.videoOffset[side] * fps)}f`); } });
        items.push({ text: `-1フレーム オフセット`, action: () => { adjustVideoOffset(side, -1 / fps); toast(`${label} オフセット: ${Math.round(S.videoOffset[side] * fps)}f`); } });
        if (Math.abs(S.videoOffset[side]) > 0.001) {
          items.push({ text: `オフセットをリセット`, action: () => { setVideoOffset(side, 0); toast(`${label} オフセットをリセット`); } });
        }
      }

      for (const item of items) {
        if (item.sep) {
          const sep = document.createElement('div');
          sep.className = 'ctx-sep';
          menu.appendChild(sep);
        } else {
          const row = document.createElement('div');
          row.className = 'ctx-item';
          row.textContent = item.text;
          row.addEventListener('click', () => { menu.remove(); item.action(); });
          menu.appendChild(row);
        }
      }

      document.body.appendChild(menu);

      // Close on click outside
      const closeMenu = (ev) => {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', closeMenu, true); }
      };
      setTimeout(() => document.addEventListener('mousedown', closeMenu, true), 0);
    });
  }
  setupDrop(el.wrapL);
  setupDrop(el.wrapR);

  // ===== SEEK BAR (drag + hover preview with cached thumbnails) =====
  {
    let seekDragging = false;
    const tooltip = $('seekTooltip');
    const seekTC = $('seekTC');
    const seekThumb = $('seekThumb');
    const seekHoverLine = $('seekHoverLine');
    const thumbCtx = seekThumb.getContext('2d');

    // Hidden video element for thumbnail generation
    const thumbVid = document.createElement('video');
    thumbVid.preload = 'auto';
    thumbVid.muted = true;
    let thumbReady = false;
    let thumbSeeking = false;
    let thumbLastFile = '';

    // === Thumbnail cache: quantize time to ~1s intervals ===
    const thumbCache = new Map(); // key: quantized time (sec) → ImageData
    const THUMB_QUANTUM = 1; // cache granularity in seconds
    const MAX_CACHE = 300;   // max cached thumbnails

    function quantizeTime(t) { return Math.round(t / THUMB_QUANTUM) * THUMB_QUANTUM; }

    function updateThumbSrc() {
      if (S.loaded.left && S.masterFilePath) {
        // Always reload on file change (cache-bust handles overwrite case)
        thumbVid.src = `file://${S.masterFilePath}#_t=${Date.now()}`;
        thumbVid.load();
        thumbReady = true;
        thumbLastFile = S.masterFilePath;
        thumbCache.clear();
      }
    }

    // Throttled thumbnail request — only one seek at a time
    let pendingThumbTime = null;

    function requestThumb(time) {
      if (!thumbReady || !thumbVid.duration) return;
      const qt = quantizeTime(time);

      // Check cache first
      const cached = thumbCache.get(qt);
      if (cached) {
        thumbCtx.putImageData(cached, 0, 0);
        return;
      }

      // If already seeking, queue the latest request
      if (thumbSeeking) {
        pendingThumbTime = time;
        return;
      }

      thumbSeeking = true;
      thumbVid.currentTime = Math.max(0, Math.min(qt, thumbVid.duration - 0.1));
    }

    thumbVid.addEventListener('seeked', () => {
      try {
        thumbCtx.drawImage(thumbVid, 0, 0, 160, 90);
        // Cache the result
        const qt = quantizeTime(thumbVid.currentTime);
        if (thumbCache.size >= MAX_CACHE) {
          // Remove oldest entry
          const first = thumbCache.keys().next().value;
          thumbCache.delete(first);
        }
        thumbCache.set(qt, thumbCtx.getImageData(0, 0, 160, 90));
      } catch (e) {}

      thumbSeeking = false;

      // Process queued request
      if (pendingThumbTime !== null) {
        const t = pendingThumbTime;
        pendingThumbTime = null;
        requestThumb(t);
      }
    });

    function getSeekRatio(e) {
      const rect = el.seekBar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    }

    el.seekBar.addEventListener('mousedown', e => {
      seekDragging = true;
      seekAbs(getSeekRatio(e));
      document.body.style.cursor = 'pointer';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
      if (seekDragging) seekAbs(getSeekRatio(e));
    });

    document.addEventListener('mouseup', () => {
      if (seekDragging) {
        seekDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });

    // Hover: show tooltip with TC and cached thumbnail
    let hoverRAF = null;
    el.seekBar.addEventListener('mousemove', e => {
      if (seekDragging) return;
      // Throttle via rAF
      if (hoverRAF) return;
      hoverRAF = requestAnimationFrame(() => {
        hoverRAF = null;
        const rect = el.seekBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const vid = S.loaded.left ? el.vidL : (S.loaded.right ? el.vidR : null);
        if (!vid || !vid.duration) { tooltip.classList.remove('vis'); return; }

        const time = ratio * vid.duration;
        const fps = S.loaded.left ? S.fps.left : S.fps.right;
        const offset = S.tcOffsetFrames || 0;
        seekTC.textContent = toSMPTE(time, fps, offset);

        // Position tooltip (clamp to bar edges)
        const xPx = e.clientX - rect.left;
        const tooltipW = 168;
        let leftPos = xPx;
        if (leftPos - tooltipW / 2 < 0) leftPos = tooltipW / 2;
        if (leftPos + tooltipW / 2 > rect.width) leftPos = rect.width - tooltipW / 2;
        tooltip.style.left = `${leftPos}px`;
        tooltip.classList.add('vis');
        seekHoverLine.style.left = `${xPx}px`;

        requestThumb(time);
      });
    });

    el.seekBar.addEventListener('mouseleave', () => {
      if (!seekDragging) tooltip.classList.remove('vis');
    });

    // Watch for master file changes
    setInterval(() => {
      if (S.masterFilePath && S.masterFilePath !== thumbLastFile) updateThumbSrc();
    }, 1000);
  }

  // ===== WAVEFORM CLICK TO SEEK =====
  el.tlBar.addEventListener('click', e => {
    if (!S.loaded.left || !el.vidL.duration) return;
    const rect = el.tlBar.getBoundingClientRect();
    seekAbs(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  });

  // ===== TRANSPORT BUTTONS =====
  el.btnPlay.addEventListener('click', togglePlay);
  el.btnStop.addEventListener('click', stop);
  el.btnFB.addEventListener('click', () => frameStep(-1));
  el.btnFF.addEventListener('click', () => frameStep(1));
  $('btnSwap').addEventListener('click', (e) => { e.stopPropagation(); swapMasterSub(); });

  // ===== AUDIO CONTROLS =====
  el.audioSrc.addEventListener('change', () => {
    S.audioSource = el.audioSrc.value;
    updateAudioRouting();
    toast(`音声ソース: ${S.audioSource === 'master' ? 'Master' : 'Sub'}`);
  });

  function setVolume(val, persist = false) {
    val = Math.max(0, Math.min(1, val));
    el.volSlider.value = val;
    el.volLabel.textContent = Math.round(val * 100);
    updateAudioRouting();
    if (persist && typeof saveVolume === 'function') saveVolume();
  }

  function updateMuteUI() {
    const btn = $('btnMute');
    if (S.muted) {
      btn.innerHTML = '&#128264;'; // muted icon
      btn.classList.add('muted');
    } else {
      btn.innerHTML = '&#128266;'; // speaker icon
      btn.classList.remove('muted');
    }
  }

  function toggleMute() {
    S.muted = !S.muted;
    updateAudioRouting();
    updateMuteUI();
    toast(S.muted ? 'ミュート' : 'ミュート解除');
    if (typeof saveVolume === 'function') saveVolume();
  }

  el.volSlider.addEventListener('input', () => {
    el.volLabel.textContent = Math.round(el.volSlider.value * 100);
    updateAudioRouting();
  });
  el.volSlider.addEventListener('change', () => {
    if (typeof saveVolume === 'function') saveVolume();
  });

  // Volume wheel on slider
  el.volSlider.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    setVolume(parseFloat(el.volSlider.value) + delta, true);
  }, { passive: false });

  // Mute button
  $('btnMute').addEventListener('click', toggleMute);

  // Delay input
  const delayInput = $('delayInput');
  delayInput.addEventListener('change', () => {
    const val = parseInt(delayInput.value, 10) || 0;
    S.audioDelay = val;
    ['left', 'right'].forEach(side => {
      if (S.audioNodes[side]) S.audioNodes[side].delay.delayTime.value = Math.max(0, S.audioDelay / 1000);
    });
    el.infoDelay.textContent = `音声遅延: ${S.audioDelay}ms`;
    if (S.audioDelay !== 0) {
      el.delayBadge.textContent = `Delay: ${S.audioDelay}ms`;
      el.delayBadge.classList.add('vis');
    } else {
      el.delayBadge.classList.remove('vis');
    }
    toast(`音声遅延: ${S.audioDelay}ms`);
  });
  delayInput.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // prevent shortcut conflicts while typing
  });

  // ===== TRANSPORT TC: CLICK TO COPY, DBLCLICK TO INPUT JUMP =====
  let tTimeClickTimer = null;

  el.tTime.addEventListener('click', (e) => {
    // Single click = copy TC. Use timer to distinguish from dblclick.
    if (tTimeClickTimer) return; // dblclick in progress
    tTimeClickTimer = setTimeout(() => {
      tTimeClickTimer = null;
      const tc = el.tTime.textContent;
      navigator.clipboard.writeText(tc).then(() => {
        el.tTime.classList.add('copied');
        toast(`コピー: ${tc}`);
        setTimeout(() => el.tTime.classList.remove('copied'), 800);
      });
    }, 250);
  });

  el.tTime.addEventListener('dblclick', (e) => {
    // Cancel pending single-click
    if (tTimeClickTimer) { clearTimeout(tTimeClickTimer); tTimeClickTimer = null; }
    // Enter TC input mode
    const currentTC = el.tTime.textContent;
    tcInputMode = true;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 't-time-input';
    input.value = currentTC;
    input.setAttribute('spellcheck', 'false');

    el.tTime.style.display = 'none';
    el.tTime.parentNode.insertBefore(input, el.tTime.nextSibling);
    input.focus();
    input.select();

    function commitInput() {
      const val = input.value.trim();
      tcInputMode = false;
      input.remove();
      el.tTime.style.display = '';

      // Parse the entered TC
      const fps = S.loaded.left ? S.fps.left : S.fps.right;
      const totalFrames = parseSMPTE(val, fps);
      if (totalFrames > 0 || val === '00:00:00:00') {
        // Convert frames back to seconds (subtract offset)
        const targetFrames = totalFrames - S.tcOffsetFrames;
        const targetSec = Math.max(0, targetFrames / (Math.round(fps) || 30));
        const vid = S.loaded.left ? el.vidL : el.vidR;
        if (vid && vid.duration) {
          const frac = Math.min(1, targetSec / vid.duration);
          seekAbs(frac);
          toast(`ジャンプ: ${val}`);
        }
      } else {
        toast('無効なTC形式 (HH:MM:SS:FF)');
      }
    }

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commitInput(); }
      if (ev.key === 'Escape') {
        tcInputMode = false;
        input.remove();
        el.tTime.style.display = '';
      }
      ev.stopPropagation(); // Don't trigger shortcuts while typing
    });
    input.addEventListener('blur', () => {
      if (tcInputMode) commitInput();
    });
  });

  // Duration: single click to copy
  el.tDur.addEventListener('click', () => {
    const dur = el.tDur.textContent.replace('/ ', '');
    navigator.clipboard.writeText(dur).then(() => {
      el.tDur.classList.add('copied');
      toast(`総尺コピー: ${dur}`);
      setTimeout(() => el.tDur.classList.remove('copied'), 800);
    });
  });

  // ===== TIMESTAMP PANEL =====
  function toggleTsPanel(forceOpen) {
    if (forceOpen !== undefined) {
      el.tsPanel.classList.toggle('open', forceOpen);
    } else {
      el.tsPanel.classList.toggle('open');
    }
    // Update TC offset input when panel opens
    if (el.tsPanel.classList.contains('open')) {
      $('tsOffsetInput').value = S.tcOffsetStr;
    }
    // After CSS transition, redraw timeline
    setTimeout(() => { drawTimeRuler(); drawTimelineBar(); }, 180);
  }
  el.btnTS.addEventListener('click', () => toggleTsPanel());
  $('tsClose').addEventListener('click', () => toggleTsPanel(false));
  $('tsPopout').addEventListener('click', () => {
    window.electronAPI.openTimestampPopup();
    toggleTsPanel(false);
  });
  $('tsAdd').addEventListener('click', () => addTimestamp(false));
  $('tsAddSS').addEventListener('click', () => addTimestamp(true));
  $('tsCopy').addEventListener('click', copyAllTimestamps);
  $('tsExportCSV').addEventListener('click', () => exportTimestamps('csv'));
  $('tsExportTSV').addEventListener('click', () => exportTimestamps('tsv'));

  // ===== SHORTCUT EDITOR =====
  let scDefaults = {};
  let scOverrides = {};
  let scRecordingId = null;

  // Convert keyboard event to Electron accelerator string
  function keyEventToAccelerator(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('CmdOrCtrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');

    const keyMap = {
      ' ': 'Space', 'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
      'Delete': 'Delete', 'Backspace': 'Backspace', 'Enter': 'Return', 'Tab': 'Tab',
      'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
      'F1':'F1','F2':'F2','F3':'F3','F4':'F4','F5':'F5','F6':'F6',
      'F7':'F7','F8':'F8','F9':'F9','F10':'F10','F11':'F11','F12':'F12',
      '[': '[', ']': ']', '=': '=', '-': '-', '.': '.', ',': ',',
      '/': '/', '\\': '\\', "'": "'", ';': ';', '`': '`',
    };

    const key = e.key;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null; // modifier-only
    if (key === 'Escape') return 'CANCEL';

    const mapped = keyMap[key] || (key.length === 1 ? key.toUpperCase() : key);
    parts.push(mapped);
    return parts.join('+');
  }

  // Format accelerator for display
  function accelDisplay(accel) {
    if (!accel) return '(なし)';
    return accel
      .replace('CmdOrCtrl', 'Ctrl')
      .replace('Shift', 'Shift')
      .replace('Return', 'Enter');
  }

  async function openShortcutEditor() {
    scDefaults = await window.electronAPI.getShortcutDefaults();
    scOverrides = await window.electronAPI.getShortcutOverrides();
    scRecordingId = null;
    renderShortcutTable();
    el.scEditorModal.classList.add('vis');
  }

  function renderShortcutTable() {
    el.scTableBody.innerHTML = '';
    let lastCat = '';

    for (const [id, def] of Object.entries(scDefaults)) {
      // Category header
      if (def.category !== lastCat) {
        lastCat = def.category;
        const catRow = document.createElement('tr');
        catRow.className = 'cat-row';
        catRow.innerHTML = `<td colspan="3">${def.category}</td>`;
        el.scTableBody.appendChild(catRow);
      }

      const currentKey = scOverrides[id] || def.key;
      const isModified = scOverrides[id] && scOverrides[id] !== def.key;
      const isRecording = scRecordingId === id;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${def.label}</td>
        <td class="sc-key-cell">
          <button class="sc-key-btn ${isRecording ? 'recording' : ''} ${isModified ? 'modified' : ''}"
                  data-id="${id}">
            ${isRecording ? 'キーを押してください...' : accelDisplay(currentKey)}
          </button>
        </td>
        <td>
          ${isModified ? `<button class="sc-reset-btn" data-id="${id}" title="デフォルトに戻す">リセット</button>` : ''}
        </td>
      `;

      // Key button click → start recording
      tr.querySelector('.sc-key-btn').addEventListener('click', () => {
        scRecordingId = id;
        renderShortcutTable();
      });

      // Reset button
      const resetBtn = tr.querySelector('.sc-reset-btn');
      if (resetBtn) {
        resetBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          delete scOverrides[id];
          renderShortcutTable();
        });
      }

      el.scTableBody.appendChild(tr);
    }
  }

  // Global keydown for recording shortcuts
  document.addEventListener('keydown', (e) => {
    if (!scRecordingId) return;
    e.preventDefault();
    e.stopPropagation();

    const accel = keyEventToAccelerator(e);
    if (!accel) return; // modifier-only press
    if (accel === 'CANCEL') {
      // Escape cancels recording
      scRecordingId = null;
      renderShortcutTable();
      return;
    }

    // Check for conflicts
    for (const [otherId, def] of Object.entries(scDefaults)) {
      if (otherId === scRecordingId) continue;
      const otherKey = scOverrides[otherId] || def.key;
      if (otherKey === accel) {
        toast(`キーが重複: ${def.label} (${accelDisplay(accel)})`);
        return;
      }
    }

    // Set the new key
    if (accel === scDefaults[scRecordingId].key) {
      delete scOverrides[scRecordingId]; // back to default
    } else {
      scOverrides[scRecordingId] = accel;
    }
    scRecordingId = null;
    renderShortcutTable();
  }, true);

  // Modal buttons
  $('scCancel').addEventListener('click', () => {
    scRecordingId = null;
    el.scEditorModal.classList.remove('vis');
  });
  $('scResetAll').addEventListener('click', () => {
    scOverrides = {};
    renderShortcutTable();
    toast('全てのショートカットをデフォルトにリセット');
  });
  $('scSave').addEventListener('click', async () => {
    scRecordingId = null;
    await window.electronAPI.saveShortcutOverrides(scOverrides);
    el.scEditorModal.classList.remove('vis');
    toast('ショートカット設定を保存しました（メニューに即時反映）');
  });
  el.scEditorModal.addEventListener('click', e => {
    if (e.target === el.scEditorModal) {
      scRecordingId = null;
      el.scEditorModal.classList.remove('vis');
    }
  });

  // ===== MODALS =====
  el.tcOffsetModal.addEventListener('click', e => { if (e.target === el.tcOffsetModal) el.tcOffsetModal.classList.remove('vis'); });

  $('tcOffsetCancel').addEventListener('click', () => el.tcOffsetModal.classList.remove('vis'));
  $('tcOffsetReset').addEventListener('click', () => {
    S.tcOffsetFrames = 0; S.tcOffsetStr = '00:00:00:00';
    el.tcOffsetInput.value = '00:00:00:00';
    el.tcOffsetModal.classList.remove('vis');
    toast('TCオフセットをリセット');
  });
  $('tcOffsetOk').addEventListener('click', () => {
    const val = el.tcOffsetInput.value.trim();
    const frames = parseSMPTE(val, S.fps.left);
    S.tcOffsetFrames = frames;
    S.tcOffsetStr = val;
    el.tcOffsetModal.classList.remove('vis');
    toast(`TCオフセット: ${val}`);
    window.electronAPI.updateSettings({ tcOffsetStr: val, tcOffsetFrames: frames });
  });

  // ===== VIDEO OFFSET MODAL =====
  el.vidOffsetModal.addEventListener('click', e => { if (e.target === el.vidOffsetModal) el.vidOffsetModal.classList.remove('vis'); });
  $('vidOffsetCancel').addEventListener('click', () => el.vidOffsetModal.classList.remove('vis'));
  $('vidOffsetReset').addEventListener('click', () => {
    const side = el.vidOffsetInput.dataset.side || 'right';
    setVideoOffset(side, 0);
    el.vidOffsetModal.classList.remove('vis');
    toast(`${side === 'left' ? 'Master' : 'Sub'} オフセットをリセット`);
  });
  $('vidOffsetOk').addEventListener('click', () => {
    const side = el.vidOffsetInput.dataset.side || 'right';
    const frames = parseInt(el.vidOffsetInput.value, 10) || 0;
    const fps = side === 'left' ? S.fps.left : S.fps.right;
    const sec = frames / (Math.round(fps) || 30);
    setVideoOffset(side, sec);
    el.vidOffsetModal.classList.remove('vis');
    const sign = frames >= 0 ? '+' : '';
    toast(`${side === 'left' ? 'Master' : 'Sub'} オフセット: ${sign}${frames}f`);
  });

  // Offset badge click → open modal
  if (el.vidOffsetL) el.vidOffsetL.addEventListener('dblclick', () => openVideoOffsetModal('left'));
  if (el.vidOffsetR) el.vidOffsetR.addEventListener('dblclick', () => openVideoOffsetModal('right'));

  // ===== IPC FROM MAIN =====
  window.electronAPI.onLoadVideo(d => loadVideo(d.side, d.filePath));
  window.electronAPI.onPlaybackCommand(cmd => {
    switch (cmd) {
      case 'toggle': togglePlay(); break;
      case 'stop': stop(); break;
      case 'frame-forward': frameStep(1); break;
      case 'frame-backward': frameStep(-1); break;
      case 'sec-forward': seekRel(1); break;
      case 'sec-backward': seekRel(-1); break;
      case 'ten-sec-forward': seekRel(10); break;
      case 'ten-sec-backward': seekRel(-10); break;
      case 'go-start': seekAbs(0); break;
      case 'go-end': seekAbs(0.9999); break;
      case 'speed-up': setSpeed(S.speed + 0.25); break;
      case 'speed-down': setSpeed(S.speed - 0.25); break;
      case 'speed-reset': setSpeed(1.0); break;
    }
  });
  window.electronAPI.onAudioDelay(d => adjustDelay(d));
  window.electronAPI.onMuteToggle(() => toggleMute());
  window.electronAPI.onVolumeChange(delta => {
    setVolume(parseFloat(el.volSlider.value) + delta, true);
    toast(`音量: ${Math.round(el.volSlider.value * 100)}%`);
  });
  window.electronAPI.onTakeScreenshot(t => takeScreenshot(t));

  // Video time offset IPC
  window.electronAPI.onVidOffset(d => {
    const fps = d.side === 'left' ? S.fps.left : S.fps.right;
    adjustVideoOffset(d.side, d.delta / fps);
    const label = d.side === 'left' ? 'Master' : 'Sub';
    toast(`${label} オフセット: ${Math.round(S.videoOffset[d.side] * fps)}f`);
  });
  window.electronAPI.onVidOffsetReset(side => {
    if (side === 'all') {
      setVideoOffset('left', 0);
      setVideoOffset('right', 0);
      toast('全オフセットをリセット');
    } else {
      setVideoOffset(side, 0);
      toast(`${side === 'left' ? 'Master' : 'Sub'} オフセットをリセット`);
    }
  });
  window.electronAPI.onVidOffsetDialog(side => openVideoOffsetModal(side));
  window.electronAPI.onShowShortcutEditor(() => openShortcutEditor());
  window.electronAPI.onSettingsUpdated(s => {
    S.settings = s;
    updateStatusBar();
    // Toggle timeline visibility
    const tlSection = $('timelineSection');
    if (tlSection) tlSection.style.display = s.showTimeline === false ? 'none' : 'flex';
    // Master/Sub panel visibility
    applyPanelVisibility(s);
  });
  window.electronAPI.onTimestampAdd(() => addTimestamp(false));
  window.electronAPI.onTimestampAddSS(() => addTimestamp(true));
  window.electronAPI.onTimestampCopyAll(() => copyAllTimestamps());
  window.electronAPI.onTimestampClear(() => { S.timestamps = []; renderTimestamps(); syncTimestampsToPopup(); toast('タイムスタンプをクリア'); });
  window.electronAPI.onTimestampExport(fmt => exportTimestamps(fmt));
  window.electronAPI.onTimestampSyncRequest(() => syncTimestampsToPopup());
  window.electronAPI.onTimestampSeekTo(sec => {
    if (S.loaded.left && el.vidL.duration) {
      seekAbs(sec / el.vidL.duration);
      toast(`シーク: ${toSMPTE(sec, S.fps.left, S.tcOffsetFrames)}`);
    }
  });
  // Popup window deleted a timestamp — sync deletion back
  window.electronAPI.onTimestampDeleteFromPopup && window.electronAPI.onTimestampDeleteFromPopup(idx => {
    deleteTimestamp(idx);
  });
  // Popup window updated a note
  window.electronAPI.onTimestampNoteFromPopup && window.electronAPI.onTimestampNoteFromPopup(({ index, note }) => {
    if (index >= 0 && index < S.timestamps.length) {
      updateTimestampNote(S.timestamps[index], note);
      renderTimestamps();
      syncTimestampsToPopup();
    }
  });
  window.electronAPI.onTcOffsetDialog(() => {
    el.tcOffsetInput.value = S.tcOffsetStr;
    el.tcOffsetModal.classList.add('vis');
  });
  window.electronAPI.onSwapVideos(() => swapMasterSub());
  window.electronAPI.onUnloadVideo(side => unloadVideo(side));
  window.electronAPI.onLayoutChange(layout => {
    const area = document.querySelector('.video-area');
    area.classList.remove('horizontal', 'vertical', 'free');
    area.classList.add(layout);
    const splitter = $('videoSplitter');
    document.querySelectorAll('.player-panel').forEach(p => {
      p.style.width = ''; p.style.height = ''; p.style.flex = '';
    });
    if (layout === 'vertical') {
      splitter.classList.remove('h'); splitter.classList.add('v');
    } else {
      splitter.classList.remove('v'); splitter.classList.add('h');
    }
    splitter.style.display = layout === 'free' ? 'none' : 'flex';
    toast(`レイアウト: ${layout === 'horizontal' ? '横並び' : layout === 'vertical' ? '縦並び' : '自由配置'}`);
  });

  // ===== VIDEO SPLITTER DRAG =====
  (function initSplitter() {
    const splitter = $('videoSplitter');
    const panelL = $('panelLeft');
    const panelR = $('panelRight');
    let dragging = false;

    splitter.addEventListener('mousedown', e => {
      e.preventDefault();
      dragging = true;
      splitter.classList.add('dragging');
      document.body.style.cursor = isVertical() ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const area = document.querySelector('.video-area');
      const rect = area.getBoundingClientRect();
      if (isVertical()) {
        const y = e.clientY - rect.top;
        const total = rect.height - 6; // splitter height
        const ratio = Math.max(0.1, Math.min(0.9, y / total));
        panelL.style.flex = 'none';
        panelR.style.flex = 'none';
        panelL.style.height = `${ratio * 100}%`;
        panelR.style.height = `${(1 - ratio) * 100}%`;
      } else {
        const x = e.clientX - rect.left;
        const total = rect.width - 6; // splitter width
        const ratio = Math.max(0.1, Math.min(0.9, x / total));
        panelL.style.flex = 'none';
        panelR.style.flex = 'none';
        panelL.style.width = `${ratio * 100}%`;
        panelR.style.width = `${(1 - ratio) * 100}%`;
      }
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });

    // Double-click to reset to 50/50
    splitter.addEventListener('dblclick', () => {
      panelL.style.flex = ''; panelR.style.flex = '';
      panelL.style.width = ''; panelR.style.width = '';
      panelL.style.height = ''; panelR.style.height = '';
      toast('分割比率をリセット');
    });

    function isVertical() {
      return document.querySelector('.video-area').classList.contains('vertical');
    }
  })();

  // ===== RESIZE =====
  window.addEventListener('resize', () => {
    drawTimeRuler();
    drawTimelineBar();
  });

  // ===== SESSION =====
  const sessionState = {
    role: null,     // 'host' | 'client' | null
    userName: '',
    users: [],
  };

  const sessionEl = {
    badge: $('sessionBadge'),
    dot: $('sessionDot'),
    label: $('sessionLabel'),
    usersCount: $('sessionUsersCount'),
    modal: $('sessionModal'),
    modalTitle: $('sessionModalTitle'),
    hostForm: $('sessionHostForm'),
    joinForm: $('sessionJoinForm'),
    usernameForm: $('sessionUsernameForm'),
    infoPanel: $('sessionInfoPanel'),
    infoContent: $('sessionInfoContent'),
    toast: $('sessionToast'),
  };

  function sessionToast(msg, level = '', dur = 3000) {
    sessionEl.toast.textContent = msg;
    sessionEl.toast.className = 'session-toast vis' + (level ? ` ${level}` : '');
    clearTimeout(sessionEl.toast._timer);
    sessionEl.toast._timer = setTimeout(() => sessionEl.toast.classList.remove('vis'), dur);
  }

  function updateSessionBadge() {
    if (!sessionState.role) {
      sessionEl.badge.style.display = 'none';
      return;
    }
    sessionEl.badge.style.display = 'flex';
    sessionEl.dot.classList.add('connected');
    const roleLabel = sessionState.role === 'host' ? 'ホスト' : 'クライアント';
    sessionEl.label.textContent = `${roleLabel}: ${sessionState.userName}`;
    sessionEl.usersCount.textContent = sessionState.users.length > 0 ? `(${sessionState.users.length}人)` : '';
  }

  function showSessionDialog(mode) {
    // Hide all forms
    sessionEl.hostForm.style.display = 'none';
    sessionEl.joinForm.style.display = 'none';
    sessionEl.usernameForm.style.display = 'none';
    sessionEl.infoPanel.style.display = 'none';

    // If already in session, show info panel
    if (sessionState.role && mode !== 'username') {
      sessionEl.modalTitle.textContent = 'セッション情報';
      sessionEl.infoPanel.style.display = 'block';
      const roleLabel = sessionState.role === 'host' ? 'ホスト' : 'クライアント';
      let html = `<div style="margin-bottom:8px;"><b>ロール:</b> ${roleLabel}</div>`;
      html += `<div style="margin-bottom:8px;"><b>ユーザー名:</b> ${sessionState.userName}</div>`;
      html += `<div style="margin-bottom:8px;"><b>参加者:</b></div>`;
      for (const u of sessionState.users) {
        const tag = u.role === 'host' ? '<span style="color:var(--green);font-size:9px;"> [HOST]</span>' : '';
        html += `<div style="padding:2px 0;color:var(--text);">&bull; ${u.name}${tag}</div>`;
      }
      sessionEl.infoContent.innerHTML = html;
      sessionEl.modal.classList.add('vis');
      return;
    }

    const savedName = S.settings.sessionUserName || '';
    const savedPort = S.settings.sessionPort || 9877;
    const savedIP = S.settings.lastHostIP || '';

    if (mode === 'host') {
      sessionEl.modalTitle.textContent = 'セッション開始（ホスト）';
      sessionEl.hostForm.style.display = 'block';
      $('sessionHostName').value = savedName;
      $('sessionHostPort').value = savedPort;
      $('sessionHostPassword').value = '';
    } else if (mode === 'client') {
      sessionEl.modalTitle.textContent = 'セッション参加';
      sessionEl.joinForm.style.display = 'block';
      $('sessionJoinName').value = savedName;
      $('sessionJoinHost').value = savedIP;
      $('sessionJoinPort').value = savedPort;
      $('sessionJoinPassword').value = '';
    } else if (mode === 'username') {
      sessionEl.modalTitle.textContent = 'ユーザー名設定';
      sessionEl.usernameForm.style.display = 'block';
      $('sessionUserNameInput').value = savedName;
    }

    sessionEl.modal.classList.add('vis');
  }

  function hideSessionModal() {
    sessionEl.modal.classList.remove('vis');
  }

  // Session dialog buttons
  $('sessionHostCancel').addEventListener('click', hideSessionModal);
  $('sessionJoinCancel').addEventListener('click', hideSessionModal);
  $('sessionUsernameCancel').addEventListener('click', hideSessionModal);
  $('sessionInfoClose').addEventListener('click', hideSessionModal);

  $('sessionHostStart').addEventListener('click', async () => {
    const userName = $('sessionHostName').value.trim();
    const port = parseInt($('sessionHostPort').value) || 9877;
    const password = $('sessionHostPassword').value;
    if (!userName) { sessionToast('ユーザー名を入力してください', 'warning'); return; }

    $('sessionHostStart').disabled = true;
    $('sessionHostStart').textContent = '開始中...';
    const result = await window.electronAPI.sessionStartHost({ userName, port, password });
    $('sessionHostStart').disabled = false;
    $('sessionHostStart').textContent = 'セッション開始';

    if (result.success) {
      sessionState.role = 'host';
      sessionState.userName = userName;
      sessionState.users = [{ name: userName, role: 'host' }];
      updateSessionBadge();
      hideSessionModal();
      sessionToast(`セッション開始: ${result.ip}:${port}`);
    } else {
      sessionToast(result.error || 'セッション開始に失敗', 'error');
    }
  });

  $('sessionJoinConnect').addEventListener('click', async () => {
    const userName = $('sessionJoinName').value.trim();
    const host = $('sessionJoinHost').value.trim();
    const port = parseInt($('sessionJoinPort').value) || 9877;
    const password = $('sessionJoinPassword').value;
    if (!userName) { sessionToast('ユーザー名を入力してください', 'warning'); return; }
    if (!host) { sessionToast('ホストIPアドレスを入力してください', 'warning'); return; }

    $('sessionJoinConnect').disabled = true;
    $('sessionJoinConnect').textContent = '接続中...';
    const result = await window.electronAPI.sessionJoin({ userName, host, port, password });
    $('sessionJoinConnect').disabled = false;
    $('sessionJoinConnect').textContent = '接続';

    if (result.success) {
      sessionState.role = 'client';
      sessionState.userName = result.userName || userName;
      sessionState.users = result.users || [];
      updateSessionBadge();
      hideSessionModal();
      sessionToast('セッションに参加しました');
    } else {
      sessionToast(result.error || '接続に失敗', 'error');
    }
  });

  $('sessionUsernameSave').addEventListener('click', () => {
    const name = $('sessionUserNameInput').value.trim();
    if (!name) { sessionToast('ユーザー名を入力してください', 'warning'); return; }
    window.electronAPI.updateSettings({ sessionUserName: name });
    S.settings.sessionUserName = name;
    hideSessionModal();
    toast(`ユーザー名: ${name}`);
  });

  $('sessionInfoStop').addEventListener('click', async () => {
    await window.electronAPI.sessionStop();
    hideSessionModal();
  });

  // Session badge click → show info
  sessionEl.badge.addEventListener('click', () => {
    showSessionDialog('info');
  });

  // IPC: Show session dialog from menu
  window.electronAPI.onSessionShowDialog((mode) => {
    showSessionDialog(mode);
  });

  // IPC: Session status updates
  window.electronAPI.onSessionStatus((data) => {
    switch (data.type) {
      case 'started':
        sessionState.role = 'host';
        sessionState.users = data.users || [];
        updateSessionBadge();
        break;
      case 'joined':
        sessionState.role = 'client';
        sessionState.users = data.users || [];
        updateSessionBadge();
        break;
      case 'stopped':
        sessionState.role = null;
        sessionState.users = [];
        updateSessionBadge();
        sessionToast('セッションが終了しました');
        break;
      case 'disconnected':
        sessionState.role = null;
        sessionState.users = [];
        updateSessionBadge();
        sessionToast('セッションが切断されました', 'warning');
        break;
    }
  });

  // IPC: Users list updated
  window.electronAPI.onSessionUsers((data) => {
    sessionState.users = data.users || [];
    updateSessionBadge();
  });

  // IPC: Session notifications (toast)
  window.electronAPI.onSessionNotification((data) => {
    sessionToast(data.message, data.level || '');
  });

  // IPC: Host requests current state to send to new client
  window.electronAPI.onSessionStateRequest(() => {
    if (sessionState.role !== 'host') return;
    const state = {
      playing: S.playing,
      currentTime: el.vidL.currentTime || 0,
      speed: S.speed,
      timestamps: S.timestamps.map(ts => ({
        ...ensureTimestampMetadata(ts),
        thumbnail: null,
        id: ts.id || '',
        seconds: ts.seconds,
        tc: ts.tc,
        memo: ts.note || '',
        author: ts.author,
        createdAt: ts.createdAt,
      })),
      masterFile: S.masterFilePath ? { name: S.masterFilePath.split(/[/\\]/).pop(), size: 0 } : null,
      subFile: S.subFilePath ? { name: S.subFilePath.split(/[/\\]/).pop(), size: 0 } : null,
    };
    window.electronAPI.sendSessionStateResponse(state);
  });

  // IPC: Client received session state from host
  window.electronAPI.onSessionStateReceived((data) => {
    if (sessionState.role !== 'client') return;
    // Sync timestamps from host
    if (data.timestamps && Array.isArray(data.timestamps)) {
      S.timestamps = data.timestamps.map(ts => ensureTimestampMetadata({
        ...ts,
        tc: ts.tc,
        seconds: ts.seconds,
        note: ts.memo || '',
        author: ts.author ?? ts.by ?? '',
        id: ts.id || '',
        thumbnail: null,
      }));
      renderTimestamps();
      renderTimelineMarkers();
    }
    // Sync playback position
    if (typeof data.currentTime === 'number' && S.loaded.left) {
      el.vidL.currentTime = data.currentTime;
      if (S.loaded.right) el.vidR.currentTime = data.currentTime;
    }
    // Sync speed
    if (typeof data.speed === 'number') {
      S.speed = data.speed;
      el.vidL.playbackRate = S.speed;
      el.vidR.playbackRate = S.speed;
      el.speedBadge.textContent = S.speed.toFixed(2) + 'x';
    }
  });

  // IPC: Playback sync from host (client only)
  window.electronAPI.onSessionPlayback((data) => {
    if (sessionState.role !== 'client') return;
    switch (data.action) {
      case 'play':
        if (S.loaded.left || S.loaded.right) {
          S.playing = true;
          if (S.loaded.left) el.vidL.play();
          if (S.loaded.right) el.vidR.play();
          el.btnPlay.innerHTML = '&#9646;&#9646;';
        }
        break;
      case 'pause':
        S.playing = false;
        el.vidL.pause(); el.vidR.pause();
        el.btnPlay.innerHTML = '&#9654;';
        break;
      case 'seek':
        if (typeof data.currentTime === 'number') {
          if (S.loaded.left) el.vidL.currentTime = data.currentTime;
          if (S.loaded.right) el.vidR.currentTime = data.currentTime;
        }
        break;
      case 'frame-step':
        if (typeof data.currentTime === 'number') {
          if (S.loaded.left) el.vidL.currentTime = data.currentTime;
          if (S.loaded.right) el.vidR.currentTime = data.currentTime;
        }
        break;
    }
  });

  // IPC: Speed change from host (client only)
  window.electronAPI.onSessionSpeedChange((data) => {
    if (sessionState.role !== 'client') return;
    if (typeof data.speed === 'number') {
      S.speed = data.speed;
      el.vidL.playbackRate = S.speed;
      el.vidR.playbackRate = S.speed;
      el.speedBadge.textContent = S.speed.toFixed(2) + 'x';
    }
  });

  // IPC: Timestamp sync from other users
  window.electronAPI.onSessionTimestamp((msg) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'timestamp-add': {
        const ts = msg.payload;
        S.timestamps.push(ensureTimestampMetadata({
          ...ts,
          tc: ts.tc, seconds: ts.seconds, note: ts.memo || '',
          author: ts.author ?? ts.by ?? msg.sender ?? '', id: ts.id || '',
          thumbnail: null,
        }));
        renderTimestamps();
        renderTimelineMarkers();
        break;
      }
      case 'timestamp-delete': {
        const id = msg.payload?.id;
        if (id) {
          S.timestamps = S.timestamps.filter(t => t.id !== id);
          renderTimestamps();
          renderTimelineMarkers();
        }
        break;
      }
      case 'timestamp-edit': {
        const { id, memo } = msg.payload || {};
        if (id) {
          const ts = S.timestamps.find(t => t.id === id);
          if (ts) {
            updateTimestampNote(ts, memo || '', msg.payload.updatedAt ?? msg.payload.updated_at);
            renderTimestamps();
          }
        }
        break;
      }
    }
  });

  // ===== INIT =====
  // ===== PANEL VISIBILITY =====
  function applyPanelVisibility(s) {
    el.panelL.style.display = s.showMaster === false ? 'none' : '';
    el.panelR.style.display = s.showSub === false ? 'none' : '';
    el.splitter.style.display = (s.showMaster === false || s.showSub === false) ? 'none' : '';
  }

  // ===== TC OFFSET FROM TIMESTAMP PANEL =====
  $('tsOffsetApply').addEventListener('click', () => {
    const val = $('tsOffsetInput').value.trim();
    const fps = Math.round(S.fps.left) || 30;
    const totalFrames = parseSMPTE(val, fps);
    if (totalFrames > 0 || val === '00:00:00:00') {
      S.tcOffsetFrames = totalFrames;
      S.tcOffsetStr = val;
      _tcLastTime = -1; // force TC redraw
      window.electronAPI.updateSettings({ tcOffsetStr: val, tcOffsetFrames: totalFrames });
      toast(`TCオフセット: ${val}`);
    } else {
      toast('無効なTC形式 (HH:MM:SS:FF)');
    }
  });

  // ===== VOLUME PERSISTENCE =====
  function saveVolume() {
    window.electronAPI.updateSettings({ volume: parseFloat(el.volSlider.value), muted: S.muted });
  }

  (async () => {
    S.settings = await window.electronAPI.getSettings();
    if (S.settings.tcOffsetStr) {
      S.tcOffsetStr = S.settings.tcOffsetStr;
      S.tcOffsetFrames = S.settings.tcOffsetFrames || 0;
    }
    if (S.settings.layout) {
      const area = document.querySelector('.video-area');
      area.classList.add(S.settings.layout);
    }
    // Apply timeline visibility setting
    if (S.settings.showTimeline === false) {
      const tlSection = $('timelineSection');
      if (tlSection) tlSection.style.display = 'none';
    }
    // Restore volume & mute
    if (S.settings.volume !== undefined) {
      setVolume(S.settings.volume);
    }
    if (S.settings.muted) {
      S.muted = true;
      updateAudioRouting();
      updateMuteUI();
    }
    // Master/Sub panel visibility
    applyPanelVisibility(S.settings);
    updateStatusBar();
    el.topStatus.textContent = 'Ctrl+1 / Ctrl+2 で動画を読込、またはドラッグ&ドロップ';

    // ===== FFMPEG AUTO SETUP =====
    const ffmpegStatus = await window.electronAPI.ffmpegCheck();
    if (!ffmpegStatus.installed) {
      // Show ffmpeg setup dialog
      const setupModal = $('ffmpegSetupModal');
      if (setupModal) {
        setupModal.classList.add('vis');
        $('ffmpegSetupBtn').addEventListener('click', async () => {
          $('ffmpegSetupBtn').disabled = true;
          $('ffmpegSetupBtn').textContent = 'セットアップ中...';
          $('ffmpegSkipBtn').style.display = 'none';
          $('ffmpegSetupStatus').textContent = 'ffmpegをダウンロード中...';
          $('ffmpegSetupBar').style.display = 'block';

          window.electronAPI.onFFmpegSetupProgress((data) => {
            $('ffmpegSetupStatus').textContent = data.message || '';
            if (data.percent) {
              $('ffmpegSetupBarFill').style.width = `${data.percent}%`;
            }
            if (data.stage === 'extracting') {
              $('ffmpegSetupStatus').textContent = 'ZIPを展開中（数分かかる場合があります）...';
              $('ffmpegSetupBarFill').style.width = '100%';
            }
          });

          const result = await window.electronAPI.ffmpegSetup();
          if (result.success) {
            $('ffmpegSetupStatus').textContent = 'セットアップ完了！ProRes/DNxHD動画が再生可能になりました。';
            $('ffmpegSetupBtn').textContent = '閉じる';
            $('ffmpegSetupBtn').disabled = false;
            $('ffmpegSetupBtn').onclick = () => setupModal.classList.remove('vis');
          } else {
            $('ffmpegSetupStatus').textContent = `失敗: ${result.message}`;
            $('ffmpegSetupBtn').textContent = '再試行';
            $('ffmpegSetupBtn').disabled = false;
            $('ffmpegSkipBtn').style.display = '';
          }
        });
        $('ffmpegSkipBtn').addEventListener('click', () => {
          setupModal.classList.remove('vis');
          toast('ffmpegなし: ProRes/DNxHD動画は再生できません', 5000);
        });
      }
    }
  })();

})();
