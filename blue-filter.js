// ===================================================================
// WebGL Blue Light Isolation Filter
// GPU-accelerated blue differential computation for LED detection
// ===================================================================

class BlueFilter {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.program = null;
    this.videoTexture = null;
    this.framebuffer = null;
    this.fbTexture = null;
    this.fbWidth = 0;
    this.fbHeight = 0;
    this.threshold = 0.30;
    this.brightnessFloor = 0.15;
    this.adaptiveEnabled = true;
    this._ready = false;
  }

  init() {
    const gl = this.canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false
    });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    this.program = this._createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
    this._setupGeometry();
    this._setupTexture();
    this._ready = true;
  }

  /**
   * Process a video frame and return the blue differential mask at reduced resolution.
   * @param {HTMLVideoElement} video
   * @param {number} downscale - Downscale factor (default 4 = 1/4 resolution)
   * @returns {{ mask: Uint8Array, width: number, height: number }} Binary mask + blue diff values
   */
  process(video, downscale = 4) {
    if (!this._ready || video.readyState < 2) return null;

    const gl = this.gl;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    // Compute output dimensions
    const outW = Math.round(vw / downscale);
    const outH = Math.round(vh / downscale);

    // Ensure framebuffer is correct size
    this._ensureFramebuffer(outW, outH);

    // Upload video to texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    // Render to framebuffer at downscaled resolution
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, outW, outH);

    gl.useProgram(this.program);
    gl.uniform1i(this.uVideo, 0);
    gl.uniform1f(this.uThreshold, this.threshold);
    gl.uniform1f(this.uBrightness, this.brightnessFloor);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Read back pixels
    const pixels = new Uint8Array(outW * outH * 4);
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Unbind framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Extract binary mask (R channel), blue diff strength (G channel), brightness (B channel)
    // IMPORTANT: WebGL readPixels returns data bottom-to-top (OpenGL convention)
    // We flip Y here so the mask uses top-left origin (standard image convention)
    const rawMask = new Uint8Array(outW * outH);
    const blueDiffValues = new Uint8Array(outW * outH);
    const brightnessValues = new Uint8Array(outW * outH);

    for (let y = 0; y < outH; y++) {
      const srcRow = (outH - 1 - y) * outW; // Flip Y
      const dstRow = y * outW;
      for (let x = 0; x < outW; x++) {
        const srcIdx = (srcRow + x) * 4;
        const dstIdx = dstRow + x;
        rawMask[dstIdx] = pixels[srcIdx];              // R channel = binary (0 or 255)
        blueDiffValues[dstIdx] = pixels[srcIdx + 1];   // G channel = blue diff strength
        brightnessValues[dstIdx] = pixels[srcIdx + 2]; // B channel = brightness
      }
    }

    // v2.4.0: 亮度高通模式下使用連續灰階（不做二值化形態學處理）
    const mask = rawMask;

    // v2.5.0: 乘積濾波器 — R 通道 > 80 才參與偵測（brightnessGate × blueWeight）
    const BRIGHT_PIXEL_THRESHOLD = 80;
    const bluePixels = [];
    for (let i = 0; i < outW * outH; i++) {
      if (mask[i] > BRIGHT_PIXEL_THRESHOLD) {
        bluePixels.push(i);
      }
    }

    // Adaptive threshold update
    if (this.adaptiveEnabled) {
      this._updateAdaptiveThreshold(brightnessValues, outW * outH);
    }

    return { mask, blueDiffValues, brightnessValues, bluePixels, width: outW, height: outH, downscale };
  }

  /**
   * Render the blue filter visualization to the canvas (for debug/display).
   * Call this after process() if you want to show the filtered view.
   */
  renderToScreen(video) {
    if (!this._ready || video.readyState < 2) return;
    const gl = this.gl;

    // Resize canvas to match display
    this.canvas.width = this.canvas.clientWidth;
    this.canvas.height = this.canvas.clientHeight;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.useProgram(this.program);
    gl.uniform1i(this.uVideo, 0);
    gl.uniform1f(this.uThreshold, this.threshold);
    gl.uniform1f(this.uBrightness, this.brightnessFloor);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  setThreshold(value) {
    this.threshold = Math.max(0.05, Math.min(0.60, value));
  }

  setBrightnessFloor(value) {
    this.brightnessFloor = Math.max(0.05, Math.min(0.80, value));
  }

  destroy() {
    const gl = this.gl;
    if (!gl) return;
    if (this.videoTexture) gl.deleteTexture(this.videoTexture);
    if (this.fbTexture) gl.deleteTexture(this.fbTexture);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    if (this.program) gl.deleteProgram(this.program);
    this._ready = false;
  }

  // --- Private methods ---

  _createProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      throw new Error('Vertex shader error: ' + gl.getShaderInfoLog(vs));
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      throw new Error('Fragment shader error: ' + gl.getShaderInfoLog(fs));
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    // Cache uniform locations
    this.uVideo = gl.getUniformLocation(program, 'u_video');
    this.uThreshold = gl.getUniformLocation(program, 'u_threshold');
    this.uBrightness = gl.getUniformLocation(program, 'u_brightness');

    return program;
  }

  _setupGeometry() {
    const gl = this.gl;
    // Fullscreen quad: position (x,y) + texcoord (u,v)
    const vertices = new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0,
    ]);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(this.program, 'a_position');
    const aTex = gl.getAttribLocation(this.program, 'a_texCoord');

    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);
  }

  _setupTexture() {
    const gl = this.gl;
    this.videoTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  _ensureFramebuffer(w, h) {
    if (this.fbWidth === w && this.fbHeight === h) return;

    const gl = this.gl;

    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    if (this.fbTexture) gl.deleteTexture(this.fbTexture);

    this.fbTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fbTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fbTexture, 0);

    this.fbWidth = w;
    this.fbHeight = h;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _updateAdaptiveThreshold(brightnessValues, count) {
    // v2.5.0: 基於原始亮度（B 通道）建直方圖
    // 找出環境亮度分布，自動調整 brightness gate 閾值
    const histogram = new Uint32Array(256);
    let signalCount = 0;
    for (let i = 0; i < count; i++) {
      if (brightnessValues[i] > 30) {
        histogram[brightnessValues[i]]++;
        signalCount++;
      }
    }

    if (signalCount < 50) return;

    // 97th percentile：top 3% 是 LED/亮光源
    const targetCount = Math.floor(signalCount * 0.97);
    let cumulative = 0;
    let percentile97 = 0;
    for (let i = 31; i < 256; i++) {
      cumulative += histogram[i];
      if (cumulative >= targetCount) {
        percentile97 = i;
        break;
      }
    }

    // 閾值 = 97th percentile 的 50%
    const adaptiveThresh = (percentile97 / 255) * 0.50;
    // 動態 floor = threshold/2, ceiling 0.45, EMA 平滑
    const floor = this.threshold * 0.5;
    this.threshold = this.threshold * 0.9 + Math.max(floor, Math.min(0.45, adaptiveThresh)) * 0.1;
  }

  /**
   * Apply morphological opening (erosion + dilation) to remove single-pixel noise
   * and reconnect nearby mask regions.
   * @param {Uint8Array} mask - Binary mask (0 or 255)
   * @param {number} w - Width
   * @param {number} h - Height
   * @returns {Uint8Array} Cleaned mask
   */
  _morphCleanup(mask, w, h) {
    const size = w * h;
    const eroded = new Uint8Array(size);
    const dilated = new Uint8Array(size);

    // Erosion (majority-vote): pixel survives if at least 3 of 4 neighbors are set
    // Gentler than strict 4-connectivity to preserve small LED blobs (2-4 px)
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (mask[idx]) {
          const neighborCount =
            (mask[idx - 1] ? 1 : 0) +   // left
            (mask[idx + 1] ? 1 : 0) +   // right
            (mask[idx - w] ? 1 : 0) +   // top
            (mask[idx + w] ? 1 : 0);    // bottom
          if (neighborCount >= 3) {
            eroded[idx] = 255;
          }
        }
      }
    }

    // Dilation (8-connectivity): pixel is set if any 8-neighbor is set in eroded mask
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (eroded[idx] ||
            eroded[idx - 1] || eroded[idx + 1] ||
            eroded[idx - w] || eroded[idx + w] ||
            eroded[idx - w - 1] || eroded[idx - w + 1] ||
            eroded[idx + w - 1] || eroded[idx + w + 1]) {
          dilated[idx] = 255;
        }
      }
    }

    return dilated;
  }
}

