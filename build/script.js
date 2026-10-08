/* ============================================================================
   Plymouth Theme Generator — script emitter (milestone 2, part 1)
   ----------------------------------------------------------------------------
   Turns the GUI's exported state into a Plymouth `.script` that keeps the
   author's formulas as formulas.

   The whole point is that nothing is baked to pixels. A header written as

     x: 50vw - (header.w / 2)

   is emitted as

     header_x = 50 * vw - (header_w / 2);

   with `vw` resolved from the *real* screen at load. So the same theme centres
   correctly on 16:9, 16:10 and 21:9 alike, and carries no assumption that the
   display is one of the four tiers.

   THE COORDINATE CONTRACT, mirrored exactly from model.js resolveAll():
     - a bare number standing alone as a whole value is a 720p measurement, so
       it scales: `300` -> `300 * scale`, where scale is screen height / 720.
     - a bare number *inside* a longer formula is literal: the 12 and the 2 in
       `(entry.w - (bullet.w * 12)) / 2` mean exactly 12 and 2.
     - `vw`/`vh`/`vmin`/`vmax` are percent-of-screen, so `100vmax` is the longer
       screen edge.
     - a per-tier override is absolute pixels for that tier and is never scaled.

   Plymouth's script language supplies only Cos, Int, Random, Sin, Sqrt and Tan
   — there is no Min or Max — so vmin/vmax are a branch rather than a call.
   ========================================================================= */
