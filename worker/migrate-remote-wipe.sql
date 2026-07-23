-- Remote-wipe of a linked device (seized-device / hostile-actor threat model).
-- Additive + nullable (old cached engines never break). Run once via the d1-migrate Action.
--   wipe_state: NULL (normal) | 'requested' (researcher asked; device wipes on next poll) | 'confirmed'
--               (device acked it began the wipe). A 'requested' row keeps revoked=0 so the seized
--               device can still authenticate + RECEIVE the wipe; 'confirmed' sets revoked=1.
--   wipe_at:    when the wipe was requested (for the panel's "pending Nm" + an optional future TTL sweep).
--   wipe_hidden: force-removed from the panel but the directive stays ARMED (keep-armed force-remove) —
--               the row lingers (hidden) so a device that reconnects months later still wipes.
ALTER TABLE install ADD COLUMN wipe_state  TEXT;
ALTER TABLE install ADD COLUMN wipe_at     INTEGER;
ALTER TABLE install ADD COLUMN wipe_hidden INTEGER NOT NULL DEFAULT 0;
