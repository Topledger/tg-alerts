import WebSocket from 'ws';
import TelegramBot from 'node-telegram-bot-api';
import * as dotenv from 'dotenv';

dotenv.config();

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TRENDING_PAIRS_URL = 'ws://34.107.31.9/ws/trending-pairs';
const TOP_HOLDERS_URL = 'ws://34.107.31.9/ws/top-holders';
const TOP_TRADERS_URL = 'ws://34.107.31.9/ws/top-traders';
const TRENDING_TIMEOUT_SECONDS = 10;
const MINT_TEST_TIMEOUT_SECONDS = 15;
const MINT_BATCH_INTERVAL = 10000; // 20 seconds
const MINTS_PER_BATCH = 30;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env file');
  process.exit(1);
}

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// State management for trending pairs
let trendingWs: WebSocket | null = null;
let trendingTimeoutTimer: NodeJS.Timeout | null = null;
let trendingLastMessageTime: Date | null = null;
let trendingAlertSent = false;
let trendingReconnectAttempts = 0;

// State management for top holders
let holdersWs: WebSocket | null = null;
let holdersTimeoutTimer: NodeJS.Timeout | null = null;
let holdersLastMessageTime: Date | null = null;
let holdersAlertSent = false;
let holdersReconnectAttempts = 0;

// State management for top traders
let tradersWs: WebSocket | null = null;
let tradersTimeoutTimer: NodeJS.Timeout | null = null;
let tradersLastMessageTime: Date | null = null;
let tradersAlertSent = false;
let tradersReconnectAttempts = 0;

// Mint management
let availableMints: string[] = [];
let currentBatchMints: string[] = [];
let holdersResponses = new Set<string>(); // Track which mints got holders data
let tradersResponses = new Set<string>(); // Track which mints got traders data
let batchTimer: NodeJS.Timeout | null = null;
let batchTimeoutTimer: NodeJS.Timeout | null = null;

const maxReconnectAttempts = 10;

// Send Telegram alert
async function sendAlert(message: string) {
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log('📱 Alert sent:', message.substring(0, 50) + '...');
  } catch (error) {
    console.error('❌ Failed to send Telegram message:', error);
  }
}

// Reset timeout for trending pairs
function resetTrendingTimeout() {
  if (trendingTimeoutTimer) {
    clearTimeout(trendingTimeoutTimer);
  }
  
  trendingLastMessageTime = new Date();
  trendingAlertSent = false;
  
  trendingTimeoutTimer = setTimeout(() => {
    if (!trendingAlertSent) {
      const timeoutMessage = `⚠️ *Trending Pairs Alert*\n\n` +
        `No data received for ${TRENDING_TIMEOUT_SECONDS} seconds!\n` +
        `Last message: ${trendingLastMessageTime?.toLocaleTimeString() || 'Never'}\n` +
        `Connection: ${trendingWs?.readyState === WebSocket.OPEN ? 'Open' : 'Closed'}`;
      
      sendAlert(timeoutMessage);
      trendingAlertSent = true;
    }
  }, TRENDING_TIMEOUT_SECONDS * 1000);
}

// Track holder response for a specific mint
function trackHolderResponse(mint: string | null) {
  if (mint && currentBatchMints.includes(mint)) {
    holdersResponses.add(mint);
    holdersLastMessageTime = new Date();
    console.log(`✅ Holders responded for mint: ${mint.substring(0, 20)}... (${holdersResponses.size}/${currentBatchMints.length})`);
  }
}

// Track trader response for a specific mint
function trackTraderResponse(mint: string | null) {
  if (mint && currentBatchMints.includes(mint)) {
    tradersResponses.add(mint);
    tradersLastMessageTime = new Date();
    console.log(`✅ Traders responded for mint: ${mint.substring(0, 20)}... (${tradersResponses.size}/${currentBatchMints.length})`);
  }
}

// Subscribe to mint on holders/traders WebSocket
function subscribeToMint(ws: WebSocket | null, mint: string, endpoint: string) {
  if (ws?.readyState === WebSocket.OPEN) {
    const subscribeMessage = {
      type: "client_message",
      data: {
        action: "subscribe",
        mints: [mint]
      },
      timestamp: new Date().toISOString()
    };
    
    ws.send(JSON.stringify(subscribeMessage));
    console.log(`📡 [${endpoint}] Subscribed to mint: ${mint.substring(0, 20)}...`);
  }
}

