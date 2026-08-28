const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------- Telegram bot setup ----------
// Fill these in when you're ready to turn Telegram features on. Get a bot token from @BotFather
// on Telegram (send it /newbot). CHAT_IDS is a list because alerts should reach more than one
// person — each person messages the bot once, and their chat id gets printed in this same
// Command Prompt window so you can copy it in below.
const TELEGRAM_BOT_TOKEN = 'PASTE_YOUR_BOT_TOKEN_HERE';
const CHAT_IDS = [
  // 'PASTE_YOUR_OWN_CHAT_ID_HERE',
  // 'PASTE_SONS_CHAT_ID_HERE',
  // 'PASTE_DAUGHTER_IN_LAWS_CHAT_ID_HERE',
];

let mainWindow;
let bot = null;
let inboxItems = [];

function setupTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'PASTE_YOUR_BOT_TOKEN_HERE') {
    console.log('[Telegram] No bot token set yet — Telegram features are off until you add one in main.js.');
    return;
  }
  const TelegramBot = require('node-telegram-bot-api');
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  bot.on('message', (msg) => {
    console.log(`[Telegram] Message from chat id ${msg.chat.id}: ${msg.text || '(non-text message)'}`);

    if (msg.voice || msg.audio) {
      inboxItems.push({
        id: String(msg.message_id),
        chatId: msg.chat.id,
        type: 'voice',
        text: '(voice message — open Telegram to listen, then type it into Smart Entry)',
        date: new Date(msg.date * 1000).toISOString(),
      });
    } else if (msg.text) {
      inboxItems.push({
        id: String(msg.message_id),
        chatId: msg.chat.id,
        type: 'text',
        text: msg.text,
        date: new Date(msg.date * 1000).toISOString(),
      });
    }

    if (mainWindow) mainWindow.webContents.send('inbox-updated', inboxItems);
  });

  console.log('[Telegram] Bot is running and listening for messages.');
}

ipcMain.handle('read-inbox', async () => inboxItems);

ipcMain.handle('send-telegram-message', async (event, text) => {
  if (!bot) {
    console.log('[Telegram] Tried to send a message, but no bot token is set in main.js yet.');
    return false;
  }
  if (!CHAT_IDS.length) {
    console.log('[Telegram] Tried to send a message, but CHAT_IDS is empty in main.js — add at least one.');
    return false;
  }
  for (const chatId of CHAT_IDS) {
    try { await bot.sendMessage(chatId, text); }
    catch (err) { console.error(`[Telegram] Failed to send to ${chatId}:`, err.message); }
  }
  return true;
});

// ---------- Company folders — Tally-style ----------
// One parent folder holds every company as its own sub-folder. The list of companies is never
// stored separately by Khata — it's discovered fresh each time by scanning that parent folder, so
// pointing at a folder that already has company sub-folders in it (from before, or from another
// computer) just works immediately. Each company's own folder IS its data — not a mirror of
// something else — so opening a company always reads straight from its folder, and every save
// writes straight back into it.
const CONFIG_PATH = path.join(app.getPath('userData'), 'khata-config.json');
const DATA_FILENAME = 'khata-data.json';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

ipcMain.handle('get-parent-folder', async () => {
  return loadConfig().parentFolder || null;
});

ipcMain.handle('choose-parent-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose where Khata should keep your companies',
  });
  if (result.canceled || !result.filePaths.length) return null;
  const folder = result.filePaths[0];
  const cfg = loadConfig();
  cfg.parentFolder = folder;
  saveConfig(cfg);
  return folder;
});

// Scans the parent folder's immediate sub-folders. A sub-folder counts as a company if it has a
// khata-data.json inside it (even an empty/fresh one) — anything else in that parent folder
// (unrelated files or folders) is silently ignored, not shown as a broken company.
ipcMain.handle('list-companies', async () => {
  const cfg = loadConfig();
  const parent = cfg.parentFolder;
  if (!parent) return { error: 'no-parent-folder' };
  if (!fs.existsSync(parent)) return { error: 'not-found', path: parent };
  let entries;
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
  catch (e) { return { error: 'not-found', path: parent }; }
  const companies = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dataPath = path.join(parent, entry.name, DATA_FILENAME);
    if (!fs.existsSync(dataPath)) continue;
    let displayName = entry.name;
    try {
      const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      if (parsed.displayName) displayName = parsed.displayName;
    } catch (e) { /* unreadable data file — still list it, using the folder name as-is */ }
    companies.push({ folder: entry.name, displayName });
  }
  return { path: parent, companies };
});

ipcMain.handle('create-company', async (event, displayName) => {
  const cfg = loadConfig();
  const parent = cfg.parentFolder;
  if (!parent) return { error: 'no-parent-folder' };
  let n = 1;
  let folderName;
  do {
    folderName = 'khata' + String(n).padStart(4, '0');
    n++;
  } while (fs.existsSync(path.join(parent, folderName)));
  fs.mkdirSync(path.join(parent, folderName), { recursive: true });
  fs.writeFileSync(
    path.join(parent, folderName, DATA_FILENAME),
    JSON.stringify({ displayName: displayName || folderName, masters: null, txns: null, savedAt: new Date().toISOString() }, null, 2)
  );
  return { folder: folderName, displayName: displayName || folderName };
});

ipcMain.handle('rename-company-folder', async (event, oldFolder, newFolder) => {
  const cfg = loadConfig();
  const parent = cfg.parentFolder;
  if (!parent) return { error: 'no-parent-folder' };
  const oldPath = path.join(parent, oldFolder);
  const newPath = path.join(parent, newFolder);
  if (fs.existsSync(newPath)) return { error: 'name-taken' };
  try { fs.renameSync(oldPath, newPath); return { folder: newFolder }; }
  catch (e) { return { error: 'rename-failed', message: e.message }; }
});

ipcMain.handle('read-company-data', async (event, folder) => {
  const cfg = loadConfig();
  const parent = cfg.parentFolder;
  if (!parent) return { error: 'no-parent-folder' };
  const dataPath = path.join(parent, folder, DATA_FILENAME);
  if (!fs.existsSync(dataPath)) return { error: 'not-found' };
  try { return { text: fs.readFileSync(dataPath, 'utf8') }; }
  catch (e) { return { error: 'not-found' }; }
});

ipcMain.handle('write-company-data', async (event, folder, jsonText) => {
  const cfg = loadConfig();
  const parent = cfg.parentFolder;
  if (!parent) return false;
  try {
    fs.mkdirSync(path.join(parent, folder), { recursive: true });
    fs.writeFileSync(path.join(parent, folder, DATA_FILENAME), jsonText);
    return true;
  } catch (e) { return false; }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Khata',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  // Page errors still echo into the Command Prompt window — no dev panel opens, but if Khata ever
  // fails to start again, the reason shows up there instead of leaving a blank window.
  mainWindow.webContents.on('console-message', (event, level, message, line) => {
    if (level >= 2) console.log(`[page] ${message}  (line ${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.log(`[page failed to load] ${code} ${desc}`);
  });
  mainWindow.loadFile('khata.html');
}

app.whenReady().then(() => {
  createWindow();
  setupTelegramBot();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
