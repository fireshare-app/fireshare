## Notifications

Fireshare supports notifications when a new video is uploaded, with two integration options: **Discord** and a **Generic Webhook**.

---

### Discord

Since gaming and Discord go hand-in-hand, Fireshare includes a dedicated Discord integration. When a new video is uploaded, it will automatically send a notification to the Discord channel of your choice.

**Setup:** Add the webhook URL for the Discord channel you want notifications sent to.

> Don't have a webhook URL yet? Learn how to create one here: [Discord — Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)

**Docker ENV example:**
```
DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz'
```

---

### Generic Webhook

For any notification service that supports HTTP POST requests with a JSON payload, you can use the Generic Webhook integration. This allows Fireshare to send notifications to virtually any platform that supports webhooks.

**Setup:** You will need to provide two things:
1. The **POST URL** for your service's webhook endpoint
2. A **JSON payload** formatted for your specific service

Enter valid JSON into the "Generic Webhook JSON Payload" field on the Integrations page. Consult your service's webhook documentation to find the correct payload format.

**Example payload:**
```json
{
    "Title": "Fireshare",
    "message": "New Video Uploaded to Fireshare"
}
```

#### Including a Link to the Video

You can include a direct link to the newly uploaded video in your notification by using the `[[video_url]]` placeholder anywhere in your JSON payload.

**Example payload with video link:**
```json
{
    "Title": "Fireshare",
    "message": "New Video Uploaded to Fireshare [[video_url]]"
}
```

**What Fireshare will send to your service:**
```json
{
    "Title": "Fireshare",
    "message": "New Video Uploaded to Fireshare https://yourdomain.com/w/c415d34530d15b2892fa4a4e037b6c05"
}
```

#### A Note on Quote Syntax

JSON payloads use key/value pairs where strings are wrapped in quotes. Keep the following in mind:

- **GUI:** If you are pasting the payload through the Fireshare UI, just choose either single `'` or double `"` quotes for your strings — Fireshare will handle the rest.
- **Docker ENV:** You must use one type of quote to wrap the entire value, and the other type for the internal JSON strings.

**Docker ENV example:**
```
GENERIC_WEBHOOK_PAYLOAD='{"Title": "Fireshare", "message": "New Video Uploaded to Fireshare [[video_url]]"}'
# Note: this must be a single line
```

**Full Docker ENV example:**
```
GENERIC_WEBHOOK_URL='https://webhook.com/at/endpoint12345'
GENERIC_WEBHOOK_PAYLOAD='{"Title": "Fireshare", "message": "New Video Uploaded to Fireshare [[video_url]]"}'
# Both ENV variables must be set for the Generic Webhook to work
```
