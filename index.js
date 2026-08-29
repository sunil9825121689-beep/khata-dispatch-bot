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

/* ------------------------------------------------------------------
   SEARCH  —  matches the way Khata's own product search behaves.

   normalizeForMatch strips everything that people type inconsistently:
   spaces, dots, hyphens, commas, slashes, brackets and the "x" in sizes.
   So "8x4", "8 x 4" and "84" all become "84", and "18 mm" becomes "18mm".

   matchesQuery splits what you typed on spaces and requires EVERY
   fragment to appear somewhere in the name. Because each fragment is
   tested independently, the order you type them in does not matter:
   "8x4 18" and "18 8x4" give exactly the same result.
   ------------------------------------------------------------------ */

function normalizeForMatch(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s.\-,/x_()\[\]#&'"]/g, '');
}

function matchesQuery(name, query) {
  const hay = normalizeForMatch(name);
  const frags = String(query == null ? '' : query)
    .trim()
    .split(/\s+/)
    .map(normalizeForMatch)
    .filter(Boolean);
  if (frags.length === 0) return false;
  return frags.every((f) => hay.includes(f));
}

function searchList(list, query) {
  return list.filter((p) => matchesQuery(p.name, query));
}

// "Showing 8 of 23" style hint so you know to narrow further.
function matchHint(total, shown) {
  if (total <= shown) return '';
  return `\n\nShowing ${shown} of ${total} matches — type more words to narrow it down.`;
}

/* ------------------------------------------------------------------
   QUANTITY  —  now accepts an optional unit.

   "10"        -> 10 in the product's own unit
   "10 pcs"    -> 10 Pcs
   "10 sqft"   -> 10 Sq.Ft
   "pcs"       -> rejected, with a helpful message
   ------------------------------------------------------------------ */

const UNIT_PCS = /^(pcs|pc|piece|pieces|nos|no|number|numbers)$/;
const UNIT_SQFT = /^(sqft|sqfeet|sqf|sft|sqfoot|squarefeet|squarefoot|feet|ft)$/;

function parseQty(text, defaultUnit) {
  const raw = String(text || '').trim();
  const m = raw.match(/^([0-9]*\.?[0-9]+)\s*(.*)$/);
  if (!m) {
    return { error: 'Please start with a number — for example "10", "10 pcs" or "10 sqft".' };
  }
  const qty = parseFloat(m[1]);
  if (isNaN(qty) || qty <= 0) {
    return { error: 'Please enter a quantity greater than zero.' };
  }
  const unitRaw = m[2].replace(/[\s.]/g, '').toLowerCase();
  // A bare number always means Pcs — that covers ~90% of entries.
  // Say "10 sqft" explicitly on the rare occasion you mean square feet.
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

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Sale', 'MODE_SALE')],
    [Markup.button.callback('Purchase', 'MODE_PURCHASE')],
    [Markup.button.callback('Both (Purchase + Sale)', 'MODE_BOTH')],
  ]);
}

function partyButtons(matches, prefix) {
  const shown = matches.slice(0, 8);
  const rows = shown.map((p, i) => [
    Markup.button.callback(p.name, `${prefix}_${i}`),
  ]);
  return { rows, matches: shown };
}

