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

### Waiting for Transcodes

By default a notification goes out as soon as a new video is added, while its lower qualities (1080p, 720p, 480p) may still be transcoding. Anyone who opens the link straight away then plays the full-size original.

Turn on **Wait for transcodes to finish** on the Integrations page to hold each notification until that video's transcodes are done. It applies to both the Discord and the Generic Webhook, and only takes effect when transcoding is enabled (`ENABLE_TRANSCODING=true`) and **Automatically transcode new videos** is on. Otherwise there is nothing to wait for and notifications go out right away.

If a transcode fails, the notification is still sent once Fireshare has finished trying that video.

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

#### Placeholders

You can include details of the new video in your notification with placeholders. Put them anywhere inside a string in your JSON payload, wrapped in double square brackets, and Fireshare replaces each one with the video's value before sending.

| Placeholder | Replaced with |
| --- | --- |
| `[[video_url]]` | A direct link to the video |
| `[[video_title]]` | The video's title |
| `[[video_description]]` | The video's description |
| `[[uploader_name]]` | The display name of the user who uploaded the video, or their username if they have no display name |
| `[[game_name]]` | The game the video is linked to |
| `[[tags]]` | The video's tags, separated by commas |

A placeholder with no value for the video, such as a video with no game or no description yet, is replaced with an empty string. Quotes and other special characters in the values are escaped, so they won't break your JSON.

Videos found by a library scan are credited to the admin account, so `[[uploader_name]]` is that admin's name.

**Example payload with placeholders:**
```json
{
    "Title": "[[video_title]]",
    "message": "[[uploader_name]] uploaded a new [[game_name]] clip: [[video_url]]",
    "tags": "[[tags]]"
}
```

**What Fireshare will send to your service:**
```json
{
    "Title": "That \"impossible\" flank",
    "message": "Shane uploaded a new Apex Legends clip: https://yourdomain.com/w/c415d34530d15b2892fa4a4e037b6c05",
    "tags": "Clutch, Funny"
}
```

The **Test Webhook** button on the Integrations page fills the placeholders with sample values, so you can check how your payload looks before a real video goes out.

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
