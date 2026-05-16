const HELIUS_API_KEY = process.env.HELIUS_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const sellsCache = new Map();
const ownerCache = new Map();
const CACHE_DURATION = 300000;

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] [HOLDER] ${msg}`);
}

function cleanWalletString(wallet) {
    if (!wallet || typeof wallet !== 'string') return "Not found";
    const match = wallet.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    return match ? match[0] : wallet;
}

function doWalletsMatch(wallet1, wallet2) {
    if (!wallet1 || !wallet2) return false;
    if (wallet1 === wallet2) return true;
    if (wallet1.includes(wallet2) || wallet2.includes(wallet1)) return true;
    if (wallet1.slice(0,8) === wallet2.slice(0,8)) return true;
    if (wallet1.slice(-8) === wallet2.slice(-8)) return true;
    return false;
}

async function getTokenMetadata(tokenAddress) {
    log(`Fetching metadata for ${tokenAddress.slice(0,8)}...`);
    try {
        const response = await fetch(`https://tokens.jup.ag/token/${tokenAddress}`, {
            timeout: 5000
        });
        if (response.ok) {
            const data = await response.json();
            const name = data.name || '';
            const symbol = data.symbol || '';
            if (name && symbol) {
                log(`✅ Jupiter: ${name} (${symbol})`);
                return { name, symbol };
            }
        }
    } catch (e) {
        log(`⚠️ Jupiter error: ${e.message}`);
    }
    const placeholder = `Token ${tokenAddress.slice(0,4)}...${tokenAddress.slice(-4)}`;
    return { name: placeholder, symbol: "???" };
}

async function getAccountOwner(tokenAccount) {
    if (ownerCache.has(tokenAccount)) {
        const { timestamp, owner } = ownerCache.get(tokenAccount);
        if (Date.now() - timestamp < CACHE_DURATION) {
            return owner;
        }
    }
    try {
        const payload = {
            jsonrpc: "2.0",
            id: 1,
            method: "getAccountInfo",
            params: [tokenAccount, { encoding: "jsonParsed" }]
        };
        const response = await fetch(HELIUS_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        const value = data.result?.value;
        if (value?.data?.parsed?.info?.owner) {
            const owner = value.data.parsed.info.owner;
            ownerCache.set(tokenAccount, { timestamp: Date.now(), owner });
            return owner;
        }
    } catch (e) {
        log(`⚠️ Error getting owner for ${tokenAccount.slice(0,8)}: ${e.message}`);
    }
    ownerCache.set(tokenAccount, { timestamp: Date.now(), owner: "Unknown" });
    return "Unknown";
}

async function getWalletSells(walletAddress, tokenMint, decimals, limit = 15) {
    const cacheKey = `${walletAddress}_${tokenMint}`;
    const now = Date.now();
    if (sellsCache.has(cacheKey)) {
        const { timestamp, amount, lastSellTime } = sellsCache.get(cacheKey);
        if (now - timestamp < CACHE_DURATION) {
            return { totalSold: amount, lastSellTime };
        }
    }
    let totalSold = 0;
    let lastSellTime = null;
    try {
        const sigResponse = await fetch(HELIUS_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: "2.0", id: 1,
                method: "getSignaturesForAddress",
                params: [walletAddress, { limit }]
            })
        });
        const sigData = await sigResponse.json();
        const sigs = sigData.result || [];
        for (const sigInfo of sigs) {
            const txResponse = await fetch(HELIUS_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0", id: 1,
                    method: "getTransaction",
                    params: [sigInfo.signature, { 
                        encoding: "jsonParsed", 
                        maxSupportedTransactionVersion: 0 
                    }]
                })
            });
            const txData = await txResponse.json();
            const tx = txData.result;
            if (!tx || !tx.meta) continue;
            const preBalances = tx.meta.preTokenBalances || [];
            const postBalances = tx.meta.postTokenBalances || [];
            const pre = preBalances.find(b => b.owner === walletAddress && b.mint === tokenMint);
            if (pre) {
                const post = postBalances.find(b => b.owner === walletAddress && b.mint === tokenMint);
                const preAmount = BigInt(pre.uiTokenAmount?.amount || "0");
                const postAmount = post ? BigInt(post.uiTokenAmount?.amount || "0") : BigInt(0);
                if (postAmount < preAmount) {
                    const diff = preAmount - postAmount;
                    const soldAmount = Number(diff) / Math.pow(10, decimals);
                    totalSold += soldAmount;
                    const txTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();
                    if (!lastSellTime || txTime > lastSellTime) {
                        lastSellTime = txTime;
                    }
                    console.log(`🔴 [SELL] ${walletAddress.slice(0,4)}... sold ${soldAmount.toLocaleString()}`);
                }
            }
        }
    } catch (e) {
        console.log(`⚠️ Sell detection failed: ${e.message}`);
    }
    sellsCache.set(cacheKey, { 
        timestamp: now, 
        amount: totalSold,
        lastSellTime: lastSellTime 
    });
    return { totalSold, lastSellTime };
}

