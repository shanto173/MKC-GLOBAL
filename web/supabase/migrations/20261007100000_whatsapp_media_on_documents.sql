-- ===========================================================================
-- Which WhatsApp file a stored document came from.
--
-- A file a client sends on WhatsApp arrives as a media id (new every time it is
-- sent) and the sha256 of its bytes (the same every time). The hash is how a
-- re-sent paper is recognised as the same document - Telegram's
-- file_unique_id does that job for Telegram - and the media id is what Meta
-- would need to fetch it again within its 30 days.
--
-- Additive and idempotent, like every migration before it. The code writes
-- these columns only once they exist, so it is safe to deploy first.
-- ===========================================================================

alter table booking_documents add column if not exists whatsapp_media_id     text;
alter table booking_documents add column if not exists whatsapp_media_sha256 text;

create index if not exists booking_documents_whatsapp_hash_idx
  on booking_documents (chat_id, whatsapp_media_sha256)
  where whatsapp_media_sha256 is not null;
