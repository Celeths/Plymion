/* ============================================================================
   Plymouth Theme Generator — browser raster pipeline (milestone 2, part 4)
   ----------------------------------------------------------------------------
   Turns whatever the author supplied into the PNGs Plymouth can actually load.

   WHY EVERY OUTPUT HERE IS A PNG
   Plymouth's loader is `ply-image.c`, which reads a 16-byte header and
   dispatches on magic bytes to `ply_image_load_png` or `ply_image_load_bmp`.
   There is no JPEG, GIF or SVG path in the running theme, so an animated GIF
   becomes a numbered PNG sequence and an SVG is rasterised — the theme itself
   never decodes anything but PNG.

   WHY SOME OF THIS IS REAL-TIME
   An animated SVG is the one thing nothing on this machine can rasterise
   off-line: `rsvg-convert` renders a still. A browser runs the animation, so
   the only way to get frames is to draw the image repeatedly while its own
   clock runs and capture what it looks like. Those frames are therefore
   sampled in wall-clock time rather than seeked deterministically, which is
   noted again at the call site.

   The pure half — type classification, GIF block walking, SVG animation
   sniffing, dimension guards — is deliberately free of any browser API so it
   can be checked under Node. See TEST_FILES/TEST-FILE_build_raster.js.
   ========================================================================= */
