/* ============================================================================
   Plymouth Theme Generator — theme assembly (milestone 2, part 3)
   ----------------------------------------------------------------------------
   Owns the shape of the thing that gets written to disk:

     <name>/
       <name>.plymouth        the descriptor Plymouth reads
       <name>.script          the script emitted by build/script.js
       assets/720p/ 1080p/ 1440p/ 2160p/
                              one folder per tier, each holding the same asset
                              names, so the script can look in a fixed set of
                              places and skip whatever is not there

   This module only names the files and says what belongs in them. Turning an
   uploaded asset into the bytes of a PNG is the browser's job and lives
   elsewhere, because it needs a decoder.

   Nothing here is destructive: a plan never contains a path the author may have
   replaced by hand without the caller being told. The rule carried over from
   the template is that an existing file is never overwritten silently, so the
   plan marks generated placeholders differently from supplied art and the
   writer decides.
   ========================================================================= */
(function (root) {
  'use strict';

  var M = root.PlymModel;
  var A = root.PlymPlacement;
  var S = root.PlymScript;

  /* ------------------------------------------------------------- descriptor */

  /* Where Plymouth installs a theme. The generator writes a tree that is meant
     to be dropped at this path, so the descriptor can carry the final absolute
     paths — Plymouth resolves them from this file, not from where it was built. */
  var THEME_ROOT = '/usr/share/plymouth/themes';

  function emitDescriptor(theme, name) {
    var dir = THEME_ROOT + '/' + name;
    var lines = [
      '[Plymouth Theme]',
      'Name=' + (theme.name || name),
      'Description=' + (theme.description || ''),
      'ModuleName=script',
      '',
      '[script]',
      'ImageDir=' + dir,
      'ScriptFile=' + dir + '/' + name + '.script',
      ''
    ];
    return lines.join('\n');
  }

  /* ----------------------------------------------------------------- naming */

  /* A theme name that is safe as a directory and a filename. Plymouth reads the
     directory name, so this is what the user sees in a theme picker. */
  function themeSlug(theme) {
    var s = String((theme && theme.name) || 'theme')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'theme';
  }

  /* The filename an element's asset takes inside a variant folder.

     A still is `<element>.png`. A sequence is `<element>/<element>-1.png`, and
     the numbered frames are not zero-padded — `startup-1.png`, not
     `startup-0001.png` — because the script finds the count by null-checking
     each slot in turn and there is no benefit to padding. */
  function assetFile(def) {
    return def.id + '.png';
  }

  function frameFile(def, index) {
    return def.id + '/' + def.id + '-' + index + '.png';
  }

  /* -------------------------------------------------------------- the plan */

  /* Every asset the theme wants, and which tiers want it.

     An element only needs its asset in the tiers it is set to show in — an
     element narrowed to 720p and 2160p should not leave two orphaned copies
     behind. */
  function assetPlan(state) {
    var plan = [];
    state.elements.forEach(function (def) {
      /* Backgrounds and text carry no loadable file of their own; the backdrop
         is a window colour, not a sprite. */
      if (def.kind !== 'image' && def.kind !== 'animation') return;
      plan.push({
        id: def.id,
        file: assetFile(def),
        animated: def.kind === 'animation',
        tiers: A.tiersForElement(def),
        /* Whatever the author supplied, if anything. A data URL for an upload,
           or nothing at all, in which case a placeholder is generated. */
        upload: def.upload || null,
        background: def.background || null,
        def: def
      });
    });
    return plan;
  }

  /* The scripts the harness and the writer both need, so the two cannot
     disagree about what the theme is. */
  function scriptAssets(plan) {
    return plan.map(function (a) {
      var n = a.id.replace(/[^A-Za-z0-9_]/g, '_');
      return {
        /* the element it belongs to, so the emitter can find its label, z and
           visibility — without this the sprite block emits a header and nothing */
        id: a.id,
        file: a.file,
        varName: n + '_image',
        wVar: n + '_w',
        hVar: n + '_h'
      };
    });
  }

  /* Everything that will be written, as paths relative to the theme folder.
     `kind` says where the bytes come from:
       'script'      the emitted script
       'descriptor'  the emitted descriptor
       'placeholder' a solid rectangle the generator draws
       'art'         a file the author supplied, to be converted to PNG
       'frames'      a sequence the author supplied, one PNG per frame */
  function planFiles(state) {
    var name = themeSlug(state.theme);
    var plan = assetPlan(state);
    var files = [];

    files.push({ path: name + '.plymouth', kind: 'descriptor', text: emitDescriptor(state.theme, name) });

    var built = S.emitScript(state, scriptAssets(plan));
    files.push({ path: name + '.script', kind: 'script', text: built.text });

    plan.forEach(function (a) {
      /* One copy per tier the element shows in. A supplied file is filed in the
         single tier that needs the least scaling; placeholders are made for
         every tier, because the generator knows each tier's exact size. */
      var targets = {};
      a.tiers.forEach(function (tierId) {
        var r = M.resolveTier(state, tierId).elements[a.id];
        targets[tierId] = { width: r ? r.w : 0, height: r ? r.h : 0 };
      });

      if (a.upload) {
        /* One copy, filed at generation time. Which folder it goes in depends on
           how big the author's art actually is, and that is only known once it
           has been decoded — so the plan states the targets and the generator
           decides. */
        files.push({
          path: null,
          kind: 'art',
          id: a.id,
          file: a.file,
          tiers: a.tiers,
          targets: targets,
          colour: a.background,
          upload: a.upload,
          animated: a.animated,
          /* A size written as a lone number is a 720p measurement, so the
             generator can resize the file to fit it exactly. A size that
             depends on the screen cannot be known here, so the file is stored
             at its nearest tier and the theme scales it at run time. */
          resize: M.isPlainNumber(a.def.w) && M.isPlainNumber(a.def.h)
        });
      } else {
        a.tiers.forEach(function (tierId) {
          files.push({
            path: 'assets/' + tierId + '/' + a.file,
            kind: 'placeholder',
            tier: tierId,
            width: Math.max(1, Math.round(targets[tierId].width || 1)),
            height: Math.max(1, Math.round(targets[tierId].height || 1)),
            colour: a.background,
            animated: a.animated
          });
        });
      }
    });

    return {
      name: name,
      files: files,
      errors: built.errors,
      overrides: built.overrides,
      plan: plan,
      text: built.text
    };
  }

  root.PlymTheme = {
    THEME_ROOT: THEME_ROOT,
    emitDescriptor: emitDescriptor,
    themeSlug: themeSlug,
    assetFile: assetFile,
    frameFile: frameFile,
    assetPlan: assetPlan,
    scriptAssets: scriptAssets,
    planFiles: planFiles
  };
})(typeof window !== 'undefined' ? window : globalThis);
