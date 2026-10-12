-- ---------------------------------------------------------------------------
-- Each person on the desk gets their own sign-in.
--
-- Until now everybody typed the same ADMIN_SECRET and whatever name they liked:
-- the name was attribution, not identity, so anyone holding the secret could
-- sign a decision with a colleague's name. This gives every row in ops_users a
-- username and a password of its own, so the desk knows who is actually there.
--
-- The password is never stored. password_hash holds a scrypt digest with its
-- own salt (lib/admin/desk-auth.js); password_set_at is both "when" and the
-- token version - changing a password ends that person's open sessions,
-- because the signed token carries the timestamp it was issued against.
--
-- Rows that existed before this migration have no username and no password.
-- They keep working: the desk derives a username from the name and accepts the
-- ADMIN_SECRET until an administrator sets a password for them.
-- ---------------------------------------------------------------------------

alter table ops_users add column if not exists username        text;
alter table ops_users add column if not exists password_hash   text;
alter table ops_users add column if not exists password_set_at timestamptz;

-- The sign-in name is unique whatever its capitalisation, as the display name
-- already is. A null username is "not chosen yet", and several are allowed.
create unique index if not exists ops_users_username_idx
  on ops_users (lower(username)) where username is not null;

-- Existing people get the obvious username: their name, lowercased, with
-- anything that is not a letter or digit turned into a dot and the dots at
-- either end taken off. "Ariful Islam" -> "ariful.islam", the same rule
-- lib/admin/desk-auth.js applies to what is typed into the box.
--
-- Only where it is long enough to type, only where nobody has that username
-- already, and only one person per candidate: "Ali Hassan" and "ali-hassan"
-- both want "ali.hassan", the unique index would refuse the pair, and the
-- statement would fail rather than settle it. The one with the lower id gets
-- it; an administrator gives the other one a username in Settings.
with wanted as (
  select id,
         regexp_replace(regexp_replace(lower(trim(name)), '[^a-z0-9]+', '.', 'g'), '^\.+|\.+$', '', 'g') as value
    from ops_users
   where username is null
), ranked as (
  select id, value, row_number() over (partition by value order by id) as rank from wanted
)
update ops_users u
   set username = r.value
  from ranked r
 where u.id = r.id
   and r.rank = 1
   and u.username is null
   and length(r.value) >= 2
   and not exists (select 1 from ops_users o where lower(o.username) = r.value);
