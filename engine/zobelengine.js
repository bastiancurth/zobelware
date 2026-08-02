/* ======================================================================
   ZobelEngine - eine kleine 2D-Engine, zugeschnitten auf ZobelWare.
   Kein Fremdcode, keine Abhängigkeiten.

   Aufbau:
     GL        - WebGL2-Kontext, Shader, Rahmenpuffer
     Batch     - sammelt Sprites und zeichnet sie in möglichst wenigen Zügen
     Post      - Nachbearbeitung (Bloom, Vignette, Scanlines, Farbversatz)
     Textures  - Bilder laden und Texturen zur Laufzeit erzeugen
     Text      - Schrift über ein Canvas, Ergebnis wird zwischengespeichert
     Display   - Anzeigeobjekte (Bild, Rechteck, Kreis, Dreieck, Text)
     Tweens    - Animationen mit Ease-Funktionen
     Clock     - Verzögerungen und wiederkehrende Ereignisse
     Input     - Tastatur, Maus, Touch
     Scene     - Szenenverwaltung
   ====================================================================== */
(function (global) {
'use strict';

// ---------------------------------------------------------------- Mathe
const Ease = {
    Linear: t => t,
    QuadIn: t => t * t,
    QuadOut: t => t * (2 - t),
    QuadInOut: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
    CubicOut: t => (--t) * t * t + 1,
    SineInOut: t => -(Math.cos(Math.PI * t) - 1) / 2,
    BackOut: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    BounceOut: t => {
        const n = 7.5625, d = 2.75;
        if (t < 1 / d) return n * t * t;
        if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
        if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
        return n * (t -= 2.625 / d) * t + 0.984375;
    },
    ElasticOut: t => t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1
};

const M = {
    clamp: (v, a, b) => v < a ? a : (v > b ? b : v),
    between: (a, b) => a + Math.random() * (b - a),
    intBetween: (a, b) => Math.floor(a + Math.random() * (b - a + 1)),
    pick: arr => arr[Math.floor(Math.random() * arr.length)],
    shuffle: arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
    dist: (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1),
    lerp: (a, b, t) => a + (b - a) * t,
    // Farbe zwischen zwei Werten mischen (0xRRGGBB)
    mix(c1, c2, t) {
        const r1 = (c1 >> 16) & 255, g1 = (c1 >> 8) & 255, b1 = c1 & 255;
        const r2 = (c2 >> 16) & 255, g2 = (c2 >> 8) & 255, b2 = c2 & 255;
        return ((r1 + (r2 - r1) * t) << 16 | (g1 + (g2 - g1) * t) << 8 | (b1 + (b2 - b1) * t)) & 0xffffff;
    }
};

// ---------------------------------------------------------------- Shader
const VERT = `#version 300 es
in vec2 aPos; in vec2 aUV; in vec4 aTint; in float aTex;
uniform vec2 uRes;
out vec2 vUV; out vec4 vTint; out float vTex;
void main() {
  vUV = aUV; vTint = aTint; vTex = aTex;
  vec2 c = (aPos / uRes) * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

// Bis zu acht Texturen in einem Zug - spart Zeichenaufrufe
const FRAG = `#version 300 es
precision highp float;
in vec2 vUV; in vec4 vTint; in float vTex;
uniform sampler2D uTex[8];
out vec4 frag;
vec4 texAt(int i, vec2 uv) {
  if (i == 0) return texture(uTex[0], uv);
  if (i == 1) return texture(uTex[1], uv);
  if (i == 2) return texture(uTex[2], uv);
  if (i == 3) return texture(uTex[3], uv);
  if (i == 4) return texture(uTex[4], uv);
  if (i == 5) return texture(uTex[5], uv);
  if (i == 6) return texture(uTex[6], uv);
  return texture(uTex[7], uv);
}
void main() {
  vec4 c = texAt(int(vTex + 0.5), vUV);
  frag = c * vTint;
  if (frag.a < 0.002) discard;
}`;

const QUAD_VERT = `#version 300 es
in vec2 aPos; out vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Helle Bereiche herausfiltern - Grundlage fürs Leuchten
const BRIGHT_FRAG = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uSrc; uniform float uThreshold; out vec4 frag;
void main() {
  vec3 c = texture(uSrc, vUV).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  frag = vec4(c * smoothstep(uThreshold, uThreshold + 0.28, l), 1.0);
}`;

// Weichzeichner in einer Richtung, zweimal angewandt ergibt das Leuchten
const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uSrc; uniform vec2 uDir; out vec4 frag;
void main() {
  vec3 sum = texture(uSrc, vUV).rgb * 0.2270270270;
  sum += texture(uSrc, vUV + uDir * 1.3846153846).rgb * 0.3162162162;
  sum += texture(uSrc, vUV - uDir * 1.3846153846).rgb * 0.3162162162;
  sum += texture(uSrc, vUV + uDir * 3.2307692308).rgb * 0.0702702703;
  sum += texture(uSrc, vUV - uDir * 3.2307692308).rgb * 0.0702702703;
  frag = vec4(sum, 1.0);
}`;

// Alles zusammenführen: Leuchten, Farbversatz, Scanlines, Vignette, Wölbung
const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene; uniform sampler2D uBloom;
uniform float uBloomAmt, uVignette, uScanline, uAberration, uCurve, uTime, uFlashAmt;
uniform vec3 uFlashCol;
out vec4 frag;

vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 off = abs(uv.yx) / vec2(6.0, 5.0);
  uv += uv * off * off * uCurve;
  return uv * 0.5 + 0.5;
}

void main() {
  vec2 uv = uCurve > 0.0 ? curve(vUV) : vUV;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { frag = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Leichter Farbversatz zum Rand hin - wirkt wie eine echte Röhre
  vec2 d = (uv - 0.5) * uAberration;
  vec3 col;
  col.r = texture(uScene, uv + d).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, uv - d).b;

  col += texture(uBloom, uv).rgb * uBloomAmt;

  // Scanlines
  float sl = 1.0 - uScanline * (0.5 + 0.5 * sin(uv.y * 900.0));
  col *= sl;

  // Randabdunklung
  vec2 v = uv * (1.0 - uv.yx);
  float vig = pow(v.x * v.y * 22.0, uVignette);
  col *= clamp(vig, 0.0, 1.0);

  col = mix(col, uFlashCol, uFlashAmt);
  frag = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- Renderer
class Renderer {
    constructor(canvas, width, height) {
        this.canvas = canvas;
        this.width = width; this.height = height;
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
        if (!gl) throw new Error('WebGL2 wird nicht unterstützt');
        this.gl = gl;

        this.progSprite = this.program(VERT, FRAG);
        this.progBright = this.program(QUAD_VERT, BRIGHT_FRAG);
        this.progBlur = this.program(QUAD_VERT, BLUR_FRAG);
        this.progComposite = this.program(QUAD_VERT, COMPOSITE_FRAG);

        this.MAX = 4000;                       // Sprites pro Zug
        this.stride = 9;                       // x,y,u,v,r,g,b,a,tex
        this.data = new Float32Array(this.MAX * 4 * this.stride);
        this.count = 0;
        this.setupBuffers();
        this.setupTargets();

        this.slots = [];                       // aktuell gebundene Texturen
        this.blend = 'normal';
        this.drawCalls = 0;

        // Effektregler
        this.fx = { bloom: 0.85, vignette: 0.28, scanline: 0.06, aberration: 0.0016, curve: 0.06, flashAmt: 0, flashCol: [1, 1, 1] };
        this.time = 0;
    }

    program(vsSrc, fsSrc) {
        const gl = this.gl;
        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
            return s;
        };
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
        return p;
    }

    setupBuffers() {
        const gl = this.gl;
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
        const S = this.stride * 4;
        const loc = (name, size, off) => {
            const l = gl.getAttribLocation(this.progSprite, name);
            gl.enableVertexAttribArray(l);
            gl.vertexAttribPointer(l, size, gl.FLOAT, false, S, off * 4);
        };
        loc('aPos', 2, 0); loc('aUV', 2, 2); loc('aTint', 4, 4); loc('aTex', 1, 8);

        // Feste Indexliste: zwei Dreiecke je Sprite
        const idx = new Uint16Array(this.MAX * 6);
        for (let i = 0; i < this.MAX; i++) {
            const o = i * 4;
            idx.set([o, o + 1, o + 2, o, o + 2, o + 3], i * 6);
        }
        this.ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);

        // Vollbild-Viereck für die Nachbearbeitung
        this.quadVao = gl.createVertexArray();
        gl.bindVertexArray(this.quadVao);
        const qb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, qb);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        [this.progBright, this.progBlur, this.progComposite].forEach(p => {
            const l = gl.getAttribLocation(p, 'aPos');
            if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0); }
        });
        gl.bindVertexArray(null);
    }

    target(w, h) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { tex, fbo, w, h };
    }

    setupTargets() {
        const w = this.width, h = this.height;
        this.sceneRT = this.target(w, h);
        // Das Leuchten wird in Viertelauflösung berechnet - kaum sichtbar, viel billiger
        this.bloomA = this.target(w >> 2, h >> 2);
        this.bloomB = this.target(w >> 2, h >> 2);
    }

    // -------------------------------------------------- Zeichnen
    beginFrame() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneRT.fbo);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.useProgram(this.progSprite);
        gl.uniform2f(gl.getUniformLocation(this.progSprite, 'uRes'), this.width, this.height);
        gl.uniform1iv(gl.getUniformLocation(this.progSprite, 'uTex'), [0, 1, 2, 3, 4, 5, 6, 7]);
        gl.bindVertexArray(this.vao);
        this.slots = []; this.count = 0; this.drawCalls = 0;
        this.setBlend('normal');
    }

    setBlend(mode) {
        if (mode === this.blend) return;
        this.flush();
        const gl = this.gl;
        this.blend = mode;
        if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
        else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    slotFor(texture) {
        let i = this.slots.indexOf(texture);
        if (i >= 0) return i;
        if (this.slots.length >= 8) { this.flush(); this.slots = []; }
        this.slots.push(texture);
        return this.slots.length - 1;
    }

    // Ein gedrehtes, skaliertes Sprite in den Sammler legen
    push(texture, x, y, w, h, ox, oy, rot, r, g, b, a, u0, v0, u1, v1) {
        if (this.count >= this.MAX) this.flush();
        const slot = this.slotFor(texture);
        const d = this.data;
        let o = this.count * 4 * this.stride;

        const px = -ox * w, py = -oy * h;
        const c = rot ? Math.cos(rot) : 1, s = rot ? Math.sin(rot) : 0;
        const corners = [px, py, px + w, py, px + w, py + h, px, py + h];
        const uvs = [u0, v0, u1, v0, u1, v1, u0, v1];

        for (let i = 0; i < 4; i++) {
            const cx = corners[i * 2], cy = corners[i * 2 + 1];
            d[o++] = x + cx * c - cy * s;
            d[o++] = y + cx * s + cy * c;
            d[o++] = uvs[i * 2]; d[o++] = uvs[i * 2 + 1];
            d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
            d[o++] = slot;
        }
        this.count++;
    }

    flush() {
        if (this.count === 0) return;
        const gl = this.gl;
        for (let i = 0; i < this.slots.length; i++) {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, this.slots[i]);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * 4 * this.stride);
        gl.drawElements(gl.TRIANGLES, this.count * 6, gl.UNSIGNED_SHORT, 0);
        this.count = 0;
        this.drawCalls++;
    }

    endFrame() {
        this.flush();
        const gl = this.gl;
        gl.bindVertexArray(this.quadVao);
        gl.disable(gl.BLEND);

        const useBloom = this.fx.bloom > 0.01;
        if (useBloom) {
            // Helle Stellen herausziehen
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo);
            gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
            gl.useProgram(this.progBright);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneRT.tex);
            gl.uniform1i(gl.getUniformLocation(this.progBright, 'uSrc'), 0);
            gl.uniform1f(gl.getUniformLocation(this.progBright, 'uThreshold'), 0.55);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            // Zweimal weichzeichnen (waagerecht, senkrecht)
            gl.useProgram(this.progBlur);
            gl.uniform1i(gl.getUniformLocation(this.progBlur, 'uSrc'), 0);
            const dirLoc = gl.getUniformLocation(this.progBlur, 'uDir');
            for (let pass = 0; pass < 2; pass++) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fbo);
                gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
                gl.uniform2f(dirLoc, 1.4 / this.bloomA.w, 0);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo);
                gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.bloomB.tex);
                gl.uniform2f(dirLoc, 0, 1.4 / this.bloomA.h);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            }
        }

        // Alles zusammensetzen und auf den Bildschirm bringen
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.progComposite);
        const u = n => gl.getUniformLocation(this.progComposite, n);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneRT.tex);
        gl.uniform1i(u('uScene'), 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, useBloom ? this.bloomA.tex : this.sceneRT.tex);
        gl.uniform1i(u('uBloom'), 1);
        gl.uniform1f(u('uBloomAmt'), useBloom ? this.fx.bloom : 0);
        gl.uniform1f(u('uVignette'), this.fx.vignette);
        gl.uniform1f(u('uScanline'), this.fx.scanline);
        gl.uniform1f(u('uAberration'), this.fx.aberration);
        gl.uniform1f(u('uCurve'), this.fx.curve);
        gl.uniform1f(u('uTime'), this.time);
        gl.uniform1f(u('uFlashAmt'), this.fx.flashAmt);
        gl.uniform3fv(u('uFlashCol'), this.fx.flashCol);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
    }
}

