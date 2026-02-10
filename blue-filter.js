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

    // Extract binary mask (R channel) and blue diff strength (G channel)
    const mask = new Uint8Array(outW * outH);
    const blueDiffValues = new Uint8Array(outW * outH);

    for (let i = 0; i < outW * outH; i++) {
      mask[i] = pixels[i * 4]; // R channel = binary (0 or 255)
      blueDiffValues[i] = pixels[i * 4 + 1]; // G channel = blue diff strength
    }

    // Adaptive threshold update
    if (this.adaptiveEnabled) {
      this._updateAdaptiveThreshold(blueDiffValues, outW * outH);
    }

    return { mask, blueDiffValues, width: outW, height: outH, downscale };
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
    this.threshold = Math.max(0.02, Math.min(0.50, value));
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

  _updateAdaptiveThreshold(blueDiffValues, count) {
    // Compute the 99.5th percentile of blue diff values to set adaptive threshold
    // Use a histogram approach for efficiency (values are 0-255)
    const histogram = new Uint32Array(256);
    for (let i = 0; i < count; i++) {
      histogram[blueDiffValues[i]]++;
    }

    const targetCount = Math.floor(count * 0.995);
    let cumulative = 0;
    let percentile99_5 = 0;
    for (let i = 0; i < 256; i++) {
      cumulative += histogram[i];
      if (cumulative >= targetCount) {
        percentile99_5 = i;
        break;
      }
    }

    // Convert to normalized (0-1) and apply as threshold
    // Use a slightly lower value than the percentile to catch LEDs
    const adaptiveThresh = (percentile99_5 / 255) * 0.8;
    // Smoothly blend with current threshold (EMA)
    this.threshold = this.threshold * 0.9 + Math.max(0.08, Math.min(0.30, adaptiveThresh)) * 0.1;
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

  // Blue differential: how much bluer than average of R+G
  float blueDiff = b - (r + g) * 0.5;

  // Brightness gate: LED must be reasonably bright (point light source)
  float brightness = max(r, max(g, b));

  // Combined filter: blue AND bright
  float isBlue = step(u_threshold, blueDiff) * step(u_brightness, brightness);

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
