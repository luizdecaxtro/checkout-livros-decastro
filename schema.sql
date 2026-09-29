CREATE TABLE IF NOT EXISTS livros (id TEXT PRIMARY KEY, titulo TEXT NOT NULL, preco_centavos INTEGER NOT NULL, preco_promocional_centavos INTEGER, codigo TEXT NOT NULL, link_leitura TEXT, capa_url TEXT, ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS pedidos (order_nsu TEXT PRIMARY KEY, livro_id TEXT NOT NULL, nome TEXT NOT NULL, email TEXT NOT NULL, telefone TEXT, valor_centavos INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pendente', transaction_nsu TEXT, invoice_slug TEXT, capture_method TEXT, receipt_url TEXT, email_enviado INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT (datetime('now')), pago_em TEXT);
CREATE INDEX IF NOT EXISTS idx_pedidos_email ON pedidos(email);
CREATE TABLE IF NOT EXISTS capas (livro_id TEXT PRIMARY KEY, mime TEXT NOT NULL, dados TEXT NOT NULL, atualizado_em TEXT NOT NULL DEFAULT (datetime('now')));

