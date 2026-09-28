// Checkout de livros DeCastro — Cloudflare Worker + D1 + InfinitePay + EmailJS
//
// Rotas:
//   GET  /comprar?livro=espiritos   página com o formulário (nome, e-mail, telefone)
//   POST /api/pedido                cria o pedido e o link de pagamento na InfinitePay
//   GET  /obrigado                  página de retorno; confere o pagamento e mostra o código
//   POST /webhook                   aviso da InfinitePay; confere o pagamento e envia o e-mail
//
// Segurança: nenhum aviso de pagamento é aceito sem confirmação direta com a
// InfinitePay (payment_check). Assim ninguém consegue "fingir" um pagamento.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/comprar") return paginaComprar(url, env);
      if (request.method === "POST" && url.pathname === "/api/pedido") return criarPedido(request, url, env);
      if (request.method === "GET" && url.pathname === "/obrigado") return paginaObrigado(url, env);
      if (request.method === "POST" && url.pathname === "/webhook") return receberWebhook(request, env);
      return html(pagina("Página não encontrada", `<p class="aviso">Este endereço não existe.</p>`), 404);
    } catch (err) {
      console.error("Erro geral:", err);
      return html(pagina("Algo falhou", `<p class="aviso">Não foi possível concluir agora. Tente de novo em instantes ou fale com a loja.</p>`), 500);
    }
  },
};

// ---------------------------------------------------------------- InfinitePay

function apiBase(env) {
  return (env.INFINITEPAY_API || "https://api.checkout.infinitepay.io").replace(/\/$/, "");
}

async function gerarLink(env, origem, livro, pedido) {
  const base = {
    handle: env.INFINITEPAY_HANDLE,
    order_nsu: pedido.order_nsu,
    redirect_url: `${origem}/obrigado`,
    webhook_url: `${origem}/webhook`,
    items: [{ quantity: 1, price: livro.preco_centavos, description: livro.titulo }],
  };

  const customer = { name: pedido.nome, email: pedido.email };
  if (pedido.telefone) customer.phone_number = pedido.telefone;

  // 1ª tentativa: com os dados do cliente (checkout já preenchido)
  let resp = await postJSON(`${apiBase(env)}/links`, { ...base, customer });
  // Se a InfinitePay recusar os dados do cliente, tenta sem eles para não perder a venda
  if (!resp.ok) {
    console.warn("Link com customer recusado:", resp.status, resp.texto);
    resp = await postJSON(`${apiBase(env)}/links`, base);
  }
  if (!resp.ok) throw new Error(`InfinitePay /links ${resp.status}: ${resp.texto}`);

  const link = resp.dados?.url || resp.dados?.link;
  if (!link) throw new Error(`Resposta sem link: ${resp.texto}`);
  return link;
}

async function conferirPagamento(env, { order_nsu, transaction_nsu, slug }) {
  if (!order_nsu || !transaction_nsu || !slug) return { paid: false };
  const resp = await postJSON(`${apiBase(env)}/payment_check`, {
    handle: env.INFINITEPAY_HANDLE,
    order_nsu,
    transaction_nsu,
    slug,
  });
  if (!resp.ok) {
    console.warn("payment_check falhou:", resp.status, resp.texto);
    return { paid: false };
  }
  return resp.dados || { paid: false };
}

async function postJSON(endpoint, corpo, headers = {}) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(corpo),
  });
  const texto = await r.text();
  let dados = null;
  try { dados = JSON.parse(texto); } catch (_) {}
  return { ok: r.ok, status: r.status, texto, dados };
}

// ------------------------------------------------------------ Regras do pedido

async function buscarLivro(env, id) {
  return env.DB.prepare("SELECT * FROM livros WHERE id = ? AND ativo = 1").bind(id).first();
}

async function buscarPedido(env, order_nsu) {
  return env.DB.prepare("SELECT * FROM pedidos WHERE order_nsu = ?").bind(order_nsu).first();
}

