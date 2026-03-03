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
  "function protocolFeeA() view returns (uint256)",
  "function protocolFeeB() view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function faucet(uint256)",
];

const ORACLE_ABI = [
  "function price() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
  "function isPriceValid() view returns (bool)",
  "event PriceUpdated(uint256 oldPrice, uint256 newPrice, uint256 timestamp)",
];

const VAULT_ABI = [
  "function openVault(uint256 wbmbAmount)",
  "function redeemMoven(uint256 movenAmount)",
  "function getVaultInfo(address) view returns (tuple(uint256 userCollateral, uint256 foundationCollateral, uint256 movenIssued, uint256 issuancePrice, uint256 issuanceTimestamp, bool isActive))",
  "function getCollateralRatio(address) view returns (uint256)",
  "function getSystemCollateralRatio() view returns (uint256)",
  "function totalUserCollateral() view returns (uint256)",
  "function totalFoundationCollateral() view returns (uint256)",
  "function totalMovenIssued() view returns (uint256)",
  "function insuranceBalance() view returns (uint256)",
  "function isIssuancePaused() view returns (bool)",
  "function getRedemptionAmount(uint256) view returns (uint256)",
  "function getInsuranceSurplus() view returns (uint256 surplus, uint256 target)",
  "event MovenIssued(address indexed user, uint256 wbmbDeposited, uint256 movenMinted, uint256 feeAmount, uint256 price)",
  "event MovenRedeemed(address indexed user, uint256 movenBurned, uint256 wbmbReturned, uint256 price)",
];

const STAKING_ABI = [
  "function stake(uint256 amount)",
  "function unstake(uint256 amount)",
  "function claimRewards()",
  "function totalStaked() view returns (uint256)",
  "function rewardPool() view returns (uint256)",
  "function pendingReward(address) view returns (uint256)",
  "function getStakeInfo(address) view returns (tuple(uint256 stakedAmount, uint256 rewardDebt))",
  "function getAPY() view returns (uint256)",
  "event Staked(address indexed user, uint256 amount)",
  "event Unstaked(address indexed user, uint256 amount)",
  "event RewardsClaimed(address indexed user, uint256 amount)",
];

const REWARDS_ABI = [
  "function stakeLPTokens(uint256 amount, uint256 lockDays)",
  "function unstakeLPTokens(uint256 amount)",
  "function claimLPRewards()",
  "function totalBoostedLP() view returns (uint256)",
  "function rewardPerSecond() view returns (uint256)",
  "function rewardEndTime() view returns (uint256)",
  "function pendingLPReward(address) view returns (uint256)",
  "function getLPStakeInfo(address) view returns (tuple(uint256 lpAmount, uint256 rewardDebt, uint256 lockEndTime, uint256 boostMultiplier, uint256 boostedAmount))",
  "function remainingRewardDuration() view returns (uint256)",
  "function getContractRewardBalance() view returns (uint256)",
  "event LPStaked(address indexed user, uint256 amount, uint256 lockDays, uint256 boostMultiplier)",
  "event LPUnstaked(address indexed user, uint256 amount)",
  "event LPRewardsClaimed(address indexed user, uint256 amount)",
];

const MOVEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
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
const vaultEvents = [];
const stakingEvents = [];
const seenVaultKeys = new Set();
const seenStakingKeys = new Set();

// ===== 공통 스타일 & 지갑 연결 코드 =====

const NAV_LINKS = `<a href="/">Dashboard</a> | <a href="/burn">Burn</a> | <a href="/swap">Swap</a> | <a href="/liquidity">LP</a> | <a href="/vault">Vault</a> | <a href="/staking">Staking</a> | <a href="/ecosystem">Ecosystem</a>`;

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

