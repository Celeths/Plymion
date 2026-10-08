/* ============================================================================
   Plymouth Theme Generator — editor logic (milestone 1: the GUI)

   The app owns one `state` object shaped exactly like PlymModel.defaultState().
   Everything on screen is a projection of that state through
   PlymModel.resolveAll(), so the numbers shown in the sidebar are the same
   numbers a milestone-2 generator would read out of the exported JSON.

   Value sources, per x/y/w/h field
     base      the element's own property. A bare number is a 720p measurement
               and is multiplied by the tier scale; anything else is a formula
               evaluated at the current tier (e.g. `50vw - (main.w / 2)`).
     override  state.elements[i].overrides[tierId][prop]. Only consulted for the
               tier it names, and a bare number there is an absolute pixel value
               for that tier — never scaled.

   Editing a field writes to whichever source currently supplies its value, so a
   hand-pinned 1080p value stays pinned while you edit. Dragging on the canvas
   follows the same rule and converts screen pixels back into that source's unit.

   The live-view shape
     state.viewport is null for a tier's native 16:9, or { width, height } to
     preview another aspect ratio. It reshapes the *current* tier rather than
     adding a fifth one, so per-tier overrides and the top-bar highlight stay
     keyed to a real preset. See PlymModel.shapeTier() for the scale rule.
   ========================================================================= */
