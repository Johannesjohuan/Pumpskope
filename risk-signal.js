require('dotenv').config();
const HELIUS_KEY = process.env.HELIUS_KEY;
const BITQUERY_KEY = process.env.BITQUERY_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const riskCache = new Map();
const CACHE_DURATION = 300000;

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] [RISK] ${msg}`);
}

function formatNumber(v) {
  if (v === null || v === undefined || isNaN(v)) return '0';

  if (v < 1000) return Math.round(v).toString();

  if (v < 1000000) {
    const n = (v / 1000).toFixed(1);
    return n.endsWith('.0') ? n.slice(0, -2) + 'K' : n + 'K';
  }

  if (v < 1000000000) {
    const n = (v / 1000000).toFixed(1);
    return n.endsWith('.0') ? n.slice(0, -2) + 'M' : n + 'M';
  }

  const n = (v / 1000000000).toFixed(1);
  return n.endsWith('.0') ? n.slice(0, -2) + 'B' : n + 'B';
}

async function getTokenPriceFromBitquery(tokenAddress) {
    try {
        const query = `
        query MyQuery {
          Solana {
            DEXTradeByTokens(
              limit: { count: 1 }
              orderBy: { descending: Block_Time }
              where: {
                Trade: {
                  Currency: {
                    MintAddress: { is: "${tokenAddress}" }
                  }
                }
                Transaction: { Result: { Success: true } }
              }
            ) {
              Trade {
                PriceInUSD
              }
              Marketcap: calculate(expression: "1000000000 * $Trade_PriceInUSD")
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
            const result = data.data.Solana.DEXTradeByTokens[0];
            return {
                priceUsd: result.Trade.PriceInUSD,
                marketCap: result.Marketcap
            };
        }
        return { priceUsd: 0, marketCap: 0 };
    } catch (error) {
        return { priceUsd: 0, marketCap: 0 };
    }
}

async function getTokenCreationTime(tokenAddress) {
    try {
        const query = `
        query MyQuery {
          Solana {
            Instructions(
              where: {
                Instruction: {
                  Program: {
                    Address: {is: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"}
                  },
                  Accounts: {includes: {Address: {is: "${tokenAddress}"}}}
                }
              }
              limit: {count: 1}
            ) {
              Block {
                Time
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
        const timeStr = data?.data?.Solana?.Instructions?.[0]?.Block?.Time;
        return timeStr ? new Date(timeStr).getTime() : Date.now() - 3600000;
    } catch (e) {
        return Date.now() - 3600000;
    }
}

async function getWalletTransactions(wallet, tokenCA) {
    try {
        const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_KEY}&limit=100`;
        const response = await fetch(url);
        const txs = await response.json();
        if (!Array.isArray(txs)) return [];
        const results = [];
        for (const tx of txs) {
            const tokenMovement = tx.tokenTransfers?.find(t => t.mint === tokenCA);
            if (!tokenMovement) continue;
            const isSender = tokenMovement.fromUserAccount === wallet;
            const isReceiver = tokenMovement.toUserAccount === wallet;
            if (!isSender && !isReceiver) continue;
            let action = null;
            if (tx.source === "PUMP_FUN" || tx.type === "SWAP") {
                action = isSender ? "SELL" : "BUY";
            }
            if (!action) continue;
            const amount = tokenMovement.tokenAmount;
            if (amount < 1) continue;
            const amountDisplay = amount >= 1000000 ? (amount / 1000000).toFixed(2) + "M" : (amount / 1000).toFixed(2) + "K";
            results.push({
                action,
                amount: amountDisplay,
                time: new Date(tx.timestamp * 1000).toISOString(),
                signature: tx.signature
            });
        }
        return results;
    } catch (e) {
        return [];
    }
}

