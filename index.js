// Khata Dispatch Bot
// Telegram bot that lets you build a Sale / Purchase / Both entry on the go,
// produces the fixed dispatch-message format, gives a WhatsApp send button
// when a phone number is known, and drops a queue entry for Khata to pick up.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing BOT_TOKEN environment variable.');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const STOCK_FILE = path.join(DATA_DIR, 'stock.json');
const PARTIES_FILE = path.join(DATA_DIR, 'parties.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');

// Challan numbers use their own O- series so they never clash with
// Khata's internal voucher numbering. The O- number is only a
// cross-reference tag; Khata assigns its own number when the entry lands.
const CHLN_PREFIX = 'O-';

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJSON(file, data) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getStock() { return readJSON(STOCK_FILE, []); }
function getParties() { return readJSON(PARTIES_FILE, []); }
function getState() { return readJSON(STATE_FILE, { lastChallanNo: 0 }); }
function setState(s) { writeJSON(STATE_FILE, s); }
function pushQueue(entry) {
  const q = readJSON(QUEUE_FILE, []);
  q.push(entry);
  writeJSON(QUEUE_FILE, q);
}

function chlnLabel(n) {
  return `${CHLN_PREFIX}${n}`;
}

/* ------------------------------------------------------------------
   SEARCH  —  matches the way Khata's own product search behaves.

   normalizeForMatch strips everything that people type inconsistently:
   spaces, dots, hyphens, commas, slashes, brackets and the "x" in sizes.
   So "8x4", "8 x 4" and "84" all become "84", and "18 mm" becomes "18mm".

   matchesQuery splits what you typed on spaces and requires EVERY
   fragment to appear somewhere in the name. Because each fragment is
   tested independently, the order you type them in does not matter:
   "8x4 18" and "18 8x4" give exactly the same result.

   If a single glued query like "1884" finds nothing, we retry by
   splitting it into size-like chunks, so "1884" becomes "18" + "84".
   ------------------------------------------------------------------ */

function normalizeForMatch(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s.\-,/x_()\[\]#&'"]/g, '');
}

function fragmentsOf(query) {
  return String(query == null ? '' : query)
    .trim()
    .split(/\s+/)
    .map(normalizeForMatch)
    .filter(Boolean);
}

function matchesFragments(name, frags) {
  const hay = normalizeForMatch(name);
  if (frags.length === 0) return false;
  return frags.every((f) => hay.includes(f));
}

// "1884" -> ["18","84"] ; "84188" -> ["84","18","8"]
function splitGluedDigits(s) {
  if (!/^\d{3,6}$/.test(s)) return null;
  const out = [];
  let rest = s;
  while (rest.length >= 2) {
    out.push(rest.slice(0, 2));
    rest = rest.slice(2);
  }
  if (rest.length) out.push(rest);
  return out.length >= 2 ? out : null;
}

function searchList(list, query) {
  const frags = fragmentsOf(query);
  let hits = list.filter((p) => matchesFragments(p.name, frags));
  if (hits.length === 0 && frags.length === 1) {
    const split = splitGluedDigits(frags[0]);
    if (split) hits = list.filter((p) => matchesFragments(p.name, split));
  }
  return hits;
}

// "Showing 8 of 23" style hint so you know to narrow further.
function matchHint(total, shown) {
  if (total <= shown) return '';
  return `\n\nShowing ${shown} of ${total} matches — type more words to narrow it down.`;
}

/* ------------------------------------------------------------------
   QUANTITY

   "10"        -> 10 Pcs   (a bare number always means Pcs)
   "10 pcs"    -> 10 Pcs
   "320 sqft"  -> 320 Sq.Ft
   ------------------------------------------------------------------ */

const UNIT_PCS = /^(pcs|pc|piece|pieces|nos|no|number|numbers)$/;
const UNIT_SQFT = /^(sqft|sqfeet|sqf|sft|sqfoot|squarefeet|squarefoot|feet|ft)$/;

