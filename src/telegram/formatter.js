import { clampChatText } from "../chat/messages.js";

export function escapeMdV2Text(text) {
    return String(text || "").replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

export function escapeMdV2Code(text) {
    return String(text || "").replace(/[`\\]/g, "\\$&");
}

export function escapeMdV2Url(url) {
    return String(url || "").replace(/[)\\]/g, "\\$&");
}

export function bold(text) {
    return `*${escapeMdV2Text(text)}*`;
}

export function bullet(text) {
    return `\\- ${escapeMdV2Text(text)}`;
}

export function labeledBullet(label, text) {
    return `\\- ${bold(label)}：${escapeMdV2Text(text)}`;
}

export function inlineCode(text) {
    return `\`${escapeMdV2Code(text)}\``;
}

export function link(text, url) {
    return `[${escapeMdV2Text(text)}](${escapeMdV2Url(url)})`;
}

export function buildTelegramMessage(text) {
    return escapeMdV2Text(clampChatText(text));
}
