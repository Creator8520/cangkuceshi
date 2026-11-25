CREATE TABLE IF NOT EXISTS app_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO app_meta (id, revision) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS app_docs (
  collection TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (collection, doc_key)
);

CREATE INDEX IF NOT EXISTS idx_app_docs_collection ON app_docs(collection);
CREATE INDEX IF NOT EXISTS idx_sales_client_time
  ON app_docs(collection, json_extract(payload, '$.client'), json_extract(payload, '$.sale.created_at'));

CREATE TABLE IF NOT EXISTS sync_locks (
  store_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
