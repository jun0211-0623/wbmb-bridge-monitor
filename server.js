const { ethers } = require("ethers");
const express = require("express");
const config = require("./config");

// 설정 검증
if (!config.BRIDGE_ADDRESS || !config.WBMB_ADDRESS) {
  console.error("Error: Contract addresses not set in monitor/config.js");
  console.error("Run the deploy script first:");
  console.error("  npx hardhat run scripts/deploy.js --network baseSepolia");
  process.exit(1);
}

const BRIDGE_ABI = [
  "event BurnExecuted(uint256 indexed burnId, address indexed burner, uint256 amount, string mobickAddress, uint256 timestamp)",
  "event BurnProcessed(uint256 indexed burnId)",
  "function getBurnRecord(uint256 burnId) view returns (tuple(address burner, uint256 amount, string mobickAddress, uint256 timestamp, bool processed))",
  "function getBurnCount() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
];

const app = express();
const burnEvents = [];

async function startMonitor() {
  console.log("Starting bridge monitor...");
  console.log("RPC:    ", config.RPC_URL);
  console.log("Bridge: ", config.BRIDGE_ADDRESS);
  console.log("WBMB:   ", config.WBMB_ADDRESS);

  const provider = new ethers.JsonRpcProvider(config.RPC_URL, undefined, {
    pollingInterval: 5000,
  });

  // 연결 확인
  try {
    const network = await provider.getNetwork();
    console.log("Connected to chain:", network.chainId.toString());
  } catch (err) {
    console.error("Failed to connect to RPC:", err.message);
    process.exit(1);
  }

  const bridge = new ethers.Contract(
    config.BRIDGE_ADDRESS,
    BRIDGE_ABI,
    provider
  );

  // 이벤트 처리 함수
  function processEvent(e) {
    const burnId = e.args[0].toString();
    // 중복 체크
    if (burnEvents.some((ev) => ev.burnId === burnId)) return;

    const event = {
      burnId,
      burner: e.args[1],
      amount: ethers.formatEther(e.args[2]),
      mobickAddress: e.args[3],
      timestamp: new Date(Number(e.args[4]) * 1000).toISOString(),
      detectedAt: new Date().toISOString(),
    };

    burnEvents.push(event);

    console.log("\n============= BURN DETECTED =============");
    console.log(`  Burn ID:  #${event.burnId}`);
    console.log(`  From:     ${event.burner}`);
    console.log(`  Amount:   ${event.amount} WBMB`);
    console.log(`  BMB To:   ${event.mobickAddress}`);
    console.log(`  Time:     ${event.timestamp}`);
    console.log("  -----------------------------------------");
    console.log(`  ACTION: Send ${event.amount} BMB to ${event.mobickAddress}`);
    console.log("  (Simulation: no actual BMB sent)");
    console.log("  =========================================\n");
  }

  // 과거 이벤트 로드 + 폴링 시작 블록 설정
  let lastBlock = 0;
  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 1000);
    console.log(`Loading past events from block ${fromBlock}...`);

    const pastEvents = await bridge.queryFilter("BurnExecuted", fromBlock);
    for (const e of pastEvents) {
      processEvent(e);
    }
    if (pastEvents.length > 0) {
      console.log(`Loaded ${pastEvents.length} past burn event(s)`);
    }
    lastBlock = currentBlock;
  } catch (err) {
    console.log("Could not load past events:", err.message);
    lastBlock = await provider.getBlockNumber();
  }

  // 수동 폴링 (공용 RPC filter 미지원 대응)
  console.log("Polling for new events every 5s...\n");
  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastBlock) return;

      const events = await bridge.queryFilter(
        "BurnExecuted",
        lastBlock + 1,
        currentBlock
      );
      for (const e of events) {
        processEvent(e);
      }
      lastBlock = currentBlock;
    } catch (err) {
      console.error("Polling error:", err.message);
    }
  }, 5000);
}