// ---------------------------------------------------------------- Texturen
class Textures {
    constructor(gl) { this.gl = gl; this.map = new Map(); }

    fromCanvas(key, canvas) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const entry = { tex, w: canvas.width, h: canvas.height, frames: null };
        this.map.set(key, entry);
        return entry;
    }

    // Zeichenfläche anlegen und daraus eine Textur machen
    make(key, w, h, draw) {
        if (this.map.has(key)) return this.map.get(key);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        draw(c.getContext('2d'), w, h);
        return this.fromCanvas(key, c);
    }

    load(key, url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = img.width; c.height = img.height;
                c.getContext('2d').drawImage(img, 0, 0);
                resolve(this.fromCanvas(key, c));
            };
            // Fehlt ein Bild, wird ein sichtbarer Platzhalter erzeugt statt abzustürzen
            img.onerror = () => {
                this.make(key, 32, 32, (ctx) => {
                    ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 32, 32);
                    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 16, 16); ctx.fillRect(16, 16, 16, 16);
                });
                resolve(this.map.get(key));
            };
            img.src = url;
        });
    }

    // Spritesheet: gleichmäßiges Raster über eine Textur
    sheet(key, url, fw, fh) {
        return this.load(key, url).then(e => {
            e.frames = [];
            const cols = Math.floor(e.w / fw), rows = Math.floor(e.h / fh);
            for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
                e.frames.push({ u0: x * fw / e.w, v0: y * fh / e.h, u1: (x + 1) * fw / e.w, v1: (y + 1) * fh / e.h, w: fw, h: fh });
            }
            return e;
        });
    }

    get(key) { return this.map.get(key); }
    has(key) { return this.map.has(key); }
}