async function getTop10Velocity(topHolders) {
    log('Calculating top 10 velocity with volume...');
    if (!topHolders || !Array.isArray(topHolders) || topHolders.length === 0) {
        return {
            success: false,
            verdict: "⚪ NO DATA",
            riskLevel: "NEUTRAL",
            message: "Run Holder Analysis first"
        };
    }
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const thirtyMinAgo = now - 1800000;
    const top10 = topHolders.slice(0, 10);
    let last1h = { buyers: 0, sellers: 0, buyVolume: 0, sellVolume: 0 };
    let last30m = { buyers: 0, sellers: 0, buyVolume: 0, sellVolume: 0 };
    top10.forEach(holder => {
        const bought = parseFloat(holder.bought_amount?.replace(/,/g, '') || '0');
        const sold = parseFloat(holder.sold_amount?.replace(/,/g, '') || '0');
        if (holder.lastBuyTime && holder.lastBuyTime > oneHourAgo) {
            last1h.buyers++;
            last1h.buyVolume += bought;
        }
        if (holder.lastSellTime && holder.lastSellTime > oneHourAgo) {
            last1h.sellers++;
            last1h.sellVolume += sold;
        }
        if (holder.lastBuyTime && holder.lastBuyTime > thirtyMinAgo) {
            last30m.buyers++;
            last30m.buyVolume += bought;
        }
        if (holder.lastSellTime && holder.lastSellTime > thirtyMinAgo) {
            last30m.sellers++;
            last30m.sellVolume += sold;
        }
    });
    const totalBuyVolume = last1h.buyVolume + last30m.buyVolume;
    const totalSellVolume = last1h.sellVolume + last30m.sellVolume;
    let verdict = "⚪ NEUTRAL";
    let riskLevel = "NEUTRAL";
    let reason = "Balanced volume";
    if (totalSellVolume > totalBuyVolume * 1.5) {
        verdict = "🔴 HIGH RISK";
        riskLevel = "HIGH";
        reason = `Sellers dumped ${formatNumber(totalSellVolume)} vs buyers ${formatNumber(totalBuyVolume)}`;
    } else if (totalBuyVolume > totalSellVolume * 1.5) {
        verdict = "🟢 LOW RISK";
        riskLevel = "LOW";
        reason = `Buyers accumulated ${formatNumber(totalBuyVolume)} vs sellers ${formatNumber(totalSellVolume)}`;
    }
    return {
        success: true,
        verdict,
        riskLevel,
        reason,
        last1h: {
            buyers: last1h.buyers,
            sellers: last1h.sellers,
            buyVolume: formatNumber(last1h.buyVolume),
            sellVolume: formatNumber(last1h.sellVolume)
        },
        last30m: {
            buyers: last30m.buyers,
            sellers: last30m.sellers,
            buyVolume: formatNumber(last30m.buyVolume),
            sellVolume: formatNumber(last30m.sellVolume)
        },
        totals: {
            buyVolume: formatNumber(totalBuyVolume),
            sellVolume: formatNumber(totalSellVolume)
        }
    };
}

async function checkHoneypot(topHolders, mintAuthority, freezeAuthority) {
    log('Checking honeypot using professional logic...');
    if (mintAuthority) {
        return {
            isHoneypot: true,
            riskLevel: "🔴 HONEYPOT",
            summary: "Mint authority active",
            details: "Dev can print unlimited tokens",
            canBuy: true,
            canSell: false
        };
    }
    if (freezeAuthority) {
        return {
            isHoneypot: true,
            riskLevel: "🔴 HONEYPOT",
            summary: "Freeze authority active",
            details: "Dev can freeze your wallet",
            canBuy: true,
            canSell: false
        };
    }
    let totalBuyers = 0;
    let totalSellers = 0;
    if (topHolders && Array.isArray(topHolders)) {
        topHolders.forEach(holder => {
            if (holder.is_dev) return;
            if (holder.bought_amount && parseFloat(holder.bought_amount.replace(/,/g, '')) > 0) {
                totalBuyers++;
            }
            if (holder.sold_amount && parseFloat(holder.sold_amount.replace(/,/g, '')) > 0) {
                totalSellers++;
            }
        });
    }
    if (totalBuyers > 10 && totalSellers === 0) {
        return {
            isHoneypot: true,
            riskLevel: "🔴 HONEYPOT",
            summary: "Buyers can't sell",
            details: `${totalBuyers} buyers but 0 sellers`,
            canBuy: true,
            canSell: false
        };
    }
    return {
        isHoneypot: false,
        riskLevel: "🟢 SAFE",
        summary: "✅ Users Can Sell",
        details: `${totalSellers} user(s) have sold`,
        canBuy: true,
        canSell: true
    };
}