// --- Shaders ---

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_video;
uniform float u_threshold;
uniform float u_brightness;
varying vec2 v_texCoord;

void main() {
  vec4 color = texture2D(u_video, v_texCoord);
  float r = color.r;
  float g = color.g;
  float b = color.b;

  float brightness = max(r, max(g, b));
  float blueDiff = b - (r + g) * 0.5;

  // === Stage 1: 亮度平滑門檻 ===
  // smoothstep: 0 at threshold, 1 at threshold+0.15
  // 排除暗背景，通過亮光源
  float brightnessGate = smoothstep(u_threshold, u_threshold + 0.15, brightness);

  // === Stage 2: 藍色選擇性 ===
  // smoothstep(-0.05, 0.15, blueDiff):
  //   blueDiff = -0.10 → 0.0  （暖白天花板燈：拒絕）
  //   blueDiff = -0.05 → 0.0  （中性暖光：拒絕）
  //   blueDiff = -0.02 → 0.09 （LED 中心近白：弱通過）
  //   blueDiff =  0.00 → 0.25 （中性：通過）
  //   blueDiff = +0.05 → 0.625（藍色光暈：通過）
  //   blueDiff = +0.15 → 1.0  （強藍：完全通過）
  float blueWeight = smoothstep(-0.05, 0.15, blueDiff);

  // === Stage 3: 乘法組合 ===
  // 必須同時亮且藍才通過 — 天花板燈（亮但不藍）= 0
  float finalScore = brightnessGate * blueWeight;

  // R = 組合分數 brightnessGate×blueWeight (0-1)
  // G = blueDiff+0.5 映射到 0-1（保留正負值供診斷）
  // B = 原始亮度 (0-1)
  gl_FragColor = vec4(finalScore, clamp(blueDiff + 0.5, 0.0, 1.0), brightness, 1.0);
}
`;