// ---------------------------------------------------------------- Schrift
class TextCache {
    constructor(textures) { this.textures = textures; this.n = 0; this.cache = new Map(); }

    key(str, style) {
        return str + '|' + style.font + '|' + style.fill + '|' + (style.stroke || '') + '|' +
               (style.strokeWidth || 0) + '|' + (style.glow || 0) + '|' + (style.glowColor || '');
    }

    // Text einmal auf ein Canvas zeichnen und als Textur behalten
    build(str, style) {
        const k = this.key(str, style);
        if (this.cache.has(k)) return this.cache.get(k);

        const pad = 12 + (style.glow || 0);
        const meas = document.createElement('canvas').getContext('2d');
        meas.font = style.font;
        const lines = String(str).split('\n');
        const lineH = (parseInt(style.font, 10) || 16) * 1.25;
        let w = 0;
        lines.forEach(l => { w = Math.max(w, meas.measureText(l).width); });
        const cw = Math.ceil(w + pad * 2), ch = Math.ceil(lineH * lines.length + pad * 2);

        const c = document.createElement('canvas');
        c.width = Math.max(2, cw); c.height = Math.max(2, ch);
        const ctx = c.getContext('2d');
        ctx.font = style.font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (style.glow) { ctx.shadowColor = style.glowColor || style.fill; ctx.shadowBlur = style.glow; }
        lines.forEach((l, i) => {
            const y = pad + lineH * (i + 0.5);
            if (style.stroke && style.strokeWidth) {
                ctx.lineWidth = style.strokeWidth * 2;
                ctx.strokeStyle = style.stroke;
                ctx.lineJoin = 'round';
                ctx.strokeText(l, cw / 2, y);
            }
            ctx.fillStyle = style.fill || '#ffffff';
            ctx.fillText(l, cw / 2, y);
        });

        const entry = this.textures.fromCanvas('__text' + (this.n++), c);
        this.cache.set(k, entry);
        // Zwischenspeicher begrenzen, sonst wächst er bei Zählern ins Uferlose
        if (this.cache.size > 400) {
            const first = this.cache.keys().next().value;
            this.cache.delete(first);
        }
        return entry;
    }
}

