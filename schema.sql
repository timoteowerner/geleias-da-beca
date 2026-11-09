-- Esquema do banco D1 "geleias-da-beca" (já aplicado). Guardado aqui como registro.
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs (collection, updated_at);
