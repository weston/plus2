/*
 * cube-glue.js — plus2 glue for the vendored csTimer cube renderer.
 *
 * Provides the few globals csTimer's twisty.js/twistynnn.js expect (Math.TAU,
 * requestAnimFrame, and a CSTCFG config shim that replaces csTimer's `kernel`),
 * a WCA-notation -> csTimer-move parser, solved detection, and a small factory
 * `window.makeCstimerCube(container, opts)`.
 *
 * The vendored twisty.js / twistynnn.js / threemin.js / pnltri.js are GPL-3.0
 * (csTimer, https://github.com/cs0x7f/cstimer). See public/cstimer/NOTICE.
 */
(function () {
  'use strict';

  if (typeof Math.TAU === 'undefined') Math.TAU = Math.PI * 2;

  if (typeof window.requestAnimFrame === 'undefined') {
    window.requestAnimFrame = function (cb) {
      return (window.requestAnimationFrame || function (f) { return setTimeout(function () { f(Date.now()); }, 1000 / 60); })(cb);
    };
  }
  if (typeof window.cancelRequestAnimFrame === 'undefined') {
    window.cancelRequestAnimFrame = function (id) {
      return (window.cancelAnimationFrame || clearTimeout)(id);
    };
  }

  // Config shim standing in for csTimer's `kernel.getProp`.
  var _cfg = {
    vrcOri: '6,11',   // camera orientation: "theta+6,phi+6" (see twisty.js resize)
    vrcSpeed: 110,    // ~ms per quarter turn (bigger = slower)
    vrcFit: 1,        // canvas size as a fraction of the container (smaller = more margin)
    vrcMP: 'n',
    vrcAH: '01'
  };
  window.CSTCFG = {
    getProp: function (key, def) { return key in _cfg ? _cfg[key] : def; },
    set: function (key, val) { _cfg[key] = val; }
  };

  // ---- WCA notation -> csTimer move [startLayer, endLayer, face, power] ------
  var FACES = { R: 'R', L: 'L', U: 'U', D: 'D', F: 'F', B: 'B' };

  function parseWCA(token, dim) {
    token = String(token).trim();
    if (!token) return null;

    var hasPrime = token.indexOf("'") >= 0;
    var has2 = token.indexOf('2') >= 0;
    var pow = has2 ? 2 : 1;
    if (hasPrime) pow = -pow;

    var core = token.replace(/['2]/g, '');
    var lead = core.match(/^(\d+)/);
    var nlead = lead ? parseInt(lead[1], 10) : 0;
    core = core.replace(/^\d+/, '');

    var wide = false;
    if (/w$/.test(core)) { wide = true; core = core.slice(0, -1); }
    var letter = core;

    // Whole-cube rotations
    if (letter === 'x') return [1, dim, 'R', pow];
    if (letter === 'y') return [1, dim, 'U', pow];
    if (letter === 'z') return [1, dim, 'F', pow];

    // Slice moves (middle layer, csTimer convention)
    if (letter === 'M') return [2, 2, 'L', pow];
    if (letter === 'E') return [2, 2, 'U', pow];
    if (letter === 'S') return [2, 2, 'F', pow];

    // Lowercase single letters are wide moves (r, l, u, d, f, b)
    if (/^[rludfb]$/.test(letter)) { wide = true; letter = letter.toUpperCase(); }

    var face = FACES[letter];
    if (!face) return null;

    if (nlead >= 2) return [1, nlead, face, pow]; // e.g. 3Rw
    if (wide) return [1, 2, face, pow];
    return [1, 1, face, pow];
  }

  function isSolvedFacelet(fc, dim) {
    if (!fc) return false;
    var n = dim * dim;
    for (var f = 0; f < 6; f++) {
      var c = fc[f * n];
      for (var i = 1; i < n; i++) if (fc[f * n + i] !== c) return false;
    }
    return true;
  }

  var DEFAULT_COLORS = [0xffffff, 0xff0000, 0x00ff00, 0xffff00, 0xff9000, 0x0000ff];

  window.makeCstimerCube = function (container, opts) {
    opts = opts || {};
    var dim = opts.dimension || 3;
    if (opts.ori) _cfg.vrcOri = opts.ori;
    if (opts.speed != null) _cfg.vrcSpeed = opts.speed;
    if (opts.fit != null) _cfg.vrcFit = opts.fit;

    var scene = new window.twistyjs.TwistyScene();
    var dom = scene.getDomElement();
    container.appendChild(dom);

    if (opts.logoUrl) {
      // Applied after initializeTwisty below (setLogo loads async anyway).
      setTimeout(function () { setLogo(opts.logoUrl); }, 0);
    }

    var type = {
      type: 'cube',
      dimension: dim,
      faceColors: opts.faceColors || DEFAULT_COLORS,
      stickerBorder: true,
      stickerWidth: opts.stickerWidth || 1.72,
      doubleSided: true,
      scale: 1
    };
    scene.initializeTwisty(type);

    // Re-fetch the twisty each time — initializeTwisty() (used by reset) makes a new one.
    function tw() { return scene.getTwisty(); }

    // ---- Cube logo (image on the U-face center sticker) --------------------
    // The vintage CanvasRenderer textures MeshBasicMaterial via material.map =
    // { image, mapping } — no THREE.Texture needed. The logo image is
    // composited over the face color first so transparent PNGs look right.
    var currentLogoUrl = null;

    function makeLogoCanvas(url, bgColorNum, cb) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        var SIZE = 128, PAD = 12;
        var c = document.createElement('canvas');
        c.width = SIZE; c.height = SIZE;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#' + ('00000' + (bgColorNum >>> 0).toString(16)).slice(-6);
        ctx.fillRect(0, 0, SIZE, SIZE);
        var s = Math.min((SIZE - 2 * PAD) / img.width, (SIZE - 2 * PAD) / img.height);
        var w = img.width * s, h = img.height * s;
        ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
        cb(c);
      };
      img.onerror = function () { cb(null); };
      img.src = url;
    }

    function applyLogoCanvas(canvas) {
      var t = tw();
      if (!t || !t.logoMaterial) return;
      // This minified THREE build references UVMapping in its textured-face
      // path but the class itself was stripped — supply it (the renderer only
      // does an instanceof check).
      if (!window.THREE.UVMapping) window.THREE.UVMapping = function () {};
      t.logoMaterial.map = canvas ? { image: canvas, mapping: new window.THREE.UVMapping() } : null;
      scene.resize(); // triggers a re-render
    }

    function setLogo(url) {
      currentLogoUrl = url || null;
      if (!currentLogoUrl) { applyLogoCanvas(null); return; }
      var want = currentLogoUrl;
      makeLogoCanvas(want, (opts.faceColors || DEFAULT_COLORS)[0], function (canvas) {
        if (want === currentLogoUrl && canvas) applyLogoCanvas(canvas);
      });
    }

    // Fire onSolved exactly once each time a move leaves the cube solved (so the
    // page can auto-stop the timer). Re-arms when the cube leaves the solved state.
    // committedCount tracks every committed move (scramble replay included) so
    // pages can identify exactly which move solved the cube and trim trailing
    // accidental inputs (see getCommitted/getSolvedAt).
    var solvedFired = false;
    var committedCount = 0;
    var solvedAtCount = -1;
    scene.addMoveListener(function (move, step) {
      if (step !== 2) return; // 2 = move animation finished (state committed)
      committedCount++;
      var solved = isSolvedFacelet(tw().getFacelet(tw()), dim);
      if (solved && !solvedFired) {
        solvedFired = true;
        solvedAtCount = committedCount;
        if (typeof opts.onSolved === 'function') opts.onSolved();
      } else if (!solved) {
        solvedFired = false;
      }
    });

    function applyMove(token, animate) {
      var mv = parseWCA(token, dim);
      if (!mv) return;
      if (animate) scene.addMoves([mv]);
      else scene.applyMoves([mv]);
    }

    return {
      scene: scene,
      dom: dom,
      applyMove: applyMove,
      applySeq: function (str, animate) {
        String(str).trim().split(/\s+/).forEach(function (t) { if (t) applyMove(t, animate); });
      },
      getFacelet: function () { return tw().getFacelet(tw()); },
      isSolved: function () { return isSolvedFacelet(tw().getFacelet(tw()), dim); },
      resize: function () { scene.resize(); },
      reset: function () {
        scene.initializeTwisty(type); // back to solved (fresh twisty)
        if (currentLogoUrl) setLogo(currentLogoUrl); // re-texture the new center sticker
      },
      setLogo: setLogo,
      getCommitted: function () { return committedCount; },
      getSolvedAt: function () { return solvedAtCount; },
      setSpeed: function (v) { _cfg.vrcSpeed = v; },
      setOri: function (o) { _cfg.vrcOri = o; scene.resize(); }
    };
  };
})();
