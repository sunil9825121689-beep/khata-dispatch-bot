# Khata Dispatch Bot

Telegram bot: t.me/gpc_khata_bot

## What it does
- Menu: Sale / Purchase / Both
- Search-and-pick client, supplier, and products (type a few letters, tap the match)
- Auto-increments Chln No. from the last one used (editable)
- Sends a WhatsApp link pre-filled with the message if the client's phone is saved,
  otherwise gives you the message to copy
- Writes each finished entry into data/queue.json for Khata to pick up

## Files
- `index.js` — all the bot logic
- `data/stock.json` — product list (name + unit)
- `data/parties.json` — customers and suppliers (name + type + phone)
- `data/state.json` — remembers the last challan number used
- `data/queue.json` — entries waiting for Khata to import

## Updating your product/client lists
Send `/upload` to the bot, then send the updated file as a Telegram document
(a JSON array). If the items have a `unit` field it's treated as the stock list;
if they have a `type` field it's treated as the parties list.