// ---------------------------------------------------------------- Anzeigeobjekte
let __id = 0;
class Node {
    constructor(scene) {
        this.scene = scene; this.id = __id++;
        this.x = 0; this.y = 0; this.rotation = 0;
        this.scaleX = 1; this.scaleY = 1;
        this.originX = 0.5; this.originY = 0.5;
        this.alpha = 1; this.visible = true; this.depth = 0;
        this.tint = 0xffffff; this.blend = 'normal';
        this.destroyed = false;
    }
    setPosition(x, y) { this.x = x; this.y = y; return this; }
    setScale(x, y) { this.scaleX = x; this.scaleY = y === undefined ? x : y; return this; }
    setOrigin(x, y) { this.originX = x; this.originY = y === undefined ? x : y; return this; }
    setAlpha(a) { this.alpha = a; return this; }
    setDepth(d) { this.depth = d; this.scene._sortDirty = true; return this; }
    setTint(c) { this.tint = c; return this; }
    setVisible(v) { this.visible = v; return this; }
    setBlend(b) { this.blend = b; return this; }
    setRotation(r) { this.rotation = r; return this; }
    get angle() { return this.rotation * 180 / Math.PI; }
    set angle(v) { this.rotation = v * Math.PI / 180; }
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.scene._remove(this);
    }
}

class Sprite extends Node {
    constructor(scene, texKey, frame) {
        super(scene);
        this.texKey = texKey;
        this.frame = frame === undefined ? null : frame;
        this.flipX = false;
        const t = scene.game.textures.get(texKey);
        this.baseW = t ? (t.frames ? t.frames[0].w : t.w) : 8;
        this.baseH = t ? (t.frames ? t.frames[0].h : t.h) : 8;
        this.displayW = null; this.displayH = null;
    }
    setFrame(f) { this.frame = f; return this; }
    setFlipX(v) { this.flipX = v; return this; }
    setDisplaySize(w, h) { this.displayW = w; this.displayH = h; return this; }
    get width() { return (this.displayW !== null ? this.displayW : this.baseW) * this.scaleX; }
    get height() { return (this.displayH !== null ? this.displayH : this.baseH) * this.scaleY; }
    render(r) {
        const t = this.scene.game.textures.get(this.texKey);
        if (!t) return;
        let u0 = 0, v0 = 0, u1 = 1, v1 = 1, bw = t.w, bh = t.h;
        if (t.frames && this.frame !== null) {
            const f = t.frames[this.frame] || t.frames[0];
            u0 = f.u0; v0 = f.v0; u1 = f.u1; v1 = f.v1; bw = f.w; bh = f.h;
        }
        if (this.flipX) { const tmp = u0; u0 = u1; u1 = tmp; }
        const w = (this.displayW !== null ? this.displayW : bw) * this.scaleX;
        const h = (this.displayH !== null ? this.displayH : bh) * this.scaleY;
        const c = this.tint;
        r.setBlend(this.blend);
        r.push(t.tex, this.x, this.y, w, h, this.originX, this.originY, this.rotation,
               ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, this.alpha, u0, v0, u1, v1);
    }
}