function parseQty(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/^([0-9]*\.?[0-9]+)\s*(.*)$/);
  if (!m) {
    return { error: 'Please start with a number — for example "10", "10 pcs" or "320 sqft".' };
  }
  const qty = parseFloat(m[1]);
  if (isNaN(qty) || qty <= 0) {
    return { error: 'Please enter a quantity greater than zero.' };
  }
  const unitRaw = m[2].replace(/[\s.]/g, '').toLowerCase();
  // A bare number always means Pcs — that covers ~90% of entries.
  if (!unitRaw) return { qty, unit: 'Pcs', assumed: true };
  if (UNIT_PCS.test(unitRaw)) return { qty, unit: 'Pcs', assumed: false };
  if (UNIT_SQFT.test(unitRaw)) return { qty, unit: 'Sq.Ft', assumed: false };
  return {
    error: `I did not recognise the unit "${m[2].trim()}". Use pcs or sqft, or just send the number on its own.`,
  };
}

// In-memory session per chat. Fine for single-user use.
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId);
}
function resetSession(chatId) {
  sessions.set(chatId, {});
}

/* ------------------------------------------------------------------
   BUTTONS
   ------------------------------------------------------------------ */

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Sale', 'MODE_SALE')],
    [Markup.button.callback('Purchase', 'MODE_PURCHASE')],
    [Markup.button.callback('Both (Purchase + Sale)', 'MODE_BOTH')],
    [Markup.button.callback('📋 Stock list', 'LIST_STOCK'),
     Markup.button.callback('👥 Party list', 'LIST_PARTIES')],
  ]);
}

// Shown while adding items: finish or abandon without typing.
function itemStepButtons(hasItems) {
  const row = [];
  if (hasItems) row.push(Markup.button.callback('✅ Done', 'ITEMS_DONE'));
  row.push(Markup.button.callback('❌ Cancel', 'CANCEL_ENTRY'));
  return Markup.inlineKeyboard([row]);
}

function cancelOnly() {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'CANCEL_ENTRY')]]);
}

// Shown at the quantity step, in case the wrong product was picked.
function qtyStepButtons() {
  return Markup.inlineKeyboard([[
    Markup.button.callback('◀ Back to product', 'BACK_PRODUCT'),
    Markup.button.callback('❌ Cancel', 'CANCEL_ENTRY'),
  ]]);
}

function newEntryButton() {
  return Markup.inlineKeyboard([[Markup.button.callback('➕ New entry', 'NEW_ENTRY')]]);
}

function partyButtons(matches, prefix) {
  const shown = matches.slice(0, 8);
  const rows = shown.map((p, i) => [
    Markup.button.callback(p.name, `${prefix}_${i}`),
  ]);
  rows.push([Markup.button.callback('❌ Cancel', 'CANCEL_ENTRY')]);
  return { rows, matches: shown };
}

function productButtons(matches, hasItems) {
  const shown = matches.slice(0, 8);
  const rows = shown.map((p, i) => [
    Markup.button.callback(`${p.name} (${p.unit})`, `PROD_${i}`),
  ]);
  const row = [];
  if (hasItems) row.push(Markup.button.callback('✅ Done', 'ITEMS_DONE'));
  row.push(Markup.button.callback('❌ Cancel', 'CANCEL_ENTRY'));
  rows.push(row);
  return { rows, matches: shown };
}

function formatMessage({ chlnNo, clientName, items }) {
  const lines = [];
  lines.push(`Chln.no. ${chlnNo}`);
  lines.push(clientName);
  lines.push('Details of goods sent:');
  items.forEach((it) => {
    lines.push(`${it.name} - ${it.qty} ${it.unit}`);
  });
  return lines.join('\n');
}

/* ------------------------------------------------------------------
   LISTS  —  Telegram caps a message at ~4096 chars, so send in chunks.
   ------------------------------------------------------------------ */

async function sendLongList(ctx, header, lines) {
  if (lines.length === 0) {
    return ctx.reply(`${header}\n\nNothing loaded yet. Send /upload to load a file.`);
  }
  let buf = `${header} (${lines.length})\n\n`;
  for (const line of lines) {
    if (buf.length + line.length + 1 > 3500) {
      await ctx.reply(buf);
      buf = '';
    }
    buf += line + '\n';
  }
  if (buf.trim()) await ctx.reply(buf);
}

async function sendStockList(ctx) {
  const stock = getStock();
  const lines = stock.map((p, i) => `${i + 1}. ${p.name} (${p.unit})`);
  await sendLongList(ctx, '📋 Stock list', lines);
}

