require('dotenv').config();
const express = require('express');
const Moralis = require('moralis').default;
const http = require('http');
const WebSocket = require('ws');
const { Connection } = require('@solana/web3.js');
const supabase = require('./supabase.js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });


app.use((req, res, next) => {
    
    res.header('Access-Control-Allow-Origin', 'https://pumpskope.com');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
  
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const API_KEY = process.env.MORALIS_KEY;
const BITQUERY_KEY = process.env.BITQUERY_KEY;
const HELIUS_KEY = process.env.HELIUS_KEY;

const connection = new Connection("https://api.mainnet-beta.solana.com", "finalized");

app.use(express.static("public"));
app.use(express.json());

app.get('/favicon-32x32.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon-32x32.png'));
});

let cachedSolPrice = 85.00;

async function updateGlobalPrice() {
    try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        const data = await response.json();
        const price = data.solana.usd;
        if (price && !isNaN(price) && price > 0) {
            cachedSolPrice = price;
        }
    } catch (error) {}
}

setInterval(updateGlobalPrice, 30 * 60 * 1000);
updateGlobalPrice();


const userSessions = new Map();
const analyzedTokens = new Map(); 
const processedSignatures = new Map(); 

wss.on('connection', (ws) => {
    console.log(`🔌 New WebSocket client connected. Total clients: ${wss.clients.size}`);
    
    ws.on('message', async (message) => {
        try {
            const { tokenCA } = JSON.parse(message);
            if (!tokenCA) return;
            
         
            userSessions.set(ws, tokenCA);
            console.log(`👤 User analyzing: ${tokenCA}`);
            
           
            let tokenName = "Unknown Token";
            let tokenImage = null;
            try {
                const meta = await Moralis.SolApi.token.getTokenMetadata({ 
                    network: "mainnet", 
                    address: tokenCA 
                });
                tokenName = meta.raw.name || "Unknown Token";
                tokenImage = meta.raw.logo || null;
            } catch (e) {
                console.log('Moralis metadata failed, using fallback');
            }
            
           
            const creator = await getDevWalletFromBitquery(tokenCA) || "Unknown";
            
      
            const { marketCap } = await getTokenPriceFromBitquery(tokenCA);
            
           
            const imageUrl = tokenImage || await (async () => {
                try {
                    const r = await fetch(`https://pumpportal.fun/api/token?mint=${tokenCA}`);
                    return r.ok ? (await r.json()).image : null;
                } catch {
                    return null;
                }
            })();
            
        
            let trades = [];
            
            if (!analyzedTokens.has(tokenCA)) {
                
                console.log(`📊 First time analyzing ${tokenCA}, fetching full history...`);
                trades = creator !== "Unknown" ? await getTokenTransactions(creator, tokenCA) : [];
                analyzedTokens.set(tokenCA, {
                    transactions: trades,
                    analyzedAt: Date.now()
                });
            } else {
              
                console.log(`📊 Using cached data for ${tokenCA}`);
                trades = analyzedTokens.get(tokenCA).transactions;
            }
            
      
            console.log(`👤 Showing all ${trades.length} trades`);
           
            ws.send(JSON.stringify({ 
                type: 'SUCCESS', 
                mint: tokenCA, 
                name: tokenName,
                creator, 
                mcap: Math.round(marketCap),
                image: imageUrl, 
                trades: trades
            }));
            
         
            trades.forEach(tx => {
                if (tx.action === "TRANSFER_OUT" && tx.recipient) {
                 
                    const amountNum = parseFloat(tx.amount.replace(/[MK]/g, '')) * 
                        (tx.amount.includes('M') ? 1000000 : 1000);
                    const totalSupply = 1000000000; 
                    const percentage = (amountNum / totalSupply * 100).toFixed(2);
                    
                    ws.send(JSON.stringify({
                        type: "RECURSIVE_TRACKING",
                        message: `🔄 Recursive wallet detected`,
                        wallet: tx.recipient,
                        shortWallet: tx.recipient.slice(0,6),
                        amount: tx.amount,
                        percentage: percentage
                    }));
                }
            });
            
            console.log(`✅ Sent ${trades.length} trades to frontend`);
            
        } catch (err) { 
            console.error('WebSocket error:', err);
            ws.send(JSON.stringify({ type: 'ERROR' })); 
        }
    });
    
    ws.on('close', () => {
        userSessions.delete(ws);
        console.log(`🔌 Client disconnected. Total clients: ${wss.clients.size}`);
    });
});