const PREMIUM_STYLE = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: linear-gradient(135deg, #0A0E27 0%, #1A1145 50%, #2D1B69 100%); color: #eee; padding: 20px; max-width: 760px; margin: 0 auto; min-height: 100vh; }
h1 { font-size: 1.8em; font-weight: 800; background: linear-gradient(135deg, #FFD54F, #e94560); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin-bottom: 4px; }
h2 { font-size: 1.1em; font-weight: 700; color: #FFD54F; margin-bottom: 12px; letter-spacing: 0.05em; text-transform: uppercase; }
.subtitle { color: rgba(255,255,255,0.5); font-size: 0.85em; margin-bottom: 24px; letter-spacing: 0.08em; text-transform: uppercase; }
.card { background: rgba(255,255,255,0.06); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 20px; margin: 14px 0; box-shadow: inset 0 1px 0 rgba(255,255,255,0.05); animation: fadeInUp 0.4s ease-out both; }
.card:nth-child(2) { animation-delay: 0.05s; }
.card:nth-child(3) { animation-delay: 0.1s; }
.card:nth-child(4) { animation-delay: 0.15s; }
.card:nth-child(5) { animation-delay: 0.2s; }
label { display: block; color: rgba(255,255,255,0.5); margin-bottom: 6px; font-size: 0.85em; letter-spacing: 0.04em; }
input, select { width: 100%; padding: 12px 14px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #eee; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 1em; margin-bottom: 10px; transition: all 0.2s ease; }
input:focus, select:focus { outline: none; border-color: #FFD54F; box-shadow: 0 0 0 3px rgba(255,213,79,0.2); }
input::placeholder { color: rgba(255,255,255,0.25); }
button { width: 100%; padding: 14px; border: none; border-radius: 8px; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 1em; font-weight: 600; cursor: pointer; transition: all 0.15s ease; position: relative; }
button:disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; }
.btn-connect { background: rgba(255,255,255,0.08); color: #eee; border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 4px 0 rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1); }
.btn-connect:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
.btn-connect:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 2px 0 rgba(0,0,0,0.3); }
.btn-action { background: linear-gradient(135deg, #e94560, #c62a47); color: #fff; box-shadow: 0 6px 0 #8B1A30, 0 8px 20px rgba(233,69,96,0.35), inset 0 1px 0 rgba(255,255,255,0.2); text-shadow: 0 1px 2px rgba(0,0,0,0.3); }
.btn-action:hover:not(:disabled) { box-shadow: 0 6px 0 #8B1A30, 0 8px 28px rgba(233,69,96,0.5), inset 0 1px 0 rgba(255,255,255,0.2); }
.btn-action:active:not(:disabled) { transform: translateY(3px); box-shadow: 0 3px 0 #8B1A30, inset 0 1px 0 rgba(255,255,255,0.2); }
.btn-faucet { background: linear-gradient(135deg, #7B2FBE, #533483); color: #eee; box-shadow: 0 4px 0 #3A1F5E, 0 6px 16px rgba(83,52,131,0.4), inset 0 1px 0 rgba(255,255,255,0.15); margin-bottom: 8px; }
.btn-faucet:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 2px 0 #3A1F5E; }
.btn-secondary { background: rgba(255,255,255,0.08); color: #eee; border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 4px 0 rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08); }
.btn-secondary:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 2px 0 rgba(0,0,0,0.3); }
.btn-gold { background: linear-gradient(135deg, #FFD54F, #FF8F00); color: #1a1a2e; box-shadow: 0 6px 0 #B8860B, 0 8px 20px rgba(255,213,79,0.3), inset 0 1px 0 rgba(255,255,255,0.3); font-weight: 700; text-shadow: none; }
.btn-gold:active:not(:disabled) { transform: translateY(3px); box-shadow: 0 3px 0 #B8860B; }
.wallet { display: flex; justify-content: space-between; align-items: center; }
.wallet-addr { color: #FFD54F; font-size: 0.9em; font-family: 'SF Mono', monospace; }
.balance { color: #4ecca3; font-size: 1.2em; font-weight: 700; font-family: 'SF Mono', monospace; }
.balance-label { color: rgba(255,255,255,0.4); font-size: 0.8em; }
#status { margin-top: 15px; padding: 14px; border-radius: 8px; display: none; font-size: 0.9em; word-break: break-all; backdrop-filter: blur(8px); }
.status-ok { background: rgba(78,204,163,0.15); border: 1px solid #4ecca3; display: block !important; color: #4ecca3; }
.status-err { background: rgba(233,69,96,0.15); border: 1px solid #e94560; display: block !important; color: #e94560; }
.status-wait { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); display: block !important; color: #aaa; }
a { color: #FFD54F; text-decoration: none; transition: color 0.2s; }
a:hover { color: #ffe082; }
.nav { margin-bottom: 24px; font-size: 0.9em; padding: 12px 16px; background: rgba(255,255,255,0.04); border-radius: 10px; border: 1px solid rgba(255,255,255,0.06); }
.nav a { margin: 0 4px; padding: 4px 8px; border-radius: 4px; transition: all 0.2s; }
.nav a:hover { background: rgba(255,213,79,0.1); }
.info-row { display: flex; justify-content: space-between; color: rgba(255,255,255,0.5); font-size: 0.85em; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
.info-row:last-child { border-bottom: none; }
.info-row span:last-child { color: #eee; font-family: 'SF Mono', monospace; }
.tab-bar { display: flex; gap: 4px; margin-bottom: 16px; }
.tab-bar button { border-radius: 8px 8px 0 0; background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.4); padding: 12px 16px; font-size: 0.95em; box-shadow: none; }
.tab-bar button.active { background: rgba(255,255,255,0.08); color: #FFD54F; border-bottom: 2px solid #FFD54F; }
.tab-content { display: none; }
.tab-content.active { display: block; }
.pct-btns { display: flex; gap: 6px; margin-bottom: 10px; }
.pct-btns button { flex: 1; padding: 8px; font-size: 0.8em; background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.08); box-shadow: none; }
.pct-btns button:hover { color: #FFD54F; border-color: rgba(255,213,79,0.3); }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 12px 0; }
.stat-box { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 14px; text-align: center; transition: transform 0.2s, box-shadow 0.2s; }
.stat-box:hover { transform: translateY(-2px); box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
.stat-value { font-size: 1.3em; font-weight: 700; color: #FFD54F; font-family: 'SF Mono', monospace; }
.stat-label { font-size: 0.75em; color: rgba(255,255,255,0.4); margin-top: 4px; letter-spacing: 0.06em; text-transform: uppercase; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 0.75em; font-weight: 600; letter-spacing: 0.04em; }
.badge-ok { background: rgba(78,204,163,0.15); color: #4ecca3; border: 1px solid rgba(78,204,163,0.3); }
.badge-warn { background: rgba(255,213,79,0.15); color: #FFD54F; border: 1px solid rgba(255,213,79,0.3); }
.badge-err { background: rgba(233,69,96,0.15); color: #e94560; border: 1px solid rgba(233,69,96,0.3); }
.row { display: flex; gap: 10px; }
.row > * { flex: 1; }
@keyframes fadeInUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
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
  if (config.VAULT_ADDRESS) console.log("Vault:  ", config.VAULT_ADDRESS);
  if (config.MOVEN_ADDRESS) console.log("MOVEN:  ", config.MOVEN_ADDRESS);
  if (config.ORACLE_ADDRESS) console.log("Oracle: ", config.ORACLE_ADDRESS);
  if (config.STAKING_ADDRESS) console.log("Staking:", config.STAKING_ADDRESS);
  if (config.REWARDS_ADDRESS) console.log("Rewards:", config.REWARDS_ADDRESS);

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

  // Vault 모니터링
  let vaultC = null;
  if (config.VAULT_ADDRESS) {
    vaultC = new ethers.Contract(config.VAULT_ADDRESS, VAULT_ABI, provider);
  }

  function processVaultEvent(e, type) {
    const txHash = e.transactionHash;
    const key = `${txHash}:${type}`;
    if (seenVaultKeys.has(key)) return;
    seenVaultKeys.add(key);
    let event = { type, txHash, timestamp: new Date().toISOString() };
    if (type === "MovenIssued") {
      event.user = e.args[0];
      event.wbmbDeposited = ethers.formatEther(e.args[1]);
      event.movenMinted = ethers.formatEther(e.args[2]);
      event.feeAmount = ethers.formatEther(e.args[3]);
      console.log(`VAULT+: ${event.wbmbDeposited} WBMB -> ${event.movenMinted} MOVEN`);
    } else if (type === "MovenRedeemed") {
      event.user = e.args[0];
      event.movenBurned = ethers.formatEther(e.args[1]);
      event.wbmbReturned = ethers.formatEther(e.args[2]);
      console.log(`VAULT-: ${event.movenBurned} MOVEN -> ${event.wbmbReturned} WBMB`);
    }
    if (vaultEvents.length >= MAX_EVENTS) vaultEvents.shift();
    vaultEvents.push(event);
  }

  // Staking 모니터링
  let stakingC = null;
  if (config.STAKING_ADDRESS) {
    stakingC = new ethers.Contract(config.STAKING_ADDRESS, STAKING_ABI, provider);
  }

  function processStakingEvent(e, type) {
    const txHash = e.transactionHash;
    const key = `${txHash}:${type}`;
    if (seenStakingKeys.has(key)) return;
    seenStakingKeys.add(key);
    let event = { type, txHash, timestamp: new Date().toISOString() };
    event.user = e.args[0];
    event.amount = ethers.formatEther(e.args[1]);
    const label = type === "Staked" ? "STAKE+" : type === "Unstaked" ? "STAKE-" : "CLAIM";
    console.log(`${label}: ${event.amount} MOVEN by ${event.user.slice(0,8)}...`);
    if (stakingEvents.length >= MAX_EVENTS) stakingEvents.shift();
    stakingEvents.push(event);
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
    if (vaultC) {
      queries.push(vaultC.queryFilter("MovenIssued", fromBlock));
      queries.push(vaultC.queryFilter("MovenRedeemed", fromBlock));
    }
    if (stakingC) {
      queries.push(stakingC.queryFilter("Staked", fromBlock));
      queries.push(stakingC.queryFilter("Unstaked", fromBlock));
      queries.push(stakingC.queryFilter("RewardsClaimed", fromBlock));
    }
    const results = await Promise.all(queries);
    let idx = 0;
    const pastBurns = results[idx++];
    const pastSwaps = dex ? results[idx++] : [];
    const pastAdds = dex ? results[idx++] : [];
    const pastRemoves = dex ? results[idx++] : [];
    const pastVIssued = vaultC ? results[idx++] : [];
    const pastVRedeemed = vaultC ? results[idx++] : [];
    const pastStaked = stakingC ? results[idx++] : [];
    const pastUnstaked = stakingC ? results[idx++] : [];
    const pastClaimed = stakingC ? results[idx++] : [];

    for (const e of pastBurns) processBurnEvent(e);
    if (pastBurns.length > 0) console.log(`Loaded ${pastBurns.length} burn event(s)`);

    if (dex) {
      for (const e of pastSwaps) processDexEvent(e, "Swap");
      for (const e of pastAdds) processDexEvent(e, "LiquidityAdded");
      for (const e of pastRemoves) processDexEvent(e, "LiquidityRemoved");
      console.log(`Loaded ${pastSwaps.length} swap, ${pastAdds.length} add, ${pastRemoves.length} remove event(s)`);
    }
    if (vaultC) {
      for (const e of pastVIssued) processVaultEvent(e, "MovenIssued");
      for (const e of pastVRedeemed) processVaultEvent(e, "MovenRedeemed");
      console.log(`Loaded ${pastVIssued.length} vault issue, ${pastVRedeemed.length} redeem event(s)`);
    }
    if (stakingC) {
      for (const e of pastStaked) processStakingEvent(e, "Staked");
      for (const e of pastUnstaked) processStakingEvent(e, "Unstaked");
      for (const e of pastClaimed) processStakingEvent(e, "RewardsClaimed");
      console.log(`Loaded ${pastStaked.length} stake, ${pastUnstaked.length} unstake, ${pastClaimed.length} claim event(s)`);
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
      if (vaultC) {
        pollQueries.push(vaultC.queryFilter("MovenIssued", lastBlock + 1, currentBlock));
        pollQueries.push(vaultC.queryFilter("MovenRedeemed", lastBlock + 1, currentBlock));
      }
      if (stakingC) {
        pollQueries.push(stakingC.queryFilter("Staked", lastBlock + 1, currentBlock));
        pollQueries.push(stakingC.queryFilter("Unstaked", lastBlock + 1, currentBlock));
        pollQueries.push(stakingC.queryFilter("RewardsClaimed", lastBlock + 1, currentBlock));
      }
      const pr = await Promise.all(pollQueries);
      let pi = 0;
      const burns = pr[pi++];
      const swaps = dex ? pr[pi++] : [];
      const adds = dex ? pr[pi++] : [];
      const removes = dex ? pr[pi++] : [];
      const vIssued = vaultC ? pr[pi++] : [];
      const vRedeemed = vaultC ? pr[pi++] : [];
      const sStaked = stakingC ? pr[pi++] : [];
      const sUnstaked = stakingC ? pr[pi++] : [];
      const sClaimed = stakingC ? pr[pi++] : [];

      for (const e of burns) processBurnEvent(e);
      if (dex) {
        for (const e of swaps) processDexEvent(e, "Swap");
        for (const e of adds) processDexEvent(e, "LiquidityAdded");
        for (const e of removes) processDexEvent(e, "LiquidityRemoved");
      }
      for (const e of vIssued) processVaultEvent(e, "MovenIssued");
      for (const e of vRedeemed) processVaultEvent(e, "MovenRedeemed");
      for (const e of sStaked) processStakingEvent(e, "Staked");
      for (const e of sUnstaked) processStakingEvent(e, "Unstaked");
      for (const e of sClaimed) processStakingEvent(e, "RewardsClaimed");

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
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
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

// ===== Vault DApp =====

app.get("/vault", (req, res) => {
  const extraSetup = `
    vaultContract = new ethers.Contract(VAULT, VAULT_ABI, signer);
    oracleContract = new ethers.Contract(ORACLE, ORACLE_ABI, new ethers.BrowserProvider(mmProvider));
    movenContract = new ethers.Contract(MOVEN, MOVEN_ABI, signer);
    document.querySelectorAll(".needs-wallet").forEach(function(b) { b.disabled = false; });
    updateVaultData();
  `;

  res.send(`<!DOCTYPE html>
<html><head>
  <title>MOVEN Vault</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.umd.min.js" integrity="sha384-NRAZj94DQk3dgtsOZzVYHbYVV1DFkF5QhL5RRxF0ILZLi6OQ7CsMlun748D42JbO" crossorigin="anonymous"><\/script>
  <style>${PREMIUM_STYLE}</style>
</head><body>
  <div class="nav">${NAV_LINKS}</div>
  <h1>MOVEN Vault</h1>
  <p class="subtitle">Deposit WBMB &middot; Mint MOVEN &middot; Base Sepolia</p>

  <div class="card">
    <div class="wallet">
      <label style="margin:0">Wallet</label>
      <span id="walletAddr" class="wallet-addr">Not connected</span>
    </div>
    <button class="btn-connect" id="btnConnect" onclick="connectWallet()">Connect MetaMask</button>
  </div>

  <div class="card">
    <h2>Oracle &amp; System</h2>
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-value" id="oraclePrice">--</div><div class="stat-label">Price (USD)</div></div>
      <div class="stat-box"><div class="stat-value" id="sysRatio">--</div><div class="stat-label">System Ratio</div></div>
      <div class="stat-box"><div class="stat-value" id="totalMoven">--</div><div class="stat-label">MOVEN Issued</div></div>
      <div class="stat-box"><div class="stat-value" id="issuanceStatus">--</div><div class="stat-label">Issuance</div></div>
    </div>
    <div class="info-row"><span>Oracle Valid</span><span id="oracleValid">--</span></div>
    <div class="info-row"><span>Total Collateral</span><span id="totalCol">--</span></div>
    <div class="info-row"><span>Insurance</span><span id="insurance">--</span></div>
  </div>

  <div class="card">
    <div class="row">
      <div><span class="balance-label">mWBMB</span><br><span class="balance" id="wbmbBal">0</span></div>
      <div><span class="balance-label">MOVEN</span><br><span class="balance" id="movenBal">0</span></div>
    </div>
    <button class="btn-faucet needs-wallet" onclick="getFaucet()" disabled style="margin-top:12px">Get 100 mWBMB (Faucet)</button>
  </div>

  <div class="card" id="vaultInfoCard" style="display:none">
    <h2>Your Vault</h2>
    <div class="info-row"><span>User Collateral</span><span id="myUserCol">--</span></div>
    <div class="info-row"><span>Foundation Collateral</span><span id="myFoundCol">--</span></div>
    <div class="info-row"><span>MOVEN Issued</span><span id="myMoven">--</span></div>
    <div class="info-row"><span>Collateral Ratio</span><span id="myRatio">--</span></div>
    <div class="info-row"><span>Issuance Price</span><span id="myPrice">--</span></div>
  </div>

  <div class="card">
    <div class="tab-bar">
      <button class="active" onclick="switchTab('open')">Open Vault</button>
      <button onclick="switchTab('redeem')">Redeem MOVEN</button>
    </div>

    <div id="tab-open" class="tab-content active">
      <label>WBMB Amount to Deposit</label>
      <input type="number" id="openAmount" placeholder="100" step="any" oninput="previewOpen()">
      <div id="openPreview" style="display:none; margin-bottom:12px">
        <div class="info-row"><span>Fee (0.5%)</span><span id="openFee">--</span></div>
        <div class="info-row"><span>Net WBMB</span><span id="openNet">--</span></div>
        <div class="info-row"><span>Est. MOVEN</span><span id="openMoven" style="color:#4ecca3;font-weight:700">--</span></div>
      </div>
      <button class="btn-action needs-wallet" onclick="openVault()" disabled>Open Vault</button>
    </div>

    <div id="tab-redeem" class="tab-content">
      <label>MOVEN Amount to Redeem</label>
      <input type="number" id="redeemAmount" placeholder="1000" step="any" oninput="previewRedeem()">
      <div id="redeemPreview" style="display:none; margin-bottom:12px">
        <div class="info-row"><span>Est. WBMB Return</span><span id="redeemWbmb" style="color:#4ecca3;font-weight:700">--</span></div>
      </div>
      <button class="btn-gold needs-wallet" onclick="redeemMoven()" disabled>Redeem MOVEN</button>
    </div>
  </div>

  <div id="status"></div>

<script>
const VAULT = "${config.VAULT_ADDRESS}";
const ORACLE = "${config.ORACLE_ADDRESS}";
const MOVEN = "${config.MOVEN_ADDRESS}";

const VAULT_ABI = [
  "function openVault(uint256 wbmbAmount)",
  "function redeemMoven(uint256 movenAmount)",
  "function getVaultInfo(address) view returns (tuple(uint256 userCollateral, uint256 foundationCollateral, uint256 movenIssued, uint256 issuancePrice, uint256 issuanceTimestamp, bool isActive))",
  "function getCollateralRatio(address) view returns (uint256)",
  "function getSystemCollateralRatio() view returns (uint256)",
  "function totalUserCollateral() view returns (uint256)",
  "function totalFoundationCollateral() view returns (uint256)",
  "function totalMovenIssued() view returns (uint256)",
  "function insuranceBalance() view returns (uint256)",
  "function isIssuancePaused() view returns (bool)",
  "function getRedemptionAmount(uint256) view returns (uint256)",
];
const ORACLE_ABI = [
  "function price() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
  "function isPriceValid() view returns (bool)",
];
const MOVEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

let vaultContract, oracleContract, movenContract;
var currentPrice = 0n;

${walletJS(extraSetup)}

function fmtE(v) { return parseFloat(ethers.formatEther(v)).toFixed(4); }
function fmtPrice(v) { return (Number(v) / 1e8).toFixed(2); }

async function updateVaultData() {
  try {
    var [wBal, mBal, price, valid, totalUC, totalFC, totalMI, ins, paused, vInfo] = await Promise.all([
      wbmbContract.balanceOf(userAddress),
      movenContract.balanceOf(userAddress),
      oracleContract.price(),
      oracleContract.isPriceValid(),
      vaultContract.totalUserCollateral(),
      vaultContract.totalFoundationCollateral(),
      vaultContract.totalMovenIssued(),
      vaultContract.insuranceBalance(),
      vaultContract.isIssuancePaused(),
      vaultContract.getVaultInfo(userAddress),
    ]);
    currentPrice = price;
    document.getElementById("wbmbBal").textContent = fmtE(wBal);
    document.getElementById("movenBal").textContent = fmtE(mBal);
    document.getElementById("oraclePrice").textContent = "$" + fmtPrice(price);
    document.getElementById("oracleValid").innerHTML = valid ? '<span class="badge badge-ok">VALID</span>' : '<span class="badge badge-err">STALE</span>';
    document.getElementById("totalCol").textContent = fmtE(totalUC + totalFC) + " WBMB";
    document.getElementById("totalMoven").textContent = fmtE(totalMI);
    document.getElementById("insurance").textContent = fmtE(ins) + " WBMB";
    document.getElementById("issuanceStatus").innerHTML = paused ? '<span class="badge badge-err">PAUSED</span>' : '<span class="badge badge-ok">ACTIVE</span>';

    var sysR = "N/A";
    try {
      var r = await vaultContract.getSystemCollateralRatio();
      sysR = r > 1000000n ? "N/A" : r.toString() + "%";
    } catch(e) {}
    document.getElementById("sysRatio").textContent = sysR;

    if (vInfo.isActive) {
      document.getElementById("vaultInfoCard").style.display = "block";
      document.getElementById("myUserCol").textContent = fmtE(vInfo.userCollateral) + " WBMB";
      document.getElementById("myFoundCol").textContent = fmtE(vInfo.foundationCollateral) + " WBMB";
      document.getElementById("myMoven").textContent = fmtE(vInfo.movenIssued) + " MOVEN";
      document.getElementById("myPrice").textContent = "$" + fmtPrice(vInfo.issuancePrice);
      try {
        var cr = await vaultContract.getCollateralRatio(userAddress);
        document.getElementById("myRatio").textContent = cr > 1000000n ? "N/A" : cr.toString() + "%";
      } catch(e) { document.getElementById("myRatio").textContent = "N/A"; }
    } else {
      document.getElementById("vaultInfoCard").style.display = "none";
    }
  } catch(e) { console.log("Update error:", e); }
}

function previewOpen() {
  var val = document.getElementById("openAmount").value;
  if (!val || parseFloat(val) <= 0 || currentPrice === 0n) {
    document.getElementById("openPreview").style.display = "none"; return;
  }
  var amt = parseFloat(val);
  var fee = amt * 0.005;
  var net = amt - fee;
  var moven = net * Number(currentPrice) / 1e8;
  document.getElementById("openFee").textContent = fee.toFixed(4) + " WBMB";
  document.getElementById("openNet").textContent = net.toFixed(4) + " WBMB";
  document.getElementById("openMoven").textContent = moven.toFixed(4) + " MOVEN";
  document.getElementById("openPreview").style.display = "block";
}

async function openVault() {
  try {
    var val = document.getElementById("openAmount").value;
    if (!val || parseFloat(val) <= 0) { setStatus("Enter amount", "err"); return; }
    var amt = ethers.parseEther(val);
    var allow = await wbmbContract.allowance(userAddress, VAULT);
    if (allow < amt) {
      setStatus("Step 1/2: Approving WBMB...", "wait");
      var atx = await wbmbContract.approve(VAULT, amt);
      await atx.wait();
    }
    setStatus("Step 2/2: Opening vault...", "wait");
    var tx = await vaultContract.openVault(amt);
    await tx.wait();
    document.getElementById("openAmount").value = "";
    document.getElementById("openPreview").style.display = "none";
    await updateVaultData();
    setStatus("Vault opened! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

var redeemTimer = null;
function previewRedeem() {
  clearTimeout(redeemTimer);
  redeemTimer = setTimeout(async function() {
    var val = document.getElementById("redeemAmount").value;
    if (!val || parseFloat(val) <= 0 || !vaultContract) {
      document.getElementById("redeemPreview").style.display = "none"; return;
    }
    try {
      var wbmb = await vaultContract.getRedemptionAmount(ethers.parseEther(val));
      document.getElementById("redeemWbmb").textContent = fmtE(wbmb) + " WBMB";
      document.getElementById("redeemPreview").style.display = "block";
    } catch(e) { document.getElementById("redeemPreview").style.display = "none"; }
  }, 300);
}

async function redeemMoven() {
  try {
    var val = document.getElementById("redeemAmount").value;
    if (!val || parseFloat(val) <= 0) { setStatus("Enter amount", "err"); return; }
    setStatus("Redeeming MOVEN...", "wait");
    var tx = await vaultContract.redeemMoven(ethers.parseEther(val));
    await tx.wait();
    document.getElementById("redeemAmount").value = "";
    document.getElementById("redeemPreview").style.display = "none";
    await updateVaultData();
    setStatus("Redeemed! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

async function getFaucet() {
  try {
    setStatus("Getting 100 mWBMB...", "wait");
    var tx = await wbmbContract.faucet(ethers.parseEther("100"));
    await tx.wait();
    await updateVaultData();
    setStatus("Got 100 mWBMB!", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

function switchTab(tab) {
  document.querySelectorAll(".tab-content").forEach(function(el) { el.classList.remove("active"); });
  document.querySelectorAll(".tab-bar button").forEach(function(b) { b.classList.remove("active"); });
  document.getElementById("tab-" + tab).classList.add("active");
  event.target.classList.add("active");
}
<\/script>
</body></html>`);
});

// ===== Staking DApp =====

app.get("/staking", (req, res) => {
  const extraSetup = `
    stakingContract = new ethers.Contract(STAKING, STAKING_ABI, signer);
    rewardsContract = new ethers.Contract(REWARDS, REWARDS_ABI, signer);
    movenContract = new ethers.Contract(MOVEN, MOVEN_ABI, signer);
    lpTokenContract = new ethers.Contract(DEX, ERC20_ABI, signer);
    document.querySelectorAll(".needs-wallet").forEach(function(b) { b.disabled = false; });
    updateStakingData();
  `;

  res.send(`<!DOCTYPE html>
<html><head>
  <title>MOVEN Staking & LP Farming</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.umd.min.js" integrity="sha384-NRAZj94DQk3dgtsOZzVYHbYVV1DFkF5QhL5RRxF0ILZLi6OQ7CsMlun748D42JbO" crossorigin="anonymous"><\/script>
  <style>${PREMIUM_STYLE}</style>
</head><body>
  <div class="nav">${NAV_LINKS}</div>
  <h1>Staking &amp; LP Farming</h1>
  <p class="subtitle">Stake MOVEN &middot; Farm LP Rewards &middot; Base Sepolia</p>

  <div class="card">
    <div class="wallet">
      <label style="margin:0">Wallet</label>
      <span id="walletAddr" class="wallet-addr">Not connected</span>
    </div>
    <button class="btn-connect" id="btnConnect" onclick="connectWallet()">Connect MetaMask</button>
  </div>

  <div class="card">
    <div class="row">
      <div><span class="balance-label">MOVEN</span><br><span class="balance" id="movenBal">0</span></div>
      <div><span class="balance-label">LP Token</span><br><span class="balance" id="lpBal">0</span></div>
    </div>
  </div>

  <div class="card">
    <div class="tab-bar">
      <button class="active" onclick="switchMain('moven')">MOVEN Staking</button>
      <button onclick="switchMain('lp')">LP Farming</button>
    </div>

    <!-- MOVEN Staking -->
    <div id="main-moven" class="tab-content active">
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-value" id="totalStaked">--</div><div class="stat-label">Total Staked</div></div>
        <div class="stat-box"><div class="stat-value" id="rewardPool">--</div><div class="stat-label">Reward Pool</div></div>
        <div class="stat-box"><div class="stat-value" id="stakingAPY">--</div><div class="stat-label">Est. APY</div></div>
      </div>

      <div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:14px;margin:12px 0">
        <div class="info-row"><span>Your Staked</span><span id="myStaked" style="color:#4ecca3">0</span></div>
        <div class="info-row"><span>Pending Rewards</span><span id="myPending" style="color:#FFD54F">0</span></div>
      </div>

      <label>Stake MOVEN</label>
      <input type="number" id="stakeAmt" placeholder="100" step="any">
      <button class="btn-action needs-wallet" onclick="stakeMoven()" disabled>Stake MOVEN</button>

      <label style="margin-top:12px">Unstake MOVEN</label>
      <input type="number" id="unstakeAmt" placeholder="100" step="any">
      <button class="btn-secondary needs-wallet" onclick="unstakeMoven()" disabled>Unstake MOVEN</button>

      <button class="btn-gold needs-wallet" onclick="claimStaking()" disabled style="margin-top:12px">Claim Rewards</button>
    </div>

    <!-- LP Farming -->
    <div id="main-lp" class="tab-content">
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-value" id="totalBoosted">--</div><div class="stat-label">Boosted LP</div></div>
        <div class="stat-box"><div class="stat-value" id="rewardRate">--</div><div class="stat-label">Reward/Sec</div></div>
        <div class="stat-box"><div class="stat-value" id="remaining">--</div><div class="stat-label">Remaining</div></div>
      </div>

      <div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:14px;margin:12px 0">
        <div class="info-row"><span>Your LP Staked</span><span id="myLP">0</span></div>
        <div class="info-row"><span>Boost</span><span id="myBoost">--</span></div>
        <div class="info-row"><span>Lock End</span><span id="myLock">--</span></div>
        <div class="info-row"><span>Pending Rewards</span><span id="myLPPending" style="color:#FFD54F">0</span></div>
      </div>

      <label>Stake LP Tokens</label>
      <input type="number" id="lpStakeAmt" placeholder="1.0" step="any">
      <label>Lock Period</label>
      <select id="lockDays">
        <option value="0">No Lock (1.0x)</option>
        <option value="30">30 Days (1.3x)</option>
        <option value="90">90 Days (1.7x)</option>
        <option value="180">180 Days (2.0x)</option>
      </select>
      <button class="btn-action needs-wallet" onclick="stakeLP()" disabled>Stake LP</button>

      <label style="margin-top:12px">Unstake LP Tokens</label>
      <input type="number" id="lpUnstakeAmt" placeholder="1.0" step="any">
      <button class="btn-secondary needs-wallet" onclick="unstakeLP()" disabled>Unstake LP</button>

      <button class="btn-gold needs-wallet" onclick="claimLP()" disabled style="margin-top:12px">Claim LP Rewards</button>
    </div>
  </div>

  <div id="status"></div>

<script>
const STAKING = "${config.STAKING_ADDRESS}";
const REWARDS = "${config.REWARDS_ADDRESS}";
const MOVEN = "${config.MOVEN_ADDRESS}";

const STAKING_ABI = [
  "function stake(uint256 amount)",
  "function unstake(uint256 amount)",
  "function claimRewards()",
  "function totalStaked() view returns (uint256)",
  "function rewardPool() view returns (uint256)",
  "function pendingReward(address) view returns (uint256)",
  "function getStakeInfo(address) view returns (tuple(uint256 stakedAmount, uint256 rewardDebt))",
  "function getAPY() view returns (uint256)",
];
const REWARDS_ABI = [
  "function stakeLPTokens(uint256 amount, uint256 lockDays)",
  "function unstakeLPTokens(uint256 amount)",
  "function claimLPRewards()",
  "function totalBoostedLP() view returns (uint256)",
  "function rewardPerSecond() view returns (uint256)",
  "function rewardEndTime() view returns (uint256)",
  "function pendingLPReward(address) view returns (uint256)",
  "function getLPStakeInfo(address) view returns (tuple(uint256 lpAmount, uint256 rewardDebt, uint256 lockEndTime, uint256 boostMultiplier, uint256 boostedAmount))",
  "function remainingRewardDuration() view returns (uint256)",
];
const MOVEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

let stakingContract, rewardsContract, movenContract, lpTokenContract;

${walletJS(extraSetup)}

function fmtE(v) { return parseFloat(ethers.formatEther(v)).toFixed(4); }
function fmtDur(s) {
  var sec = Number(s);
  if (sec <= 0) return "Ended";
  var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  return d + "d " + h + "h";
}

async function updateStakingData() {
  try {
    var [mBal, lpBal, ts, rp, apy, sInfo, pending,
         tbl, rps, endT, lpInfo, lpPending] = await Promise.all([
      movenContract.balanceOf(userAddress),
      lpTokenContract.balanceOf(userAddress),
      stakingContract.totalStaked(),
      stakingContract.rewardPool(),
      stakingContract.getAPY(),
      stakingContract.getStakeInfo(userAddress),
      stakingContract.pendingReward(userAddress),
      rewardsContract.totalBoostedLP(),
      rewardsContract.rewardPerSecond(),
      rewardsContract.rewardEndTime(),
      rewardsContract.getLPStakeInfo(userAddress),
      rewardsContract.pendingLPReward(userAddress),
    ]);
    document.getElementById("movenBal").textContent = fmtE(mBal);
    document.getElementById("lpBal").textContent = fmtE(lpBal);
    document.getElementById("totalStaked").textContent = fmtE(ts);
    document.getElementById("rewardPool").textContent = fmtE(rp);
    document.getElementById("stakingAPY").textContent = (Number(apy) / 100).toFixed(2) + "%";
    document.getElementById("myStaked").textContent = fmtE(sInfo.stakedAmount) + " MOVEN";
    document.getElementById("myPending").textContent = fmtE(pending) + " MOVEN";
    document.getElementById("totalBoosted").textContent = fmtE(tbl);
    document.getElementById("rewardRate").textContent = fmtE(rps);
    var now = Math.floor(Date.now() / 1000);
    var rem = Number(endT) > now ? Number(endT) - now : 0;
    document.getElementById("remaining").textContent = fmtDur(rem);
    document.getElementById("myLP").textContent = fmtE(lpInfo.lpAmount) + " LP";
    document.getElementById("myBoost").textContent = lpInfo.boostMultiplier > 0n ? (Number(lpInfo.boostMultiplier) / 100).toFixed(1) + "x" : "--";
    document.getElementById("myLock").textContent = Number(lpInfo.lockEndTime) > 0 ? new Date(Number(lpInfo.lockEndTime) * 1000).toLocaleString() : "--";
    document.getElementById("myLPPending").textContent = fmtE(lpPending) + " MOVEN";
  } catch(e) { console.log("Update error:", e); }
}

async function stakeMoven() {
  try {
    var val = document.getElementById("stakeAmt").value;
    if (!val || parseFloat(val) <= 0) { setStatus("Enter amount", "err"); return; }
    var amt = ethers.parseEther(val);
    var allow = await movenContract.allowance(userAddress, STAKING);
    if (allow < amt) {
      setStatus("Step 1/2: Approving MOVEN...", "wait");
      var atx = await movenContract.approve(STAKING, amt);
      await atx.wait();
    }
    setStatus("Step 2/2: Staking...", "wait");
    var tx = await stakingContract.stake(amt);
    await tx.wait();
    document.getElementById("stakeAmt").value = "";
    await updateStakingData();
    setStatus("Staked! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

async function unstakeMoven() {
  try {
    var val = document.getElementById("unstakeAmt").value;
    if (!val || parseFloat(val) <= 0) { setStatus("Enter amount", "err"); return; }
    setStatus("Unstaking...", "wait");
    var tx = await stakingContract.unstake(ethers.parseEther(val));
    await tx.wait();
    document.getElementById("unstakeAmt").value = "";
    await updateStakingData();
    setStatus("Unstaked! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

async function claimStaking() {
  try {
    setStatus("Claiming rewards...", "wait");
    var tx = await stakingContract.claimRewards();
    await tx.wait();
    await updateStakingData();
    setStatus("Claimed! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

async function stakeLP() {
  try {
    var val = document.getElementById("lpStakeAmt").value;
    var days = parseInt(document.getElementById("lockDays").value);
    if (!val || parseFloat(val) <= 0) { setStatus("Enter amount", "err"); return; }
    var amt = ethers.parseEther(val);
    var allow = await lpTokenContract.allowance(userAddress, REWARDS);
    if (allow < amt) {
      setStatus("Step 1/2: Approving LP...", "wait");
      var atx = await lpTokenContract.approve(REWARDS, amt);
      await atx.wait();
    }
    setStatus("Step 2/2: Staking LP...", "wait");
    var tx = await rewardsContract.stakeLPTokens(amt, days);
    await tx.wait();
    document.getElementById("lpStakeAmt").value = "";
    await updateStakingData();
    setStatus("LP Staked! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

async function unstakeLP() {
  try {
    var val = document.getElementById("lpUnstakeAmt").value;
    if (!val || parseFloat(val) <= 0) { setStatus("Enter amount", "err"); return; }
    setStatus("Unstaking LP...", "wait");
    var tx = await rewardsContract.unstakeLPTokens(ethers.parseEther(val));
    await tx.wait();
    document.getElementById("lpUnstakeAmt").value = "";
    await updateStakingData();
    setStatus("LP Unstaked! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

async function claimLP() {
  try {
    setStatus("Claiming LP rewards...", "wait");
    var tx = await rewardsContract.claimLPRewards();
    await tx.wait();
    await updateStakingData();
    setStatus("Claimed! TX: " + tx.hash.slice(0,14) + "...", "ok");
  } catch(err) { setStatus(err.shortMessage || err.message, "err"); }
}

function switchMain(tab) {
  document.querySelectorAll(".tab-content").forEach(function(el) { el.classList.remove("active"); });
  document.querySelectorAll(".tab-bar button").forEach(function(b) { b.classList.remove("active"); });
  document.getElementById("main-" + tab).classList.add("active");
  event.target.classList.add("active");
}
<\/script>
</body></html>`);
});

// ===== Ecosystem Dashboard =====

app.get("/ecosystem", async (req, res) => {
  try {
    const prov = new ethers.JsonRpcProvider(config.RPC_URL);
    const oracle = new ethers.Contract(config.ORACLE_ADDRESS, ORACLE_ABI, prov);
    const vault = new ethers.Contract(config.VAULT_ADDRESS, VAULT_ABI, prov);
    const moven = new ethers.Contract(config.MOVEN_ADDRESS, MOVEN_ABI, prov);
    const stak = new ethers.Contract(config.STAKING_ADDRESS, STAKING_ABI, prov);
    const rwds = new ethers.Contract(config.REWARDS_ADDRESS, REWARDS_ABI, prov);
    const dexC = new ethers.Contract(config.DEX_ADDRESS, DEX_ABI, prov);

    const [oPrice, oValid, oLastUp,
      tUC, tFC, tMI, ins, paused,
      mSupply,
      tStaked, rPool, apy,
      tBoosted, rps, rEndT, rDur, rBal,
      dReserves, dLPSupply, dFeeA, dFeeB
    ] = await Promise.all([
      oracle.price(), oracle.isPriceValid(), oracle.lastUpdateTime(),
      vault.totalUserCollateral(), vault.totalFoundationCollateral(),
      vault.totalMovenIssued(), vault.insuranceBalance(), vault.isIssuancePaused(),
      moven.totalSupply(),
      stak.totalStaked(), stak.rewardPool(), stak.getAPY(),
      rwds.totalBoostedLP(), rwds.rewardPerSecond(), rwds.rewardEndTime(),
      rwds.remainingRewardDuration(), rwds.getContractRewardBalance(),
      dexC.getReserves(), dexC.totalSupply(), dexC.protocolFeeA(), dexC.protocolFeeB(),
    ]);

    var sysRatio = "N/A";
    try {
      var sr = await vault.getSystemCollateralRatio();
      sysRatio = sr > 1000000n ? "N/A" : sr.toString() + "%";
    } catch(e) {}

    const fe = (v) => parseFloat(ethers.formatEther(v)).toFixed(4);
    const fp = (v) => (Number(v) / 1e8).toFixed(2);
    const now = Math.floor(Date.now() / 1000);
    const stale = now - Number(oLastUp);
    const staleStr = Math.floor(stale / 3600) + "h " + (stale % 3600) + "s";
    const durSec = Number(rDur);
    const durStr = durSec <= 0 ? "Ended" : Math.floor(durSec / 86400) + "d " + Math.floor((durSec % 86400) / 3600) + "h";
    const apyStr = (Number(apy) / 100).toFixed(2) + "%";

    const vRows = vaultEvents.map(e => {
      if (e.type === "MovenIssued") {
        return '<tr><td style="color:#4ecca3">OPEN</td><td>' + esc(e.user.slice(0,8)) + '...</td><td>' + esc(e.wbmbDeposited) + ' WBMB -> ' + esc(e.movenMinted) + ' MOVEN</td><td>' + esc(e.timestamp) + '</td></tr>';
      }
      return '<tr><td style="color:#e94560">REDEEM</td><td>' + esc(e.user.slice(0,8)) + '...</td><td>' + esc(e.movenBurned) + ' MOVEN -> ' + esc(e.wbmbReturned) + ' WBMB</td><td>' + esc(e.timestamp) + '</td></tr>';
    }).reverse().join("");

    const sRows = stakingEvents.map(e => {
      var color = e.type === "Staked" ? "#4ecca3" : e.type === "Unstaked" ? "#e94560" : "#FFD54F";
      var label = e.type === "Staked" ? "STAKE" : e.type === "Unstaked" ? "UNSTAKE" : "CLAIM";
      return '<tr><td style="color:' + color + '">' + label + '</td><td>' + esc(e.user.slice(0,8)) + '...</td><td>' + esc(e.amount) + ' MOVEN</td><td>' + esc(e.timestamp) + '</td></tr>';
    }).reverse().join("");

    const addr = (label, a) => '<div class="info-row"><span>' + label + '</span><span><a href="https://sepolia.basescan.org/address/' + a + '" target="_blank">' + a.slice(0,8) + '...' + a.slice(-6) + '</a></span></div>';

    res.send(`<!DOCTYPE html>
<html><head>
  <title>MOVEN Ecosystem</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: linear-gradient(135deg, #0A0E27 0%, #1A1145 50%, #2D1B69 100%); color: #eee; padding: 20px; max-width: 1100px; margin: 0 auto; min-height: 100vh; }
    h1 { font-size: 1.8em; font-weight: 800; background: linear-gradient(135deg, #FFD54F, #e94560); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin-bottom: 4px; }
    h2 { font-size: 1em; font-weight: 700; color: #FFD54F; margin-bottom: 10px; letter-spacing: 0.06em; text-transform: uppercase; }
    .subtitle { color: rgba(255,255,255,0.45); font-size: 0.85em; margin-bottom: 24px; letter-spacing: 0.08em; }
    a { color: #FFD54F; text-decoration: none; }
    a:hover { color: #ffe082; }
    .nav { margin-bottom: 24px; font-size: 0.9em; padding: 12px 16px; background: rgba(255,255,255,0.04); border-radius: 10px; border: 1px solid rgba(255,255,255,0.06); }
    .nav a { margin: 0 4px; padding: 4px 8px; border-radius: 4px; }
    .card { background: rgba(255,255,255,0.06); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 18px; margin: 12px 0; animation: fadeInUp 0.4s ease-out both; }
    .card:nth-child(2) { animation-delay: 0.05s; }
    .card:nth-child(3) { animation-delay: 0.1s; }
    .card:nth-child(4) { animation-delay: 0.15s; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 10px 0; }
    .stat-box { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 12px; text-align: center; }
    .stat-value { font-size: 1.2em; font-weight: 700; color: #FFD54F; font-family: 'SF Mono', monospace; }
    .stat-label { font-size: 0.7em; color: rgba(255,255,255,0.4); margin-top: 3px; letter-spacing: 0.06em; text-transform: uppercase; }
    .info-row { display: flex; justify-content: space-between; color: rgba(255,255,255,0.5); font-size: 0.82em; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .info-row:last-child { border-bottom: none; }
    .info-row span:last-child { color: #eee; font-family: 'SF Mono', monospace; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 0.72em; font-weight: 600; }
    .badge-ok { background: rgba(78,204,163,0.15); color: #4ecca3; }
    .badge-err { background: rgba(233,69,96,0.15); color: #e94560; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.82em; }
    th { background: rgba(255,255,255,0.06); padding: 8px; text-align: left; color: rgba(255,255,255,0.5); }
    td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .empty { background: rgba(255,255,255,0.03); border-radius: 8px; padding: 14px; color: rgba(255,255,255,0.3); border-left: 3px solid #e94560; font-size: 0.85em; }
    @keyframes fadeInUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 700px) { .grid2 { grid-template-columns: 1fr; } }
  </style>
</head><body>
  <div class="nav">${NAV_LINKS}</div>
  <h1>MOVEN Ecosystem</h1>
  <p class="subtitle">Base Sepolia &middot; Auto-refresh 10s &middot; ${new Date().toISOString().slice(0,19)}Z</p>

  <div class="grid2">
    <div class="card">
      <h2>Price Oracle</h2>
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-value">$${fp(oPrice)}</div><div class="stat-label">Price</div></div>
        <div class="stat-box"><div class="stat-value">${staleStr}</div><div class="stat-label">Staleness</div></div>
      </div>
      <div class="info-row"><span>Valid</span><span>${oValid ? '<span class="badge badge-ok">YES</span>' : '<span class="badge badge-err">STALE</span>'}</span></div>
    </div>

    <div class="card">
      <h2>MovenToken</h2>
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-value">${fe(mSupply)}</div><div class="stat-label">Total Supply</div></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>MovenVault</h2>
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-value">${fe(tUC)}</div><div class="stat-label">User Collateral</div></div>
      <div class="stat-box"><div class="stat-value">${fe(tFC)}</div><div class="stat-label">Foundation Col.</div></div>
      <div class="stat-box"><div class="stat-value">${fe(tMI)}</div><div class="stat-label">MOVEN Issued</div></div>
      <div class="stat-box"><div class="stat-value">${sysRatio}</div><div class="stat-label">System Ratio</div></div>
    </div>
    <div class="info-row"><span>Insurance Balance</span><span>${fe(ins)} WBMB</span></div>
    <div class="info-row"><span>Issuance</span><span>${paused ? '<span class="badge badge-err">PAUSED</span>' : '<span class="badge badge-ok">ACTIVE</span>'}</span></div>
  </div>

  <div class="grid2">
    <div class="card">
      <h2>MovenStaking</h2>
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-value">${fe(tStaked)}</div><div class="stat-label">Total Staked</div></div>
        <div class="stat-box"><div class="stat-value">${fe(rPool)}</div><div class="stat-label">Reward Pool</div></div>
      </div>
      <div class="info-row"><span>Est. APY</span><span>${apyStr}</span></div>
    </div>

    <div class="card">
      <h2>LP Rewards</h2>
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-value">${fe(tBoosted)}</div><div class="stat-label">Boosted LP</div></div>
        <div class="stat-box"><div class="stat-value">${fe(rps)}</div><div class="stat-label">Reward/Sec</div></div>
      </div>
      <div class="info-row"><span>Remaining</span><span>${durStr}</span></div>
      <div class="info-row"><span>Reward Balance</span><span>${fe(rBal)} MOVEN</span></div>
    </div>
  </div>

  <div class="card">
    <h2>SimpleDEX</h2>
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-value">${fe(dReserves[0])}</div><div class="stat-label">Reserve mWBMB</div></div>
      <div class="stat-box"><div class="stat-value">${fe(dReserves[1])}</div><div class="stat-label">Reserve mFYUSD</div></div>
      <div class="stat-box"><div class="stat-value">${fe(dLPSupply)}</div><div class="stat-label">LP Supply</div></div>
    </div>
    <div class="info-row"><span>Protocol Fee A</span><span>${fe(dFeeA)} WBMB</span></div>
    <div class="info-row"><span>Protocol Fee B</span><span>${fe(dFeeB)} FYUSD</span></div>
  </div>

  <div class="card">
    <h2>Contract Addresses</h2>
    ${addr("PriceOracle", config.ORACLE_ADDRESS)}
    ${addr("MovenVault", config.VAULT_ADDRESS)}
    ${addr("MovenToken", config.MOVEN_ADDRESS)}
    ${addr("MovenStaking", config.STAKING_ADDRESS)}
    ${addr("MovenRewards", config.REWARDS_ADDRESS)}
    ${addr("SimpleDEX", config.DEX_ADDRESS)}
    ${addr("MockWBMB", config.WBMB_ADDRESS)}
    ${addr("MockFYUSD", config.FYUSD_ADDRESS)}
    ${addr("BridgeBurn", config.BRIDGE_ADDRESS)}
  </div>

  <div class="grid2">
    <div class="card">
      <h2>Vault Activity</h2>
      ${vaultEvents.length === 0 ? '<div class="empty">No vault events yet</div>' : '<table><tr><th>Type</th><th>User</th><th>Details</th><th>Time</th></tr>' + vRows + '</table>'}
    </div>
    <div class="card">
      <h2>Staking Activity</h2>
      ${stakingEvents.length === 0 ? '<div class="empty">No staking events yet</div>' : '<table><tr><th>Type</th><th>User</th><th>Amount</th><th>Time</th></tr>' + sRows + '</table>'}
    </div>
  </div>

</body></html>`);
  } catch (err) {
    console.error("Ecosystem page error:", err.message);
    res.status(500).send(`<!DOCTYPE html><html><head><title>Error</title><style>body{font-family:monospace;background:#1a1a2e;color:#e94560;padding:40px;text-align:center;}</style></head><body><h1>Ecosystem Error</h1><p>${esc(err.message)}</p><p><a href="/ecosystem" style="color:#FFD54F">Retry</a></p></body></html>`);
  }
});

// ===== APIs =====

app.get("/api/config", (req, res) => {
  res.json({
    bridgeAddress: config.BRIDGE_ADDRESS,
    wbmbAddress: config.WBMB_ADDRESS,
    fyusdAddress: config.FYUSD_ADDRESS || null,
    dexAddress: config.DEX_ADDRESS || null,
    vaultAddress: config.VAULT_ADDRESS || null,
    movenAddress: config.MOVEN_ADDRESS || null,
    oracleAddress: config.ORACLE_ADDRESS || null,
    stakingAddress: config.STAKING_ADDRESS || null,
    rewardsAddress: config.REWARDS_ADDRESS || null,
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

app.get("/api/vault-events", (req, res) => {
  res.json({
    total: vaultEvents.length,
    issued: vaultEvents.filter((e) => e.type === "MovenIssued").length,
    redeemed: vaultEvents.filter((e) => e.type === "MovenRedeemed").length,
    events: vaultEvents,
  });
});

app.get("/api/staking-events", (req, res) => {
  res.json({
    total: stakingEvents.length,
    staked: stakingEvents.filter((e) => e.type === "Staked").length,
    unstaked: stakingEvents.filter((e) => e.type === "Unstaked").length,
    claimed: stakingEvents.filter((e) => e.type === "RewardsClaimed").length,
    events: stakingEvents,
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", burns: burnEvents.length, dexEvents: dexEvents.length, vaultEvents: vaultEvents.length, stakingEvents: stakingEvents.length });
});

// ===== 서버 시작 =====

app.listen(config.PORT, () => {
  console.log(`Dashboard: http://localhost:${config.PORT}`);
});

startMonitor().catch((err) => {
  console.error("Monitor failed:", err);
  process.exit(1);
});
