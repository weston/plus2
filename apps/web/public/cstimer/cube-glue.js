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
      reset: function () { scene.initializeTwisty(type); }, // back to solved
      setSpeed: function (v) { _cfg.vrcSpeed = v; },
      setOri: function (o) { _cfg.vrcOri = o; scene.resize(); }
    };
  };
})();