(async () => {
    try {
        const { data, error } = await supabase.from('transactions').select('count').limit(1);
        if (error) console.log('❌ Supabase connection error:', error.message);
        else console.log('✅ Supabase connected');
    } catch (err) { console.log('❌ Supabase connection failed:', err.message); }
})();

Moralis.start({ apiKey: API_KEY }).then(() => {
    console.log("✅ Moralis Engine Primed (Metadata Only)");
});

let activeDevWallets = {};
let recursiveWalletsByToken = new Map();

function storeRecursiveWallet(tokenCA, walletData) {
    if (!recursiveWalletsByToken.has(tokenCA)) {
        recursiveWalletsByToken.set(tokenCA, []);
    }
    const wallets = recursiveWalletsByToken.get(tokenCA);
    if (!wallets.some(w => w.wallet === walletData.wallet)) {
        wallets.push({
            wallet: walletData.wallet,
            amount: walletData.amount,
            percentage: walletData.percentage,
            timestamp: walletData.timestamp,
            detectedAt: new Date().toISOString()
        });
        console.log(`🔄 Stored recursive wallet: ${walletData.wallet.slice(0,8)}... (${walletData.percentage}%)`);
    }
}

app.get('/api/recursive-wallets/:tokenCA', (req, res) => {
    const { tokenCA } = req.params;
    const wallets = recursiveWalletsByToken.get(tokenCA) || [];
    res.json({ success: true, wallets });
});

async function getTokenSupply(tokenCA) {
    try {
        const metadata = await Moralis.SolApi.token.getTokenMetadata({ 
            network: "mainnet", 
            address: tokenCA 
        });
        if (metadata.raw.supply) return metadata.raw.supply;
        const response = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_KEY}&mint=${tokenCA}`);
        const data = await response.json();
        return data?.supply || 1000000000;
    } catch (error) {
        return 1000000000;
    }
}

async function getDevWalletFromBitquery(tokenCA) {
    try {
        const query = `
        {
          solana(network: solana) {
            transfers(
              date: {since: "2023-01-01"}
              options: {limit: 1, asc: ["block.height", "transaction.transactionIndex"]}
              currency: {is: "${tokenCA}"}
            ) {
              transaction {
                creator:signer
                transactionIndex
              }
              block {
                height
              }
            }
          }
        }`;
        
        const response = await fetch('https://graphql.bitquery.io', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BITQUERY_KEY}`
            },
            body: JSON.stringify({ query })
        });
        
        const data = await response.json();
        return data?.data?.solana?.transfers?.[0]?.transaction?.creator || null;
    } catch (error) {
        console.error('Bitquery V1 error:', error);
        return null;
    }
}


async function getTokenPriceFromBitquery(tokenCA) {
    try {
        const query = `
        {
          Solana {
            DEXTradeByTokens(
              where: {
                Trade: {
                  Currency: {
                    MintAddress: { is: "${tokenCA}" }
                  }
                }
              }
              limit: { count: 1 }
              orderBy: { descending: Block_Time }
            ) {
              Trade {
                PriceInUSD
              }
            }
          }
        }`;
        
        const response = await fetch('https://streaming.bitquery.io/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BITQUERY_KEY}`
            },
            body: JSON.stringify({ query })
        });

        const data = await response.json();
        
        if (data.data?.Solana?.DEXTradeByTokens?.[0]) {
            const price = parseFloat(data.data.Solana.DEXTradeByTokens[0].Trade.PriceInUSD);
            console.log(`💰 Bitquery price: $${price}`);
            return {
                priceUsd: price,
                marketCap: price * 1000000000
            };
        }
        
        console.log(`⚠️ No price data for ${tokenCA}, using fallback`);
        return { priceUsd: 0.000005, marketCap: 5000 };
        
    } catch (error) {
        console.error('Bitquery price error:', error);
        return { priceUsd: 0.000005, marketCap: 5000 };
    }
}