// 대시보드 HTML
app.get("/", (req, res) => {
  const totalAmount = burnEvents
    .reduce((sum, e) => sum + parseFloat(e.amount), 0)
    .toFixed(2);

  const rows = burnEvents
    .map(
      (e) => `
      <tr>
        <td>${e.burnId}</td>
        <td title="${e.burner}">${e.burner.slice(0, 8)}...${e.burner.slice(-6)}</td>
        <td>${e.amount} WBMB</td>
        <td title="${e.mobickAddress}">${e.mobickAddress.length > 20 ? e.mobickAddress.slice(0, 20) + "..." : e.mobickAddress}</td>
        <td>${e.timestamp}</td>
      </tr>`
    )
    .reverse()
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>WBMB Bridge Monitor</title>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5">
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; max-width: 1000px; margin: 0 auto; }
    h1 { color: #e94560; }
    .stats { display: flex; gap: 20px; margin: 20px 0; }
    .stat { background: #0f3460; padding: 20px; border-radius: 8px; text-align: center; flex: 1; }
    .stat h2 { color: #e94560; font-size: 2em; margin: 0; }
    .stat p { color: #aaa; margin: 5px 0 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th { background: #0f3460; padding: 10px; text-align: left; }
    td { padding: 10px; border-bottom: 1px solid #333; }
    .empty { background: #16213e; border-radius: 8px; padding: 15px; margin: 10px 0; border-left: 4px solid #e94560; }
    .info { color: #aaa; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>WBMB → BMB Bridge Monitor</h1>
  <p class="info">Base Sepolia Testnet | Auto-refresh every 5s | <a href="/burn" style="color:#e94560">Burn Bridge</a></p>

  <div class="stats">
    <div class="stat">
      <h2>${burnEvents.length}</h2>
      <p>Total Burns</p>
    </div>
    <div class="stat">
      <h2>${totalAmount}</h2>
      <p>Total WBMB Burned</p>
    </div>
  </div>

  <h2>Recent Burns</h2>
  ${
    burnEvents.length === 0
      ? '<div class="empty"><p>No burn events yet. Run the burn script to test!</p></div>'
      : `<table>
    <tr><th>#</th><th>From</th><th>Amount</th><th>BMB Address</th><th>Time</th></tr>
    ${rows}
  </table>`
  }
</body>
</html>`;
  res.send(html);
});

// 소각 요청 페이지 (DApp)
app.get("/burn", (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>WBMB Burn Bridge</title>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; max-width: 600px; margin: 0 auto; }
    h1 { color: #e94560; margin-bottom: 5px; }
    .subtitle { color: #aaa; font-size: 0.9em; margin-bottom: 30px; }
    .card { background: #16213e; border-radius: 8px; padding: 20px; margin: 15px 0; }
    label { display: block; color: #aaa; margin-bottom: 5px; font-size: 0.9em; }
    input { width: 100%; padding: 12px; background: #0f3460; border: 1px solid #333; border-radius: 6px; color: #eee; font-family: monospace; font-size: 1em; margin-bottom: 15px; }
    input:focus { outline: none; border-color: #e94560; }
    button { width: 100%; padding: 14px; border: none; border-radius: 6px; font-family: monospace; font-size: 1.1em; cursor: pointer; transition: opacity 0.2s; }
    button:hover { opacity: 0.9; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-connect { background: #0f3460; color: #eee; }
    .btn-faucet { background: #533483; color: #eee; }
    .btn-burn { background: #e94560; color: #fff; }
    .wallet { display: flex; justify-content: space-between; align-items: center; }
    .wallet-addr { color: #e94560; font-size: 0.9em; }
    .balance { color: #4ecca3; font-size: 1.2em; }
    #status { margin-top: 15px; padding: 12px; border-radius: 6px; display: none; font-size: 0.9em; word-break: break-all; }
    .status-ok { background: #1b4332; border: 1px solid #4ecca3; display: block !important; }
    .status-err { background: #461220; border: 1px solid #e94560; display: block !important; }
    .status-wait { background: #1a1a2e; border: 1px solid #aaa; display: block !important; }
    a { color: #e94560; }
    .nav { margin-bottom: 20px; }
    .steps { color: #aaa; font-size: 0.85em; line-height: 1.6; }
    .steps b { color: #eee; }
  </style>
</head>
<body>
  <div class="nav"><a href="/">Monitor Dashboard</a> | <b>Burn Bridge</b></div>
  <h1>WBMB Burn Bridge</h1>
  <p class="subtitle">Base Sepolia Testnet</p>

  <div class="card">
    <div class="steps">
      <b>How it works:</b><br>
      1. Connect MetaMask (Base Sepolia network)<br>
      2. Get test tokens from Faucet<br>
      3. Enter amount & your BMB address<br>
      4. Burn! Monitor will detect it
    </div>
  </div>

  <div class="card">
    <div class="wallet">
      <label style="margin:0">Wallet</label>
      <span id="walletAddr" class="wallet-addr">Not connected</span>
    </div>
    <p style="margin: 8px 0"><span class="balance" id="tokenBalance">0</span> mWBMB</p>
    <button class="btn-connect" id="btnConnect" onclick="connectWallet()">Connect MetaMask</button>
  </div>

  <div class="card">
    <button class="btn-faucet" id="btnFaucet" onclick="getFaucet()" disabled>Get 100 mWBMB (Faucet)</button>
  </div>

  <div class="card">
    <label>Burn Amount (mWBMB)</label>
    <input type="number" id="burnAmount" placeholder="50" min="0.01" step="any">
    <label>BMB Destination Address</label>
    <input type="text" id="mobickAddr" placeholder="mobick:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa">
    <button class="btn-burn" id="btnBurn" onclick="executeBurn()" disabled>Burn WBMB</button>
  </div>

  <div id="status"></div>

<script>
const BRIDGE = "${config.BRIDGE_ADDRESS}";
const WBMB = "${config.WBMB_ADDRESS}";
const CHAIN_HEX = "0x14a34";

const WBMB_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function faucet(uint256)",
  "function decimals() view returns (uint8)"
];
const BRIDGE_ABI = [
  "function burnForBMB(uint256, string)"
];

let provider, signer, wbmbContract, bridgeContract, userAddress;
var mmProvider = null; // MetaMask 전용 provider

function setStatus(msg, type) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status-" + type;
}

// 여러 지갑 중 MetaMask만 찾기
function getMetaMaskProvider() {
  if (window.ethereum) {
    // 여러 지갑이 있으면 providers 배열에서 MetaMask 찾기
    if (window.ethereum.providers && window.ethereum.providers.length) {
      for (var i = 0; i < window.ethereum.providers.length; i++) {
        if (window.ethereum.providers[i].isMetaMask) {
          return window.ethereum.providers[i];
        }
      }
    }
    // 단일 지갑이 MetaMask인 경우
    if (window.ethereum.isMetaMask) {
      return window.ethereum;
    }
  }
  return null;
}

async function connectWallet() {
  try {
    mmProvider = getMetaMaskProvider();
    if (!mmProvider) {
      setStatus("MetaMask not found. Other wallets detected but MetaMask is required.", "err");
      return;
    }

    setStatus("Connecting to MetaMask...", "wait");

    // 1. 이미 연결된 계정 확인
    var accounts = await mmProvider.request({ method: "eth_accounts" });

    // 2. 없으면 권한 요청
    if (!accounts || accounts.length === 0) {
      try {
        await mmProvider.request({
          method: "wallet_requestPermissions",
          params: [{ eth_accounts: {} }]
        });
        accounts = await mmProvider.request({ method: "eth_accounts" });
      } catch (permErr) {
        if (permErr.code === 4001) {
          setStatus("Connection rejected. Please approve in MetaMask.", "err");
        } else {
          setStatus("Permission error [" + permErr.code + "]: " + permErr.message, "err");
        }
        return;
      }
    }

    if (!accounts || accounts.length === 0) {
      setStatus("No account found. Unlock MetaMask and retry.", "err");
      return;
    }

    // 3. 체인 확인 & 전환
    var chainId = await mmProvider.request({ method: "eth_chainId" });
    if (chainId !== CHAIN_HEX) {
      try {
        await mmProvider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: CHAIN_HEX }]
        });
      } catch (e) {
        if (e.code === 4902) {
          await mmProvider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: CHAIN_HEX,
              chainName: "Base Sepolia",
              rpcUrls: ["https://sepolia.base.org"],
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
              blockExplorerUrls: ["https://sepolia.basescan.org"]
            }]
          });
        } else {
          setStatus("Switch to Base Sepolia in MetaMask.", "err");
          return;
        }
      }
      accounts = await mmProvider.request({ method: "eth_accounts" });
    }

    // 4. ethers provider + signer (MetaMask provider 사용, 이중호출 방지)
    var cached = accounts.slice();
    provider = new ethers.BrowserProvider(mmProvider);
    var origSend = provider.send.bind(provider);
    provider.send = async function(method, params) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return cached;
      return origSend(method, params);
    };
    signer = await provider.getSigner();
    userAddress = cached[0];

    // 5. 컨트랙트
    wbmbContract = new ethers.Contract(WBMB, WBMB_ABI, signer);
    bridgeContract = new ethers.Contract(BRIDGE, BRIDGE_ABI, signer);

    // 6. UI 업데이트
    document.getElementById("walletAddr").textContent = userAddress.slice(0,6) + "..." + userAddress.slice(-4);
    document.getElementById("btnConnect").textContent = "Connected";
    document.getElementById("btnConnect").disabled = true;
    document.getElementById("btnFaucet").disabled = false;
    document.getElementById("btnBurn").disabled = false;
    await updateBalance();
    setStatus("Connected: " + userAddress.slice(0,6) + "..." + userAddress.slice(-4), "ok");

  } catch (err) {
    setStatus("[" + (err.code || "?") + "] " + (err.shortMessage || err.message || String(err)), "err");
  }
}

// 페이지 로드 시 MetaMask 감지 + 자동 연결
window.addEventListener("load", function() {
  var mm = getMetaMaskProvider();
  if (!mm) return;

  mm.on("chainChanged", function() { location.reload(); });
  mm.on("accountsChanged", function(accs) {
    if (accs.length === 0) { location.reload(); }
    else { connectWallet(); }
  });

  mm.request({ method: "eth_accounts" }).then(function(accs) {
    if (accs && accs.length > 0) { connectWallet(); }
  }).catch(function() {});
});

async function updateBalance() {
  try {
    var bal = await wbmbContract.balanceOf(userAddress);
    document.getElementById("tokenBalance").textContent = ethers.formatEther(bal);
  } catch (e) {
    document.getElementById("tokenBalance").textContent = "?";
  }
}

async function getFaucet() {
  try {
    document.getElementById("btnFaucet").disabled = true;
    setStatus("Requesting 100 mWBMB from faucet... (confirm in MetaMask)", "wait");
    var tx = await wbmbContract.faucet(ethers.parseEther("100"));
    setStatus("TX sent, waiting for confirmation...", "wait");
    await tx.wait();
    await updateBalance();
    setStatus("Got 100 mWBMB!", "ok");
  } catch (err) {
    setStatus("Faucet: " + (err.shortMessage || err.message), "err");
  } finally {
    document.getElementById("btnFaucet").disabled = false;
  }
}

async function executeBurn() {
  try {
    var amount = document.getElementById("burnAmount").value;
    var mobickAddr = document.getElementById("mobickAddr").value;
    if (!amount || parseFloat(amount) <= 0) { setStatus("Enter a valid amount", "err"); return; }
    if (!mobickAddr) { setStatus("Enter a BMB destination address", "err"); return; }

    var parsedAmount = ethers.parseEther(amount);
    document.getElementById("btnBurn").disabled = true;

    var allowance = await wbmbContract.allowance(userAddress, BRIDGE);
    if (allowance < parsedAmount) {
      setStatus("Step 1/2: Approving... (confirm in MetaMask)", "wait");
      var approveTx = await wbmbContract.approve(BRIDGE, parsedAmount);
      setStatus("Step 1/2: Waiting for approval...", "wait");
      await approveTx.wait();
    }

    setStatus("Step 2/2: Burning " + amount + " mWBMB... (confirm in MetaMask)", "wait");
    var burnTx = await bridgeContract.burnForBMB(parsedAmount, mobickAddr);
    setStatus("Waiting for confirmation...", "wait");
    var receipt = await burnTx.wait();

    await updateBalance();
    setStatus("Burn successful! " + amount + " mWBMB burned. TX: " + receipt.hash.slice(0,14) + "... Check Monitor Dashboard!", "ok");
  } catch (err) {
    setStatus("Burn: " + (err.shortMessage || err.message), "err");
  } finally {
    document.getElementById("btnBurn").disabled = false;
  }
}
</script>
</body>
</html>`;
  res.send(html);
});

// 컨트랙트 주소 API (프론트엔드용)
app.get("/api/config", (req, res) => {
  res.json({
    bridgeAddress: config.BRIDGE_ADDRESS,
    wbmbAddress: config.WBMB_ADDRESS,
    chainId: 84532,
  });
});

// API
app.get("/api/burns", (req, res) => {
  res.json({ total: burnEvents.length, burns: burnEvents });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", events: burnEvents.length });
});

// 서버 시작
app.listen(config.PORT, () => {
  console.log(`Dashboard: http://localhost:${config.PORT}`);
});

startMonitor().catch((err) => {
  console.error("Monitor failed:", err);
  process.exit(1);
});
