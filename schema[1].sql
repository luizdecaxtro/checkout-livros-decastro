-- Tabela de livros à venda (você cadastra os códigos aqui, pelo painel da Cloudflare)
CREATE TABLE IF NOT EXISTS livros (
  id              TEXT PRIMARY KEY,        -- identificador curto, ex.: 'espiritos'
  titulo          TEXT NOT NULL,
  preco_centavos  INTEGER NOT NULL,        -- R$ 2,00 = 200
  codigo          TEXT NOT NULL,           -- código de acesso enviado ao comprador
  link_leitura    TEXT,                    -- página do leitor no seu site
  capa_url        TEXT,                    -- imagem da capa (opcional)
  ativo           INTEGER NOT NULL DEFAULT 1
);

-- Pedidos: um por tentativa de compra
CREATE TABLE IF NOT EXISTS pedidos (
  order_nsu        TEXT PRIMARY KEY,
  livro_id         TEXT NOT NULL,
  nome             TEXT NOT NULL,
  email            TEXT NOT NULL,
  telefone         TEXT,
  valor_centavos   INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pendente',   -- pendente | pago
  transaction_nsu  TEXT,
  invoice_slug     TEXT,
  capture_method   TEXT,
  receipt_url      TEXT,
  email_enviado    INTEGER NOT NULL DEFAULT 0,
  criado_em        TEXT NOT NULL DEFAULT (datetime('now')),
  pago_em          TEXT
);

CREATE INDEX IF NOT EXISTS idx_pedidos_email ON pedidos(email);

-- Livro de teste. TROQUE 'SEU-CODIGO-AQUI' pelo código real do Espíritos
-- e ajuste o link_leitura para a página do leitor no seu site.
INSERT OR REPLACE INTO livros (id, titulo, preco_centavos, codigo, link_leitura, capa_url, ativo)
VALUES (
  'espiritos',
  'Espíritos – Um mundo desconhecido',
  200,
  'SEU-CODIGO-AQUI',
  'https://www.lojasdecastro.com.br/',
  NULL,
  1
);