// Marca como pago (uma única vez) e envia o e-mail. Seguro chamar várias vezes.
async function confirmarPedido(env, pedido, livro, info) {
  const valorPago = Number(info.amount ?? info.paid_amount ?? 0);
  if (valorPago && valorPago < livro.preco_centavos) {
    console.warn("Valor pago menor que o preço:", pedido.order_nsu, valorPago);
    return false;
  }

  await env.DB.prepare(
    `UPDATE pedidos SET status = 'pago', pago_em = COALESCE(pago_em, datetime('now')),
       transaction_nsu = COALESCE(?, transaction_nsu), invoice_slug = COALESCE(?, invoice_slug),
       capture_method = COALESCE(?, capture_method), receipt_url = COALESCE(?, receipt_url)
     WHERE order_nsu = ?`
  ).bind(info.transaction_nsu || null, info.slug || null, info.capture_method || null,
         info.receipt_url || null, pedido.order_nsu).run();

  // Garante envio único: só quem conseguir mudar 0 -> 1 envia
  const trava = await env.DB.prepare(
    "UPDATE pedidos SET email_enviado = 1 WHERE order_nsu = ? AND email_enviado = 0"
  ).bind(pedido.order_nsu).run();

  if (trava.meta?.changes === 1) {
    const enviado = await enviarEmail(env, pedido, livro);
    if (!enviado) {
      // Libera para tentar de novo no próximo aviso/visita
      await env.DB.prepare("UPDATE pedidos SET email_enviado = 0 WHERE order_nsu = ?")
        .bind(pedido.order_nsu).run();
    }
  }
  return true;
}

async function enviarEmail(env, pedido, livro) {
  const resp = await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
    service_id: env.EMAILJS_SERVICE_ID,
    template_id: env.EMAILJS_TEMPLATE_ID,
    user_id: env.EMAILJS_PUBLIC_KEY,
    accessToken: env.EMAILJS_PRIVATE_KEY,
    template_params: {
      to_email: pedido.email,
      to_name: pedido.nome,
      livro: livro.titulo,
      codigo: livro.codigo,
      link_leitura: livro.link_leitura || "",
      pedido: pedido.order_nsu.slice(0, 8).toUpperCase(),
    },
  });
  if (!resp.ok) console.error("EmailJS falhou:", resp.status, resp.texto);
  return resp.ok;
}

// ------------------------------------------------------------------- Rotas

async function paginaComprar(url, env) {
  const livro = await buscarLivro(env, url.searchParams.get("livro") || "");
  if (!livro) return html(pagina("Livro não encontrado", `<p class="aviso">Este livro não está disponível para compra no momento.</p>`), 404);

  const capa = livro.capa_url
    ? `<img class="capa" src="${esc(livro.capa_url)}" alt="Capa de ${esc(livro.titulo)}">`
    : "";

  const corpo = `
  <div class="compra">
    ${capa}
    <div>
      <h1>${esc(livro.titulo)}</h1>
      <p class="preco">${reais(livro.preco_centavos)}</p>
      <p class="nota">Depois do pagamento você recebe o código de acesso na tela e por e-mail. A leitura é feita aqui no site DeCastro.</p>

      <form id="f" novalidate>
        <label>Nome completo<input name="nome" autocomplete="name" required></label>
        <label>E-mail<input name="email" type="email" autocomplete="email" required></label>
        <label>Celular com DDD<input name="telefone" type="tel" autocomplete="tel" placeholder="(98) 99999-9999"></label>
        <p id="erro" class="erro" role="alert"></p>
        <button id="b" type="submit">Ir para o pagamento</button>
        <p class="nota pequena">Pagamento por Pix ou cartão, processado pela InfinitePay.</p>
      </form>
    </div>
  </div>
  <script>
    const f = document.getElementById('f'), b = document.getElementById('b'), erro = document.getElementById('erro');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      erro.textContent = '';
      const d = Object.fromEntries(new FormData(f));
      if (!d.nome.trim() || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(d.email.trim())) {
        erro.textContent = 'Preencha nome e um e-mail válido.'; return;
      }
      b.disabled = true; b.textContent = 'Gerando pagamento...';
      try {
        const r = await fetch('/api/pedido', { method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ ...d, livro: ${JSON.stringify(livro.id)} }) });
        const j = await r.json();
        if (!r.ok || !j.url) throw new Error(j.erro || 'Falha ao gerar o pagamento.');
        window.top.location.href = j.url;
      } catch (err) {
        erro.textContent = err.message; b.disabled = false; b.textContent = 'Ir para o pagamento';
      }
    });
  </script>`;
  return html(pagina(`Comprar ${livro.titulo}`, corpo));
}

