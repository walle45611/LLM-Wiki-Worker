export function buildIntentRouterResponseFormat() {
    return {
        type: "json_schema",
        json_schema: {
            name: "rule_router",
            strict: true,
            schema: {
                type: "object",
                properties: {
                    rule: {
                        type: "string",
                        enum: ["B", "D"],
                    },
                    date: {
                        type: "string",
                        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
                    },
                },
                required: ["rule"],
                additionalProperties: false,
            },
        },
    };
}

export function buildSummaryLookupResponseFormat() {
    return {
        type: "json_schema",
        json_schema: {
            name: "summary_lookup_decision",
            strict: true,
            schema: {
                type: "object",
                properties: {
                    intent: {
                        type: "string",
                        enum: ["summary_lookup", "unsupported"],
                    },
                    path: { type: "string" },
                },
                required: ["intent"],
                additionalProperties: false,
            },
        },
    };
}

export function buildSummaryReplyResponseFormat() {
    return {
        type: "json_schema",
        json_schema: {
            name: "line_summary_reply",
            strict: true,
            schema: {
                type: "object",
                properties: {
                    reply: { type: "string", minLength: 1 },
                },
                required: ["reply"],
                additionalProperties: false,
            },
        },
    };
}
