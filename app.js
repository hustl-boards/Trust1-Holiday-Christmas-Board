(() => {
  // Office TV board. One video element, one animation loop, no per-clip listeners.
  // The playlist is clips.js. There is no GitHub API call.
  const params = new URLSearchParams(location.search);
  const FLAKES = 18;
  const FAILURES_BEFORE_RELOAD = 3;
  const CURSOR_IDLE_MS = 3000;

  function num(key, fallback, min, max) {
    if (!params.has(key)) return fallback;
    const n = Number(params.get(key));
    if (!isFinite(n)) return fallback;
    if (n < min) return min;
    if (max != null && n > max) return max;
    return n;
  }

  const maxClip = num('maxclip', 60, 10, 600);
  // ?watchdog= still works as an alias for the stall window.
  const stallSeconds = params.has('stall') ? num('stall', 8, 2, 120) : num('watchdog', 8, 2, 120);
  const reloadHours = num('reload', 4, 0, 168);
  const hardExtraMin = num('hardmin', 15, 0, 240);
  const fresh = params.get('fresh') === '1';
  const debug = params.get('debug') === '1';
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const stage = document.getElementById('stage');
  const vid = document.getElementById('vid');
  const bar = document.querySelector('#progress span');
  const counter = document.getElementById('counter');
  const countdown = document.getElementById('countdown');
  const pauseBtn = document.getElementById('pause');
  const soundBtn = document.getElementById('sound');
  const fx = document.getElementById('fx');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  if (!store.get('cb_since')) store.set('cb_since', String(Date.now()));
  store.set('cb_loads', String((Number(store.get('cb_loads')) || 0) + 1));

  // Muted has to be set in script. Audible autoplay is what TV browsers block.
  vid.muted = true;
  vid.defaultMuted = true;
  vid.loop = false;
  vid.playsInline = true;
  try { vid.disablePictureInPicture = true; } catch (e) {}
  let wantSound = false;
  let retriedMuted = false;

  function readClips() {
    const list = window.CLIPS;
    const out = [];
    if (!list || !list.length) return out;
    for (let n = 0; n < list.length; n++) {
      if (typeof list[n] === 'string' && list[n].trim()) out.push(list[n].trim());
    }
    return out;
  }

  const clips = readClips();
  if (params.get('shuffle') === '1') {
    for (let n = clips.length - 1; n > 0; n--) {
      const j = Math.floor(Math.random() * (n + 1));
      const swap = clips[n];
      clips[n] = clips[j];
      clips[j] = swap;
    }
  }

  let index = 0;
  let generation = 0;
  let expectedSrc = '';
  let paused = false;
  let failures = 0;
  let failedGen = -1;
  let reloading = false;
  let reloadDue = false;
  let pendingReload = '';
  let pendingRecover = '';
  let mediaLive = false;
  let armLive = false;
  let seenPlaying = false;
  let lastAdvanceAt = Date.now();
  let lastMediaTime = -1;
  let sawFrame = false;
  let clipStartedAt = Date.now();
  let wakeLock = null;
  let rafId = 0;
  let lastSnowAt = 0;
  let lastBarAt = 0;
  let lastWakeAt = 0;
  let lastDebugAt = 0;
  let cursorAt = 0;
  let hiddenAt = 0;
  let pausedAt = 0;
  const booted = Date.now();
  const boundaryAt = reloadHours > 0 ? booted + reloadHours * 3600 * 1000 : 0;
  const hardAt = boundaryAt ? boundaryAt + hardExtraMin * 60 * 1000 : 0;

  const flakes = new Array(FLAKES);
  let dbg = null;

  function note(msg) {
    store.set('cb_err', new Date().toLocaleTimeString() + ' ' + msg);
  }

  function labelOf(src) {
    const path = (src || '').split('?')[0];
    const parts = path.split('/');
    return parts[parts.length - 1] || src || 'clip';
  }

  let nyFmt = null;

  function nyParts(date) {
    try {
      if (!nyFmt) {
        nyFmt = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
      }
      const bits = nyFmt.formatToParts(date);
      const grab = (type) => {
        for (let n = 0; n < bits.length; n++) {
          if (bits[n].type === type) return Number(bits[n].value);
        }
        return 0;
      };
      return { y: grab('year'), m: grab('month'), d: grab('day') };
    } catch (e) {
      return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
    }
  }

  function activeParts() {
    const raw = params.get('date');
    if (raw) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      if (match) return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
    }
    return nyParts(new Date());
  }

  function daysUntilChristmas(parts) {
    const today = Date.UTC(parts.y, parts.m - 1, parts.d);
    let xmas = Date.UTC(parts.y, 11, 25);
    if (today > xmas) xmas = Date.UTC(parts.y + 1, 11, 25);
    return Math.round((xmas - today) / 86400000);
  }

  // 12:00 AM America/New_York on a civil date, as a UTC instant.
  // Resolved from the timezone database so the TV's own zone does not matter.
  function wallClockUtc(y, m, d, h, mi, s) {
    const want = Date.UTC(y, m - 1, d, h, mi, s);
    let utc = want;
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (e) {
      return Date.UTC(y, m - 1, d, h + 5, mi, s);
    }
    for (let n = 0; n < 4; n++) {
      const bits = fmt.formatToParts(new Date(utc));
      const grab = (type) => {
        for (let i = 0; i < bits.length; i++) {
          if (bits[i].type === type) return Number(bits[i].value);
        }
        return 0;
      };
      let hour = grab('hour');
      if (hour === 24) hour = 0;
      const got = Date.UTC(grab('year'), grab('month') - 1, grab('day'), hour, grab('minute'), grab('second'));
      const delta = got - want;
      if (delta === 0) return utc;
      utc -= delta;
    }
    return utc;
  }

  const christmasStartCache = Object.create(null);

  function christmasStart(year) {
    if (christmasStartCache[year] == null) {
      christmasStartCache[year] = wallClockUtc(year, 12, 25, 0, 0, 0);
    }
    return christmasStartCache[year];
  }

  function frozenNow() {
    const raw = params.get('date');
    if (!raw) return 0;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) return 0;
    return wallClockUtc(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0);
  }

  const FROZEN_NOW = frozenNow();

  function clockNow() {
    return FROZEN_NOW || Date.now();
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function countdownMessage(ms) {
    const parts = nyParts(new Date(ms));
    if (parts.m === 12 && parts.d === 25) return 'Merry Christmas from the 3R family';
    let year = parts.y;
    if (parts.m === 12 && parts.d > 25) year += 1;
    let left = christmasStart(year) - ms;
    if (left < 0) left = 0;
    const total = Math.floor(left / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return days + 'd ' + pad2(hours) + 'h ' + pad2(mins) + 'm ' + pad2(secs) + 's until Christmas';
  }

  let shownCountdown = '';

  function paintCountdown() {
    const text = countdownMessage(clockNow());
    if (text === shownCountdown) return;
    shownCountdown = text;
    countdown.textContent = text;
    publish();
  }

  function publish() {
    const parts = activeParts();
    window.__board = {
      index: index,
      count: clips.length,
      src: clips.length ? clips[index] : '',
      paused: paused,
      days: daysUntilChristmas(parts),
      failures: failures
    };
  }

  function nextIndex() {
    if (!clips.length) return 0;
    return (index + 1) % clips.length;
  }

  // Full navigation. Returns false when we must stay on this page (offline,
  // or a failure reload that would reboot-loop). The clip loop keeps going.
  function navigate(reason, resumeAt, failure) {
    if (reloading) return true;
    if (navigator.onLine === false) {
      pendingReload = reason;
      note('offline defer ' + reason);
      return false;
    }
    if (failure) {
      const last = Number(store.get('cb_reload_at')) || 0;
      if (Date.now() - last < 180000) {
        note('reload held ' + reason);
        return false;
      }
    }
    reloading = true;
    pendingReload = '';
    store.set('cb_reload_at', String(Date.now()));
    store.set('cb_reason', reason);
    if (clips.length) store.set('cb_next', String(resumeAt));
    const url = new URL(location.href);
    url.searchParams.set('cb', String(Date.now()));
    location.replace(url.toString());
    return true;
  }

  function releaseVideo() {
    // One element. Drop the decoder before the next file. Events that fire
    // from this empty load are ignored because mediaLive is false.
    mediaLive = false;
    armLive = false;
    seenPlaying = false;
    expectedSrc = '';
    try { vid.pause(); } catch (e) {}
    vid.classList.remove('on');
    vid.removeAttribute('src');
    vid.src = '';
    try { vid.load(); } catch (e) {}
  }

  function playClip(gen) {
    if (paused || gen !== generation || reloading) return;
    if (!wantSound) vid.muted = true;
    let ret;
    try { ret = vid.play(); } catch (e) { ret = Promise.reject(e); }
    // Some TV browsers return undefined from play(). Promise.resolve covers that.
    Promise.resolve(ret).then(() => {
      if (gen !== generation) return;
      if (paused) {
        try { vid.pause(); } catch (e) {}
        return;
      }
      vid.classList.add('on');
      lastAdvanceAt = Date.now();
    }).catch((err) => {
      if (gen !== generation || paused || reloading) return;
      if (err && err.name === 'AbortError') return;
      // Autoplay blocked, or the muted flag did not stick. One muted retry.
      if (!retriedMuted) {
        retriedMuted = true;
        wantSound = false;
        vid.muted = true;
        vid.defaultMuted = true;
        soundBtn.textContent = '\uD83D\uDD07';
        soundBtn.setAttribute('aria-label', 'Turn sound on');
        playClip(gen);
        return;
      }
      recover('playback rejected ' + labelOf(clips[index]));
    });
  }

  function recover(reason) {
    if (reloading || pendingRecover) return;
    if (failedGen === generation) return;
    failedGen = generation;
    pendingRecover = reason;
    note(reason);
    startLoop();
  }

  function applyRecover(reason) {
    if (failedGen !== generation || reloading) return;
    failures += 1;
    publish();
    const resumeAt = nextIndex();
    if (failures >= FAILURES_BEFORE_RELOAD) {
      failures = 0;
      if (navigate('failures ' + reason, resumeAt, true)) return;
    } else if (reloadDue) {
      if (navigate('scheduled', resumeAt, false)) return;
    }
    goTo(index + 1);
  }

  function goTo(n) {
    if (fresh && clips.length > 1) {
      const next = ((n % clips.length) + clips.length) % clips.length;
      if (navigate('fresh', next, false)) return;
    }
    show(n);
  }

  function advance(gen) {
    if (gen != null && gen !== generation) return;
    if (!clips.length || reloading) return;
    if (reloadDue && navigate('scheduled', nextIndex(), false)) return;
    goTo(index + 1);
  }

  function show(n) {
    if (!clips.length) {
      showEmpty();
      return;
    }
    pendingRecover = '';
    generation += 1;
    const gen = generation;
    releaseVideo();
    index = ((n % clips.length) + clips.length) % clips.length;
    const src = clips[index];
    expectedSrc = src;
    counter.style.opacity = '';
    counter.textContent = (index + 1) + ' / ' + clips.length;
    bar.style.width = '0%';
    lastMediaTime = -1;
    sawFrame = false;
    lastAdvanceAt = Date.now();
    clipStartedAt = lastAdvanceAt;
    retriedMuted = false;
    vid.muted = !wantSound;
    publish();
    vid.src = src;
    armLive = true;
    if (paused) return;
    playClip(gen);
  }

  function showEmpty() {
    releaseVideo();
    counter.textContent = window.CLIPS ? 'No clips yet' : 'Playlist missing';
    counter.style.opacity = '1';
    bar.style.width = '0%';
    publish();
  }

  function onEnded() {
    if (!mediaLive || reloading) return;
    if ((vid.getAttribute('src') || '') !== expectedSrc) return;
    failures = 0;
    lastAdvanceAt = Date.now();
    publish();
    advance(generation);
  }

  function onPlaying() {
    if ((vid.getAttribute('src') || '') !== expectedSrc) return;
    seenPlaying = true;
    vid.classList.add('on');
    lastAdvanceAt = Date.now();
  }

  function onProblem(ev) {
    if (!mediaLive || reloading) return;
    const current = vid.getAttribute('src') || '';
    if (!current || current !== expectedSrc) return;
    if (ev.type !== 'error' && !seenPlaying) return;
    // A brief stall while the playhead is still moving is buffering, not a dead clip.
    if (ev.type === 'stalled' && Date.now() - lastAdvanceAt < 2000) return;
    recover(ev.type + ' ' + labelOf(current));
  }

  vid.addEventListener('ended', onEnded);
  vid.addEventListener('playing', onPlaying);
  vid.addEventListener('error', onProblem);
  vid.addEventListener('stalled', onProblem);
  vid.addEventListener('abort', onProblem);
  vid.addEventListener('emptied', onProblem);

  function togglePause() {
    paused = !paused;
    pauseBtn.textContent = paused ? '\u25b6' : '\u2161';
    pauseBtn.setAttribute('aria-label', paused ? 'Resume slideshow' : 'Pause slideshow');
    publish();
    if (!clips.length) return;
    if (paused) {
      pausedAt = Date.now();
      lastAdvanceAt = pausedAt;
      try { vid.pause(); } catch (e) {}
      return;
    }
    if (pausedAt) {
      clipStartedAt += Date.now() - pausedAt;
      pausedAt = 0;
    }
    lastAdvanceAt = Date.now();
    retriedMuted = false;
    playClip(generation);
  }

  function toggleSound() {
    wantSound = !wantSound;
    retriedMuted = !wantSound;
    vid.muted = !wantSound;
    soundBtn.textContent = vid.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    soundBtn.setAttribute('aria-label', vid.muted ? 'Turn sound on' : 'Turn sound off');
    if (wantSound && !paused && clips.length) playClip(generation);
  }

  document.getElementById('next').onclick = () => advance(generation);
  document.getElementById('prev').onclick = () => show(index - 1);
  pauseBtn.onclick = togglePause;
  soundBtn.onclick = (e) => {
    e.stopPropagation();
    toggleSound();
  };
  document.getElementById('full').onclick = () => {
    const request = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    if (request && request.catch) request.catch(() => {});
  };
  addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    if (key === 'arrowright' || key === ' ') {
      e.preventDefault();
      advance(generation);
    } else if (key === 'arrowleft') {
      e.preventDefault();
      show(index - 1);
    } else if (key === 'p') togglePause();
    else if (key === 'm') toggleSound();
    else if (key === 'f') document.getElementById('full').click();
  });

  function pokeCursor() {
    cursorAt = Date.now();
    if (!stage.classList.contains('awake')) stage.classList.add('awake');
  }
  stage.addEventListener('pointermove', pokeCursor);
  stage.addEventListener('pointerdown', pokeCursor);

  function buildSnow() {
    for (let n = 0; n < FLAKES; n++) {
      const el = document.createElement('span');
      el.className = 'flake';
      el.style.left = ((n * 5.7) % 100) + '%';
      el.style.opacity = reduceMotion ? '0' : String(0.28 + (n % 5) * 0.1);
      const size = (4 + (n % 4) * 2) + 'px';
      el.style.width = size;
      el.style.height = size;
      fx.appendChild(el);
      flakes[n] = {
        el: el,
        dur: 14 + (n % 9),
        phase: n * 0.85
      };
    }
  }

  function stepSnow(now) {
    if (reduceMotion) return;
    const t = now / 1000;
    for (let n = 0; n < FLAKES; n++) {
      const flake = flakes[n];
      const p = ((t + flake.phase) % flake.dur) / flake.dur;
      flake.el.style.transform = 'translateY(' + (-8 + p * 118).toFixed(2) + 'vh)';
    }
  }

  async function wake() {
    if (!('wakeLock' in navigator) || document.hidden) return;
    try {
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {}
  }

  function stepPlayer(now) {
    const wall = Date.now();
    if (armLive) {
      armLive = false;
      mediaLive = true;
      if (vid.error && (vid.getAttribute('src') || '') === expectedSrc && expectedSrc) {
        recover('error ' + labelOf(expectedSrc));
      }
    }

    if (cursorAt && stage.classList.contains('awake') && wall - cursorAt > CURSOR_IDLE_MS) {
      stage.classList.remove('awake');
    }

    if (boundaryAt && !reloadDue && wall >= boundaryAt) reloadDue = true;
    if (hardAt && wall >= hardAt) {
      if (navigate('hard', nextIndex(), false)) return;
    }

    if (wall - lastWakeAt >= 60000) {
      lastWakeAt = wall;
      wake();
    }

    if (debug && dbg && wall - lastDebugAt >= 1000) {
      lastDebugAt = wall;
      const up = Math.round((wall - Number(store.get('cb_since'))) / 60000);
      dbg.textContent = 'clip: ' + (clips.length ? (index + 1) + '/' + clips.length + '  ' + labelOf(clips[index]) : 'none')
        + '\nrunning: ' + up + ' min'
        + '\npage loads: ' + store.get('cb_loads')
        + '\nfailures: ' + failures
        + '\nlast problem: ' + (store.get('cb_err') || 'none');
    }

    if (paused || !clips.length || reloading || !expectedSrc) {
      lastAdvanceAt = wall;
      return;
    }

    if (now - lastBarAt >= 250) {
      lastBarAt = now;
      const duration = vid.duration;
      if (duration && isFinite(duration) && duration > 0) {
        bar.style.width = Math.min(100, (100 * vid.currentTime) / duration) + '%';
      }
      if (vid.currentTime > lastMediaTime + 0.05) {
        lastMediaTime = vid.currentTime;
        lastAdvanceAt = wall;
        if (vid.currentTime > 0.4) {
          if (failures) {
            failures = 0;
            publish();
          }
        }
        if (!sawFrame && vid.currentTime > 1 && vid.readyState >= 2) {
          if (vid.videoWidth > 0) sawFrame = true;
          else recover('no frames ' + labelOf(expectedSrc));
        }
      }
    }

    if (wall - clipStartedAt > maxClip * 1000) {
      advance(generation);
      return;
    }
    if (wall - lastAdvanceAt > stallSeconds * 1000) {
      lastAdvanceAt = wall;
      recover('frozen ' + labelOf(expectedSrc));
    }
  }

  function frame(now) {
    rafId = 0;
    if (document.hidden || reloading) return;
    if (pendingRecover) {
      const reason = pendingRecover;
      pendingRecover = '';
      applyRecover(reason);
      if (reloading || document.hidden) return;
    }
    if (!reduceMotion && now - lastSnowAt >= 32) {
      lastSnowAt = now;
      stepSnow(now);
    }
    stepPlayer(now);
    if (!reloading && !document.hidden) rafId = requestAnimationFrame(frame);
  }

  function startLoop() {
    if (rafId || document.hidden || reloading) return;
    rafId = requestAnimationFrame(frame);
  }

  function shiftClocks(from) {
    if (!from) return;
    const held = Date.now() - from;
    clipStartedAt += held;
    lastAdvanceAt += held;
  }

  function onVisible() {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      hiddenAt = Date.now();
      lastAdvanceAt = hiddenAt;
      return;
    }
    shiftClocks(hiddenAt);
    hiddenAt = 0;
    wake();
    paintCountdown();
    if (pendingReload || (hardAt && Date.now() >= hardAt)) {
      navigate(pendingReload || 'hard', nextIndex(), false);
      return;
    }
    if (!paused && expectedSrc && vid.paused && !reloading) playClip(generation);
    startLoop();
  }

  addEventListener('online', () => {
    if (reloading) return;
    if (pendingReload || (hardAt && Date.now() >= hardAt)) {
      navigate(pendingReload || 'hard', nextIndex(), false);
      return;
    }
    if (paused || !clips.length) return;
    if (!expectedSrc || vid.error || vid.networkState === 3) show(index);
    else if (vid.paused) playClip(generation);
    startLoop();
  });

  // Log only. Reloading from here used to reboot-loop when play() threw.
  window.onerror = (msg) => { note('error: ' + msg); };

  document.addEventListener('visibilitychange', onVisible);

  if (debug) {
    dbg = document.createElement('div');
    dbg.style.cssText = 'position:fixed;left:28px;bottom:28px;z-index:9;background:rgba(0,0,0,.75);color:#f4e4b0;font:16px/1.4 monospace;padding:8px 10px;border-radius:6px;white-space:pre';
    document.body.appendChild(dbg);
  }

  buildSnow();
  paintCountdown();
  // One interval for the life of the page. A scheduled reload starts a fresh one.
  let countdownTimer = 0;
  function startCountdown() {
    if (countdownTimer) return;
    countdownTimer = setInterval(() => {
      if (document.hidden) return;
      paintCountdown();
    }, 1000);
  }
  startCountdown();
  lastWakeAt = Date.now();
  wake();
  startLoop();

  function startIndex() {
    // ?cb= means this load is a board reload. Resume at cb_next, not ?slide=.
    if (!params.has('cb') && params.has('slide')) {
      const q = Number(params.get('slide'));
      if (isFinite(q)) return Math.max(1, Math.floor(q)) - 1;
    }
    const raw = store.get('cb_next');
    if (raw) {
      const n = Number(raw);
      store.set('cb_next', '');
      if (isFinite(n) && n >= 0 && clips.length) return n % clips.length;
    }
    return 0;
  }

  if (!clips.length) showEmpty();
  else show(startIndex());
})();