async function criarPedido(request, url, env) {
  let d;
  try { d = await request.json(); } catch (_) { return json({ erro: "Dados inválidos." }, 400); }

  const nome = String(d.nome || "").trim().slice(0, 120);
  const email = String(d.email || "").trim().toLowerCase().slice(0, 160);
  if (!nome || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ erro: "Preencha nome e um e-mail válido." }, 400);

  const livro = await buscarLivro(env, String(d.livro || ""));
  if (!livro) return json({ erro: "Livro indisponível." }, 404);

  const pedido = {
    order_nsu: crypto.randomUUID(),
    nome, email,
    telefone: normalizarTelefone(d.telefone),
  };

  await env.DB.prepare(
    "INSERT INTO pedidos (order_nsu, livro_id, nome, email, telefone, valor_centavos) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(pedido.order_nsu, livro.id, nome, email, pedido.telefone, livro.preco_centavos).run();

  try {
    const link = await gerarLink(env, url.origin, livro, pedido);
    return json({ url: link });
  } catch (err) {
    console.error(err);
    return json({ erro: "Não foi possível gerar o pagamento agora. Tente de novo em instantes." }, 502);
  }
}

async function paginaObrigado(url, env) {
  const p = url.searchParams;
  const order_nsu = p.get("order_nsu");
  const pedido = order_nsu ? await buscarPedido(env, order_nsu) : null;
  if (!pedido) return html(pagina("Pedido não encontrado", `<p class="aviso">Não encontramos este pedido. Se você pagou, o código chegará no seu e-mail em alguns minutos.</p>`), 404);

  const livro = await env.DB.prepare("SELECT * FROM livros WHERE id = ?").bind(pedido.livro_id).first();

  let pago = pedido.status === "pago";
  if (!pago) {
    const info = await conferirPagamento(env, {
      order_nsu,
      transaction_nsu: p.get("transaction_nsu"),
      slug: p.get("slug"),
    });
    if (info.paid) {
      pago = await confirmarPedido(env, pedido, livro, {
        ...info,
        transaction_nsu: p.get("transaction_nsu"),
        slug: p.get("slug"),
        receipt_url: p.get("receipt_url"),
        capture_method: p.get("capture_method") || info.capture_method,
      });
    }
  }

  if (!pago) {
    return html(pagina("Aguardando confirmação", `
      <h1>Aguardando a confirmação do pagamento</h1>
      <p>Assim que a InfinitePay confirmar, esta página mostra o seu código. Ela se atualiza sozinha.</p>
      <p class="nota">O código também será enviado para <strong>${esc(pedido.email)}</strong>.</p>
      <meta http-equiv="refresh" content="8">`));
  }

  const leitura = livro.link_leitura
    ? `<a class="botao" href="${esc(livro.link_leitura)}" target="_top">Ir para a leitura</a>` : "";

  return html(pagina("Compra confirmada", `
    <h1>Compra confirmada</h1>
    <p>Obrigado, ${esc(pedido.nome.split(" ")[0])}. Este é o seu código de acesso ao livro <em>${esc(livro.titulo)}</em>:</p>
    <p class="codigo">${esc(livro.codigo)}</p>
    <p class="nota">Enviamos o mesmo código para <strong>${esc(pedido.email)}</strong>. Guarde-o para acessar o livro sempre que quiser.</p>
    ${leitura}`));
}

async function receberWebhook(request, env) {
  let d;
  try { d = await request.json(); } catch (_) { return json({ ok: false }, 400); }

  const order_nsu = d.order_nsu;
  const pedido = order_nsu ? await buscarPedido(env, order_nsu) : null;
  if (!pedido) return json({ ok: true }); // pedido que não é deste sistema: ignora

  if (pedido.status === "pago" && pedido.email_enviado === 1) return json({ ok: true });

  const livro = await env.DB.prepare("SELECT * FROM livros WHERE id = ?").bind(pedido.livro_id).first();

  // Nunca confia só no aviso: confirma com a InfinitePay
  const info = await conferirPagamento(env, {
    order_nsu,
    transaction_nsu: d.transaction_nsu,
    slug: d.invoice_slug || d.slug,
  });
  if (!info.paid) return json({ ok: false, motivo: "pagamento não confirmado" }, 400); // InfinitePay reenviará

  await confirmarPedido(env, pedido, livro, {
    ...info,
    transaction_nsu: d.transaction_nsu,
    slug: d.invoice_slug || d.slug,
    receipt_url: d.receipt_url,
    capture_method: d.capture_method || info.capture_method,
  });
  return json({ ok: true });
}

