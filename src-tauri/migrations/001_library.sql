CREATE TABLE sound_effects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 path TEXT NOT NULL UNIQUE, hash TEXT NOT NULL UNIQUE CHECK(length(hash)=64),
 duration_ms INTEGER NOT NULL CHECK(duration_ms>0), format TEXT NOT NULL CHECK(format IN ('wav','mp3','ogg','flac')),
 sample_rate INTEGER NOT NULL CHECK(sample_rate BETWEEN 8000 AND 192000), channels INTEGER NOT NULL CHECK(channels BETWEEN 1 AND 2),
 byte_size INTEGER NOT NULL CHECK(byte_size>0), default_volume REAL NOT NULL DEFAULT 0.5 CHECK(default_volume BETWEEN 0 AND 1)
);
CREATE TABLE sound_banks (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60), position INTEGER NOT NULL UNIQUE CHECK(position>=0));
CREATE TABLE categories (name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 80));
CREATE TABLE diagnostic_volumes (
 effect_id TEXT PRIMARY KEY CHECK(effect_id IN ('native-test-chime','native-test-pulse','native-test-low')),
 volume REAL NOT NULL CHECK(volume BETWEEN 0 AND 1)
);
CREATE TABLE bank_effects (
 id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES sound_banks(id) ON DELETE CASCADE,
 effect_id TEXT REFERENCES sound_effects(id), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 color TEXT NOT NULL CHECK(color IN ('amber','coral','mint','sky','violet','slate')),
 category TEXT REFERENCES categories(name), position INTEGER NOT NULL CHECK(position>=0), UNIQUE(bank_id,position)
);
CREATE TABLE app_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), board_revision INTEGER NOT NULL DEFAULT 0 CHECK(board_revision>=0),
 active_bank_id TEXT NOT NULL REFERENCES sound_banks(id) DEFERRABLE INITIALLY DEFERRED,
 columns TEXT NOT NULL DEFAULT 'auto' CHECK(columns IN ('auto','3','4','6')),
 master_volume REAL NOT NULL DEFAULT 0.7 CHECK(master_volume BETWEEN 0 AND 1),
 max_concurrent_playbacks INTEGER NOT NULL DEFAULT 16 CHECK(max_concurrent_playbacks BETWEEN 1 AND 64),
 preferred_device_name TEXT
);
INSERT INTO sound_banks VALUES ('principal','Principal',0);
INSERT INTO app_settings(id,active_bank_id) VALUES (1,'principal');
PRAGMA user_version=1;
