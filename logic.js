/*
 * UTP human evaluation - the rules of the answer form, with no page code in it, so that it can be tested on its own.
 *
 * "raw"    = what the evaluator typed (text boxes, unit menus, "not given" / "not stated" ticks). Kept exactly,
 *            also on the server.
 * "answer" = the 17 values that are stored and compared with the models:
 *              q1 (true/false), q2, q3, q4 (9 amounts), q5 (2 amounts)   -> amounts in USD millions, null = not given
 *              q6.federal (list of years | null), q6.state (list | "various" | null), q6.foreign ({country: years} | null)
 *
 * Every question must be answered before a filing can be saved: an amount is either typed or ticked "not given",
 * each part of question 6 is either typed or ticked "not stated". computeAnswer() reports what is missing.
 * checkPractice() compares the answers of the practice filing with its known answers and explains mistakes.
 */
(function (root) {
  'use strict';

  var UNITS = {dollars: 1e-6, thousands: 1e-3, millions: 1, billions: 1e3};
  var UNIT_NAMES = {dollars: 'in dollars', thousands: 'in thousands', millions: 'in millions', billions: 'in billions'};
  var UNIT_LONG = {dollars: 'dollars', thousands: 'thousands of dollars', millions: 'millions of dollars', billions: 'billions of dollars'};

  /* [path in raw/answer, label, small note, kind]. kind: balance | increase | decrease | either */
  var AMOUNT_GROUPS = {
    q2: [['q2', 'Balance at end of year', '', 'balance']],
    q3: [['q3', 'Amount that would affect the effective tax rate', '', 'balance']],
    q4: [
      ['q4.beginning', 'Balance at beginning of year', '', 'balance'],
      ['q4.add_prior', 'Increases: positions of prior years', '', 'increase'],
      ['q4.dec_prior', 'Decreases: positions of prior years', 'a decrease: type only the number', 'decrease'],
      ['q4.add_current', 'Increases: positions of the current year', '', 'increase'],
      ['q4.settlements', 'Decreases: settlements with tax authorities', 'a decrease: type only the number', 'decrease'],
      ['q4.lapse', 'Decreases: lapse of the statute of limitations', 'a decrease: type only the number', 'decrease'],
      ['q4.fx', 'Foreign currency translation', 'in parentheses if it lowers the balance', 'either'],
      ['q4.other', 'Other lines, added up', 'acquisitions, divestitures, reclassifications, "other"; in parentheses if they lower the balance', 'either'],
      ['q4.ending', 'Balance at end of year', '', 'balance']
    ],
    q5: [
      ['q5.accrued', 'Accrued at the end of the year', 'a balance', 'balance'],
      ['q5.expense', 'Recognized as expense during the year', '', 'either']
    ]
  };
  var Q4_MOVEMENTS = ['add_prior', 'dec_prior', 'add_current', 'settlements', 'lapse', 'fx', 'other'];
  var ALL_AMOUNTS = [].concat(AMOUNT_GROUPS.q2, AMOUNT_GROUPS.q3, AMOUNT_GROUPS.q4, AMOUNT_GROUPS.q5);
  var KIND = {};
  var LABEL = {};
  for (var ka = 0; ka < ALL_AMOUNTS.length; ka++) { KIND[ALL_AMOUNTS[ka][0]] = ALL_AMOUNTS[ka][3]; LABEL[ALL_AMOUNTS[ka][0]] = ALL_AMOUNTS[ka][1]; }

  function amt() { return {v: '', u: '', ng: false}; }

  function blankRaw() {
    return {
      default_unit: '', q1: '',
      q2: amt(), q3: amt(),
      q4: {no_table: false, beginning: amt(), add_prior: amt(), dec_prior: amt(), add_current: amt(), settlements: amt(),
           lapse: amt(), fx: amt(), other: amt(), ending: amt()},
      q5: {accrued: amt(), expense: amt()},
      q6: {federal: '', federal_ns: false, state: '', state_ns: false, state_various: false, foreign: [{j: '', y: ''}], foreign_ns: false},
      flag: false, comment: ''
    };
  }

  function getPath(obj, path) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function setPath(obj, path, value) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) { if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = value;
  }
  function text(v) { return v == null ? '' : String(v); }
  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  /* Whatever was stored (an older draft, a damaged one), return a complete raw object. */
  function mergeRaw(saved) {
    var raw = blankRaw();
    if (!saved || typeof saved !== 'object') return raw;
    if (UNITS[saved.default_unit]) raw.default_unit = saved.default_unit;
    if (saved.q1 === 'yes' || saved.q1 === 'no') raw.q1 = saved.q1;
    for (var i = 0; i < ALL_AMOUNTS.length; i++) {
      var f = getPath(saved, ALL_AMOUNTS[i][0]);
      if (f && typeof f === 'object') setPath(raw, ALL_AMOUNTS[i][0], {v: text(f.v), u: UNITS[f.u] ? f.u : '', ng: f.ng === true});
    }
    if (saved.q4 && saved.q4.no_table === true) raw.q4.no_table = true;
    var q6 = saved.q6 && typeof saved.q6 === 'object' ? saved.q6 : {};
    raw.q6.federal = text(q6.federal);
    raw.q6.federal_ns = q6.federal_ns === true;
    if (typeof q6.state === 'string' || typeof q6.state === 'number') raw.q6.state = text(q6.state);
    else if (q6.state_mode === 'years') raw.q6.state = text(q6.state_years);          // drafts of the first version
    raw.q6.state_ns = q6.state_ns === true;
    raw.q6.state_various = q6.state_various === true || q6.state_mode === 'various';
    if (isArray(q6.foreign)) {
      var rows = [];
      for (var k = 0; k < q6.foreign.length && k < 60; k++) {
        var row = q6.foreign[k];
        if (row && typeof row === 'object') rows.push({j: text(row.j), y: text(row.y)});
      }
      if (rows.length) raw.q6.foreign = rows;
    }
    raw.q6.foreign_ns = q6.foreign_ns === true;
    raw.flag = saved.flag === true;
    raw.comment = text(saved.comment);
    return raw;
  }

  /* "16,475" -> 16475; "(791)" -> -791; "$1.4" -> 1.4; "" -> null; anything else -> error. */
  function parseAmount(input) {
    var s = text(input).trim();
    if (!s) return {value: null};
    s = s.replace(/[−‒–—]/g, '-').replace(/[$,\s]/g, '');
    var negative = false;
    var paren = /^\((.*)\)$/.exec(s);
    if (paren) { negative = true; s = paren[1]; }
    if (s.charAt(0) === '-') { negative = !negative; s = s.slice(1); } else if (s.charAt(0) === '+') { s = s.slice(1); }
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return {error: true};
    var n = Number(s);
    if (!isFinite(n)) return {error: true};
    return {value: negative && n !== 0 ? -n : n};
  }

  /* A decrease must be typed in parentheses with a plain number inside: "(791)", "( 1,234.5 )", "$(85)". */
  function isParenthesized(input) {
    var s = text(input).replace(/[$\s]/g, '');
    return /^\([^()\-−‒–—+]+\)$/.test(s);
  }

  function toMillions(value, unit) { return Math.round(value * UNITS[unit] * 1e6) / 1e6; }

  /* Decrease rows show their parentheses on the page, so the number typed there is a decrease, whatever its sign. */
  function signed(path, value) {
    if (value === null || value === undefined) return value;
    return KIND[path] === 'decrease' && value !== 0 ? -Math.abs(value) : value;
  }

  /* "2016-2020", "2016, 2018", "2015 through 2019" -> sorted list of years; "" -> null. */
  function parseYears(input) {
    var s = text(input).trim();
    if (!s) return {years: null};
    var norm = s.replace(/[−‒–—]/g, '-').replace(/\b(through|thru|to)\b/gi, '-').replace(/\band\b/gi, ',').replace(/\s+/g, '');
    var tokens = norm.split(/[,;]+/);
    var seen = {};
    var years = [];
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (!token) continue;
      var one = /^(\d{4})$/.exec(token);
      var range = /^(\d{4})-(\d{4})$/.exec(token);
      var open = /^(\d{4})(\+|-|onwards?|andlater|andafter)$/i.exec(token);
      var from, to;
      if (one) { from = to = Number(one[1]); }
      else if (range) { from = Number(range[1]); to = Number(range[2]); }
      else if (open) return {error: 'Write the years out up to the current fiscal year: for example ' + open[1] + '-2020 instead of "' + token + '".'};
      else return {error: '"' + token + '" is not a year or a range of years. Write for example 2016-2020 or 2016, 2018.'};
      if (to < from) return {error: 'The range ' + token + ' ends before it starts.'};
      if (from < 1950 || to > 2100) return {error: token + ' is not a plausible tax year.'};
      if (to - from > 60) return {error: 'The range ' + token + ' is too long.'};
      for (var y = from; y <= to; y++) { if (!seen[y]) { seen[y] = true; years.push(y); } }
    }
    if (!years.length) return {error: 'No year found.'};
    years.sort(function (a, b) { return a - b; });
    return {years: years};
  }

  /* Year text of a foreign line: "2015+", "after 2014", "2012-2019", "2018" -> {from, to (null = open-ended)} or null. */
  function yearSpec(input) {
    var t = text(input).toLowerCase().replace(/[−‒–—]/g, '-').replace(/\s+/g, ' ').trim();
    var m;
    if ((m = /^(\d{4}) ?(\+|-|and later|and after|and beyond|and thereafter|onwards?|forward|or later)$/.exec(t))) return {from: +m[1], to: null};
    if ((m = /^(after|since|from) (\d{4})( on| onwards?)?$/.exec(t))) return {from: +m[2] + (m[1] === 'after' ? 1 : 0), to: null};
    if ((m = /^(\d{4}) ?(-|to|through|thru) ?(\d{4})$/.exec(t))) return {from: +m[1], to: +m[3]};
    if ((m = /^(\d{4})$/.exec(t))) return {from: +m[1], to: +m[1]};
    return null;
  }

  function fmt(n) {
    if (n === null || n === undefined) return '';
    return Number(n).toLocaleString('en-US', {maximumFractionDigits: 6});
  }

  function labelOf(path) {
    if (LABEL[path]) return 'Question ' + path.charAt(1) + ', ' + LABEL[path].toLowerCase();
    return path;
  }

  /*
   * Checks what was typed and turns it into the stored answer.
   * Returns {answer, errors: [{path, q, text}], missing: [{path, q, label?, text?}], warnings: [text],
   *          conv: {path: {millions}|{error}|{needUnit}|{ng}}, years: {federal, state}, tie: null | {sum, ending, diff, ok}}
   * errors and missing block saving; warnings ask the evaluator to look again but can be overridden.
   */
  function computeAnswer(rawIn) {
    var raw = mergeRaw(rawIn);
    var errors = [];
    var missing = [];
    var warnings = [];
    var conv = {};
    var years = {};
    var answer = {
      q1: raw.q1 === 'yes' ? true : (raw.q1 === 'no' ? false : null), q2: null, q3: null,
      q4: {beginning: null, add_prior: null, dec_prior: null, add_current: null, settlements: null, lapse: null, fx: null, other: null, ending: null},
      q5: {accrued: null, expense: null},
      q6: {federal: null, state: null, foreign: null},
      flag: raw.flag === true, comment: raw.comment.trim().slice(0, 2000)
    };
    var out = {answer: answer, errors: errors, missing: missing, warnings: warnings, conv: conv, years: years, tie: null};
    if (answer.q1 === null) missing.push({path: 'q1', q: 1, text: 'Question 1: choose Yes or No.'});
    if (answer.q1 !== true) return out;

    var unitOf = {};
    var needUnit = false;
    var nNotGiven = 0;
    var nQ4NotGiven = 0;
    for (var i = 0; i < ALL_AMOUNTS.length; i++) {
      var path = ALL_AMOUNTS[i][0];
      var kind = ALL_AMOUNTS[i][3];
      var q = Number(path.charAt(1));
      var label = labelOf(path);
      if (path.indexOf('q4.') === 0 && raw.q4.no_table) continue;
      var field = getPath(raw, path);
      var typed = field.v.trim();
      if (field.ng && !typed) {
        conv[path] = {ng: true};
        nNotGiven++;
        if (q === 4) nQ4NotGiven++;
        continue;
      }
      if (!typed) { missing.push({path: path, q: q, label: ALL_AMOUNTS[i][1]}); continue; }
      if (field.ng) {
        errors.push({path: path + '.v', q: q, text: label + ': there is an amount and "not given" is ticked. Keep one of the two.'});
        continue;
      }
      var parsed = parseAmount(typed);
      if (parsed.error) {
        conv[path] = {error: true};
        errors.push({path: path + '.v', q: q, text: label + ': "' + typed + '" is not a number. Type it as printed, for example 16,475. If the note shows a dash, tick "not given".'});
        continue;
      }
      var unit = field.u || raw.default_unit;
      if (!UNITS[unit]) {
        if (parsed.value === 0) { conv[path] = {millions: 0, unit: ''}; setPath(answer, path, 0); continue; }
        conv[path] = {needUnit: true};
        if (!needUnit) errors.push({path: 'default_unit', q: 1.5, text: 'Choose the unit of the amounts ("Amounts are in ..."), or the unit next to each amount.'});
        needUnit = true;
        continue;
      }
      var millions = toMillions(signed(path, parsed.value), unit);
      if (Math.abs(millions) > 1e9) {
        conv[path] = {error: true};
        errors.push({path: path + '.v', q: q, text: label + ': the amount is impossibly large. Check the number and its unit.'});
        continue;
      }
      conv[path] = {millions: millions, unit: unit};
      unitOf[path] = unit;
      setPath(answer, path, millions);
    }

    var q6 = raw.q6;
    if (q6.federal.trim() && q6.federal_ns) {
      errors.push({path: 'q6.federal', q: 6, text: 'Question 6, U.S. federal: there are years and "not stated" is ticked. Keep one of the two.'});
    } else if (q6.federal_ns) {
      years.federal = null;
    } else if (!q6.federal.trim()) {
      missing.push({path: 'q6.federal', q: 6, text: 'Question 6, U.S. federal: type the open years, or tick "not stated".'});
    } else {
      var fed = parseYears(q6.federal);
      years.federal = fed;
      if (fed.error) errors.push({path: 'q6.federal', q: 6, text: 'Question 6, U.S. federal: ' + fed.error});
      else answer.q6.federal = fed.years;
    }

    var stateTyped = q6.state.trim() !== '';
    var nState = (stateTyped ? 1 : 0) + (q6.state_ns ? 1 : 0) + (q6.state_various ? 1 : 0);
    if (nState === 0) {
      missing.push({path: 'q6.state', q: 6, text: 'Question 6, U.S. states: type the open years, or tick "not stated" or "open, but the years are not named".'});
    } else if (nState > 1) {
      errors.push({path: 'q6.state', q: 6, text: 'Question 6, U.S. states: give one answer only: the years, "not stated", or "open, but the years are not named".'});
    } else if (q6.state_various) {
      answer.q6.state = 'various';
    } else if (stateTyped) {
      var st = parseYears(q6.state);
      years.state = st;
      if (st.error) errors.push({path: 'q6.state', q: 6, text: 'Question 6, U.S. states: ' + st.error});
      else answer.q6.state = st.years;
    }

    var foreign = {};
    var nForeign = 0;
    var nPartial = 0;
    var lower = {};
    for (var r = 0; r < q6.foreign.length; r++) {
      var j = q6.foreign[r].j.replace(/\s+/g, ' ').trim();
      var yy = q6.foreign[r].y.replace(/\s+/g, ' ').trim();
      if (!j && !yy) continue;
      if (!j || !yy) {
        nPartial++;
        errors.push({path: 'q6.foreign.' + r + (j ? '.y' : '.j'), q: 6, text: 'Question 6, foreign countries, line ' + (r + 1) + ': give both the country and its years.'});
        continue;
      }
      if (lower[j.toLowerCase()]) { errors.push({path: 'q6.foreign.' + r + '.j', q: 6, text: 'Question 6, foreign countries: "' + j + '" is listed twice.'}); continue; }
      lower[j.toLowerCase()] = true;
      foreign[j.slice(0, 80)] = yy.slice(0, 80);
      nForeign++;
    }
    if (q6.foreign_ns && (nForeign || nPartial)) {
      errors.push({path: 'q6.foreign', q: 6, text: 'Question 6, foreign countries: a country is typed and "not stated" is ticked. Keep one of the two.'});
    } else if (!q6.foreign_ns && !nForeign && !nPartial) {
      missing.push({path: 'q6.foreign', q: 6, text: 'Question 6, foreign countries: add a country with its years, or tick "not stated".'});
    }
    if (nForeign && !q6.foreign_ns) answer.q6.foreign = foreign;

    /* ---- things to look at again (they do not block saving) ---- */
    if (errors.length || missing.length) return out;
    var q4 = answer.q4;
    var nQ4 = 0;
    for (var key in q4) { if (q4[key] !== null) nQ4++; }
    var anything = answer.q2 !== null || answer.q3 !== null || nQ4 > 0 || answer.q5.accrued !== null || answer.q5.expense !== null ||
      answer.q6.federal !== null || answer.q6.state !== null || answer.q6.foreign !== null;
    if (!anything) {
      warnings.push('You answered Yes to question 1 but everything else is "not given" or "not stated". That is right only if the note mentions the subject without giving any amount or year.');
    } else if (!raw.q4.no_table && nQ4 === 0) {
      warnings.push('Question 4: every row is "not given". If the note has no roll-forward table, tick "The note has no roll-forward table" instead.');
    }
    if (answer.q2 !== null && answer.q3 !== null && answer.q3 > answer.q2 + 1e-9) {
      warnings.push('Question 3 (' + fmt(answer.q3) + ' million) is larger than question 2 (' + fmt(answer.q2) + ' million). The part that affects the tax rate cannot be larger than the total.');
    }
    if (answer.q2 !== null && q4.ending !== null && Math.abs(answer.q2 - q4.ending) > 1e-6 * Math.max(1, Math.abs(q4.ending))) {
      warnings.push('Question 2 (' + fmt(answer.q2) + ' million) is not the same as the ending balance in question 4 (' + fmt(q4.ending) + ' million). If the table and the text differ, use the number of the table in both places.');
    }
    var nMoves = 0;
    var sum = q4.beginning;
    for (var m = 0; m < Q4_MOVEMENTS.length; m++) {
      var mv = q4[Q4_MOVEMENTS[m]];
      if (mv !== null) { nMoves++; if (sum !== null) sum += mv; }
    }
    if (q4.beginning !== null && q4.ending !== null) {
      var scale = Math.max(Math.abs(q4.beginning), Math.abs(q4.ending));
      var smallest = Math.min(UNITS[unitOf['q4.beginning']] || 1, UNITS[unitOf['q4.ending']] || 1);
      var tolerance = Math.max(0.005 * scale, 2.01 * smallest);
      var diff = Math.round((sum - q4.ending) * 1e6) / 1e6;
      out.tie = {sum: Math.round(sum * 1e6) / 1e6, ending: q4.ending, diff: diff, ok: Math.abs(diff) <= tolerance};
      if (!out.tie.ok) {
        warnings.push('Question 4 does not add up: the beginning balance plus the changes gives ' + fmt(out.tie.sum) + ' million, but the ending balance is ' +
          fmt(q4.ending) + ' million (difference ' + fmt(diff) + '). Check the numbers. If the table in the note does not add up either, keep the printed numbers and flag the filing.');
      }
    } else if (nMoves > 0) {
      warnings.push('Question 4: there are changes but the beginning or the ending balance is "not given".');
    }
    for (var a = 0; a < ALL_AMOUNTS.length; a++) {
      var p = ALL_AMOUNTS[a][0];
      var kd = ALL_AMOUNTS[a][3];
      var val = getPath(answer, p);
      if (val === null || val === undefined || val === 0) continue;
      if (kd === 'increase' && val < 0) warnings.push('"' + labelOf(p) + '" is an increase, but the amount is negative.');
      if (kd === 'balance' && val < 0) warnings.push('"' + labelOf(p) + '" is negative. Balances are normally positive.');
    }
    return out;
  }

  /* Tie-out preview while typing: computed from whatever is complete, even if other questions are still open. */
  function tieOut(rawIn) {
    var raw = mergeRaw(rawIn);
    if (raw.q1 !== 'yes' || raw.q4.no_table) return null;
    var vals = {};
    var units = {};
    for (var i = 0; i < AMOUNT_GROUPS.q4.length; i++) {
      var path = AMOUNT_GROUPS.q4[i][0];
      var f = getPath(raw, path);
      var unit = f.u || raw.default_unit;
      var parsed = parseAmount(f.v);
      vals[path] = (f.ng || parsed.error || parsed.value === null || !UNITS[unit]) ? null : toMillions(signed(path, parsed.value), unit);
      units[path] = unit;
    }
    if (vals['q4.beginning'] === null || vals['q4.ending'] === null) return null;
    var sum = vals['q4.beginning'];
    for (var m = 0; m < Q4_MOVEMENTS.length; m++) { var v = vals['q4.' + Q4_MOVEMENTS[m]]; if (v !== null) sum += v; }
    var scale = Math.max(Math.abs(vals['q4.beginning']), Math.abs(vals['q4.ending']));
    var smallest = Math.min(UNITS[units['q4.beginning']] || 1, UNITS[units['q4.ending']] || 1);
    var tolerance = Math.max(0.005 * scale, 2.01 * smallest);
    var diff = Math.round((sum - vals['q4.ending']) * 1e6) / 1e6;
    return {sum: Math.round(sum * 1e6) / 1e6, ending: vals['q4.ending'], diff: diff, ok: Math.abs(diff) <= tolerance};
  }

  /* The list shown above the Save button: format problems one by one, unanswered amounts grouped per question. */
  function problemLines(out) {
    var items = [];
    var groups = {};
    var i;
    for (i = 0; i < out.missing.length; i++) {
      var m = out.missing[i];
      if (m.text) { items.push({q: m.q, text: m.text}); continue; }
      if (!groups[m.q]) { groups[m.q] = {q: m.q, labels: []}; items.push(groups[m.q]); }
      groups[m.q].labels.push(m.label);
    }
    for (i = 0; i < out.errors.length; i++) items.push({q: out.errors[i].q, text: out.errors[i].text});
    items.sort(function (x, y) { return x.q - y.q; });
    var lines = [];
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.text) { lines.push(it.text); continue; }
      var total = AMOUNT_GROUPS['q' + it.q].length;
      if (total === 1) lines.push('Question ' + it.q + ': type the amount, or tick "not given".');
      else if (it.q === 4 && it.labels.length === total) lines.push('Question 4: no row is answered yet. Type each amount, tick "not given" for rows the table does not have, or tick "The note has no roll-forward table".');
      else lines.push('Question ' + it.q + ': ' + (it.labels.length === 1 ? '1 row has' : it.labels.length + ' rows have') + ' no answer yet (' + it.labels.join('; ') + '). Type the amount, or tick "not given".');
    }
    return lines;
  }

  /* Rebuild something typeable from a stored answer whose raw entries are missing. Amounts are then in millions. */
  function rawFromAnswer(answer) {
    var raw = blankRaw();
    if (!answer || typeof answer !== 'object') return raw;
    raw.q1 = answer.q1 === true ? 'yes' : (answer.q1 === false ? 'no' : '');
    if (answer.q1 !== true) { raw.flag = answer.flag === true; raw.comment = text(answer.comment); return raw; }
    raw.default_unit = 'millions';
    var anyQ4 = false;
    for (var i = 0; i < ALL_AMOUNTS.length; i++) {
      var v = getPath(answer, ALL_AMOUNTS[i][0]);
      if (typeof v === 'number' && isFinite(v)) {
        var shown = ALL_AMOUNTS[i][3] === 'decrease' ? String(Math.abs(v)) : (v < 0 ? '(' + String(-v) + ')' : String(v));
        setPath(raw, ALL_AMOUNTS[i][0], {v: shown, u: '', ng: false});
        if (ALL_AMOUNTS[i][0].indexOf('q4.') === 0) anyQ4 = true;
      } else {
        setPath(raw, ALL_AMOUNTS[i][0], {v: '', u: '', ng: true});
      }
    }
    raw.q4.no_table = !anyQ4;
    if (raw.q4.no_table) for (var k4 = 0; k4 < AMOUNT_GROUPS.q4.length; k4++) setPath(raw, AMOUNT_GROUPS.q4[k4][0], amt());
    var q6 = answer.q6 || {};
    if (q6.federal && q6.federal.length) raw.q6.federal = q6.federal.join(', '); else raw.q6.federal_ns = true;
    if (q6.state === 'various') raw.q6.state_various = true;
    else if (q6.state && q6.state.length) raw.q6.state = q6.state.join(', ');
    else raw.q6.state_ns = true;
    var rows = [];
    if (q6.foreign && typeof q6.foreign === 'object') {
      for (var key in q6.foreign) { if (Object.prototype.hasOwnProperty.call(q6.foreign, key)) rows.push({j: key, y: String(q6.foreign[key])}); }
    }
    if (rows.length) raw.q6.foreign = rows; else raw.q6.foreign_ns = true;
    raw.flag = answer.flag === true;
    raw.comment = text(answer.comment);
    return raw;
  }

  /* ------------------------------------------------------------------ practice filing */

  /* The part of the typed entries that question q depends on (a checked result is valid while this stays the same). */
  function practiceSlice(rawIn, q) {
    var raw = mergeRaw(rawIn);
    if (q === 'q1') return [raw.q1];
    if (q === 'q6') return [raw.q1, raw.q6];
    return [raw.q1, raw.default_unit, raw[q]];
  }

  function close(a, b) { return Math.abs(a - b) <= Math.max(1e-6, 1e-9 * Math.abs(b)); }

  /* One amount of the practice filing against its known value. Returns {ok, text, group}. */
  function checkAmount(raw, path, spec) {
    var exp = spec.expect.amounts[path];
    var f = getPath(raw, path);
    var typed = f.v.trim();
    var nullNote = (spec.null_notes && spec.null_notes[path]) || 'The note does not give this value: tick "not given".';
    if (exp === null) {
      if (f.ng && !typed) return {ok: true};
      return {ok: false, text: (typed ? '' : 'not answered yet. ') + nullNote};
    }
    if (f.ng && !typed) return {ok: false, text: 'the note does give this value, so "not given" is not right.'};
    if (!typed) return {ok: false, text: 'not answered yet.'};
    var p = parseAmount(typed);
    if (p.error) return {ok: false, text: '"' + typed + '" is not a number.'};
    var unit = f.u || raw.default_unit;
    if (!UNITS[unit]) return {ok: false, text: 'choose the unit.'};
    var value = signed(path, p.value);
    var got = toMillions(value, unit);
    if (close(got, exp)) return {ok: true};
    for (var k in UNITS) {
      if (k === unit || !close(toMillions(value, k), exp)) continue;
      if (k === spec.unit && !f.u) return {ok: false, text: 'the number is right but the unit is not. The tables of this note are ' + UNIT_NAMES[k] + ': choose "' + UNIT_LONG[k] + '" under "Amounts are in".'};
      return {ok: false, text: 'the number is right but the unit is not: choose "' + UNIT_NAMES[k] + '" in the unit menu next to this amount.'};
    }
    var traps = (spec.traps && spec.traps[path]) || [];
    for (var t = 0; t < traps.length; t++) {
      if (close(got, traps[t][0])) return {ok: false, text: traps[t][2] ? '' : traps[t][1], group: traps[t][2] || null};
    }
    if (close(got, -exp)) return {ok: false, text: 'the sign is not right.'};
    return {ok: false, text: 'this is not the right number.'};
  }

  /* Returns {q1: {ok, reasons: [text]}, ..., q6: {...}} for the practice filing described by `spec`. */
  function checkPractice(rawIn, spec) {
    var raw = mergeRaw(rawIn);
    var E = spec.expect;
    var res = {};
    var res1 = {ok: raw.q1 === E.q1, reasons: []};
    if (!raw.q1) res1.reasons.push('Choose Yes or No.');
    else if (!res1.ok) res1.reasons.push(spec.q1_wrong || 'This is not the right answer.');
    res.q1 = res1;

    function amounts(paths, prefix) {
      var reasons = [];
      var groups = {};
      var order = [];
      for (var i = 0; i < paths.length; i++) {
        var r = checkAmount(raw, paths[i], spec);
        if (r.ok) continue;
        var label = prefix ? LABEL[paths[i]] + ': ' : '';
        if (r.group) {
          if (!groups[r.group]) { groups[r.group] = []; order.push(r.group); }
          groups[r.group].push(LABEL[paths[i]]);
        } else {
          var txt = r.text.charAt(0).toUpperCase() + r.text.slice(1);
          reasons.push(prefix ? label + r.text : txt);
        }
      }
      for (var g = 0; g < order.length; g++) {
        var gt = (spec.group_text && spec.group_text[order[g]]) || 'this is not the right number.';
        var standalone = groups[order[g]].length > 1 || !prefix;
        reasons.unshift(standalone ? gt.charAt(0).toUpperCase() + gt.slice(1) : groups[order[g]][0] + ': ' + gt);
      }
      return reasons;
    }

    res.q2 = {reasons: amounts(['q2'], false)};
    res.q3 = {reasons: amounts(['q3'], false)};
    if (raw.q4.no_table !== E.q4_no_table) {
      res.q4 = {reasons: [raw.q4.no_table ? (spec.q4_has_table || 'The note has a roll-forward table: untick "The note has no roll-forward table".')
                                         : 'The note has no roll-forward table: tick "The note has no roll-forward table".']};
    } else {
      res.q4 = {reasons: E.q4_no_table ? [] : amounts(AMOUNT_GROUPS.q4.map(function (x) { return x[0]; }), true)};
    }
    var q5 = amounts(['q5.accrued', 'q5.expense'], true);
    var acc = raw.q5.accrued;
    var exp = raw.q5.expense;
    var pa = parseAmount(acc.v);
    var pe = parseAmount(exp.v);
    var ua = acc.u || raw.default_unit;
    var ue = exp.u || raw.default_unit;
    if (spec.swap_q5 && pa.value != null && pe.value != null && UNITS[ua] && UNITS[ue] &&
        close(toMillions(pa.value, ua), E.amounts['q5.expense']) && close(toMillions(pe.value, ue), E.amounts['q5.accrued'])) {
      q5 = [spec.swap_q5];
    }
    res.q5 = {reasons: q5};

    var r6 = [];
    var q6 = raw.q6;
    if (q6.federal_ns) r6.push('U.S. federal: ' + (spec.federal_ns || 'the note does say which federal years are open.'));
    else if (!q6.federal.trim()) r6.push('U.S. federal: not answered yet.');
    else {
      var fed = parseYears(q6.federal);
      if (fed.error) r6.push('U.S. federal: ' + fed.error);
      else if (fed.years.join(',') !== E.federal.join(',')) {
        var hit = null;
        var ft = spec.federal_traps || [];
        for (var t = 0; t < ft.length; t++) if (ft[t][0].join(',') === fed.years.join(',')) hit = ft[t][1];
        r6.push('U.S. federal: ' + (hit || 'these are not the open years.'));
      }
    }
    var stateTyped = q6.state.trim() !== '';
    if (E.state === 'not_stated') {
      if (!q6.state_ns && !q6.state_various && !stateTyped) r6.push('U.S. states: not answered yet.');
      else if (!q6.state_ns || q6.state_various || stateTyped) r6.push('U.S. states: ' + (spec.state_wrong || 'the note does not say which state years are open: tick "not stated".'));
    }
    var rows = [];
    for (var k = 0; k < q6.foreign.length; k++) {
      var j = q6.foreign[k].j.trim();
      var y = q6.foreign[k].y.trim();
      if (j || y) rows.push({j: j, y: y});
    }
    var F = E.foreign;
    if (q6.foreign_ns) r6.push('Foreign countries: ' + (spec.foreign_ns || 'the note does give foreign years.'));
    else if (!rows.length) r6.push('Foreign countries: not answered yet.');
    else if (rows.length > 1) r6.push('Foreign countries: ' + (spec.foreign_many || 'the note names one group only.'));
    else if (!rows[0].j || !rows[0].y) r6.push('Foreign countries: give both the name and the years.');
    else {
      if (!new RegExp(F.name, 'i').test(rows[0].j)) r6.push('Foreign countries: ' + (spec.foreign_name || 'name the countries the way the note names them.'));
      var ys = yearSpec(rows[0].y);
      if (!ys || ys.from !== F.from || !(ys.to === null || ys.to === F.to)) r6.push('Foreign countries: ' + (spec.foreign_years || 'these are not the open years.'));
    }
    res.q6 = {reasons: r6};
    for (var qq in res) if (Object.prototype.hasOwnProperty.call(res, qq)) res[qq].ok = res[qq].reasons.length === 0;
    return res;
  }

  /* ---- the texts of the supervisor's Restore account: pure functions, so that every case can be tested ---- */
  function nFilings(n, what) { return n + ' ' + (what ? what + ' ' : '') + 'filing' + (n === 1 ? '' : 's'); }

  /* What restoring will do, as the confirmation says it. u = the account in the overview (assigned, freed = unfinished
     filings freed when it was deleted, freed_free = how many of those nobody took); free = filings free now.
     The numbers follow restoreAccount_ in the backend: the still-free ones come back, each taken one is replaced by
     another free filing as long as any are free. */
  function restorePlan(u, free) {
    var freed = Math.max(0, Number(u && u.freed) || 0);
    var back = Math.min(Math.max(0, Number(u && u.freed_free) || 0), freed);
    var gone = freed - back;
    var others = Math.min(gone, Math.max(0, (Number(free) || 0) - back));
    var parts = [];
    if (!freed) {
      parts.push('It keeps its ' + nFilings(Number(u && u.assigned) || 0) + '.');
    } else if (!gone) {
      parts.push('It gets back the ' + nFilings(freed, 'unfinished') + ' that went back to the pool when it was deleted.');
    } else {
      parts.push('When it was deleted, ' + nFilings(freed, 'unfinished') + ' went back to the pool.');
      parts.push(back ? back + (back === 1 ? ' is' : ' are') + ' still free and ' + (back === 1 ? 'comes' : 'come') + ' back; other evaluators took ' + gone + '.'
                      : 'Other evaluators took all of them.');
      parts.push(others === gone ? 'In their place it gets ' + nFilings(others, 'other free') + '.'
        : (others ? 'In their place it gets ' + nFilings(others, 'other free') + ', all that are free.' : 'No other filings are free to put in their place.'));
    }
    return {back: back, gone: gone, others: others, short: gone - others, text: parts.join(' ')};
  }

  /* What the page says after a restore. r = the reply of restore_account. */
  function restoredText(r) {
    var text = '"' + r.user_id + '" is restored and can log in again with its password. It has ' + nFilings(r.assigned) + ', ' +
      r.answered + ' of them answered.';
    var got = [];
    if (r.back) got.push(r.back + ' of its unfinished filings came back');
    if (r.added) got.push(nFilings(r.added, 'other free') + (r.added === 1 ? ' replaces' : ' replace') + ' ones others took');
    if (got.length) text += ' ' + got.join(' and ') + '.';
    if (r.short) text += ' ' + r.short + (r.short === 1 ? ' was' : ' were') + ' not replaced because no filings are free; use Number of filings when some are free.';
    return text;
  }

  var api = {
    UNITS: UNITS, UNIT_NAMES: UNIT_NAMES, UNIT_LONG: UNIT_LONG, AMOUNT_GROUPS: AMOUNT_GROUPS, ALL_AMOUNTS: ALL_AMOUNTS,
    blankRaw: blankRaw, mergeRaw: mergeRaw, getPath: getPath, setPath: setPath, parseAmount: parseAmount,
    isParenthesized: isParenthesized, signed: signed, parseYears: parseYears, yearSpec: yearSpec, toMillions: toMillions,
    computeAnswer: computeAnswer, tieOut: tieOut, problemLines: problemLines, rawFromAnswer: rawFromAnswer,
    practiceSlice: practiceSlice, checkPractice: checkPractice, fmt: fmt, labelOf: labelOf,
    restorePlan: restorePlan, restoredText: restoredText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UTPLogic = api;
})(typeof window !== 'undefined' ? window : this);
