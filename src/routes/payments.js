const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const axios = require("axios");
const config = require("../config");
const { auth } = require("../middleware/auth");
const User = require("../models/User");
const logger = require("../utils/logger");

const PLAN_PRICES = {
  pro: 12,
  agency: 39,
};

const NOWPAYMENTS_API = "https://api.nowpayments.io/v1";

// ─── POST /create-checkout ─── Create NOWPayments invoice
router.post("/create-checkout", auth, async (req, res) => {
  try {
    const { plan } = req.body;

    if (!plan || !["pro", "agency"].includes(plan)) {
      return res.status(400).json({ error: "Invalid plan. Must be 'pro' or 'agency'" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const frontendUrl = config.frontendUrls[0] || "http://localhost:5173";
    const orderId = `${user._id}_${plan}_${Date.now()}`;

    const { data } = await axios.post(
      `${NOWPAYMENTS_API}/invoice`,
      {
        price_amount: PLAN_PRICES[plan],
        price_currency: "usd",
        order_id: orderId,
        order_description: `ReelFlow ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan - 30 days`,
        ipn_callback_url: `${config.frontendUrls.find(u => u && !u.includes("localhost")) || frontendUrl}/api/payments/webhook`,
        success_url: `${frontendUrl}/settings?payment=success`,
        cancel_url: `${frontendUrl}/settings?payment=cancelled`,
      },
      {
        headers: {
          "x-api-key": config.nowpayments.apiKey,
          "Content-Type": "application/json",
        },
      }
    );

    logger.info("NOWPayments invoice created", {
      userId: user._id,
      plan,
      invoiceId: data.id,
      orderId,
    });

    res.json({ invoiceUrl: data.invoice_url, invoiceId: data.id });
  } catch (err) {
    logger.error("Create checkout failed", {
      error: err.response?.data || err.message,
      userId: req.user.id,
    });
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ─── POST /webhook ─── NOWPayments IPN callback (no auth)
router.post("/webhook", async (req, res) => {
  try {
    const sig = req.headers["x-nowpayments-sig"];
    if (!sig) {
      logger.warn("Webhook missing signature header");
      return res.status(400).json({ error: "Missing signature" });
    }

    // Verify HMAC-SHA512 signature
    const ipnSecret = config.nowpayments.ipnSecret;
    const sortedPayload = JSON.stringify(sortObject(req.body));
    const hmac = crypto
      .createHmac("sha512", ipnSecret)
      .update(sortedPayload)
      .digest("hex");

    if (hmac !== sig) {
      logger.warn("Webhook signature mismatch");
      return res.status(400).json({ error: "Invalid signature" });
    }

    const { payment_status, order_id, payment_id } = req.body;

    logger.info("NOWPayments webhook received", {
      payment_status,
      order_id,
      payment_id,
    });

    if (payment_status === "finished" || payment_status === "confirmed") {
      // Parse order_id: {userId}_{plan}_{timestamp}
      const parts = order_id.split("_");
      if (parts.length < 3) {
        logger.warn("Invalid order_id format", { order_id });
        return res.json({ received: true });
      }

      const userId = parts[0];
      const plan = parts[1];

      if (!["pro", "agency"].includes(plan)) {
        logger.warn("Invalid plan in order_id", { order_id, plan });
        return res.json({ received: true });
      }

      const planExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await User.findByIdAndUpdate(userId, {
        plan,
        planExpiresAt,
        paymentProvider: "crypto",
        lastPaymentId: String(payment_id),
        lastPaymentAt: new Date(),
      });

      logger.info("User plan upgraded via crypto payment", {
        userId,
        plan,
        paymentId: payment_id,
        expiresAt: planExpiresAt,
      });
    } else if (payment_status === "failed" || payment_status === "expired") {
      logger.warn("Payment failed or expired", {
        payment_status,
        order_id,
        payment_id,
      });
    }

    res.json({ received: true });
  } catch (err) {
    logger.error("Webhook handler error", { error: err.message });
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// ─── GET /status ─── Current plan status
router.get("/status", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "plan planExpiresAt trialEndsAt paymentProvider lastPaymentId lastPaymentAt autoRenew"
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    const now = new Date();
    const isTrialing =
      user.plan === "free" && user.trialEndsAt && new Date(user.trialEndsAt) > now;

    const isPlanActive =
      user.plan !== "free" && user.planExpiresAt && new Date(user.planExpiresAt) > now;

    const daysRemaining = user.planExpiresAt
      ? Math.max(0, Math.ceil((new Date(user.planExpiresAt) - now) / 86400000))
      : null;

    let trialDaysRemaining = null;
    if (isTrialing) {
      trialDaysRemaining = Math.max(
        0,
        Math.ceil((new Date(user.trialEndsAt) - now) / 86400000)
      );
    }

    res.json({
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
      trialEndsAt: user.trialEndsAt,
      isTrialing,
      trial: isTrialing,
      trialDaysRemaining,
      isPlanActive,
      daysRemaining,
      paymentProvider: user.paymentProvider,
      lastPaymentAt: user.lastPaymentAt,
      autoRenew: user.autoRenew,
    });
  } catch (err) {
    logger.error("Get payment status failed", { error: err.message, userId: req.user.id });
    res.status(500).json({ error: "Failed to get payment status" });
  }
});

// ─── POST /cancel ─── Disable auto-renew reminder (crypto is one-time, no recurring)
router.post("/cancel", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.autoRenew = false;
    await user.save();

    logger.info("User disabled auto-renew reminder", { userId: user._id });

    res.json({
      message: "Auto-renewal reminder disabled. Your plan will remain active until it expires.",
      planExpiresAt: user.planExpiresAt,
    });
  } catch (err) {
    logger.error("Cancel auto-renew failed", { error: err.message, userId: req.user.id });
    res.status(500).json({ error: "Failed to update renewal preference" });
  }
});

// ─── Helper: sort object keys recursively for HMAC verification ───
function sortObject(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortObject);
  return Object.keys(obj)
    .sort()
    .reduce((result, key) => {
      result[key] = sortObject(obj[key]);
      return result;
    }, {});
}

module.exports = router;
