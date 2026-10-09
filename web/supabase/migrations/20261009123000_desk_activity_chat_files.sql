-- ===========================================================================
-- desk_activity: a paper moves its conversation too
--
-- 20261009120000_desk_activity.sql gave each conversation a version
-- (chat:<channel>:<chat id>), moved by its messages, its session, its
-- customer, its bookings and call-backs. A conversation now also shows the
-- files in it (lib/admin/desk-media.js): each file message is drawn with the
-- paper it became - "Still being read", "Checked by Sara", "Set aside",
-- "A newer copy came later", "Removed from the case" - read from
-- booking_documents on every load of the conversation. Those papers moved
-- only their booking, so an open conversation answered "not modified" over a
-- paper the bot had just finished reading, or one a colleague had checked,
-- until something else happened in the chat.
--
-- So a booking_documents row now moves, besides the bookings area and its
-- booking, the conversation it came from (its chat_id). An MKY document - a
-- paper the desk sent the customer and filed on their booking - is stored
-- with no chat on purpose (the bot must never count it among the customer's
-- papers), and the conversation shows it by the message that sent it; it
-- moves its booking's conversation, looked up by reference (a unique index,
-- one row, and only for those papers).
--
-- Nothing else changes: the same function, with that one branch, replacing
-- the one 20261009120000 made. Safe to run twice; the desk works before and
-- after it (an open conversation is asked for again at least every two
-- minutes regardless).
-- ===========================================================================

create or replace function desk_activity_keys(p_table text, p jsonb)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $func$
declare
  keys text[];
  ref text;
begin
  case p_table
    when 'bookings' then
      keys := array['bookings', 'booking:' || (p->>'booking_ref'), desk_chat_key(p->>'channel', p->>'chat_id')];
    when 'booking_documents' then
      -- The conversation shows each paper beside the message that brought it.
      ref := desk_chat_key(p->>'channel', p->>'chat_id');
      -- One of ours, filed with no chat: the conversation it was sent from is its booking's.
      if ref is null and p->>'doc_type' = 'mky' and p->>'booking_ref' is not null then
        select desk_chat_key(b.channel, b.chat_id) into ref from bookings b where b.booking_ref = p->>'booking_ref';
      end if;
      keys := array['bookings', 'booking:' || (p->>'booking_ref'), ref];
    when 'mrn_requests' then
      keys := array['bookings', 'mrn:' || (p->>'request_ref'), 'booking:' || (p->>'booking_ref')];
    when 'support_tickets' then
      keys := array['requests', 'request:' || (p->>'ticket_ref'), desk_chat_key(p->>'channel', p->>'chat_id')];
    when 'notification_outbox' then
      keys := array['outbox', case p->>'entity_type'
        when 'booking' then 'booking:' || (p->>'entity_id')
        when 'support_ticket' then 'request:' || (p->>'entity_id')
        when 'shipment' then 'shipment:' || (p->>'entity_id')
      end];
    when 'chat_messages' then
      keys := array['messages', desk_chat_key(p->>'channel', p->>'chat_id'),
        case when p->>'status' = 'failed' then 'problems' end];
    when 'conversation_sessions' then
      -- Where the customer is with the bot, and the WhatsApp window: shown on
      -- their conversation only.
      keys := array[desk_chat_key(p->>'channel', p->>'chat_id')];
    when 'audit_logs' then
      keys := array['history'];
      case p->>'entity_type'
        when 'problem' then
          keys := keys || 'problems'::text;
          -- A failed message sent again or set aside changes its conversation
          -- (the Retry button); a whole chat set aside is named by its key.
          if p->>'entity_id' like 'chat:%' then
            keys := keys || (p->>'entity_id');
          elsif p->>'entity_id' ~ '^message:[0-9]{1,18}$' then
            select desk_chat_key(m.channel, m.chat_id) into ref from chat_messages m
             where m.id = substr(p->>'entity_id', 9)::bigint;
            keys := keys || ref;
          end if;
        when 'booking' then
          keys := keys || ('booking:' || (p->>'entity_id'));
        when 'booking_document' then
          ref := p->'metadata'->>'booking_ref';
          if ref is null and p->>'entity_id' ~ '^[0-9]{1,18}$' then
            select d.booking_ref into ref from booking_documents d where d.id = (p->>'entity_id')::bigint;
          end if;
          keys := keys || ('booking:' || ref);
        when 'mrn_request' then
          ref := p->'metadata'->>'booking_ref';
          if ref is null then
            select m.booking_ref into ref from mrn_requests m where m.request_ref = p->>'entity_id';
          end if;
          keys := keys || ('mrn:' || (p->>'entity_id')) || ('booking:' || ref);
        when 'support_ticket' then
          keys := keys || ('request:' || (p->>'entity_id'));
        when 'shipment' then
          keys := keys || ('shipment:' || (p->>'entity_id'));
        else
          null;
      end case;
    when 'internal_notes' then
      keys := array['history', case
        when p->>'booking_ref' is not null then 'booking:' || (p->>'booking_ref')
        when p->>'entity_type' = 'support_ticket' then 'request:' || (p->>'entity_id')
        when p->>'entity_type' = 'mrn_request' then 'mrn:' || (p->>'entity_id')
      end];
    when 'clients' then
      keys := array['customers',
        desk_chat_key('whatsapp', 'wa:' || (p->>'whatsapp_id')),
        desk_chat_key('telegram', p->>'telegram_chat_id')];
    when 'shipments' then
      keys := array['shipments', 'shipment:' || (p->>'shipment_id'), 'booking:' || (p->>'booking_ref')];
    when 'shipment_events' then
      keys := array['shipments', 'shipment:' || (p->>'shipment_id')];
    when 'ops_users', 'bot_settings' then
      keys := array['team'];
    else
      keys := '{}';
  end case;
  return keys;
end
$func$;

revoke execute on function desk_activity_keys(text, jsonb) from anon, authenticated;
