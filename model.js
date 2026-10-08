/* ============================================================================
   Plymouth Theme Generator — theme model + resolver
   ----------------------------------------------------------------------------
   Every element, size, padding and placement rule in this file is a direct
   transcription of layout.html (line references in each `notes`). Nothing here
   is invented: the sizes are the 720p tier from the CSS custom properties, and
   the placement expressions are layout.html's `left`/`top` rules converted to
   top-left x/y pixels.

   Coordinate contract used everywhere in this app
     - x, y            offset of the element's TOP-LEFT corner from the screen's
                       top-left, in pixels, for one specific tier.
     - w, h            element size in pixels for one specific tier.
     - numeric strings are 720p base values and are multiplied by the tier
                       scale (720p x1, 1080p x1.5, 1440p x2, 2160p x3).
     - any other string is an expression evaluated at the tier's real pixel
                       dimensions, so `50vw` means half of *that* tier's width.
     - per-tier `overrides` are absolute pixels for that tier (never scaled).

   layout.html anchors elements with left/top/right/bottom + margins. This file
   normalises every one of them to top-left x/y, e.g.
     #secure-boot  right:0; margin-right:pad-h1   ->  x = 100vw - secure-boot.w - pad-h1
     #status       bottom:pad-v2 - status-h       ->  y = 100vh - pad-v2
   ========================================================================= */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------- tiers */

  /* Scale factors are the ones the template already uses: every size comment in
     layout.html:9-131 lists four values in a clean 1 / 1.5 / 2 / 3 progression. */
  var TIERS = [
    { id: '720p',  label: '720p',  width: 1280, height: 720,  scale: 1 },
    { id: '1080p', label: '1080p', width: 1920, height: 1080, scale: 1.5 },
    { id: '1440p', label: '1440p', width: 2560, height: 1440, scale: 2 },
    { id: '2160p', label: '2160p', width: 3840, height: 2160, scale: 3 }
  ];

  /* A live-view shape: the same tier re-measured to an arbitrary box, so a
     different aspect ratio can be previewed without inventing a new tier.
     Bare numbers in the layout are 720p measurements, so the scale follows the
     height (720p x1, 1080p x1.5, 1440p x2, 2160p x3 all equal height / 720). */
  function shapeTier(base, width, height) {
    return {
      id: base.id,
      label: base.label,
      width: width,
      height: height,
      scale: height / 720,
      shaped: true,
      native: { width: base.width, height: base.height }
    };
  }

  /* ---------------------------------------------------------------- modes */

  /* config.yaml:22-624 — the seven modes the theme declares. `help` says when
     Plymouth enters each one, for someone meeting the terminology cold. */
  var MODES = [
    { id: 'boot', label: 'Boot', short: 'Boot',
      help: 'The startup screen: on display from the moment the kernel hands over to Plymouth until the login prompt or desktop appears.' },
    { id: 'shutdown', label: 'Shutdown', short: 'Down',
      help: 'Shown while the machine is powering off, after the user has asked it to shut down. Plymouth reuses the same theme here, minus the extras that only make sense at startup.' },
    { id: 'reboot', label: 'Reboot', short: 'Reboot',
      help: 'Shown while the machine restarts. Plymouth cannot tell a reboot from a shutdown, so the two normally share the same art.' },
    { id: 'updates', label: 'Updates', short: 'Updates',
      help: 'Shown when the system is applying offline updates during startup, before the desktop comes up.' },
    { id: 'system-upgrade', label: 'System Upgrade', short: 'SysUp',
      help: 'Shown when the operating system itself is being upgraded to a new release.' },
    { id: 'firmware-upgrade', label: 'Firmware Upgrade', short: 'FwUp',
      help: 'Shown while the firmware (BIOS or UEFI) is being updated. The screen is deliberately kept simple, because the machine must not be interrupted.' },
    { id: 'system-reset', label: 'System Reset', short: 'Reset',
      help: 'Shown when the system is being reset back to its factory state.' }
  ];

  /* -------------------------------------------------------------- paddings */

  /* layout.html:133-139. These are shared, editable terms in the placement
     math: pad-v4 is derived from entry.w and bullet.w, so editing either of
     those on the canvas moves every element whose position uses pad-v4. */
  var PADDINGS = [
    { id: 'pad-h1', expr: '100vmax / 50',
      note: 'Horizontal padding 1 — one fiftieth of the longer screen edge (layout.html:134).' },
    { id: 'pad-v1', expr: '100vmin / 40',
      note: 'Vertical padding 1 — one fortieth of the shorter screen edge (layout.html:135).' },
    { id: 'pad-v2', expr: '100vh / 6',
      note: 'Vertical padding 2 — status line baseline offset (layout.html:136).' },
    { id: 'pad-v3', expr: '100vh / 30',
      note: 'Vertical padding 3 — gap between progress and status (layout.html:137).' },
    { id: 'pad-v4', expr: '(entry.w - (bullet.w * 12)) / 2',
      note: 'Bullet safe-zone padding inside the entry, derived from entry.w and bullet.w (layout.html:138). Defaults to 6px at 720p.' }
  ];

  /* -------------------------------------------------------------- elements */

  /* Ordered front-to-back by the template's own document order (layout.html:676-714).
     kind:      image | animation | text | background
     z:         layout.html z-index
     asset:     which file Plymouth will look for (layout.html:143-153)
     fixedSize: true when the size is not the user's to set (background, corner-image,
                end-animation derive theirs from another element) */
  var ELEMENTS = [
    {
      id: 'firmware-background', label: 'Firmware Background', kind: 'background', z: 0,
      enabled: true,
      w: '100vw', h: '100vh', x: '0', y: '0',
      asset: 'bgrt-fallback.png, or the firmware BGRT image at /sys/firmware/acpi/bgrt/image',
      notes: 'The screen the firmware drew before Plymouth. Full-bleed and behind everything (layout.html:165-180). This background colour is the theme background colour.'
    },
    {
      id: 'background', label: 'Background', kind: 'background', z: 1,
      enabled: true,
      w: '100vw', h: '100vh', x: '0', y: '0',
      asset: 'background.png (else the CSS background colour is used)',
      /* A theme always has a background, so it is the one element the editor
         will not let you move, resize, hide, restrict to a mode, restack or
         delete. Its colour is still editable — layout.html:191 says this
         background colour IS the theme's background colour. */
      locked: true,
      notes: 'Full screen fill at every tier (layout.html:182-196). Always the full screen — no size of its own.'
    },
    {
      id: 'header', label: 'Header', kind: 'animation', z: 1,
      enabled: true,
      w: '720', h: '150', x: '50vw - (header.w / 2)', y: '0',
      asset: 'header.png / header-*.png',
      notes: 'Centred horizontally, at the very top of the screen (layout.html:198-210).'
    },
    {
      id: 'corner-image', label: 'Corner Image', kind: 'image', z: 22,
      enabled: true,
      w: 'secure-boot.w', h: 'secure-boot.h', x: 'pad-h1', y: '100vh - corner-image.h - pad-v1',
      asset: 'corner-image.png',
      notes: 'Bottom-left corner including padding, mirroring secure-boot (layout.html:627-639). Size follows secure-boot.'
    },
    {
      id: 'main', label: 'Main', kind: 'animation', z: 1,
      enabled: true,
      w: '300', h: '300', x: '50vw - (main.w / 2)', y: '50vh - (main.h / 2)',
      asset: 'startup/startup-N.png (frames counted from the folder)',
      notes: 'Startup and shutdown animation or image, always centred (layout.html:212-226).'
    },
    {
      id: 'end-animation', label: 'End Animation', kind: 'animation', z: 2,
      enabled: true,
      w: 'main.w', h: 'main.h', x: '50vw - (main.w / 2)', y: '50vh - (main.h / 2)',
      asset: 'startup-animation-N.png',
      notes: 'Played once the boot passes its show-animation fraction (layout.html:228-242). Always the same size and spot as main.'
    },
    {
      id: 'title', label: 'Title', kind: 'text', z: 2,
      enabled: true,
      w: '600', h: '60',
      x: '50vw - (title.w / 2)',
      y: '50vh - (main.h / 2) - subtitle.h - title.h - pad-h1',
      text: 'Template Title', font: { family: 'Sans, Arial, sans-serif', size: '32', color: '#ffffff' },
      notes: 'Centred horizontally, above the main asset (layout.html:357-378). Text, never an asset.'
    },
    {
      id: 'subtitle', label: 'SubTitle', kind: 'text', z: 2,
      enabled: true,
      w: '600', h: '40',
      x: '50vw - (subtitle.w / 2)',
      y: '50vh - (main.h / 2) - subtitle.h - pad-h1',
      text: 'Template SubTitle', font: { family: 'Sans, Arial, sans-serif', size: '22', color: '#ffffff' },
      notes: 'Centred horizontally, directly below the title (layout.html:380-399). Text, never an asset.'
    },
    {
      id: 'watermark', label: 'Watermark', kind: 'image', z: 1,
      enabled: true,
      w: '200', h: '50', x: 'pad-h1', y: 'pad-v1',
      asset: 'watermark.png',
      notes: 'Top-left corner including padding (layout.html:244-258).'
    },
    {
      id: 'spinner', label: 'Spinner', kind: 'animation', z: 1,
      enabled: true,
      w: '50', h: '50',
      x: 'pad-h1 + watermark.w + pad-h1', y: 'pad-v1',
      asset: 'spinner/spinner-N.png',
      notes: 'Top-left, to the right of the watermark. If the watermark is disabled the margin-left should be only pad-h1 (layout.html:260-276) — milestone 2 generator logic.'
    },
    {
      id: 'secure-boot', label: 'Secure Boot', kind: 'image', z: 1,
      enabled: true,
      w: '50', h: '50',
      x: '100vw - secure-boot.w - pad-h1', y: '100vh - secure-boot.h - pad-v1',
      asset: 'insecure-boot.png',
      notes: 'Bottom-right corner including padding (layout.html:278-292). config.yaml enables this in boot only.'
    },
    {
      id: 'status', label: 'Status', kind: 'text', z: 1,
      enabled: true,
      w: '100vw', h: '50', x: '50vw - (status.w / 2)', y: '100vh - pad-v2',
      text: 'Status', font: { family: 'Sans, Arial, sans-serif', size: '22', color: '#ffffff' },
      background: '#000000',
      notes: 'Boot status line at the bottom, above pad-v2 (layout.html:294-315). Text, never an asset; nothing renders until a status string arrives.'
    },
    {
      id: 'message', label: 'Message', kind: 'text', z: 2,
      enabled: true,
      w: '400', h: '40',
      x: '50vw - (message.w / 2)',
      y: '50vh + (main.h / 2) + (pad-v1 / 2)',
      text: 'Message', font: { family: 'Sans, Arial, sans-serif', size: '22', color: '#ffffff' },
      notes: 'Transient text, centred below the main asset (layout.html:333-355). Distinct from status.'
    },
    {
      id: 'console', label: 'Console', kind: 'text', z: 200,
      enabled: true,
      w: '100vw', h: '400', x: '0', y: '100vh - console.h',
      text: 'Console', font: { family: 'monospace, monospace', size: '18', color: '#cccccc' },
      background: '#000000',
      notes: 'Full screen width, anchored to the bottom (layout.html:401-417).'
    },
    {
      id: 'dialog', label: 'Dialog', kind: 'image', z: 2,
      enabled: true,
      w: '500', h: '175',
      x: '50vw - (dialog.w / 2)',
      y: '50vh + (main.h / 2) - dialog.h',
      asset: 'dialog.png',
      notes: 'Centred horizontally, bottom edge shared with main (layout.html:419-431). Falls back to a grey rectangle.'
    },
    {
      id: 'prompt', label: 'Prompt', kind: 'text', z: 99,
      enabled: true,
      w: '500', h: '30',
      x: '50vw - (prompt.w / 2)',
      y: '50vh + (main.h / 2) - (dialog.h / 2) - (prompt.h / 2)',
      text: 'Template Example Prompt:', font: { family: 'Sans, Arial, sans-serif', size: '22', color: '#ffffff' },
      notes: 'Centred horizontally (layout.html:524-545). Several positions are built from prompt.h, so set h to 0 when the element is unused.'
    },
    {
      id: 'lock', label: 'Lock', kind: 'image', z: 3,
      enabled: true,
      w: '420', h: '50',
      x: '50vw - (lock.w / 2)',
      y: '50vh + (main.h / 2) - lock.h - (dialog.h / 2) - (dialog.h / 25) - (prompt.h / 3)',
      asset: 'lock.png',
      notes: 'Upper middle part of the dialog (layout.html:433-445).'
    },
    {
      id: 'entry', label: 'Entry', kind: 'image', z: 3,
      enabled: true,
      w: '420', h: '50',
      x: '50vw - (entry.w / 2)',
      y: '50vh + (main.h / 2) - (dialog.h / 2) + (dialog.h / 25) + (prompt.h / 3)',
      asset: 'entry.png',
      notes: 'Lower middle part of the dialog (layout.html:447-458). Falls back to a black rectangle.'
    },
    {
      id: 'capslock', label: 'Caps Lock', kind: 'image', z: 3,
      enabled: true,
      w: '25', h: '25',
      x: '50vw - capslock.w - (entry.w / 2) - pad-v4',
      y: '50vh + (main.h / 2) - (dialog.h / 2) + (dialog.h / 25) + (bullet.h / 2) - (capslock.h / 2) + (prompt.h / 3)',
      asset: 'capslock.png',
      notes: 'Left of the entry plus the bullet safety padding, vertically centred on the entry (layout.html:482-494).'
    },
    {
      id: 'keyboard', label: 'Keyboard', kind: 'image', z: 3,
      enabled: true,
      w: '25', h: '25',
      x: '50vw - capslock.w + (entry.w / 2) + pad-v4 + keyboard.w',
      y: '50vh + (main.h / 2) - (dialog.h / 2) + (dialog.h / 25) + (bullet.h / 2) + (prompt.h / 3)',
      asset: 'keyboard.png',
      notes: 'Right of the entry plus the bullet safety padding, vertically centred on the entry with keymap (layout.html:496-508).'
    },
    {
      id: 'keymap', label: 'Keymap', kind: 'image', z: 3,
      enabled: true,
      w: '25', h: '25',
      x: '50vw - capslock.w + (entry.w / 2) + pad-v4 + keymap.w',
      y: '50vh + (main.h / 2) - (dialog.h / 2) + (dialog.h / 25) + (bullet.h / 2) - keymap.h + (prompt.h / 3)',
      asset: 'keymap.png',
      notes: 'Right of the entry, vertically centred on the entry with keyboard (layout.html:510-522).'
    },
    {
      /* The zone and the bullet are two things, as layout.html has them:
         `#bullet` is the area (layout.html:460-473) and `#bullet span` is one
         dot (layout.html:475-481). Merged, a single row carried both the area's
         size and one bullet's size, and the generator drew one dot where the
         row should be. */
      id: 'bullet-zone', label: 'Bullet Safe Zone', kind: 'text', z: 100,
      enabled: true,
      /* 12 bullets plus pad-v4 on each side, which lands exactly on entry.w.
         layout.html declares the width as bullet.w * 12, one pad-v4 short of
         the entry; the expression below makes the row fill the entry. */
      w: 'bullet.w * 12 + pad-v4 * 2', h: 'bullet.h',
      x: '50vw - (entry.w / 2)',
      y: '50vh + (main.h / 2) - (dialog.h / 2) + (dialog.h / 25) + (prompt.h / 3)',
      padding: { left: 'pad-v4', right: 'pad-v4' },
      bullets: 12,
      /* The sample the live view turns into bullets — one dot per character.
         Plymouth replaces it at run time with however many the user typed. */
      text: 'password',
      notes: 'The safe zone holding up to 12 bullets, inside the entry plus pad-v4 padding on each side (layout.html:460-473). Draws the row; each dot comes from the bullet below.'
    },

    {
      id: 'bullet', label: 'Bullet', kind: 'image', z: 101,
      enabled: true,
      w: '34', h: '50',
      /* The first slot in the zone, so the dot's own size is visible at the size
         it is actually drawn — the other eleven follow it. */
      x: 'bullet-zone.x + pad-v4',
      y: 'bullet-zone.y',
      asset: 'bullet.png',
      /* The zone names the count, so the repeat is not written twice: this dot
         is drawn once per slot the zone holds. */
      repeatsIn: 'bullet-zone',
      notes: 'One bullet: the mask for a single typed password character, repeated across the safe zone above (layout.html:475-481).'
    },
    {
      id: 'entry-question', label: 'Entry Question', kind: 'image', z: 3,
      enabled: true,
      w: '420', h: '50',
      x: '50vw - (entry-question.w / 2)',
      y: '50vh + (main.h / 2) - (dialog.h / 2)',
      asset: 'entry-question.png',
      notes: 'Centred horizontally, on the entry row (layout.html:569-580). Question state replaces the password entry.'
    },
    {
      id: 'prompt-question', label: 'Prompt Question', kind: 'text', z: 99,
      enabled: true,
      w: '500', h: '30',
      x: '50vw - (prompt-question.w / 2)',
      y: '50vh + (main.h / 2) - dialog.h + (dialog.h / 6)',
      text: 'Template Question Prompt:', font: { family: 'Sans, Arial, sans-serif', size: '22', color: '#ffffff' },
      notes: 'Centred horizontally above the entry (layout.html:582-602).'
    },
    {
      id: 'entry-text', label: 'Entry Text', kind: 'text', z: 101,
      enabled: true,
      w: '420', h: '50',
      x: '50vw - (entry.w / 2)',
      y: '50vh + (main.h / 2) - (dialog.h / 2)',
      text: 'Entry Text', font: { family: 'Sans, Arial, sans-serif', size: '22', color: '#ffffff' },
      padding: { left: 'pad-v4', right: 'pad-v4' },
      notes: 'Same spot as the entry asset / bullet safe zone, aligns typed text with the bullets (layout.html:547-567).'
    },
    {
      id: 'progress', label: 'Progress', kind: 'animation', z: 1,
      enabled: true,
      w: '400', h: '25',
      x: '50vw - (progress.w / 2)',
      y: '100vh - progress.h - pad-v2 - status.h + pad-v3',
      asset: 'progress/progress-N.png (frame chosen from the boot fraction)',
      notes: 'Centred horizontally, above the status line (layout.html:317-330). Not on the frame clock: N frames map to N evenly spaced steps 0-100%.'
    },
    {
      id: 'progress-percent', label: 'Progress Percent', kind: 'text', z: 2,
      enabled: true,
      w: '200', h: '40',
      x: '50vw - (progress-percent.w / 2)',
      y: '100vh - progress-percent.h - pad-v2 - status.h + pad-v3 - progress.h',
      text: 'Progress Percent', font: { family: 'Sans, Arial, sans-serif', size: '16', color: '#ffffff' },
      notes: 'The "NN% complete" readout, centred just above the progress asset (layout.html:604-625).'
    }
  ];

  /* ---------------------------------------------------------------- help */
  /* Plain-language explanation of every asset, written for someone who has
     never built a Plymouth theme: what it is, how Plymouth uses it, and when it
     appears. Kept out of ELEMENTS so the geometry stays readable. */

  var HELP = {
    'firmware-background':
      'The picture the firmware (UEFI/BIOS) already put on the screen before the operating system started — usually the PC maker\'s logo. Plymouth can reuse that exact image, or fall back to its own bgrt-fallback.png. It is the very first thing on screen and sits behind everything else. If neither image exists, the theme\'s background colour is used instead. Present in every mode, for the whole time the screen is up.',
    'background':
      'The theme\'s own base layer: a full-screen picture if you supply one, otherwise a flat colour. It fills the whole screen at every resolution and sits behind every other element. The colour you pick here is also the colour Plymouth falls back to when no background image is supplied. Always present, in every mode.',
    'header':
      'A wide banner across the top of the screen — normally a distribution or vendor wordmark. It can be a single still image or an animation (supply a numbered sequence of frames and Plymouth plays them in a loop). Shows for the whole of the boot and shutdown screens.',
    'corner-image':
      'A small picture tucked into the bottom-left corner, used by upstream themes for a distribution badge. Entirely optional — leave it out and nothing is drawn. It mirrors the secure-boot badge, which sits in the opposite corner.',
    'main':
      'The centrepiece: a picture or animation in the middle of the screen. Plymouth plays it on a loop for the whole time the system is booting, and again while it is shutting down. One frame gives you a static image; a numbered sequence gives you an animation.',
    'end-animation':
      'A second animation that takes over once the boot is nearly finished. Plymouth switches to it after the boot passes its show-animation fraction, so you can give the end of the boot different art from the main loop — a finishing flourish instead of the looping idle.',
    'title':
      'The large line of text sitting above the main image, normally the operating system\'s name. Plymouth draws it as real text, so the theme supplies a font, a size and a colour rather than an image.',
    'subtitle':
      'The smaller second line of text under the title — typically a version number or a short phrase. Drawn as text, like the title.',
    'watermark':
      'A small logo in the top-left corner, usually the distribution or hardware maker. Static: it never moves or animates.',
    'spinner':
      'The small looping "busy" animation next to the watermark in the top-left, the equivalent of a spinner on a web page. It reassures the user that work is still happening while the boot is slow. It advances one frame per tick, so the loop length is the frame count divided by the theme\'s refresh rate.',
    'secure-boot':
      'The indicator shown in the bottom-right corner when the machine has Secure Boot switched on. Confusingly, its file is named insecure-boot.png, but it marks Secure Boot being enabled. Only used on the boot screen — the other modes leave it out.',
    'status':
      'The running line of boot text Plymouth supplies, such as "Starting Disk Manager". It is not an image: Plymouth fills in the words, and the theme only decides the font, size, colour and position. It sits at the bottom of the screen and nothing appears until a status message actually arrives.',
    'message':
      'A short, transient message Plymouth is told to display, such as "Checking for updates…". It appears, gets replaced by the next one, and can be hidden again. That makes it different from status, which is the single ongoing boot line.',
    'console':
      'The area at the bottom of the screen where raw kernel and service output scrolls, shown when the user asks for detailed boot logging (pressing Esc, for example). It is text, not an image, and it is normally hidden.',
    'dialog':
      'The panel that sits behind a password or question prompt. If you do not supply an image, Plymouth draws a plain grey rectangle. It is centred, and its bottom edge lines up with the bottom of the main image.',
    'prompt':
      'The line of text inside a password dialog that asks for input, such as "Password:". It is text, never an image. Several other elements measure their positions from this element\'s height, so if you are not using it, set its height to 0.',
    'lock':
      'The padlock icon in the upper part of the password dialog — the visual cue that Plymouth is asking for a password rather than for some other kind of input. Static, and drawn only in the password-entry state.',
    'entry':
      'The input field where the password is typed. If you do not supply an image, Plymouth draws a black rectangle. It sits in the lower part of the dialog.',
    'capslock':
      'A small warning icon to the left of the password field, shown while Caps Lock is on — the usual cause of a rejected password.',
    'keyboard':
      'A small keyboard icon to the right of the password field, shown when the current keyboard layout should be indicated.',
    'keymap':
      'A short label beside the keyboard icon naming the active keyboard layout, such as "us".',
    'bullet-zone':
      'The area the password dots occupy: a run inside the input field, inset on each side so the dots never touch its edges. It holds up to twelve bullets and draws the row; each dot is its own element. Nothing appears here until the user types.',
    'bullet':
      'One bullet: the mask for a single typed password character. Sized once and repeated across the safe zone. If you do not supply an image, Plymouth draws white rectangles.',
    'entry-question':
      'The input field used instead of the password field when Plymouth asks a question rather than for a password — a passphrase or confirmation prompt, where what you type is shown rather than masked.',
    'prompt-question':
      'The line of text that asks that question, such as "Enter passphrase:". Drawn as text, like the ordinary prompt.',
    'entry-text':
      'The characters the user has typed, drawn on top of the input field. This is the question-mode counterpart of the bullet row: here the text is visible instead of masked.',
    'progress':
      'The progress bar near the bottom of the screen. It is the one animation not on the frame clock: Plymouth picks a frame from how far the boot has actually got, so N frames become N evenly spaced steps from 0% to 100%. It advances when the boot advances and sits still when the boot sits still.',
    'progress-percent':
      'The "42% complete" readout shown just above the progress bar, used when the mode asks Plymouth for percent-complete text.'
  };

  /* The most frames a numbered sequence may have.

     The script language has no string concatenation — its string library is
     CharAt, Length and SubString only — so a frame path cannot be built at run
     time. Every probe is therefore a literal path, and the whole sequence is
     written out. That is what makes frames droppable after generation: the
     theme finds however many are actually there, up to this ceiling.

     The cost is real and worth stating: one animated element costs roughly
     MAX_FRAMES x (tiers it shows in) lines to load, plus MAX_FRAMES to step
     through. At 240 and four tiers that is about 1200 lines per animated
     element. Raise it if you need longer sequences; the ceiling exists only
     because the language cannot count them itself. */
  var MAX_FRAMES = 240;

  /* Every mode Plymouth can start a splash in. */
  var ALL_MODE_IDS = MODES.map(function (m) { return m.id; });

  /* Plymouth brings the splash up for two quite different reasons: while it is
     starting the system, or while it is taking the system down. Five of the
     seven modes are the former. */
  var STARTUP_MODE_IDS = ['boot', 'updates', 'system-upgrade', 'firmware-upgrade', 'system-reset'];

  /* Which modes each element can actually appear in.

     Plymouth starts the same theme in all seven modes, and hands the theme the
     mode name — the script plugin's `Plymouth.GetMode()` returns exactly the
     seven strings above, switching on ply_boot_splash_mode_t. So the split below
     is this theme's decision, not a Plymouth rule: the mode is available, and
     what a theme draws with it is up to the theme.

     Two groups are narrowed, because the mechanism behind them only runs one way:

       - Plymouth's password and question displays are driven by explicit
         requests over the boot protocol, and nothing sends those while the
         system is going down; they come from the startup path unlocking
         encrypted volumes. So the whole prompt group is startup-only in
         practice. The protocol itself is not mode-gated — this is about who
         asks and when, not about Plymouth refusing.

       - `secure-boot` reports how the system was started, which is meaningless
         once it is being stopped.

     Everything else — the backgrounds, header, main animation and its ending,
     watermark, spinner, title, subtitle, status line, messages, console and
     progress — is theme chrome, and a theme is free to draw it in any mode. */
  var ELEMENT_MODES = {
    'secure-boot': ['boot'],

    'dialog': STARTUP_MODE_IDS,
    'prompt': STARTUP_MODE_IDS,
    'lock': STARTUP_MODE_IDS,
    'entry': STARTUP_MODE_IDS,
    'capslock': STARTUP_MODE_IDS,
    'keyboard': STARTUP_MODE_IDS,
    'keymap': STARTUP_MODE_IDS,
    'bullet': STARTUP_MODE_IDS,
    'bullet-zone': STARTUP_MODE_IDS,
    'entry-question': STARTUP_MODE_IDS,
    'prompt-question': STARTUP_MODE_IDS,
    'entry-text': STARTUP_MODE_IDS
  };

  /* The order a theme author is most likely to touch, most first. It drives the
     add-element menu and the element list, and it is deliberately separate from
     the ELEMENTS declaration order: the canvas paints in declaration order and
     settles equal z-indexes by it, so moving `background` here must not move it
     over the z=1 elements it sits behind. */
  var ELEMENT_ORDER = [
    /* the things a theme is actually judged on */
    'main', 'header', 'corner-image', 'title', 'subtitle', 'watermark',
    /* motion and progress */
    'end-animation', 'spinner', 'progress', 'progress-percent',
    /* transient messages */
    'message',
    /* the password prompt, panel first */
    'dialog', 'lock', 'prompt', 'entry', 'bullet-zone', 'bullet', 'capslock', 'keyboard', 'keymap',
    /* the question prompt */
    'entry-text', 'entry-question', 'prompt-question',
    /* rarely themed at all */
    'console', 'status', 'secure-boot',
    /* backdrops, always last, firmware first */
    'firmware-background', 'background'
  ];

  /* Elements Plymouth raises and lowers itself rather than the mode deciding.
     They are defined and positioned like anything else, but nothing puts them on
     screen except a callback: a password or question prompt, the status line a
     client sets with `plymouth update --status=`, or the user toggling the
     console with Esc. The generated script therefore creates them hidden and
     lets the callbacks show them. */
  var ON_DEMAND = [
    'dialog', 'prompt', 'lock', 'entry', 'capslock', 'keyboard', 'keymap',
    'bullet-zone', 'bullet',
    'entry-question', 'prompt-question', 'entry-text',
    'console', 'status', 'message'
  ];

  /* The on-demand elements as groups, because that is how they are designed:
     you work on the password dialog, not on eleven separate sprites. `dialog` is
     in both entry states because it is the panel behind either of them. */
  var DEMAND_GROUPS = [
    {
      id: 'password',
      label: 'Password dialog',
      help: 'The panel, the prompt, the lock, the entry field, the bullets and the keyboard indicators',
      elements: ['dialog', 'prompt', 'lock', 'entry', 'bullet-zone', 'bullet', 'capslock', 'keyboard', 'keymap']
    },
    {
      id: 'question',
      label: 'Question dialog',
      help: 'The shared panel and the typed-answer state that replaces the password one',
      elements: ['dialog', 'entry-question', 'prompt-question', 'entry-text']
    },
    {
      id: 'status',
      label: 'Status line',
      help: 'The one running boot line, set by a client with `plymouth update --status=`',
      elements: ['status']
    },
    {
      id: 'messages',
      label: 'Messages',
      help: 'Short notices a client pushes with `plymouth display-message` — disk checks and the like. Each replaces the last, and can be hidden again, so the box is empty at boot',
      elements: ['message']
    },
    {
      id: 'console',
      label: 'Console',
      help: 'The verbose log, toggled with Esc. It covers the whole screen, so showing it hides everything behind it',
      elements: ['console']
    }
  ];

  ELEMENTS.forEach(function (def) {
    def.help = HELP[def.id] || '';
    def.onDemand = ON_DEMAND.indexOf(def.id) > -1;
    def.demandGroups = DEMAND_GROUPS.filter(function (g) {
      return g.elements.indexOf(def.id) > -1;
    }).map(function (g) { return g.id; });
    /* the modes this element supports, and the default of showing in all of them */
    def.modes = (ELEMENT_MODES[def.id] || ALL_MODE_IDS).slice();
    def.showIn = def.modes.slice();
    /* Which of the four screen sizes it appears in. Unlike modes there is no
       per-element set of supported sizes — every element is laid out at all four,
       so all four are offered. */
    def.showInTiers = TIERS.map(function (t) { return t.id; });
    /* The template element this came from. A name can be renamed, so the name is
       not a usable identity; the order above is keyed on this instead. */
    def.origin = def.id;
  });

  /* ------------------------------------------------------------- preview art */

  /* layout.html's debug colours, so the canvas looks like the template. */
  var PREVIEW_COLORS = {
    'firmware-background': '#202020',
    'background': '#000000',
    'header': 'darkcyan',
    'corner-image': 'green',
    'main': 'indigo',
    'end-animation': '#552255',
    'watermark': 'lightblue',
    'spinner': 'blue',
    'secure-boot': 'coral',
    'status': '#000000',
    'message': null,
    'console': '#000000',
    'dialog': 'dimgray',
    'prompt': null,
    'lock': 'cyan',
    'entry': '#000000',
    'capslock': 'gold',
    'keyboard': 'brown',
    'keymap': 'silver',
    'bullet-zone': '#ffffff',
    'bullet': '#ffffff',
    'entry-question': '#2a2a2a',
    'prompt-question': null,
    'entry-text': null,
    'progress': '#303030',
    'progress-percent': null
  };

  var THEME = {
    name: 'template',
    description: 'Template theme.',
    refresh_rate: 30
  };

  /* --------------------------------------------------------------- helpers */

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  var PLAIN_NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

  function isPlainNumber(text) {
    return PLAIN_NUMBER_RE.test(String(text).trim());
  }

  function defaultState() {
    var elements = ELEMENTS.map(function (src) {
      var def = clone(src);
      if (def.font) def.font = clone(def.font);
      if (def.container) def.container = clone(def.container);
      def.background = PREVIEW_COLORS[def.id] === undefined ? null : PREVIEW_COLORS[def.id];
      def.overrides = {};
      /* No file of its own until one is chosen. Present as null rather than
         absent, so "the theme's own asset" is a state and not a missing key. */
      def.upload = null;
      return def;
    });

    return {
      format: 'plymouth-theme-generator',
      version: 1,
      theme: clone(THEME),
      tier: '720p',
      /* null = the tier's native shape. Set to { width, height } to preview a
         different aspect ratio live without leaving the tier. */
      viewport: null,
      previewMode: 'all',
      onlyShown: false,
      /* The elements Plymouth calls when they are wanted, and which groups of
         them to draw. Both entry states and the status line by default; the
         console is left out because it covers the whole screen. */
      showOnDemandAll: false,
      demandPick: [],
      zoom: 'fit',
      paddings: PADDINGS.map(function (p) { return { id: p.id, expr: p.expr, note: p.note }; }),
      elements: elements
    };
  }

  /* ---------------------------------------------------------------- resolve */

  /* Resolves every padding and every element to pixels for one tier.
     Dependencies between names (`pad-v4` -> `entry.w` -> ...) are followed with
     memoisation, and circular references are reported instead of hanging. */
  function resolveAll(state, tier) {
    var elements = state.elements;
    var paddings = state.paddings || [];
    var byId = Object.create(null);
    elements.forEach(function (e) { byId[e.id] = e; });

    var W = tier.width;
    var H = tier.height;
    var scale = tier.scale;

    /* Known names, longest first, so the tokenizer can split hyphenated and
       dotted identifiers without whitespace. */
    var names = ['vmin', 'vmax', 'vw', 'vh', 'W', 'H', 'scale'];
    paddings.forEach(function (p) { names.push(p.id); });
    elements.forEach(function (e) {
      names.push(e.id + '.w', e.id + '.h', e.id + '.x', e.id + '.y');
    });
    names.sort(function (a, b) { return b.length - a.length; });

    var memo = Object.create(null);
    var resolving = Object.create(null);
    var parseCache = Object.create(null);

    function compile(src) {
      if (!(src in parseCache)) parseCache[src] = root.PlymExpr.compile(src, names);
      return parseCache[src];
    }

    function evalExpr(src) {
      var text = String(src === undefined || src === null ? '' : src).trim();
      if (text === '') return 0;
      return root.PlymExpr.evaluate(compile(text), get);
    }

    /* Base value: a bare number is a 720p measurement and scales with the tier. */
    function baseValue(raw) {
      var text = String(raw === undefined || raw === null ? '' : raw).trim();
      if (text === '') return 0;
      if (isPlainNumber(text)) return parseFloat(text) * scale;
      return evalExpr(text);
    }

    /* Override value: a bare number is already the absolute pixel for this tier. */
    function overrideValue(raw) {
      var text = String(raw === undefined || raw === null ? '' : raw).trim();
      if (text === '') return 0;
      if (isPlainNumber(text)) return parseFloat(text);
      return evalExpr(text);
    }

    function get(name) {
      if (name in memo) return memo[name];
      if (resolving[name]) throw new Error('Circular reference: ' + name);
      resolving[name] = true;
      var value;
      try {
        value = compute(name);
      } finally {
        delete resolving[name];
      }
      memo[name] = value;
      return value;
    }

    /* vw/vh/vmin/vmax are true CSS units: 1vw is one percent of the width, so
       `100vmax` is the longer screen edge and `50vw` is half the width — exactly
       how layout.html writes its calc() rules. W/H are the full pixel dimensions. */
    function compute(name) {
      switch (name) {
        case 'vw': return W / 100;
        case 'vh': return H / 100;
        case 'vmin': return Math.min(W, H) / 100;
        case 'vmax': return Math.max(W, H) / 100;
        case 'W': return W;
        case 'H': return H;
        case 'scale': return scale;
      }

      for (var i = 0; i < paddings.length; i += 1) {
        if (paddings[i].id === name) return evalExpr(paddings[i].expr);
      }

      var dot = name.lastIndexOf('.');
      if (dot > 0) {
        var id = name.slice(0, dot);
        var prop = name.slice(dot + 1);
        var def = byId[id];
        if (!def) throw new Error('Unknown element "' + id + '"');
        return elementProp(def, prop);
      }

      throw new Error('Unknown name "' + name + '"');
    }

    function elementProp(def, prop) {
      var override = def.overrides && def.overrides[tier.id];
      if (override && override[prop] !== undefined && override[prop] !== '') {
        return overrideValue(override[prop]);
      }
      return baseValue(def[prop]);
    }

    var out = {
      tier: tier,
      scale: scale,
      W: W,
      H: H,
      vmin: Math.min(W, H),
      vmax: Math.max(W, H),
      paddings: {},
      elements: {},
      errors: {}
    };

    paddings.forEach(function (p) {
      try {
        out.paddings[p.id] = { expr: p.expr, value: get(p.id), error: null };
      } catch (err) {
        out.paddings[p.id] = { expr: p.expr, value: NaN, error: err.message };
        out.errors['pad:' + p.id] = err.message;
      }
    });

    elements.forEach(function (def) {
      var entry = { id: def.id, overridden: {}, error: null };
      ['x', 'y', 'w', 'h'].forEach(function (prop) {
        var override = def.overrides && def.overrides[tier.id];
        entry.overridden[prop] = !!(override && override[prop] !== undefined && override[prop] !== '');
        try {
          entry[prop] = get(def.id + '.' + prop);
        } catch (err) {
          entry[prop] = NaN;
          entry.error = entry.error || (prop + ': ' + err.message);
          out.errors[def.id + '.' + prop] = err.message;
        }
      });
      if (def.container) {
        entry.container = {};
        ['w', 'h'].forEach(function (prop) {
          try {
            entry.container[prop] = evalExpr(def.container[prop]);
          } catch (err) {
            entry.container[prop] = NaN;
            entry.error = entry.error || ('container.' + prop + ': ' + err.message);
            out.errors[def.id + '.container.' + prop] = err.message;
          }
        });
      }
      out.elements[def.id] = entry;
    });

    return out;
  }

  /* Resolve one tier on its own; used by the exporter and the fit view. */
  function resolveTier(state, tierId) {
    var tier = TIERS.filter(function (t) { return t.id === tierId; })[0] || TIERS[0];
    return resolveAll(state, tier);
  }

  root.PlymModel = {
    TIERS: TIERS,
    ALL_MODE_IDS: ALL_MODE_IDS,
    DEMAND_GROUPS: DEMAND_GROUPS,
    MAX_FRAMES: MAX_FRAMES,
    ELEMENT_ORDER: ELEMENT_ORDER,
    shapeTier: shapeTier,
    MODES: MODES,
    PADDINGS: PADDINGS,
    ELEMENTS: ELEMENTS,
    THEME: THEME,
    PREVIEW_COLORS: PREVIEW_COLORS,
    defaultState: defaultState,
    resolveAll: resolveAll,
    resolveTier: resolveTier,
    isPlainNumber: isPlainNumber,
    clone: clone
  };
})(typeof window !== 'undefined' ? window : globalThis);