// Connect to Trending Pairs WebSocket
function connectTrendingPairs() {
  try {
    console.log(`🔌 Connecting to Trending Pairs: ${TRENDING_PAIRS_URL}`);
    trendingWs = new WebSocket(TRENDING_PAIRS_URL);

    trendingWs.on('open', () => {
      console.log('✅ Trending Pairs connected');
      trendingReconnectAttempts = 0;
      
      // Subscribe to pump-fun
      const subscribeMessage = {
        action: 'subscribe',
        dex: ['pump-fun'],
        categories: ['NEW', 'MIGRATING', 'MIGRATED']
      };
      
      trendingWs?.send(JSON.stringify(subscribeMessage));
      console.log('📡 Subscribed to pump-fun');
      
      resetTrendingTimeout();
    });

    trendingWs.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        const timestamp = new Date().toLocaleTimeString();
        
        // Extract mint addresses from different message types
        if (message.type === 'initial_snapshot' && message.tokens && Array.isArray(message.tokens)) {
          console.log(`📥 [${timestamp}] Trending: Initial snapshot with ${message.tokens.length} tokens`);
          message.tokens.forEach((token: any) => {
            const mint = token.mint || token.mint_address;
            if (mint && !availableMints.includes(mint)) {
              availableMints.push(mint);
            }
          });
        } else if (message.type === 'category_update' && message.data) {
          console.log(`📥 [${timestamp}] Trending: ${message.category} - ${message.data?.symbol || 'unknown'}`);
          const mint = message.data.mint || message.data.mint_address;
          if (mint && !availableMints.includes(mint)) {
            availableMints.push(mint);
            console.log(`✨ New mint added: ${mint.substring(0, 20)}... (Total: ${availableMints.length})`);
          }
        } else if (message.symbol && (message.mint || message.mint_address)) {
          const mint = message.mint || message.mint_address;
          if (mint && !availableMints.includes(mint)) {
            availableMints.push(mint);
          }
        }
        
        // Keep only last 100 mints
        if (availableMints.length > 100) {
          availableMints = availableMints.slice(-100);
        }
        
        resetTrendingTimeout();
      } catch (error) {
        resetTrendingTimeout();
      }
    });

    trendingWs.on('close', (code, reason) => {
      console.log(`🔌 Trending Pairs closed: ${code}`);
      if (trendingTimeoutTimer) clearTimeout(trendingTimeoutTimer);
      
      if (trendingReconnectAttempts < maxReconnectAttempts) {
        const timeout = Math.min(1000 * Math.pow(2, trendingReconnectAttempts), 30000);
        trendingReconnectAttempts++;
        console.log(`🔄 Reconnecting Trending Pairs in ${timeout / 1000}s...`);
        setTimeout(connectTrendingPairs, timeout);
      } else {
        sendAlert(`❌ *Trending Pairs Failed*\n\nMax reconnection attempts reached.`);
      }
    });

    trendingWs.on('error', (error) => {
      console.error('❌ Trending Pairs error:', error);
    });

  } catch (error) {
    console.error('❌ Failed to connect Trending Pairs:', error);
  }
}

// Connect to Top Holders WebSocket
function connectTopHolders() {
  try {
    console.log(`🔌 Connecting to Top Holders: ${TOP_HOLDERS_URL}`);
    holdersWs = new WebSocket(TOP_HOLDERS_URL);

    holdersWs.on('open', () => {
      console.log('✅ Top Holders connected');
      holdersReconnectAttempts = 0;
    });

    holdersWs.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        const timestamp = new Date().toLocaleTimeString();
        
        // Extract mint from message (based on actual API response)
        let mintFromMessage = message.data?.mint || message.data?.data?.mint || 
                             message.mint || message.mint_address;
        
        // Check for data - be flexible with format
        const hasData = (message.data?.type === 'top_holders_update' && message.data?.data?.holders) ||
                       message.holders || 
                       (message.data?.holders) ||
                       (Array.isArray(message.data?.data?.holders));
        
        if (hasData && mintFromMessage) {
          const dataCount = message.data?.data?.holders?.length || 
                           message.holders?.length || 
                           message.data?.holders?.length || 0;
          console.log(`📥 [${timestamp}] Holders: Received ${dataCount} holders for ${mintFromMessage.substring(0, 20)}...`);
          trackHolderResponse(mintFromMessage);
        }
      } catch (error) {
        // Silent error
      }
    });

    holdersWs.on('close', (code, reason) => {
      console.log(`🔌 Top Holders closed: ${code}`);
      if (holdersTimeoutTimer) clearTimeout(holdersTimeoutTimer);
      
      if (holdersReconnectAttempts < maxReconnectAttempts) {
        const timeout = Math.min(1000 * Math.pow(2, holdersReconnectAttempts), 30000);
        holdersReconnectAttempts++;
        console.log(`🔄 Reconnecting Top Holders in ${timeout / 1000}s...`);
        setTimeout(connectTopHolders, timeout);
      } else {
        sendAlert(`❌ *Top Holders Failed*\n\nMax reconnection attempts reached.`);
      }
    });

    holdersWs.on('error', (error) => {
      console.error('❌ Top Holders error:', error);
    });

  } catch (error) {
    console.error('❌ Failed to connect Top Holders:', error);
  }
}

