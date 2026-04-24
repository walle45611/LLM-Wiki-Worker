import test from "node:test";
import assert from "node:assert/strict";

import { sendTelegramMessage } from "../src/telegram/client.js";
import { createJsonResponse } from "../testing/helpers.js";

test("sendTelegramMessage falls back to plain text when entities parsing fails", async () => {
    const requests = [];

    const customFetch = async (input, init = {}) => {
        requests.push({
            url: String(input),
            body: init.body ? JSON.parse(String(init.body)) : null,
        });

        if (requests.length === 1) {
            return createJsonResponse(
                {
                    ok: false,
                    error_code: 400,
                    description:
                        "Bad Request: can't parse entities: Character '-' is reserved and must be escaped with the preceding '\\'",
                },
                400,
            );
        }

        return createJsonResponse({
            ok: true,
            result: {
                message_id: 123,
            },
        });
    };

    await sendTelegramMessage(
        "123456789",
        {
            blocks: [{ type: "heading", text: "MicroK8s summary" }],
        },
        "telegram-token",
        { fetch: customFetch },
    );

    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /sendMessage$/);
    assert.equal(requests[0].body.text, "MicroK8s summary");
    assert.equal(Array.isArray(requests[0].body.entities), true);
    assert.equal(requests[0].body.entities[0].type, "bold");
    assert.equal(requests[1].body.text, "MicroK8s summary");
    assert.equal("entities" in requests[1].body, false);
});