class Rect extends Node {
    constructor(scene, w, h, color, alpha) {
        super(scene);
        this.w = w; this.h = h; this.tint = color === undefined ? 0xffffff : color;
        this.alpha = alpha === undefined ? 1 : alpha;
        this.strokeColor = null; this.strokeWidth = 0;
    }
    setStroke(color, width) { this.strokeColor = color; this.strokeWidth = width; return this; }
    setSize(w, h) { this.w = w; this.h = h; return this; }
    get width() { return this.w * this.scaleX; }
    set width(v) { this.w = v / this.scaleX; }
    get height() { return this.h * this.scaleY; }
    set height(v) { this.h = v / this.scaleY; }
    render(r) {
        const px = this.scene.game.textures.get('__px');
        const c = this.tint;
        r.setBlend(this.blend);
        const w = this.w * this.scaleX, h = this.h * this.scaleY;
        r.push(px.tex, this.x, this.y, w, h, this.originX, this.originY, this.rotation,
               ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, this.alpha, 0, 0, 1, 1);
        if (this.strokeColor !== null && this.strokeWidth > 0) {
            const s = this.strokeWidth, sc = this.strokeColor;
            const sr = ((sc >> 16) & 255) / 255, sg = ((sc >> 8) & 255) / 255, sb = (sc & 255) / 255;
            const ox = this.originX, oy = this.originY;
            const left = this.x - ox * w, top = this.y - oy * h;
            const bar = (bx, by, bw, bh) => r.push(px.tex, bx, by, bw, bh, 0, 0, 0, sr, sg, sb, this.alpha, 0, 0, 1, 1);
            bar(left, top, w, s); bar(left, top + h - s, w, s);
            bar(left, top, s, h); bar(left + w - s, top, s, h);
        }
    }
}

class Ellipse extends Node {
    constructor(scene, radius, color, alpha) {
        super(scene);
        this.radius = radius; this.tint = color === undefined ? 0xffffff : color;
        this.alpha = alpha === undefined ? 1 : alpha;
        this.strokeColor = null; this.strokeWidth = 0;
    }
    setRadius(r) { this.radius = r; return this; }
    setStroke(color, width) { this.strokeColor = color; this.strokeWidth = width; return this; }
    get width() { return this.radius * 2 * this.scaleX; }
    render(r) {
        // Weicher Kreis aus einer Textur - kein Polygonzeichnen nötig
        const t = this.scene.game.textures.get(this.strokeColor !== null ? '__ring' : '__disc');
        const c = this.strokeColor !== null ? this.strokeColor : this.tint;
        const d = this.radius * 2 * this.scaleX;
        r.setBlend(this.blend);
        if (this.strokeColor !== null) {
            const f = this.scene.game.textures.get('__disc');
            const fc = this.tint;
            r.push(f.tex, this.x, this.y, d, d, 0.5, 0.5, this.rotation,
                   ((fc >> 16) & 255) / 255, ((fc >> 8) & 255) / 255, (fc & 255) / 255, this.alpha, 0, 0, 1, 1);
        }
        r.push(t.tex, this.x, this.y, d, d, 0.5, 0.5, this.rotation,
               ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, this.alpha, 0, 0, 1, 1);
    }
}

class Triangle extends Node {
    constructor(scene, size, color, alpha) {
        super(scene);
        this.size = size; this.tint = color === undefined ? 0xffffff : color;
        this.alpha = alpha === undefined ? 1 : alpha;
    }
    render(r) {
        const t = this.scene.game.textures.get('__tri');
        const c = this.tint;
        r.setBlend(this.blend);
        r.push(t.tex, this.x, this.y, this.size * this.scaleX, this.size * this.scaleY,
               0.5, 0.5, this.rotation,
               ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, this.alpha, 0, 0, 1, 1);
    }
}

class TextNode extends Node {
    constructor(scene, str, style) {
        super(scene);
        this.style = Object.assign({ font: '16px Orbitron, sans-serif', fill: '#ffffff' }, style || {});
        this.setText(str);
    }
    setText(str) {
        if (str === this._str) return this;
        this._str = String(str);
        this.entry = this.scene.game.text.build(this._str, this.style);
        return this;
    }
    setFill(c) { this.style.fill = c; this.entry = this.scene.game.text.build(this._str, this.style); return this; }
    get text() { return this._str; }
    get width() { return this.entry.w * this.scaleX; }
    get height() { return this.entry.h * this.scaleY; }
    render(r) {
        const c = this.tint;
        r.setBlend(this.blend);
        r.push(this.entry.tex, this.x, this.y, this.entry.w * this.scaleX, this.entry.h * this.scaleY,
               this.originX, this.originY, this.rotation,
               ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, this.alpha, 0, 0, 1, 1);
    }
}