// Connect to Top Traders WebSocket
function connectTopTraders() {
  try {
    console.log(`🔌 Connecting to Top Traders: ${TOP_TRADERS_URL}`);
    tradersWs = new WebSocket(TOP_TRADERS_URL);

    tradersWs.on('open', () => {
      console.log('✅ Top Traders connected');
      tradersReconnectAttempts = 0;
    });

    tradersWs.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        const timestamp = new Date().toLocaleTimeString();
        
        // Extract mint from message (based on actual API response)
        let mintFromMessage = message.data?.mint || message.data?.data?.mint || 
                             message.mint || message.mint_address;
        
        // Check for data - be flexible with format (API returns data.data.traders)
        const hasData = (message.data?.type === 'top_traders_update' && message.data?.data?.traders) ||
                       message.traders || 
                       (message.data?.traders) ||
                       (Array.isArray(message.data?.data?.traders));
        
        if (hasData && mintFromMessage) {
          const dataCount = message.data?.data?.traders?.length || 
                           message.traders?.length || 
                           message.data?.traders?.length || 0;
          console.log(`📥 [${timestamp}] Traders: Received ${dataCount} traders for ${mintFromMessage.substring(0, 20)}...`);
          trackTraderResponse(mintFromMessage);
        }
      } catch (error) {
        // Silent error
      }
    });

    tradersWs.on('close', (code, reason) => {
      console.log(`🔌 Top Traders closed: ${code}`);
      if (tradersTimeoutTimer) clearTimeout(tradersTimeoutTimer);
      
      if (tradersReconnectAttempts < maxReconnectAttempts) {
        const timeout = Math.min(1000 * Math.pow(2, tradersReconnectAttempts), 30000);
        tradersReconnectAttempts++;
        console.log(`🔄 Reconnecting Top Traders in ${timeout / 1000}s...`);
        setTimeout(connectTopTraders, timeout);
      } else {
        sendAlert(`❌ *Top Traders Failed*\n\nMax reconnection attempts reached.`);
      }
    });

    tradersWs.on('error', (error) => {
      console.error('❌ Top Traders error:', error);
    });

  } catch (error) {
    console.error('❌ Failed to connect Top Traders:', error);
  }
}

// Process batch results after timeout
function processBatchResults() {
  if (currentBatchMints.length === 0) {
    console.log('⏳ No batch to process');
    return;
  }
  
  console.log(`\n📊 Processing batch results...`);
  
  const holdersResponseCount = holdersResponses.size;
  const tradersResponseCount = tradersResponses.size;
  
  console.log(`📊 Batch Results:
  - Holders: ${holdersResponseCount}/${currentBatchMints.length} responded
  - Traders: ${tradersResponseCount}/${currentBatchMints.length} responded`);
  
  // Only alert if NO responses at all (WebSocket is completely dead)
  if (holdersResponseCount === 0) {
    const mintList = currentBatchMints.slice(0, 5).map(m => `\`${m.substring(0, 15)}...\``).join('\n');
    sendAlert(
      `❌ *Top Holders - WebSocket Dead*\n\n` +
      `NO responses for ANY of ${currentBatchMints.length} mints!\n\n` +
      `Tested mints (first 5):\n${mintList}\n\n` +
      `WebSocket may be down or not responding.`
    );
  } else {
    console.log(`✅ Holders WebSocket working (${holdersResponseCount} responses)`);
  }
  
  if (tradersResponseCount === 0) {
    const mintList = currentBatchMints.slice(0, 5).map(m => `\`${m.substring(0, 15)}...\``).join('\n');
    sendAlert(
      `❌ *Top Traders - WebSocket Dead*\n\n` +
      `NO responses for ANY of ${currentBatchMints.length} mints!\n\n` +
      `Tested mints (first 5):\n${mintList}\n\n` +
      `WebSocket may be down or not responding.`
    );
  } else {
    console.log(`✅ Traders WebSocket working (${tradersResponseCount} responses)`);
  }
}