async function getWalletBuys(walletAddress, tokenMint, decimals, limit = 15) {
    const cacheKey = `${walletAddress}_${tokenMint}_buys`;
    const now = Date.now();
    if (sellsCache.has(cacheKey)) {
        const { timestamp, amount, lastBuyTime } = sellsCache.get(cacheKey);
        if (now - timestamp < CACHE_DURATION) {
            return { totalBought: amount, lastBuyTime };
        }
    }
    let totalBought = 0;
    let lastBuyTime = null;
    try {
        const sigResponse = await fetch(HELIUS_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: "2.0", id: 1,
                method: "getSignaturesForAddress",
                params: [walletAddress, { limit }]
            })
        });
        const sigData = await sigResponse.json();
        const sigs = sigData.result || [];
        for (const sigInfo of sigs) {
            const txResponse = await fetch(HELIUS_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0", id: 1,
                    method: "getTransaction",
                    params: [sigInfo.signature, { 
                        encoding: "jsonParsed", 
                        maxSupportedTransactionVersion: 0 
                    }]
                })
            });
            const txData = await txResponse.json();
            const tx = txData.result;
            if (!tx || !tx.meta) continue;
            const preBalances = tx.meta.preTokenBalances || [];
            const postBalances = tx.meta.postTokenBalances || [];
            const pre = preBalances.find(b => b.owner === walletAddress && b.mint === tokenMint);
            const post = postBalances.find(b => b.owner === walletAddress && b.mint === tokenMint);
            if (pre && post) {
                const preAmount = BigInt(pre.uiTokenAmount?.amount || "0");
                const postAmount = BigInt(post.uiTokenAmount?.amount || "0");
                if (postAmount > preAmount) {
                    const diff = postAmount - preAmount;
                    const boughtAmount = Number(diff) / Math.pow(10, decimals);
                    totalBought += boughtAmount;
                    const txTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();
                    if (!lastBuyTime || txTime > lastBuyTime) {
                        lastBuyTime = txTime;
                    }
                    console.log(`🟢 [BUY] ${walletAddress.slice(0,4)}... bought ${boughtAmount.toLocaleString()}`);
                }
            }
        }
    } catch (e) {
        console.log(`⚠️ Buy detection failed: ${e.message}`);
    }
    sellsCache.set(cacheKey, { 
        timestamp: now, 
        amount: totalBought,
        lastBuyTime: lastBuyTime 
    });
    return { totalBought, lastBuyTime };
}