(function (root) {
  'use strict';

  /* ==================================================================== pure */

  /* Whole pixels, never below 1. A zero or unmeasurable target is a bug
     upstream, but encoding a 0x0 canvas throws deep inside the browser, so it
     is clamped here where the reason is obvious. */
  function dim(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return 1;
    return Math.max(1, Math.round(n));
  }

  var EXT_TYPES = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    webp: 'image/webp',
    avif: 'image/avif'
  };

  var SUPPORTED = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml'];

  function typeFromName(name) {
    var s = String(name || '');
    var dot = s.lastIndexOf('.');
    if (dot < 0) return '';
    var ext = s.slice(dot + 1).toLowerCase();
    return EXT_TYPES[ext] || '';
  }

  function isSupportedType(type) {
    return SUPPORTED.indexOf(String(type || '').toLowerCase()) > -1;
  }

  /* What kind of file this is. A declared MIME type is preferred, but drag and
     drop and some pickers hand over an empty or generic one, so the extension
     gets a say — and when the declared type is a real image type the extension
     is not consulted at all, because `image/png` named `photo.jpg` is a PNG. */
  function normaliseType(source) {
    var declared = String((source && source.type) || '').toLowerCase().trim();
    if (isSupportedType(declared)) return declared;
    var guessed = typeFromName(source && source.name);
    if (guessed) return guessed;
    return declared;
  }

  /* --------------------------------------------------------------- GIF bytes */

  function gifLogicalSize(bytes) {
    if (!bytes || bytes.length < 10) return null;
    if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return null;
    return {
      width: bytes[6] | (bytes[7] << 8),
      height: bytes[8] | (bytes[9] << 8)
    };
  }

  /* Walks the GIF block structure and counts image descriptors.

     This is a real parse rather than a search for 0x2C bytes: the separator
     byte occurs constantly inside compressed data, so counting occurrences
     would report animation in a still. Following the block structure means
     stepping over extension and image sub-blocks by their declared lengths. */
  function gifFrameCount(bytes) {
    if (!gifLogicalSize(bytes)) return 0;

    /* Past the header (6), the logical screen descriptor (width, height, packed,
       background index, aspect ratio = 7) and then the global colour table if
       the descriptor says there is one. */
    var p = 13;
    var packed = bytes[10];
    if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));

    var count = 0;

    function skipSubBlocks() {
      while (p < bytes.length) {
        var n = bytes[p];
        p += 1;
        if (n === 0) return true;
        p += n;
      }
      return false;
    }

    while (p < bytes.length) {
      var block = bytes[p];
      p += 1;

      if (block === 0x3b) break;                    /* trailer */

      if (block === 0x21) {                         /* extension */
        if (p >= bytes.length) break;
        p += 1;                                     /* label */
        if (!skipSubBlocks()) break;
        continue;
      }

      if (block === 0x2c) {                         /* image descriptor */
        if (p + 9 > bytes.length) break;
        var localPacked = bytes[p + 8];
        p += 9;
        if (localPacked & 0x80) p += 3 * (1 << ((localPacked & 0x07) + 1));
        if (p >= bytes.length) break;
        p += 1;                                     /* LZW minimum code size */
        count += 1;
        if (!skipSubBlocks()) break;
        continue;
      }

      break;                                        /* unrecognised: stop, do not guess */
    }

    return count;
  }

  /* ------------------------------------------------------------------- SVG */

  /* SMIL declarative animation, or a CSS animation. `<set` needs a delimiter
     after it so `<setup>` is not mistaken for one. */
  var SVG_ANIM_RE = /<\s*animate(?:Transform|Motion|Color)?[\s/>]|<\s*set[\s/>]|@keyframes\b|animation(?:-name)?\s*:/i;

  function svgLooksAnimated(text) {
    return SVG_ANIM_RE.test(String(text || ''));
  }

  /* The animation's own length, so sampling covers one full cycle rather than
     an arbitrary second. Longest declaration wins: a document with several
     animations is only complete once the slowest has finished. */
  function svgDurationMs(text) {
    var src = String(text || '');
    var best = 0;
    var re = /(?:dur|animation-duration)\s*[:=]\s*["']?\s*([0-9]*\.?[0-9]+)\s*(ms|s)\b/gi;
    var m;
    while ((m = re.exec(src)) !== null) {
      var ms = parseFloat(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1);
      if (isFinite(ms) && ms > best) best = ms;
    }
    if (best > 0) return best;

    /* The `animation` shorthand carries its duration as the first time value. */
    var shorthand = /animation\s*:\s*[^;"']*?([0-9]*\.?[0-9]+)\s*(ms|s)\b/i.exec(src);
    if (shorthand) {
      var ms2 = parseFloat(shorthand[1]) * (shorthand[2].toLowerCase() === 's' ? 1000 : 1);
      if (isFinite(ms2) && ms2 > 0) return ms2;
    }
    return null;
  }

  function numberAttr(head, name) {
    var re = new RegExp(name + '\\s*=\\s*["\']\\s*([0-9]*\\.?[0-9]+)\\s*(?:px)?\\s*["\']', 'i');
    var m = re.exec(head);
    if (!m) return null;
    var n = parseFloat(m[1]);
    return isFinite(n) && n > 0 ? n : null;
  }

  /* An SVG's own idea of how big it is. A percentage width is not a size, so
     `numberAttr` refuses it; the viewBox is the fallback, and one axis is
     enough to derive the other from it. Returns null when the document does
     not say, in which case the caller must supply the size. */
  function svgIntrinsicSize(text) {
    /* Only the root <svg> tag describes the image's size. Searching the whole
       document would read a child's `<rect width="4">` as the canvas width,
       which is exactly how a size-less SVG once appeared to know its size. */
    var tag = /<svg\b[^>]*>/i.exec(String(text || ''));
    var head = tag ? tag[0] : '';
    var w = numberAttr(head, 'width');
    var h = numberAttr(head, 'height');
    if (w && h) return { width: w, height: h };

    var vb = /viewBox\s*=\s*["']\s*([-0-9.eE]+)[\s,]+([-0-9.eE]+)[\s,]+([-0-9.eE]+)[\s,]+([-0-9.eE]+)/i.exec(head);
    if (vb) {
      var vw = parseFloat(vb[3]);
      var vh = parseFloat(vb[4]);
      if (isFinite(vw) && vh > 0 && isFinite(vh) && vw > 0) {
        if (w && !h) return { width: w, height: Math.round(w * vh / vw) };
        if (h && !w) return { width: Math.round(h * vw / vh), height: h };
        return { width: vw, height: vh };
      }
    }
    if (w || h) return { width: w || h, height: h || w };
    return null;
  }

  /* ------------------------------------------------------- SMIL evaluation */

  /* ANIMATED SVG CANNOT BE SAMPLED BY DRAWING IT REPEATEDLY.
     Chromium rasterises an SVG referenced by an <img> once and hands the same
     pixels back for every drawImage, so a sampling loop yields N identical
     frames no matter how long it waits. So instead of asking the browser what
     the animation looks like at time t, we work that out ourselves, rewrite the
     document with the value applied, and rasterise one static SVG per frame.
     That is deterministic as a bonus: no sleeping, and the same input always
     gives the same frames.

     The subset covered is the one real animated SVGs use: <animate> on a
     numeric or colour attribute, and <animateTransform> of type translate,
     scale or rotate. Anything else is stepped rather than interpolated, and
     CSS-driven animation is reported rather than silently frozen. */

  /* SMIL clock values: a bare number is seconds. */
  function parseClock(value) {
    var m = /^\s*([0-9]*\.?[0-9]+)\s*(ms|s|min|h)?\s*$/.exec(has(value) ? String(value) : '');
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    var unit = (m[2] || 's').toLowerCase();
    if (unit === 'ms') return n;
    if (unit === 'min') return n * 60000;
    if (unit === 'h') return n * 3600000;
    return n * 1000;
  }

  function round6(n) {
    return Number(n.toFixed(6));
  }

  /* An attribute that is absent reads as null from the DOM and as undefined
     from a plain object, and both mean "not there". Testing only for undefined
     made an absent `values` look like a value list, which stringified to the
     literal text "null". */
  function has(value) {
    return value !== undefined && value !== null;
  }

  /* Where in the animation a moment falls, 0..1. An animation that repeats (or
     says nothing about repeats, which means once — but sampling covers exactly
     one duration, so the cycle position is the same either way) is taken modulo
     its duration; one that freezes holds at the end. */
  function smilProgress(anim, timeMs) {
    var dur = parseClock(anim.dur);
    if (!dur || dur <= 0) return 0;
    var t = Number(timeMs) || 0;
    var repeats = String(has(anim.repeatCount) ? anim.repeatCount : '').toLowerCase();
    var loops = repeats === 'indefinite' || repeats === '';
    if (!loops) {
      var n = parseFloat(repeats);
      if (isFinite(n) && n > 0 && t >= dur * n) return 1;
    }
    return Math.min(1, Math.max(0, (t % dur) / dur));
  }

  function parseColour(value) {
    var s = (has(value) ? String(value) : '').trim();
    var m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1];
    m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      var parts = m[1].split(',').map(function (x) { return parseFloat(x); });
      if (!isFinite(parts[0]) || !isFinite(parts[1]) || !isFinite(parts[2])) return null;
      return [parts[0], parts[1], parts[2], isFinite(parts[3]) ? parts[3] : 1];
    }
    return null;   /* a named colour cannot be interpolated without a colour table */
  }

  function numeric(text) {
    var s = (has(text) ? String(text) : '').trim();
    if (!/^-?[0-9]*\.?[0-9]+$/.test(s)) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  /* Between two values of whatever kind they turn out to be. Numbers are
     interpolated, colours are interpolated channel by channel, and anything
     else steps at the halfway point rather than being mangled. */
  function interpolateValue(a, b, p) {
    var na = numeric(a);
    var nb = numeric(b);
    if (na !== null && nb !== null) return String(round6(na + (nb - na) * p));

    var ca = parseColour(a);
    var cb = parseColour(b);
    if (ca && cb) {
      return 'rgba(' + Math.round(ca[0] + (cb[0] - ca[0]) * p) + ',' +
        Math.round(ca[1] + (cb[1] - ca[1]) * p) + ',' +
        Math.round(ca[2] + (cb[2] - ca[2]) * p) + ',' +
        round6(ca[3] + (cb[3] - ca[3]) * p) + ')';
    }
    return p < 0.5 ? String(a) : String(b);
  }

  function interpolateList(a, b, p) {
    var as = String(a).trim().split(/[\s,]+/);
    var bs = String(b).trim().split(/[\s,]+/);
    if (!as.length || as.length !== bs.length) return p < 0.5 ? String(a) : String(b);
    var out = [];
    for (var i = 0; i < as.length; i += 1) {
      var na = numeric(as[i]);
      var nb = numeric(bs[i]);
      if (na === null || nb === null) return p < 0.5 ? String(a) : String(b);
      out.push(round6(na + (nb - na) * p));
    }
    return out.join(' ');
  }

  /* Picks the value out of the list form, honouring keyTimes when it is the
     same length as the value list and spacing them evenly when it is not. */
  function valueFromList(raw, keyTimes, p) {
    var vals = String(raw).split(';').map(function (v) { return v.trim(); });
    if (vals.length === 1) return vals[0];
    var times = String(keyTimes || '').split(';').map(parseFloat).filter(isFinite);
    if (times.length !== vals.length) {
      times = vals.map(function (_, i) { return i / (vals.length - 1); });
    }
    for (var i = 0; i < times.length - 1; i += 1) {
      if (p <= times[i + 1] || i === times.length - 2) {
        var span = times[i + 1] - times[i];
        var local = span > 0 ? (p - times[i]) / span : 0;
        return interpolateValue(vals[i], vals[i + 1], Math.min(1, Math.max(0, local)));
      }
    }
    return vals[vals.length - 1];
  }

  /* The value an <animate> gives its target at a moment. */
  function smilValueAt(anim, timeMs) {
    var p = smilProgress(anim, timeMs);
    if (has(anim.values)) return valueFromList(anim.values, anim.keyTimes, p);
    if (has(anim.from) && has(anim.to)) return interpolateValue(anim.from, anim.to, p);
    if (has(anim.to)) return String(anim.to);
    if (has(anim.from)) return String(anim.from);
    return null;
  }

  /* The transform string an <animateTransform> gives its target at a moment. */
  function smilTransformAt(anim, timeMs) {
    var p = smilProgress(anim, timeMs);
    var type = String(anim.type || 'translate');
    var body;
    if (has(anim.values)) {
      var vals = String(anim.values).split(';').map(function (v) { return v.trim(); });
      body = vals.length === 1 ? vals[0] : valueFromListTransform(vals, anim.keyTimes, p);
    } else if (has(anim.from) && has(anim.to)) {
      body = interpolateList(anim.from, anim.to, p);
    } else if (has(anim.to)) {
      body = String(anim.to);
    } else if (has(anim.from)) {
      body = String(anim.from);
    } else {
      return null;
    }
    return type + '(' + body + ')';
  }

  function valueFromListTransform(vals, keyTimes, p) {
    var times = String(keyTimes || '').split(';').map(parseFloat).filter(isFinite);
    if (times.length !== vals.length) {
      times = vals.map(function (_, i) { return i / (vals.length - 1); });
    }
    for (var i = 0; i < times.length - 1; i += 1) {
      if (p <= times[i + 1] || i === times.length - 2) {
        var span = times[i + 1] - times[i];
        var local = span > 0 ? (p - times[i]) / span : 0;
        return interpolateList(vals[i], vals[i + 1], Math.min(1, Math.max(0, local)));
      }
    }
    return vals[vals.length - 1];
  }

  /* ---------------------------------------------------------------- classify */

  function classify(type, animated) {
    return {
      kind: animated ? 'frames' : 'still',
      type: type,
      animated: !!animated
    };
  }

  /* =============================================================== browser */

  function hasOffscreen() {
    return typeof root.OffscreenCanvas === 'function';
  }

  function makeCanvas(width, height) {
    var w = dim(width);
    var h = dim(height);
    if (hasOffscreen()) return new root.OffscreenCanvas(w, h);
    var c = root.document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function ctxOf(canvas) {
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context available');
    return ctx;
  }

  function toBlobOf(canvas) {
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: 'image/png' });
    }
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('The canvas refused to encode a PNG'));
      }, 'image/png');
    });
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new root.Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not rasterise the supplied SVG')); };
      img.src = url;
    });
  }

  function warn(options, message) {
    if (options && typeof options.onWarn === 'function') options.onWarn(message);
  }

  function drawInto(source, width, height) {
    var canvas = makeCanvas(width, height);
    ctxOf(canvas).drawImage(source, 0, 0, dim(width), dim(height));
    return { width: dim(width), height: dim(height), canvas: canvas };
  }

  /* Anything that can be drawn: our own frame records, a bare canvas, an
     OffscreenCanvas, or an ImageBitmap/VideoFrame. */
  function canvasOf(frame) {
    if (!frame) throw new Error('No image to encode');
    if (frame.canvas) return frame.canvas;
    if (typeof frame.getContext === 'function') return frame;
    if (typeof frame.convertToBlob === 'function') return frame;
    var w = dim(frame.width || frame.displayWidth);
    var h = dim(frame.height || frame.displayHeight);
    var c = makeCanvas(w, h);
    ctxOf(c).drawImage(frame, 0, 0, w, h);
    return c;
  }

  /* ---------------------------------------------------------------- decoding */

  async function decodeStill(source) {
    var bitmap = await root.createImageBitmap(source);
    var frame = drawInto(bitmap, bitmap.width, bitmap.height);
    if (bitmap.close) bitmap.close();
    return frame;
  }

  /* Every frame of a GIF, composited onto its logical canvas.

     ImageDecoder hands each frame back at the animation's logical size with
     earlier frames already composited, so drawing each one onto a fresh canvas
     of that size is the whole job — there is no sub-rectangle bookkeeping to do
     here. The track's own videoWidth/videoHeight is preferred to parsing the
     header, because it is what the decoder actually produced. */
  async function gifFrames(source, options) {
    var buffer = await source.arrayBuffer();
    var bytes = new Uint8Array(buffer);
    var logical = gifLogicalSize(bytes) || { width: 0, height: 0 };

    var decodable = typeof root.ImageDecoder === 'function';
    if (decodable) {
      try {
        decodable = await root.ImageDecoder.isTypeSupported('image/gif');
      } catch (err) {
        decodable = false;
      }
    }

    if (!decodable) {
      warn(options, 'ImageDecoder cannot read GIF here, so only the first frame was used — ' +
        'this animation would ship as a still');
      return [await decodeStill(source)];
    }

    var decoder = new root.ImageDecoder({ data: buffer, type: 'image/gif' });
    try {
      if (decoder.tracks && decoder.tracks.ready) await decoder.tracks.ready;
      if (decoder.completed) await decoder.completed;

      var track = (decoder.tracks && decoder.tracks.selectedTrack) || null;
      var count = track && track.frameCount ? track.frameCount : 1;
      var width = dim((track && track.videoWidth) || logical.width);
      var height = dim((track && track.videoHeight) || logical.height);

      var frames = [];
      for (var i = 0; i < count; i += 1) {
        var result = await decoder.decode({ frameIndex: i });
        var canvas = makeCanvas(width, height);
        ctxOf(canvas).drawImage(result.image, 0, 0, width, height);
        if (result.image && result.image.close) result.image.close();
        frames.push({ width: width, height: height, canvas: canvas });
      }
      if (!frames.length) return [await decodeStill(source)];
      return frames;
    } finally {
      if (decoder.close) decoder.close();
    }
  }

  /* --------------------------------------------------------------- SVG */

  /* One static SVG document, rasterised. Each frame of an animation is a
     different document, which is why the <img> raster cache that defeats
     sampling by time is harmless here. */
  async function rasteriseSvg(text, width, height) {
    var blob = new root.Blob([text], { type: 'image/svg+xml' });
    var url = root.URL.createObjectURL(blob);
    try {
      var img = await loadImage(url);
      return drawInto(img, width, height);
    } finally {
      root.URL.revokeObjectURL(url);
    }
  }

  /* The document as it looks at a moment in time: every animation evaluated and
     written in as an ordinary attribute, then the animation elements removed so
     what gets serialised is a still. */
  function svgAtTime(text, timeMs) {
    if (typeof root.DOMParser !== 'function') return text;
    var doc = new root.DOMParser().parseFromString(text, 'image/svg+xml');
    if (!doc || !doc.documentElement) return text;
    if (doc.getElementsByTagName('parsererror').length) return text;

    var all = [];
    var plain = doc.getElementsByTagName('animate');
    var transforms = doc.getElementsByTagName('animateTransform');
    var i;
    for (i = 0; i < plain.length; i += 1) all.push({ node: plain[i], transform: false });
    for (i = 0; i < transforms.length; i += 1) all.push({ node: transforms[i], transform: true });

    all.forEach(function (entry) {
      var node = entry.node;
      var parent = node.parentNode;
      if (!parent || !parent.setAttribute) return;
      var anim = {
        dur: node.getAttribute('dur'),
        from: node.getAttribute('from'),
        to: node.getAttribute('to'),
        values: node.getAttribute('values'),
        keyTimes: node.getAttribute('keyTimes'),
        repeatCount: node.getAttribute('repeatCount'),
        fill: node.getAttribute('fill'),
        type: node.getAttribute('type'),
        attributeName: node.getAttribute('attributeName')
      };
      if (entry.transform) {
        var t = smilTransformAt(anim, timeMs);
        if (t) parent.setAttribute('transform', t);
        return;
      }
      if (!anim.attributeName) return;
      var v = smilValueAt(anim, timeMs);
      if (v !== null) parent.setAttribute(anim.attributeName, v);
    });

    all.forEach(function (entry) {
      if (entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
    });

    return new root.XMLSerializer().serializeToString(doc);
  }

  async function svgFrames(source, options) {
    var text = await source.text();
    var intrinsic = svgIntrinsicSize(text);

    var width = options.width || (intrinsic && intrinsic.width);
    var height = options.height || (intrinsic && intrinsic.height);
    if (!width || !height) {
      throw new Error('An SVG needs an explicit width and height — it has no reliable ' +
        'intrinsic size and none could be read from it');
    }
    width = dim(width);
    height = dim(height);

    if (!svgLooksAnimated(text)) return [await rasteriseSvg(text, width, height)];

    /* SMIL can be evaluated here. CSS cannot, short of a CSS engine, so say so
       rather than shipping a sequence of identical frames. */
    if (!/<\s*animate/i.test(text)) {
      warn(options, 'This SVG animates with CSS, which cannot be sampled here, so only ' +
        'one frame was produced — it will ship as a still');
      return [await rasteriseSvg(text, width, height)];
    }

    var count = Math.max(1, Math.round(options.frames || 30));
    var duration = options.duration || svgDurationMs(text) || 1000;
    var frames = [];
    for (var i = 0; i < count; i += 1) {
      /* The last sample stops a step short of the full duration, so a looping
         animation does not end by repeating its own first frame. */
      frames.push(await rasteriseSvg(svgAtTime(text, (i * duration) / count), width, height));
    }
    return frames;
  }

  /* =================================================================== API */

  async function framesFrom(source, options) {
    options = options || {};
    if (!source) throw new Error('No file given');

    /* The format is checked before the environment is: an unsupported file is
       the author's problem and the message should say which formats work, not
       blame the browser. */
    var type = normaliseType(source);
    if (!isSupportedType(type)) {
      throw new Error('Cannot turn "' + (type || 'an unknown type') + '" into a Plymouth asset — ' +
        'PNG, JPEG, GIF and SVG are the formats this generator accepts');
    }

    if (type === 'image/svg+xml') {
      if (typeof root.Image !== 'function' || !root.URL) {
        throw new Error('This environment cannot rasterise SVG (no Image or URL)');
      }
      return svgFrames(source, options);
    }

    if (typeof root.createImageBitmap !== 'function') {
      throw new Error('This environment cannot decode images (no createImageBitmap)');
    }
    if (type === 'image/gif') return gifFrames(source, options);
    return [await decodeStill(source)];
  }

  /* The rectangle a theme falls back to when the author supplied no art, in the
     element's own preview colour. An unparseable colour is not an error: the
     canvas keeps whatever it had, which starts as black. */
  async function placeholderPng(colour, width, height) {
    var canvas = makeCanvas(width, height);
    var ctx = ctxOf(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = colour ? String(colour) : '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return toBlobOf(canvas);
  }

  async function resizePng(frame, width, height) {
    var w = dim(width);
    var h = dim(height);
    var canvas = makeCanvas(w, h);
    var ctx = ctxOf(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvasOf(frame), 0, 0, w, h);
    return toBlobOf(canvas);
  }

  async function toPng(frame) {
    return toBlobOf(canvasOf(frame));
  }

  /* Cheap classification, without decoding pixels: enough to decide whether a
     sequence folder is needed and what to tell the author about the file. */
  async function describe(source) {
    if (!source) throw new Error('No file given');
    var type = normaliseType(source);

    if (type === 'image/png' || type === 'image/jpeg') return classify(type, false);
    if (type === 'image/svg+xml') return classify(type, svgLooksAnimated(await source.text()));
    if (type === 'image/gif') {
      var bytes = new Uint8Array(await source.arrayBuffer());
      /* A GIF with one image is a still, whatever its extension says. */
      return classify(type, gifFrameCount(bytes) > 1);
    }
    throw new Error('Cannot describe "' + (type || 'an unknown type') + '" — ' +
      'PNG, JPEG, GIF and SVG are the formats this generator accepts');
  }

  root.PlymRaster = {
    /* the API */
    framesFrom: framesFrom,
    placeholderPng: placeholderPng,
    resizePng: resizePng,
    toPng: toPng,
    describe: describe,

    /* internals, exposed because they are the half that can be tested under
       Node and because the check page reports on them directly */
    dim: dim,
    normaliseType: normaliseType,
    isSupportedType: isSupportedType,
    gifLogicalSize: gifLogicalSize,
    gifFrameCount: gifFrameCount,
    svgLooksAnimated: svgLooksAnimated,
    svgDurationMs: svgDurationMs,
    svgIntrinsicSize: svgIntrinsicSize,
    parseClock: parseClock,
    smilProgress: smilProgress,
    interpolateValue: interpolateValue,
    interpolateList: interpolateList,
    smilValueAt: smilValueAt,
    smilTransformAt: smilTransformAt,
    svgAtTime: svgAtTime,
    classify: classify,
    makeCanvas: makeCanvas,
    toBlobOf: toBlobOf
  };
})(typeof window !== 'undefined' ? window : globalThis);