// Test a batch of mints
function testMintBatch() {
  if (availableMints.length === 0) {
    console.log('⏳ No mints available yet, waiting for trending pairs data...');
    return;
  }
  
  // Get the 10 latest mints
  const startIndex = Math.max(0, availableMints.length - MINTS_PER_BATCH);
  currentBatchMints = availableMints.slice(startIndex);
  
  // Reset response tracking
  holdersResponses.clear();
  tradersResponses.clear();
  
  console.log(`\n🔄 Testing batch of ${currentBatchMints.length} latest mints...`);
  currentBatchMints.forEach((mint, index) => {
    console.log(`  ${index + 1}. ${mint.substring(0, 30)}...`);
  });
  
  // Subscribe all mints to both endpoints
  currentBatchMints.forEach(mint => {
    subscribeToMint(holdersWs, mint, 'Holders');
    subscribeToMint(tradersWs, mint, 'Traders');
  });
  
  // Set timeout to process results after 10 seconds
  if (batchTimeoutTimer) {
    clearTimeout(batchTimeoutTimer);
  }
  
  batchTimeoutTimer = setTimeout(() => {
    processBatchResults();
  }, MINT_TEST_TIMEOUT_SECONDS * 1000);
}

// Start batch testing
function startBatchTesting() {
  if (batchTimer) {
    clearInterval(batchTimer);
  }
  
  // Wait a bit for initial mints to accumulate
  setTimeout(() => {
    testMintBatch();
    
    // Then test batch every 20 seconds
    batchTimer = setInterval(testMintBatch, MINT_BATCH_INTERVAL);
    console.log(`🔁 Batch testing started (every ${MINT_BATCH_INTERVAL / 1000}s with ${MINTS_PER_BATCH} mints)`);
  }, 3000);
}

// Telegram bot commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `🤖 *Multi-WebSocket Monitor Bot*\n\n` +
    `Monitoring 3 endpoints:\n` +
    `• Trending Pairs (${TRENDING_TIMEOUT_SECONDS}s timeout)\n` +
    `• Top Holders (batch testing)\n` +
    `• Top Traders (batch testing)\n\n` +
    `Batch Testing:\n` +
    `• Tests ${MINTS_PER_BATCH} latest mints every ${MINT_BATCH_INTERVAL / 1000}s\n` +
    `• Waits ${MINT_TEST_TIMEOUT_SECONDS}s for responses\n` +
    `• Alerts on both success and failure\n\n` +
    `Commands:\n` +
    `/status - Check all connections\n` +
    `/restart - Restart all connections\n` +
    `/info - Show configuration\n` +
    `/mints - Show available mints`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const trendingStatus = trendingWs?.readyState === WebSocket.OPEN ? '✅' : '❌';
  const holdersStatus = holdersWs?.readyState === WebSocket.OPEN ? '✅' : '❌';
  const tradersStatus = tradersWs?.readyState === WebSocket.OPEN ? '✅' : '❌';
  
  bot.sendMessage(
    chatId,
    `📊 *Status Report*\n\n` +
    `Trending Pairs: ${trendingStatus}\n` +
    `Last msg: ${trendingLastMessageTime?.toLocaleTimeString() || 'Never'}\n\n` +
    `Top Holders: ${holdersStatus}\n` +
    `Last msg: ${holdersLastMessageTime?.toLocaleTimeString() || 'Never'}\n` +
    `Responses: ${holdersResponses.size}/${currentBatchMints.length}\n\n` +
    `Top Traders: ${tradersStatus}\n` +
    `Last msg: ${tradersLastMessageTime?.toLocaleTimeString() || 'Never'}\n` +
    `Responses: ${tradersResponses.size}/${currentBatchMints.length}\n\n` +
    `Available mints: ${availableMints.length}\n` +
    `Current batch: ${currentBatchMints.length} mints`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/restart/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔄 Restarting all connections...');
  
  // Close all connections
  if (trendingWs) trendingWs.close(1000, 'Manual restart');
  if (holdersWs) holdersWs.close(1000, 'Manual restart');
  if (tradersWs) tradersWs.close(1000, 'Manual restart');
  
  // Reset reconnect attempts
  trendingReconnectAttempts = 0;
  holdersReconnectAttempts = 0;
  tradersReconnectAttempts = 0;
  
  // Reconnect
  setTimeout(() => {
    connectTrendingPairs();
    connectTopHolders();
    connectTopTraders();
  }, 1000);
});

