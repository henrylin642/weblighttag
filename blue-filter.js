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
    this.threshold = 0.12;
    this.brightnessFloor = 0.15;
    this.adaptiveEnabled = true;
    this._ready = false;

    // HSV filter parameters
    this.hueCenter = 0.63;    // Blue hue center (0-1, ~227°/360°)
    this.hueRange = 0.12;     // Hue tolerance (±0.12 = ±43°, covers ~184°-270°)
    this.satMin = 0.15;       // Minimum saturation
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
    gl.uniform1f(this.uHueCenter, this.hueCenter);
    gl.uniform1f(this.uHueRange, this.hueRange);
    gl.uniform1f(this.uSatMin, this.satMin);

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

    // Apply morphological opening (erosion + dilation) to clean noise
    const mask = this._morphCleanup(rawMask, outW, outH);

    // Build sparse blue pixel index list for peak detector (fast NMS scanning)
    const bluePixels = [];
    for (let i = 0; i < outW * outH; i++) {
      if (mask[i] > 0 || brightnessValues[i] > 200) {
        bluePixels.push(i);
      }
    }

    // Adaptive threshold update
    if (this.adaptiveEnabled) {
      this._updateAdaptiveThreshold(blueDiffValues, outW * outH);
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
    gl.uniform1f(this.uHueCenter, this.hueCenter);
    gl.uniform1f(this.uHueRange, this.hueRange);
    gl.uniform1f(this.uSatMin, this.satMin);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  setThreshold(value) {
    this.threshold = Math.max(0.02, Math.min(0.50, value));
  }

  setBrightnessFloor(value) {
    this.brightnessFloor = Math.max(0.05, Math.min(0.80, value));
  }

  setHueCenter(value) {
    this.hueCenter = Math.max(0, Math.min(1.0, value));
  }

  setHueRange(value) {
    this.hueRange = Math.max(0.01, Math.min(0.5, value));
  }

  setSatMin(value) {
    this.satMin = Math.max(0, Math.min(1.0, value));
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
    this.uHueCenter = gl.getUniformLocation(program, 'u_hueCenter');
    this.uHueRange = gl.getUniformLocation(program, 'u_hueRange');
    this.uSatMin = gl.getUniformLocation(program, 'u_satMin');

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

  _updateAdaptiveThreshold(blueDiffValues, count) {
    // Compute the 97th percentile of blue diff values to set adaptive threshold
    // Using 97th instead of 99.5th for more stable estimation (less sensitive to noise clusters)
    const histogram = new Uint32Array(256);
    for (let i = 0; i < count; i++) {
      histogram[blueDiffValues[i]]++;
    }

    const targetCount = Math.floor(count * 0.97);
    let cumulative = 0;
    let percentile97 = 0;
    for (let i = 0; i < 256; i++) {
      cumulative += histogram[i];
      if (cumulative >= targetCount) {
        percentile97 = i;
        break;
      }
    }

    // Convert to normalized (0-1) with 0.6x factor (lower threshold to catch weak blue signals)
    const adaptiveThresh = (percentile97 / 255) * 0.6;
    // Smoothly blend with current threshold (EMA), cap at 0.20 to protect saturated LED detection
    this.threshold = this.threshold * 0.9 + Math.max(0.08, Math.min(0.20, adaptiveThresh)) * 0.1;
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

    // Erosion (4-connectivity): pixel survives only if all 4 neighbors are set
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (mask[idx] &&
            mask[idx - 1] &&       // left
            mask[idx + 1] &&       // right
            mask[idx - w] &&       // top
            mask[idx + w]) {       // bottom
          eroded[idx] = 255;
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
uniform float u_hueCenter;
uniform float u_hueRange;
uniform float u_satMin;
varying vec2 v_texCoord;

// RGB to HSV conversion
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

void main() {
  vec4 color = texture2D(u_video, v_texCoord);
  float r = color.r;
  float g = color.g;
  float b = color.b;

  // Blue differential: how much bluer than average of R+G
  float blueDiff = b - (r + g) * 0.5;

  // Brightness gate: LED must be reasonably bright (point light source)
  float brightness = max(r, max(g, b));

  // HSV-based hue filter for blue range
  vec3 hsv = rgb2hsv(color.rgb);
  float hue = hsv.x;       // 0-1 (0=red, 0.33=green, 0.67=blue)
  float sat = hsv.y;       // 0-1

  // Hue distance (circular, wraps around 0/1)
  float hueDist = min(abs(hue - u_hueCenter), 1.0 - abs(hue - u_hueCenter));
  float hueOk = step(hueDist, u_hueRange);

  // Saturation gate: must be sufficiently saturated (not white/gray)
  float satOk = step(u_satMin, sat);

  // === PATH 1: Normal blue detection ===
  // Blue diff > threshold AND bright AND hue in range AND saturated
  float normalBlue = step(u_threshold, blueDiff) * step(u_brightness, brightness) * hueOk * satOk;

  // === PATH 2: Saturated/overexposed LED center detection ===
  // Very bright (>0.85) AND any blue excess (>0.02) AND blue is max channel
  // Catches near-white pixels at LED center where camera sensor saturated
  float isBright = step(0.85, brightness);
  float hasBlueExcess = step(0.02, blueDiff);
  float blueIsMax = step(r, b) * step(g, b);
  float saturatedLED = isBright * hasBlueExcess * blueIsMax;

  // Combined: either path passes
  float isBlue = clamp(normalBlue + saturatedLED, 0.0, 1.0);

  // R = binary mask (0 or 1 -> 0 or 255)
  // G = blue diff strength (clamped to 0-1)
  // B = brightness value
  // A = 1
  gl_FragColor = vec4(
    isBlue,
    clamp(blueDiff, 0.0, 1.0),
    brightness,
    1.0
  );
}
`;