function extractSolAmount(tx, traderAddress, tokenCA) {
    console.log(`\n🔍 EXTRACTING SOL for TX: ${tx.signature.slice(0,16)}...`);
    if (tx.transactionError) {
        console.log(`   ❌ Transaction failed - skipping`);
        return { solAmount: 0, isBuy: false };
    }
    console.log(`   💰 Checking account balance change...`);
    const account = tx.accountData?.find(a => a.account === traderAddress);
    if (account && account.nativeBalanceChange !== 0) {
        const rawChange = account.nativeBalanceChange / 1_000_000_000;
        const solAmount = Math.abs(rawChange);
        const isBuy = rawChange < 0;
        console.log(`   ✅ BALANCE CHANGE: ${solAmount.toFixed(6)} SOL (${isBuy ? 'BUY' : 'SELL'})`);
        return { solAmount, isBuy };
    }
    console.log(`   🔄 Checking swap events...`);
    if (tx.events?.swap) {
        const swap = tx.events.swap;
        if (swap.nativeInput?.amount) {
            const solAmount = swap.nativeInput.amount / 1e9;
            console.log(`   ✅ SWAP INPUT: ${solAmount.toFixed(6)} SOL`);
            return { solAmount, isBuy: true };
        }
        if (swap.nativeOutput?.amount) {
            const solAmount = swap.nativeOutput.amount / 1e9;
            console.log(`   ✅ SWAP OUTPUT: ${solAmount.toFixed(6)} SOL`);
            return { solAmount, isBuy: false };
        }
    }
    console.log(`   💸 Checking nativeTransfers...`);
    const transfers = tx.nativeTransfers?.filter(t => 
        (t.fromUserAccount === traderAddress || t.toUserAccount === traderAddress) &&
        Math.abs(t.amount) > 1000
    );
    if (transfers && transfers.length > 0) {
        const mainTransfer = transfers.reduce((prev, current) => 
            (Math.abs(prev.amount) > Math.abs(current.amount)) ? prev : current
        );
        const solAmount = Math.abs(mainTransfer.amount) / 1_000_000_000;
        const isBuy = mainTransfer.fromUserAccount === traderAddress;
        console.log(`   ⚠️ NATIVE TRANSFER: ${solAmount.toFixed(6)} SOL (may be dust)`);
        return { solAmount, isBuy };
    }
    console.log(`   ❌ No SOL found`);
    return { solAmount: 0, isBuy: false };
}

async function getSolPriceAtTimestamp(timestamp) {
    try {
        const date = new Date(timestamp);
        const hourKey = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}-${date.getUTCHours()}`;
        let { data: solPrice } = await supabase
            .from('sol_price_history')
            .select('id, price_usd')
            .eq('hour_key', hourKey)
            .single();
        if (!solPrice) {
            const response = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot');
            const json = await response.json();
            const livePrice = parseFloat(json.data.amount);
            const { data: newPrice } = await supabase
                .from('sol_price_history')
                .insert([{
                    price_usd: livePrice,
                    recorded_at: new Date().toISOString(),
                    hour_key: hourKey
                }])
                .select('id, price_usd')
                .single();
            return newPrice;
        }
        return solPrice;
    } catch (error) {
        const { data: lastKnown } = await supabase
            .from('sol_price_history')
            .select('price_usd')
            .order('recorded_at', { ascending: false })
            .limit(1)
            .single();
        return lastKnown || { price_usd: cachedSolPrice };
    }
}

async function getWalletTransactions(wallet, tokenCA) {
    console.log(`\n📡 FETCHING RECURSIVE WALLET HISTORY: ${wallet.slice(0,8)}...`);
    let allTransactions = [];
    let lastSignature = null;
    let page = 1;
    const MAX_PAGES = 3;
    while (page <= MAX_PAGES) {
        console.log(`\n📄 Page ${page} - Fetching...`);
        const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_KEY}&limit=100${lastSignature ? `&before=${lastSignature}` : ''}`;
        try {
            const response = await fetch(url);
            const txs = await response.json();
            if (!Array.isArray(txs) || txs.length === 0) {
                break;
            }
            for (const tx of txs) {
                const result = await classifyTransaction(tx, tokenCA, wallet);
                if (result) {
                    allTransactions.push(result);
                }
            }
            if (txs.length > 0) {
                lastSignature = txs[txs.length - 1].signature;
            }
            page++;
        } catch (err) {
            console.log(`   ⚠️ Error fetching page ${page}: ${err.message}`);
            break;
        }
    }
    allTransactions.sort((a, b) => new Date(b.time) - new Date(a.time));
    console.log(`\n📊 FOUND ${allTransactions.length} transactions for wallet ${wallet.slice(0,8)}...`);
    return allTransactions;
}