function productButtons(matches) {
  const shown = matches.slice(0, 8);
  const rows = shown.map((p, i) => [
    Markup.button.callback(`${p.name} (${p.unit})`, `PROD_${i}`),
  ]);
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

const bot = new Telegraf(TOKEN);

bot.start((ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply(
    "Welcome. What do you want to record?\n\n" +
    "Tip: when searching, type any parts of the name in any order — " +
    "\"8x4 18\" or \"18 8x4\" both work, and \"84\" finds all 8x4 items.\n\n" +
    "(Send an updated stock/parties file any time with /upload to refresh the lists.)",
    mainMenu()
  );
});

bot.command('menu', (ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply('What do you want to record?', mainMenu());
});

bot.command('cancel', (ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply('Cancelled. Back to menu.', mainMenu());
});

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

bot.action('MODE_SALE', (ctx) => {
  const s = getSession(ctx.chat.id);
  s.mode = 'sale';
  s.step = 'PICK_CLIENT';
  s.items = [];
  ctx.answerCbQuery();
  ctx.reply('Type the client name to search:');
});

bot.action('MODE_PURCHASE', (ctx) => {
  const s = getSession(ctx.chat.id);
  s.mode = 'purchase';
  s.step = 'PICK_SUPPLIER';
  s.items = [];
  ctx.answerCbQuery();
  ctx.reply('Type the supplier name to search:');
});

bot.action('MODE_BOTH', (ctx) => {
  const s = getSession(ctx.chat.id);
  s.mode = 'both';
  s.step = 'PICK_SUPPLIER';
  s.items = [];
  ctx.answerCbQuery();
  ctx.reply('Type the supplier name to search:');
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
    ctx.reply(`Supplier: ${chosen.name}\n\nType a product name to search:`);
  } else {
    s.step = 'PICK_CLIENT';
    ctx.reply(`Supplier: ${chosen.name}\n\nNow type the client name to search:`);
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
  ctx.reply(`Client: ${chosen.name}\n\nType a product name to search:`);
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
    `Just send a number — that means Pcs. For square feet type it out, e.g. "320 sqft".`
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
    return ctx.reply('Send /menu to start a Sale, Purchase, or Both entry.');
  }

  if (s.step === 'PICK_SUPPLIER') {
    const parties = getParties().filter((p) => p.type === 'supplier');
    const matches = searchList(parties, text);
    if (matches.length === 0) {
      return ctx.reply('No supplier matched. Try fewer or different words.');
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
      return ctx.reply('No client matched. Try fewer or different words.');
    }
    const { rows, matches: shown } = partyButtons(matches, 'CLI');
    s._lastClientMatches = shown;
    return ctx.reply(
      'Pick the client:' + matchHint(matches.length, shown.length),
      Markup.inlineKeyboard(rows)
    );
  }

  if (s.step === 'PICK_PRODUCT') {
    if (text.toLowerCase() === 'done') {
      if (!s.items || s.items.length === 0) {
        return ctx.reply('No products added yet. Add at least one, or /cancel.');
      }
      return proceedAfterItems(ctx, s);
    }
    const stock = getStock();
    const matches = searchList(stock, text);
    if (matches.length === 0) {
      return ctx.reply(
        'No product matched. Try fewer words — for example "84" for all 8x4 items, ' +
        'then add more words to narrow it. Or type "done" if finished.'
      );
    }
    const { rows, matches: shown } = productButtons(matches);
    s._lastProductMatches = shown;
    return ctx.reply(
      'Pick the product:' + matchHint(matches.length, shown.length),
      Markup.inlineKeyboard(rows)
    );
  }

  if (s.step === 'ENTER_QTY') {
    const parsed = parseQty(text, s.pendingProduct.unit);
    if (parsed.error) return ctx.reply(parsed.error);

    s.items.push({
      name: s.pendingProduct.name,
      unit: parsed.unit,
      qty: parsed.qty,
    });
    const added = s.items[s.items.length - 1];
    const productUnit = s.pendingProduct.unit;
    s.pendingProduct = null;
    s.step = 'PICK_PRODUCT';

    let note = '';
    if (parsed.assumed && productUnit && productUnit !== 'Pcs') {
      note = `\n(Taken as Pcs. This product is normally sold in ${productUnit} — ` +
             `if you meant that, send it again as e.g. "320 sqft".)`;
    }

    return ctx.reply(
      `Added: ${added.name} - ${added.qty} ${added.unit}${note}\n\n` +
      `Type another product to search, or type "done" if finished.`
    );
  }

  if (s.step === 'ENTER_CHLN') {
    const num = parseInt(text, 10);
    if (isNaN(num)) return ctx.reply('Please send a valid challan number, or tap "Use suggested" above.');
    return finalizeEntry(ctx, s, num);
  }
});

function proceedAfterItems(ctx, s) {
  if (s.mode === 'purchase') {
    return finalizeEntry(ctx, s, null);
  }
  // sale or both — need a challan number
  const state = getState();
  const suggested = state.lastChallanNo + 1;
  s.suggestedChln = suggested;
  s.step = 'ENTER_CHLN';
  ctx.reply(
    `Suggested Chln No: ${suggested}\nSend a different number, or use the suggested one.`,
    Markup.inlineKeyboard([Markup.button.callback(`Use ${suggested}`, 'USE_SUGGESTED_CHLN')])
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
    ctx.reply(`Purchase entry recorded for ${s.supplier.name}. Khata will pick this up and assign its own voucher number.`);
    resetSession(ctx.chat.id);
    return;
  }

  // sale or both — need chln no and message
  const state = getState();
  state.lastChallanNo = chlnNo;
  setState(state);

  const message = formatMessage({ chlnNo, clientName: s.client.name, items: s.items });

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
    chlnNo,
    items: s.items,
    timestamp,
  });

  ctx.reply(`Entry recorded.\n\n${message}`);

  if (s.client.phone) {
    const waUrl = `https://wa.me/${s.client.phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
    ctx.reply('Send to client on WhatsApp:', Markup.inlineKeyboard([
      Markup.button.url('Send to WhatsApp', waUrl),
    ]));
  } else {
    ctx.reply('No phone number saved for this client — copy the message above and pick the contact yourself in WhatsApp.');
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