(function (root) {
  'use strict';

  var M = root.PlymModel;
  var E = root.PlymExpr;

  /* --------------------------------------------------------------- helpers */

  /* Identifiers in the emitted script cannot contain `-` or `.`, which would
     read as subtraction and member access. `corner-1080.w` -> `corner_1080_w`. */
  function ident(name) {
    return String(name).replace(/[^A-Za-z0-9_]/g, '_');
  }

  function num(value) {
    if (!isFinite(value)) return '0';
    /* keep integers integral — Plymouth divides in floating point, but a tidy
       script is a readable one */
    if (Math.floor(value) === value && Math.abs(value) < 1e15) return String(value);
    return String(Number(value.toFixed(6)));
  }

  function quote(text) {
    return '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function comment(text) {
    return '# ' + text;
  }

  /* ------------------------------------------------- name resolution table */

  /* Built once per document: every name the author's formulas may quote, mapped
     to the script identifier that holds it. */
  function nameTable(state) {
    var table = Object.create(null);

    /* screen units, and the 720p scale, resolved at the top of the script */
    table.vw = 'vw';
    table.vh = 'vh';
    table.vmin = 'vmin';
    table.vmax = 'vmax';
    table.scale = 'scale';
    table.W = 'screen_w';
    table.H = 'screen_h';

    state.paddings.forEach(function (p) {
      table[p.id] = ident('pad_' + p.id);
    });

    state.elements.forEach(function (el) {
      ['w', 'h', 'x', 'y'].forEach(function (prop) {
        table[el.id + '.' + prop] = ident(el.id + '_' + prop);
      });
    });

    return table;
  }

  /* -------------------------------------------------- expression emission */

  /* Walks the AST from expr.js and writes the same arithmetic in Plymouth's
     syntax. Fully parenthesised, so operator precedence can never drift between
     the two languages. */
  function emitAst(node, table, errs, where) {
    switch (node.type) {
      case 'num':
        return num(node.value);

      case 'name': {
        var mapped = table[node.value];
        if (mapped === undefined) {
          errs.push(where + ': unknown name "' + node.value + '"');
          return '0';
        }
        return mapped;
      }

      case 'neg':
        return '(-' + emitAst(node.arg, table, errs, where) + ')';

      case 'bin': {
        var op = node.op === '*' ? '*' : node.op === '/' ? '/' : node.op;
        return '(' + emitAst(node.left, table, errs, where) + ' ' + op + ' ' +
          emitAst(node.right, table, errs, where) + ')';
      }
    }
    errs.push(where + ': malformed expression');
    return '0';
  }

  /* One value, mirroring model.js baseValue() / overrideValue().
     `scaled` is true for a base value (a lone number is a 720p measurement) and
     false for an override (a lone number is already this tier's pixel count). */
  function emitValue(raw, table, errs, where, scaled) {
    var text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (text === '') return '0';
    if (M.isPlainNumber(text)) {
      var value = parseFloat(text);
      return scaled ? '(' + num(value) + ' * scale)' : num(value);
    }
    var ast;
    try {
      ast = E.compile(text, knownNames(table));
    } catch (err) {
      errs.push(where + ': ' + err.message);
      return '0';
    }
    return emitAst(ast, table, errs, where);
  }

  var namesCache = null;
  var namesCacheKey = '';
  /* Longest first, so `pad-h1` never splits into `pad - h1`. */
  function knownNames(table) {
    var key = Object.keys(table).length;
    var all = Object.keys(table);
    if (namesCache && namesCacheKey === key + ':' + all.join(',')) return namesCache;
    namesCache = all.slice().sort(function (a, b) { return b.length - a.length; });
    namesCacheKey = key + ':' + all.join(',');
    return namesCache;
  }

  /* --------------------------------------------------- dependency ordering */

  function refsOf(raw, table) {
    var text = String(raw === undefined || raw === null ? '' : raw).trim();
    var found = [];
    if (text === '' || M.isPlainNumber(text)) return found;
    var ast;
    try {
      ast = E.compile(text, knownNames(table));
    } catch (err) {
      return found;
    }
    (function walk(node) {
      if (!node) return;
      if (node.type === 'name') {
        var mapped = table[node.value];
        if (mapped) found.push(mapped);
        return;
      }
      walk(node.arg);
      walk(node.left);
      walk(node.right);
    })(ast);
    return found;
  }

  /* A flat list of `name = expr;` lines, ordered so every value is defined
     before it is used. An element's width may reference another element's
     height, so this cannot assume w/h come before x/y — it sorts properly and
     reports a cycle rather than emitting an order that silently reads 0. */
  function orderedDefs(state, table) {
    var defs = [];        /* { name, expr, deps } */
    var errs = [];
    var overrides = [];   /* per-tier pins the caller still has to place */

    state.paddings.forEach(function (p) {
      var target = table[p.id];
      defs.push({
        name: target,
        expr: emitValue(p.expr, table, errs, 'padding ' + p.id, true),
        deps: refsOf(p.expr, table),
        label: 'padding ' + p.id,
        group: 'padding ' + p.id,
        padding: true
      });
    });

    state.elements.forEach(function (el) {
      ['w', 'h', 'x', 'y'].forEach(function (prop) {
        var target = table[el.id + '.' + prop];
        var where = el.id + '.' + prop;

        /* A per-tier override is absolute pixels for one tier, so it cannot be
           a single value: it becomes a branch on the tier the theme found
           itself running at. The base formula is still emitted, and every
           dependant still reads the one variable, so nothing downstream has to
           know an override exists. */
        var pins = [];
        Object.keys(el.overrides || {}).forEach(function (tierId) {
          var ov = el.overrides[tierId];
          if (!ov || ov[prop] === undefined || ov[prop] === '') return;
          var index = M.TIERS.map(function (t) { return t.id; }).indexOf(tierId);
          if (index < 0) return;
          pins.push({
            index: index,
            tier: tierId,
            raw: ov[prop],
            expr: emitValue(ov[prop], table, errs, where + ' @' + tierId, false)
          });
          overrides.push({ where: where, tier: tierId, expr: ov[prop] });
        });
        pins.sort(function (a, b) { return a.index - b.index; });

        /* The sort has to wait for whatever the pins quote as well as whatever
           the base formula does, or a pinned value could be emitted before a
           name it reads. */
        var deps = refsOf(el[prop], table);
        pins.forEach(function (pin) {
          if (pin.raw !== undefined) deps = deps.concat(refsOf(pin.raw, table));
        });

        defs.push({
          name: target,
          expr: emitValue(el[prop], table, errs, where, true),
          deps: deps,
          label: where,
          group: el.id,
          pins: pins,
          padding: false
        });
      });
    });

    /* Kahn-ish: repeatedly take whatever is now satisfiable. */
    var byName = Object.create(null);
    defs.forEach(function (d) { byName[d.name] = d; });

    var emitted = Object.create(null);
    var out = [];
    var remaining = defs.slice();
    while (remaining.length) {
      var progressed = false;
      for (var i = 0; i < remaining.length; i += 1) {
        var d = remaining[i];
        var ready = d.deps.every(function (dep) {
          return emitted[dep] || !byName[dep];
        });
        if (ready) {
          out.push(d);
          emitted[d.name] = true;
          remaining.splice(i, 1);
          i -= 1;
          progressed = true;
        }
      }
      if (!progressed) {
        remaining.forEach(function (d) {
          errs.push('circular reference involving ' + d.label);
        });
        break;
      }
    }

    return { defs: out, errors: errs, overrides: overrides };
  }

  /* -------------------------------------------------------------- the block */

  /* The geometry block: screen units, the 720p scale, paddings, then every
     element's four values in dependency order. */
  function emitGeometry(state) {
    var table = nameTable(state);
    var ordered = orderedDefs(state, table);
    var lines = [];

    lines.push(comment('---------------------------------------------------'));
    lines.push(comment('Screen geometry, resolved once at load.'));
    lines.push(comment('Nothing below is baked to a pixel count, so the theme'));
    lines.push(comment('lays out correctly on any aspect ratio.'));
    lines.push(comment('---------------------------------------------------'));
    lines.push('screen_w = Window.GetWidth();');
    lines.push('screen_h = Window.GetHeight();');
    lines.push('');
    lines.push(comment('A bare number in the layout is a 720p measurement.'));
    lines.push('scale = screen_h / 720;');
    lines.push('');
    lines.push(comment('Percent-of-screen, as in CSS. 100vmax is the longer edge.'));
    lines.push('vw = screen_w / 100;');
    lines.push('vh = screen_h / 100;');
    lines.push(comment('The language has no Min or Max, so this is a branch.'));
    lines.push('if (screen_w < screen_h)');
    lines.push('{');
    lines.push('  vmin = screen_w / 100;');
    lines.push('  vmax = screen_h / 100;');
    lines.push('}');
    lines.push('else');
    lines.push('{');
    lines.push('  vmin = screen_h / 100;');
    lines.push('  vmax = screen_w / 100;');
    lines.push('}');
    lines.push('');

    lines.push(comment('Paddings and element geometry, in dependency order.'));
    lines.push(comment('A padding may be written in terms of an element size and'));
    lines.push(comment('an element may quote a padding, so the two cannot be'));
    lines.push(comment('emitted as separate blocks: the order below is the order'));
    lines.push(comment('the values can actually be computed in.'));

    /* Emitted strictly in the sorted order. Grouping them by kind here would
       undo the sort — pad-v4 is written in terms of entry.w, so it has to come
       after it, not in a paddings-first block. */
    var current = null;
    ordered.defs.forEach(function (d) {
      if (d.group !== current) {
        lines.push('');
        lines.push(comment(d.group));
        current = d.group;
      }
      lines.push(d.name + ' = ' + d.expr + ';');
      (d.pins || []).forEach(function (pin) {
        lines.push('if (tier == ' + pin.index + ') ' + d.name + ' = ' + pin.expr + ';   ' +
          comment('pinned for ' + pin.tier));
      });
    });

    return {
      text: lines.join('\n') + '\n',
      errors: ordered.errors,
      overrides: ordered.overrides,
      table: table
    };
  }

  /* ------------------------------------------------------- tier detection */

  /* Which variant folder to read from, decided from the real screen height.
     The thresholds sit halfway between the four tier heights, so this is the
     nearest tier by height and nothing else. Written as sequential `if`s rather
     than an `else if` chain: same result, no grammar to get wrong. */
  function emitAssetPrelude() {
    var lines = [];
    lines.push(comment('---------------------------------------------------'));
    lines.push(comment('Which variant folder to read. Thresholds sit halfway'));
    lines.push(comment('between the four tier heights, so this is the nearest'));
    lines.push(comment('tier by screen height.'));
    lines.push(comment('---------------------------------------------------'));
    lines.push('tier = 0;');
    M.TIERS.forEach(function (t, i) {
      if (i === 0) return;
      var mid = Math.round((M.TIERS[i - 1].height + t.height) / 2);
      lines.push('if (screen_h >= ' + mid + ') tier = ' + i + ';');
    });
    lines.push('');
    lines.push(comment('Fetches the first path that exists, and decodes only that'));
    lines.push(comment('one. Taking paths rather than images is what keeps the other'));
    lines.push(comment('three off the disk and out of memory. A missing file is not'));
    lines.push(comment('an error: Image() returns NULL, and the element is simply'));
    lines.push(comment('not drawn, so deleting art from the theme removes it.'));
    lines.push('fun load_nearest (p1, p2, p3, p4)');
    lines.push('{');
    lines.push('  picked = Image (p1);');
    lines.push('  if (picked) return picked;');
    lines.push('  picked = Image (p2);');
    lines.push('  if (picked) return picked;');
    lines.push('  picked = Image (p3);');
    lines.push('  if (picked) return picked;');
    lines.push('  return Image (p4);');
    lines.push('}');
    return lines.join('\n') + '\n';
  }

  /* ------------------------------------------------------------- assets */

  /* One block per asset: fetch it from the nearest folder that has it, then
     scale it to the size this screen actually needs.

     `assets` is [{ file, varName, wVar, hVar }] — `file` is the same relative
     name inside every variant folder. */
  function emitAssetLoads(assets) {
    if (!assets.length) return '';
    var A = root.PlymPlacement;
    var lines = [];

    lines.push('');
    lines.push(comment('---------------------------------------------------'));
    lines.push(comment('Assets. Fetched from the nearest folder that has the file,'));
    lines.push(comment('then scaled to the size this screen actually needs.'));
    lines.push(comment('---------------------------------------------------'));

    assets.forEach(function (a) {
      lines.push('');
      lines.push(comment(a.file));
      lines.push(a.varName + ' = NULL;');
      M.TIERS.forEach(function (t, i) {
        var order = A.nearestOrder(t.id).map(function (id) {
          return quote('assets/' + id + '/' + a.file);
        });
        lines.push('if (tier == ' + i + ')');
        lines.push('{');
        lines.push('  ' + a.varName + ' = load_nearest (' + order.join(', ') + ');');
        lines.push('}');
      });
      lines.push(comment('A placeholder written for this tier is already the right'));
      lines.push(comment('size; one that fell back from another tier is not.'));
      lines.push('if (' + a.varName + ' && (' + a.varName + '.GetWidth () != Math.Int (' +
        a.wVar + ') || ' + a.varName + '.GetHeight () != Math.Int (' + a.hVar + ')))');
      lines.push('{');
      lines.push('  ' + a.varName + ' = ' + a.varName + '.Scale (Math.Int (' + a.wVar +
        '), Math.Int (' + a.hVar + '));');
      lines.push('}');
    });

    return lines.join('\n') + '\n';
  }

  /* --------------------------------------------------------------- modes */

  /* Plymouth hands the theme the splash mode it was started in, and it does not
     change for the life of that splash, so visibility is decided once at load.
     A mode index beats comparing strings per element. */
  function emitModeBlock() {
    var lines = [];
    lines.push('');
    lines.push(comment('---------------------------------------------------'));
    lines.push(comment('Which splash mode we are in. Plymouth hands this over once,'));
    lines.push(comment('when the splash starts, and it does not change afterwards.'));
    lines.push(comment('---------------------------------------------------'));
    lines.push('mode = Plymouth.GetMode ();');
    lines.push('mode_i = -1;');
    M.MODES.forEach(function (m, i) {
      lines.push('if (mode == ' + quote(m.id) + ') mode_i = ' + i + ';');
    });
    return lines.join('\n') + '\n';
  }

  /* ------------------------------------------------------------- sprites */

  /* One sprite per element that draws a picture, positioned from the resolved
     variables and stacked by the element's own z.

     Visibility: an element appears if the mode it found itself in is one it is
     set to show in. Elements Plymouth raises itself — the prompts, the status
     line, the console — are created hidden whatever the mode, and the callbacks
     below are the only thing that shows them. */
  function emitSprites(state, assets) {
    if (!assets.length) return '';
    var byId = Object.create(null);
    state.elements.forEach(function (def) { byId[def.id] = def; });

    var lines = [];
    lines.push('');
    lines.push(comment('---------------------------------------------------'));
    lines.push(comment('Sprites. An element with no asset is simply not drawn, so'));
    lines.push(comment('deleting a file from the theme removes the element.'));
    lines.push(comment('---------------------------------------------------'));

    assets.forEach(function (a) {
      var def = byId[a.id];
      if (!def) {
        throw new Error('emitSprites: asset "' + (a.id || a.file) +
          '" names no element — scriptAssets must carry the id');
      }
      var v = a.varName;
      var n = a.id.replace(/[^A-Za-z0-9_]/g, '_');

      /* The zone is an area: it holds the row but draws nothing itself. */
      if (def.bullets) return;

      lines.push('');
      lines.push(comment(def.label + (def.onDemand ? '  (shown on demand)' : '')));
      lines.push(v.replace(/_image$/, '_sprite') + ' = NULL;');
      lines.push('if (' + v + ')');
      lines.push('{');

      /* A dot that repeats across a zone becomes one sprite per slot, stepped by
         the dot's own width — this is the row the theme actually draws. */
      var zone = null;
      if (def.repeatsIn) {
        state.elements.forEach(function (e) { if (e.id === def.repeatsIn) zone = e; });
      }
      if (zone && zone.bullets > 1) {
        lines.push('  ' + n + '_sprite = Sprite (' + v + ');');
        lines.push('  ' + n + '_sprite.SetPosition (Math.Int (' + zone.id.replace(/[^A-Za-z0-9_]/g, '_') +
          '_x + pad_' + 'pad_v4' + '), Math.Int (' + zone.id.replace(/[^A-Za-z0-9_]/g, '_') +
          '_y), ' + num(def.z) + ');');
        for (var slot = 1; slot < zone.bullets; slot += 1) {
          lines.push('  ' + n + '_s' + slot + ' = Sprite (' + v + ');');
          lines.push('  ' + n + '_s' + slot + '.SetPosition (Math.Int (' +
            zone.id.replace(/[^A-Za-z0-9_]/g, '_') + '_x + pad_pad_v4 + ' + slot +
            ' * ' + n + '_w), Math.Int (' + zone.id.replace(/[^A-Za-z0-9_]/g, '_') + '_y), ' +
            num(def.z) + ');');
          lines.push('  ' + n + '_s' + slot + '.SetOpacity (0);');
        }
      } else {
        lines.push('  ' + n + '_sprite = Sprite (' + v + ');');
        lines.push('  ' + n + '_sprite.SetPosition (Math.Int (' + n + '_x), Math.Int (' + n +
          '_y), ' + num(def.z) + ');');
      }

      if (def.onDemand) {
        lines.push('  ' + n + '_sprite.SetOpacity (0);');
      } else {
        lines.push.apply(lines, modeOpacity(state, def, n + '_sprite'));
      }
      lines.push('}');
    });

    return lines.join('\n') + '\n';
  }

  /* ---------------------------------------------------------------- text */

  /* `#rrggbb` (or a CSS keyword the model already resolved) to the 0..1 floats
     Image.Text wants. Anything unparseable is white rather than black, because
     invisible text is the harder failure to notice. */
  function rgb01(colour) {
    var hex = String(colour || '').trim();
    var m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return [1, 1, 1];
    var v = parseInt(m[1], 16);
    return [
      Number((((v >> 16) & 255) / 255).toFixed(4)),
      Number((((v >> 8) & 255) / 255).toFixed(4)),
      Number(((v & 255) / 255).toFixed(4))
    ];
  }

  function fontString(def, scale) {
    var f = def.font || {};
    var family = String(f.family || 'Sans').split(',')[0].trim();
    var size = parseFloat(f.size);
    if (!isFinite(size) || size <= 0) size = 16;
    return family + ' ' + Math.max(1, Math.round(size * scale));
  }

  /* Text is drawn by Image.Text, which takes a font as a string like "Sans 32".
     That size has to scale with the screen, and the language has no string
     concatenation — its string library is CharAt, Length and SubString only — so
     the font is picked per tier from four literals. That is the same four-step
     quantisation the assets use, and for the same reason.

     The string itself is *not* baked in beyond the opening frame: the layout's
     text is a placeholder, and the real string arrives from the system. Each
     element therefore also gets a show_<id> function the callbacks call. */
  function emitTexts(state) {
    var texts = state.elements.filter(function (d) {
      return d.kind === 'text' && !d.bullets;
    });
    if (!texts.length) return '';

    var lines = [];
    lines.push('');
    lines.push(comment('---------------------------------------------------'));
    lines.push(comment('Text. The font is chosen per tier because the size has to'));
    lines.push(comment('scale and the language cannot build a string at run time.'));
    lines.push(comment('---------------------------------------------------'));

    /* Left-aligned is right for the things that read as a log or an input box;
       everything else is centred, which is what the layout does. */
    var LEFT = ['console', 'entry-text', 'status', 'message', 'prompt', 'prompt-question'];

    texts.forEach(function (def) {
      var n = ident(def.id);
      var f = def.font || {};
      var rgb = rgb01(f.color);
      var align = LEFT.indexOf(def.id) > -1 ? 'left' : 'center';
      var rgbArg = num(rgb[0]) + ', ' + num(rgb[1]) + ', ' + num(rgb[2]) + ', 1';
      var label = def.text || def.label;

      lines.push('');
      lines.push(comment(def.label + (def.onDemand ? '  (shown on demand)' : '')));
      lines.push(n + '_image = NULL;');
      M.TIERS.forEach(function (t, i) {
        lines.push('if (tier == ' + i + ') ' + n + '_image = Image.Text (' +
          quote(label) + ', ' + rgbArg + ', ' + quote(fontString(def, t.scale)) + ', ' +
          quote(align) + ');');
      });
      lines.push(n + '_sprite = NULL;');
      lines.push('if (' + n + '_image)');
      lines.push('{');
      lines.push('  ' + n + '_sprite = Sprite (' + n + '_image);');
      lines.push('  ' + n + '_sprite.SetPosition (Math.Int (' + n + '_x), Math.Int (' +
        n + '_y), ' + num(def.z) + ');');
      if (def.onDemand) {
        lines.push('  ' + n + '_sprite.SetOpacity (0);');
      } else {
        lines.push.apply(lines, modeOpacity(state, def, n + '_sprite'));
      }
      lines.push('}');
      lines.push('');
      lines.push(comment('The system supplies the real string.'));
      lines.push('fun show_' + n + ' (text)');
      lines.push('{');
      lines.push('  if (!' + n + '_sprite) return;');
      M.TIERS.forEach(function (t, i) {
        lines.push('  if (tier == ' + i + ') ' + n + '_sprite.SetImage (Image.Text (text, ' +
          rgbArg + ', ' + quote(fontString(def, t.scale)) + ', ' + quote(align) + '));');
      });
      lines.push('  ' + n + '_sprite.SetOpacity (1);');
      lines.push('}');
    });

    return lines.join('\n') + '\n';
  }

  /* The SetOpacity lines for an element the mode decides, shared by sprites and
     text so the two cannot disagree about what "shown in this mode" means. */
  function modeOpacity(state, def, spriteVar) {
    var all = M.MODES.map(function (m) { return m.id; });
    var chosen = Array.isArray(def.showIn) && def.showIn.length ? def.showIn : all;
    if (chosen.length === all.length) {
      return ['  ' + spriteVar + '.SetOpacity (1);'];
    }
    var conds = chosen.map(function (id) {
      var idx = all.indexOf(id);
      return idx < 0 ? null : 'mode_i == ' + idx;
    }).filter(Boolean);
    var out = ['  ' + spriteVar + '.SetOpacity (0);'];
    if (conds.length) out.push('  if (' + conds.join(' || ') + ') ' + spriteVar + '.SetOpacity (1);');
    return out;
  }

  /* -------------------------------------------------------------- frames */

  /* A sequence is `assets/<tier>/<id>/<id>-1.png`, `-2.png`, … and the count is
     found by probing the slots in order: the highest contiguous one that loaded
     is the count, so frames can be dropped in or deleted after generation and
     the theme simply finds what is there.

     Frames never fall back individually. If a tier has frames 1-5 and 7-36 but
     not 6, the count stops at 5 — fetching frame 6 from another tier would let
     the count run past the gap and play one frame at a different size mid-loop,
     which is far worse than a short animation. A tier supplies a whole sequence
     or none of it, and a tier that has nothing falls through to the next. */
  function frameTierOrder(def) {
    var A = root.PlymPlacement;
    var own = A.tiersForElement(def);
    if (!own.length) return A.tierIds();
    /* The element's own tier first, then the rest ascending. Nearest-first for
       every runtime tier would mean sixteen unrolled blocks per element instead
       of four, and the ordering only differs on a fallback path that is already
       the exception. */
    return own;
  }

  function emitFrames(state, assets) {
    var byId = Object.create(null);
    state.elements.forEach(function (def) { byId[def.id] = def; });

    var animated = assets.filter(function (a) {
      var d = byId[a.id];
      return d && d.kind === 'animation';
    });
    if (!animated.length) return '';

    var MAX = M.MAX_FRAMES;
    var lines = [];
    lines.push('');
    lines.push(comment('---------------------------------------------------'));
    lines.push(comment('Frame sequences. Probing stops at the first gap, so a tier'));
    lines.push(comment('supplies a whole sequence or none of it, and frames can be'));
    lines.push(comment('added or removed after generation.'));
    lines.push(comment('---------------------------------------------------'));

    animated.forEach(function (a) {
      var def = byId[a.id];
      var n = ident(a.id);
      var tiers = frameTierOrder(def);

      lines.push('');
      lines.push(comment(def.label + ' — up to ' + MAX + ' frames'));
      lines.push(n + '_count = 0;');

      tiers.forEach(function (tierId, ti) {
        lines.push('');
        lines.push('# ' + tierId);
        lines.push('if (' + (ti === 0 ? 'tier == ' + tierIndexOf(tierId) : n + '_count < 1') + ')');
        lines.push('{');
        for (var i = 1; i <= MAX; i += 1) {
          var path = 'assets/' + tierId + '/' + a.id + '/' + a.id + '-' + i + '.png';
          lines.push('  ' + n + '_f' + i + ' = Image (' + quote(path) + ');' +
            ' if (' + n + '_f' + i + ' && ' + n + '_count == ' + (i - 1) + ') ' +
            n + '_count = ' + i + ';');
        }
        lines.push('}');
      });

      /* Stepping. One line per frame, because the language cannot index a set of
         named globals. */
      lines.push('');
      lines.push(comment('Advances one frame per tick and wraps at the count.'));
      lines.push('fun ' + n + '_step ()');
      lines.push('{');
      lines.push('  if (' + n + '_count < 2 || !' + n + '_sprite) return;');
      lines.push('  ' + n + '_i = ' + n + '_i + 1;');
      lines.push('  if (' + n + '_i > ' + n + '_count) ' + n + '_i = 1;');
      for (var j = 1; j <= MAX; j += 1) {
        lines.push('  if (' + n + '_i == ' + j + ') ' + n + '_sprite.SetImage (' +
          n + '_f' + j + ');');
      }
      lines.push('}');
      lines.push(n + '_i = 0;');

      /* A single frame is a still, not a broken animation: the sprite already
         holds it and the step function returns immediately. */
      lines.push(comment('Show the first frame if there is one.'));
      lines.push('if (' + n + '_count > 0 && ' + n + '_sprite) ' + n + '_sprite.SetImage (' +
        n + '_f1);');
    });

    return lines.join('\n') + '\n';
  }

  function tierIndexOf(id) {
    var ids = M.TIERS.map(function (t) { return t.id; });
    return ids.indexOf(id);
  }

  /* ------------------------------------------------------------- drivers */

  /* The refresh tick and the boot-progress mapping.

     `progress` is the exception to the animation clock: its frame is chosen
     from the boot fraction rather than advanced, so it moves when the boot
     moves and sits still when it sits still. N frames means N evenly spaced
     steps from 0 to 100%. */
  function emitDrivers(state, assets) {
    var byId = Object.create(null);
    state.elements.forEach(function (def) { byId[def.id] = def; });

    var animated = assets.filter(function (a) {
      var d = byId[a.id];
      return d && d.kind === 'animation';
    });
    if (!animated.length) return '';

    var steppers = animated.filter(function (a) { return a.id !== 'progress'; });
    var hasProgress = animated.some(function (a) { return a.id === 'progress'; });
    var lines = [];

    lines.push('');
    lines.push(comment('---------------------------------------------------'));
    lines.push(comment('The tick. Every animated element except progress advances'));
    lines.push(comment('one frame per refresh, so one rule covers them all.'));
    lines.push(comment('---------------------------------------------------'));
    lines.push('fun on_refresh ()');
    lines.push('{');
    if (!steppers.length) {
      lines.push('  return;');
    } else {
      steppers.forEach(function (a) { lines.push('  ' + ident(a.id) + '_step ();'); });
    }
    lines.push('}');

    if (hasProgress) {
      var MAX = M.MAX_FRAMES;
      lines.push('');
      lines.push(comment('Progress, driven by the boot fraction rather than the'));
      lines.push(comment('clock: N frames are N evenly spaced steps from 0 to 100%.'));
      lines.push('fun on_progress (duration, progress)');
      lines.push('{');
      lines.push('  if (progress_count < 2 || !progress_sprite) return;');
      lines.push('  progress_i = Math.Int (progress * (progress_count - 1)) + 1;');
      lines.push('  if (progress_i > progress_count) progress_i = progress_count;');
      lines.push('  if (progress_i < 1) progress_i = 1;');
      for (var j = 1; j <= MAX; j += 1) {
        lines.push('  if (progress_i == ' + j + ') progress_sprite.SetImage (progress_f' + j + ');');
      }
      lines.push('}');
    }

    lines.push('');
    lines.push(comment('Bind the two that drive animation.'));
    lines.push('Plymouth.SetRefreshFunction (on_refresh);');
    if (hasProgress) lines.push('Plymouth.SetBootProgressFunction (on_progress);');

    return lines.join('\n') + '\n';
  }

  /* ----------------------------------------------------------- callbacks */

  /* Which on-demand elements each callback raises. Plymouth shows one entry
     state at a time: the password set and the question set are mutually
     exclusive, and both share the dialog panel behind them. */
  var PASSWORD_SET = ['dialog', 'prompt', 'lock', 'entry', 'bullet', 'capslock', 'keyboard', 'keymap'];
  var QUESTION_SET = ['dialog', 'prompt-question', 'entry-question', 'entry-text'];

  function emitCallbacks(state) {
    var byId = Object.create(null);
    state.elements.forEach(function (def) { byId[def.id] = def; });

    var hasSprite = Object.create(null);
    state.elements.forEach(function (def) {
      if (def.kind === 'image' || def.kind === 'animation') hasSprite[def.id] = true;
    });

    var lines = [];
    lines.push('');
    lines.push(comment('---------------------------------------------------'));
    lines.push(comment('Callbacks. Everything Plymouth raises itself goes through'));
    lines.push(comment('here: the two entry states, the status line and messages.'));
    lines.push(comment('---------------------------------------------------'));

    function raise(name, ids, on) {
      var sprites = ids.filter(function (id) {
        /* A dot that repeats is not the panel's to raise: how many are shown is
           the count Plymouth reports, and show_bullets owns it. */
        return hasSprite[id] && !byId[id].repeatsIn;
      });
      lines.push('');
      lines.push('fun ' + name + ' (on)');
      lines.push('{');
      if (!sprites.length) {
        lines.push('  return;');
      } else {
        sprites.forEach(function (id) {
          var n = ident(id);
          lines.push('  if (' + n + '_sprite) ' + n + '_sprite.SetOpacity (on);');
        });
      }
      lines.push('}');
    }

    raise('password_panel', PASSWORD_SET, true);
    raise('question_panel', QUESTION_SET, true);

    /* The text side of each state is a show_<id> the text block already emits,
       so the handlers refresh the string and then raise the panel. */
    /* The bullet row. Plymouth reports how many characters the user has typed,
       so the dots are all created and revealed up to that count — which is why
       the safe zone holds a capacity rather than a fixed number. */
    var zone = null;
    var dot = null;
    state.elements.forEach(function (e) {
      if (e.bullets) zone = e;
      if (e.repeatsIn) dot = e;
    });
    var dotNames = [];
    if (dot && zone && zone.bullets > 1) {
      var dn = ident(dot.id);
      dotNames.push(dn + '_sprite');
      for (var k = 1; k < zone.bullets; k += 1) dotNames.push(dn + '_s' + k);
    }
    if (dotNames.length) {
      lines.push('');
      lines.push(comment('One bullet per character typed. Plymouth supplies the'));
      lines.push(comment('count on the password callback; the rest stay hidden.'));
      lines.push('fun show_bullets (count)');
      lines.push('{');
      dotNames.forEach(function (n2) { lines.push('  if (' + n2 + ') ' + n2 + '.SetOpacity (0);'); });
      dotNames.forEach(function (n2, idx) {
        lines.push('  if (count > ' + idx + ' && ' + n2 + ') ' + n2 + '.SetOpacity (1);');
      });
      lines.push('}');
    }

    var promptIsText = byId.prompt && byId.prompt.kind === 'text';
    var questionIsText = byId['prompt-question'] && byId['prompt-question'].kind === 'text';

    lines.push('');
    lines.push(comment('Plymouth asks for a password.'));
    lines.push('fun on_password (prompt, bullets)');
    lines.push('{');
    lines.push('  password_panel (1);');
    lines.push('  question_panel (0);');
    if (dotNames.length) lines.push('  show_bullets (bullets);');
    if (promptIsText) lines.push('  show_prompt (prompt);');
    lines.push('}');

    lines.push('');
    lines.push(comment('Plymouth asks a question, and the answer is not secret.'));
    lines.push('fun on_question (prompt, entry_text)');
    lines.push('{');
    lines.push('  question_panel (1);');
    lines.push('  password_panel (0);');
    if (questionIsText) lines.push('  show_prompt_question (prompt);');
    if (byId['entry-text'] && byId['entry-text'].kind === 'text') {
      lines.push('  show_entry_text (entry_text);');
    }
    lines.push('}');

    lines.push('');
    lines.push(comment('Neither is wanted any more: back to the plain screen.'));
    lines.push('fun on_normal ()');
    lines.push('{');
    lines.push('  password_panel (0);');
    lines.push('  question_panel (0);');
    lines.push('}');

    lines.push('');
    lines.push(comment('A client set the status line with `plymouth update --status=`.'));
    lines.push('fun on_status (text)');
    lines.push('{');
    if (byId.status && byId.status.kind === 'text') {
      lines.push('  if (!status_sprite) return;');
      lines.push('  show_status (text);');
    } else {
      lines.push('  return;');
    }
    lines.push('}');

    lines.push('');
    lines.push(comment('A transient message, which Plymouth takes away again.'));
    lines.push('fun on_message (text)');
    lines.push('{');
    if (byId.message && byId.message.kind === 'text') lines.push('  show_message (text);');
    else lines.push('  return;');
    lines.push('}');

    lines.push('');
    lines.push('fun on_hide_message ()');
    lines.push('{');
    if (byId.message) {
      var m = ident('message');
      lines.push('  if (' + m + '_sprite) ' + m + '_sprite.SetOpacity (0);');
    } else {
      lines.push('  return;');
    }
    lines.push('}');

    lines.push('');
    lines.push(comment('Plymouth is finishing. Nothing to put away: the screen'));
    lines.push(comment('is about to go.'));
    lines.push('fun on_quit ()');
    lines.push('{');
    lines.push('  return;');
    lines.push('}');

    /* ---- registration */
    lines.push('');
    lines.push(comment('Bind them. The refresh rate comes from the theme rather'));
    lines.push(comment('than the plugin default of 50, so animation pacing is ours.'));
    var rate = parseInt(state.theme && state.theme.refresh_rate, 10);
    lines.push('Plymouth.SetRefreshRate (' + (isFinite(rate) && rate > 0 ? rate : 30) + ');');
    lines.push('Plymouth.SetDisplayPasswordFunction (on_password);');
    lines.push('Plymouth.SetDisplayQuestionFunction (on_question);');
    lines.push('Plymouth.SetDisplayNormalFunction (on_normal);');
    lines.push('Plymouth.SetUpdateStatusFunction (on_status);');
    lines.push('Plymouth.SetDisplayMessageFunction (on_message);');
    lines.push('Plymouth.SetHideMessageFunction (on_hide_message);');
    lines.push('Plymouth.SetQuitFunction (on_quit);');

    return lines.join('\n') + '\n';
  }

  /* ------------------------------------------------------------ assembly */

  /* Everything emitted so far, in the order the language needs it: screen
     geometry first, because the tier thresholds and the asset sizes both read
     it, then the loader, then the assets.

     Sprites, the mode manifest and the callbacks are not here yet — this is
     the load-time half of the theme. */
  function emitScript(state, assets) {
    var geo = emitGeometry(state);
    var text = '';
    text += comment('===================================================');
    text += '\n';
    text += comment('Generated by the Plymouth theme generator.');
    text += '\n';
    text += comment('Every position and size below is computed from the real');
    text += '\n';
    text += comment('screen at load, so the theme is not tied to one resolution.');
    text += '\n';
    text += comment('===================================================');
    text += '\n\n';
    text += geo.text;
    text += '\n' + emitAssetPrelude();
    text += emitModeBlock();
    text += emitAssetLoads(assets || []);
    text += emitSprites(state, assets || []);
    /* frames after sprites, because a sequence sets images on a sprite that has
       to exist first */
    text += emitFrames(state, assets || []);
    text += emitTexts(state);
    text += emitDrivers(state, assets || []);
    text += emitCallbacks(state);
    return { text: text, errors: geo.errors, overrides: geo.overrides, table: geo.table };
  }

  root.PlymScript = {
    emitGeometry: emitGeometry,
    emitAssetPrelude: emitAssetPrelude,
    emitAssetLoads: emitAssetLoads,
    emitModeBlock: emitModeBlock,
    emitSprites: emitSprites,
    emitTexts: emitTexts,
    emitCallbacks: emitCallbacks,
    emitFrames: emitFrames,
    emitDrivers: emitDrivers,
    rgb01: rgb01,
    fontString: fontString,
    emitScript: emitScript,
    emitValue: emitValue,
    emitAst: emitAst,
    nameTable: nameTable,
    ident: ident,
    num: num,
    quote: quote,
    comment: comment
  };
})(typeof window !== 'undefined' ? window : globalThis);
