# Geleias da Beca

Painel de gestão de vendas, compras de insumos e metas, em `geleias.familiawerner.org`.

## Como funciona

- `public/index.html`: o painel (HTML, CSS e JS em um arquivo só).
- `public/db-shim.js`: camada de dados do navegador. Fala com a API e atualiza a cada 8 s.
- `src/worker.js`: API no Cloudflare Workers. Guarda tudo no banco D1 `geleias-da-beca` (tabela `docs`, ver `schema.sql`).
- `wrangler.jsonc`: configuração do Cloudflare (domínio, banco, variáveis).

A API só responde a quem passou pelo Cloudflare Access. Enquanto `TEAM_DOMAIN` e `POLICY_AUD` estiverem vazios em `wrangler.jsonc`, ela devolve 503.

## Publicação

Cada commit na branch `main` é publicado sozinho pelo Cloudflare (Workers Builds). Não há passo manual.

## Dados

- `lancamentos/<id>`: vendas (`tipo: "venda"`) e compras de insumo (`tipo: "gasto"`).
- `config/metas`: metas editadas (vendas em R$ e potes por sabor).
- `config/categorias`: sabores, insumos (com unidade) e canais de venda.
