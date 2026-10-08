/* ============================================================================
   Plymouth Theme Generator — output (milestone 2, part 5)
   ----------------------------------------------------------------------------
   Gets a generated theme out of the page and onto the disk, by whichever route
   the browser allows.

   Preferred: the File System Access API. The author picks a folder — normally
   /usr/share/plymouth/themes — and the theme directory is created inside it,
   subdirectories and all. That is the only route that produces something
   Plymouth can use without the author unzipping anything.

   Fallback: a ZIP. File System Access is Chromium-only and needs a secure
   context, so on Safari and Firefox, and on a page opened straight off the
   filesystem, the theme is handed over as one archive instead. Same file tree
   inside; the author unpacks it into the themes directory.

   Cancelling the folder picker is not an error. The author changing their mind
   resolves with method "cancelled" so the caller can say so plainly rather than
   reporting a failure.
   ========================================================================= */
(function (root) {
  'use strict';

  /* --------------------------------------------------------------- checks */

  /* The picker exists, is callable, and this page is allowed to use it. A
     non-secure context can expose the symbol and still refuse the call, which
     is why the caller is expected to handle the fallback as well. */
  function browserCanWriteFolders() {
    return typeof root.showDirectoryPicker === 'function';
  }

  /* ------------------------------------------------------------- segments */

  /* "assets/720p/main.png" -> ["assets", "720p", "main.png"] */
  function segments(path) {
    return String(path)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .filter(function (part) { return part && part !== '.'; });
  }

  /* -------------------------------------------------------- directory route */

  function writeIntoDirectory(rootHandle, themeName, files) {
    return rootHandle.getDirectoryHandle(themeName, { create: true })
      .then(function (themeDir) {
        /* Written one at a time rather than in parallel: this is a handful of
           files and a serial loop keeps the failure report unambiguous. */
        return files.reduce(function (chain, file) {
          return chain.then(function () {
            var parts = segments(file.path);
            var filename = parts.pop();
            if (!filename) throw new Error('"' + file.path + '" has no filename');

            return parts.reduce(function (dirChain, part) {
              return dirChain.then(function (dir) {
                return dir.getDirectoryHandle(part, { create: true });
              });
            }, Promise.resolve(themeDir))
              .then(function (dir) {
                return dir.getFileHandle(filename, { create: true });
              })
              .then(function (handle) {
                return handle.createWritable();
              })
              .then(function (writable) {
                return writable.write(file.blob).then(function () {
                  return writable.close();
                });
              });
          });
        }, Promise.resolve());
      })
      .then(function () {
        return { method: 'directory', count: files.length, name: themeName };
      });
  }

  /* -------------------------------------------------------------- zip route */

  function downloadBlob(blob, filename) {
    var url = root.URL.createObjectURL(blob);
    var link = root.document.createElement('a');
    link.href = url;
    link.download = filename;
    root.document.body.appendChild(link);
    link.click();
    root.document.body.removeChild(link);
    /* Revoked on the next turn of the loop rather than immediately: Safari has
       been known to cancel a download whose object URL is revoked in the same
       task as the click. */
    root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 0);
  }

  function writeAsZip(files, themeName) {
    var zipName = themeName + '.zip';
    return root.PlymZip.build(files).then(function (blob) {
      downloadBlob(blob, zipName);
      return { method: 'zip', count: files.length, name: zipName };
    });
  }

  /* ------------------------------------------------------------ the entry */

  /* files: [{ path, blob }]. Resolves — never rejects on a cancellation. */
  function writeTheme(files, themeName) {
    var list = Array.isArray(files) ? files : [];
    var name = String(themeName || 'theme');

    if (!browserCanWriteFolders()) {
      return writeAsZip(list, name);
    }

    return root.showDirectoryPicker({ mode: 'readwrite' })
      .then(function (handle) {
        return writeIntoDirectory(handle, name, list);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          return { method: 'cancelled', count: 0, name: name };
        }
        /* Present but unusable — a non-secure context, or a refused permission.
           The ZIP route still works, so fall back rather than failing. */
        return writeAsZip(list, name);
      });
  }

  root.PlymOutput = {
    writeTheme: writeTheme,
    browserCanWriteFolders: browserCanWriteFolders,
    segments: segments
  };
})(typeof window !== 'undefined' ? window : globalThis);
