/* Cabinet Order Translator — main app logic
 * Loads cabinet KB, parses dropped PDF, translates codes, renders result.
 */

(function () {
  'use strict';

  // ---------- State ----------
  let KB = null;

  // ---------- DOM ----------
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const loading = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const results = document.getElementById('results');
  const resultsContent = document.getElementById('resultsContent');
  const printBtn = document.getElementById('printBtn');
  const copyHtmlBtn = document.getElementById('copyHtmlBtn');
  const newBtn = document.getElementById('newBtn');

  // ---------- Init ----------
  fetch('cabinet-kb.json')
    .then(r => r.json())
    .then(data => { KB = data; })
    .catch(err => showError('Failed to load knowledge base: ' + err.message));

  // ---------- File handling ----------
  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragging');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  printBtn.addEventListener('click', () => window.print());
  copyHtmlBtn.addEventListener('click', () => {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Cabinet Order Translation</title><style>${getInlineCSS()}</style></head><body class="result">${resultsContent.innerHTML}</body></html>`;
    navigator.clipboard.writeText(html).then(() => {
      copyHtmlBtn.textContent = 'Copied!';
      setTimeout(() => copyHtmlBtn.textContent = 'Copy HTML', 1500);
    });
  });
  newBtn.addEventListener('click', () => {
    results.classList.add('hidden');
    errorEl.classList.add('hidden');
    dropzone.classList.remove('hidden');
    fileInput.value = '';
  });

  function handleFile(file) {
    if (!file.type.includes('pdf')) {
      showError('That doesn\'t look like a PDF. Please drop a PDF file.');
      return;
    }
    if (!KB) {
      showError('Knowledge base still loading — give it a second and try again.');
      return;
    }
    showLoading();
    const reader = new FileReader();
    reader.onload = function (e) {
      processArrayBuffer(e.target.result);
    };
    reader.onerror = function () {
      showError('Could not read file.');
    };
    reader.readAsArrayBuffer(file);
  }

  // ---------- PDF processing ----------
  async function processArrayBuffer(buf) {
    try {
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        pages.push(tc);
      }
      const text = extractStructuredText(pages);
      const result = translate(text);
      renderResult(result);
      showResults();
    } catch (err) {
      console.error(err);
      showError('Error reading PDF: ' + err.message);
    }
  }

  /** Extract text with positional grouping into lines */
  function extractStructuredText(pages) {
    const lines = [];
    pages.forEach(tc => {
      // Group text items by Y-coordinate (within 2px)
      const items = tc.items.filter(it => it.str !== undefined);
      const rows = {};
      items.forEach(it => {
        const y = Math.round(it.transform[5]);
        // Snap to nearest 2px to group line text
        const key = Math.round(y / 2) * 2;
        if (!rows[key]) rows[key] = [];
        rows[key].push({ x: it.transform[4], str: it.str });
      });
      // Sort rows top-to-bottom (PDF Y increases upward, so descending Y = top)
      Object.keys(rows)
        .map(Number)
        .sort((a, b) => b - a)
        .forEach(y => {
          const row = rows[y].sort((a, b) => a.x - b.x);
          const line = row.map(r => r.str).join(' ').replace(/\s+/g, ' ').trim();
          if (line) lines.push(line);
        });
      lines.push('---PAGEBREAK---');
    });
    return lines.join('\n');
  }

  // ---------- Translation engine ----------
  function translate(text) {
    const line = identifyLine(text);
    const lineKB = KB.lines[line] || null;
    const header = parseHeader(text);
    const items = parseLineItems(text);
    const translated = items.map(it => translateItem(it, lineKB));
    const totals = parseTotals(text);
    const uncertain = translated.filter(t => t.uncertain).map(t => ({ code: t.stockCode, why: t.uncertainReason }));

    return {
      line,
      lineKB,
      header,
      items: translated,
      totals,
      uncertain
    };
  }

  function identifyLine(text) {
    const t = text.toLowerCase();
    // Order matters: more specific first (Bria/Crestwood before generic Dura)
    if (t.includes('shiloh cabinetry') || t.includes('shiloh') && t.includes('wwinc')) return 'shiloh';
    if (t.includes('eclipse cabinetry') || t.includes('eclipsecabinetry.com')) return 'eclipse';
    if (t.includes('bria') && t.includes('dura')) return 'dura-bria';
    if (t.includes('crestwood') && t.includes('dura')) return 'dura-crestwood';
    if (t.includes('dura supreme')) return 'dura-crestwood'; // default Dura → Crestwood (more common)
    if (t.includes('w w wood products') || t.includes('wwinc.com')) {
      // W.W. Wood — could be Shiloh or Eclipse; try door style hints
      if (t.includes('metro') || t.includes('eclipse')) return 'eclipse';
      return 'shiloh';
    }
    return 'unknown';
  }

  function parseHeader(text) {
    const h = {};
    const grab = (re) => {
      const m = text.match(re);
      return m ? m[1].trim() : null;
    };
    h.orderNumber = grab(/Order Number[:\s]+(\d+)/i);
    h.orderDate = grab(/Order Date[:\s]+([\d/]+)/i);
    h.poNumber = grab(/PO Number[:\s]+(\S+)/i);
    h.dealer = grab(/Name[:\s]+([^\n]+?)(?=\s+(?:Species|Color|Dealer))/i);
    h.dealerNumber = grab(/Dealer Number[:\s]+(\d+)/i);
    h.jobName = grab(/Job Name[:\s]+([^\n]+?)(?=\s+(?:Distressed|Wearing|Sand|Brushing|Glaze|Ship|$))/i);
    h.shipDate = grab(/Ship Date[:\s]+([^\n]+?)(?=\s+(?:Wearing|Drawer|Sand|Glaze|$))/i);
    h.shipVia = grab(/Ship Via[:\s]+([^\n]+?)(?=\s+(?:Sand|Brushing|$))/i);
    h.species = grab(/Species[:\s]+(\w+)/i);
    h.color = grab(/Color[:\s]+(\w+)/i);
    h.glaze = grab(/Glaze[:\s]+(\S+)/i);
    h.distressed = grab(/Distressed[:\s]+(\S+)/i);
    h.wearing = grab(/Wearing[:\s]+(\S+)/i);
    h.sandThrough = grab(/Sand-Through[:\s]+(\S+)/i);
    h.brushing = grab(/Brushing[:\s]+(\S+)/i);
    h.upper = grab(/Upper[:\s]+(\S+)/i);
    h.lower = grab(/Lower[:\s]+(\S+)/i);
    h.edge = grab(/Edge[:\s]+(\d+)/i);
    h.hinge = grab(/Hinge[:\s]+(\w+)/i);
    h.drawerType = grab(/Drawer Type[:\s]+([^\n]+?)(?=\s+(?:Drawer Head|Guide|Hinge|$))/i);
    h.drawerHead = grab(/Drawer Head[:\s]+([\w-]+)/i);
    h.guideType = grab(/Guide Type[:\s]+([\w-]+)/i);
    h.blumotion = grab(/Blumotion For Doors[:\s]+(\S+)/i);
    return h;
  }

  function parseLineItems(text) {
    const items = [];
    // Each line item starts with: cab# (1-3 digits) followed by qty (1-3 digits) followed by something
    // Then Fin End / Hinge / Price typically follow
    // Price is the last column, format: dd,ddd.dd or d.dd
    const lines = text.split('\n');
    lines.forEach(raw => {
      // Match: leading number (cab#), qty, then everything else, then price at end
      // Be tolerant of "16 Ft" and similar quantity formats
      const m = raw.match(/^(\d{1,3})\s+(\d+(?:\s*Ft)?)\s+(.+?)\s+([\d,]+\.\d{2})\s*$/);
      if (m) {
        const cab = m[1];
        const qty = m[2];
        const middle = m[3].trim();
        const price = parseFloat(m[4].replace(/,/g, ''));
        // Try to extract Fin End and Hinge from end of middle
        // Common patterns: "L/R LRLR" or "L LL" or "" or "N" or "RR" etc.
        // Fin End and Hinge are typically 1-4 chars, all uppercase letters or slashes
        const finHingeMatch = middle.match(/^(.+?)\s+([LRN/]{1,2})\s+([LRN]{1,4})\s*$/);
        let stockDesc, finEnd, hinge;
        if (finHingeMatch) {
          stockDesc = finHingeMatch[1].trim();
          finEnd = finHingeMatch[2];
          hinge = finHingeMatch[3];
        } else {
          // Try just hinge
          const hingeOnly = middle.match(/^(.+?)\s+([LRN]{1,4})\s*$/);
          if (hingeOnly) {
            stockDesc = hingeOnly[1].trim();
            hinge = hingeOnly[2];
          } else {
            stockDesc = middle;
          }
        }
        items.push({ cab, qty, stockDesc, finEnd: finEnd || '', hinge: hinge || '', price });
      }
    });
    return items;
  }

  function parseTotals(text) {
    const grab = (re) => {
      const m = text.match(re);
      return m ? parseFloat(m[1].replace(/,/g, '')) : null;
    };
    return {
      cabinetTotal: grab(/Cabinet Total\s+([\d,.]+)/i),
      upchargeWoodSpecies: grab(/Upcharge For Wood Species\s+([\d,.]+)/i),
      upchargeColor: grab(/Upcharge For Color\s+([\d,.]+)/i),
      upchargeFullOverlayDoors: grab(/Upcharge For Full Overlay Doors\s+([\d,.]+)/i),
      upchargeDrawerGuides: grab(/Upcharge For Drawer Guides\s+([\d,.]+)/i),
      subtotal: grab(/Subtotal\s+([\d,.]+)/i),
      dealerDiscount: grab(/Dealer Discount\s+([\d,.]+)/i),
      orderAmount: grab(/Order Amount[^\n]+\s+([\d,.]+)/i)
    };
  }

  function translateItem(item, lineKB) {
    const result = Object.assign({}, item);
    if (!lineKB) {
      result.description = item.stockDesc;
      result.uncertain = true;
      result.uncertainReason = 'Unknown cabinet line';
      return result;
    }

    const stockDesc = item.stockDesc;
    // Split off the description after the first comma
    const firstComma = stockDesc.indexOf(',');
    const codePart = firstComma > -1 ? stockDesc.substring(0, firstComma).trim() : stockDesc.trim();
    const descPart = firstComma > -1 ? stockDesc.substring(firstComma + 1).trim() : '';

    // Find the matching prefix (longest match wins to handle UVTDEP before UVT, etc.)
    const prefixes = Object.keys(lineKB.prefixes).sort((a, b) => b.length - a.length);
    let matchedPrefix = null;
    let dimensionStr = '';
    for (const p of prefixes) {
      // Match prefix at start, followed by digit/space/quote/special
      const re = new RegExp('^' + escapeRegex(p) + '(?=\\d|\\s|$|\\W)');
      if (re.test(codePart)) {
        matchedPrefix = p;
        dimensionStr = codePart.substring(p.length).trim();
        break;
      }
    }

    // Build description
    if (matchedPrefix) {
      const prefixInfo = lineKB.prefixes[matchedPrefix];
      let desc = prefixInfo.name;
      if (dimensionStr) desc += ` — ${parseDimensions(matchedPrefix, dimensionStr)}`;
      // Decode modifiers in descPart
      const modifierDecode = decodeModifiers(descPart, lineKB);
      if (modifierDecode.decoded.length) {
        desc += ' [' + modifierDecode.decoded.join(', ') + ']';
      }
      if (prefixInfo.note && !desc.includes('See ')) {
        desc += ` (${prefixInfo.note})`;
      }
      result.description = desc;
      result.matchedPrefix = matchedPrefix;
      result.category = categoryOf(matchedPrefix, lineKB);
      result.uncertain = modifierDecode.uncertain.length > 0;
      result.uncertainReason = modifierDecode.uncertain.length > 0 ? 'Some modifiers not in KB: ' + modifierDecode.uncertain.join(', ') : '';
    } else {
      // Maybe it's a moulding (e.g. "1/4\"FPS", "3/4 SB", "3SRM 10 F")
      const mouldingMatch = matchMoulding(stockDesc, lineKB);
      if (mouldingMatch) {
        result.description = mouldingMatch;
        result.category = 'moulding';
        result.uncertain = false;
      } else {
        // Maybe a touch-up code
        const touchupMatch = matchTouchup(stockDesc, lineKB);
        if (touchupMatch) {
          result.description = touchupMatch;
          result.category = 'touchup';
          result.uncertain = false;
        } else {
          // OXRP NO EDGE or specialty panels
          if (codePart.includes('OXRP') || stockDesc.includes('OXRP')) {
            result.description = `Custom panel — Oxford Raised Panel style. ${stockDesc}`;
            result.category = 'panel';
            result.uncertain = false;
          } else if (codePart.includes('FPS') || codePart.includes('FLS')) {
            result.description = `Finished plywood scribe panel. ${stockDesc}`;
            result.category = 'scribe';
            result.uncertain = false;
          } else if (stockDesc.toUpperCase() === 'VOID') {
            result.description = 'Voided line — ignore';
            result.category = 'touchup';
            result.uncertain = false;
          } else if (stockDesc.toUpperCase() === 'CLIPS') {
            result.description = 'Shelf clips (free)';
            result.category = 'touchup';
            result.uncertain = false;
          } else {
            result.description = stockDesc;
            result.uncertain = true;
            result.uncertainReason = `Code "${codePart}" not recognized in ${lineKB.displayName} KB`;
            result.category = 'unknown';
          }
        }
      }
    }
    return result;
  }

  function parseDimensions(prefix, dimStr) {
    // Common patterns:
    //   B36 → 36" wide
    //   B36-3 → 36" wide, 3-drawer
    //   W3027 → 30"w × 27"h
    //   F6102 → 6"w × 102"h (filler)
    //   REP1.5102-FTK27 → 1.5" thick × 102"h × 27"d, foot toe kick
    //   RH21 3630 → 21" deep, 36"w × 30"h (range hood, depth-first)
    //   SW1248(12) → 12"w × 48"h × 12"d
    const trimmed = dimStr.trim();
    if (!trimmed) return '';

    // SW##(12) → has explicit depth in parens
    const swMatch = trimmed.match(/^(\d{2,4})\((\d+)\)/);
    if (swMatch) {
      return parseWH(swMatch[1]) + ' × ' + swMatch[2] + '" deep';
    }

    // RH (depth first): RH21 3630 → "21" deep, 36" × 30""
    if (prefix === 'RH') {
      const rhMatch = trimmed.match(/^(\d+)\s+(\d{4,})/);
      if (rhMatch) return rhMatch[1] + '" deep, ' + parseWH(rhMatch[2]);
    }

    // REP: thickness then height (e.g. 1.5102 = 1.5" thick × 102" tall), then -FTK or -RCK then depth
    if (prefix === 'REP') {
      const repMatch = trimmed.match(/^(\d+(?:\.\d+)?)(\d{2,3})(?:-(FTK|RCK))?-?(\d+)?(?:-(L|R))?/);
      if (repMatch) {
        const parts = [repMatch[1] + '" thick', repMatch[2] + '" tall'];
        if (repMatch[4]) parts.push(repMatch[4] + '" deep');
        if (repMatch[3]) parts.push(repMatch[3] === 'FTK' ? 'with foot toe kick' : 'with roll-out rack');
        if (repMatch[5]) parts.push(repMatch[5] === 'L' ? 'left' : 'right');
        return parts.join(', ');
      }
    }

    // B36-3: width then -drawer count
    const bMatch = trimmed.match(/^(\d{1,3})(?:-(\d))?$/);
    if (bMatch) {
      let s = bMatch[1] + '" wide';
      if (bMatch[2]) s += `, ${bMatch[2]}-drawer stack`;
      return s;
    }

    // W3027 / F6102: 4 digit code = WWHH or WHH
    const whMatch = trimmed.match(/^(\d{4,5})/);
    if (whMatch) {
      return parseWH(whMatch[1]);
    }

    return trimmed;
  }

  function parseWH(num) {
    // Try to parse as WWHH: e.g. 3027 = 30w × 27h, 1248 = 12w × 48h
    // 5 digits could be WWHHH or WWWHH; pick the most common pattern
    const s = String(num);
    if (s.length === 4) {
      return s.substring(0, 2) + '"w × ' + s.substring(2) + '"h';
    } else if (s.length === 5) {
      // E.g. 27102 = 27w × 102h, OR 31 1/2 102 (but fractions handled separately)
      return s.substring(0, 2) + '"w × ' + s.substring(2) + '"h';
    } else if (s.length === 3) {
      return s.substring(0, 1) + '"w × ' + s.substring(1) + '"h';
    }
    return num;
  }

  function decodeModifiers(descPart, lineKB) {
    const decoded = [];
    const uncertain = [];
    if (!descPart) return { decoded, uncertain };
    // Split on commas, decode each
    const parts = descPart.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    parts.forEach(part => {
      // Direct match
      if (lineKB.modifiers[part]) {
        decoded.push(lineKB.modifiers[part]);
        return;
      }
      // ER-3.000 / EL-3.000
      const erMatch = part.match(/^(ER|EL)-(\d+(?:\.\d+)?)/);
      if (erMatch) {
        const side = erMatch[1] === 'ER' ? 'right' : 'left';
        decoded.push(`${side} end shaved ${parseFloat(erMatch[2])}"`);
        return;
      }
      // RCK-RIGHT / RCK-LEFT
      if (/^RCK-(LEFT|RIGHT)$/i.test(part)) {
        decoded.push(`Roll-out rack ${part.split('-')[1].toLowerCase()}`);
        return;
      }
      // Custom dimensions like "24" Deep" or "27" Deep"
      const depthMatch = part.match(/(\d+(?:\s*\d+\/\d+)?)" Deep/i);
      if (depthMatch) {
        decoded.push(`${depthMatch[1]}" deep`);
        return;
      }
      // BTM OPNG measurements like "28 1/4"BTM OPNG"
      const btmMatch = part.match(/(\d+(?:\s*\d+\/\d+)?)"?\s*BTM OPNG/i);
      if (btmMatch) {
        decoded.push(`bottom opening ${btmMatch[1]}"`);
        return;
      }
      // ATT TO RIGHT/LEFT OF #X
      const attMatch = part.match(/ATT TO (RIGHT|LEFT) OF #(\d+)/i);
      if (attMatch) {
        decoded.push(`attached to ${attMatch[1].toLowerCase()} of cab #${attMatch[2]}`);
        return;
      }
      // GF UPPER LEFT ONLY etc
      if (/GF UPPER/i.test(part)) {
        decoded.push('glass front upper' + (/LEFT ONLY/i.test(part) ? ' (left side only)' : ''));
        return;
      }
      // 32"TALL etc
      const tallMatch = part.match(/(\d+)"?\s*TALL/i);
      if (tallMatch) {
        decoded.push(`${tallMatch[1]}" tall (non-standard)`);
        return;
      }
      // See Drawing
      if (/^See Drawing/i.test(part)) {
        decoded.push('see drawing for custom internals');
        return;
      }
      // Otherwise, unknown — flag
      if (part.length > 0 && part.length < 40) {
        uncertain.push(part);
      }
    });
    return { decoded, uncertain };
  }

  function categoryOf(prefix, lineKB) {
    for (const cat in lineKB.categories) {
      if (lineKB.categories[cat].includes(prefix)) return cat;
    }
    return 'cabinet';
  }

  function matchMoulding(stockDesc, lineKB) {
    const upper = stockDesc.toUpperCase();
    // 3SRM 10 F / 3SRM10F variants
    const sub = upper.match(/(\d(?:\s*\d\/\d)?)\s*SRM\s*(\d+)?\s*F?/);
    if (sub) {
      const size = sub[1].replace(/\s+/g, '');
      const lengthFt = sub[2] ? `, ${sub[2]}ft sticks` : '';
      return `${size}" Sub-Rail Moulding${lengthFt}`;
    }
    // X 1/4 FCR / 4 1/4 FCR / 3FCR
    const fcr = upper.match(/(\d(?:\s*\d\/\d)?)\s*FCR/);
    if (fcr) {
      return `${fcr[1].replace(/\s+/g, ' ')}" Furniture Crown Moulding`;
    }
    // X UC
    const uc = upper.match(/(\d(?:\s*\d\/\d{1,2})?)\s*UC/);
    if (uc) {
      return `${uc[1].replace(/\s+/g, ' ')}" Under-Cabinet light rail`;
    }
    // X TD
    const td = upper.match(/(\d(?:\/\d)?)\s*TD/);
    if (td) {
      return `${td[1]}" Top Detail moulding`;
    }
    // X SB / 3/4 SB
    const sb = upper.match(/(\d(?:\/\d)?)\s*SB(?!\d)/);
    if (sb) {
      return `${sb[1]}" Scribe / Single Bead stock`;
    }
    // TK alone
    if (/^TK\b/.test(upper) || upper === 'TK') {
      return `Toe Kick stock`;
    }
    // FPS / FLS
    if (/^1\/4"?FPS/i.test(stockDesc) || /^FPS/i.test(stockDesc)) {
      const dims = stockDesc.match(/[\d/\s]+x[\d/\s]+/i);
      return 'Finished Plywood Scribe panel' + (dims ? ', ' + dims[0] : '');
    }
    if (/^FLS/i.test(stockDesc)) {
      const dims = stockDesc.match(/[\d/\s]+x[\d/\s]+/i);
      return 'Filler-Liner Side panel' + (dims ? ', ' + dims[0] : '');
    }
    return null;
  }

  function matchTouchup(stockDesc, lineKB) {
    const upper = stockDesc.toUpperCase().trim();
    if (/^TUB/i.test(upper)) {
      const color = stockDesc.replace(/^TUB\s*/i, '').trim();
      return `Touch-up bottle${color ? ' — ' + color : ''}`;
    }
    if (/^TUK/i.test(upper)) return 'Touch-up kit';
    if (/^WTD/i.test(upper)) return 'Wood touch-up marker';
    if (upper === 'CLIPS') return 'Shelf clips (free)';
    if (upper === 'VOID') return 'Voided line — ignore';
    return null;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---------- Render ----------
  function renderResult(r) {
    const h = r.header;
    const lineDisplay = r.lineKB ? r.lineKB.displayName : '(line not identified)';
    const groups = groupItemsByCategory(r.items);
    const html = `
<div class="result">
  <h1>${escapeHtml(lineDisplay)} Order ${escapeHtml(h.orderNumber || '?')} — ${escapeHtml(h.jobName || 'Job')}</h1>

  <div class="meta">
    <div><strong>Order Number:</strong> ${esc(h.orderNumber)}</div>
    <div><strong>Order Date:</strong> ${esc(h.orderDate)}</div>
    <div><strong>PO Number:</strong> ${esc(h.poNumber)}</div>
    <div><strong>Dealer:</strong> ${esc(h.dealer)}${h.dealerNumber ? ' (#' + esc(h.dealerNumber) + ')' : ''}</div>
    <div><strong>Job:</strong> ${esc(h.jobName)}</div>
    <div><strong>Ship:</strong> ${esc(h.shipDate)}${h.shipVia ? ' · ' + esc(h.shipVia) : ''}</div>
  </div>

  <h2>Finishing &amp; Door Specs</h2>
  <table>
    <tr><td><strong>Species</strong></td><td>${esc(h.species)}</td><td><strong>Edge / Profile</strong></td><td>${esc(h.edge)}</td></tr>
    <tr><td><strong>Color</strong></td><td>${esc(h.color)}</td><td><strong>Drawer Head</strong></td><td>${esc(h.drawerHead)}${decodeAside(h.drawerHead, r.lineKB?.drawerHeads)}</td></tr>
    <tr><td><strong>Glaze</strong></td><td>${esc(h.glaze)}</td><td><strong>Drawer Type</strong></td><td>${esc(h.drawerType)}</td></tr>
    <tr><td><strong>Distressed/Wear/Sand-thru</strong></td><td>${esc(h.distressed) || '–'} / ${esc(h.wearing) || '–'} / ${esc(h.sandThrough) || '–'}</td><td><strong>Guide Type</strong></td><td>${esc(h.guideType)}${decodeAside(h.guideType, r.lineKB?.drawerGuides)}</td></tr>
    <tr><td><strong>Door Style — Upper</strong></td><td>${esc(h.upper)}${decodeAside(h.upper, r.lineKB?.doorStyles)}</td><td><strong>Hinge</strong></td><td>${esc(h.hinge)}</td></tr>
    <tr><td><strong>Door Style — Lower</strong></td><td>${esc(h.lower)}${decodeAside(h.lower, r.lineKB?.doorStyles)}</td><td><strong>Blumotion on Doors</strong></td><td>${esc(h.blumotion)}</td></tr>
  </table>

  ${renderGroup('Cabinets', groups.cabinet)}
  ${renderGroup('Panels & End Pieces', groups.panel)}
  ${renderGroup('Fillers', groups.filler)}
  ${renderGroup('Mouldings & Trim', groups.moulding)}
  ${renderGroup('Finished Plywood / Scribe Panels', groups.scribe)}
  ${renderGroup('Touch-up & Accessories', groups.touchup)}
  ${groups.unknown && groups.unknown.length ? renderGroup('Unrecognized — Verify', groups.unknown) : ''}

  <h2>Order Totals</h2>
  <table>
    ${r.totals.cabinetTotal ? `<tr><td><strong>Cabinet Total</strong></td><td class="amount">$${fmtMoney(r.totals.cabinetTotal)}</td></tr>` : ''}
    ${r.totals.upchargeWoodSpecies ? `<tr><td>Upcharge — Wood Species</td><td class="amount">$${fmtMoney(r.totals.upchargeWoodSpecies)}</td></tr>` : ''}
    ${r.totals.upchargeColor ? `<tr><td>Upcharge — Color</td><td class="amount">$${fmtMoney(r.totals.upchargeColor)}</td></tr>` : ''}
    ${r.totals.upchargeFullOverlayDoors ? `<tr><td>Upcharge — Full Overlay Doors</td><td class="amount">$${fmtMoney(r.totals.upchargeFullOverlayDoors)}</td></tr>` : ''}
    ${r.totals.upchargeDrawerGuides ? `<tr><td>Upcharge — Drawer Guides</td><td class="amount">$${fmtMoney(r.totals.upchargeDrawerGuides)}</td></tr>` : ''}
    ${r.totals.subtotal ? `<tr><td><strong>Subtotal</strong></td><td class="amount"><strong>$${fmtMoney(r.totals.subtotal)}</strong></td></tr>` : ''}
    ${r.totals.dealerDiscount ? `<tr><td>Dealer Discount</td><td class="amount">−$${fmtMoney(r.totals.dealerDiscount)}</td></tr>` : ''}
    ${r.totals.orderAmount ? `<tr><td><strong>Order Amount (sales tax not included)</strong></td><td class="amount"><strong>$${fmtMoney(r.totals.orderAmount)}</strong></td></tr>` : ''}
  </table>

  ${r.uncertain.length ? `
  <div class="note">
    <strong>Codes flagged for verification:</strong>
    <ul style="margin: 6px 0 0 18px; padding: 0;">
      ${r.uncertain.map(u => `<li><code>${escapeHtml(u.code || '?')}</code> — ${escapeHtml(u.why)}</li>`).join('')}
    </ul>
    <div style="margin-top: 8px;">Contact ${r.lineKB?.customerService ? '<strong>' + r.lineKB.customerService + '</strong>' : 'manufacturer customer service'} for verification.</div>
  </div>
  ` : ''}

  <div class="footer">
    Generated ${new Date().toISOString().slice(0, 10)} · Cabinet KB v${r.lineKB?.catalog_version || ''} · E.F. San Juan Cabinet Order Translator
  </div>
</div>
    `;
    resultsContent.innerHTML = html;
  }

  function renderGroup(title, items) {
    if (!items || items.length === 0) return '';
    return `
<h2>${escapeHtml(title)}</h2>
<table>
  <thead>
    <tr><th>Cab #</th><th>Qty</th><th>Stock Code</th><th>What it is</th><th>Fin End / Hinge</th><th>Price</th></tr>
  </thead>
  <tbody>
    ${items.map(it => `
    <tr>
      <td class="cab">${escapeHtml(it.cab)}</td>
      <td class="qty">${escapeHtml(it.qty)}</td>
      <td class="code">${escapeHtml(extractStockCode(it))}</td>
      <td>${escapeHtml(it.description)}${it.uncertain ? ' <span class="badge-uncertain">verify</span>' : ''}</td>
      <td>${escapeHtml((it.finEnd || '') + (it.hinge ? ' / ' + it.hinge : ''))}</td>
      <td class="amount">${it.price ? '$' + fmtMoney(it.price) : ''}</td>
    </tr>
    `).join('')}
  </tbody>
</table>
    `;
  }

  function extractStockCode(it) {
    const sd = it.stockDesc || '';
    const firstComma = sd.indexOf(',');
    return firstComma > -1 ? sd.substring(0, firstComma).trim() : sd.trim();
  }

  function groupItemsByCategory(items) {
    const groups = { cabinet: [], panel: [], filler: [], moulding: [], scribe: [], touchup: [], unknown: [] };
    items.forEach(it => {
      const cat = it.category || 'unknown';
      if (groups[cat]) groups[cat].push(it);
      else groups.unknown.push(it);
    });
    return groups;
  }

  function decodeAside(value, dict) {
    if (!value || !dict) return '';
    const v = value.trim();
    if (dict[v]) return ` <span style="color:#666;">— ${escapeHtml(dict[v])}</span>`;
    return '';
  }

  function fmtMoney(n) {
    if (n === null || n === undefined) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function esc(s) {
    return s ? escapeHtml(s) : '–';
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function getInlineCSS() {
    // For copy-as-html — minimal print-friendly CSS
    return `body{font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:10.5pt;color:#000;padding:18px;}h1{font-size:16pt;border-bottom:2px solid #000;padding-bottom:6px;}h2{font-size:12pt;background:#000;color:#fff;padding:5px 10px;}table{border-collapse:collapse;width:100%;font-size:10pt;margin:4px 0 12px;}th,td{border:1px solid #555;padding:5px 8px;text-align:left;vertical-align:top;}th{background:#e8e8e8;}td.cab{width:60px;text-align:center;font-weight:bold;}td.code{font-family:Consolas,monospace;font-size:9.5pt;}td.amount{text-align:right;font-family:Consolas,monospace;}.note{background:#fff7d6;border:1px solid #d4b400;padding:10px 14px;margin:14px 0;}`;
  }

  // ---------- UI helpers ----------
  function showLoading() {
    dropzone.classList.add('hidden');
    results.classList.add('hidden');
    errorEl.classList.add('hidden');
    loading.classList.remove('hidden');
  }
  function showResults() {
    loading.classList.add('hidden');
    errorEl.classList.add('hidden');
    results.classList.remove('hidden');
    dropzone.classList.add('hidden');
  }
  function showError(msg) {
    loading.classList.add('hidden');
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    dropzone.classList.remove('hidden');
  }

})();
