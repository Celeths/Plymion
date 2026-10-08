/* ============================================================================
   Plymouth Theme Generator — ZIP writer (milestone 2, part 4)
   ----------------------------------------------------------------------------
   A dependency-free ZIP writer, because the generator has to be able to hand
   over a whole theme folder from a page opened off the filesystem: no server,
   no bundler, no npm.

   `CompressionStream('deflate-raw')` is used when the environment has it, and
   the archive falls back to stored entries when it does not — both are valid
   ZIPs, and a stored entry is exactly the right choice for the small text files
   anyway. An entry that deflates no smaller than it started is stored too,
   which is what every other writer does.

   The output is a classic ZIP: local file header per entry, then the central
   directory, then the end-of-central-directory record. No ZIP64, so a single
   entry or the archive as a whole above 4 GiB is refused rather than silently
   truncated.

   Names are UTF-8 and the language-encoding flag (bit 11) is set on both
   headers, so a theme whose element name is not ASCII still unzips correctly.
   ========================================================================= */
(function (root) {
  'use strict';

  var LOCAL_SIG = 0x04034b50;
  var CENTRAL_SIG = 0x02014b50;
  var EOCD_SIG = 0x06054b50;

  var METHOD_STORE = 0;
  var METHOD_DEFLATE = 8;

  /* General purpose bit 11: the filename is UTF-8. */
  var FLAG_UTF8 = 0x0800;

  var VERSION = 20;              /* 2.0 — deflate support */
  var MAX_U32 = 0xffffffff;
  var MAX_U16 = 0xffff;

  /* -------------------------------------------------------------- CRC-32 */

  /* The reflected IEEE polynomial, the one ZIP uses. Computed from the table
     rather than by calling into a platform API, so the same bytes come out in
     a browser and in Node. */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ------------------------------------------------------------- helpers */

  function utf8(text) {
    return new TextEncoder().encode(String(text));
  }

  function concat(chunks) {
    var total = 0;
    var i;
    for (i = 0; i < chunks.length; i += 1) total += chunks[i].length;
    var out = new Uint8Array(total);
    var at = 0;
    for (i = 0; i < chunks.length; i += 1) {
      out.set(chunks[i], at);
      at += chunks[i].length;
    }
    return out;
  }

  /* Little-endian byte builder — every multi-byte field in a ZIP is LE. */
  function Builder() {
    this.chunks = [];
    this.length = 0;
  }
  Builder.prototype.push = function (bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  };
  Builder.prototype.u16 = function (value) {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  };
  Builder.prototype.u32 = function (value) {
    this.push(new Uint8Array([
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff
    ]));
  };
  Builder.prototype.bytes = function () {
    return concat(this.chunks);
  };

  /* MS-DOS packed date and time. ZIP has no other way to record a timestamp,
     and 1980 is the earliest it can express. */
  function dosStamp(date) {
    var year = date.getFullYear();
    if (year < 1980) return { time: 0, date: 0x0021 };
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  /* ------------------------------------------------------------ deflating */

  /* Raw deflate, or null when the environment cannot do it.

     Driven through the stream's own reader and writer rather than by piping a
     Blob through a Response: it keeps the writer free of any other platform
     API, which means the only thing a host has to supply to exercise the
     compressed path is CompressionStream itself. */
  function deflateRaw(bytes) {
    if (typeof root.CompressionStream !== 'function') return Promise.resolve(null);

    var stream;
    try {
      stream = new root.CompressionStream('deflate-raw');
    } catch (err) {
      return Promise.resolve(null);      /* present but unhappy with the format */
    }

    return new Promise(function (resolve) {
      var chunks = [];
      var reader = stream.readable.getReader();
      var writer = stream.writable.getWriter();
      var settled = false;

      function giveUp() {
        if (settled) return;
        settled = true;
        resolve(null);                   /* store it instead; never fatal */
      }

      function pump() {
        reader.read().then(function (result) {
          if (result.done) {
            if (settled) return;
            settled = true;
            resolve(concat(chunks));
            return;
          }
          chunks.push(new Uint8Array(result.value));
          pump();
        }, giveUp);
      }

      pump();
      writer.write(bytes).then(function () {
        return writer.close();
      }).catch(giveUp);
    });
  }

  /* ------------------------------------------------------------- entries */

  function bytesFor(entry, index) {
    if (typeof entry.text === 'string') {
      return Promise.resolve(utf8(entry.text));
    }
    if (entry.blob && typeof entry.blob.arrayBuffer === 'function') {
      return entry.blob.arrayBuffer().then(function (buf) {
        return new Uint8Array(buf);
      });
    }
    if (entry.bytes) return Promise.resolve(entry.bytes);
    return Promise.reject(new Error('entry ' + index + ' ("' + entry.path +
      '") has no text, blob or bytes'));
  }

  function nameFor(entry, index) {
    var path = entry && entry.path;
    if (typeof path !== 'string' || !path) {
      throw new Error('entry ' + index + ' has no path');
    }
    /* Backslashes and a leading slash both produce archives that unpack in the
       wrong place, so they are normalised rather than trusted. */
    var clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || /(^|\/)\.\.(\/|$)/.test(clean)) {
      throw new Error('entry ' + index + ' has an unusable path: "' + path + '"');
    }
    return clean;
  }

  /* --------------------------------------------------------------- build */

  /* entries: [{ path, text } | { path, blob }]
     Resolves to a Blob holding a complete ZIP archive. */
  function build(entries) {
    if (!Array.isArray(entries)) {
      return Promise.reject(new Error('build(entries) needs an array'));
    }
    if (entries.length > MAX_U16) {
      return Promise.reject(new Error('too many entries for a non-ZIP64 archive'));
    }

    var names;
    try {
      names = entries.map(nameFor);
    } catch (err) {
      return Promise.reject(err);
    }

    var stamp = dosStamp(new Date());

    return Promise.all(entries.map(function (entry, index) {
      return bytesFor(entry, index).then(function (raw) {
        if (raw.length > MAX_U32) {
          throw new Error('"' + names[index] + '" is too large for a non-ZIP64 archive');
        }
        var crc = crc32(raw);
        return deflateRaw(raw).then(function (packed) {
          /* Only keep the deflated form if it actually helped. */
          var useDeflate = packed && packed.length < raw.length;
          var body = useDeflate ? packed : raw;
          return {
            name: names[index],
            nameBytes: utf8(names[index]),
            method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
            crc: crc,
            body: body,
            rawSize: raw.length,
            packedSize: body.length
          };
        });
      });
    })).then(function (records) {
      var local = new Builder();
      var offsets = [];

      records.forEach(function (rec) {
        offsets.push(local.length);
        if (local.length > MAX_U32) {
          throw new Error('archive is too large for a non-ZIP64 file');
        }
        local.u32(LOCAL_SIG);
        local.u16(VERSION);
        local.u16(FLAG_UTF8);
        local.u16(rec.method);
        local.u16(stamp.time);
        local.u16(stamp.date);
        local.u32(rec.crc);
        local.u32(rec.packedSize);
        local.u32(rec.rawSize);
        local.u16(rec.nameBytes.length);
        local.u16(0);                    /* no extra field */
        local.push(rec.nameBytes);
        local.push(rec.body);
      });

      var central = new Builder();
      records.forEach(function (rec, index) {
        central.u32(CENTRAL_SIG);
        central.u16(VERSION);            /* version made by */
        central.u16(VERSION);            /* version needed */
        central.u16(FLAG_UTF8);
        central.u16(rec.method);
        central.u16(stamp.time);
        central.u16(stamp.date);
        central.u32(rec.crc);
        central.u32(rec.packedSize);
        central.u32(rec.rawSize);
        central.u16(rec.nameBytes.length);
        central.u16(0);                  /* extra */
        central.u16(0);                  /* comment */
        central.u16(0);                  /* disk number start */
        central.u16(0);                  /* internal attributes */
        central.u32(0);                  /* external attributes */
        central.u32(offsets[index]);
        central.push(rec.nameBytes);
      });

      var localBytes = local.bytes();
      var centralBytes = central.bytes();

      var end = new Builder();
      end.u32(EOCD_SIG);
      end.u16(0);                        /* this disk */
      end.u16(0);                        /* disk holding the central directory */
      end.u16(records.length);           /* entries on this disk */
      end.u16(records.length);           /* entries in total */
      end.u32(centralBytes.length);
      end.u32(localBytes.length);        /* central directory starts right after */
      end.u16(0);                        /* no archive comment */

      return new root.Blob([localBytes, centralBytes, end.bytes()],
        { type: 'application/zip' });
    });
  }

  root.PlymZip = {
    build: build,
    crc32: crc32,
    METHOD_STORE: METHOD_STORE,
    METHOD_DEFLATE: METHOD_DEFLATE,
    FLAG_UTF8: FLAG_UTF8
  };
})(typeof window !== 'undefined' ? window : globalThis);