(function () {
  'use strict';

  var M = window.PlymModel;

  /* ------------------------------------------------------------- app state */

  var state = M.defaultState();
  var resolved = null;            // resolution of `state` at the current tier
  var selectedId = null;
  var drag = null;
  var zoomFactor = 1;
  var frozenZoom = null;          // held while a shape drag is live, so the
                                  // dragged edge tracks the cursor under 'fit'
  var shapeDrag = null;
  var uid = 0;

  /* The template's own values, so a field can offer to revert. */
  var TEMPLATE_DEFAULTS = {};
  M.ELEMENTS.forEach(function (def) {
    TEMPLATE_DEFAULTS[def.id] = { x: def.x, y: def.y, w: def.w, h: def.h };
  });

  /* ------------------------------------------------------------------ dom */

  var dom = {};
  [
    'stage', 'frame', 'frameHandles', 'screen', 'overlay', 'sidebar',
    'tierSelect', 'modeSelect', 'modeHelp', 'zoomSelect',
    'fileBtn', 'fileMenu', 'undoBtn', 'redoBtn', 'onDemandToggle', 'onDemandHelp',
    'demandBtn', 'demandMenu',
    'paddingToggle', 'paddingBody',
    'saveBtn', 'exportBtn', 'importBtn', 'importFile', 'assetFile', 'generateBtn',
    'resetBtn', 'themeName', 'themeDesc', 'themeRefresh',
    'paddingList', 'elementList', 'elementCount',
    'onlyShown', 'statusTier', 'statusSel', 'statusPixels', 'shapeReset',
    'statusCounts', 'addSelect', 'addPaddingBtn', 'assetTip'
  ].forEach(function (id) { dom[id] = document.getElementById(id); });

  var ALL_TIER_IDS = M.TIERS.map(function (t) { return t.id; });

  var rows = {};        // element id -> row refs
  /* Which rows are folded shut. Not in `state`: it does not change the theme,
     and it should not survive a save as if it did. */
  var collapsed = {};

  /* ================================================================ history */
  /*
     Snapshots of the editor state, so a change can be taken back. Deliberately
     not everything: selection, zoom, the tier, the live-view shape and the
     on-demand picks are ways of looking at the theme, not edits to it, and
     putting them in would make Undo jump the view around as well as the work.

     Uploaded files are the exception to "snapshot everything". Their bytes are
     megabytes of data URL, and copying them into every entry would make the
     history heavier than the theme. A snapshot keeps the name and a reference
     instead, and the bytes are held once in a side table — so undo still puts
     the picture back without the history carrying it.
  */
  var HISTORY_LIMIT = 60;
  var historyLock = false;      /* set while restoring, so a restore is not recorded */
  var assetStash = {};          /* reference -> data URL, held once */
  var hist = { past: [], future: [], last: null, label: '', at: 0 };

  function assetRef(upload) {
    return upload.name + '|' + (upload.size || 0) + '|' + (upload.type || '');
  }

  /* A clone of the state safe to keep: files referenced, not embedded. */
  function snapshot() {
    var copy = M.clone(state);
    copy.elements.forEach(function (el) {
      var up = el.upload;
      if (!up) return;
      if (up.data) assetStash[assetRef(up)] = up.data;
      el.upload = {
        name: up.name, type: up.type, size: up.size,
        width: up.width, height: up.height, ref: assetRef(up)
      };
    });
    return copy;
  }

  /* Put the bytes back for anything the snapshot only referenced. */
  function rehydrate(snap) {
    var next = M.clone(snap);
    next.elements.forEach(function (el) {
      var up = el.upload;
      if (up && !up.data && up.ref && assetStash[up.ref]) {
        up.data = assetStash[up.ref];
        delete up.ref;
      } else if (up && up.ref) {
        /* the file is gone from this session, so the element has no art */
        el.upload = null;
      }
    });
    return next;
  }

  function syncHistoryButtons() {
    if (!dom.undoBtn) return;
    dom.undoBtn.disabled = hist.past.length === 0;
    dom.redoBtn.disabled = hist.future.length === 0;
  }

  /* Called after an undoable change. The entry pushed is the state as it was
     before it, which is why this runs after the mutation. Typing in a field
     fires continuously, so a run of the same kind of edit within a moment
     counts as one step rather than one per keystroke. */
  function commit(label) {
    if (historyLock) return;
    var now = Date.now();
    var sameRun = label === hist.label && (now - hist.at) < 700;
    if (!sameRun) {
      hist.past.push(hist.last);
      if (hist.past.length > HISTORY_LIMIT) hist.past.shift();
      hist.future.length = 0;
    }
    hist.last = snapshot();
    hist.label = label;
    hist.at = now;
    syncHistoryButtons();
  }

  function restore(snap) {
    historyLock = true;
    var next = rehydrate(snap);
    /* A snapshot holds the whole state, but the history is meant to cover edits
       only. Ways of looking at the theme — which screen size, the live-view
       shape, the zoom, the preview mode, the on-demand picks — are kept as they
       are now, so Undo moves the work back without jumping the view with it. */
    next.tier = state.tier;
    next.viewport = state.viewport;
    next.zoom = state.zoom;
    next.previewMode = state.previewMode;
    next.onlyShown = state.onlyShown;
    next.showOnDemandAll = state.showOnDemandAll;
    next.demandPick = (state.demandPick || []).slice();
    state = next;
    selectedId = null;
    drag = null;
    shapeDrag = null;
    frozenZoom = null;
    closeTip(true);
    dom.onlyShown.checked = state.onlyShown;
    dom.zoomSelect.value = state.zoom;
    render(true);
    historyLock = false;
  }

  function undo() {
    if (!hist.past.length) return;
    hist.future.push(hist.last);
    var snap = hist.past.pop();
    restore(snap);
    hist.last = snap;
    hist.label = '';
    syncHistoryButtons();
    flashStatus('Undo.');
  }

  function redo() {
    if (!hist.future.length) return;
    hist.past.push(hist.last);
    var snap = hist.future.pop();
    restore(snap);
    hist.last = snap;
    hist.label = '';
    syncHistoryButtons();
    flashStatus('Redo.');
  }

  /* Start again from the state as it is now — after a load, a reset, or a
     generation, none of which should be undoable. */
  function historyReset() {
    hist.past = [];
    hist.future = [];
    hist.label = '';
    hist.at = 0;
    hist.last = snapshot();
    syncHistoryButtons();
  }
  var art = {};         // element id -> canvas art node
  var fills = {};       // element id -> its colour layer inside the art node
  var images = {};      // element id -> its uploaded-asset layer, if it may have one
  var badges = {};      // element id -> the filename badge over the art node
  var labels = {};      // element id -> the text span, for showing another string
  var boxes = {};       // element id -> overlay selection box

  /* -------------------------------------------------------------- helpers */

  /* The tier being previewed: the selected preset, reshaped by state.viewport
     when the live view has been dragged off 16:9. */
  function tier() {
    var base = null;
    for (var i = 0; i < M.TIERS.length; i += 1) {
      if (M.TIERS[i].id === state.tier) { base = M.TIERS[i]; break; }
    }
    if (!base) base = M.TIERS[0];
    var vp = state.viewport;
    if (!vp) return base;
    return M.shapeTier(base, vp.width, vp.height);
  }

  function fmt(n) {
    if (!isFinite(n)) return '';
    return String(Math.round(n * 100) / 100);
  }

  function byId(id) {
    for (var i = 0; i < state.elements.length; i += 1) {
      if (state.elements[i].id === id) return state.elements[i];
    }
    return null;
  }

  function overrideFor(def, prop) {
    var tierOv = def.overrides && def.overrides[state.tier];
    if (!tierOv) return null;
    var v = tierOv[prop];
    return v === undefined || v === '' ? null : v;
  }

  function setOverride(def, prop, text) {
    if (!def.overrides) def.overrides = {};
    if (!def.overrides[state.tier]) def.overrides[state.tier] = {};
    if (text === null) {
      delete def.overrides[state.tier][prop];
      if (!Object.keys(def.overrides[state.tier]).length) delete def.overrides[state.tier];
    } else {
      def.overrides[state.tier][prop] = text;
    }
  }

  /* The expression a field is currently sourcing its value from. */
  function sourceText(def, prop) {
    var ov = overrideFor(def, prop);
    return ov === null ? String(def[prop]) : ov;
  }

  /* Drawn when the previewed mode is one the element supports — unless it has
     been pinned to a single mode by hand, which is an explicit override. */
  function isModeVisible(def) {
    if (state.previewMode === 'all') return true;
    return showInOf(def).indexOf(state.previewMode) > -1;
  }

  /* The modes an element is set to show in. Absent or empty falls back to
     everything it supports, so a half-written session still draws something. */
  function showInOf(def) {
    if (Array.isArray(def.showIn) && def.showIn.length) return def.showIn;
    return def.modes || M.ALL_MODE_IDS;
  }

  /* The screen sizes it is set to show in, on the same terms. */
  function showInTiersOf(def) {
    if (Array.isArray(def.showInTiers) && def.showInTiers.length) return def.showInTiers;
    return ALL_TIER_IDS;
  }

  function isTierVisible(def) {
    return showInTiersOf(def).indexOf(state.tier) > -1;
  }

  /* Elements the editor refuses to restructure. Only `background` is locked:
     a theme always has one, so it stays full screen at 0,0, always enabled, in
     every mode, at a fixed z, and cannot be deleted. Its colour still changes.
     Every mutation path below checks this — the disabled controls alone would
     leave drag, the arrow keys and import routes open. */
  function isLocked(def) {
    return !!(def && def.locked);
  }

  /* The sidebar is a settings list, so the two full-screen backdrops are shown
     last, underneath the elements you actually work at. `state.elements` keeps
     the model's declaration order, which is what decides how same-z elements
     stack on the canvas — the list order is display only, so reordering it can
     never repaint the theme by accident. */
  /* The order the element list shows, which is not the paint order: the canvas
     walks state.elements so that equal z-indexes settle the way the template
     declared them, while the list reads in the order an author cares about.
     Elements added in this session sit on top, then the template's own in
     priority order, then the backdrops. */
  /* The template's elements in the order an author is most likely to want them. */
  function rankedElements() {
    var rank = {};
    M.ELEMENT_ORDER.forEach(function (id, i) { rank[id] = i; });
    return M.ELEMENTS.slice().sort(function (a, b) {
      var ra = rank[a.id] === undefined ? 999 : rank[a.id];
      var rb = rank[b.id] === undefined ? 999 : rank[b.id];
      return ra - rb;
    });
  }

  function displayOrder() {
    var rank = {};
    M.ELEMENT_ORDER.forEach(function (id, i) { rank[id] = i; });

    var added = [];
    var known = [];
    var backdrops = [];
    state.elements.forEach(function (def) {
      if (def.kind === 'background') backdrops.push(def);
      else if (def.custom || rank[def.origin] === undefined) added.push(def);
      else known.push(def);
    });
    known.sort(function (a, b) { return rank[a.origin] - rank[b.origin]; });
    return added.concat(known, backdrops);
  }

  /* The layout template paints its debug fills with CSS colour keywords
     (layout.html uses darkcyan, indigo, lightblue, coral, gold, brown, silver…)
     but <input type="color"> only accepts #rrggbb, so the picker needs the
     keyword translated. Only the names the template actually uses are listed. */
  var CSS_COLORS = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
    blue: '#0000ff', cyan: '#00ffff', gold: '#ffd700', brown: '#a52a2a',
    coral: '#ff7f50', silver: '#c0c0c0', indigo: '#4b0082', darkcyan: '#008b8b',
    lightblue: '#add8e6', dimgray: '#696969', gray: '#808080', grey: '#808080',
    orange: '#ffa500', purple: '#800080', teal: '#008080', navy: '#000080',
    maroon: '#800000', olive: '#808000', lime: '#00ff00', pink: '#ffc0cb'
  };

  /* Any CSS colour the model holds -> the #rrggbb the colour input needs.
     Unknown values fall back to black rather than throwing; the swatch itself
     still shows the true value, so nothing is silently rewritten. */
  function hexFor(css) {
    if (!css) return '#000000';
    var v = String(css).trim().toLowerCase();
    if (CSS_COLORS[v]) return CSS_COLORS[v];
    if (v.charAt(0) === '#') {
      if (/^#[0-9a-f]{3}$/.test(v)) {
        return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      }
      return /^#[0-9a-f]{6}$/.test(v) ? v : '#000000';
    }
    return '#000000';
  }

  /* Plymouth's animation slots take either a single still or a numbered frame
     sequence — layout.html calls them "Animation or Image" — so the label names
     both. The stored `kind` stays the short value the rest of the code keys on
     (canvas styling, the add dialog, the export). */
  var KIND_LABEL = {
    image: 'image',
    animation: 'image / animation',
    text: 'text',
    background: 'background'
  };

  /* Which files an element will take for its own asset. A still element takes
     the still formats; an element that can be animated may also take a GIF.
     `accept` is only a hint to the file picker — a picker can be made to show
     every file, so the extension is checked again on the way in. */
  var ASSET_TYPES = {
    image: {
      exts: ['png', 'svg', 'jpg', 'jpeg'],
      accept: '.png,.svg,.jpg,.jpeg',
      what: 'PNG, SVG or JPG'
    },
    animation: {
      exts: ['png', 'svg', 'jpg', 'jpeg', 'gif'],
      accept: '.png,.svg,.jpg,.jpeg,.gif',
      what: 'PNG, SVG, JPG or GIF'
    }
  };

  function assetRule(def) {
    return ASSET_TYPES[def.kind] || null;
  }

  function kindLabel(def) {
    return (KIND_LABEL[def.kind] || def.kind) + ' asset';
  }

  /* "an image asset", but "a text asset" */
  function article(word) {
    return /^[aeiou]/i.test(word) ? 'an' : 'a';
  }

  /* Shown means enabled, in the mode being previewed, and laid out for the size
     being previewed. All three narrow the canvas and the element list alike. */
  function isShown(def) {
    return !!def.enabled && isModeVisible(def) && isTierVisible(def) && isDemandVisible(def);
  }

  /* The elements Plymouth calls when they are wanted, rather than the mode
     deciding. Show all draws every one of them; otherwise only the groups the
     author picked, so the console can be left out — it covers the whole screen
     and would hide the status line, the progress bar and the dialog behind it. */
  function isDemandVisible(def) {
    if (!def.onDemand) return true;
    if (state.showOnDemandAll) return true;
    var picked = state.demandPick || [];
    return (def.demandGroups || []).some(function (g) { return picked.indexOf(g) > -1; });
  }

  /* Picking every group is the same thing as Show all, so the two controls are
     kept in step rather than being able to disagree: all picked collapses to
     none picked plus the checkbox. */
  function allGroupsPicked() {
    return M.DEMAND_GROUPS.length > 0 &&
      state.demandPick.length === M.DEMAND_GROUPS.length;
  }

  /* Resolve and repaint. `structural` rebuilds the DOM trees; without it only
     values, classes and geometry are refreshed (so typing never loses focus). */
  function render(structural) {
    resolved = M.resolveAll(state, tier());
    zoomFactor = currentZoom();

    if (structural) {
      buildCanvas();
      buildRows();
      buildPaddingList();
    }
    applyFrame();
    syncCanvas();
    syncRows();
    syncPaddings();
    syncTopbar();
    syncStatus();
  }

  /* =================================================================== zoom */

  function currentZoom() {
    /* a live shape drag pins the zoom: under 'fit' the factor grows as the box
       shrinks, so the frame would chase the cursor instead of following it */
    if (frozenZoom !== null) return frozenZoom;
    if (state.zoom !== 'fit') return parseFloat(state.zoom) || 1;
    var t = tier();
    var availW = Math.max(120, dom.stage.clientWidth - 56);
    var availH = Math.max(120, dom.stage.clientHeight - 56);
    var z = Math.min(availW / t.width, availH / t.height);
    return Math.max(0.05, Math.min(z, 2));
  }

  function applyFrame() {
    var t = tier();
    var z = zoomFactor;
    dom.frame.style.width = (t.width * z) + 'px';
    dom.frame.style.height = (t.height * z) + 'px';
    dom.screen.style.width = t.width + 'px';
    dom.screen.style.height = t.height + 'px';
    dom.screen.style.transform = 'scale(' + z + ')';
  }

  /* ========================================================= live-view shape */

  /* Eight drag handles around the frame. The frame is centred in the stage, so
     a resize is applied symmetrically: each edge covers half of the change in
     size, which keeps the centre fixed and holds the dragged edge under the
     cursor. `state.viewport` records the chosen box; null means the tier keeps
     its native 16:9. */
  var SHAPE_HANDLES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
  var SHAPE_MIN = 160;      // theme px: below this a tier stops being legible
  var SHAPE_MAX = 7680;

  function buildShapeHandles() {
    dom.frameHandles.innerHTML = '';
    SHAPE_HANDLES.forEach(function (dir) {
      var h = document.createElement('div');
      h.className = 'fv-handle fv-' + dir;
      h.dataset.dir = dir;
      h.title = 'Drag to resize the live view — double-click for the native shape';
      h.addEventListener('pointerdown', function (e) { onShapeDown(e, dir); });
      h.addEventListener('dblclick', function () { setShape(null); });
      dom.frameHandles.appendChild(h);
    });
  }

  /* null restores the tier's native shape. */
  function setShape(size) {
    state.viewport = size ? { width: size.width, height: size.height } : null;
    render(false);
  }

  /* The element's preview colour. null means "no colour", which the canvas and
     the swatch both render as transparent plus a hatch. */
  function setColor(def, value) {
    def.background = value || null;
    render(false);
  }

  /* Limits one axis of the drag by capping the delta rather than the result, so
     once the cursor overshoots a limit the opposite edge stays put instead of
     the box creeping. */
  function capAxis(start, delta) {
    var limit = start + delta < SHAPE_MIN ? SHAPE_MIN
              : start + delta > SHAPE_MAX ? SHAPE_MAX : null;
    return limit === null ? delta : limit - start;
  }

  function onShapeDown(e, dir) {
    if (e.button) return;
    var t = tier();
    /* Pin the zoom for the length of the drag. Under 'fit' the factor is a
       function of the box, so it would change as the box does and the frame
       would chase the cursor instead of tracking it. */
    if (state.zoom === 'fit') frozenZoom = zoomFactor;
    shapeDrag = {
      dir: dir,
      startClientX: e.clientX,
      startClientY: e.clientY,
      width: t.width,
      height: t.height,
      zoom: currentZoom()
    };
    dom.frame.classList.add('is-shaping');
    var node = e.currentTarget;
    if (node.setPointerCapture) {
      try { node.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
    }
    node.addEventListener('pointermove', onShapeMove);
    node.addEventListener('pointerup', onShapeUp);
    node.addEventListener('pointercancel', onShapeUp);
    /* deliberately no preventDefault(): suppressing the pointerdown default is
       what some browsers treat as suppressing the dblclick that resets the
       shape. Selection is held off with `user-select: none` in the stylesheet,
       and stopPropagation keeps the stage's deselect handler out. */
    e.stopPropagation();
  }

  function onShapeMove(e) {
    if (!shapeDrag) return;
    var d = shapeDrag.dir;
    var dx = (e.clientX - shapeDrag.startClientX) / shapeDrag.zoom;
    var dy = (e.clientY - shapeDrag.startClientY) / shapeDrag.zoom;
    /* e/w and n/s are mutually exclusive, so one term survives per axis. Sizes
       are rounded to even numbers, as display modes usually are. */
    var growW = (d.indexOf('e') > -1 ? 2 * dx : 0) - (d.indexOf('w') > -1 ? 2 * dx : 0);
    var growH = (d.indexOf('s') > -1 ? 2 * dy : 0) - (d.indexOf('n') > -1 ? 2 * dy : 0);
    setShape({
      width: Math.round((shapeDrag.width + capAxis(shapeDrag.width, growW)) / 2) * 2,
      height: Math.round((shapeDrag.height + capAxis(shapeDrag.height, growH)) / 2) * 2
    });
  }

  function onShapeUp(e) {
    var node = e.currentTarget;
    node.removeEventListener('pointermove', onShapeMove);
    node.removeEventListener('pointerup', onShapeUp);
    node.removeEventListener('pointercancel', onShapeUp);
    if (node.hasPointerCapture && node.hasPointerCapture(e.pointerId)) {
      node.releasePointerCapture(e.pointerId);
    }
    shapeDrag = null;
    frozenZoom = null;
    dom.frame.classList.remove('is-shaping');
    /* release the frozen zoom, so 'fit' re-fits around the new shape */
    render(false);
  }

  /* The live view's aspect ratio, reduced, for the status bar. */
  function aspectLabel(w, h) {
    function gcd(a, b) { return b ? gcd(b, a % b) : a; }
    var g = gcd(Math.round(w), Math.round(h)) || 1;
    var rw = Math.round(w) / g;
    var rh = Math.round(h) / g;
    /* a reduced ratio beyond 40:1 is noise — fall back to a decimal */
    if (rw > 40 || rh > 40) return (w / h).toFixed(2) + ':1';
    return rw + ':' + rh;
  }

  /* A padding can be renamed or deleted out from under a formula, so read one
     defensively: a missing or broken padding collapses to 0 rather than taking
     the whole render down. The element still reports the problem through its own
     resolution. */
  function padValue(name) {
    var pad = name === undefined || name === null ? null : resolved.paddings[name];
    return pad && !pad.error ? pad.value : 0;
  }

  /* ============================================================ element asset */

  /* Which element the shared file input is currently for. */
  var uploadTarget = null;

  function pickAsset(def) {
    var rule = assetRule(def);
    if (!rule) return;
    uploadTarget = def;
    dom.assetFile.setAttribute('accept', rule.accept);
    dom.assetFile.value = '';
    dom.assetFile.click();
  }

  /* The asset's own pixel size, recorded so the generator can tell whether it
     has to resize anything. SVG has no fixed pixel size, so it can stay unknown. */
  function measureAsset(data, done) {
    if (typeof window.Image !== 'function') { done(null, null); return; }
    var probe = new window.Image();
    probe.onload = function () {
      done(probe.naturalWidth || null, probe.naturalHeight || null);
    };
    probe.onerror = function () { done(null, null); };
    probe.src = data;
  }

  /* Kept as a data URL so the save file stays self-contained and still opens
     from file:// — there is no storage to fall back on. */
  function readAsset(file) {
    var def = uploadTarget;
    uploadTarget = null;
    if (!def || !file) return;

    var rule = assetRule(def);
    var ext = String(file.name || '').split('.').pop().toLowerCase();
    if (!rule || rule.exts.indexOf(ext) === -1) {
      flashStatus('"' + file.name + '" is not one of the formats ' + def.label +
        ' takes (' + (rule ? rule.what : 'none') + ').');
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      var data = String(reader.result);
      measureAsset(data, function (w, h) {
        def.upload = {
          name: file.name,
          type: file.type || '',
          size: file.size || 0,
          width: w,
          height: h,
          data: data
        };
        commit('asset');
        render(false);
        flashStatus('Using ' + file.name + ' for ' + def.label +
          (w && h ? ' (' + w + '×' + h + 'px)' : '') + '.');
      });
    };
    reader.onerror = function () { flashStatus('Could not read that file.'); };
    reader.readAsDataURL(file);
  }

  function clearAsset(def) {
    def.upload = null;
    commit('asset');
    render(false);
    flashStatus(def.label + ' is back to the theme\u2019s own asset.');
  }

  /* One row of chips: All, then one per option. Used twice — the screen sizes an
     element appears in, and the modes it appears in — so the two read as a pair
     and cannot drift apart.

     Chips rather than a native <select multiple> because that needs ctrl-click
     to add to a selection and would stand several rows tall in all 27 rows. */
  function buildChipRow(labelText, options, onAll, onToggle) {
    var row = document.createElement('div');
    row.className = 'el-modes';

    var label = document.createElement('span');
    label.className = 'mini';
    label.textContent = labelText;

    var chips = document.createElement('span');
    chips.className = 'mode-chips';

    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'mode-chip is-all';
    all.textContent = 'All';
    all.title = 'Every one of them';
    all.addEventListener('click', onAll);
    chips.appendChild(all);

    var each = [];
    options.forEach(function (o) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mode-chip';
      chip.textContent = o.short || o.label;
      chip.title = o.label;
      chip.dataset.value = o.id;
      chip.addEventListener('click', function () { onToggle(o.id); });
      chips.appendChild(chip);
      each.push(chip);
    });

    row.appendChild(label);
    row.appendChild(chips);
    return { row: row, all: all, chips: each };
  }

  /* Light the chips that are on, and All when nothing has been narrowed away. */
  function paintChips(set, chosen, total) {
    set.chips.forEach(function (chip) {
      chip.classList.toggle('is-on', chosen.indexOf(chip.dataset.value) > -1);
    });
    set.all.classList.toggle('is-on', chosen.length === total);
  }

  /* ================================================================= canvas */

  function buildCanvas() {
    dom.screen.innerHTML = '';
    dom.overlay.innerHTML = '';
    art = {};
    fills = {};
    images = {};
    badges = {};
    labels = {};
    boxes = {};

    state.elements.forEach(function (def) {
      var el = document.createElement('div');
      el.className = 'c-el';
      el.dataset.id = def.id;
      el.dataset.kind = def.kind;

      var fill = document.createElement('div');
      fill.className = 'c-el-fill';
      el.appendChild(fill);
      fills[def.id] = fill;

      if (ASSET_TYPES[def.kind]) {
        var img = document.createElement('img');
        img.className = 'c-el-img';
        img.alt = '';
        el.appendChild(img);
        images[def.id] = img;
      }

      if (def.kind === 'text' && !def.bullets) {
        var span = document.createElement('span');
        span.textContent = def.text || def.label;
        el.appendChild(span);
        labels[def.id] = span;
      } else if (def.asset && def.kind !== 'background') {
        var badge = document.createElement('div');
        badge.className = 'c-el-badge';
        badge.textContent = def.upload ? def.upload.name : def.asset;
        el.appendChild(badge);
        badges[def.id] = badge;
      }

      /* The safe zone draws the row of bullets. It is a text-kind element
         because it is an area rather than a picture, so it takes no string: the
         dots are the content. */
      if (def.bullets) {
        var zoneMark = document.createElement('div');
        zoneMark.className = 'c-zone';
        el.appendChild(zoneMark);
        el.dataset.zone = '1';
        for (var i = 0; i < def.bullets; i += 1) {
          var dot = document.createElement('div');
          dot.className = 'c-bullet';
          dot.style.opacity = '0.85';
          el.appendChild(dot);
        }
      }

      dom.screen.appendChild(el);
      art[def.id] = el;

      var box = document.createElement('div');
      /* A locked backdrop covers the whole canvas, so letting its box take
         pointer events would swallow every click meant for the elements on top
         of it. It has nothing to drag anyway. */
      box.className = isLocked(def) ? 'o-rect is-locked' : 'o-rect';
      box.dataset.id = def.id;
      var label = document.createElement('div');
      label.className = 'o-label';
      label.textContent = def.label;
      box.appendChild(label);
      var handle = document.createElement('div');
      handle.className = 'o-handle';
      handle.dataset.handle = '1';
      box.appendChild(handle);
      box.addEventListener('pointerdown', onBoxPointerDown);
      dom.overlay.appendChild(box);
      boxes[def.id] = box;
    });
  }

  function syncCanvas() {
    var t = tier();
    var scale = t.scale;

    state.elements.forEach(function (def) {
      var r = resolved.elements[def.id];
      var el = art[def.id];
      var box = boxes[def.id];
      var shown = isShown(def) && !r.error && isFinite(r.x) && isFinite(r.w);
      if (!shown) {
        el.style.display = 'none';
        box.style.display = 'none';
        return;
      }
      el.style.display = '';
      box.style.display = '';

      var w = r.w;
      var h = r.h;

      el.style.left = r.x + 'px';
      el.style.top = r.y + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      el.style.zIndex = def.z;

      /* The preview colour is applied here, not only in buildCanvas, so editing
         the swatch repaints on the next frame. `backgroundColor` rather than the
         `background` shorthand, which would reset the CSS placeholder hatch on
         any element with no colour of its own. */
      /* The dot that repeats is the asset, not a drawn thing: the safe zone
         renders the row from it. Drawing one here too put a duplicate on the
         first slot, the only one carrying a filename badge, so it read as a
         stray block that matched nothing. It stays selectable from its row and
         its box stays on the canvas, but it paints nothing. */
      if (def.repeatsIn) {
        fills[def.id].style.backgroundColor = 'transparent';
        el.style.outline = '';
        if (images[def.id]) images[def.id].style.display = 'none';
        if (badges[def.id]) badges[def.id].style.display = 'none';
        el.dataset.assetOf = '1';
        box.style.left = (r.x * zoomFactor) + 'px';
        box.style.top = (r.y * zoomFactor) + 'px';
        box.style.width = (w * zoomFactor) + 'px';
        box.style.height = (h * zoomFactor) + 'px';
        box.classList.toggle('is-selected', selectedId === def.id);
        box.style.display = '';
        return;
      }

      /* A zone's fill is the row's backdrop; the dots carry the bullet colour. */
      fills[def.id].style.backgroundColor = def.background || 'transparent';
      /* An element drawing its own file is no longer a placeholder, whatever
         colour sits behind it. */
      if (def.background || def.upload) delete el.dataset.placeholder;
      else el.dataset.placeholder = '1';

      /* The asset fills the element's box: the export resizes the file to match,
         so previewing it stretched is previewing what will ship. */
      if (images[def.id]) {
        if (def.upload && def.upload.data) {
          if (images[def.id].getAttribute('src') !== def.upload.data) {
            images[def.id].setAttribute('src', def.upload.data);
          }
          images[def.id].style.display = '';
        } else {
          images[def.id].style.display = 'none';
        }
      }

      if (badges[def.id]) {
        badges[def.id].textContent = def.upload ? def.upload.name : (def.asset || '');
      }

      if (def.kind === 'text' && !def.bullets) {
        /* the string is editable, so it is set here and not only at build time */
        if (labels[def.id]) labels[def.id].textContent = def.text || def.label;
        var f = def.font || {};
        el.style.fontFamily = f.family || 'inherit';
        el.style.fontSize = ((parseFloat(f.size) || 16) * scale) + 'px';
        el.style.color = f.color || '#fff';
        el.style.padding = def.padding
          ? '0 ' + padValue(def.padding.right) + 'px 0 ' + padValue(def.padding.left) + 'px'
          : '';
      }

      /* The safe zone shows the sample text as bullets: one dot per character,
         drawn at the bullet element's size and in its colour. That is the only
         way the bullet layer is seen — the bullet element itself is a single
         dot showing what one of them looks like.

         With the bullet element hidden, the zone has no asset to draw, so its
         text simply disappears, which is what Plymouth does with no bullet.png
         to mask with. */
      if (def.bullets) {
        var dotDef = null;
        var zoneId = def.id;
        state.elements.forEach(function (e) { if (e.repeatsIn === zoneId) dotDef = e; });
        var dotR = dotDef ? resolved.elements[dotDef.id] : null;
        var dotShown = !!(dotDef && isShown(dotDef) && dotR && !dotR.error &&
          isFinite(dotR.w) && dotR.w > 0);

        var pad = padValue(def.padding && def.padding.left);
        el.style.padding = '0 ' + pad + 'px';

        var wanted = dotShown
          ? Math.min(String(def.text || '').length, def.bullets)
          : 0;

        var dots = el.querySelectorAll('.c-bullet');
        Array.prototype.forEach.call(dots, function (dot, i) {
          if (i >= wanted) { dot.style.display = 'none'; return; }
          dot.style.display = '';
          dot.style.left = (pad + i * dotR.w) + 'px';
          dot.style.top = '0';
          dot.style.width = dotR.w + 'px';
          dot.style.height = dotR.h + 'px';
          dot.style.backgroundColor = (dotDef.background || '#ffffff');
          /* the dot's own art, if the author supplied any */
          var up = dotDef.upload;
          if (up && up.data) {
            dot.style.backgroundImage = 'url(' + up.data + ')';
            dot.style.backgroundSize = '100% 100%';
            dot.style.backgroundColor = 'transparent';
          } else {
            dot.style.backgroundImage = '';
          }
        });
      }

      box.style.left = (r.x * zoomFactor) + 'px';
      box.style.top = (r.y * zoomFactor) + 'px';
      box.style.width = (w * zoomFactor) + 'px';
      box.style.height = (h * zoomFactor) + 'px';
      box.classList.toggle('is-selected', selectedId === def.id);
    });
  }

  /* ============================================================ sidebar rows */

  function buildRows() {
    dom.elementList.innerHTML = '';
    rows = {};
    /* the rows about to be replaced may be anchoring a tip */
    closeTip(true);

    displayOrder().forEach(function (def) {
      var locked = isLocked(def);
      /* Declared here, not beside modeSet/sizeSet further down: `var` hoists to
         the top of the function, so a declaration placed after the assignment
         would reset it to null and the arrow would never move. */
      var collapse = null;
      var li = document.createElement('li');
      li.className = 'el';
      li.dataset.id = def.id;

      /* ---- head */
      var head = document.createElement('div');
      head.className = 'el-head';

      /* A locked element has no controls at all — not disabled ones, none. Its
         row is its colour, its name and its resolved box, nothing else. */
      var enabled = null;
      if (!locked) {
        enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.className = 'el-enabled';
        enabled.title = 'Toggle this element off';
        enabled.checked = !!def.enabled;
        enabled.addEventListener('change', function () {
          def.enabled = enabled.checked;
          render(false);
        });
        head.appendChild(enabled);
      }

      var swatch = document.createElement('span');
      swatch.className = 'el-swatch';
      if (!def.background) swatch.classList.add('is-empty');
      swatch.style.backgroundColor = def.background || 'transparent';

      /* The swatch is the visible square; an invisible colour input sits on top
         of it so a plain click opens the OS picker, and a ⊘ appears only once
         there is a colour to clear. */
      var colorWrap = document.createElement('span');
      colorWrap.className = 'el-color';

      var colorPick = document.createElement('input');
      colorPick.type = 'color';
      colorPick.className = 'el-swatch-picker';
      colorPick.value = hexFor(def.background);
      colorPick.setAttribute('aria-label', 'Preview colour for ' + def.label);
      colorPick.addEventListener('input', function () {
        setColor(def, colorPick.value);
        commit('colour');
      });
      colorPick.addEventListener('change', function () { setColor(def, colorPick.value); });

      var colorClear = document.createElement('button');
      colorClear.type = 'button';
      colorClear.className = 'el-color-clear';
      colorClear.textContent = '⊘';
      colorClear.title = 'No colour — draw this element transparent';
      colorClear.addEventListener('click', function () { setColor(def, null); commit('colour'); });

      /* Every element whose asset is an image may take a file of its own,
         beside the button that clears the colour. */
      var assetAdd = null;
      var assetDel = null;
      var rule = assetRule(def);
      if (rule) {
        assetAdd = document.createElement('button');
        assetAdd.type = 'button';
        assetAdd.className = 'el-asset-add';
        assetAdd.textContent = '+';
        assetAdd.title = 'Use your own ' + rule.what + ' file for this element';
        assetAdd.addEventListener('click', function () { pickAsset(def); });

        /* Mirrors the ⊘ on the colour: it appears only once there is a file to
           take back off, so a + cannot become a one-way door. */
        assetDel = document.createElement('button');
        assetDel.type = 'button';
        assetDel.className = 'el-asset-del';
        assetDel.textContent = '✕';
        assetDel.title = 'Go back to the theme\u2019s own asset';
        assetDel.hidden = true;
        assetDel.addEventListener('click', function () { clearAsset(def); });
      }

      colorWrap.appendChild(swatch);
      colorWrap.appendChild(colorPick);
      colorWrap.appendChild(colorClear);
      if (assetAdd) colorWrap.appendChild(assetAdd);
      if (assetDel) colorWrap.appendChild(assetDel);
      head.appendChild(colorWrap);

      /* ---- name over its asset-type subtitle */
      var headText = document.createElement('span');
      headText.className = 'el-head-text';

      var nameRow = document.createElement('span');
      nameRow.className = 'el-name-row';

      /* The title is the element's variable name — the thing formulas quote,
         such as `corner-1080.w`. Renaming rewrites every reference to it. */
      var name = document.createElement('input');
      name.type = 'text';
      name.className = 'el-name-input';
      name.spellcheck = false;
      name.autocomplete = 'off';
      name.value = def.id;
      name.title = 'Variable name — other elements can refer to ' +
        def.id + '.w, .h, .x or .y';
      name.addEventListener('focus', function () { select(def.id); });
      name.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') name.blur();
        else if (e.key === 'Escape') { name.value = def.id; name.blur(); }
      });
      name.addEventListener('blur', function () { renameElement(def, name.value); });
      nameRow.appendChild(name);

      if (def.custom) {
        var tag = document.createElement('span');
        tag.className = 'new-el-tag';
        tag.textContent = 'new';
        nameRow.appendChild(tag);
      }
      headText.appendChild(nameRow);

      /* the subtitle reads as prose: the readable label, then the asset type */
      var kindRow = document.createElement('span');
      kindRow.className = 'el-kind-row';

      var subLabel = document.createElement('span');
      subLabel.className = 'el-sub-label';
      subLabel.textContent = def.label;
      kindRow.appendChild(subLabel);

      var sep = document.createElement('span');
      sep.className = 'el-sub-sep';
      sep.textContent = '|';
      kindRow.appendChild(sep);

      var kind = document.createElement('span');
      kind.className = 'el-kind';
      kind.textContent = kindLabel(def);
      kindRow.appendChild(kind);

      var help = document.createElement('button');
      help.type = 'button';
      help.className = 'el-help';
      help.textContent = '?';
      help.setAttribute('aria-label',
        'What is ' + article(kindLabel(def)) + ' ' + kindLabel(def) + '?');
      help.addEventListener('mouseenter', function () { openTip(help, assetTipContent(def)); });
      help.addEventListener('mouseleave', closeTip);
      help.addEventListener('focus', function () { openTip(help, assetTipContent(def)); });
      help.addEventListener('blur', closeTip);
      help.addEventListener('click', function (e) {
        /* stop this reaching the document listener that dismisses a pinned tip */
        e.stopPropagation();
        if (tip.pinned && tip.anchor === help) closeTip(true);
        else { openTip(help, assetTipContent(def)); tip.pinned = true; }
      });
      kindRow.appendChild(help);

      headText.appendChild(kindRow);

      head.appendChild(headText);

      /* ---- z-index. Stacking is not a measurement, so unlike x/y/w/h it is a
         plain integer with no per-tier base/override/formula machinery. Equal
         z values are legitimate — layout.html itself has nine elements at z1 —
         and ties are drawn in list order. A locked element has a fixed z and
         therefore no control for it. */
      var zInput = null;
      if (!locked) {
        var zWrap = document.createElement('label');
        zWrap.className = 'el-z';
        zWrap.title = 'Stacking order, 0 or higher. Equal z values are drawn in list order.';

        var zKey = document.createElement('span');
        zKey.className = 'el-z-key';
        zKey.textContent = 'z';
        zWrap.appendChild(zKey);

        zInput = document.createElement('input');
        zInput.type = 'text';
        zInput.inputMode = 'numeric';
        zInput.autocomplete = 'off';
        zInput.spellcheck = false;
        zInput.value = String(def.z);
        zInput.addEventListener('input', function () {
          var n = parseInt(zInput.value, 10);
          /* a half-typed or empty box leaves the value alone until blur */
          if (!isFinite(n)) return;
          def.z = Math.max(0, n);
          render(false);
        });
        zInput.addEventListener('blur', function () {
          zInput.value = String(def.z);
        });
        zInput.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') zInput.blur();
        });
        zWrap.appendChild(zInput);
        head.appendChild(zWrap);

        /* 4 — collapse the row to just the summary line above SHOWS IN SIZE.
           To the left of the cross, so the destructive control stays furthest
           from everything else. */
        collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'el-collapse';
        collapse.textContent = '▾';
        collapse.title = 'Collapse ' + def.label;
        collapse.setAttribute('aria-expanded', 'true');
        /* The row's own pointerdown selects it and re-renders, which races the
           click that follows and made folding feel like a coin toss. Keeping the
           arrow's pointerdown to itself makes it deterministic: folding a row is
           not selecting it. */
        collapse.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        collapse.addEventListener('click', function (e) {
          e.stopPropagation();
          setCollapsed(def.id, !collapsed[def.id]);
        });
        head.appendChild(collapse);

        /* ---- delete */
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'el-del';
        del.textContent = '✕';
        del.title = 'Delete ' + def.label;
        del.addEventListener('click', function () { deleteElement(def.id); });
        head.appendChild(del);
      }

      li.appendChild(head);

      /* ---- body. A locked element has none: no mode, no geometry, and no
         resolved readout, because its box is fixed and there is nothing to
         report or change. */
      var modeSet = null;
      var sizeSet = null;
      var textField = null;
      var fields = {};
      var summary = null;

      if (!locked) {
        var body = document.createElement('div');
        body.className = 'el-body';

        /* The screen sizes it appears in, on the same chips as the modes below. */
        sizeSet = buildChipRow('Shows in size', M.TIERS,
          function () {
            def.showInTiers = ALL_TIER_IDS.slice();
            commit('size');
            render(false);
          },
          function (id) {
            var on = showInTiersOf(def).slice();
            var at = on.indexOf(id);
            if (at === -1) on.push(id); else on.splice(at, 1);
            def.showInTiers = on;
            commit('size');
            render(false);
          });
        body.appendChild(sizeSet.row);

        /* The modes it appears in. Only modes it can actually be drawn in are
           offered — naming another would be a contradiction. */
        modeSet = buildChipRow('Shows in mode',
          M.MODES.filter(function (m) {
            return (def.modes || M.ALL_MODE_IDS).indexOf(m.id) > -1;
          }),
          function () {
            def.showIn = def.modes.slice();
            commit('mode');
            render(false);
          },
          function (id) {
            var on = showInOf(def).slice();
            var at = on.indexOf(id);
            if (at === -1) on.push(id); else on.splice(at, 1);
            def.showIn = on;
            commit('mode');
            render(false);
          });
        body.appendChild(modeSet.row);

        /* ---- what the element says. Text elements only, and a preview aid:
           the real string arrives from the system at boot, so this is not
           carried into the generated file. */
        if (def.kind === 'text') {
          var textRow = document.createElement('div');
          textRow.className = 'el-text-row';
          var textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.className = 'control el-text-input';
          textInput.value = def.text || '';
          textInput.placeholder = def.label;
          textInput.spellcheck = false;
          textInput.title = 'Preview text for the live view — how the theme reads ' +
            'with a different string, not part of what is generated';
          textInput.addEventListener('input', function () {
            def.text = textInput.value;
            render(false);
          });
          textInput.addEventListener('focus', function () { select(def.id); });
          textRow.appendChild(textInput);
          body.appendChild(textRow);
          textField = textInput;
        }

        /* ---- x / y / w / h */
        var grid = document.createElement('div');
        grid.className = 'el-grid';
        ['x', 'y', 'w', 'h'].forEach(function (prop) {
          var wrap = document.createElement('div');
          wrap.className = 'el-field';

          var key = document.createElement('span');
          key.className = 'el-field-key';
          key.textContent = prop;
          wrap.appendChild(key);

          var input = document.createElement('input');
          input.type = 'text';
          input.spellcheck = false;
          input.autocomplete = 'off';
          input.value = sourceText(def, prop);
          input.addEventListener('input', function () {
            if (overrideFor(def, prop) !== null) setOverride(def, prop, input.value);
            else def[prop] = input.value;
            commit('geometry');
            render(false);
          });
          input.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { input.blur(); }
          });
          wrap.appendChild(input);

          var tagBtn = document.createElement('button');
          tagBtn.type = 'button';
          tagBtn.className = 'el-field-tag';
          tagBtn.addEventListener('click', function () {
            if (overrideFor(def, prop) !== null) {
              /* pinned for this tier -> unpin, fall back to the base formula */
              setOverride(def, prop, null);
            } else {
              /* seed a per-tier override with the value it currently resolves to */
              setOverride(def, prop, fmt(resolved.elements[def.id][prop]));
            }
            commit('geometry');
            render(false);
          });
          wrap.appendChild(tagBtn);

          var resetBtn = document.createElement('button');
          resetBtn.type = 'button';
          resetBtn.className = 'el-field-tag is-reset';
          resetBtn.textContent = '↺';
          resetBtn.title = 'Restore the layout.html value';
          resetBtn.addEventListener('click', function () {
            var d = TEMPLATE_DEFAULTS[def.id];
            setOverride(def, prop, null);
            def[prop] = d ? d[prop] : def[prop];
            input.value = sourceText(def, prop);
            commit('geometry');
            render(false);
          });
          wrap.appendChild(resetBtn);

          grid.appendChild(wrap);
          fields[prop] = { wrap: wrap, input: input, tag: tagBtn, reset: resetBtn };
        });
        body.appendChild(grid);

        summary = document.createElement('div');
        summary.className = 'el-summary';
        body.appendChild(summary);

        li.appendChild(body);
      }

      li.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.el-head') || li === e.currentTarget) select(def.id);
      });

      dom.elementList.appendChild(li);
      rows[def.id] = {
        root: li, name: name, enabled: enabled, fields: fields,
        z: zInput, swatch: swatch, colorWrap: colorWrap, colorPick: colorPick,
        colorClear: colorClear, assetAdd: assetAdd, assetDel: assetDel,
        modeSet: modeSet, sizeSet: sizeSet, text: textField, summary: summary,
        collapse: collapse, body: body
      };
    });
  }

  /* 4 — fold a row down to the line above SHOWS IN SIZE. The body is hidden but
     the head stays, so the row is still selectable, renameable and deletable
     while shut. */
  function setCollapsed(id, shut) {
    if (shut) collapsed[id] = true; else delete collapsed[id];
    var row = rows[id];
    if (!row) return;
    if (row.body) row.body.hidden = !!shut;
    row.root.classList.toggle('is-collapsed', !!shut);
    if (row.collapse) {
      row.collapse.textContent = shut ? '▸' : '▾';
      row.collapse.setAttribute('aria-expanded', shut ? 'false' : 'true');
      row.collapse.title = (shut ? 'Expand ' : 'Collapse ') + byId(id).label;
    }
  }

  function syncRows() {
    state.elements.forEach(function (def) {
      var row = rows[def.id];
      if (!row) return;
      /* a structural rebuild makes fresh nodes, so the fold has to be reapplied */
      if (row.body) row.body.hidden = !!collapsed[def.id];
      row.root.classList.toggle('is-collapsed', !!collapsed[def.id]);
      if (row.collapse) {
        row.collapse.textContent = collapsed[def.id] ? '▸' : '▾';
        row.collapse.setAttribute('aria-expanded', collapsed[def.id] ? 'false' : 'true');
      }
      var r = resolved.elements[def.id];
      var modeVisible = isModeVisible(def);

      row.root.classList.toggle('is-selected', selectedId === def.id);
      row.root.classList.toggle('is-off', !def.enabled);
      row.root.classList.toggle('is-mode-hidden',
        def.enabled && !(modeVisible && isTierVisible(def) && isDemandVisible(def)));
      row.root.classList.toggle('is-filtered', state.onlyShown && !isShown(def));

      /* preview colour: backgroundColor, never the shorthand, or the CSS hatch
         behind a transparent swatch would be reset away — and the hatch itself
         is gated on `is-empty`, or it would draw over a chosen colour */
      row.swatch.style.backgroundColor = def.background || 'transparent';
      row.swatch.classList.toggle('is-empty', !def.background);
      if (document.activeElement !== row.colorPick) row.colorPick.value = hexFor(def.background);
      row.colorClear.hidden = !def.background;
      if (row.assetDel) row.assetDel.hidden = !def.upload;
      row.root.classList.toggle('is-asset', !!def.upload);
      /* on the wrapper, not the swatch: the invisible input sits on top of it and
         would otherwise swallow the tooltip */
      row.colorWrap.title = (def.background ? def.background : 'no colour') +
        ' — click the square to pick a colour';

      /* A locked element has no controls to sync — that is the whole point of
         deleting them rather than disabling them. */
      /* the variable name is renamable on every row, locked ones included —
         the lock is about geometry, mode, stacking and deletion */
      if (document.activeElement !== row.name) row.name.value = def.id;

      if (!isLocked(def)) {
        row.enabled.checked = !!def.enabled;
        if (row.text && document.activeElement !== row.text) row.text.value = def.text || '';

        paintChips(row.modeSet, showInOf(def), (def.modes || M.ALL_MODE_IDS).length);
        paintChips(row.sizeSet, showInTiersOf(def), ALL_TIER_IDS.length);
        if (document.activeElement !== row.z) row.z.value = String(def.z);

        ['x', 'y', 'w', 'h'].forEach(function (prop) {
          var f = row.fields[prop];
          var ov = overrideFor(def, prop);
          var text = ov === null ? String(def[prop]) : ov;

          if (document.activeElement !== f.input) f.input.value = text;

          f.wrap.classList.toggle('is-error', !isFinite(r[prop]));
          f.tag.classList.remove('is-fx', 'is-override', 'is-base');

          if (ov !== null) {
            f.tag.textContent = state.tier;
            f.tag.classList.add('is-override');
            f.tag.title = 'Pinned for ' + state.tier + ' only — click to unpin and use the shared formula';
          } else if (!M.isPlainNumber(text)) {
            f.tag.textContent = 'fx';
            f.tag.classList.add('is-fx');
            f.tag.title = 'Formula shared by every tier — click to pin ' + state.tier + ' to its current value';
          } else {
            f.tag.textContent = 'base';
            f.tag.classList.add('is-base');
            f.tag.title = '720p measurement, scaled for every tier — click to pin ' + state.tier + ' instead';
          }

          var d = TEMPLATE_DEFAULTS[def.id];
          f.reset.hidden = !d || (ov === null && text === d[prop]);
        });
      }

      /* resolved pixels, straight from the resolver. A locked element has no
         readout — its box is fixed and already stated by the element itself. */
      if (row.summary) {
        var bits = [];
        if (r.error) {
          bits.push('<span class="err">' + r.error + '</span>');
        } else {
          bits.push('<span class="px">' + fmt(r.x) + ', ' + fmt(r.y) + '</span>');
          bits.push('<span class="px">' + fmt(r.w) + ' × ' + fmt(r.h) + '</span>');
          bits.push('<span>' + tier().label + '</span>');
        }
        row.summary.innerHTML = bits.join('<span style="color:#3a414c">·</span>');
      }
    });

    dom.elementCount.textContent = '(' + state.elements.filter(isShown).length + '/' + state.elements.length + ')';
  }

  /* ================================================================ asset tip */

  /* One shared tip element serves the whole list. It is anchored against the ?
     that opened it, preferring the roomier canvas side and flipping if the
     viewport is narrow. Built from nodes rather than innerHTML because a custom
     element's label is user text. */
  var tip = { anchor: null, pinned: false };

  /* `content` is { title, body, footer? }; the footer is optional and set in the
     mono style used for a file name or a list. */
  function openTip(anchor, content) {
    var box = dom.assetTip;
    box.innerHTML = '';

    var head = document.createElement('strong');
    head.textContent = content.title;
    box.appendChild(head);

    var body = document.createElement('p');
    body.textContent = content.body;
    box.appendChild(body);

    if (content.footer) {
      var foot = document.createElement('code');
      foot.textContent = content.footer;
      box.appendChild(foot);
    }

    box.hidden = false;
    tip.anchor = anchor;
    placeTip(anchor);
  }

  /* The group picker: one checkbox per group, each with the note explaining what
     it is. Rebuilt when the list changes, re-ticked on every render. */
  function buildDemandMenu() {
    dom.demandMenu.innerHTML = '';
    M.DEMAND_GROUPS.forEach(function (g) {
      var row = document.createElement('label');
      row.className = 'menu-check';
      row.dataset.group = g.id;

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.group = g.id;
      box.addEventListener('change', function () { toggleDemandGroup(g.id, box.checked); });
      row.appendChild(box);

      var text = document.createElement('span');
      var name = document.createElement('span');
      name.textContent = g.label;
      text.appendChild(name);
      var note = document.createElement('span');
      note.className = 'menu-check-help';
      note.textContent = g.help;
      text.appendChild(note);
      row.appendChild(text);

      dom.demandMenu.appendChild(row);
    });
  }

  function toggleDemandGroup(id, on) {
    /* With Show all on, every group is in effect even though none is ticked, so
       unticking one has to hand back the rest rather than clear the lot. */
    var picked = state.showOnDemandAll
      ? M.DEMAND_GROUPS.map(function (g) { return g.id; })
      : (state.demandPick || []).slice();
    var at = picked.indexOf(id);
    if (on && at === -1) picked.push(id);
    if (!on && at > -1) picked.splice(at, 1);

    /* Picking the last group is the same as asking for everything, so it folds
       into Show all rather than sitting as four ticks that mean the same. */
    if (picked.length === M.DEMAND_GROUPS.length) {
      state.showOnDemandAll = true;
      state.demandPick = [];
    } else {
      state.showOnDemandAll = false;
      state.demandPick = picked;
    }
    render(false);
  }

  function syncDemandMenu() {
    var all = !!state.showOnDemandAll;
    Array.prototype.forEach.call(dom.demandMenu.children, function (row) {
      var box = row.querySelector('input');
      /* with Show all on, every group is in effect even though none is ticked */
      box.checked = all || (state.demandPick || []).indexOf(row.dataset.group) > -1;
    });
    dom.demandBtn.textContent = all
      ? 'Groups (all) ▾'
      : 'Groups (' + (state.demandPick || []).length + ') ▾';
  }

  /* What the On demand ? says: which elements it covers, and why one of them is
     left out. */
  function demandTipContent() {
    var showing = state.elements.filter(isDemandVisible).filter(function (d) {
      return d.onDemand;
    }).map(function (d) { return d.label; });
    var hidden = state.elements.filter(function (d) {
      return d.onDemand && !isDemandVisible(d);
    }).map(function (d) { return d.label; });

    return {
      title: 'On demand elements',
      body: 'Some elements are not decided by the mode. Plymouth calls them when ' +
        'they are wanted — the password and question dialogs, the status line a ' +
        'client sets, the console you toggle with Esc. These are shown together ' +
        'because that is how they are designed, and only while you work on them: ' +
        'at boot nothing draws until Plymouth asks. ' +
        (state.showOnDemandAll
          ? 'Show all is on, so every one of them is drawn — including the console, ' +
            'which covers the whole screen and hides what is behind it.'
          : showing.length
            ? 'Showing ' + showing.length + ' of ' + (showing.length + hidden.length) + '.'
            : 'Nothing on demand is drawn, so the canvas is the theme as it looks at boot.') +
        (hidden.length && !state.showOnDemandAll
          ? ' ' + hidden.join(', ') + ' is not shown.'
          : ''),
      footer: (state.showOnDemandAll || !showing.length ? 'none picked' : showing.join(', '))
    };
  }

  /* What a row's ? says. Built at open time so a rename is reflected. */
  function assetTipContent(def) {
    return {
      title: def.label + ' — ' + kindLabel(def),
      body: def.help || 'No description yet for this element.',
      footer: def.asset ? 'File: ' + def.asset : ''
    };
  }

  /* What the top bar's mode ? says: what the mode is, and which elements belong
     to it *in general*. That comes from the template rather than from the theme
     as currently edited, so it stays a stable description of the mode instead of
     a readout of the dropdowns. */
  function modeTipContent() {
    if (state.previewMode === 'all') {
      return {
        title: 'Preview mode: All modes',
        body: 'All modes is a preview setting rather than a Plymouth mode: the ' +
          'canvas shows every element in the theme, whichever mode it belongs ' +
          'to. Each element\'s row names the mode it is for. Choose a specific ' +
          'mode to see what that screen contains.',
        footer: ''
      };
    }

    var mode = null;
    M.MODES.forEach(function (m) { if (m.id === state.previewMode) mode = m; });

    /* Labels, not variable names: the reader wants "Corner Image", and a label
       is fixed by the template while a name can be renamed at any time. */
    var belongs = M.ELEMENTS.filter(function (e) {
      return e.modes.indexOf(state.previewMode) > -1;
    }).map(function (e) { return e.label; });

    return {
      title: 'Preview mode: ' + (mode ? mode.label : state.previewMode),
      body: (mode ? mode.help + ' ' : '') + belongs.length + ' of the ' +
        M.ELEMENTS.length + ' template elements can appear in this mode; the ' +
        'rest never do.',
      footer: belongs.join(', ')
    };
  }

  function placeTip(anchor) {
    var box = dom.assetTip;
    var r = anchor.getBoundingClientRect();
    /* fall back to sane numbers so an unmeasured box can never yield NaNpx */
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var w = box.offsetWidth || 290;
    var h = box.offsetHeight || 0;
    var gap = 10;

    /* the sidebar hugs the right edge, so the tip normally goes to its left.
       `right` is derived rather than read, so this works anywhere. */
    var right = r.left + (r.width || 0);
    var left = r.left - w - gap;
    if (left < 8) left = right + gap;
    left = Math.max(8, left);
    if (vw) left = Math.min(left, vw - w - 8);

    var top = Math.max(8, r.top - 6);
    if (vh) top = Math.min(top, vh - h - 8);

    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(top) + 'px';
  }

  /* A hover-away closes the tip; `force` also overrides a click that pinned it.
     `force` is compared strictly because this is tempting to pass straight to
     addEventListener, which would hand it the event object — truthy, and the
     pinned tip would vanish on mouse-out. */
  function closeTip(force) {
    if (tip.pinned && force !== true) return;
    dom.assetTip.hidden = true;
    tip.anchor = null;
    if (force === true) tip.pinned = false;
  }

  /* ================================================================ paddings */

  function buildPaddingList() {
    dom.paddingList.innerHTML = '';
    state.paddings.forEach(function (pad) {
      var item = document.createElement('div');
      item.className = 'padding-item';

      /* the name is the variable, so it reads as code and is renamable */
      var name = document.createElement('input');
      name.type = 'text';
      name.className = 'padding-name';
      name.spellcheck = false;
      name.autocomplete = 'off';
      name.value = pad.id;
      name.dataset.padName = pad.id;
      name.title = (pad.note ? pad.note + '\n\n' : '') +
        'Rename this padding — formulas use it bare, as ' + pad.id + '.';
      name.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') name.blur();
        else if (e.key === 'Escape') { name.value = pad.id; name.blur(); }
      });
      name.addEventListener('blur', function () { renamePadding(pad, name.value); });
      item.appendChild(name);

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'control';
      input.spellcheck = false;
      input.value = pad.expr;
      input.dataset.padId = pad.id;
      input.title = 'The expression this padding stands for';
      input.addEventListener('input', function () {
        pad.expr = input.value;
        commit('padding');
        render(false);
      });
      item.appendChild(input);

      var value = document.createElement('span');
      value.className = 'padding-value';
      value.dataset.padValue = pad.id;
      item.appendChild(value);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'padding-del';
      del.textContent = '✕';
      del.title = 'Delete ' + pad.id;
      del.addEventListener('click', function () { deletePadding(pad); });
      item.appendChild(del);

      dom.paddingList.appendChild(item);
    });
  }

  function syncPaddings() {
    state.paddings.forEach(function (pad) {
      var r = resolved.paddings[pad.id];
      var el = dom.paddingList.querySelector('[data-pad-value="' + pad.id + '"]');
      if (!el) return;
      el.textContent = r.error ? 'error' : (fmt(r.value) + ' px');
      el.classList.toggle('is-error', !!r.error);
      el.title = r.error || '';
      var input = dom.paddingList.querySelector('[data-pad-id="' + pad.id + '"]');
      if (input && document.activeElement !== input) input.value = pad.expr;
      var name = dom.paddingList.querySelector('[data-pad-name="' + pad.id + '"]');
      if (name && document.activeElement !== name) name.value = pad.id;
    });
  }

  function addPadding() {
    var n = 1;
    while (state.paddings.some(function (p) { return p.id === 'pad-' + n; })) n += 1;
    var id = 'pad-' + n;
    state.paddings.push({ id: id, expr: '0', note: '' });
    render(true);
    commit('padding');
    var field = dom.paddingList.querySelector('[data-pad-name="' + id + '"]');
    if (field) field.focus();
    flashStatus('Added ' + id + ' — rename it and give it an expression.');
  }

  function deletePadding(pad) {
    state.paddings = state.paddings.filter(function (p) { return p !== pad; });
    render(true);
    commit('padding');
    flashStatus('Deleted padding ' + pad.id + '. Any formula still naming it now reports an error.');
  }

  /* A padding rename is a plain rename. Formulas that still quote the old name
     are left exactly as written and report an unknown name, which is visible in
     the element list and the padding readout, and undone by renaming back. */
  function renamePadding(pad, raw) {
    var next = cleanName(raw);
    var problem = nameProblem(next, pad.id);
    if (problem) {
      flashStatus('Cannot use "' + next + '" — ' + problem + '.');
      render(true);
      return;
    }
    if (next === pad.id) { render(true); return; }

    var oldId = pad.id;
    pad.id = next;
    commit('padding');
    flashStatus('Renamed ' + oldId + ' to ' + next +
      '. Anything still naming ' + oldId + ' will report an error.');
    render(true);
  }

  function flashStatus(message) {
    var previous = dom.statusSel.textContent;
    dom.statusSel.textContent = message;
    window.setTimeout(function () {
      if (dom.statusSel.textContent === message) dom.statusSel.textContent = previous;
    }, 2600);
  }

  /* ================================================================ selection */

  /* Delete an element from the theme. Any element can go, including a template
     one — Reset puts the full layout.html set back, and that is the undo. */
  function deleteElement(id) {
    if (isLocked(byId(id))) return;                      // mandatory element
    var next = state.elements.filter(function (e) { return e.id !== id; });
    if (next.length === state.elements.length) return;   // no such element
    state.elements = next;
    if (selectedId === id) selectedId = null;
    render(true);
    commit('element');
  }

  function select(id, reveal) {
    selectedId = id;
    render(false);
    if (reveal) {
      /* `start` rather than `nearest`: picking something on the canvas brings
         its row to the top of the list, where it can be worked on. The list is
         its own scroll container, so this scrolls the list, not the page. */
      var row = rows[id] && rows[id].root;
      if (row && typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }
    var r = resolved.elements[id];
    if (r) {
      dom.statusSel.textContent = byId(id).label + ' — x ' + fmt(r.x) + ', y ' + fmt(r.y) +
        ', ' + fmt(r.w) + ' × ' + fmt(r.h) + ' px at ' + tier().label;
    }
  }

  /* ============================================================== drag/move */

  function onBoxPointerDown(e) {
    if (e.button !== 0) return;
    var id = e.currentTarget.dataset.id;
    var def = byId(id);
    var r = resolved.elements[id];
    if (!def || !r || r.error) return;

    /* alt-click digs down through whatever is stacked on top */
    if (e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      select(cycleAt(e.clientX, e.clientY, id), true);
      return;
    }

    var isHandle = !!(e.target.dataset && e.target.dataset.handle);
    var props = isHandle ? ['w', 'h'] : ['x', 'y'];

    select(id, true);
    /* selectable, so its colour and settings stay reachable — but not draggable */
    if (isLocked(def)) return;
    drag = {
      mode: isHandle ? 'resize' : 'move',
      id: id,
      props: props,
      startClientX: e.clientX,
      startClientY: e.clientY,
      start: { x: r.x, y: r.y, w: r.w, h: r.h },
      moved: false
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.addEventListener('pointermove', onBoxPointerMove);
    e.currentTarget.addEventListener('pointerup', onBoxPointerUp);
    e.currentTarget.addEventListener('pointercancel', onBoxPointerUp);
    e.preventDefault();
  }

  function onBoxPointerMove(e) {
    if (!drag) return;
    var dx = (e.clientX - drag.startClientX) / zoomFactor;
    var dy = (e.clientY - drag.startClientY) / zoomFactor;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) drag.moved = true;

    var def = byId(drag.id);
    var scale = tier().scale;

    if (drag.mode === 'move') {
      writeFromDrag(def, 'x', drag.start.x + dx, scale);
      writeFromDrag(def, 'y', drag.start.y + dy, scale);
    } else {
      writeFromDrag(def, 'w', Math.max(1, drag.start.w + dx), scale);
      writeFromDrag(def, 'h', Math.max(1, drag.start.h + dy), scale);
    }
    render(false);
  }

  /* Writes a pixel position back into whichever source supplies that field:
     an override is already absolute pixels, a base value is 720p units. */
  function writeFromDrag(def, prop, px, scale) {
    if (!isFinite(px)) return;
    if (overrideFor(def, prop) !== null) setOverride(def, prop, fmt(px));
    else def[prop] = fmt(px / scale);
  }

  function onBoxPointerUp(e) {
    var box = e.currentTarget;
    box.removeEventListener('pointermove', onBoxPointerMove);
    box.removeEventListener('pointerup', onBoxPointerUp);
    box.removeEventListener('pointercancel', onBoxPointerUp);
    if (box.hasPointerCapture && box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId);
    /* A drag is one step. Committed here rather than during the move, or every
       pointer event on the way would be its own entry. A click that never moved
       is a selection, not an edit, so it records nothing. */
    var moved = !!(drag && drag.moved);
    drag = null;
    if (moved) commit('geometry');
  }

  /* Every overlay box under a screen point, topmost last. */
  function hitsAt(clientX, clientY) {
    var rect = dom.overlay.getBoundingClientRect();
    var x = clientX - rect.left;
    var y = clientY - rect.top;
    var hits = [];
    state.elements.forEach(function (def) {
      var box = boxes[def.id];
      if (!box || box.style.display === 'none') return;
      var left = parseFloat(box.style.left);
      var top = parseFloat(box.style.top);
      var w = parseFloat(box.style.width);
      var h = parseFloat(box.style.height);
      if (x >= left && x <= left + w && y >= top && y <= top + h) hits.push(def.id);
    });
    return hits;
  }

  function cycleAt(clientX, clientY, currentId) {
    var hits = hitsAt(clientX, clientY);
    if (!hits.length) return currentId;
    var i = hits.lastIndexOf(currentId);
    return hits[(i + 1) % hits.length];
  }

  /* ================================================================ statusbar */

  function syncStatus() {
    var t = tier();
    var shown = state.elements.filter(isShown).length;
    dom.statusTier.innerHTML = '<b>' + t.label + '</b> ' + t.width + ' × ' + t.height + ' · ×' + t.scale;
    dom.statusPixels.textContent = aspectLabel(t.width, t.height) + (state.viewport ? ' live' : '');
    dom.shapeReset.hidden = !state.viewport;
    dom.statusCounts.textContent = shown + ' of ' + state.elements.length + ' elements shown';
    if (!selectedId) dom.statusSel.textContent = 'Click an element on the canvas or in the list to select it.';
  }

  /* ================================================================ top bar */

  function buildTopbar() {
    dom.tierSelect.innerHTML = '';
    M.TIERS.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label + '  ·  ' + t.width + '×' + t.height;
      dom.tierSelect.appendChild(opt);
    });
    dom.tierSelect.value = state.tier;
    dom.tierSelect.addEventListener('change', function () {
      state.tier = dom.tierSelect.value;
      /* Picking a screen size is a request for that screen's own shape, so it
         drops any live-view reshape. Element geometry is untouched: this is the
         frame, not the layout inside it. */
      state.viewport = null;
      render(false);
    });

    dom.modeSelect.innerHTML = '';
    var allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'All modes';
    dom.modeSelect.appendChild(allOpt);
    M.MODES.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      dom.modeSelect.appendChild(opt);
    });
    dom.modeSelect.value = state.previewMode;
    dom.modeSelect.addEventListener('change', function () {
      state.previewMode = dom.modeSelect.value;
      render(false);
      /* the explainer names the mode and lists its elements, so refresh it */
      if (!dom.assetTip.hidden && tip.anchor === dom.modeHelp) {
        openTip(dom.modeHelp, modeTipContent());
      }
    });

    dom.zoomSelect.value = state.zoom;
    dom.zoomSelect.addEventListener('change', function () {
      state.zoom = dom.zoomSelect.value === 'fit' ? 'fit' : parseFloat(dom.zoomSelect.value);
      render(false);
    });
  }

  function syncTopbar() {
    if (document.activeElement !== dom.tierSelect) dom.tierSelect.value = state.tier;
    dom.modeSelect.value = state.previewMode;
    if (document.activeElement !== dom.onDemandToggle) {
      dom.onDemandToggle.checked = !!state.showOnDemandAll;
      syncDemandMenu();
    }
    /* never overwrite a field the user is typing in */
    if (document.activeElement !== dom.themeName) dom.themeName.value = state.theme.name;
    if (document.activeElement !== dom.themeDesc) dom.themeDesc.value = state.theme.description;
    if (document.activeElement !== dom.themeRefresh) dom.themeRefresh.value = state.theme.refresh_rate;
  }

  /* ============================================================= add element */

  /* Add is a plain picker over the theme's catalogue: every element a Plymouth
     theme can have, added at the top of the list with the template's own values. */
  function buildAddOptions() {
    dom.addSelect.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '+ Add element…';
    dom.addSelect.appendChild(placeholder);

    /* Most likely to be changed first. The backdrop is left out: it is locked,
       so a copy of it could never be moved, hidden or removed. */
    rankedElements().forEach(function (src) {
      if (src.locked) return;
      var opt = document.createElement('option');
      opt.value = src.id;
      opt.textContent = src.label;
      dom.addSelect.appendChild(opt);
    });
    dom.addSelect.value = '';
  }

  function uniqueId(base) {
    /* a renamed-away name is free again, so take it rather than suffixing */
    if (!byId(base)) return base;
    var n = 2;
    while (byId(base + '-' + n)) n += 1;
    return base + '-' + n;
  }

  function uniqueLabel(base) {
    var n = 2;
    while (state.elements.some(function (e) { return e.label === base + ' ' + n; })) n += 1;
    return base + ' ' + n;
  }

  /* A pristine copy of the template entry: no per-tier pins, the template's own
     debug colour, and no `locked` flag — a second background is not the
     mandatory one and stays as editable as anything else. */
  function templateClone(srcId) {
    var src = null;
    M.ELEMENTS.forEach(function (e) { if (e.id === srcId) src = e; });
    if (!src) return null;
    var def = M.clone(src);
    def.overrides = {};
    def.upload = null;          /* a copy starts on the theme's own asset */
    def.origin = src.id;
    def.showInTiers = ALL_TIER_IDS.slice();
    def.background = M.PREVIEW_COLORS[src.id] === undefined ? null : M.PREVIEW_COLORS[src.id];
    delete def.locked;
    return def;
  }

  function addFromTemplate(srcId) {
    var def = templateClone(srcId);
    if (!def) return;

    var newId = uniqueId(srcId);
    rebindSelfReferences(def, srcId, newId);
    def.id = newId;
    def.label = uniqueLabel(def.label);
    def.custom = true;
    def.uid = (uid += 1);

    /* the top of the list is the front of the array, which is also where the
       canvas starts painting — so a copy of a same-z element sits behind it */
    state.elements.unshift(def);

    render(true);
    select(newId, true);
    commit('element');
  }

  /* The template places an element with expressions naming itself, e.g. main's x
     is `50vw - (main.w / 2)`. On a copy those have to point at the copy, or
     resizing it would move it by the original's width. Ids are matched with
     their trailing dot, so `main.` can never hit `main-2.` or `progress.` inside
     `progress-percent.`. */
  function rebindSelfReferences(def, oldId, newId) {
    var from = oldId + '.';
    var to = newId + '.';
    var swap = function (text) {
      return typeof text === 'string' && text.indexOf(from) > -1
        ? text.split(from).join(to) : text;
    };
    ['x', 'y', 'w', 'h'].forEach(function (prop) { def[prop] = swap(def[prop]); });
  }

  /* ================================================================ renaming */

  /* Names that already mean something inside a formula. */
  var RESERVED_NAMES = ['vw', 'vh', 'vmin', 'vmax', 'w', 'h', 'scale'];

  /* A name has to survive being written inside a formula: the tokenizer matches
     whole names, so it must start with a letter and carry no dot (which splits
     element from property) and no operator characters. */
  function cleanName(raw) {
    return String(raw === undefined || raw === null ? '' : raw)
      .trim().toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /* Returns a reason the name cannot be used, or null when it is fine. */
  function nameProblem(name, selfId) {
    if (!name) return 'a name is required';
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return 'use letters, digits and dashes, starting with a letter';
    }
    if (name === selfId) return null;
    if (RESERVED_NAMES.indexOf(name) > -1) return 'that is a reserved word';
    if (state.paddings.some(function (p) { return p.id === name; })) {
      return 'that is already a padding';
    }
    if (byId(name)) return 'another element already has that name';
    return null;
  }

  /* Replace one element name inside a formula. Elements are always quoted with
     a dot (`main.w`), and the leading boundary keeps `main` from matching inside
     a longer name such as `main-2`. */
  function swapName(text, oldName, newName) {
    if (typeof text !== 'string' || text.indexOf(oldName) < 0) return text;
    var escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('(^|[^A-Za-z0-9_.-])' + escaped + '\\.', 'g');
    return text.replace(re, function (match, before) { return before + newName + '.'; });
  }

  /* An element rename has to carry the formulas that quote it, or resizing it
     would move whatever still pointed at the old name: every element's own
     x/y/w/h and derived container, and the shared padding formulas. Padding
     names are deliberately NOT chased this way — renaming one is a plain rename,
     and anything still quoting the old name reports an error. */
  function renameReferences(oldName, newName) {
    var swap = function (text) { return swapName(text, oldName, newName); };

    state.elements.forEach(function (def) {
      ['x', 'y', 'w', 'h'].forEach(function (prop) {
        if (typeof def[prop] === 'string') def[prop] = swap(def[prop]);
      });
    });

    state.paddings.forEach(function (pad) { pad.expr = swap(pad.expr); });
  }

  function renameElement(def, raw) {
    var next = cleanName(raw);
    var problem = nameProblem(next, def.id);
    if (problem) {
      flashStatus('Cannot use "' + next + '" — ' + problem + '.');
      render(true);                     /* puts the current name back in the box */
      return;
    }
    if (next === def.id) { render(true); return; }

    var oldId = def.id;
    renameReferences(oldId, next);
    def.id = next;
    /* the per-field revert looks its template value up by id, so carry it over */
    if (TEMPLATE_DEFAULTS[oldId]) {
      TEMPLATE_DEFAULTS[next] = TEMPLATE_DEFAULTS[oldId];
      delete TEMPLATE_DEFAULTS[oldId];
    }
    if (selectedId === oldId) selectedId = next;

    flashStatus('Renamed ' + oldId + ' to ' + next + ', and updated every reference.');
    /* structural: the row, art and overlay maps are all keyed by name */
    render(true);
  }

  /* ================================================================= export */

  function buildExport() {
    /* resolve each tier once, not once per element */
    var perTierCache = {};
    M.TIERS.forEach(function (t) { perTierCache[t.id] = M.resolveAll(state, t); });

    var out = {
      format: state.format,
      version: state.version,
      generator: 'plymouth-theme-generator (milestone 1 — layout and values)',
      exported: new Date().toISOString(),
      theme: state.theme,
      previewTier: state.tier,
      previewMode: state.previewMode,
      /* the live-view box, when it has been dragged off 16:9. A preview aid
         only: `resolved` below is still computed for the four real tiers. */
      previewViewport: state.viewport,
      coordinateSpace: 'x/y are the element top-left in pixels for the named tier; w/h are its size in pixels',
      paddings: state.paddings.map(function (pad) {
        var r = resolved.paddings[pad.id];
        return { id: pad.id, expr: pad.expr, value: r.error ? null : r.value, error: r.error };
      }),
      elements: state.elements.map(function (def) {
        var perTier = {};
        M.TIERS.forEach(function (t) {
          var e = perTierCache[t.id].elements[def.id];
          perTier[t.id] = {
            x: e.x, y: e.y, w: e.w, h: e.h,
            container: e.container || null,
            error: e.error
          };
        });
        return {
          id: def.id,
          label: def.label,
          kind: def.kind,
          z: def.z,
          enabled: !!def.enabled,
          showIn: showInOf(def).slice(),
          showInTiers: showInTiersOf(def).slice(),
          modes: (def.modes || M.ALL_MODE_IDS).slice(),
          /* The element's own file, if it has one, with its natural size so the
             generator can see whether it needs resizing to `resolved`'s box. */
          upload: def.upload ? {
            name: def.upload.name,
            type: def.upload.type,
            size: def.upload.size,
            width: def.upload.width,
            height: def.upload.height,
            data: def.upload.data
          } : null,
          /* the editor refuses to move, resize, hide, restack, mode-restrict or
             delete a locked element, so the generator can rely on those */
          locked: !!def.locked,
          asset: def.asset || null,
          font: def.font || null,
          /* kept because it is the theme's own background colour for
             firmware-background/background, and the fallback fill for assets */
          background: def.background || null,
          placement: { x: def.x, y: def.y, w: def.w, h: def.h },
          overrides: def.overrides || {},
          resolved: perTier
        };
      }),
      paddingsByTier: M.TIERS.reduce(function (acc, t) {
        var pads = perTierCache[t.id].paddings;
        acc[t.id] = Object.keys(pads).reduce(function (a, id) {
          a[id] = pads[id].error ? null : pads[id].value;
          return a;
        }, {});
        return acc;
      }, {})
    };
    return out;
  }

  function slug(text) {
    var s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || 'theme';
  }

  function downloadFile(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* Saving goes through the browser's own save flow. Chromium's File System
     Access picker is a real "Save As" panel, so it is used where it exists;
     where it does not (Safari, Firefox), or where the page is not allowed to
     use it, this falls back to the plain download Export JSON uses. A cancel
     is not an error and saves nothing. */
  function saveFile(filename, text, mime) {
    if (typeof window.showSaveFilePicker === 'function') {
      return window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Plymouth theme editor save', accept: { 'application/json': ['.plymeta'] } }]
      }).then(function (handle) {
        return handle.createWritable();
      }).then(function (writable) {
        return writable.write(text).then(function () { return writable.close(); });
      }).then(function () {
        return true;
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return false;
        downloadFile(filename, text, mime);
        return true;
      });
    }
    downloadFile(filename, text, mime);
    return Promise.resolve(true);
  }

  /* ============================================================= milestone 2 */

  /* Build the whole theme and hand it over. Every pixel step happens in the
     browser: placeholders are drawn, supplied files are decoded and converted
     to PNG, animated GIFs and SVGs become frame sequences, and the result is
     either written straight into a folder you pick or downloaded as a zip. */
  function generateTheme() {
    if (!window.PlymGenerate) {
      flashStatus('The generator did not load — check the console.');
      return;
    }
    var btn = dom.generateBtn;
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    flashStatus('Generating the theme…');

    window.PlymGenerate.run(state, {
      onProgress: function (stage, done, total) {
        if (stage === 'writing') btn.textContent = 'Writing…';
      }
    }).then(function (result) {
      var bits = [];
      if (result.method === 'cancelled') {
        flashStatus('Generate cancelled.');
        return;
      }
      bits.push(result.count + ' files');
      bits.push(result.method === 'directory'
        ? 'written to the ' + result.artefact + ' folder'
        : 'downloaded as ' + result.artefact);
      if (result.warnings.length) bits.push(result.warnings.length + ' warning(s)');
      if (result.errors.length) bits.push(result.errors.length + ' error(s)');
      flashStatus('Theme generated — ' + bits.join(', ') + '.');
      if (result.warnings.length || result.errors.length) {
        /* Warnings are the interesting half: a CSS-animated SVG, a file that
           would not decode, two elements claiming one filename. */
        window.console.warn('Plymouth theme generator:');
        result.errors.forEach(function (e) { window.console.warn('  error: ' + e); });
        result.warnings.forEach(function (w) { window.console.warn('  ' + w); });
      }
    }).catch(function (err) {
      flashStatus('Generate failed: ' + (err && err.message ? err.message : err));
      window.console.error(err);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = label;
    });
  }

  function exportJson() {
    downloadFile('plymouth-theme-' + slug(state.theme.name) + '.json',
      JSON.stringify(buildExport(), null, 2), 'application/json');
    flashStatus('Exported ' + state.elements.length + ' elements with all four tiers resolved.');
  }

  /* ============================================================ save / load */

  /* The editor's own state, which is not the same thing as the generator
     export: this is everything needed to carry on editing, so it round-trips. */
  function buildSave() {
    return {
      format: state.format,
      kind: 'editor-state',
      version: state.version,
      saved: new Date().toISOString(),
      state: state
    };
  }

  function saveState() {
    var name = slug(state.theme.name) + '.plymeta';
    var text = JSON.stringify(buildSave(), null, 2);
    saveFile(name, text, 'application/json').then(function (written) {
      flashStatus(written
        ? 'Saved ' + name + ' — ' + state.elements.length + ' elements, ' +
          state.paddings.length + ' paddings.'
        : 'Save cancelled.');
    });
  }

  /* Anything can be in a file, so a load is validated and filled out rather than
     trusted; a bad file leaves the session exactly as it was. Returns a complete
     state, or null when the file is not one of ours. */
  function normaliseState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var src = raw.state && typeof raw.state === 'object' ? raw.state : raw;

    if (!Array.isArray(src.elements) || !src.elements.length) return null;
    if (!Array.isArray(src.paddings) || !src.theme || typeof src.theme !== 'object') return null;
    for (var i = 0; i < src.elements.length; i += 1) {
      var e = src.elements[i];
      if (!e || typeof e.id !== 'string' || !e.id) return null;
    }

    var out = M.defaultState();
    out.theme = {
      name: String(src.theme.name || 'template'),
      description: String(src.theme.description || ''),
      refresh_rate: parseInt(src.theme.refresh_rate, 10) || 30
    };
    out.paddings = src.paddings.map(function (p) {
      return {
        id: String(p && p.id ? p.id : 'pad'),
        expr: String(p && p.expr !== undefined && p.expr !== null ? p.expr : '0'),
        note: String((p && p.note) || '')
      };
    });
    out.elements = src.elements.map(function (e) {
      var def = M.clone(e);
      def.label = String(e.label || e.id);
      def.kind = String(e.kind || 'image');
      def.help = typeof e.help === 'string' ? e.help : '';
      def.enabled = e.enabled !== false;
      def.z = isFinite(parseInt(e.z, 10)) ? parseInt(e.z, 10) : 1;
      def.overrides = e.overrides && typeof e.overrides === 'object' ? e.overrides : {};
      ['x', 'y', 'w', 'h'].forEach(function (prop) {
        if (def[prop] === undefined || def[prop] === null) def[prop] = '0';
      });

      /* Supported modes arrived after the first saves, so fall back to the
         template's set, found by label — the one thing renaming does not touch.
         An element with no template match simply supports everything. */
      var known = e.modes && e.modes.filter
        ? e.modes.filter(function (m) { return M.ALL_MODE_IDS.indexOf(m) > -1; })
        : null;
      var tpl = null;
      M.ELEMENTS.forEach(function (t) { if (t.label === def.label) tpl = t; });
      def.origin = typeof e.origin === 'string' && e.origin ? e.origin : (tpl ? tpl.id : null);
      def.modes = known && known.length ? known : (tpl ? tpl.modes.slice() : M.ALL_MODE_IDS.slice());

      var up = e.upload;
      def.upload = up && typeof up === 'object' && typeof up.data === 'string' && up.data
        ? {
            name: String(up.name || 'asset'),
            type: String(up.type || ''),
            size: parseInt(up.size, 10) || 0,
            width: isFinite(parseInt(up.width, 10)) ? parseInt(up.width, 10) : null,
            height: isFinite(parseInt(up.height, 10)) ? parseInt(up.height, 10) : null,
            data: up.data
          }
        : null;

      /* Which screen sizes are ticked. Arrived with the second round of saves,
         so an older file simply shows in all four. */
      var sizes = Array.isArray(e.showInTiers)
        ? e.showInTiers.filter(function (t) { return ALL_TIER_IDS.indexOf(t) > -1; })
        : null;
      def.showInTiers = sizes && sizes.length ? sizes : ALL_TIER_IDS.slice();

      /* Which modes are ticked. Older saves held one mode, or the word 'all'
         for every supported one; a mode outside the supported set is dropped,
         since the row could not offer it and it could never be drawn there. */
      var wanted = Array.isArray(e.showIn) ? e.showIn : (e.mode && e.mode !== 'all'
        ? [e.mode] : null);
      if (!wanted) {
        def.showIn = def.modes.slice();
      } else {
        def.showIn = wanted.filter(function (m) { return def.modes.indexOf(m) > -1; });
        if (!def.showIn.length) def.showIn = def.modes.slice();
      }
      return def;
    });

    if (M.TIERS.some(function (t) { return t.id === src.tier; })) out.tier = src.tier;
    if (src.viewport && isFinite(src.viewport.width) && isFinite(src.viewport.height)) {
      out.viewport = { width: src.viewport.width, height: src.viewport.height };
    }
    out.previewMode = src.previewMode === 'all' ||
      M.MODES.some(function (m) { return m.id === src.previewMode; }) ? src.previewMode : 'all';
    out.onlyShown = !!src.onlyShown;
    /* A view setting, but part of the editor state all the same: a save records
       it, so a load has to put it back or the canvas would come back showing
       something other than what was saved. */
    out.showOnDemandAll = !!src.showOnDemandAll;
    out.demandPick = (Array.isArray(src.demandPick) ? src.demandPick : [])
      .filter(function (g) {
        return M.DEMAND_GROUPS.some(function (d) { return d.id === g; });
      });
    out.zoom = src.zoom === 'fit' || isFinite(parseFloat(src.zoom)) ? src.zoom : 'fit';
    return out;
  }

  /* The per-field revert restores an element's template value, looked up by name.
     An imported theme may use renamed elements, so re-key it: a label is fixed by
     the template and survives renaming, which is what identifies where an element
     came from. A copy has a suffixed label and so correctly gets no revert. */
  function rebindTemplateDefaults(elements) {
    var byLabel = {};
    M.ELEMENTS.forEach(function (e) { byLabel[e.label] = e; });
    var next = {};
    elements.forEach(function (def) {
      var src = byLabel[def.label];
      if (src) next[def.id] = { x: src.x, y: src.y, w: src.w, h: src.h };
    });
    Object.keys(TEMPLATE_DEFAULTS).forEach(function (k) { delete TEMPLATE_DEFAULTS[k]; });
    Object.keys(next).forEach(function (k) { TEMPLATE_DEFAULTS[k] = next[k]; });
  }

  function applyImport(text, name) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      flashStatus('"' + name + '" is not valid JSON, so nothing was imported.');
      return;
    }

    var next = normaliseState(parsed);
    if (!next) {
      flashStatus('"' + name + '" is not a Plymouth theme save (.plymeta).');
      return;
    }

    state = next;
    selectedId = null;
    drag = null;
    shapeDrag = null;
    frozenZoom = null;
    closeTip(true);
    rebindTemplateDefaults(state.elements);

    dom.onlyShown.checked = state.onlyShown;
    dom.zoomSelect.value = state.zoom;
    render(true);
    historyReset();
    flashStatus('Imported ' + name + ' — ' + state.elements.length + ' elements, ' +
      state.paddings.length + ' paddings.');
  }

  /* ================================================================== boot */

  function bindStatic() {
    dom.onlyShown.addEventListener('change', function () {
      state.onlyShown = dom.onlyShown.checked;
      render(false);
    });

    dom.shapeReset.addEventListener('click', function () { setShape(null); });
    dom.addPaddingBtn.addEventListener('click', addPadding);

    /* the preview-mode explainer, sharing the one tip element with the rows */
    /* the On demand explainer, on the same shared tip */
    dom.onDemandHelp.addEventListener('mouseenter', function () { openTip(dom.onDemandHelp, demandTipContent()); });
    dom.onDemandHelp.addEventListener('mouseleave', closeTip);
    dom.onDemandHelp.addEventListener('focus', function () { openTip(dom.onDemandHelp, demandTipContent()); });
    dom.onDemandHelp.addEventListener('blur', closeTip);
    dom.onDemandHelp.addEventListener('click', function (e) {
      e.stopPropagation();
      if (tip.pinned && tip.anchor === dom.onDemandHelp) closeTip(true);
      else { openTip(dom.onDemandHelp, demandTipContent()); tip.pinned = true; }
    });

    dom.modeHelp.addEventListener('mouseenter', function () { openTip(dom.modeHelp, modeTipContent()); });
    dom.modeHelp.addEventListener('mouseleave', closeTip);
    dom.modeHelp.addEventListener('focus', function () { openTip(dom.modeHelp, modeTipContent()); });
    dom.modeHelp.addEventListener('blur', closeTip);
    dom.modeHelp.addEventListener('click', function (e) {
      e.stopPropagation();
      if (tip.pinned && tip.anchor === dom.modeHelp) closeTip(true);
      else { openTip(dom.modeHelp, modeTipContent()); tip.pinned = true; }
    });

    /* a tip anchored to a row would drift once that row moves, so dismiss it */
    document.addEventListener('click', function () { closeTip(true); });
    dom.sidebar.addEventListener('scroll', function () { closeTip(true); }, true);

    dom.themeName.addEventListener('input', function () { state.theme.name = dom.themeName.value; });
    dom.themeDesc.addEventListener('input', function () { state.theme.description = dom.themeDesc.value; });
    dom.themeRefresh.addEventListener('input', function () {
      state.theme.refresh_rate = parseInt(dom.themeRefresh.value, 10) || 0;
    });

    /* the add control is a plain picker; it springs back to its placeholder so
       the same element can be added again straight away */
    dom.addSelect.addEventListener('change', function () {
      var pick = dom.addSelect.value;
      dom.addSelect.value = '';
      if (pick) addFromTemplate(pick);
    });

    /* 6 — on-demand elements on the canvas. Off matches what Plymouth shows at
       boot; on is for designing the prompts and the console. */
    dom.onDemandToggle.checked = !!state.showOnDemandAll;
    dom.onDemandToggle.addEventListener('change', function () {
      state.showOnDemandAll = dom.onDemandToggle.checked;
      /* Show all and the group picks are two views of one thing */
      if (state.showOnDemandAll) state.demandPick = [];
      render(false);
    });

    buildDemandMenu();

    /* 2 — the File menu. Opens on click, closes on a choice, on Escape, or on a
       click anywhere else. */
    dom.fileMenu.hidden = true;   /* explicit, not left to the markup attribute */
    /* A menu is fixed-positioned, so it has to be placed against its button
       rather than flowing from it. Anchored to the right edge, because both sit
       at the right-hand end of the bar. */
    function placeMenu(menu, btn) {
      var r = btn.getBoundingClientRect();
      menu.style.top = Math.round(r.bottom + 5) + 'px';
      menu.style.right = Math.round(Math.max(6, window.innerWidth - r.right)) + 'px';
    }

    function closeFileMenu() {
      dom.fileMenu.hidden = true;
      dom.fileBtn.setAttribute('aria-expanded', 'false');
    }
    dom.fileBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      dom.demandMenu.hidden = true;
      var open = dom.fileMenu.hidden;
      if (open) placeMenu(dom.fileMenu, dom.fileBtn);
      dom.fileMenu.hidden = !open;
      dom.fileBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    dom.fileMenu.addEventListener('click', function () { closeFileMenu(); });

    dom.demandBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeFileMenu();
      var open = dom.demandMenu.hidden;
      if (open) placeMenu(dom.demandMenu, dom.demandBtn);
      dom.demandMenu.hidden = !open;
      dom.demandBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    /* the group list stays open while ticking, so only a click outside closes it */
    dom.demandMenu.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { dom.demandMenu.hidden = true; });
    document.addEventListener('click', closeFileMenu);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !dom.fileMenu.hidden) closeFileMenu();
    });

    /* 5 — the paddings section folds away. */
    dom.paddingToggle.addEventListener('click', function () {
      var open = dom.paddingBody.hidden;
      dom.paddingBody.hidden = !open;
      dom.paddingToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      dom.paddingToggle.textContent = open ? '▾' : '▸';
      dom.paddingToggle.title = (open ? 'Collapse' : 'Expand') + ' this section';
    });

    dom.undoBtn.addEventListener('click', undo);
    dom.redoBtn.addEventListener('click', redo);

    /* The universal shortcuts. Cmd on a Mac, Ctrl elsewhere, and Ctrl+Y as the
       other redo people reach for. Ignored while a field has focus, so the
       browser's own text undo still works where a caret is. */
    document.addEventListener('keydown', function (e) {
      var typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ||
        e.target.isContentEditable);
      var mod = e.metaKey || e.ctrlKey;

      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
        return;
      }
      /* Backspace with something selected removes it, as long as the caret is
         not in a field. */
      if (!typing && !mod && (e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
        var byIdSel = byId(selectedId);
        if (byIdSel && !isLocked(byIdSel)) {
          e.preventDefault();
          deleteElement(selectedId);
        }
      }
    });

    dom.generateBtn.addEventListener('click', generateTheme);
    dom.saveBtn.addEventListener('click', saveState);
    dom.exportBtn.addEventListener('click', exportJson);

    /* Import is a real file picker; the button is just its label. Clearing the
       value afterwards lets the same file be chosen twice in a row. */
    dom.importBtn.addEventListener('click', function () { dom.importFile.click(); });
    dom.assetFile.addEventListener('change', function () {
      var file = dom.assetFile.files && dom.assetFile.files[0];
      dom.assetFile.value = '';
      readAsset(file);
    });

    dom.importFile.addEventListener('change', function () {
      var file = dom.importFile.files && dom.importFile.files[0];
      dom.importFile.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { applyImport(String(reader.result), file.name); };
      reader.onerror = function () { flashStatus('Could not read that file.'); };
      reader.readAsText(file);
    });
    dom.resetBtn.addEventListener('click', function () {
      if (!window.confirm('Reset the theme, every element and every padding back to the layout.html defaults?\n\n' +
        'The screen size, zoom and preview mode you are looking at are kept.')) return;
      var view = {
        tier: state.tier, viewport: state.viewport, zoom: state.zoom,
        previewMode: state.previewMode, onlyShown: state.onlyShown
      };
      state = M.defaultState();
      /* reset the document, not the viewpoint */
      state.tier = view.tier;
      state.viewport = view.viewport;
      state.zoom = view.zoom;
      state.previewMode = view.previewMode;
      state.onlyShown = view.onlyShown;
      selectedId = null;
      drag = null;
      dom.onlyShown.checked = state.onlyShown;
      dom.zoomSelect.value = state.zoom;
      render(true);
      historyReset();
    });

    /* clicking empty canvas deselects */
    dom.stage.addEventListener('pointerdown', function (e) {
      if (e.target === dom.stage || e.target === dom.overlay) {
        selectedId = null;
        render(false);
      }
    });

    /* dragging a pad chip into a field is a bonus: keep click-to-insert primary */
    window.addEventListener('resize', function () { closeTip(true); render(false); });

    /* keyboard: arrow keys nudge the selection by one 720p pixel (shift = 10) */
    window.addEventListener('keydown', function (e) {
      if (!selectedId || drag) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      var step = (e.shiftKey ? 10 : 1) * tier().scale;
      var dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else if (e.key === 'Escape') { selectedId = null; render(false); return; }
      else return;
      var def = byId(selectedId);
      if (isLocked(def)) return;
      e.preventDefault();
      var r = resolved.elements[selectedId];
      writeFromDrag(def, 'x', r.x + dx, tier().scale);
      writeFromDrag(def, 'y', r.y + dy, tier().scale);
      render(false);
    });
  }

  function boot() {
    buildTopbar();
    buildShapeHandles();
    buildAddOptions();
    bindStatic();
    dom.onlyShown.checked = state.onlyShown;
    render(true);
    historyReset();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* exposed for the Node-side state test */
  window.PlymApp = {
    getState: function () { return state; },
    getResolved: function () { return resolved; },
    buildExport: buildExport
  };
})();
