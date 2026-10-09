-- ===========================================================================
-- Files in conversations: what the booking-docs bucket must accept.
--
-- The bucket was made by hand in the dashboard, so its limits are whatever was
-- chosen then. The desk now keeps more than papers and photos in it:
--
--   <customer>/chat-media/   voice notes, videos and stickers customers send,
--                            and Office files the bot will not read (up to 16 MB)
--   <customer>/outbound/     papers and photos the desk sends (up to 50 MB)
--   thumbs/                  640 px copies of big photos, for the chat
--
-- If the bucket restricts file types, the types those need are added; if it
-- restricts size below 50 MB, the limit is raised to 50 MB. A bucket with no
-- restriction is left alone, and nothing is ever narrowed. Safe to run twice.
-- No table changes: chat_messages.payload carries where each file is, and an
-- MKY document is a booking_documents row with doc_type 'mky' (doc_type has no
-- check constraint).
--
-- A Postgres without Supabase's storage schema (the PGlite the tests apply
-- every migration to) has no bucket to change: the block stops before naming
-- storage.buckets, which PL/pgSQL would otherwise fail to plan.
-- ===========================================================================

do $do$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;
  if exists (select 1 from storage.buckets where id = 'booking-docs') then
    update storage.buckets
       set allowed_mime_types = (
         select array_agg(distinct t) from unnest(allowed_mime_types || array[
           'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
           'application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'application/vnd.ms-excel',
           'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
           'application/vnd.ms-powerpoint',
           'application/vnd.openxmlformats-officedocument.presentationml.presentation',
           'text/plain', 'text/csv',
           'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/opus', 'audio/wav',
           'video/mp4', 'video/3gpp', 'video/quicktime', 'video/webm'
         ]) as t
       )
     where id = 'booking-docs' and allowed_mime_types is not null;

    update storage.buckets
       set file_size_limit = 52428800
     where id = 'booking-docs' and file_size_limit is not null and file_size_limit < 52428800;
  end if;
end
$do$;
