//! Queued follow-up payload.
//!
//! The public TUI preview still looks like `Vec<String>`, but a queued user
//! prompt can carry pasted/attached images. Those used to live only on
//! `pending_images` / `PreparedInput` and were dropped the moment a turn was
//! queued or a follow-up was dequeued (`begin_remote_send(..., vec![], ...)`).
//! Keep the string surface for poke/preview/debug code and store attachments
//! next to the text.

use serde::{Deserialize, Serialize};

pub(super) type QueuedImage = (String, String);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct QueuedMessage {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<QueuedImage>,
}

impl QueuedMessage {
    pub(super) fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            images: Vec::new(),
        }
    }

    pub(super) fn with_images(text: impl Into<String>, images: Vec<QueuedImage>) -> Self {
        Self {
            text: text.into(),
            images,
        }
    }

    pub(super) fn from_prepared(prepared: super::input::PreparedInput) -> Self {
        Self::with_images(prepared.expanded, prepared.images)
    }

    pub(super) fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.images.is_empty()
    }

    pub(super) fn as_str(&self) -> &str {
        &self.text
    }
}

impl From<String> for QueuedMessage {
    fn from(text: String) -> Self {
        Self::text(text)
    }
}

impl From<&str> for QueuedMessage {
    fn from(text: &str) -> Self {
        Self::text(text)
    }
}

impl AsRef<str> for QueuedMessage {
    fn as_ref(&self) -> &str {
        &self.text
    }
}

impl std::ops::Deref for QueuedMessage {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.text
    }
}

/// Combine dequeued follow-ups into one remote/local send payload.
///
/// Text is joined the same way the old `Vec<String>` path did. Images from every
/// item are concatenated so a queued paste is not dropped just because another
/// poke/reminder sat next to it.
pub(super) fn combine_queued_user_payload(
    messages: &[QueuedMessage],
) -> (String, Vec<QueuedImage>) {
    let combined = messages
        .iter()
        .map(|message| message.text.as_str())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let images = messages
        .iter()
        .flat_map(|message| message.images.iter().cloned())
        .collect();
    (combined, images)
}

pub(super) fn queued_preview_texts(messages: &[QueuedMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|message| message.text.clone())
        .collect()
}

pub(super) fn queued_capacity_bytes(messages: &[QueuedMessage]) -> usize {
    messages
        .iter()
        .map(|message| {
            message.text.capacity()
                + message
                    .images
                    .iter()
                    .map(|(media_type, data)| media_type.capacity() + data.capacity())
                    .sum::<usize>()
        })
        .sum()
}

pub(super) fn parse_queued_messages_json(value: &serde_json::Value) -> Vec<QueuedMessage> {
    match value.as_array() {
        Some(items) => items.iter().filter_map(parse_queued_message_json).collect(),
        None => Vec::new(),
    }
}

fn parse_queued_image_json(image: &serde_json::Value) -> Option<QueuedImage> {
    if let Some(pair) = image.as_array() {
        if pair.len() != 2 {
            return None;
        }
        return Some((pair[0].as_str()?.to_string(), pair[1].as_str()?.to_string()));
    }
    Some((
        image.get("media_type")?.as_str()?.to_string(),
        image.get("data")?.as_str()?.to_string(),
    ))
}

fn parse_queued_message_json(item: &serde_json::Value) -> Option<QueuedMessage> {
    if let Some(text) = item.as_str() {
        return Some(QueuedMessage::text(text));
    }
    let object = item.as_object()?;
    let text = object
        .get("text")
        .or_else(|| object.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let images: Vec<QueuedImage> = object
        .get("images")
        .and_then(|value| value.as_array())
        .map(|items| items.iter().filter_map(parse_queued_image_json).collect())
        .unwrap_or_else(Vec::new);
    if text.is_empty() && images.is_empty() {
        None
    } else {
        Some(QueuedMessage { text, images })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combine_queued_user_payload_keeps_images_from_every_item() {
        let messages = vec![
            QueuedMessage::with_images(
                "look at this".to_string(),
                vec![("image/png".to_string(), "aaa".to_string())],
            ),
            QueuedMessage::text("and this"),
            QueuedMessage::with_images(
                String::new(),
                vec![("image/jpeg".to_string(), "bbb".to_string())],
            ),
        ];
        let (text, images) = combine_queued_user_payload(&messages);
        assert_eq!(text, "look at this\n\nand this");
        assert_eq!(
            images,
            vec![
                ("image/png".to_string(), "aaa".to_string()),
                ("image/jpeg".to_string(), "bbb".to_string()),
            ]
        );
    }

    #[test]
    fn parse_queued_messages_json_accepts_legacy_strings_and_objects() {
        let value = serde_json::json!([
            "plain text",
            {
                "text": "with image",
                "images": [{"media_type": "image/png", "data": "abc"}]
            }
        ]);
        let parsed = parse_queued_messages_json(&value);
        assert_eq!(parsed[0], QueuedMessage::text("plain text"));
        assert_eq!(
            parsed[1],
            QueuedMessage::with_images(
                "with image".to_string(),
                vec![("image/png".to_string(), "abc".to_string())]
            )
        );
    }
}
