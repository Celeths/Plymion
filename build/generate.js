/* ============================================================================
   Plymouth Theme Generator — generation (milestone 2, part 4)
   ----------------------------------------------------------------------------
   Turns the plan from build/theme.js into actual files: every placeholder drawn,
   every supplied file decoded and converted, everything encoded as PNG, and the
   lot handed to build/output.js to write.

   This is the only module that needs a browser, because it is the only one that
   touches pixels. Everything it calls is pure or async, so it can be driven from
   the app, from a test page, or from Node with the raster half stubbed.

   Three rules it exists to enforce:

     - Everything is a PNG. Plymouth's loader reads PNG and BMP only, and
       `ply-image.c` dispatches on magic bytes, so a JPEG or a GIF or an SVG
       would simply fail to load.

     - A placeholder is written for every tier the element shows in, at that
       tier's exact size — the generator knows all four, so it can. A file the
       author supplied is written once, into the single folder whose target needs
       the least scaling.

     - A supplied file with a hardcoded size is resized to fit on creation. One
       whose size depends on the screen is stored as it came and scaled by the
       theme at run time, because the size it needs is not knowable here.
   ========================================================================= */
(function (root) {
  'use strict';

  var M = root.PlymModel;
  var A = root.PlymPlacement;
  var T = root.PlymTheme;
  var R = root.PlymRaster;
  var O = root.PlymOutput;

  function pngName(id) {
    return id + '.png';
  }

  /* The filename a frame takes inside its sequence folder. Not zero-padded, so
     frame 10 is `-10.png` — the count is found by probing slots in order, and
     padding buys nothing. */
  function framePath(tier, id, index) {
    return 'assets/' + tier + '/' + id + '/' + id + '-' + index + '.png';
  }

  function blobOfText(text) {
    return new Blob([text], { type: 'text/plain' });
  }

  /* Turn one planned entry into the blobs it actually produces. Returns the
     entries to add; an asset the author deleted is simply absent, which is how
     "remove a file to remove the element" works. */
  async function buildArt(entry, warnings) {
    var out = [];
    var source = entry.upload;
    if (!source) return out;

    var first = entry.tiers[0];
    var probe = entry.targets[first] || { width: 1, height: 1 };

    var frames;
    try {
      frames = await R.framesFrom(source.data ? dataUrlBlob(source) : source.raw,
        {
          width: probe.width,
          height: probe.height,
          onWarn: function (msg) { warnings.push(entry.id + ': ' + msg); }
        });
    } catch (err) {
      warnings.push(entry.id + ': could not be used — ' + (err && err.message ? err.message : err));
      return out;
    }
    if (!frames.length) {
      warnings.push(entry.id + ': decoded to no frames');
      return out;
    }

    /* Which folder. Judged on the decoded size against every tier this element
       shows in, so the copy stored is the one needing least resampling. */
    var place = A.placeTier(frames[0].width, frames[0].height, entry.targets) || first;
    var target = entry.targets[place] || probe;

    var animated = frames.length > 1;
    for (var i = 0; i < frames.length; i += 1) {
      var path = animated
        ? framePath(place, entry.id, i + 1)
        : 'assets/' + place + '/' + pngName(entry.id);

      var blob;
      if (entry.resize || animated) {
        /* A sequence is always sized: every frame has to match the one before
           it, and the theme sets them on a single sprite. */
        blob = await R.resizePng(frames[i], target.width, target.height);
      } else {
        blob = await R.toPng(frames[i]);
      }
      out.push({ path: path, blob: blob, kind: 'art', tier: place, frame: i + 1 });
    }
    return out;
  }

  /* An uploaded asset arrives as a data URL, which is what makes a save file
     self-contained. fetch() turns it back into a Blob without touching the
     network — data: URLs never leave the page. */
  function dataUrlBlob(upload) {
    var parts = String(upload.data).split(',');
    var meta = parts[0] || '';
    var body = parts.slice(1).join(',');
    var mime = (/data:([^;]*)/.exec(meta) || [])[1] || upload.type || 'application/octet-stream';
    if (/;base64/.test(meta)) {
      var bin = atob(body);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(body)], { type: mime });
  }

  /* --------------------------------------------------------------- the run */

  /* `onProgress(stage, done, total)` is called as work proceeds so a caller can
     show something during a run that may touch hundreds of files. */
  async function run(state, options) {
    var opts = options || {};
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var warnings = [];

    var plan = T.planFiles(state);
    var files = [];
    var total = plan.files.length;

    /* Placeholders, script and descriptor come straight off the plan. */
    for (var i = 0; i < plan.files.length; i += 1) {
      var f = plan.files[i];
      onProgress('plan', i + 1, total);
      if (f.kind === 'placeholder') {
        files.push({
          path: f.path,
          blob: await R.placeholderPng(f.colour, f.width, f.height),
          kind: 'placeholder'
        });
      } else if (f.kind === 'script' || f.kind === 'descriptor') {
        files.push({ path: f.path, blob: blobOfText(f.text), kind: f.kind });
      } else if (f.kind === 'art') {
        var made = await buildArt(f, warnings);
        for (var k = 0; k < made.length; k += 1) files.push(made[k]);
      }
    }

    /* Duplicate paths would mean two elements claiming one filename. The theme
       tolerates it, but it is always a mistake worth surfacing. */
    var seen = Object.create(null);
    var duplicates = [];
    files.forEach(function (x) {
      if (seen[x.path]) duplicates.push(x.path);
      seen[x.path] = true;
    });
    if (duplicates.length) {
      warnings.push('two elements produced the same file: ' + duplicates.join(', '));
    }

    var result = {
      name: plan.name,
      files: files,
      warnings: warnings,
      errors: plan.errors.slice(),
      overrides: plan.overrides,
      text: plan.text
    };

    if (opts.write === false) return result;

    onProgress('writing', files.length, files.length);
    var written = await O.writeTheme(files, plan.name);
    result.method = written.method;
    result.count = written.count;
    result.artefact = written.name;
    return result;
  }

  root.PlymGenerate = {
    run: run,
    dataUrlBlob: dataUrlBlob,
    framePath: framePath,
    pngName: pngName
  };
})(typeof window !== 'undefined' ? window : globalThis);
