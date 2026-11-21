# MERLIN EXE — WhatsApp Bot

Pairing number: 2349064331053 (works with WhatsApp or WhatsApp Business).

## Run
1. Node.js 18+ required.
2. `npm install`
3. `npm start`
4. Enter the pairing code in WhatsApp (Business): Settings > Linked devices > Link a device > Link with phone number instead. Use the newest code within ~60 seconds.
5. Test from a DIFFERENT phone (you can't test by messaging yourself).

Problems? `npm run reset` clears the saved session, then pair again. Run only ONE copy of the bot.

## Commands (prefix `.`)
Send `.menu`. Highlights: `.jail` / `.free` / `.jaillist`, `.ffban <uid>`, `.song <name>`, `.hack @user` (prank), `.hash`, `.b64`, `.morse`, `.sysinfo`.

## Jail
`.jail @user` (or reply) gives a random crime + sentence; ALL their messages in that group are deleted
(text, stickers, media, view-once, voice, docs...) until `.free @user`. Needs the bot's account to be a group admin.

## Free Fire ban check (.ffban)
Checks whether a UID is banned. Garena has no official public API, so you must supply a ban-check API:
`FF_API_URL="https://your-api.example/check?uid={uid}" npm start` (use `{uid}` as the placeholder).
The bot understands common response fields (banned/is_banned/status, nickname, region, ban_period).

## Songs (.song)
Looks up the song on Apple's public iTunes Search API and sends artwork, details, a link and the official 30-second preview.
(Full-song downloading from YouTube is unreliable and breaks copyright terms, so it isn't included.)

## About bans — please read
No unofficial WhatsApp bot can guarantee a number is never banned. Built-in protections: typing indicator + random
reply delay, per-user cooldown (1.5 s gap, 12 commands/min), the bot only answers commands and never messages
anyone first. To keep the risk low: don't add it to hundreds of groups, don't broadcast, don't use a brand-new number,
and keep it on one host. The only ban-proof option is the official WhatsApp Business Cloud API, but it can't delete
members' messages, so jail wouldn't work there.

## Pairing website (MERLIN EXE)
`npm run site` starts the website at http://localhost:3000 (set `PORT` to change it).
Visitors enter their number, press Get Pair Code, and the server starts a separate bot for them
(folder `sessions/<number>`), up to `BOT_LIMIT` bots (default 50). Linked bots restart automatically
after a server restart. Unfinished pairings are stopped after 3 minutes.
Put your channel, GitHub and tutorial links in the `CONFIG` block at the top of the script in `public/index.html`.
Needs a host that keeps a Node process running (a VPS or panel), not static hosting. Each bot uses roughly 50-100 MB RAM.
Only link numbers you own or have permission to link. Every linked bot is an unofficial client and carries the ban risk described above.