async function getTotalHolders(tokenAddress) {
    try {
        const payload = {
            jsonrpc: "2.0",
            id: 1,
            method: "getTokenAccounts",
            params: { mint: tokenAddress, limit: 1000 }
        };
        const response = await fetch(HELIUS_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        const accounts = data.result?.token_accounts;
        if (accounts) {
            const count = accounts.length;
            return count === 1000 ? "1000+" : count.toString();
        }
    } catch (e) {
        log(`⚠️ Error counting holders: ${e.message}`);
    }
    try {
        const payload = {
            jsonrpc: "2.0",
            id: 1,
            method: "getTokenLargestAccounts",
            params: [tokenAddress]
        };
        const response = await fetch(HELIUS_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        const accounts = data.result?.value || [];
        return accounts.length.toString();
    } catch {
        return "0";
    }
}

async function analyzeToken(req, res) {
    console.log('\n🔍 ===== HOLDER ANALYSIS DEBUG =====');
    console.log(`📍 Time: ${new Date().toLocaleTimeString()}`);
    if (!req.body || !req.body.token_address) {
        console.log('❌ ERROR: No token address provided');
        return res.status(400).json({ 
            success: false, 
            error: 'Token address is required' 
        });
    }
    const tokenAddress = req.body.token_address;
    const devWallet = req.body.dev_wallet || "Not found";
    console.log(`📍 Token: ${tokenAddress}`);
    console.log(`👤 Dev Wallet: ${devWallet}`);
    console.log('-----------------------------------\n');
    try {
        const { name: tokenName, symbol: tokenSymbol } = await getTokenMetadata(tokenAddress);
        console.log(`📝 Token: ${tokenName} (${tokenSymbol})`);
        let totalSupply = 0;
        let decimals = 9;
        try {
            const payload = {
                jsonrpc: "2.0",
                id: 1,
                method: "getTokenSupply",
                params: [tokenAddress]
            };
            const response = await fetch(HELIUS_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            const value = data.result?.value || {};
            totalSupply = value.uiAmount || 0;
            decimals = value.decimals || 9;
            console.log(`💰 Total supply: ${totalSupply.toLocaleString()}`);
        } catch (e) {
            console.log(`⚠️ Supply error: ${e.message}`);
        }
        let topHolders = [];
        try {
            const payload = {
                jsonrpc: "2.0",
                id: 1,
                method: "getTokenLargestAccounts",
                params: [tokenAddress]
            };
            const response = await fetch(HELIUS_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            const accounts = data.result?.value || [];
            console.log(`\n📊 RAW TOP ACCOUNTS:`);
            accounts.slice(0, 10).forEach((acc, i) => {
                console.log(`  #${i+1}: ${acc.address.slice(0,8)}... | ${(acc.uiAmount/1e6).toFixed(2)}M`);
            });
            const holderPromises = accounts.slice(0, 20).map(async (acc, index) => {
                const tokenAcc = acc.address;
                const balance = acc.uiAmount || 0;
                const owner = await getAccountOwner(tokenAcc);
                return {
                    rank: index + 1,
                    owner,
                    balance,
                    percentage: totalSupply > 0 ? (balance / totalSupply * 100) : 0
                };
            });
            topHolders = await Promise.all(holderPromises);
            console.log(`\n👥 PROCESSED TOP 10 HOLDERS:`);
            topHolders.slice(0, 10).forEach((h, i) => {
                console.log(`  #${i+1}: ${h.owner.slice(0,8)}... | ${(h.balance/1e6).toFixed(2)}M | ${h.percentage.toFixed(2)}%`);
            });
        } catch (e) {
            console.log(`⚠️ Error fetching top holders: ${e.message}`);
        }
        const totalHolders = await getTotalHolders(tokenAddress);
        console.log(`\n📊 Total holders: ${totalHolders}`);
        const top10Pct = topHolders.slice(0, 10).reduce((sum, h) => sum + h.percentage, 0);
        console.log(`📊 Top 10 concentration: ${top10Pct.toFixed(2)}%`);
        const isSupplyWallet = topHolders[0]?.owner === tokenAddress;
        console.log(`\n🔍 SPECIAL CHECKS:`);
        console.log(`  #1 holder is supply account: ${isSupplyWallet ? '✅ YES' : '❌ NO'}`);
        if (isSupplyWallet) {
            console.log(`  📦 Supply account holds ${topHolders[0].percentage.toFixed(2)}% of supply`);
        }
        console.log(`\n💰 SELL DETECTION (with timestamps):`);
        let sellingCount = 0;
        const sellPromises = topHolders.slice(0, 10)
            .filter(h => h.owner !== "Unknown")
            .map(async (h) => {
                const { totalSold, lastSellTime } = await getWalletSells(h.owner, tokenAddress, decimals, 15);
                return { rank: h.rank, sold: totalSold, lastSellTime };
            });
        const sellResults = await Promise.all(sellPromises);
        const soldMap = new Map(sellResults.map(r => [r.rank, { sold: r.sold, lastSellTime: r.lastSellTime }]));
        console.log(`\n🟢 BUY DETECTION (with timestamps):`);
        const buyPromises = topHolders.slice(0, 10)
            .filter(h => h.owner !== "Unknown")
            .map(async (h) => {
                const { totalBought, lastBuyTime } = await getWalletBuys(h.owner, tokenAddress, decimals, 15);
                return { rank: h.rank, bought: totalBought, lastBuyTime };
            });
        const buyResults = await Promise.all(buyPromises);
        const boughtMap = new Map(buyResults.map(r => [r.rank, { bought: r.bought, lastBuyTime: r.lastBuyTime }]));
        topHolders = topHolders.map(h => {
            const sellData = soldMap.get(h.rank) || { sold: 0, lastSellTime: null };
            const buyData = boughtMap.get(h.rank) || { bought: 0, lastBuyTime: null };
            const sold = sellData.sold;
            const lastSellTime = sellData.lastSellTime;
            const bought = buyData.bought;
            const lastBuyTime = buyData.lastBuyTime;
            const soldPct = totalSupply > 0 ? (sold / totalSupply * 100) : 0;
            const boughtPct = totalSupply > 0 ? (bought / totalSupply * 100) : 0;
            const isSelling = sold > 0.001;
            const isBuying = bought > 0.001;
            let statusText = "";
            const formatAmount = (amount) => {
                if (amount >= 1000000) {
                    return (amount / 1000000).toFixed(2) + "M";
                } else if (amount >= 1000) {
                    return (amount / 1000).toFixed(2) + "K";
                } else {
                    return amount.toFixed(2);
                }
            };
            if (isSelling && lastSellTime) {
                const minutesAgo = Math.floor((Date.now() - lastSellTime) / 60000);
                let timePart = "";
                if (minutesAgo < 1) {
                    timePart = "just now";
                } else if (minutesAgo < 60) {
                    timePart = `${minutesAgo} min ago`;
                } else {
                    const hoursAgo = Math.floor(minutesAgo / 60);
                    timePart = `${hoursAgo} hour${hoursAgo > 1 ? 's' : ''} ago`;
                }
                statusText = `<span class="status-badge badge-selling" style="margin-right: 4px;">SOLD ${formatAmount(sold)}</span> <span style="color: #888888;">${timePart}</span>`;
            }
            else if (isBuying && lastBuyTime) {
                const minutesAgo = Math.floor((Date.now() - lastBuyTime) / 60000);
                let timePart = "";
                if (minutesAgo < 1) {
                    timePart = "just now";
                } else if (minutesAgo < 60) {
                    timePart = `${minutesAgo} min ago`;
                } else {
                    const hoursAgo = Math.floor(minutesAgo / 60);
                    timePart = `${hoursAgo} hour${hoursAgo > 1 ? 's' : ''} ago`;
                }
                statusText = `<span class="status-badge badge-buy" style="margin-right: 4px;">BOUGHT ${formatAmount(bought)}</span> <span style="color: #888888;">${timePart}</span>`;
            }
            if (isSelling) {
                console.log(`  🔴 #${h.rank} sold ${(sold/1e6).toFixed(2)}M (${soldPct.toFixed(2)}%)`);
                sellingCount++;
            }
            if (isBuying) {
                console.log(`  🟢 #${h.rank} bought ${(bought/1e6).toFixed(2)}M (${boughtPct.toFixed(2)}%)`);
            }
            return {
                ...h,
                sold,
                soldPct,
                bought,
                boughtPct,
                isSelling,
                isBuying,
                lastSellTime,
                lastBuyTime,
                statusText
            };
        });
        if (sellingCount > 0) {
            console.log(`  🔴 Found ${sellingCount} holders selling`);
        } else {
            console.log(`  ⚫ No selling activity detected`);
        }
        const formattedHolders = topHolders.slice(0, 10).map(h => ({
            rank: h.rank,
            address: h.owner.length > 16 ? `${h.owner.slice(0,8)}...${h.owner.slice(-8)}` : h.owner,
            full_address: h.owner,
            balance: h.balance.toLocaleString(),
            percentage: parseFloat(h.percentage.toFixed(2)),
            is_selling: h.isSelling,
            is_buying: h.isBuying,
            status_text: h.statusText || "",
            sold_amount: h.sold.toLocaleString(),
            sold_percentage: parseFloat(h.soldPct.toFixed(2)),
            bought_amount: h.bought.toLocaleString(),
            bought_percentage: parseFloat(h.boughtPct.toFixed(2)),
            lastBuyTime: h.lastBuyTime || null,
            lastSellTime: h.lastSellTime || null,
            is_dev: doWalletsMatch(h.owner, devWallet),
            is_supply: h.owner === tokenAddress,
            solscan_link: `https://solscan.io/account/${h.owner}`
        }));
        console.log('\n✅ Analysis complete');
        console.log('=====================================\n');
        const result = {
            success: true,
            token_name: tokenName,
            token_symbol: tokenSymbol,
            total_supply: totalSupply.toLocaleString(),
            total_holders: totalHolders,
            top_10_concentration: `${top10Pct.toFixed(1)}%`,
            top_holders: formattedHolders,
            analysis_time: new Date().toLocaleString()
        };
        res.json(result);
    } catch (error) {
        console.log(`❌ Fatal error: ${error.message}`);
        console.log('=====================================\n');
        res.status(500).json({ success: false, error: error.message });
    }
}

module.exports = { analyzeToken };