// Partikel: ein kompaktes System ohne Objekt pro Teilchen
class Particles extends Node {
    constructor(scene, texKey, cfg) {
        super(scene);
        this.texKey = texKey;
        this.cfg = Object.assign({
            count: 20, speed: [60, 260], angle: [0, 360], life: [300, 700],
            scale: [0.6, 0], tint: [0xffffff], gravity: 0, blend: 'add'
        }, cfg || {});
        this.blend = this.cfg.blend;
        this.parts = [];
        this.originX = 0.5; this.originY = 0.5;
    }
    explode(n, x, y) {
        const c = this.cfg;
        const num = n || c.count;
        for (let i = 0; i < num; i++) {
            const a = M.between(c.angle[0], c.angle[1]) * Math.PI / 180;
            const sp = M.between(c.speed[0], c.speed[1]);
            this.parts.push({
                x: x === undefined ? this.x : x, y: y === undefined ? this.y : y,
                vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                life: 0, max: M.between(c.life[0], c.life[1]),
                tint: M.pick(c.tint), rot: Math.random() * 6.28, vr: M.between(-6, 6)
            });
        }
        return this;
    }
    update(dt) {
        const c = this.cfg;
        for (let i = this.parts.length - 1; i >= 0; i--) {
            const p = this.parts[i];
            p.life += dt * 1000;
            if (p.life >= p.max) { this.parts.splice(i, 1); continue; }
            p.vy += c.gravity * dt;
            p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        }
        if (this.parts.length === 0 && this.autoDestroy) this.destroy();
    }
    render(r) {
        const t = this.scene.game.textures.get(this.texKey);
        if (!t) return;
        r.setBlend(this.blend);
        const c = this.cfg;
        for (const p of this.parts) {
            const k = p.life / p.max;
            const s = M.lerp(c.scale[0], c.scale[1], k) * 64;
            const a = 1 - k;
            const col = p.tint;
            r.push(t.tex, p.x, p.y, s, s, 0.5, 0.5, p.rot,
                   ((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255, a, 0, 0, 1, 1);
        }
    }
}

// ---------------------------------------------------------------- Tweens
class Tweens {
    constructor(scene) { this.scene = scene; this.list = []; this.timeScale = 1; }
    add(cfg) {
        const targets = Array.isArray(cfg.targets) ? cfg.targets : [cfg.targets];
        const props = {};
        for (const k in cfg) {
            if (['targets', 'duration', 'ease', 'yoyo', 'repeat', 'delay', 'onComplete', 'onUpdate', 'hold'].includes(k)) continue;
            props[k] = cfg[k];
        }
        const t = {
            targets, props, duration: cfg.duration || 300,
            ease: typeof cfg.ease === 'function' ? cfg.ease : (Ease[cfg.ease] || Ease.Linear),
            yoyo: !!cfg.yoyo, repeat: cfg.repeat || 0, delay: cfg.delay || 0,
            onComplete: cfg.onComplete, onUpdate: cfg.onUpdate,
            elapsed: 0, started: false, reversing: false, done: false, from: null
        };
        this.list.push(t);
        return t;
    }
    killTweensOf(target) { this.list = this.list.filter(t => t.targets.indexOf(target) === -1); }
    update(dt) {
        const step = dt * 1000 * this.timeScale;
        for (let i = this.list.length - 1; i >= 0; i--) {
            const t = this.list[i];
            // Die Liste kann sich mitten im Durchlauf leeren, wenn ein
            // onComplete die Szene wechselt - dann still weitergehen.
            if (!t) continue;
            if (t.delay > 0) { t.delay -= step; continue; }
            if (!t.started) {
                t.started = true;
                t.from = t.targets.map(tg => {
                    const f = {};
                    for (const k in t.props) {
                        const spec = t.props[k];
                        f[k] = (spec && typeof spec === 'object' && 'from' in spec) ? spec.from : tg[k];
                        if (spec && typeof spec === 'object' && 'from' in spec) tg[k] = spec.from;
                    }
                    return f;
                });
            }
            t.elapsed += step;
            let k = M.clamp(t.elapsed / t.duration, 0, 1);
            const e = t.ease(t.reversing ? 1 - k : k);
            t.targets.forEach((tg, ti) => {
                if (!tg || tg.destroyed || !t.from || !t.from[ti]) return;
                for (const key in t.props) {
                    const spec = t.props[key];
                    let to;
                    if (spec && typeof spec === 'object') to = 'to' in spec ? spec.to : spec.value;
                    else if (typeof spec === 'string' && spec.startsWith('+=')) to = t.from[ti][key] + parseFloat(spec.slice(2));
                    else if (typeof spec === 'string' && spec.startsWith('-=')) to = t.from[ti][key] - parseFloat(spec.slice(2));
                    else if (typeof spec === 'string' && spec.startsWith('*=')) to = t.from[ti][key] * parseFloat(spec.slice(2));
                    else to = spec;
                    tg[key] = M.lerp(t.from[ti][key], to, e);
                }
            });
            if (t.onUpdate) t.onUpdate(t);
            if (k >= 1) {
                if (t.yoyo && !t.reversing) { t.reversing = true; t.elapsed = 0; continue; }
                if (t.repeat === -1 || t.repeat > 0) {
                    if (t.repeat > 0) t.repeat--;
                    t.elapsed = 0; t.reversing = false;
                    continue;
                }
                this.list.splice(i, 1);
                if (t.onComplete) t.onComplete();
            }
        }
    }
}

// ---------------------------------------------------------------- Uhr
class Clock {
    constructor() { this.events = []; this.timeScale = 1; this.now = 0; }
    delayedCall(ms, cb) { const e = { delay: ms, elapsed: 0, cb, loop: false, removed: false }; this.events.push(e); return e; }
    addEvent(cfg) {
        const e = { delay: cfg.delay, elapsed: 0, cb: cfg.callback, loop: !!cfg.loop, repeat: cfg.repeat || 0, removed: false };
        this.events.push(e); return e;
    }
    remove(e) { if (e) e.removed = true; }
    update(dt) {
        const step = dt * 1000 * this.timeScale;
        this.now += step;
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (e.removed) { this.events.splice(i, 1); continue; }
            e.elapsed += step;
            if (e.elapsed >= e.delay) {
                e.elapsed -= e.delay;
                try { e.cb(); } catch (err) { console.error(err); }
                if (!e.loop && !(e.repeat > 0)) { e.removed = true; }
                else if (e.repeat > 0) e.repeat--;
            }
        }
    }
    // Fortschritt eines Ereignisses von 0 bis 1
    progress(e) { return e ? M.clamp(e.elapsed / e.delay, 0, 1) : 0; }
}

// ---------------------------------------------------------------- Eingabe
class Input {
    constructor(game) {
        this.game = game;
        this.keys = {};
        this.justKeys = {};
        this.pointer = { x: 400, y: 300, isDown: false, justDown: false, justUp: false };
        this.handlers = { keydown: [], pointerdown: [], pointerup: [], pointermove: [] };

        const canvas = game.canvas;
        window.addEventListener('keydown', e => {
            if (!this.keys[e.code]) this.justKeys[e.code] = true;
            this.keys[e.code] = true;
            this.handlers.keydown.forEach(h => h(e));
            if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
        });
        window.addEventListener('keyup', e => { this.keys[e.code] = false; });

        const pos = (ev) => {
            const r = canvas.getBoundingClientRect();
            const t = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
            this.pointer.x = (t.clientX - r.left) / r.width * game.width;
            this.pointer.y = (t.clientY - r.top) / r.height * game.height;
        };
        canvas.addEventListener('pointermove', e => { pos(e); this.handlers.pointermove.forEach(h => h(this.pointer)); });
        canvas.addEventListener('pointerdown', e => {
            pos(e); this.pointer.isDown = true; this.pointer.justDown = true;
            this.handlers.pointerdown.forEach(h => h(this.pointer));
        });
        window.addEventListener('pointerup', e => {
            this.pointer.isDown = false; this.pointer.justUp = true;
            this.handlers.pointerup.forEach(h => h(this.pointer));
        });
    }
    on(evt, cb) { if (this.handlers[evt]) this.handlers[evt].push(cb); return this; }
    off(evt, cb) { if (this.handlers[evt]) this.handlers[evt] = this.handlers[evt].filter(h => h !== cb); }
    down(code) { return !!this.keys[code]; }
    justDown(code) { const v = !!this.justKeys[code]; return v; }
    // Am Bildende die "gerade gedrückt"-Marken zurücksetzen
    postUpdate() { this.justKeys = {}; this.pointer.justDown = false; this.pointer.justUp = false; }
}

// ---------------------------------------------------------------- Szene
class Scene {
    constructor(key) { this.key = key; this.children = []; this._sortDirty = false; this.active = false; }