async function calculateTrustScores(recursiveWallets = [], walletTransactions = {}) {
    log(`Calculating trust scores for ${recursiveWallets?.length || 0} wallets...`);
    console.log('\n🔵 ===== TRUST SCORE DEBUG =====');
    console.log(`🔵 Raw recursiveWallets:`, JSON.stringify(recursiveWallets, null, 2));
    console.log(`🔵 walletTransactions keys:`, Object.keys(walletTransactions));
    if (!recursiveWallets || !Array.isArray(recursiveWallets) || recursiveWallets.length === 0) {
        console.log('🔵 No recursive wallets found');
        return {
            wallets: [],
            summary: "No recursive wallets detected",
            highRisk: 0,
            mediumRisk: 0,
            lowRisk: 0,
            totalWallets: 0
        };
    }
    const TOTAL_SUPPLY = 1000000000;
    console.log(`🔵 TOTAL_SUPPLY: ${TOTAL_SUPPLY}`);
    const scoredWallets = recursiveWallets.map((w, index) => {
        console.log(`\n🔵 Processing wallet #${index + 1}:`);
        console.log(`🔵 Wallet data:`, JSON.stringify(w, null, 2));
        if (!w || !w.address) {
            console.log(`🔵 Skipping - no address`);
            return null;
        }
        const txs = walletTransactions[w.address] || [];
        console.log(`🔵 Found ${txs.length} transactions for this wallet`);
        let totalSold = 0;
        let sellCount = 0;
        txs.forEach(tx => {
            if (tx.action && tx.action.includes("SELL")) {
                let amount = 0;
                const match = tx.amount ? tx.amount.match(/^([\d.]+)/) : null;
                if (match) {
                    amount = parseFloat(match[1]);
                    if (tx.amount && tx.amount.includes('M')) amount *= 1000000;
                    else if (tx.amount && tx.amount.includes('K')) amount *= 1000;
                }
                totalSold += amount;
                sellCount++;
            }
        });
        const soldPercentage = (totalSold / TOTAL_SUPPLY) * 100;
        const receivedPercentage = parseFloat(w.percentage || '0');
        let risk = "🟢 LOW";
        let riskColor = "🟢";
        let reasons = [];
        let trustScore = 100;
        let summary = "🟢 LOW RISK";
        if (soldPercentage > 2) {
            risk = "🔴 HIGH";
            riskColor = "🔴";
            trustScore = 20;
            summary = `🔴 HIGH RISK: Sold ${formatNumber(totalSold)} total`;
            reasons.push(`Sold ${soldPercentage.toFixed(2)}% of total supply (ABOVE 2% threshold)`);
        } else if (sellCount > 0) {
            risk = "🟡 MEDIUM";
            riskColor = "🟡";
            trustScore = 60;
            summary = `🟡 MEDIUM RISK: Sold ${formatNumber(totalSold)} total`;
            reasons.push(`Sold ${soldPercentage.toFixed(2)}% of total supply (below 2% threshold)`);
        } else {
            risk = "🟢 LOW";
            riskColor = "🟢";
            trustScore = 100;
            summary = "🟢 LOW RISK";
            reasons.push("No sells detected");
        }
        if (receivedPercentage > 0) {
            reasons.push(`Received ${receivedPercentage.toFixed(2)}% of supply`);
        }
        return {
            wallet: w.address,
            address: w.address.slice(0,8) + '...' + w.address.slice(-8),
            amount: w.amount || "0",
            percentage: w.percentage || "0",
            trustScore: trustScore,
            riskLevel: risk,
            riskColor,
            summary: summary,
            reasons: reasons.slice(0, 3),
            soldAmount: totalSold,
            soldPercentage: soldPercentage.toFixed(2)
        };
    });
    const validWallets = scoredWallets.filter(w => w !== null);
    const highRisk = validWallets.filter(w => w.riskLevel === "🔴 HIGH").length;
    const mediumRisk = validWallets.filter(w => w.riskLevel === "🟡 MEDIUM").length;
    const lowRisk = validWallets.filter(w => w.riskLevel === "🟢 LOW").length;
    return {
        wallets: validWallets,
        summary: `${highRisk} HIGH | ${mediumRisk} MEDIUM | ${lowRisk} LOW`,
        highRisk,
        mediumRisk,
        lowRisk,
        totalWallets: validWallets.length
    };
}

