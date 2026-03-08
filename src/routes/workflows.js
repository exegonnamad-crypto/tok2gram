const express = require("express");
const { auth } = require("../middleware/auth");
const { checkPlan } = require("../middleware/planLimits");
const Workflow = require("../models/Workflow");
const { logActivity } = require("../services/scheduler");

const router = express.Router();

// ── List workflows ──
router.get("/", auth, async (req, res, next) => {
  try {
    const workflows = await Workflow.find({ userId: req.user.id })
      .populate("destinationAccountId", "username profilePic status")
      .sort({ createdAt: -1 });
    res.json(workflows);
  } catch (err) { next(err); }
});

// ── Create workflow ──
router.post("/", auth, checkPlan("workflows"), async (req, res, next) => {
  try {
    const {
      name, description, destinationAccountId,
      captionStyle, customCaption, captionTemplate,
      hashtags, appendHashtags, autoPublish, autoRequeue,
      removeWatermark, postingTimes, postsPerDay,
    } = req.body;

    if (!name) return res.status(400).json({ error: "Workflow name required" });
    if (!destinationAccountId) return res.status(400).json({ error: "Destination account required" });

    const workflow = await Workflow.create({
      userId: req.user.id,
      name: name.trim(),
      description: description || "",
      destinationAccountId,
      captionStyle: captionStyle || "original",
      customCaption: customCaption || "",
      captionTemplate: captionTemplate || "",
      hashtags: hashtags || "",
      appendHashtags: appendHashtags !== false,
      autoPublish: autoPublish !== false,
      autoRequeue: autoRequeue || false,
      removeWatermark: removeWatermark !== false,
      postingTimes: postingTimes || [],
      postsPerDay: postsPerDay || null,
    });

    await logActivity(req.user.id, null, "", "workflow_created", `Workflow "${name}" created`);

    res.status(201).json(workflow);
  } catch (err) { next(err); }
});

// ── Update workflow ──
router.put("/:id", auth, async (req, res, next) => {
  try {
    const update = { ...req.body };
    delete update.userId;
    delete update.videosProcessed;

    const workflow = await Workflow.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      update,
      { new: true, runValidators: true }
    );
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    await logActivity(req.user.id, null, "", "workflow_updated", `Workflow "${workflow.name}" updated`);
    res.json(workflow);
  } catch (err) { next(err); }
});

// ── Toggle workflow ──
router.post("/:id/toggle", auth, async (req, res, next) => {
  try {
    const workflow = await Workflow.findOne({ _id: req.params.id, userId: req.user.id });
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    workflow.status = workflow.status === "active" ? "paused" : "active";
    await workflow.save();
    res.json({ status: workflow.status });
  } catch (err) { next(err); }
});

// ── Delete workflow ──
router.delete("/:id", auth, async (req, res, next) => {
  try {
    const workflow = await Workflow.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    await logActivity(req.user.id, null, "", "workflow_deleted", `Workflow "${workflow.name}" deleted`);
    res.json({ message: "Workflow deleted" });
  } catch (err) { next(err); }
});

module.exports = router;