    _boot(game) {
        this.game = game;
        this.tweens = new Tweens(this);
        this.time = new Clock();
        this.input = game.input;
        this.textures = game.textures;
    }

    _remove(node) {
        const i = this.children.indexOf(node);
        if (i >= 0) this.children.splice(i, 1);
    }

    _addNode(n) { this.children.push(n); this._sortDirty = true; return n; }

    // --- Erzeugen ---
    get add() {
        const s = this;
        return {
            sprite: (x, y, key, frame) => s._addNode(new Sprite(s, key, frame).setPosition(x, y)),
            image: (x, y, key) => s._addNode(new Sprite(s, key).setPosition(x, y)),
            rect: (x, y, w, h, color, alpha) => s._addNode(new Rect(s, w, h, color, alpha).setPosition(x, y)),
            circle: (x, y, r, color, alpha) => s._addNode(new Ellipse(s, r, color, alpha).setPosition(x, y)),
            triangle: (x, y, size, color, alpha) => s._addNode(new Triangle(s, size, color, alpha).setPosition(x, y)),
            text: (x, y, str, style) => s._addNode(new TextNode(s, str, style).setPosition(x, y)),
            particles: (x, y, key, cfg) => s._addNode(new Particles(s, key, cfg).setPosition(x, y))
        };
    }

    start(key, data) { this.game.start(key, data); }
    launch(key, data) { this.game.launch(key, data); }
    stop(key) { this.game.stop(key || this.key); }

    // Von Szenen zu überschreiben
    preload() {}
    create() {}
    update() {}
    shutdown() {}

    _update(dt) {
        this.time.update(dt);
        this.tweens.update(dt);
        for (const c of this.children) if (c.update) c.update(dt);
        this.update(this.time.now, dt * 1000);
    }

