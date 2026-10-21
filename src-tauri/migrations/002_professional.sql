ALTER TABLE bank_effects ADD COLUMN looped INTEGER NOT NULL DEFAULT 0 CHECK(looped IN (0,1));
ALTER TABLE bank_effects ADD COLUMN fade_in_ms INTEGER NOT NULL DEFAULT 0 CHECK(fade_in_ms BETWEEN 0 AND 30000);
ALTER TABLE bank_effects ADD COLUMN fade_out_ms INTEGER NOT NULL DEFAULT 0 CHECK(fade_out_ms BETWEEN 0 AND 30000);
CREATE TABLE keyboard_shortcuts (
 id TEXT PRIMARY KEY,
 scope_bank_id TEXT REFERENCES sound_banks(id),
 button_id TEXT REFERENCES bank_effects(id),
 bank_id TEXT REFERENCES sound_banks(id),
 binding TEXT NOT NULL
);
PRAGMA user_version=2;
