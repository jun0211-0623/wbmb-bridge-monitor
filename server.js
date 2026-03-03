const { ethers } = require("ethers");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");

// 설정 검증
if (!config.BRIDGE_ADDRESS || !config.WBMB_ADDRESS) {
  console.error("Error: Contract addresses not set in monitor/config.js");
  process.exit(1);
}

// XSS 방지: HTML 이스케이프
function esc(str) {
  if (typeof str !== "string") return String(str);
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const MAX_EVENTS = 1000;

const BRIDGE_ABI = [
  "event BurnExecuted(uint256 indexed burnId, address indexed burner, uint256 amount, string mobickAddress, uint256 timestamp)",
  "event BurnProcessed(uint256 indexed burnId)",
  "function getBurnRecord(uint256 burnId) view returns (tuple(address burner, uint256 amount, string mobickAddress, uint256 timestamp, bool processed))",
  "function getBurnCount() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
];

const DEX_ABI = [
  "event Swap(address indexed user, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
  "event LiquidityAdded(address indexed provider, uint256 amountA, uint256 amountB, uint256 lpTokens)",
  "event LiquidityRemoved(address indexed provider, uint256 amountA, uint256 amountB, uint256 lpTokens)",
  "function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) returns (uint256)",
  "function addLiquidity(uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin) returns (uint256)",
  "function removeLiquidity(uint256 lpAmount, uint256 amountAMin, uint256 amountBMin) returns (uint256, uint256)",
  "function getAmountOut(address tokenIn, uint256 amountIn) view returns (uint256)",
  "function getReserves() view returns (uint256, uint256)",
  "function getPrice() view returns (uint256, uint256)",
  "function quoteAddLiquidity(uint256 amountA) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function tokenA() view returns (address)",
  "function tokenB() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function faucet(uint256)",
];

const app = express();

// 보안 헤더
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", "https://sepolia.base.org", "wss://sepolia.base.org"],
      },
    },
  })
);

// API rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests" },
});
app.use("/api/", apiLimiter);

const burnEvents = [];
const dexEvents = [];
const seenBurnIds = new Set();
const seenDexKeys = new Set();

// ===== 공통 스타일 & 지갑 연결 코드 =====

const NAV_LINKS = `<a href="/">Dashboard</a> | <a href="/burn">Burn Bridge</a> | <a href="/swap">Swap</a> | <a href="/liquidity">Liquidity</a>`;