// ------------------------------------------------------------------ Utilidades

function normalizarTelefone(v) {
  let n = String(v || "").replace(/\D/g, "");
  if (n.startsWith("55") && (n.length === 12 || n.length === 13)) n = n.slice(2);
  if (n.startsWith("0")) n = n.slice(1);
  return n.length === 10 || n.length === 11 ? `+55${n}` : null; // formato exigido: +5598999999999
}

function reais(c) {
  return (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function html(corpo, status = 200) {
  return new Response(corpo, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function pagina(titulo, conteudo) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)} | DeCastro</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --mar: #1B2733; --papel: #E9ECEE; --folha: #FFFFFF; --ouro: #9C7A34;
    --texto: #1B2733; --suave: #56626D; --erro: #A3322B; --linha: #D3D8DC;
  }
  @media (prefers-color-scheme: dark) {
    :root { --papel: #121A22; --folha: #1B2733; --texto: #E6EAED; --suave: #A7B1B9; --linha: #2C3A47; --ouro: #C9A45A; --erro: #E07A70; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--papel); color: var(--texto);
    font: 17px/1.55 "Source Sans 3", "Segoe UI", Arial, sans-serif; }
  header { background: var(--mar); color: #E6EAED; padding: 14px 20px;
    font: 600 22px "Cormorant Garamond", Georgia, serif; letter-spacing: .02em; }
  header small { font: 400 14px "Source Sans 3", Arial, sans-serif; color: #A7B1B9; margin-left: 8px; }
  main { max-width: 860px; margin: 32px auto; padding: 32px 28px; background: var(--folha);
    border-top: 3px solid var(--ouro); }
  h1 { font: 600 clamp(28px, 4vw, 38px)/1.15 "Cormorant Garamond", Georgia, serif; margin: 0 0 8px; }
  .compra { display: grid; grid-template-columns: minmax(0, 220px) 1fr; gap: 32px; align-items: start; }
  .capa { width: 100%; max-width: 220px; box-shadow: 6px 8px 0 var(--linha); }
  .preco { font: 600 26px "Cormorant Garamond", Georgia, serif; color: var(--ouro); margin: 0 0 12px; }
  .nota { color: var(--suave); } .pequena { font-size: 14px; }
  form { display: grid; gap: 14px; margin-top: 20px; max-width: 440px; }
  label { display: grid; gap: 4px; font-weight: 600; font-size: 15px; }
  input { font: inherit; padding: 11px 12px; border: 1px solid var(--linha); background: var(--papel); color: var(--texto); border-radius: 4px; }
  input:focus, button:focus-visible, .botao:focus-visible { outline: 2px solid var(--ouro); outline-offset: 2px; }
  button, .botao { font: 600 17px "Source Sans 3", Arial, sans-serif; background: var(--mar); color: #fff;
    border: 0; padding: 13px 18px; border-radius: 4px; cursor: pointer; text-decoration: none; display: inline-block; }
  @media (prefers-color-scheme: dark) { button, .botao { background: var(--ouro); color: #121A22; } }
  button:disabled { opacity: .6; cursor: wait; }
  .erro { color: var(--erro); min-height: 1em; margin: 0; }
  .codigo { font: 600 30px/1.2 "Cormorant Garamond", Georgia, serif; letter-spacing: .06em;
    padding: 18px; border: 1px dashed var(--ouro); text-align: center; margin: 18px 0; word-break: break-all; }
  .aviso { font-size: 18px; }
  @media (max-width: 640px) {
    main { margin: 0; padding: 24px 18px; }
    .compra { grid-template-columns: 1fr; }
    .capa { max-width: 160px; }
  }
</style>
</head>
<body>
<header>DeCastro <small>O Canal do Conhecimento</small></header>
<main>${conteudo}</main>
</body>
</html>`;
}
