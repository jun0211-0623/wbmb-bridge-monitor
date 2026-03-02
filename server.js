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
  <p class="info">Base Sepolia Testnet | Auto-refresh every 5s | Bridge: ${config.BRIDGE_ADDRESS.slice(0, 10)}...</p>

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
