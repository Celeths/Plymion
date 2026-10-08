/* ============================================================================
   Plymouth Theme Generator — expression engine
   ----------------------------------------------------------------------------
   The layout template expresses every position and size as CSS calc() math
   (layout.html:134-138 and the `left`/`top`/`width`/`height` rules per id).
   This engine evaluates that same math to plain numbers, so the GUI can render
   a preview *and* milestone 2's generator can emit real values for each tier.

   Grammar (recursive descent):
     expr    := term (('+' | '-') term)*
     term    := factor (('*' | '/' | implicit) factor)*
     factor  := ('+' | '-') factor | primary
     primary := number | name | '(' expr ')'

   Implicit multiplication is supported the way CSS writes it:
     `100vw`      -> 100 * vw
     `2(x + 1)`   -> 2 * (x + 1)
     `(a)(b)`     -> (a) * (b)

   Names are matched longest-first against a caller-supplied list, which is why
   hyphenated identifiers (`pad-h1`, `secure-boot.w`) and compound references
   (`progress-percent.h`) all tokenize correctly without needing whitespace.
   Requires nothing: plain classic script, works from file://.
   ========================================================================= */
(function (root) {
  'use strict';

  var NUMBER_RE = /^\d*\.?\d+$/;
  var FALLBACK_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*/;

  /* ---------------------------------------------------------------- tokens */

  function tokenize(src, names) {
    var tokens = [];
    var i = 0;
    var n = src.length;

    while (i < n) {
      var c = src[i];

      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }

      /* number — leading dot allowed: `.5` */
      if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        var j = i;
        while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j += 1;
        var text = src.slice(i, j);
        if (!NUMBER_RE.test(text)) throw new Error('Bad number "' + text + '"');
        tokens.push({ type: 'num', value: parseFloat(text) });
        i = j;
        continue;
      }

      /* name — longest known name first, so `pad-h1` never splits into `pad - h1` */
      if (/[A-Za-z_]/.test(c)) {
        var matched = null;
        for (var k = 0; k < names.length; k += 1) {
          var cand = names[k];
          if (src.substr(i, cand.length) === cand) { matched = cand; break; }
        }
        if (matched) {
          tokens.push({ type: 'name', value: matched });
          i += matched.length;
          continue;
        }
        var m = FALLBACK_IDENT_RE.exec(src.slice(i));
        if (!m) throw new Error('Unexpected character "' + c + '"');
        tokens.push({ type: 'name', value: m[0] });
        i += m[0].length;
        continue;
      }

      if (c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')') {
        tokens.push({ type: 'op', value: c });
        i += 1;
        continue;
      }

      throw new Error('Unexpected character "' + c + '"');
    }

    tokens.push({ type: 'end' });
    return tokens;
  }

  /* ---------------------------------------------------------------- parser */

  function parse(tokens) {
    var pos = 0;

    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }

    function isOp(tok, value) { return tok.type === 'op' && tok.value === value; }
    function startsPrimary(tok) {
      return tok.type === 'num' || tok.type === 'name' || isOp(tok, '(');
    }

    function parsePrimary() {
      var t = next();
      if (t.type === 'num') return { type: 'num', value: t.value };
      if (t.type === 'name') return { type: 'name', value: t.value };
      if (isOp(t, '(')) {
        var inner = parseExpr();
        var close = next();
        if (!isOp(close, ')')) throw new Error('Expected ")"');
        return inner;
      }
      if (t.type === 'end') throw new Error('Unexpected end of expression');
      throw new Error('Unexpected "' + t.value + '"');
    }

    function parseFactor() {
      if (isOp(peek(), '-')) { next(); return { type: 'neg', arg: parseFactor() }; }
      if (isOp(peek(), '+')) { next(); return parseFactor(); }
      return parsePrimary();
    }

    function parseTerm() {
      var node = parseFactor();
      for (;;) {
        var t = peek();
        if (isOp(t, '*') || isOp(t, '/')) {
          next();
          node = { type: 'bin', op: t.value, left: node, right: parseFactor() };
        } else if (startsPrimary(t)) {
          /* implicit multiplication */
          node = { type: 'bin', op: '*', left: node, right: parseFactor() };
        } else {
          return node;
        }
      }
    }

    function parseExpr() {
      var node = parseTerm();
      for (;;) {
        var t = peek();
        if (isOp(t, '+') || isOp(t, '-')) {
          next();
          node = { type: 'bin', op: t.value, left: node, right: parseTerm() };
        } else {
          return node;
        }
      }
    }

    var ast = parseExpr();
    if (peek().type !== 'end') throw new Error('Unexpected trailing input');
    return ast;
  }

  /* -------------------------------------------------------------- evaluate */

  function evaluate(ast, get) {
    switch (ast.type) {
      case 'num':
        return ast.value;
      case 'name':
        return get(ast.value);
      case 'neg':
        return -evaluate(ast.arg, get);
      case 'bin': {
        var a = evaluate(ast.left, get);
        var b = evaluate(ast.right, get);
        switch (ast.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/':
            if (b === 0) throw new Error('Division by zero');
            return a / b;
        }
        break;
      }
    }
    throw new Error('Malformed expression');
  }

  function compile(src, names) {
    return parse(tokenize(src, names));
  }

  root.PlymExpr = {
    tokenize: tokenize,
    parse: parse,
    evaluate: evaluate,
    compile: compile
  };
})(typeof window !== 'undefined' ? window : globalThis);
