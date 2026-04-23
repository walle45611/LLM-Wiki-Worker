import { FormattedString } from "@grammyjs/parse-mode";

export function renderTelegramMessage(payload) {
    const blocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
    if (blocks.length === 0) {
        throw new Error("Telegram payload blocks are empty");
    }

    const renderedBlocks = blocks.map(renderBlock);
    const formatted = FormattedString.join(renderedBlocks, "\n\n");
    return {
        text: formatted.text,
        entities: formatted.entities,
    };
}

export function renderTelegramMessageAsPlainText(payload) {
    const blocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
    return blocks.map(renderBlockAsPlainText).filter(Boolean).join("\n\n").trim();
}

function renderBlock(block) {
    switch (block.type) {
        case "heading":
            return FormattedString.bold(block.text);
        case "paragraph":
            return new FormattedString(block.text);
        case "bullet_list": {
            const lines = block.items.map((item) => {
                if (item.label) {
                    return FormattedString.join(
                        ["• ", FormattedString.bold(item.label), `：${item.text}`],
                        "",
                    );
                }
                return new FormattedString(`• ${item.text}`);
            });
            return FormattedString.join(lines, "\n");
        }
        case "quote":
            return FormattedString.blockquote(block.text);
        case "code_block":
            return FormattedString.pre(block.text, block.language);
        case "link":
            return FormattedString.link(block.text, block.url);
        default:
            throw new Error(`Unsupported block type: ${String(block?.type || "")}`);
    }
}

function renderBlockAsPlainText(block) {
    switch (block.type) {
        case "heading":
        case "paragraph":
        case "quote":
            return block.text;
        case "bullet_list":
            return block.items
                .map((item) =>
                    item.label ? `• ${item.label}：${item.text}` : `• ${item.text}`,
                )
                .join("\n");
        case "code_block":
            return block.language
                ? `\`\`\`${block.language}\n${block.text}\n\`\`\``
                : `\`\`\`\n${block.text}\n\`\`\``;
        case "link":
            return `${block.text} (${block.url})`;
        default:
            return "";
    }
}
