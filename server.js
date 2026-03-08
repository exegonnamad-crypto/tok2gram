const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const config = require("./src/config");
const logger = require("./src/utils/logger");
const { apiLimiter } = require("./src/middleware/rateLimiter");
const { errorHandler, notFoundHandler } = require("./src/middleware/errorHandler");

// ── Routes ──
const authRoutes = require("./src/routes/auth");
const accountRoutes = require("./src/routes/accounts");
const videoRoutes = require("./src/routes/videos");
const workflowRoutes = require("./src/routes/workflows");
const statsRoutes = require("./src/routes/stats");
const adminRoutes = require("./src/routes/admin");
const aiRoutes = require("./src/routes/ai");
const oauthRoutes = require("./src/routes/oauth");
const discoverRoutes = require("./src/routes/discover");
const toolsRoutes = require("./src/routes/tools");
const evergreenRoutes = require("./src/routes/evergreen");
const abtestRoutes = require("./src/routes/abtest");
const bioRoutes = require("./src/routes/biopage");
const gamificationRoutes = require("./src/routes/gamification");
const paymentRoutes = require("./src/routes/payments");

// ── Services ──
const scheduler = require("./src/services/scheduler");

// ── Express App ──
const app = express();

// ── Security ──
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// ── CORS ──
app.use(cors({
  origin: config.frontendUrls,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
}));

// ── Body parsing ──
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ──
app.use("/api/", apiLimiter);

// ── Request logging ──
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (duration > 5000 || res.statusCode >= 400) {
      logger.info(`${req.method} ${req.path}`, {
        status: res.statusCode,
        duration: `${duration}ms`,
        userId: req.user?.id,
      });
    }
  });
  next();
});

// ── Routes ──
app.use("/api", authRoutes);
app.use("/api/accounts", oauthRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/videos", videoRoutes);
app.use("/api/workflows", workflowRoutes);
app.use("/api", statsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/discover", discoverRoutes);
app.use("/api/tools", toolsRoutes);
app.use("/api/evergreen", evergreenRoutes);
app.use("/api/ab-test", abtestRoutes);
app.use("/api/bio", bioRoutes);
app.use("/api/gamification", gamificationRoutes);
app.use("/api/payments", paymentRoutes);

// ── Health checks ──
app.get("/", (req, res) => {
  res.json({
    name: "ReelFlow API",
    version: "5.0.0",
    status: "running",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", async (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };
  res.status(dbState === 1 ? 200 : 503).json({
    ok: dbState === 1,
    database: dbStatus[dbState] || "unknown",
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage().rss,
  });
});

// ── Error handling ──
app.use(notFoundHandler);
app.use(errorHandler);

// ── Database connection ──
mongoose.connect(config.mongoUri, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
  .then(() => {
    logger.info("MongoDB connected");

    // Start scheduler after DB is ready
    scheduler.startScheduler();

    // Start server
    app.listen(config.port, () => {
      logger.info(`ReelFlow API v5.0.0 running on port ${config.port}`, {
        env: config.nodeEnv,
        cors: config.frontendUrls,
      });
    });
  })
  .catch(err => {
    logger.error("MongoDB connection failed", { error: err.message });
    process.exit(1);
  });

// ── Graceful shutdown ──
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received — shutting down gracefully");
  await mongoose.connection.close();
  process.exit(0);
});

process.on("unhandledRejection", (err) => {
  logger.error("Unhandled rejection", { error: err.message, stack: err.stack });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = app;