const COMMON_STYLE = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; max-width: 700px; margin: 0 auto; }
h1 { color: #e94560; margin-bottom: 5px; }
.subtitle { color: #aaa; font-size: 0.9em; margin-bottom: 20px; }
.card { background: #16213e; border-radius: 8px; padding: 20px; margin: 15px 0; }
label { display: block; color: #aaa; margin-bottom: 5px; font-size: 0.9em; }
input, select { width: 100%; padding: 12px; background: #0f3460; border: 1px solid #333; border-radius: 6px; color: #eee; font-family: monospace; font-size: 1em; margin-bottom: 10px; }
input:focus, select:focus { outline: none; border-color: #e94560; }
button { width: 100%; padding: 14px; border: none; border-radius: 6px; font-family: monospace; font-size: 1.1em; cursor: pointer; transition: opacity 0.2s; }
button:hover { opacity: 0.9; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-connect { background: #0f3460; color: #eee; }
.btn-action { background: #e94560; color: #fff; }
.btn-faucet { background: #533483; color: #eee; margin-bottom: 8px; }
.btn-secondary { background: #0f3460; color: #eee; }
.wallet { display: flex; justify-content: space-between; align-items: center; }
.wallet-addr { color: #e94560; font-size: 0.9em; }
.balance { color: #4ecca3; font-size: 1.1em; }
#status { margin-top: 15px; padding: 12px; border-radius: 6px; display: none; font-size: 0.9em; word-break: break-all; }
.status-ok { background: #1b4332; border: 1px solid #4ecca3; display: block !important; }
.status-err { background: #461220; border: 1px solid #e94560; display: block !important; }
.status-wait { background: #1a1a2e; border: 1px solid #aaa; display: block !important; }
a { color: #e94560; }
.nav { margin-bottom: 20px; font-size: 0.95em; }
.nav a { margin: 0 2px; }
.row { display: flex; gap: 10px; }
.row > * { flex: 1; }
.pct-btns { display: flex; gap: 6px; margin-bottom: 10px; }
.pct-btns button { flex: 1; padding: 8px; font-size: 0.85em; background: #0f3460; color: #aaa; }
.pct-btns button:hover { color: #eee; }
.swap-arrow { text-align: center; font-size: 1.5em; cursor: pointer; margin: 5px 0; color: #e94560; }
.swap-arrow:hover { color: #fff; }
.info-row { display: flex; justify-content: space-between; color: #aaa; font-size: 0.85em; padding: 4px 0; }
.info-row span:last-child { color: #eee; }
.tab-bar { display: flex; gap: 0; margin-bottom: 15px; }
.tab-bar button { border-radius: 6px 6px 0 0; background: #0f3460; color: #aaa; padding: 10px; }
.tab-bar button.active { background: #16213e; color: #e94560; }
`;

// 공통 EIP-6963 지갑 탐지 + 연결 코드
function walletJS(extraSetup) {
  return `
const CHAIN_HEX = "0x14a34";
const WBMB = "${config.WBMB_ADDRESS}";
const FYUSD = "${config.FYUSD_ADDRESS || ""}";
const DEX = "${config.DEX_ADDRESS || ""}";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function faucet(uint256)"
];

const DEX_ABI = [
  "function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) returns (uint256)",
  "function addLiquidity(uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin) returns (uint256)",
  "function removeLiquidity(uint256 lpAmount, uint256 amountAMin, uint256 amountBMin) returns (uint256, uint256)",
  "function getAmountOut(address tokenIn, uint256 amountIn) view returns (uint256)",
  "function getReserves() view returns (uint256, uint256)",
  "function getPrice() view returns (uint256, uint256)",
  "function quoteAddLiquidity(uint256 amountA) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)"
];

let provider, signer, userAddress;
let wbmbContract, fyusdContract, dexContract;
var mmProvider = null;

function setStatus(msg, type) {
  var el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status-" + type;
}

function findMetaMask() {
  return new Promise(function(resolve) {
    var found = false;
    window.addEventListener("eip6963:announceProvider", function(event) {
      var info = event.detail.info;
      if (info.rdns === "io.metamask" || info.rdns === "io.metamask.flask") {
        found = true;
        resolve(event.detail.provider);
      }
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(function() {
      if (!found) {
        if (window.ethereum && window.ethereum.providers) {
          for (var i = 0; i < window.ethereum.providers.length; i++) {
            var p = window.ethereum.providers[i];
            if (p.isMetaMask && !p.isTrust && !p.isTrustWallet) { resolve(p); return; }
          }
        }
        if (window.ethereum && window.ethereum.isMetaMask && !window.ethereum.isTrust) { resolve(window.ethereum); return; }
        resolve(null);
      }
    }, 1000);
  });
}

async function connectWallet() {
  try {
    if (!mmProvider) {
      setStatus("Finding MetaMask...", "wait");
      mmProvider = await findMetaMask();
    }
    if (!mmProvider) { setStatus("MetaMask not found.", "err"); return; }

    setStatus("Connecting...", "wait");
    var accounts = await mmProvider.request({ method: "eth_accounts" });
    if (!accounts || accounts.length === 0) {
      try {
        await mmProvider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
        accounts = await mmProvider.request({ method: "eth_accounts" });
      } catch (permErr) {
        setStatus(permErr.code === 4001 ? "Connection rejected." : "Error: " + permErr.message, "err");
        return;
      }
    }
    if (!accounts || accounts.length === 0) { setStatus("No account found.", "err"); return; }

    var chainId = await mmProvider.request({ method: "eth_chainId" });
    if (chainId !== CHAIN_HEX) {
      try {
        await mmProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
      } catch (e) {
        if (e.code === 4902) {
          await mmProvider.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_HEX, chainName: "Base Sepolia", rpcUrls: ["https://sepolia.base.org"], nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://sepolia.basescan.org"] }] });
        } else { setStatus("Switch to Base Sepolia.", "err"); return; }
      }
      accounts = await mmProvider.request({ method: "eth_accounts" });
    }

    var cached = accounts.slice();
    provider = new ethers.BrowserProvider(mmProvider);
    var origSend = provider.send.bind(provider);
    provider.send = async function(method, params) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return cached;
      return origSend(method, params);
    };
    signer = await provider.getSigner();
    userAddress = cached[0];

    wbmbContract = new ethers.Contract(WBMB, ERC20_ABI, signer);
    if (FYUSD) fyusdContract = new ethers.Contract(FYUSD, ERC20_ABI, signer);
    if (DEX) dexContract = new ethers.Contract(DEX, DEX_ABI, signer);

    document.getElementById("walletAddr").textContent = userAddress.slice(0,6) + "..." + userAddress.slice(-4);
    document.getElementById("btnConnect").textContent = "Connected";
    document.getElementById("btnConnect").disabled = true;

    ${extraSetup || ""}

    setStatus("Connected: " + userAddress.slice(0,6) + "..." + userAddress.slice(-4), "ok");
  } catch (err) {
    setStatus("[" + (err.code || "?") + "] " + (err.shortMessage || err.message || String(err)), "err");
  }
}

window.addEventListener("load", async function() {
  mmProvider = await findMetaMask();
  if (!mmProvider) return;
  mmProvider.on("chainChanged", function() { location.reload(); });
  mmProvider.on("accountsChanged", function(accs) {
    if (accs.length === 0) location.reload(); else connectWallet();
  });
  mmProvider.request({ method: "eth_accounts" }).then(function(accs) {
    if (accs && accs.length > 0) connectWallet();
  }).catch(function() {});
});
`;
}

// ===== 모니터링 =====

async function startMonitor() {
  console.log("Starting monitor...");
  console.log("RPC:    ", config.RPC_URL);
  console.log("Bridge: ", config.BRIDGE_ADDRESS);
  console.log("WBMB:   ", config.WBMB_ADDRESS);
  if (config.DEX_ADDRESS) console.log("DEX:    ", config.DEX_ADDRESS);
  if (config.FYUSD_ADDRESS) console.log("FYUSD:  ", config.FYUSD_ADDRESS);

  const provider = new ethers.JsonRpcProvider(config.RPC_URL, undefined, {
    pollingInterval: 5000,
  });

  try {
    const network = await provider.getNetwork();
    console.log("Connected to chain:", network.chainId.toString());
  } catch (err) {
    console.error("Failed to connect:", err.message);
    process.exit(1);
  }

  const bridge = new ethers.Contract(config.BRIDGE_ADDRESS, BRIDGE_ABI, provider);

  function processBurnEvent(e) {
    const burnId = e.args[0].toString();
    if (seenBurnIds.has(burnId)) return;
    seenBurnIds.add(burnId);
    const event = {
      burnId,
      burner: e.args[1],
      amount: ethers.formatEther(e.args[2]),
      mobickAddress: e.args[3],
      timestamp: new Date(Number(e.args[4]) * 1000).toISOString(),
    };
    if (burnEvents.length >= MAX_EVENTS) burnEvents.shift();
    burnEvents.push(event);
    console.log(`BURN #${event.burnId}: ${event.amount} WBMB from ${event.burner.slice(0,8)}...`);
  }

  // DEX 모니터링
  let dex = null;
  if (config.DEX_ADDRESS) {
    dex = new ethers.Contract(config.DEX_ADDRESS, DEX_ABI, provider);
  }

  function processDexEvent(e, type) {
    const txHash = e.transactionHash;
    const key = `${txHash}:${type}`;
    if (seenDexKeys.has(key)) return;
    seenDexKeys.add(key);

    let event = { type, txHash, timestamp: new Date().toISOString() };

    if (type === "Swap") {
      event.user = e.args[0];
      event.tokenIn = e.args[1];
      event.tokenOut = e.args[2];
      event.amountIn = ethers.formatEther(e.args[3]);
      event.amountOut = ethers.formatEther(e.args[4]);
      event.direction = e.args[1].toLowerCase() === config.WBMB_ADDRESS.toLowerCase()
        ? "mWBMB -> mFYUSD" : "mFYUSD -> mWBMB";
      console.log(`SWAP: ${event.amountIn} ${event.direction} -> ${event.amountOut}`);
    } else if (type === "LiquidityAdded") {
      event.user = e.args[0];
      event.amountA = ethers.formatEther(e.args[1]);
      event.amountB = ethers.formatEther(e.args[2]);
      event.lpTokens = ethers.formatEther(e.args[3]);
      console.log(`LP+: ${event.amountA} mWBMB + ${event.amountB} mFYUSD`);
    } else if (type === "LiquidityRemoved") {
      event.user = e.args[0];
      event.amountA = ethers.formatEther(e.args[1]);
      event.amountB = ethers.formatEther(e.args[2]);
      event.lpTokens = ethers.formatEther(e.args[3]);
      console.log(`LP-: ${event.amountA} mWBMB + ${event.amountB} mFYUSD`);
    }

    if (dexEvents.length >= MAX_EVENTS) dexEvents.shift();
    dexEvents.push(event);
  }

  // 과거 이벤트 로드
  let lastBlock = 0;
  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 5000);
    console.log(`Loading past events from block ${fromBlock}...`);

    const queries = [bridge.queryFilter("BurnExecuted", fromBlock)];
    if (dex) {
      queries.push(dex.queryFilter("Swap", fromBlock));
      queries.push(dex.queryFilter("LiquidityAdded", fromBlock));
      queries.push(dex.queryFilter("LiquidityRemoved", fromBlock));
    }
    const [pastBurns, pastSwaps, pastAdds, pastRemoves] = await Promise.all(queries);

    for (const e of pastBurns) processBurnEvent(e);
    if (pastBurns.length > 0) console.log(`Loaded ${pastBurns.length} burn event(s)`);

    if (dex) {
      for (const e of pastSwaps) processDexEvent(e, "Swap");
      for (const e of pastAdds) processDexEvent(e, "LiquidityAdded");
      for (const e of pastRemoves) processDexEvent(e, "LiquidityRemoved");
      console.log(`Loaded ${pastSwaps.length} swap, ${pastAdds.length} add, ${pastRemoves.length} remove event(s)`);
    }

    lastBlock = currentBlock;
  } catch (err) {
    console.log("Could not load past events:", err.message);
    lastBlock = await provider.getBlockNumber();
  }

  console.log("Polling for new events every 5s...\n");
  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastBlock) return;

      const pollQueries = [bridge.queryFilter("BurnExecuted", lastBlock + 1, currentBlock)];
      if (dex) {
        pollQueries.push(dex.queryFilter("Swap", lastBlock + 1, currentBlock));
        pollQueries.push(dex.queryFilter("LiquidityAdded", lastBlock + 1, currentBlock));
        pollQueries.push(dex.queryFilter("LiquidityRemoved", lastBlock + 1, currentBlock));
      }
      const [burns, swaps, adds, removes] = await Promise.all(pollQueries);

      for (const e of burns) processBurnEvent(e);
      if (dex) {
        for (const e of swaps) processDexEvent(e, "Swap");
        for (const e of adds) processDexEvent(e, "LiquidityAdded");
        for (const e of removes) processDexEvent(e, "LiquidityRemoved");
      }

      lastBlock = currentBlock;
    } catch (err) {
      console.error("Polling error:", err.message);
    }
  }, 5000);
}

// ===== 대시보드 =====

app.get("/", (req, res) => {
  const totalBurned = burnEvents.reduce((s, e) => s + parseFloat(e.amount), 0).toFixed(2);
  const swapCount = dexEvents.filter((e) => e.type === "Swap").length;
  const lpAddCount = dexEvents.filter((e) => e.type === "LiquidityAdded").length;
  const lpRemoveCount = dexEvents.filter((e) => e.type === "LiquidityRemoved").length;

  const burnRows = burnEvents.map((e) => `
    <tr>
      <td>${esc(e.burnId)}</td>
      <td title="${esc(e.burner)}">${esc(e.burner.slice(0,8))}...${esc(e.burner.slice(-6))}</td>
      <td>${esc(e.amount)} WBMB</td>
      <td title="${esc(e.mobickAddress)}">${esc(e.mobickAddress.length > 20 ? e.mobickAddress.slice(0,20) + "..." : e.mobickAddress)}</td>
      <td>${esc(e.timestamp)}</td>
    </tr>`).reverse().join("");

  const dexRows = dexEvents.map((e) => {
    if (e.type === "Swap") {
      return `<tr><td style="color:#4ecca3">SWAP</td><td title="${esc(e.user)}">${esc(e.user.slice(0,8))}...</td><td>${esc(e.direction)}</td><td>${esc(e.amountIn)} -&gt; ${esc(e.amountOut)}</td><td>${esc(e.timestamp)}</td></tr>`;
    } else if (e.type === "LiquidityAdded") {
      return `<tr><td style="color:#533483">LP+</td><td title="${esc(e.user)}">${esc(e.user.slice(0,8))}...</td><td>Add Liquidity</td><td>${esc(e.amountA)} mWBMB + ${esc(e.amountB)} mFYUSD</td><td>${esc(e.timestamp)}</td></tr>`;
    } else {
      return `<tr><td style="color:#e94560">LP-</td><td title="${esc(e.user)}">${esc(e.user.slice(0,8))}...</td><td>Remove Liquidity</td><td>${esc(e.amountA)} mWBMB + ${esc(e.amountB)} mFYUSD</td><td>${esc(e.timestamp)}</td></tr>`;
    }
  }).reverse().join("");

  res.send(`<!DOCTYPE html>
<html><head>
  <title>WBMB Monitor</title>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5">
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; max-width: 1100px; margin: 0 auto; }
    h1 { color: #e94560; }
    h2 { color: #ccc; margin-top: 30px; }
    .nav { margin-bottom: 20px; font-size: 0.95em; }
    .nav a { color: #e94560; margin: 0 2px; }
    .stats { display: flex; gap: 15px; margin: 20px 0; flex-wrap: wrap; }
    .stat { background: #0f3460; padding: 18px; border-radius: 8px; text-align: center; flex: 1; min-width: 120px; }
    .stat h2 { color: #e94560; font-size: 1.8em; margin: 0; }
    .stat p { color: #aaa; margin: 5px 0 0; font-size: 0.85em; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th { background: #0f3460; padding: 10px; text-align: left; font-size: 0.9em; }
    td { padding: 8px 10px; border-bottom: 1px solid #333; font-size: 0.85em; }
    .empty { background: #16213e; border-radius: 8px; padding: 15px; margin: 10px 0; border-left: 4px solid #e94560; color: #aaa; }
    .info { color: #aaa; font-size: 0.9em; }
  </style>
</head><body>
  <div class="nav"><b>Dashboard</b> | ${NAV_LINKS.replace('<a href="/">Dashboard</a> | ', '')}</div>
  <h1>WBMB Bridge & DEX Monitor</h1>
  <p class="info">Base Sepolia Testnet | Auto-refresh 5s</p>

  <div class="stats">
    <div class="stat"><h2>${burnEvents.length}</h2><p>Burns</p></div>
    <div class="stat"><h2>${totalBurned}</h2><p>WBMB Burned</p></div>
    <div class="stat"><h2>${swapCount}</h2><p>Swaps</p></div>
    <div class="stat"><h2>${lpAddCount}</h2><p>LP Adds</p></div>
    <div class="stat"><h2>${lpRemoveCount}</h2><p>LP Removes</p></div>
  </div>

  <h2>Bridge Burns</h2>
  ${burnEvents.length === 0 ? '<div class="empty">No burns yet</div>' : `<table><tr><th>#</th><th>From</th><th>Amount</th><th>BMB Addr</th><th>Time</th></tr>${burnRows}</table>`}

  <h2>DEX Activity</h2>
  ${dexEvents.length === 0 ? '<div class="empty">No DEX activity yet</div>' : `<table><tr><th>Type</th><th>User</th><th>Action</th><th>Details</th><th>Time</th></tr>${dexRows}</table>`}
</body></html>`);
});

// ===== Burn DApp =====

app.get("/burn", (req, res) => {
  const extraSetup = `
    document.querySelectorAll(".needs-wallet").forEach(function(b) { b.disabled = false; });
    updateBurnBalance();
  `;

  res.send(`<!DOCTYPE html>
<html><head>
  <title>WBMB Burn Bridge</title>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.umd.min.js" integrity="sha384-NRAZj94DQk3dgtsOZzVYHbYVV1DFkF5QhL5RRxF0ILZLi6OQ7CsMlun748D42JbO" crossorigin="anonymous"><\/script>
  <style>${COMMON_STYLE}</style>
</head><body>
  <div class="nav">${NAV_LINKS}</div>
  <h1>WBMB Burn Bridge</h1>
  <p class="subtitle">Base Sepolia Testnet</p>

  <div class="card">
    <div class="wallet">
      <label style="margin:0">Wallet</label>
      <span id="walletAddr" class="wallet-addr">Not connected</span>
    </div>
    <p style="margin:8px 0"><span class="balance" id="tokenBalance">0</span> mWBMB</p>
    <button class="btn-connect" id="btnConnect" onclick="connectWallet()">Connect MetaMask</button>
  </div>

  <div class="card">
    <button class="btn-faucet needs-wallet" onclick="getFaucet()" disabled>Get 100 mWBMB (Faucet)</button>
  </div>

  <div class="card">
    <label>Burn Amount (mWBMB)</label>
    <input type="number" id="burnAmount" placeholder="50" step="any">
    <label>BMB Destination Address</label>
    <input type="text" id="mobickAddr" placeholder="mobick:1A1zP1eP...">
    <button class="btn-action needs-wallet" id="btnBurn" onclick="executeBurn()" disabled>Burn WBMB</button>
  </div>

  <div id="status"></div>

<script>
const BRIDGE = "${config.BRIDGE_ADDRESS}";
const BRIDGE_ABI = ["function burnForBMB(uint256, string)"];
let bridgeContract;

${walletJS(extraSetup)}

async function updateBurnBalance() {
  try {
    var bal = await wbmbContract.balanceOf(userAddress);
    document.getElementById("tokenBalance").textContent = ethers.formatEther(bal);
  } catch(e) {}
}

async function getFaucet() {
  try {
    setStatus("Requesting 100 mWBMB... (confirm in MetaMask)", "wait");
    var tx = await wbmbContract.faucet(ethers.parseEther("100"));
    setStatus("Waiting for confirmation...", "wait");
    await tx.wait();
    await updateBurnBalance();
    setStatus("Got 100 mWBMB!", "ok");
  } catch(err) { setStatus("Faucet: " + (err.shortMessage || err.message), "err"); }
}

async function executeBurn() {
  try {
    var amount = document.getElementById("burnAmount").value;
    var mobickAddr = document.getElementById("mobickAddr").value;
    if (!amount || parseFloat(amount) <= 0) { setStatus("Enter a valid amount", "err"); return; }
    if (!mobickAddr) { setStatus("Enter a BMB address", "err"); return; }

    if (!bridgeContract) bridgeContract = new ethers.Contract(BRIDGE, BRIDGE_ABI, signer);
    var parsedAmount = ethers.parseEther(amount);
    document.getElementById("btnBurn").disabled = true;

    var allowance = await wbmbContract.allowance(userAddress, BRIDGE);
    if (allowance < parsedAmount) {
      setStatus("Step 1/2: Approving...", "wait");
      var atx = await wbmbContract.approve(BRIDGE, parsedAmount);
      await atx.wait();
    }

    setStatus("Step 2/2: Burning...", "wait");
    var tx = await bridgeContract.burnForBMB(parsedAmount, mobickAddr);
    await tx.wait();
    await updateBurnBalance();
    setStatus("Burned " + amount + " mWBMB! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus("Burn: " + (err.shortMessage || err.message), "err"); }
  finally { document.getElementById("btnBurn").disabled = false; }
}
<\/script>
</body></html>`);
});

// ===== Swap DApp =====

app.get("/swap", (req, res) => {
  const extraSetup = `
    document.querySelectorAll(".needs-wallet").forEach(function(b) { b.disabled = false; });
    updateSwapBalances();
  `;

  res.send(`<!DOCTYPE html>
<html><head>
  <title>DEX Swap</title>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.umd.min.js" integrity="sha384-NRAZj94DQk3dgtsOZzVYHbYVV1DFkF5QhL5RRxF0ILZLi6OQ7CsMlun748D42JbO" crossorigin="anonymous"><\/script>
  <style>${COMMON_STYLE}
    .swap-box { position: relative; }
    .token-label { display: flex; justify-content: space-between; align-items: center; }
    .token-label .bal { color: #4ecca3; font-size: 0.85em; cursor: pointer; }
    .slippage-row { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
    .slippage-row button { flex: none; width: auto; padding: 6px 12px; font-size: 0.85em; background: #0f3460; color: #aaa; }
    .slippage-row button.active { color: #e94560; border: 1px solid #e94560; }
    .quote-info { background: #0f3460; border-radius: 6px; padding: 12px; margin: 10px 0; }
  </style>
</head><body>
  <div class="nav">${NAV_LINKS}</div>
  <h1>Token Swap</h1>
  <p class="subtitle">mWBMB / mFYUSD | 0.3% fee</p>

  <div class="card">
    <div class="wallet">
      <label style="margin:0">Wallet</label>
      <span id="walletAddr" class="wallet-addr">Not connected</span>
    </div>
    <button class="btn-connect" id="btnConnect" onclick="connectWallet()">Connect MetaMask</button>
  </div>

  <div class="card">
    <div class="row">
      <button class="btn-faucet needs-wallet" onclick="getFaucetWBMB()" disabled>+ 100 mWBMB</button>
      <button class="btn-faucet needs-wallet" onclick="getFaucetFYUSD()" disabled>+ 1000 mFYUSD</button>
    </div>
  </div>

  <div class="card" id="poolCard">
    <b>Pool Status</b>
    <div style="background:#0f3460;border-radius:6px;padding:12px;margin-top:10px">
      <div class="info-row"><span>Reserve mWBMB</span><span id="poolResA">-</span></div>
      <div class="info-row"><span>Reserve mFYUSD</span><span id="poolResB">-</span></div>
      <div class="info-row"><span>Price (1 mWBMB)</span><span id="poolPrice">-</span></div>
      <div class="info-row"><span>Total LP Supply</span><span id="poolLP">-</span></div>
    </div>
  </div>

  <div class="card swap-box">
    <div class="token-label">
      <label>From: <b id="fromToken">mWBMB</b></label>
      <span class="bal" id="fromBal" onclick="setMax()">Balance: 0</span>
    </div>
    <input type="number" id="fromAmount" placeholder="0.0" step="any" oninput="getQuote()">

    <div class="swap-arrow" onclick="flipDirection()">&#8597;</div>

    <div class="token-label">
      <label>To: <b id="toToken">mFYUSD</b></label>
      <span class="bal" id="toBal">Balance: 0</span>
    </div>
    <input type="number" id="toAmount" placeholder="0.0" readonly style="opacity:0.7">

    <div class="quote-info" id="quoteInfo" style="display:none">
      <div class="info-row"><span>Rate</span><span id="qRate">-</span></div>
      <div class="info-row"><span>Price Impact</span><span id="qImpact">-</span></div>
      <div class="info-row"><span>Min Received</span><span id="qMin">-</span></div>
    </div>

    <label style="margin-top:10px">Slippage Tolerance</label>
    <div class="slippage-row">
      <button onclick="setSlippage(0.5)" class="active" id="slip05">0.5%</button>
      <button onclick="setSlippage(1)" id="slip1">1%</button>
      <button onclick="setSlippage(3)" id="slip3">3%</button>
    </div>

    <button class="btn-action needs-wallet" id="btnSwap" onclick="executeSwap()" disabled>Swap</button>
  </div>

  <div id="status"></div>

<script>
${walletJS(extraSetup)}

var isAtoB = true;
var slippage = 0.5;
var quoteTimer = null;

function setSlippage(v) {
  slippage = v;
  document.querySelectorAll(".slippage-row button").forEach(function(b) { b.className = ""; });
  document.getElementById("slip" + String(v).replace(".", "")).className = "active";
  getQuote();
}

function flipDirection() {
  isAtoB = !isAtoB;
  document.getElementById("fromToken").textContent = isAtoB ? "mWBMB" : "mFYUSD";
  document.getElementById("toToken").textContent = isAtoB ? "mFYUSD" : "mWBMB";
  document.getElementById("fromAmount").value = "";
  document.getElementById("toAmount").value = "";
  document.getElementById("quoteInfo").style.display = "none";
  if (userAddress) updateSwapBalances();
}

function setMax() {
  var bal = document.getElementById("fromBal").textContent.replace("Balance: ", "");
  document.getElementById("fromAmount").value = bal;
  getQuote();
}

async function updateSwapBalances() {
  try {
    var [wbal, fbal] = await Promise.all([wbmbContract.balanceOf(userAddress), fyusdContract.balanceOf(userAddress)]);
    var wStr = parseFloat(ethers.formatEther(wbal)).toFixed(4);
    var fStr = parseFloat(ethers.formatEther(fbal)).toFixed(4);
    document.getElementById("fromBal").textContent = "Balance: " + (isAtoB ? wStr : fStr);
    document.getElementById("toBal").textContent = "Balance: " + (isAtoB ? fStr : wStr);
  } catch(e) {}
  updatePoolInfo();
}

async function updatePoolInfo() {
  try {
    var [res, supply] = await Promise.all([dexContract.getReserves(), dexContract.totalSupply()]);
    var rA = parseFloat(ethers.formatEther(res[0]));
    var rB = parseFloat(ethers.formatEther(res[1]));
    document.getElementById("poolResA").textContent = rA.toFixed(4) + " mWBMB";
    document.getElementById("poolResB").textContent = rB.toFixed(4) + " mFYUSD";
    if (rA > 0) {
      document.getElementById("poolPrice").textContent = (rB / rA).toFixed(4) + " mFYUSD";
    }
    document.getElementById("poolLP").textContent = parseFloat(ethers.formatEther(supply)).toFixed(4);
  } catch(e) {}
}

async function getQuote() {
  var val = document.getElementById("fromAmount").value;
  if (!val || parseFloat(val) <= 0 || !dexContract) {
    document.getElementById("toAmount").value = "";
    document.getElementById("quoteInfo").style.display = "none";
    return;
  }

  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async function() {
    try {
      var tokenIn = isAtoB ? WBMB : FYUSD;
      var amountIn = ethers.parseEther(val);
      var [amountOut, reserves] = await Promise.all([dexContract.getAmountOut(tokenIn, amountIn), dexContract.getReserves()]);
      var outStr = ethers.formatEther(amountOut);
      document.getElementById("toAmount").value = parseFloat(outStr).toFixed(6);

      var rate = parseFloat(outStr) / parseFloat(val);
      var rA = parseFloat(ethers.formatEther(reserves[0]));
      var rB = parseFloat(ethers.formatEther(reserves[1]));
      var spotRate = isAtoB ? (rB / rA) : (rA / rB);
      var impact = Math.abs((rate - spotRate) / spotRate * 100).toFixed(2);

      var minOut = parseFloat(outStr) * (1 - slippage / 100);

      document.getElementById("qRate").textContent = "1 " + (isAtoB ? "mWBMB" : "mFYUSD") + " = " + rate.toFixed(6) + " " + (isAtoB ? "mFYUSD" : "mWBMB");
      document.getElementById("qImpact").textContent = impact + "%";
      document.getElementById("qMin").textContent = minOut.toFixed(6) + " " + (isAtoB ? "mFYUSD" : "mWBMB");
      document.getElementById("quoteInfo").style.display = "block";
    } catch(e) {
      document.getElementById("toAmount").value = "Error";
    }
  }, 300);
}

async function getFaucetWBMB() {
  try {
    setStatus("Getting 100 mWBMB...", "wait");
    var tx = await wbmbContract.faucet(ethers.parseEther("100"));
    await tx.wait();
    await updateSwapBalances();
    setStatus("Got 100 mWBMB!", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

async function getFaucetFYUSD() {
  try {
    setStatus("Getting 1000 mFYUSD...", "wait");
    var tx = await fyusdContract.faucet(ethers.parseEther("1000"));
    await tx.wait();
    await updateSwapBalances();
    setStatus("Got 1000 mFYUSD!", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

async function executeSwap() {
  try {
    var val = document.getElementById("fromAmount").value;
    if (!val || parseFloat(val) <= 0) { setStatus("Enter amount", "err"); return; }

    document.getElementById("btnSwap").disabled = true;
    var tokenIn = isAtoB ? WBMB : FYUSD;
    var tokenContract = isAtoB ? wbmbContract : fyusdContract;
    var amountIn = ethers.parseEther(val);

    var amountOut = await dexContract.getAmountOut(tokenIn, amountIn);
    var minOut = amountOut * BigInt(Math.floor((100 - slippage) * 100)) / 10000n;

    var allowance = await tokenContract.allowance(userAddress, DEX);
    if (allowance < amountIn) {
      setStatus("Step 1/2: Approving...", "wait");
      var atx = await tokenContract.approve(DEX, amountIn);
      await atx.wait();
    }

    setStatus("Step 2/2: Swapping...", "wait");
    var tx = await dexContract.swap(tokenIn, amountIn, minOut);
    await tx.wait();
    await updateSwapBalances();
    document.getElementById("fromAmount").value = "";
    document.getElementById("toAmount").value = "";
    document.getElementById("quoteInfo").style.display = "none";
    setStatus("Swap complete! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus("Swap: " + (err.shortMessage || err.message), "err"); }
  finally { document.getElementById("btnSwap").disabled = false; }
}
<\/script>
</body></html>`);
});

// ===== Liquidity DApp =====

app.get("/liquidity", (req, res) => {
  const extraSetup = `
    document.querySelectorAll(".needs-wallet").forEach(function(b) { b.disabled = false; });
    updateLiqBalances();
  `;

  res.send(`<!DOCTYPE html>
<html><head>
  <title>DEX Liquidity</title>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.umd.min.js" integrity="sha384-NRAZj94DQk3dgtsOZzVYHbYVV1DFkF5QhL5RRxF0ILZLi6OQ7CsMlun748D42JbO" crossorigin="anonymous"><\/script>
  <style>${COMMON_STYLE}
    .tab-bar { display: flex; gap: 0; margin-bottom: 0; }
    .tab-bar button { border-radius: 6px 6px 0 0; background: #0f3460; color: #aaa; padding: 12px 20px; border: none; cursor: pointer; font-family: monospace; font-size: 1em; width: auto; }
    .tab-bar button.active { background: #16213e; color: #e94560; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .pool-info { background: #0f3460; border-radius: 6px; padding: 12px; margin: 10px 0; }
  </style>
</head><body>
  <div class="nav">${NAV_LINKS}</div>
  <h1>Liquidity Pool</h1>
  <p class="subtitle">mWBMB / mFYUSD</p>

  <div class="card">
    <div class="wallet">
      <label style="margin:0">Wallet</label>
      <span id="walletAddr" class="wallet-addr">Not connected</span>
    </div>
    <button class="btn-connect" id="btnConnect" onclick="connectWallet()">Connect MetaMask</button>
  </div>

  <div class="card">
    <div class="row">
      <button class="btn-faucet needs-wallet" onclick="getFaucetW()" disabled>+ 100 mWBMB</button>
      <button class="btn-faucet needs-wallet" onclick="getFaucetF()" disabled>+ 1000 mFYUSD</button>
    </div>
  </div>

  <div class="card" id="poolCard">
    <b>Pool Info</b>
    <div class="pool-info">
      <div class="info-row"><span>Reserve mWBMB</span><span id="resA">-</span></div>
      <div class="info-row"><span>Reserve mFYUSD</span><span id="resB">-</span></div>
      <div class="info-row"><span>Price (1 mWBMB)</span><span id="price">-</span></div>
      <div class="info-row"><span>Your LP Tokens</span><span id="lpBal">-</span></div>
      <div class="info-row"><span>Pool Share</span><span id="poolShare">-</span></div>
    </div>
    <div class="info-row"><span>Your mWBMB</span><span id="myWBMB">-</span></div>
    <div class="info-row"><span>Your mFYUSD</span><span id="myFYUSD">-</span></div>
  </div>

  <div class="tab-bar">
    <button class="active" id="tabAdd" onclick="switchTab('add')">Add Liquidity</button>
    <button id="tabRemove" onclick="switchTab('remove')">Remove Liquidity</button>
  </div>

  <div class="card" style="border-radius: 0 8px 8px 8px;">
    <div class="tab-content active" id="addPanel">
      <label>mWBMB Amount</label>
      <div class="pct-btns">
        <button onclick="setPctA(25)">25%</button>
        <button onclick="setPctA(50)">50%</button>
        <button onclick="setPctA(75)">75%</button>
        <button onclick="setPctA(100)">Max</button>
      </div>
      <input type="number" id="addAmountA" placeholder="0.0" step="any" oninput="quoteB()">
      <label>mFYUSD Amount (auto)</label>
      <input type="number" id="addAmountB" placeholder="0.0" readonly style="opacity:0.7">
      <button class="btn-action needs-wallet" id="btnAdd" onclick="addLiq()" disabled>Add Liquidity</button>
    </div>

    <div class="tab-content" id="removePanel">
      <label>LP Tokens to Remove</label>
      <div class="pct-btns">
        <button onclick="setPctLP(25)">25%</button>
        <button onclick="setPctLP(50)">50%</button>
        <button onclick="setPctLP(75)">75%</button>
        <button onclick="setPctLP(100)">Max</button>
      </div>
      <input type="number" id="removeLP" placeholder="0.0" step="any" oninput="quoteRemove()">
      <div class="pool-info" id="removeQuote" style="display:none">
        <div class="info-row"><span>You receive mWBMB</span><span id="removeA">-</span></div>
        <div class="info-row"><span>You receive mFYUSD</span><span id="removeB">-</span></div>
      </div>
      <button class="btn-action needs-wallet" id="btnRemove" onclick="removeLiq()" disabled>Remove Liquidity</button>
    </div>
  </div>

  <div id="status"></div>

<script>
${walletJS(extraSetup)}

var myWbmbBal = 0n;
var myFyusdBal = 0n;
var myLpBal = 0n;
var totalLpSupply = 0n;
var reserveA = 0n;
var reserveB = 0n;

function switchTab(tab) {
  document.getElementById("addPanel").className = "tab-content" + (tab === "add" ? " active" : "");
  document.getElementById("removePanel").className = "tab-content" + (tab === "remove" ? " active" : "");
  document.getElementById("tabAdd").className = tab === "add" ? "active" : "";
  document.getElementById("tabRemove").className = tab === "remove" ? "active" : "";
}

async function updateLiqBalances() {
  try {
    var [wb, fb, lb, ts, res, p] = await Promise.all([
      wbmbContract.balanceOf(userAddress),
      fyusdContract.balanceOf(userAddress),
      dexContract.balanceOf(userAddress),
      dexContract.totalSupply(),
      dexContract.getReserves(),
      dexContract.getPrice()
    ]);
    myWbmbBal = wb; myFyusdBal = fb; myLpBal = lb;
    totalLpSupply = ts; reserveA = res[0]; reserveB = res[1];

    document.getElementById("myWBMB").textContent = parseFloat(ethers.formatEther(myWbmbBal)).toFixed(4);
    document.getElementById("myFYUSD").textContent = parseFloat(ethers.formatEther(myFyusdBal)).toFixed(4);
    document.getElementById("lpBal").textContent = parseFloat(ethers.formatEther(myLpBal)).toFixed(4);
    document.getElementById("resA").textContent = parseFloat(ethers.formatEther(reserveA)).toFixed(4) + " mWBMB";
    document.getElementById("resB").textContent = parseFloat(ethers.formatEther(reserveB)).toFixed(4) + " mFYUSD";

    if (reserveA > 0n) {
      document.getElementById("price").textContent = parseFloat(ethers.formatEther(p[0])).toFixed(4) + " mFYUSD";
    }

    if (totalLpSupply > 0n && myLpBal > 0n) {
      var share = Number(myLpBal * 10000n / totalLpSupply) / 100;
      document.getElementById("poolShare").textContent = share.toFixed(2) + "%";
    } else {
      document.getElementById("poolShare").textContent = "0%";
    }
  } catch(e) { console.log("Balance update error:", e); }
}

function setPctA(pct) {
  if (myWbmbBal === 0n) return;
  var val = myWbmbBal * BigInt(pct) / 100n;
  document.getElementById("addAmountA").value = ethers.formatEther(val);
  quoteB();
}

function setPctLP(pct) {
  if (myLpBal === 0n) return;
  var val = myLpBal * BigInt(pct) / 100n;
  document.getElementById("removeLP").value = ethers.formatEther(val);
  quoteRemove();
}

async function quoteB() {
  var val = document.getElementById("addAmountA").value;
  if (!val || parseFloat(val) <= 0 || !dexContract) {
    document.getElementById("addAmountB").value = "";
    return;
  }
  try {
    if (reserveA === 0n) {
      document.getElementById("addAmountB").value = "";
      return;
    }
    var amtB = await dexContract.quoteAddLiquidity(ethers.parseEther(val));
    document.getElementById("addAmountB").value = parseFloat(ethers.formatEther(amtB)).toFixed(6);
  } catch(e) { document.getElementById("addAmountB").value = "Error"; }
}

function quoteRemove() {
  var val = document.getElementById("removeLP").value;
  if (!val || parseFloat(val) <= 0 || totalLpSupply === 0n) {
    document.getElementById("removeQuote").style.display = "none";
    return;
  }
  try {
    var lp = ethers.parseEther(val);
    var getA = lp * reserveA / totalLpSupply;
    var getB = lp * reserveB / totalLpSupply;
    document.getElementById("removeA").textContent = parseFloat(ethers.formatEther(getA)).toFixed(6);
    document.getElementById("removeB").textContent = parseFloat(ethers.formatEther(getB)).toFixed(6);
    document.getElementById("removeQuote").style.display = "block";
  } catch(e) { document.getElementById("removeQuote").style.display = "none"; }
}

async function getFaucetW() {
  try {
    setStatus("Getting 100 mWBMB...", "wait");
    var tx = await wbmbContract.faucet(ethers.parseEther("100"));
    await tx.wait();
    await updateLiqBalances();
    setStatus("Got 100 mWBMB!", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

async function getFaucetF() {
  try {
    setStatus("Getting 1000 mFYUSD...", "wait");
    var tx = await fyusdContract.faucet(ethers.parseEther("1000"));
    await tx.wait();
    await updateLiqBalances();
    setStatus("Got 1000 mFYUSD!", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

async function addLiq() {
  try {
    var valA = document.getElementById("addAmountA").value;
    var valB = document.getElementById("addAmountB").value;
    if (!valA || parseFloat(valA) <= 0) { setStatus("Enter mWBMB amount", "err"); return; }
    if (!valB || parseFloat(valB) <= 0) { setStatus("No mFYUSD quote", "err"); return; }

    document.getElementById("btnAdd").disabled = true;
    var amtA = ethers.parseEther(valA);
    var amtB = ethers.parseEther(valB);
    var minA = amtA * 95n / 100n;
    var minB = amtB * 95n / 100n;

    var allowA = await wbmbContract.allowance(userAddress, DEX);
    if (allowA < amtA) {
      setStatus("Step 1/3: Approving mWBMB...", "wait");
      var atx1 = await wbmbContract.approve(DEX, amtA);
      await atx1.wait();
    }

    var allowB = await fyusdContract.allowance(userAddress, DEX);
    if (allowB < amtB) {
      setStatus("Step 2/3: Approving mFYUSD...", "wait");
      var atx2 = await fyusdContract.approve(DEX, amtB);
      await atx2.wait();
    }

    setStatus("Step 3/3: Adding liquidity...", "wait");
    var tx = await dexContract.addLiquidity(amtA, amtB, minA, minB);
    await tx.wait();
    await updateLiqBalances();
    document.getElementById("addAmountA").value = "";
    document.getElementById("addAmountB").value = "";
    setStatus("Liquidity added! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus("Add: " + (err.shortMessage || err.message), "err"); }
  finally { document.getElementById("btnAdd").disabled = false; }
}

async function removeLiq() {
  try {
    var val = document.getElementById("removeLP").value;
    if (!val || parseFloat(val) <= 0) { setStatus("Enter LP amount", "err"); return; }

    document.getElementById("btnRemove").disabled = true;
    var lpAmt = ethers.parseEther(val);

    // 슬리피지 보호: 예상 수령량의 95%를 최소값으로 설정
    var [res, ts] = await Promise.all([dexContract.getReserves(), dexContract.totalSupply()]);
    var minA = lpAmt * res[0] / ts * 95n / 100n;
    var minB = lpAmt * res[1] / ts * 95n / 100n;

    setStatus("Removing liquidity...", "wait");
    var tx = await dexContract.removeLiquidity(lpAmt, minA, minB);
    await tx.wait();
    await updateLiqBalances();
    document.getElementById("removeLP").value = "";
    document.getElementById("removeQuote").style.display = "none";
    setStatus("Liquidity removed! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus("Remove: " + (err.shortMessage || err.message), "err"); }
  finally { document.getElementById("btnRemove").disabled = false; }
}
<\/script>
</body></html>`);
});

// ===== APIs =====

app.get("/api/config", (req, res) => {
  res.json({
    bridgeAddress: config.BRIDGE_ADDRESS,
    wbmbAddress: config.WBMB_ADDRESS,
    fyusdAddress: config.FYUSD_ADDRESS || null,
    dexAddress: config.DEX_ADDRESS || null,
    chainId: 84532,
  });
});

app.get("/api/burns", (req, res) => {
  res.json({ total: burnEvents.length, burns: burnEvents });
});

app.get("/api/dex", (req, res) => {
  res.json({
    total: dexEvents.length,
    swaps: dexEvents.filter((e) => e.type === "Swap").length,
    adds: dexEvents.filter((e) => e.type === "LiquidityAdded").length,
    removes: dexEvents.filter((e) => e.type === "LiquidityRemoved").length,
    events: dexEvents,
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", burns: burnEvents.length, dexEvents: dexEvents.length });
});

// ===== 서버 시작 =====

app.listen(config.PORT, () => {
  console.log(`Dashboard: http://localhost:${config.PORT}`);
});

startMonitor().catch((err) => {
  console.error("Monitor failed:", err);
  process.exit(1);
});