async function sendPartyList(ctx) {
  const parties = getParties();
  const cust = parties.filter((p) => p.type === 'customer');
  const supp = parties.filter((p) => p.type === 'supplier');
  const lines = [];
  if (cust.length) {
    lines.push('— CUSTOMERS —');
    cust.forEach((p, i) => lines.push(`${i + 1}. ${p.name}${p.phone ? ' · ' + p.phone : ''}`));
  }
  if (supp.length) {
    if (lines.length) lines.push('');
    lines.push('— SUPPLIERS —');
    supp.forEach((p, i) => lines.push(`${i + 1}. ${p.name}${p.phone ? ' · ' + p.phone : ''}`));
  }
  await sendLongList(ctx, '👥 Party list', lines);
}

const bot = new Telegraf(TOKEN);

const WELCOME =
  'Welcome. What do you want to record?\n\n' +
  'Tip: when searching, type any parts of the name in any order — ' +
  '"8x4 18" or "18 8x4" both work, and "84" finds all 8x4 items.\n\n' +
  'Commands: /menu · /stock · /parties · /upload · /cancel';

bot.start((ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply(WELCOME, mainMenu());
});

bot.command('menu', (ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply('What do you want to record?', mainMenu());
});

bot.command('cancel', (ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply('Cancelled. Back to menu.', mainMenu());
});

bot.command('stock', async (ctx) => { await sendStockList(ctx); });
bot.command('parties', async (ctx) => { await sendPartyList(ctx); });

bot.command('upload', (ctx) => {
  ctx.reply(
    'Send me the exported stock file as a document, then separately the parties (customer/supplier) file. ' +
    'Accepted format: JSON array. I will tell you which one I detect and confirm before overwriting.'
  );
});

// Handle uploaded documents to refresh stock/parties lists
bot.on('document', async (ctx) => {
  try {
    const file = await ctx.telegram.getFile(ctx.message.document.file_id);
    const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    const text = await res.text();
    const parsed = JSON.parse(text);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return ctx.reply('That file did not look like a valid list. Expected a JSON array.');
    }

    if (parsed[0].unit !== undefined) {
      writeJSON(STOCK_FILE, parsed);
      ctx.reply(`Stock list updated — ${parsed.length} products loaded.`);
    } else if (parsed[0].type !== undefined) {
      writeJSON(PARTIES_FILE, parsed);
      ctx.reply(`Client/Supplier list updated — ${parsed.length} parties loaded.`);
    } else {
      ctx.reply('Could not tell if this is a stock file or a parties file. Check the format and resend.');
    }
  } catch (e) {
    ctx.reply('Could not read that file. Make sure it is valid JSON exported in the agreed format.');
  }
});

bot.action('LIST_STOCK', async (ctx) => {
  await ctx.answerCbQuery();
  await sendStockList(ctx);
});

bot.action('LIST_PARTIES', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPartyList(ctx);
});

bot.action('CANCEL_ENTRY', (ctx) => {
  resetSession(ctx.chat.id);
  ctx.answerCbQuery('Cancelled');
  ctx.reply('Cancelled — nothing was saved.', mainMenu());
});

bot.action('NEW_ENTRY', (ctx) => {
  resetSession(ctx.chat.id);
  ctx.answerCbQuery();
  ctx.reply('What do you want to record?', mainMenu());
});

bot.action('ITEMS_DONE', (ctx) => {
  const s = getSession(ctx.chat.id);
  ctx.answerCbQuery();
  if (!s.items || s.items.length === 0) {
    return ctx.reply('No products added yet. Add at least one first.', cancelOnly());
  }
  return proceedAfterItems(ctx, s);
});

bot.action('BACK_PRODUCT', (ctx) => {
  const s = getSession(ctx.chat.id);
  ctx.answerCbQuery();
  s.pendingProduct = null;
  s.step = 'PICK_PRODUCT';
  ctx.reply('Type a product name to search:', itemStepButtons(s.items && s.items.length > 0));
});

bot.action('MODE_SALE', (ctx) => {
  const s = getSession(ctx.chat.id);
  s.mode = 'sale';
  s.step = 'PICK_CLIENT';
  s.items = [];
  ctx.answerCbQuery();
  ctx.reply('Type the client name to search:', cancelOnly());
});

