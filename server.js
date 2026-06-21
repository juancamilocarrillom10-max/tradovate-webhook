const express = require("express");
const axios   = require("axios");
const app     = express();
app.use(express.json());

// ─── CONFIGURACION ────────────────────────────────────────────────────────────
// Rellena estos datos con los tuyos de Tradovate
const CONFIG = {
  username:    process.env.TV_USERNAME    || "TU_USUARIO_TRADOVATE",
  password:    process.env.TV_PASSWORD    || "TU_PASSWORD_TRADOVATE",
  appId:       process.env.TV_APP_ID      || "Sample App",
  appVersion:  process.env.TV_APP_VERSION || "1.0",
  deviceId:    process.env.TV_DEVICE_ID   || "webhook-server-001",
  cid:         process.env.TV_CID         || "",   // Client ID si tienes API key
  sec:         process.env.TV_SEC         || "",   // Secret si tienes API key
  accountName: process.env.TV_ACCOUNT     || "",   // Nombre exacto de tu cuenta en Tradovate
  defaultSymbol: process.env.TV_SYMBOL    || "MGCQ6", // Simbolo de respaldo si la alerta no manda uno
  webhookSecret: process.env.WEBHOOK_SECRET || "mi_clave_secreta_123",
};

// URL base — las cuentas Eval/fondeo de Lucid corren sobre el entorno LIVE de Tradovate
const BASE_URL = "https://live.tradovateapi.com/v1";
// Solo para cuentas de practica gratuitas sin fondeo real: "https://demo.tradovateapi.com/v1"

// ─── TOKEN DE ACCESO ──────────────────────────────────────────────────────────
let accessToken  = null;
let tokenExpires = 0;

async function getToken() {
  if (accessToken && Date.now() < tokenExpires) return accessToken;

  console.log("🔑 Obteniendo token de Tradovate...");
  try {
    const body = {
      name:       CONFIG.username,
      password:   CONFIG.password,
      appId:      CONFIG.appId,
      appVersion: CONFIG.appVersion,
      deviceId:   CONFIG.deviceId,
    };
    if (CONFIG.cid) body.cid = CONFIG.cid;
    if (CONFIG.sec) body.sec = CONFIG.sec;

    const res = await axios.post(`${BASE_URL}/auth/accesstokenrequest`, body);
    accessToken  = res.data.accessToken;
    tokenExpires = Date.now() + 75 * 60 * 1000; // renueva cada 75 min
    console.log("✅ Token obtenido");
    return accessToken;
  } catch (err) {
    console.error("❌ Error obteniendo token:", err.response?.data || err.message);
    throw err;
  }
}

// ─── OBTENER ID DE CUENTA ─────────────────────────────────────────────────────
async function getAccountId(token) {
  const res = await axios.get(`${BASE_URL}/account/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accounts = res.data;
  if (!accounts || accounts.length === 0) throw new Error("No se encontraron cuentas");

  // Si tienes nombre de cuenta configurado lo busca, sino usa la primera
  const account = CONFIG.accountName
    ? accounts.find(a => a.name === CONFIG.accountName) || accounts[0]
    : accounts[0];

  console.log(`📋 Cuenta: ${account.name} (ID: ${account.id})`);
  return account.id;
}

// ─── EJECUTAR ORDEN ───────────────────────────────────────────────────────────
async function placeOrder(action, symbol, qty, sl_price, tp_price) {
  const token     = await getToken();
  const accountId = await getAccountId(token);

  const side = action === "BUY" ? "Buy" : "Sell";

  // Orden de mercado con bracket (SL + TP)
  const orderBody = {
    accountId,
    action:   side,
    symbol:   symbol,
    orderQty: qty,
    orderType: "Market",
    isAutomated: true,
    bracket1: {
      action:    side === "Buy" ? "Sell" : "Buy",
      orderType: "Stop",
      stopPrice: sl_price,
    },
    bracket2: {
      action:    side === "Buy" ? "Sell" : "Buy",
      orderType: "Limit",
      price:     tp_price,
    },
  };

  console.log(`📤 Enviando orden ${side} ${symbol} x${qty} | SL: ${sl_price} | TP: ${tp_price}`);

  const res = await axios.post(`${BASE_URL}/order/placeorder`, orderBody, {
    headers: { Authorization: `Bearer ${token}` },
  });

  console.log("✅ Orden enviada:", JSON.stringify(res.data, null, 2));
  return res.data;
}

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("\n📨 Alerta recibida:", JSON.stringify(req.body, null, 2));

  // Verificacion de seguridad
  const { secret, action, symbol, qty, sl, tp } = req.body;
  if (secret !== CONFIG.webhookSecret) {
    console.warn("⚠️  Clave incorrecta — alerta ignorada");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Si la alerta no manda symbol, usa el de respaldo configurado en Railway
  const finalSymbol = symbol || CONFIG.defaultSymbol;

  // Validar campos
  if (!action || !qty || !sl || !tp) {
    return res.status(400).json({ error: "Faltan campos: action, qty, sl, tp" });
  }
  if (!["BUY", "SELL"].includes(action.toUpperCase())) {
    return res.status(400).json({ error: "action debe ser BUY o SELL" });
  }

  try {
    const result = await placeOrder(action.toUpperCase(), finalSymbol, parseInt(qty), parseFloat(sl), parseFloat(tp));
    res.json({ ok: true, symbol: finalSymbol, order: result });
  } catch (err) {
    console.error("❌ Error al colocar orden:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "online",
    defaultSymbol: CONFIG.defaultSymbol,
    env:    BASE_URL.includes("demo") ? "DEMO" : "LIVE",
    time:   new Date().toISOString(),
  });
});

// ─── ARRANCAR ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 Entorno: ${BASE_URL.includes("demo") ? "DEMO" : "LIVE"}`);
  console.log(`🎯 Simbolo por defecto: ${CONFIG.defaultSymbol} (cada alerta puede mandar su propio symbol)`);
});
