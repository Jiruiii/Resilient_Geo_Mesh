(function installLocatorSiren(global) {
  // Web half of the locator siren. Browsers only allow audio after a user
  // gesture, so locatorSirenStart() must be called from the tap handler and
  // resumes the AudioContext before its first await. Background tabs and a
  // locked screen may still be throttled; the UI says so and this script
  // flags a hidden page instead of claiming the tone is still audible.
  const PLAY_DURATION_MS = 60 * 1000;
  let audioContext = null;
  let buffer = null;
  let source = null;
  let timer = null;
  let listener = null;
  let status = { phase: 'IDLE', reason: null, ends_at_epoch_ms: null, warnings: [] };

  function emit(next) {
    status = { phase: next.phase, reason: next.reason ?? null, ends_at_epoch_ms: next.ends_at_epoch_ms ?? null, warnings: next.warnings ?? [] };
    if (listener) listener(JSON.stringify(status));
    return status;
  }

  function release() {
    if (timer !== null) global.clearTimeout(timer);
    timer = null;
    if (source) {
      try { source.stop(); } catch { /* already stopped */ }
      try { source.disconnect(); } catch { /* not connected */ }
    }
    source = null;
  }

  async function loadBuffer() {
    if (buffer) return buffer;
    const url = new URL('audio/locator_siren.wav', global.document?.baseURI ?? global.location.href);
    const response = await global.fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error('audio_init_failed');
    buffer = await audioContext.decodeAudioData(await response.arrayBuffer());
    return buffer;
  }

  function start() {
    if (status.phase === 'PLAYING' || status.phase === 'STARTING') return Promise.resolve(status);
    const AudioContextClass = global.AudioContext ?? global.webkitAudioContext;
    if (!AudioContextClass) return Promise.resolve(emit({ phase: 'FAILED', reason: 'unsupported' }));
    emit({ phase: 'STARTING' });
    let resumed;
    try {
      audioContext ??= new AudioContextClass();
      resumed = audioContext.resume(); // still inside the user's tap
    } catch {
      return Promise.resolve(emit({ phase: 'FAILED', reason: 'audio_init_failed' }));
    }
    return (async () => {
      try {
        await resumed;
        if (audioContext.state !== 'running') return emit({ phase: 'FAILED', reason: 'browser_blocked' });
        const tone = await loadBuffer();
        release();
        source = audioContext.createBufferSource();
        source.buffer = tone;
        source.loop = true;
        source.connect(audioContext.destination);
        source.start();
        timer = global.setTimeout(() => {
          release();
          emit({ phase: 'AUTO_STOPPED' });
        }, PLAY_DURATION_MS);
        return emit({ phase: 'PLAYING', ends_at_epoch_ms: Date.now() + PLAY_DURATION_MS, warnings: global.document?.hidden ? ['page_hidden'] : [] });
      } catch (error) {
        release();
        const reason = error?.message === 'browser_blocked' ? 'browser_blocked' : 'audio_init_failed';
        return emit({ phase: 'FAILED', reason });
      }
    })();
  }

  function stop() {
    release();
    return emit({ phase: 'IDLE' });
  }

  global.document?.addEventListener?.('visibilitychange', () => {
    if (status.phase !== 'PLAYING') return;
    const warnings = global.document.hidden ? ['page_hidden'] : [];
    emit({ ...status, warnings });
  });

  const exported = (run) => async (...args) => {
    try {
      return JSON.stringify({ ok: true, value: await run(...args) });
    } catch (error) {
      return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
    }
  };

  // Not async: start() must reach AudioContext.resume() synchronously.
  global.locatorSirenStart = (...args) => exported(start)(...args);
  global.locatorSirenStop = exported(stop);
  global.locatorSirenStatus = exported(() => status);
  global.locatorSirenSetListener = (callback) => { listener = typeof callback === 'function' ? callback : null; };
})(globalThis);