bot.action('MODE_PURCHASE', (ctx) => {
  const s = getSession(ctx.chat.id);
  s.mode = 'purchase';
  s.step = 'PICK_SUPPLIER';
  s.items = [];
  ctx.answerCbQuery();
  ctx.reply('Type the supplier name to search:', cancelOnly());
});

bot.action('MODE_BOTH', (ctx) => {
  const s = getSession(ctx.chat.id);
  s.mode = 'both';
  s.step = 'PICK_SUPPLIER';
  s.items = [];
  ctx.answerCbQuery();
  ctx.reply('Type the supplier name to search:', cancelOnly());
});

// Party selection callbacks (supplier or client)
bot.action(/^SUP_(\d+)$/, (ctx) => {
  const s = getSession(ctx.chat.id);
  const idx = parseInt(ctx.match[1], 10);
  const chosen = s._lastSupplierMatches && s._lastSupplierMatches[idx];
  if (!chosen) return ctx.answerCbQuery('Selection expired, try again.');
  s.supplier = chosen;
  ctx.answerCbQuery();
  if (s.mode === 'purchase') {
    s.step = 'PICK_PRODUCT';
    ctx.reply(`Supplier: ${chosen.name}\n\nType a product name to search:`, cancelOnly());
  } else {
    s.step = 'PICK_CLIENT';
    ctx.reply(`Supplier: ${chosen.name}\n\nNow type the client name to search:`, cancelOnly());
  }
});

bot.action(/^CLI_(\d+)$/, (ctx) => {
  const s = getSession(ctx.chat.id);
  const idx = parseInt(ctx.match[1], 10);
  const chosen = s._lastClientMatches && s._lastClientMatches[idx];
  if (!chosen) return ctx.answerCbQuery('Selection expired, try again.');
  s.client = chosen;
  s.step = 'PICK_PRODUCT';
  ctx.answerCbQuery();
  ctx.reply(`Client: ${chosen.name}\n\nType a product name to search:`, cancelOnly());
});

bot.action(/^PROD_(\d+)$/, (ctx) => {
  const s = getSession(ctx.chat.id);
  const idx = parseInt(ctx.match[1], 10);
  const chosen = s._lastProductMatches && s._lastProductMatches[idx];
  if (!chosen) return ctx.answerCbQuery('Selection expired, try again.');
  s.pendingProduct = chosen;
  s.step = 'ENTER_QTY';
  ctx.answerCbQuery();
  ctx.reply(
    `Qty for ${chosen.name}?\n\n` +
    `Just send a number — that means Pcs. For square feet type it out, e.g. "320 sqft".`,
    qtyStepButtons()
  );
});

bot.action('USE_SUGGESTED_CHLN', (ctx) => {
  const s = getSession(ctx.chat.id);
  ctx.answerCbQuery();
  finalizeEntry(ctx, s, s.suggestedChln);
});

