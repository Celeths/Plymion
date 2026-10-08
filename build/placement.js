/* ============================================================================
   Plymouth Theme Generator — placement (milestone 2, part 2)
   ----------------------------------------------------------------------------
   Pure decisions, no text output: which variant folder a supplied asset belongs
   in, and in what order the theme should look for it at run time.

   The four folders hold the same asset at four sizes:

     assets/720p/  1080p/  1440p/  2160p/

   A placeholder is written into all four, because the generator is the one
   making it and knows every tier's exact size. A file the author supplies is
   written to *one*, the folder whose target size is closest to what they gave
   us — that is the copy that needs the least resampling, and the theme scales
   it from there. Storing one copy rather than four also means we never silently
   upscale their art 3x and present the result as if it were native.

   At run time the theme takes the nearest folder that actually has the file.
   Both directions are allowed: a screen between two tiers is better served by
   whichever is closer, and a larger asset downscaled looks better than a
   smaller one stretched.
   ========================================================================= */
(function (root) {
  'use strict';

  var M = root.PlymModel;

  /* Ascending by screen height, which is also the fallback order. */
  function tierIds() {
    return M.TIERS.map(function (t) { return t.id; });
  }

  function tierById(id) {
    return M.TIERS.filter(function (t) { return t.id === id; })[0] || null;
  }

  /* The folders to try on a given screen, nearest first.

     Distance is measured on the screen *height*, since that is what `scale`
     follows and what the tiers are named for. Ties go to the taller folder:
     1080p sits exactly between 720p and 1440p, and downscaling the larger one
     looks better than stretching the smaller. */
  function nearestOrder(runtimeTierId) {
    var here = tierById(runtimeTierId);
    if (!here) return tierIds();
    return M.TIERS.slice().sort(function (a, b) {
      var da = Math.abs(a.height - here.height);
      var db = Math.abs(b.height - here.height);
      if (da !== db) return da - db;
      return b.height - a.height;
    }).map(function (t) { return t.id; });
  }

  /* Which folder a supplied asset belongs in.

     `targets` maps tier id -> { width, height }, the size the element actually
     resolves to at that tier. The best folder is the one whose target needs the
     least scaling of the supplied pixels.

     The error is the geometric mean of the two axis ratios, so it is neutral
     about an asset whose aspect ratio differs from the element's: doubling both
     axes is as wrong as halving both, and a 2:1 source into a 1:1 box is not
     ranked as if it fitted. Every candidate is expressed as a factor, and the
     one closest to 1 wins — equivalently, the smallest |ln factor|. */
  function placeTier(nativeWidth, nativeHeight, targets) {
    var ids = Object.keys(targets);
    if (!ids.length) return null;
    if (!nativeWidth || !nativeHeight) return ids[0];

    /* Walked smallest first so an exact tie goes to the smaller folder: less to
       decode, less to hold. A tie is a real outcome — a 4:1 source into two 1:1
       boxes is equally wrong either way, at factor 0.5 and factor 2. */
    ids = ids.slice().sort(function (a, b) {
      var ta = targets[a] || {};
      var tb = targets[b] || {};
      return (ta.height || 0) - (tb.height || 0);
    });

    var best = null;
    var bestError = Infinity;
    ids.forEach(function (id) {
      var t = targets[id];
      if (!t || !t.width || !t.height) return;
      var ratio = Math.sqrt((t.width / nativeWidth) * (t.height / nativeHeight));
      var error = Math.abs(Math.log(ratio));
      if (error < bestError - 1e-12) {
        bestError = error;
        best = id;
      }
    });
    return best;
  }

  /* Every tier an element is set to show in, in ascending order. Only these
     need a copy of the asset at all. */
  function tiersForElement(def) {
    var chosen = Array.isArray(def.showInTiers) && def.showInTiers.length
      ? def.showInTiers
      : tierIds();
    return tierIds().filter(function (id) { return chosen.indexOf(id) > -1; });
  }

  root.PlymPlacement = {
    tierIds: tierIds,
    tierById: tierById,
    nearestOrder: nearestOrder,
    placeTier: placeTier,
    tiersForElement: tiersForElement
  };
})(typeof window !== 'undefined' ? window : globalThis);
