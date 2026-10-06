// 夜's aurora for the web: AuroraGo's curtain (Render/Aurora.swift, ADR 0035 amended 2026-09-27) ported
// line for line — the rays placed on the CPU each frame off the seconds and a seed, splatted by a fragment
// shader at one texel a CSS pixel, screened onto the sky; the stars on their own canvas at the display's
// resolution. Moves at the display's rate while on screen and visible; still at second zero under
// prefers-reduced-motion; without WebGL2 it calls `fallback` and draws only the stars. AuroraSky.attach({aurora, stars,
// shape, seed, fallback}); `shape` is {border, rayLength, starEnd}
// in CSS pixels from the host's top, or a function returning one, read again on every resize.
(function () {
  'use strict';
  var C = {
    zenith: 2400, exposure: 0.78, lip: 0.6, violet: 0.30, backRise: 34, backWeight: 0.42, glow: 16, margin: 70,
    green: [0x33 / 255, 0xff / 255, 0x57 / 255], violetRGB: [0x8c / 255, 0x1f / 255, 0x9e / 255]
  };
  function setting(back) {
    var s = {
      rays: 120,
      meanders: [[12, 520, 44, 0.3], [6, 300, -29, 1.7], [2, 43, 4.2, 0.5]],
      wander: [9, 110, 3.5],
      fold: 0.42, foldLength: 240, foldPeriod: 60, envelopeLength: 300, envelopeSpeed: 3,
      shimmer: [8.5, 5, 14, -3], surge: [170, 4, 0.5], length: 0.95
    };
    if (back) { s.fold *= 0.7; s.length *= 0.8; }
    return s;
  }
  var FRONT = setting(false), BACK = setting(true);
  function fract(x) { return x - Math.floor(x); }
  function hash(n) { return fract(Math.sin(n * 127.1 + 311.7) * 43758.5453); }
  function noise(x) { var i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash(i) * (1 - u) + hash(i + 1) * u; }
  function fbm(x) { return noise(x) * 0.55 + noise(x * 2.07 + 13.1) * 0.3 + noise(x * 4.13 + 71.7) * 0.15; }
  function smooth(a, b, x) { var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
  var TAU = 2 * Math.PI;

  function curtain(s, n, t, width, yB, H, seed, row) {
    var du = (width + 2 * C.margin) / n, k = seed * 17.3 + row * 101.7, out = [];
    for (var i = 0; i < n; i++) {
      var u = -C.margin + (i + 0.5) * du, y = yB;
      for (var m = 0; m < s.meanders.length; m++) {
        var me = s.meanders[m];
        y += me[0] * Math.sin(TAU * u / me[1] - TAU * t / me[2] + me[3] + k);
      }
      y += s.wander[0] * (fbm(u / s.wander[1] - t * s.wander[2] / s.wander[1] + k) - 0.5) * 2;
      var envelope = smooth(0.3, 0.8, fbm(u / s.envelopeLength - t * s.envelopeSpeed / s.envelopeLength + 5.3 + k));
      var fold = s.fold * (0.35 + 0.65 * envelope);
      var x = u + fold * (s.foldLength / TAU) * Math.sin(TAU * u / s.foldLength - TAU * t / s.foldPeriod + 0.8 + k);
      var sh = s.shimmer;
      var r = fbm(u / sh[0] - t * sh[1] / sh[0] + k) * 0.62 + fbm(u / sh[2] - t * sh[3] / sh[2] + 50 + k) * 0.38;
      r = Math.pow(Math.min(1, Math.max(0, (r - 0.18) / 0.72)), 1.5);
      var surge = (1 - s.surge[2]) + s.surge[2] * smooth(0.28, 0.78, fbm(u / s.surge[0] - t * s.surge[1] / s.surge[0] + 9 + k));
      var weight = (0.2 + 0.8 * r) * surge;
      var len = H * (0.62 + 0.8 * fbm(u / 21 + 31 + t * 0.04 + k));
      out.push([x, y, weight, len]);
    }
    out.sort(function (a, b) { return a[0] - b[0]; });
    return { rays: out, spacing: du };
  }

  function rays(t, width, shape, seed) {
    var density = Math.min(1.75, (width + 2 * C.margin) / 542);
    var fc = Math.round(FRONT.rays * density), bc = Math.round(fc * 0.6);
    var f = curtain(FRONT, fc, t, width, shape.border, shape.rayLength * FRONT.length, seed, 0);
    var b = curtain(BACK, bc, t * 0.8 + 37, width, shape.border - C.backRise, shape.rayLength * BACK.length, seed + 3, 1);
    var lowest = -Infinity, highest = Infinity, all = f.rays.concat(b.rays);
    for (var i = 0; i < all.length; i++) { lowest = Math.max(lowest, all[i][1]); highest = Math.min(highest, all[i][1]); }
    var lean = (width / 2 + C.margin) * lowest / (highest + C.zenith);
    return { front: f.rays, back: b.rays, fs: f.spacing, bs: b.spacing, reach: 3 * C.glow + lean + 2 };
  }

  var VS = '#version 300 es\nvoid main(){vec2 c[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));gl_Position=vec4(c[gl_VertexID],0,1);}';
  var FS = [
    '#version 300 es',
    'precision highp float; precision highp int;',
    'uniform highp sampler2D uRays;',
    'uniform int uFront, uBack; uniform float uFs, uBs, uWidth, uHeight, uZenith, uExposure, uLip, uViolet, uGlow, uReach, uBackW, uStrength;',
    'uniform vec3 uGreen, uVioletRGB;',
    'out vec4 o;',
    'vec3 curtainAt(vec2 q, int start, int n, float du){',
    '  float lo=q.x-uReach, hi=q.x+uReach; int a=0, b=n;',
    '  for(int it=0; it<12; it++){ if(a>=b) break; int m=(a+b)/2; if(texelFetch(uRays, ivec2(start+m,0),0).x<lo) a=m+1; else b=m; }',
    '  float sigma=0.9*du, sb=uGlow; float fine=du/(sigma*2.5066), broad=0.22*du/(sb*2.5066);',
    '  vec3 e=vec3(0);',
    '  for(int i=a; i<n; i++){',
    '    vec4 r=texelFetch(uRays, ivec2(start+i,0),0); if(r.x>hi) break;',
    '    float h=r.y-q.y, hx=max(h,0.0);',
    '    float xr=r.x+(uWidth*0.5-r.x)*hx/max(r.y+uZenith,1.0); float dx=q.x-xr;',
    '    float k=fine*exp(-dx*dx/(2.0*sigma*sigma))+broad*exp(-dx*dx/(2.0*sb*sb));',
    '    float len=max(r.w,4.0);',
    '    float v=h<0.0 ? exp(h/2.4)+0.12*exp(h/18.0) : exp(-h/len)*(1.0+uLip*exp(-h/5.0));',
    '    float high=h>0.0 ? uViolet*exp(-h/(2.6*len))*smoothstep(0.35*len,1.3*len,h) : 0.0;',
    '    e+=r.z*k*(uGreen*v+uVioletRGB*high);',
    '  }',
    '  return e;',
    '}',
    'void main(){',
    '  vec2 q=vec2(gl_FragCoord.x, uHeight-gl_FragCoord.y);',
    '  vec3 e=curtainAt(q,0,uFront,uFs)+curtainAt(q,uFront,uBack,uBs)*uBackW;',
    '  o=vec4((1.0-exp(-e*uExposure))*uStrength,1.0);',
    '}'
  ].join('\n');

  function hash21(x, y) {
    x = fract(x * 123.34); y = fract(y * 456.21);
    var d = x * (x + 45.32) + y * (y + 45.32);
    x += d; y += d;
    return fract(x * y);
  }

  function drawStars(cv, width, height, starEnd) {
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr); cv.height = Math.round(height * dpr);
    cv.style.width = width + 'px'; cv.style.height = height + 'px';
    var g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#000'; g.fillRect(0, 0, width, height);
    for (var cy = 0; cy * 23 < Math.min(height, starEnd); cy++) {
      for (var cx = 0; cx * 23 < width; cx++) {
        if (hash21(cx + 0.37, cy + 0.37) <= 0.66) continue;
        var sx = (cx + hash21(cx + 7.1, cy + 7.1)) * 23, sy = (cy + hash21(cx + 3.3, cy + 3.3)) * 23;
        if (sy >= starEnd) continue;
        var sr = 0.35 + 0.55 * hash21(cx + 11.7, cy + 11.7), b = 0.18 + 0.62 * Math.pow(hash21(cx + 5.9, cy + 5.9), 2);
        var halo = g.createRadialGradient(sx, sy, 0, sx, sy, sr * 5);
        halo.addColorStop(0, 'rgba(219,230,255,' + (0.25 * b) + ')');
        halo.addColorStop(1, 'rgba(219,230,255,0)');
        g.fillStyle = halo; g.beginPath(); g.arc(sx, sy, sr * 5, 0, TAU); g.fill();
        g.fillStyle = 'rgba(219,230,255,' + b + ')'; g.beginPath(); g.arc(sx, sy, Math.max(sr, 0.5), 0, TAU); g.fill();
      }
    }
  }

  function attach(o) {
    var cv = o.aurora, shapeOf = typeof o.shape === 'function' ? o.shape : function () { return o.shape; }, shape = shapeOf(), seed = o.seed == null ? 1.3 : o.seed;
    var host = cv.parentElement, width = 0, height = 0;
    var gl = cv.getContext('webgl2', { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
    var prog = null, tex = null, U = {};
    if (gl) {
      var sh = function (type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { gl = null; }
    }
    if (!gl && o.fallback) o.fallback();
    if (gl) {
      gl.useProgram(prog);
      ['uRays', 'uFront', 'uBack', 'uFs', 'uBs', 'uWidth', 'uHeight', 'uZenith', 'uExposure', 'uLip', 'uViolet', 'uGlow', 'uReach',
        'uBackW', 'uStrength', 'uGreen', 'uVioletRGB'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
      tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(U.uRays, 0);
      gl.uniform1f(U.uZenith, C.zenith); gl.uniform1f(U.uExposure, C.exposure); gl.uniform1f(U.uLip, C.lip);
      gl.uniform1f(U.uViolet, C.violet); gl.uniform1f(U.uGlow, C.glow); gl.uniform1f(U.uBackW, C.backWeight);
      gl.uniform1f(U.uStrength, o.strength == null ? 1 : o.strength);
      gl.uniform3fv(U.uGreen, C.green); gl.uniform3fv(U.uVioletRGB, C.violetRGB);
    }

    function size() {
      shape = shapeOf();
      width = Math.round(host.clientWidth);
      height = Math.round(Math.max(shape.starEnd, shape.border + 60));
      cv.width = width; cv.height = height; cv.style.width = width + 'px'; cv.style.height = height + 'px';
      if (o.stars) drawStars(o.stars, width, height, shape.starEnd);
    }

    function draw(t) {
      if (!gl || !width) return;
      var r = rays(t, width, shape, seed), all = r.front.concat(r.back), data = new Float32Array(all.length * 4);
      for (var i = 0; i < all.length; i++) data.set(all[i], i * 4);
      gl.viewport(0, 0, width, height);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, all.length, 1, 0, gl.RGBA, gl.FLOAT, data);
      gl.uniform1i(U.uFront, r.front.length); gl.uniform1i(U.uBack, r.back.length);
      gl.uniform1f(U.uFs, r.fs); gl.uniform1f(U.uBs, r.bs); gl.uniform1f(U.uReach, r.reach);
      gl.uniform1f(U.uWidth, width); gl.uniform1f(U.uHeight, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // The clock banks seconds only while the sky runs, and resumes without a jump (AuroraClock).
    var still = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    var seconds = o.start || 0, last = null, raf = 0, onScreen = true, dead = false;
    function runs() { return !dead && onScreen && !document.hidden && !still.matches; }
    function frame(now) {
      raf = 0;
      if (!runs()) { last = null; return; }
      if (last != null) seconds += Math.min(0.1, (now - last) / 1000);
      last = now;
      draw(seconds);
      raf = requestAnimationFrame(frame);
    }
    function kick() { if (!raf && runs()) raf = requestAnimationFrame(frame); }

    size(); draw(seconds);
    var ro = window.ResizeObserver ? new ResizeObserver(function () { size(); draw(seconds); }) : null;
    if (ro) ro.observe(host);
    var io = window.IntersectionObserver ? new IntersectionObserver(function (es) { onScreen = es[0].isIntersecting; kick(); }) : null;
    if (io) io.observe(cv);
    document.addEventListener('visibilitychange', kick);
    if (still.addEventListener) still.addEventListener('change', kick);
    kick();
    return function () {
      dead = true; if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect(); if (io) io.disconnect();
      document.removeEventListener('visibilitychange', kick);
    };
  }

  window.AuroraSky = { attach: attach, rays: rays };
})();