    _render(r) {
        if (this._sortDirty) {
            // Nach Tiefe sortieren und innerhalb einer Ebene nach Blend-Modus
            // gruppieren. Jeder Wechsel des Blend-Modus kostet einen eigenen
            // Zeichenaufruf - so bleiben gleichartige Sprites beieinander.
            this.children.sort((a, b) =>
                (a.depth - b.depth) ||
                ((a.blend === 'add' ? 1 : 0) - (b.blend === 'add' ? 1 : 0)) ||
                (a.id - b.id));
            this._sortDirty = false;
        }
        for (const c of this.children) {
            if (c.visible && c.alpha > 0.001 && !c.destroyed) c.render(r);
        }
    }

    _destroy() {
        this.children.length = 0;
        this.tweens.list.length = 0;
        this.time.events.length = 0;
    }
}

// ---------------------------------------------------------------- Spiel
class Game {
    constructor(cfg) {
        this.width = cfg.width || 800;
        this.height = cfg.height || 600;
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.width; this.canvas.height = this.height;
        (cfg.parent ? document.getElementById(cfg.parent) : document.body).appendChild(this.canvas);

        this.renderer = new Renderer(this.canvas, this.width, this.height);
        this.textures = new Textures(this.renderer.gl);
        this.text = new TextCache(this.textures);
        this.input = new Input(this);

        this.scenes = new Map();
        this.activeScenes = [];
        this.fps = 60; this._frames = 0; this._fpsTime = 0;
        this.drawCalls = 0;

        (cfg.scenes || []).forEach(S => this.addScene(new S()));
        this._makeBaseTextures();
        this._resize();
        window.addEventListener('resize', () => this._resize());

        this._last = performance.now();
        const loop = (now) => {
            const dt = Math.min((now - this._last) / 1000, 0.05);
            this._last = now;
            this._frames++; this._fpsTime += dt;
            if (this._fpsTime >= 0.5) { this.fps = this._frames / this._fpsTime; this._frames = 0; this._fpsTime = 0; }
            this.step(dt);
            requestAnimationFrame(loop);
        };
        if (cfg.boot) {
            Promise.resolve(cfg.boot(this)).then(() => {
                if (cfg.first) this.start(cfg.first);
                requestAnimationFrame(loop);
            });
        } else {
            if (cfg.first) this.start(cfg.first);
            requestAnimationFrame(loop);
        }
    }

    // Grundtexturen, aus denen Rechtecke, Kreise und Dreiecke gebaut werden
    _makeBaseTextures() {
        this.textures.make('__px', 4, 4, ctx => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 4, 4); });
        this.textures.make('__disc', 128, 128, (ctx, w) => {
            ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(w / 2, w / 2, w / 2 - 2, 0, 6.2832); ctx.fill();
        });
        this.textures.make('__ring', 128, 128, (ctx, w) => {
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 8;
            ctx.beginPath(); ctx.arc(w / 2, w / 2, w / 2 - 6, 0, 6.2832); ctx.stroke();
        });
        this.textures.make('__tri', 128, 128, (ctx, w) => {
            ctx.fillStyle = '#fff'; ctx.beginPath();
            ctx.moveTo(w / 2, 4); ctx.lineTo(w - 4, w - 6); ctx.lineTo(4, w - 6); ctx.closePath(); ctx.fill();
        });
        this.textures.make('__glow', 128, 128, (ctx, w) => {
            const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
            g.addColorStop(0, 'rgba(255,255,255,1)');
            g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
        });
    }

    _resize() {
        const shell = this.canvas.parentElement;
        const availW = shell.clientWidth || window.innerWidth;
        const availH = shell.clientHeight || window.innerHeight;
        const scale = Math.min(availW / this.width, availH / this.height);
        this.canvas.style.width = Math.floor(this.width * scale) + 'px';
        this.canvas.style.height = Math.floor(this.height * scale) + 'px';
    }

    addScene(scene) { scene._boot(this); this.scenes.set(scene.key, scene); return scene; }

    start(key, data) {
        this.activeScenes.slice().forEach(s => this.stop(s.key));
        this.launch(key, data);
    }

    launch(key, data) {
        const s = this.scenes.get(key);
        if (!s || s.active) return;
        s._destroy();
        s.active = true;
        // Zeitfaktoren sind szenenlokal und werden bei jedem Start normalisiert
        s.time.timeScale = 1; s.tweens.timeScale = 1; s.time.now = 0;
        s.data = data || {};
        this.activeScenes.push(s);
        s.create(s.data);
    }

    stop(key) {
        const s = this.scenes.get(key);
        if (!s || !s.active) return;
        s.shutdown();
        s.active = false;
        s._destroy();
        this.activeScenes = this.activeScenes.filter(x => x !== s);
    }

    step(dt) {
        for (const s of this.activeScenes.slice()) if (s.active) s._update(dt);
        const r = this.renderer;
        r.time += dt;
        r.beginFrame();
        for (const s of this.activeScenes) if (s.active) s._render(r);
        r.endFrame();
        this.drawCalls = r.drawCalls;
        this.input.postUpdate();
    }
}

global.ZE = { Game, Scene, Renderer, Textures, Ease, Math: M, Sprite, Rect, Ellipse, Triangle, TextNode, Particles };

})(window);
