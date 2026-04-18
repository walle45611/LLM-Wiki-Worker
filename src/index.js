const SUPPORTED_COMMAND = "我今天讀了什麼";
const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const GITHUB_API_BASE = "https://api.github.com";

import { buildSummaryUserPrompt, SUMMARY_SYSTEM_PROMPT } from "./prompts.js";

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Unhandled worker error", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return Response.json({ ok: true, service: "llmwikiworker" });
  }

  if (request.method !== "POST" || url.pathname !== "/webhook") {
    return new Response("Not Found", { status: 404 });
  }

  const bodyText = await request.text();
  const signature = request.headers.get("x-line-signature");

  if (!(await verifyLineSignature(bodyText, signature, env.LINE_CHANNEL_SECRET))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = JSON.parse(bodyText);
  const events = Array.isArray(payload.events) ? payload.events : [];

  await Promise.all(
    events.map((event) => handleLineEvent(event, env)),
  );

  return new Response("OK", { status: 200 });
}

export async function handleLineEvent(event, env) {
  if (!event?.replyToken || event.replyToken === "00000000000000000000000000000000") {
    return;
  }

  if (event.type !== "message" || event.message?.type !== "text") {
    return replyToLine(event.replyToken, "目前只支援文字訊息。", env.LINE_CHANNEL_ACCESS_TOKEN);
  }

  const text = event.message.text.trim();
  if (text !== SUPPORTED_COMMAND) {
    return replyToLine(
      event.replyToken,
      `目前只支援指令「${SUPPORTED_COMMAND}」。`,
      env.LINE_CHANNEL_ACCESS_TOKEN,
    );
  }

  let todayInfo = null;

  try {
    const config = getRuntimeConfig(env);
    todayInfo = getTodayInfo(config.timezone);
    const logContent = await fetchGithubFile(config);
    const todayLog = extractTodayLog(logContent, todayInfo);

    if (!todayLog) {
      return replyToLine(
        event.replyToken,
        `今天（${todayInfo.displayDate}）沒有讀書紀錄。`,
        env.LINE_CHANNEL_ACCESS_TOKEN,
      );
    }

    const summary = await summarizeTodayLog(todayLog, todayInfo, env.AI, config.aiModel);
    const message = clampLineText(summary);
    return replyToLine(event.replyToken, message, env.LINE_CHANNEL_ACCESS_TOKEN);
  } catch (error) {
    console.error("Failed to handle LINE command", error);
    const fallbackMessage = buildUserErrorMessage(error, todayInfo);
    return replyToLine(event.replyToken, fallbackMessage, env.LINE_CHANNEL_ACCESS_TOKEN);
  }
}

export function getRuntimeConfig(env) {
  const required = [
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_CHANNEL_SECRET",
    "GITHUB_OWNER",
    "GITHUB_REPO",
    "GITHUB_TOKEN",
  ];

  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    githubOwner: env.GITHUB_OWNER,
    githubRepo: env.GITHUB_REPO,
    githubRef: env.GITHUB_REF || "main",
    githubFilePath: env.GITHUB_FILE_PATH || "wiki/log.md",
    githubToken: env.GITHUB_TOKEN,
    timezone: env.APP_TIMEZONE || "Asia/Taipei",
    aiModel: env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct",
  };
}

export async function verifyLineSignature(bodyText, signature, channelSecret) {
  if (!signature || !channelSecret) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  const actual = arrayBufferToBase64(signed);
  return timingSafeEqual(actual, signature);
}

