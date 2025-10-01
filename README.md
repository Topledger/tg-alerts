# Multi-WebSocket Telegram Alert Bot

A Telegram bot that monitors three WebSocket endpoints and sends alerts when any endpoint stops responding within specified timeout periods.

## Features

- 🔌 Monitors 3 WebSocket endpoints simultaneously:
  - **Trending Pairs** (`ws://34.107.31.9/ws/trending-pairs`) - 4 second timeout
  - **Top Holders** (`ws://34.107.31.9/ws/top-holders`) - batch testing
  - **Top Traders** (`ws://34.107.31.9/ws/top-traders`) - batch testing
- 📡 Subscribes to pump-fun DEX data from trending pairs
- 🔄 **Batch Testing**: Every 20 seconds, tests 10 latest mints simultaneously
- ⏱️ Waits 10 seconds for responses from each endpoint
- 📱 **Smart Alerts**: Only alerts if WebSocket is completely dead (zero responses)
- ✅ If even 1 mint responds, WebSocket is considered healthy (no alert)
- 🔄 Automatic reconnection with exponential backoff
- 🤖 Interactive bot commands

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the instructions
3. Save the bot token you receive

### 3. Get Your Chat ID

1. Send a message to your bot
2. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Look for `"chat":{"id":` in the response
4. Copy the chat ID number

### 4. Configure Environment

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

## Usage

### Development Mode

```bash
npm run dev
```

### Production Mode

```bash
# Build the project
npm run build

# Start the bot
npm start
```

### Bot Commands

Once the bot is running, you can use these commands in Telegram:

- `/start` - Show welcome message and available commands
- `/status` - Check all WebSocket connection statuses
- `/restart` - Manually restart all WebSocket connections
- `/info` - Show current configuration for all endpoints
- `/mints` - Show available mints being tested

## How It Works

1. **Trending Pairs Connection**: 
   - Connects to trending-pairs WebSocket
   - Subscribes to pump-fun DEX (NEW, MIGRATING, MIGRATED categories)
   - Collects mint addresses from incoming token data
   - Monitors with 4-second timeout for continuous data

2. **Holders & Traders Connections**:
   - Connects to both top-holders and top-traders WebSockets
   - Waits for mint addresses from trending pairs

3. **Batch Testing** (Every 20 seconds):
   - Picks the **10 latest mints** from trending pairs
   - Subscribes all 10 mints to both holders and traders endpoints simultaneously
   - Tracks which mints receive data responses

4. **Result Processing** (After 10 seconds):
   - Checks if ANY mint received data
   - **Only alerts if ZERO responses** (WebSocket completely dead)
   - If even 1 mint responds, WebSocket is working fine (no alert)
   - Separate monitoring for holders and traders endpoints

5. **Reconnection**: Automatically attempts to reconnect any endpoint that disconnects

## Alerts

The bot sends alerts for:

- ✅ Bot startup and all connections established
- ⚠️ **Trending Pairs**: No data received for 4 seconds
- ❌ **Top Holders Dead**: When ZERO out of 10 mints respond (WebSocket completely dead)
- ❌ **Top Traders Dead**: When ZERO out of 10 mints respond (WebSocket completely dead)
- ⚠️ Any WebSocket disconnection
- ❌ Connection errors
- ❌ Max reconnection attempts reached

**Note:** If even 1 mint out of 10 responds, the WebSocket is considered working and no alert is sent.

## Example Alerts

### Trending Pairs Timeout
```
⚠️ Trending Pairs Alert

No data received for 4 seconds!
Last message: 3:45:23 PM
Connection: Open
```

### Top Holders Dead (WebSocket Not Working)
```
❌ Top Holders - WebSocket Dead

NO responses for ANY of 10 mints!

Tested mints (first 5):
`7xKXtg2CW87d97...`
`9bNmQ5fP3aK8Yr...`
`3aB5mN2pQ7xK9F...`
`8pYzL4fR6nM2vH...`
`5kW9jT3dC8qP1B...`

WebSocket may be down or not responding.
```

### Top Holders Working (No Alert)
```
Console only: ✅ Holders WebSocket working (7 responses)
```
No Telegram alert is sent if any mints respond.

### Startup Confirmation
```
✅ Bot Started

Monitoring 3 WebSocket endpoints:
• Trending Pairs (4s timeout)
• Top Holders (batch testing)
• Top Traders (batch testing)

Testing 10 mints every 20s
Waiting 10s for responses
```

## Troubleshooting

### Bot not responding
- Check if `TELEGRAM_BOT_TOKEN` is correct
- Verify bot is running (`npm run dev`)
- Make sure you've sent `/start` to the bot

### No alerts received
- Verify `TELEGRAM_CHAT_ID` is correct
- Check bot logs for errors
- Use `/status` command to check connection

### WebSocket connection issues
- Verify WebSocket URL is accessible: `ws://34.107.31.9/ws/trending-pairs`
- Check network connectivity
- Review bot logs for error messages

## Development

### Project Structure

```
alerts/
├── src/
│   └── bot.ts          # Main bot logic
├── dist/               # Compiled JavaScript (generated)
├── .env                # Environment variables (create this)
├── .env.example        # Example environment variables
├── package.json        # Dependencies
├── tsconfig.json       # TypeScript configuration
└── README.md          # This file
```

### Watch Mode

To automatically rebuild on file changes:

```bash
npm run watch
```

## License

MIT

