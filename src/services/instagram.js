const { spawn } = require("child_process");
const logger = require("../utils/logger");
const { sanitizeForPython } = require("../utils/helpers");
const { encrypt, decrypt } = require("../utils/crypto");

/**
 * Login to Instagram via instagrapi (Python)
 */
async function login(username, password, existingSession = null) {
  const safeUser = sanitizeForPython(username);
  const safePass = sanitizeForPython(password);

  let sessionBlock = `cl.login('${safeUser}', '${safePass}')`;
  if (existingSession) {
    const decryptedSession = decrypt(existingSession);
    if (decryptedSession) {
      const safeSession = sanitizeForPython(decryptedSession);
      sessionBlock = `
try:
    cl.set_settings(json.loads('${safeSession}'))
    cl.login('${safeUser}', '${safePass}')
except:
    cl = Client()
    cl.delay_range = [2, 5]
    cl.login('${safeUser}', '${safePass}')`;
    }
  }

  const script = `
import sys, json
try:
    from instagrapi import Client
    cl = Client()
    cl.delay_range = [2, 5]
    ${sessionBlock}
    session = json.dumps(cl.get_settings())
    user_id = str(cl.user_id)
    info = cl.account_info()
    pic = str(info.profile_pic_url) if info.profile_pic_url else ""
    print(json.dumps({"success": True, "userId": user_id, "username": "${safeUser}", "sessionData": session, "profilePic": pic}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;

  return runPython(script, 60000);
}

/**
 * Post a video reel via instagrapi
 */
async function postReel(sessionData, videoPath, caption, accountId) {
  const decryptedSession = decrypt(sessionData);
  if (!decryptedSession) {
    return { success: false, error: "Session expired — please reconnect your Instagram account" };
  }

  const safeSession = sanitizeForPython(decryptedSession);
  const safeCaption = sanitizeForPython(caption);
  const safePath = videoPath.replace(/\\/g, "/");

  const script = `
import sys, json
try:
    from instagrapi import Client
    cl = Client()
    cl.delay_range = [1, 3]
    settings = json.loads('${safeSession}')
    cl.set_settings(settings)
    cl.get_timeline_feed()
    media = cl.clip_upload('${safePath}', caption='${safeCaption}')
    new_session = json.dumps(cl.get_settings())
    media_url = f"https://www.instagram.com/reel/{media.code}/" if media.code else ""
    print(json.dumps({"success": True, "mediaId": str(media.pk), "mediaCode": str(media.code or ""), "postUrl": media_url, "sessionData": new_session}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;

  return runPython(script, 120000);
}

/**
 * Add a first comment to a media post (e.g. hashtags)
 */
async function addFirstComment(sessionData, mediaId, comment, accountId) {
  const decryptedSession = decrypt(sessionData);
  if (!decryptedSession) {
    return { success: false, error: "Session expired — please reconnect your Instagram account" };
  }

  const safeSession = sanitizeForPython(decryptedSession);
  const safeComment = sanitizeForPython(comment);

  const script = `
import sys, json
try:
    from instagrapi import Client
    cl = Client()
    cl.delay_range = [1, 3]
    settings = json.loads('${safeSession}')
    cl.set_settings(settings)
    cl.get_timeline_feed()
    result = cl.media_comment(${mediaId}, '${safeComment}')
    comment_id = str(result.pk) if hasattr(result, 'pk') else str(result)
    print(json.dumps({"success": True, "commentId": comment_id}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;

  return runPython(script, 30000);
}

/**
 * Fetch post analytics via instagrapi
 */
async function getPostInsights(sessionData, mediaId) {
  const decryptedSession = decrypt(sessionData);
  if (!decryptedSession) return { success: false, error: "No session" };

  const safeSession = sanitizeForPython(decryptedSession);

  const script = `
import sys, json
try:
    from instagrapi import Client
    cl = Client()
    cl.set_settings(json.loads('${safeSession}'))
    cl.get_timeline_feed()
    info = cl.media_info(${mediaId})
    print(json.dumps({
        "success": True,
        "likes": info.like_count or 0,
        "comments": info.comment_count or 0,
        "views": getattr(info, 'view_count', 0) or 0,
        "plays": getattr(info, 'play_count', 0) or 0,
    }))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;

  return runPython(script, 30000);
}

/**
 * Run a Python script and parse JSON output
 */
function runPython(script, timeout = 60000) {
  return new Promise((resolve) => {
    const py = spawn("python3", ["-c", script]);
    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (d) => (stdout += d.toString()));
    py.stderr.on("data", (d) => (stderr += d.toString()));

    py.on("close", (code) => {
      try {
        const lines = stdout.trim().split("\n").reverse();
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed && typeof parsed === "object" && "success" in parsed) {
              return resolve(parsed);
            }
          } catch {}
        }
        resolve({ success: false, error: stderr || "No valid response from Python" });
      } catch {
        resolve({ success: false, error: stderr || "Python execution failed" });
      }
    });

    py.on("error", (err) => {
      logger.error("Python spawn error", { error: err.message });
      resolve({ success: false, error: "Python/Instagrapi not available — check server setup" });
    });

    setTimeout(() => {
      py.kill();
      resolve({ success: false, error: `Operation timed out (${timeout / 1000}s)` });
    }, timeout);
  });
}

module.exports = { login, postReel, addFirstComment, getPostInsights };