export function timingSafeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < left.length; i += 1) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export async function fetchGithubFile(config) {
  const encodedPath = config.githubFilePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${encodedPath}?ref=${encodeURIComponent(config.githubRef)}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubToken}`,
      "User-Agent": "llmwikiworker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 404) {
    throw new Error(`GitHub file not found: ${config.githubFilePath}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("GitHub authentication failed");
  }

  if (!response.ok) {
    throw new Error(`GitHub API failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (!payload?.content) {
    throw new Error("GitHub API returned empty file content");
  }

  const normalized = payload.content.replace(/\n/g, "");
  const bytes = Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function getTodayInfo(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  return {
    year,
    month,
    day,
    isoDate: `${year}-${pad2(month)}-${pad2(day)}`,
    displayDate: `${year}/${pad2(month)}/${pad2(day)}`,
    timezone,
  };
}

export function pad2(value) {
  return String(value).padStart(2, "0");
}

export function extractTodayLog(logContent, todayInfo) {
  const variants = buildDateVariants(todayInfo);
  const lines = logContent.split(/\r?\n/);
  const blocks = [];
  const seen = new Set();
  const genericDateLine = /^(\s{0,3}#{1,6}\s*)?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!lineMatchesVariants(line, variants)) {
      continue;
    }

    const blockLines = [line];
    let blankCount = 0;

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextLine = lines[cursor];
      const trimmed = nextLine.trim();

      if (genericDateLine.test(trimmed) && !lineMatchesVariants(nextLine, variants)) {
        break;
      }

      if (/^\s*#{1,6}\s+/.test(trimmed) && !lineMatchesVariants(nextLine, variants)) {
        break;
      }

      blockLines.push(nextLine);

      if (trimmed === "") {
        blankCount += 1;
        if (blankCount >= 2) {
          break;
        }
      } else {
        blankCount = 0;
      }
    }

    const block = blockLines.join("\n").trim();
    if (block && !seen.has(block)) {
      blocks.push(block);
      seen.add(block);
    }
  }

  if (blocks.length > 0) {
    return blocks.join("\n\n");
  }

  return extractParagraphMatches(logContent, variants);
}

export function buildDateVariants(todayInfo) {
  return [
    `${todayInfo.year}-${pad2(todayInfo.month)}-${pad2(todayInfo.day)}`,
    `${todayInfo.year}-${todayInfo.month}-${todayInfo.day}`,
    `${todayInfo.year}/${pad2(todayInfo.month)}/${pad2(todayInfo.day)}`,
    `${todayInfo.year}/${todayInfo.month}/${todayInfo.day}`,
    `${todayInfo.year}.${pad2(todayInfo.month)}.${pad2(todayInfo.day)}`,
    `${todayInfo.year}.${todayInfo.month}.${todayInfo.day}`,
    `${todayInfo.year}年${todayInfo.month}月${todayInfo.day}日`,
    `${todayInfo.year}年${pad2(todayInfo.month)}月${pad2(todayInfo.day)}日`,
  ];
}

export function lineMatchesVariants(line, variants) {
  return variants.some((variant) => line.includes(variant));
}

export function extractParagraphMatches(logContent, variants) {
  const sections = logContent.split(/\n{2,}/);
  const matches = sections.filter((section) => lineMatchesVariants(section, variants));
  return matches.join("\n\n").trim();
}

export async function summarizeTodayLog(todayLog, todayInfo, aiBinding, aiModel) {
  if (!aiBinding?.run) {
    throw new Error("Workers AI binding is not configured");
  }

  const result = await aiBinding.run(aiModel, {
    messages: [
      {
        role: "system",
        content: SUMMARY_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildSummaryUserPrompt(todayLog, todayInfo),
      },
    ],
  });

  const text = extractAiText(result);
  if (!text) {
    throw new Error("Workers AI returned an empty summary");
  }

  return text.trim();
}

export function extractAiText(result) {
  if (!result) {
    return "";
  }

  if (typeof result === "string") {
    return result;
  }

  if (typeof result.response === "string") {
    return result.response;
  }

  if (typeof result.output_text === "string") {
    return result.output_text;
  }

  if (Array.isArray(result.result?.messages)) {
    const joined = result.result.messages
      .map((message) => message?.content)
      .filter(Boolean)
      .join("\n");
    if (joined) {
      return joined;
    }
  }

  if (Array.isArray(result.choices)) {
    const joined = result.choices
      .map((choice) => choice?.message?.content || choice?.text)
      .filter(Boolean)
      .join("\n");
    if (joined) {
      return joined;
    }
  }

  return "";
}

export function clampLineText(text) {
  const normalized = text.trim();
  const maxLength = 4500;
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 14)}\n\n[內容已截斷]`;
}

export function buildUserErrorMessage(error, todayInfo) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("GitHub file not found")) {
    return "找不到閱讀紀錄檔案，請確認 GitHub 路徑設定。";
  }

  if (message.includes("GitHub authentication failed")) {
    return "目前無法讀取 GitHub 私有內容，請檢查 GitHub Token。";
  }

  if (message.includes("Workers AI")) {
    return "今天的紀錄有找到，但目前暫時無法完成整理，請稍後再試。";
  }

  if (todayInfo) {
    return `今天（${todayInfo.displayDate}）的整理暫時失敗，請稍後再試。`;
  }

  return "目前暫時無法處理這個指令，請稍後再試。";
}

export async function replyToLine(replyToken, text, channelAccessToken) {
  if (!channelAccessToken) {
    throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");
  }

  const response = await fetch(LINE_REPLY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE reply failed with status ${response.status}: ${body}`);
  }
}