bot.on('text', async (ctx) => {
  const s = getSession(ctx.chat.id);
  const text = ctx.message.text.trim();

  if (!s.step) {
    return ctx.reply('Send /menu to start a Sale, Purchase, or Both entry.', mainMenu());
  }

  if (s.step === 'PICK_SUPPLIER') {
    const parties = getParties().filter((p) => p.type === 'supplier');
    const matches = searchList(parties, text);
    if (matches.length === 0) {
      return ctx.reply('No supplier matched. Try fewer or different words.', cancelOnly());
    }
    const { rows, matches: shown } = partyButtons(matches, 'SUP');
    s._lastSupplierMatches = shown;
    return ctx.reply(
      'Pick the supplier:' + matchHint(matches.length, shown.length),
      Markup.inlineKeyboard(rows)
    );
  }

  if (s.step === 'PICK_CLIENT') {
    const parties = getParties().filter((p) => p.type === 'customer');
    const matches = searchList(parties, text);
    if (matches.length === 0) {
      return ctx.reply('No client matched. Try fewer or different words.', cancelOnly());
    }
    const { rows, matches: shown } = partyButtons(matches, 'CLI');
    s._lastClientMatches = shown;
    return ctx.reply(
      'Pick the client:' + matchHint(matches.length, shown.length),
      Markup.inlineKeyboard(rows)
    );
  }

  if (s.step === 'PICK_PRODUCT') {
    const hasItems = s.items && s.items.length > 0;
    if (text.toLowerCase() === 'done') {
      if (!hasItems) {
        return ctx.reply('No products added yet. Add at least one, or cancel.', cancelOnly());
      }
      return proceedAfterItems(ctx, s);
    }
    const stock = getStock();
    const matches = searchList(stock, text);
    if (matches.length === 0) {
      return ctx.reply(
        'No product matched. Try fewer words — for example "84" for all 8x4 items, ' +
        'then add more words to narrow it.',
        itemStepButtons(hasItems)
      );
    }
    const { rows, matches: shown } = productButtons(matches, hasItems);
    s._lastProductMatches = shown;
    return ctx.reply(
      'Pick the product:' + matchHint(matches.length, shown.length),
      Markup.inlineKeyboard(rows)
    );
  }

  if (s.step === 'ENTER_QTY') {
    const parsed = parseQty(text);
    if (parsed.error) return ctx.reply(parsed.error, qtyStepButtons());

    s.items.push({
      name: s.pendingProduct.name,
      unit: parsed.unit,
      qty: parsed.qty,
    });
    const added = s.items[s.items.length - 1];
    s.pendingProduct = null;
    s.step = 'PICK_PRODUCT';

    return ctx.reply(
      `Added: ${added.name} - ${added.qty} ${added.unit}\n\n` +
      `Type another product to search, or tap Done.`,
      itemStepButtons(true)
    );
  }

  if (s.step === 'ENTER_CHLN') {
    // Accept "12" or "O-12" — we store the number, display it as O-12.
    const digits = text.replace(/\D/g, '');
    const num = parseInt(digits, 10);
    if (isNaN(num) || num <= 0) {
      return ctx.reply(
        'Please send a valid challan number, or tap the suggested one above.'
      );
    }
    return finalizeEntry(ctx, s, num);
  }
});

function proceedAfterItems(ctx, s) {
  if (s.mode === 'purchase') {
    return finalizeEntry(ctx, s, null);
  }
  // sale or both — need a challan number
  const state = getState();
  const suggested = (state.lastChallanNo || 0) + 1;
  s.suggestedChln = suggested;
  s.step = 'ENTER_CHLN';
  ctx.reply(
    `Suggested Chln No: ${chlnLabel(suggested)}\nSend a different number, or use the suggested one.`,
    Markup.inlineKeyboard([
      [Markup.button.callback(`Use ${chlnLabel(suggested)}`, 'USE_SUGGESTED_CHLN')],
      [Markup.button.callback('❌ Cancel', 'CANCEL_ENTRY')],
    ])
  );
}

function finalizeEntry(ctx, s, chlnNo) {
  const timestamp = new Date().toISOString();

  if (s.mode === 'purchase') {
    pushQueue({
      type: 'purchase',
      supplier: s.supplier.name,
      items: s.items,
      timestamp,
    });
    ctx.reply(
      `Purchase entry recorded for ${s.supplier.name}. Khata will pick this up and assign its own voucher number.`,
      newEntryButton()
    );
    resetSession(ctx.chat.id);
    return;
  }

  // sale or both — need chln no and message
  const state = getState();
  state.lastChallanNo = chlnNo;
  setState(state);

  const label = chlnLabel(chlnNo);
  const message = formatMessage({ chlnNo: label, clientName: s.client.name, items: s.items });

  if (s.mode === 'both') {
    pushQueue({
      type: 'purchase',
      supplier: s.supplier.name,
      items: s.items,
      timestamp,
    });
  }
  pushQueue({
    type: 'sale',
    client: s.client.name,
    chlnNo: label,
    items: s.items,
    timestamp,
  });

  ctx.reply(`Entry recorded.\n\n${message}`);

  if (s.client.phone) {
    const waUrl = `https://wa.me/${s.client.phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
    ctx.reply('Send to client on WhatsApp:', Markup.inlineKeyboard([
      [Markup.button.url('Send to WhatsApp', waUrl)],
      [Markup.button.callback('➕ New entry', 'NEW_ENTRY')],
    ]));
  } else {
    ctx.reply(
      'No phone number saved for this client — copy the message above and pick the contact yourself in WhatsApp.',
      newEntryButton()
    );
  }

  resetSession(ctx.chat.id);
}

bot.launch();
console.log('Bot started.');

// Tiny web server so Render's free Web Service sees an open port.
const app = express();
app.get('/', (req, res) => res.send('Khata dispatch bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Health check server on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