async function getDevHistory(devWallet) {
    log(`Fetching last 24h history for ${devWallet?.slice(0,8)}...`);
    
    if (!devWallet || devWallet === "Not found" || devWallet === "Unknown") {
        return {
            totalCoins24h: 0,
            highestAth24h: 0,
            summary: "Dev wallet unknown"
        };
    }
    
    try {
        const twentyFourHoursAgo = new Date(Date.now() - 86400000).toISOString();
        
        // Step 1: Get all tokens created in last 24h
        const discoveryQuery = `
        {
          Solana(dataset: realtime) {
            Instructions(
              where: {
                Instruction: {
                  Program: {
                    Address: {is: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"}
                    Method: {in: ["create", "create_v2"]}
                  }
                }
                Transaction: {
                  Signer: {is: "${devWallet}"}
                  Result: {Success: true}
                }
                Block: {
                  Time: {after: "${twentyFourHoursAgo}"}
                }
              }
              limit: {count: 50}
              orderBy: {descending: Block_Time}
            ) {
              Instruction {
                Accounts {
                  Address
                }
              }
            }
          }
        }`;
        
        const discResponse = await fetch('https://streaming.bitquery.io/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BITQUERY_KEY}`
            },
            body: JSON.stringify({ query: discoveryQuery })
        });
        
        const discData = await discResponse.json();
        const instructions = discData?.data?.Solana?.Instructions || [];
        
        if (instructions.length === 0) {
            return {
                totalCoins24h: 0,
                highestAth24h: 0,
                summary: "No coins created in last 24h"
            };
        }
        
        // Extract unique token mints
        const tokenMints = [];
        instructions.forEach(ix => {
            const mint = ix.Instruction?.Accounts?.[0]?.Address;
            if (mint && !tokenMints.includes(mint)) {
                tokenMints.push(mint);
            }
        });
        
        const totalCoins24h = tokenMints.length;
        
        // Step 2: Get all trades for ALL these tokens
        const athQuery = `
        {
          Solana(dataset: realtime) {
            DEXTradeByTokens(
              where: { 
                Trade: { 
                  Currency: { 
                    MintAddress: { 
                      in: ${JSON.stringify(tokenMints)}
                    }
                  }
                }
              }
              limit: { count: 1000 }
              orderBy: { descending: Trade_PriceInUSD }
            ) {
              Trade {
                Currency {
                  MintAddress
                }
                PriceInUSD
              }
            }
          }
        }`;
        
        const athResponse = await fetch('https://streaming.bitquery.io/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BITQUERY_KEY}`
            },
            body: JSON.stringify({ query: athQuery })
        });
        
        const athData = await athResponse.json();
        const allTrades = athData?.data?.Solana?.DEXTradeByTokens || [];
        
        // Step 3: For EACH token, find its highest market cap
        let highestAth24h = 0;
        
        tokenMints.forEach(mint => {
            // Get all trades for this specific token
            const tokenTrades = allTrades.filter(t => t.Trade.Currency.MintAddress === mint);
            
            let highestPriceForToken = 0;
            
            tokenTrades.forEach(t => {
                const price = t.Trade.PriceInUSD || 0;
                if (price > highestPriceForToken) {
                    highestPriceForToken = price;
                }
            });
            
            // Convert highest price to market cap
            // If price > 1000, it's probably already market cap
           const TOTAL_SUPPLY = 1000000000;
           const marketCap = highestPriceForToken * TOTAL_SUPPLY;
            
            console.log(`🔵 Token ${mint.slice(0,8)}: ATH $${formatNumber(marketCap)}`);
            
            if (marketCap > highestAth24h) {
                highestAth24h = marketCap;
            }
        });
        
        return {
            totalCoins24h,
            highestAth24h,
            summary: `${totalCoins24h} launched | Highest ATH: $${formatNumber(highestAth24h)}`
        };
        
    } catch (error) {
        console.log(`🔵 Error:`, error);
        return {
            totalCoins24h: 0,
            highestAth24h: 0,
            summary: "Error fetching data"
        };
    }
}

async function analyzeRisks(req, res) {
    console.log('\n🔍 ===== RISK SIGNALS ANALYSIS =====');
    console.log(`📍 Time: ${new Date().toLocaleTimeString()}`);
    if (!req.body || !req.body.token_address) {
        console.log('❌ ERROR: No token address provided');
        return res.status(400).json({ 
            success: false, 
            error: 'Token address is required' 
        });
    }
    const {
        token_address,
        dev_wallet,
        top_holders = [],
        recursive_wallets = []
    } = req.body;
    console.log(`📍 Token: ${token_address}`);
    console.log(`👤 Dev Wallet: ${dev_wallet}`);
    console.log(`📊 Top Holders: ${top_holders?.length || 0}`);
    console.log(`🔄 Recursive Wallets: ${recursive_wallets?.length || 0}`);
    try {
        const tokenCreationTime = await getTokenCreationTime(token_address);
        const walletTransactions = {};
        for (const w of recursive_wallets) {
            if (w && w.address) {
                console.log(`🔵 Fetching transactions for ${w.address.slice(0,8)}...`);
                const txs = await getWalletTransactions(w.address, token_address);
                walletTransactions[w.address] = txs;
                console.log(`🔵 Found ${txs.length} transactions`);
            }
        }
        const [velocity, honeypot, trustScores, devHistory] = await Promise.all([
            getTop10Velocity(top_holders),
            checkHoneypot(top_holders),
            calculateTrustScores(recursive_wallets, walletTransactions),
            getDevHistory(dev_wallet)
        ]);
        const results = {
            success: true,
            velocity,
            honeypot,
            trustScores,
            devHistory,
            analysis_time: new Date().toLocaleString()
        };
        console.log('\n✅ Risk analysis complete');
        console.log(`   Velocity: ${velocity.verdict} - ${velocity.reason}`);
        console.log(`   Honeypot: ${honeypot.summary} (${honeypot.riskLevel})`);
        console.log(`   Trust Scores: ${trustScores.summary}`);
        console.log(`   Dev History: ${devHistory.summary}`);
        console.log('=====================================\n');
        res.json(results);
    } catch (error) {
        console.log(`❌ Fatal error: ${error.message}`);
        console.log(error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
}

module.exports = { analyzeRisks };