async function classifyTransaction(tx, tokenCA, wallet) {
    const tokenMovement = tx.tokenTransfers?.find(t => t.mint === tokenCA);
    if (!tokenMovement) return null;
    const isSender = tokenMovement.fromUserAccount === wallet;
    const isReceiver = tokenMovement.toUserAccount === wallet;
    if (!isSender && !isReceiver) return null;
    let action = null;
    const isCreate = tx.instructions?.some(ix => ix.programId === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    if (tx.type === "CREATE_POOL" || (isCreate && tx.type === "UNKNOWN")) {
        action = "CREATE";
    } else if (tx.source === "PUMP_FUN" || tx.type === "SWAP") {
        action = isSender ? "SELL" : "BUY";
    } else if (tx.type === "TRANSFER") {
        if (tokenMovement.toUserAccount?.includes('pump') || tokenMovement.fromUserAccount?.includes('pump')) return null;
        if (!isSender) return null;
        action = "TRANSFER_OUT";
    }
    if (!action) return null;
    const amount = tokenMovement.tokenAmount;
    if (amount < 1) return null;
    const amountDisplay = amount >= 1000000 ? (amount / 1000000).toFixed(2) + "M" : (amount / 1000).toFixed(2) + "K";
    let marketCap = 0;
    if (action === "BUY" || action === "SELL") {
        const { solAmount } = extractSolAmount(tx, wallet, tokenCA);
        if (solAmount > 0 && amount > 0) {
            const txTime = new Date(tx.timestamp * 1000).toISOString();
            const solPriceData = await getSolPriceAtTimestamp(txTime);
            const tokenPriceInSol = solAmount / amount;
            marketCap = Math.round(tokenPriceInSol * solPriceData.price_usd * 1000000000);
        }
    } else if (action === "CREATE") {
        const txTime = new Date(tx.timestamp * 1000).toISOString();
        const solPriceData = await getSolPriceAtTimestamp(txTime);
        const initialVirtualSol = 30;
        marketCap = Math.round(initialVirtualSol * solPriceData.price_usd);
    }
    return {
        action,
        amount: amountDisplay,
        mcap: marketCap,
        time: new Date(tx.timestamp * 1000).toISOString(),
        signature: tx.signature,
        recipient: isSender ? tokenMovement.toUserAccount : null,
        isDev: false,
        wallet: wallet,
        walletShort: wallet.slice(0, 6)
    };
}

async function getFullDevHistory(devWallet, tokenCA) {
    console.log(`\n📡 FETCHING HISTORY FOR: ${tokenCA.slice(0,8)}...`);
    console.log(`   Dev Wallet: ${devWallet.slice(0,8)}...`);
    let allTransactions = [];
    let lastSignature = null;
    let foundCreate = false;
    let page = 1;
    
    if (!processedSignatures.has(tokenCA)) {
        processedSignatures.set(tokenCA, new Set());
    }
    const tokenSignatures = processedSignatures.get(tokenCA);
    
    while (!foundCreate && page <= 5) {
        console.log(`\n📄 Page ${page} - Fetching...`);
        const url = `https://api.helius.xyz/v0/addresses/${devWallet}/transactions?api-key=${HELIUS_KEY}&limit=100${lastSignature ? `&before=${lastSignature}` : ''}`;
        try {
            const response = await fetch(url);
            const txs = await response.json();
            console.log(`   Raw Helius returned: ${txs.length} transactions`);
            if (!Array.isArray(txs) || txs.length === 0) {
                console.log(`   No transactions on page ${page}`);
                break;
            }
            let pageCount = 0;
            for (const tx of txs) {
                if (tokenSignatures.has(tx.signature)) {
                    console.log(`   ⏭️ Skipping duplicate: ${tx.signature.slice(0,8)}...`);
                    continue;
                }
                tokenSignatures.add(tx.signature);
                
                const result = await classifyTransaction(tx, tokenCA, devWallet);
                if (result) {
                    allTransactions.push(result);
                    pageCount++;
                    if (result.action === "CREATE") {
                        foundCreate = true;
                        console.log(`   🎉 Found CREATE transaction!`);
                    }
                }
            }
            console.log(`   Page ${page} found ${pageCount} relevant transactions`);
            if (txs.length > 0) {
                lastSignature = txs[txs.length - 1].signature;
                console.log(`   Next page before: ${lastSignature.slice(0,8)}...`);
            }
            page++;
        } catch (err) {
            console.log(`   ⚠️ Error fetching page ${page}: ${err.message}`);
            break;
        }
    }
    allTransactions.sort((a, b) => new Date(b.time) - new Date(a.time));
    console.log(`\n📊 TOTAL FOUND: ${allTransactions.length} transactions`);
    return allTransactions;
}

async function getTokenTransactions(devWallet, tokenCA) {
    console.log(`\n--- FETCHING DEV ACTIVITY: ${tokenCA} ---`);
    console.log(`   👤 Dev Wallet: ${devWallet.slice(0,8)}...`);
    
    const transactions = await getFullDevHistory(devWallet, tokenCA);
    
    for (const tx of transactions) {
        if (tx.action === "TRANSFER_OUT" && tx.recipient) {
            const totalSupply = await getTokenSupply(tokenCA);
            const amountNum = parseFloat(tx.amount.replace(/[MK]/g, '')) * 
                (tx.amount.includes('M') ? 1000000 : 1000);
            const percentage = (amountNum / totalSupply) * 100;
            
            if (percentage > 0.9 && tx.recipient) {
                storeRecursiveWallet(tokenCA, {
                    wallet: tx.recipient,
                    amount: tx.amount,
                    percentage: percentage.toFixed(2),
                    timestamp: tx.time
                });
            }
        }
    }
    
    console.log(`\n📤 FOUND ${transactions.length} TRADES`);
    return transactions;
}

app.get('/api/wallet-transactions/:tokenCA/:wallet', async (req, res) => {
    const { tokenCA, wallet } = req.params;
    try {
        console.log(`\n🔍 FETCHING TRANSACTIONS FOR RECURSIVE WALLET: ${wallet.slice(0,8)}...`);
        const transactions = await getWalletTransactions(wallet, tokenCA);
        res.json({ success: true, trades: transactions });
    } catch (error) {
        console.error('Error fetching wallet transactions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/refresh-mcap/:tokenCA', async (req, res) => {
    const { tokenCA } = req.params;
    try {
        const { marketCap } = await getTokenPriceFromBitquery(tokenCA);
        res.json({ success: true, mcap: Math.round(marketCap) });
    } catch (error) {
        console.error('Refresh MCAP error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const { analyzeToken } = require('./holder-analysis.js');
app.post('/api/analyze-holders', analyzeToken);

const { analyzeRisks } = require('./risk-signal.js');
app.post('/api/analyze-risks', analyzeRisks);

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
    console.log(`🚀 Server on port ${PORT}`);
});