bot.onText(/\/info/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `ℹ️ *Configuration*\n\n` +
    `📡 Trending Pairs:\n\`${TRENDING_PAIRS_URL}\`\n` +
    `Timeout: ${TRENDING_TIMEOUT_SECONDS}s\n\n` +
    `📡 Top Holders:\n\`${TOP_HOLDERS_URL}\`\n\n` +
    `📡 Top Traders:\n\`${TOP_TRADERS_URL}\`\n\n` +
    `🔄 Batch Testing:\n` +
    `• Batch size: ${MINTS_PER_BATCH} mints\n` +
    `• Interval: ${MINT_BATCH_INTERVAL / 1000}s\n` +
    `• Wait time: ${MINT_TEST_TIMEOUT_SECONDS}s\n\n` +
    `Chat ID: \`${TELEGRAM_CHAT_ID}\``,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/mints/, (msg) => {
  const chatId = msg.chat.id;
  if (availableMints.length === 0) {
    bot.sendMessage(chatId, 'No mints available yet. Waiting for trending pairs data...');
  } else {
    const mintList = availableMints.slice(-10).map((m, i) => `${i + 1}. \`${m.substring(0, 30)}...\``).join('\n');
    const batchList = currentBatchMints.length > 0 
      ? currentBatchMints.map((m, i) => `${i + 1}. \`${m.substring(0, 20)}...\``).join('\n')
      : 'None yet';
    
    bot.sendMessage(
      chatId,
      `🪙 *Available Mints* (showing last 10 of ${availableMints.length}):\n\n${mintList}\n\n` +
      `📦 *Current Batch* (${currentBatchMints.length} mints):\n${batchList}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Handle graceful shutdown
function shutdown() {
  console.log('\n👋 Shutting down...');
  
  if (trendingTimeoutTimer) clearTimeout(trendingTimeoutTimer);
  if (batchTimer) clearInterval(batchTimer);
  if (batchTimeoutTimer) clearTimeout(batchTimeoutTimer);
  
  if (trendingWs) trendingWs.close(1000, 'Bot shutting down');
  if (holdersWs) holdersWs.close(1000, 'Bot shutting down');
  if (tradersWs) tradersWs.close(1000, 'Bot shutting down');
  
  bot.stopPolling();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the bot
console.log('🤖 Multi-WebSocket Monitor Bot starting...');
console.log(`📡 Trending Pairs: ${TRENDING_PAIRS_URL} (${TRENDING_TIMEOUT_SECONDS}s timeout)`);
console.log(`📡 Top Holders: ${TOP_HOLDERS_URL}`);
console.log(`📡 Top Traders: ${TOP_TRADERS_URL}`);
console.log(`🔄 Batch Testing: ${MINTS_PER_BATCH} mints every ${MINT_BATCH_INTERVAL / 1000}s (${MINT_TEST_TIMEOUT_SECONDS}s wait)\n`);

// Initialize all connections
connectTrendingPairs();
connectTopHolders();
connectTopTraders();

// Start batch testing after connections are established
startBatchTesting();

sendAlert(
  `✅ *Bot Started*\n\n` +
  `Monitoring 3 WebSocket endpoints:\n` +
  `• Trending Pairs (${TRENDING_TIMEOUT_SECONDS}s timeout)\n` +
  `• Top Holders (batch testing)\n` +
  `• Top Traders (batch testing)\n\n` +
  `Testing ${MINTS_PER_BATCH} mints every ${MINT_BATCH_INTERVAL / 1000}s\n` +
  `Waiting ${MINT_TEST_TIMEOUT_SECONDS}s for responses`
);
