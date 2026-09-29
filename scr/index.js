// Checkout de livros DeCastro — Cloudflare Worker + D1 + InfinitePay + EmailJS
//
// Rotas públicas:
//   GET  /comprar?livro=ID      página de compra (nome, e-mail, celular)
//   POST /api/pedido            cria o pedido e o link de pagamento na InfinitePay
//   GET  /obrigado              retorno do pagamento; confere e mostra o código
//   POST /webhook               aviso da InfinitePay; confere e envia o e-mail
//   GET  /capa/ID               imagem da capa guardada no banco
//
// Administração (protegida pela senha do Secret ADMIN_SENHA):
//   GET  /admin                 painel: livros, preços, códigos, capas e vendas
//
// Segurança: nenhum aviso de pagamento é aceito sem confirmação direta com a
// InfinitePay (payment_check). O valor pago é comparado ao valor do pedido.

let migrado = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const m = request.method;
    try {
      await migrar(env);

      if (m === "GET" && pathname === "/comprar") return paginaComprar(url, env);
      if (m === "POST" && pathname === "/api/pedido") return criarPedido(request, url, env);
      if (m === "GET" && pathname === "/obrigado") return paginaObrigado(url, env);
      if (m === "POST" && pathname === "/webhook") return receberWebhook(request, env);
      if (m === "GET" && pathname.startsWith("/capa/")) return servirCapa(pathname.slice(6), env);

      if (pathname === "/admin" || pathname.startsWith("/admin/")) return rotasAdmin(request, url, env);

      return html(pagina("Página não encontrada", `<p class="aviso">Este endereço não existe.</p>`), 404);
    } catch (err) {
      console.error("Erro geral:", err && err.stack ? err.stack : err);
      if (pathname.startsWith("/admin/api/") || pathname.startsWith("/api/")) {
        return json({ erro: "Erro interno. Veja os Logs do Worker." }, 500);
      }
      return html(pagina("Algo falhou", `<p class="aviso">Não foi possível concluir agora. Tente de novo em instantes ou fale com a loja.</p>`), 500);
    }
  },
};

// Atualiza o banco automaticamente (coluna de preço promocional e tabela de capas)
async function migrar(env) {
  if (migrado) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS capas (livro_id TEXT PRIMARY KEY, mime TEXT NOT NULL, dados TEXT NOT NULL, atualizado_em TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  try {
    await env.DB.prepare("ALTER TABLE livros ADD COLUMN preco_promocional_centavos INTEGER").run();
  } catch (e) {
    if (!/duplicate column/i.test(String(e && e.message ? e.message : e))) throw e;
  }
  migrado = true;
}

// ---------------------------------------------------------------- Preços

function temPromo(l) {
  return Number.isInteger(l.preco_promocional_centavos) &&
    l.preco_promocional_centavos > 0 &&
    l.preco_promocional_centavos < l.preco_centavos;
}

function precoEfetivo(l) {
  return temPromo(l) ? l.preco_promocional_centavos : l.preco_centavos;
}

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
    items: [{ quantity: 1, price: pedido.valor_centavos, description: livro.titulo }],
  };

  const customer = { name: pedido.nome, email: pedido.email };
  if (pedido.telefone) customer.phone_number = pedido.telefone;

  let resp = await postJSON(`${apiBase(env)}/links`, { ...base, customer });
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
    handle: env.INFINITEPAY_HANDLE, order_nsu, transaction_nsu, slug,
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

async function confirmarPedido(env, pedido, livro, info) {
  const valorPago = Number(info.amount ?? info.paid_amount ?? 0);
  if (valorPago && valorPago < pedido.valor_centavos) {
    console.warn("Valor pago menor que o do pedido:", pedido.order_nsu, valorPago, pedido.valor_centavos);
    return false;
  }

  await env.DB.prepare(
    `UPDATE pedidos SET status = 'pago', pago_em = COALESCE(pago_em, datetime('now')),
       transaction_nsu = COALESCE(?, transaction_nsu), invoice_slug = COALESCE(?, invoice_slug),
       capture_method = COALESCE(?, capture_method), receipt_url = COALESCE(?, receipt_url)
     WHERE order_nsu = ?`
  ).bind(info.transaction_nsu || null, info.slug || null, info.capture_method || null,
         info.receipt_url || null, pedido.order_nsu).run();

  const trava = await env.DB.prepare(
    "UPDATE pedidos SET email_enviado = 1 WHERE order_nsu = ? AND email_enviado = 0"
  ).bind(pedido.order_nsu).run();

  if (trava.meta?.changes === 1) {
    const enviado = await enviarEmail(env, pedido, livro);
    if (!enviado) {
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

// ------------------------------------------------------------ Rotas públicas

async function paginaComprar(url, env) {
  const livro = await buscarLivro(env, url.searchParams.get("livro") || "");
  if (!livro) return html(pagina("Livro não encontrado", `<p class="aviso">Este livro não está disponível para compra no momento.</p>`), 404);

  const capa = livro.capa_url
    ? `<img class="capa" src="${esc(livro.capa_url)}" alt="Capa de ${esc(livro.titulo)}">`
    : "";

  const preco = temPromo(livro)
    ? `<p class="preco"><s class="de">${reais(livro.preco_centavos)}</s> ${reais(livro.preco_promocional_centavos)}</p>
       <p class="selo">Preço promocional</p>`
    : `<p class="preco">${reais(livro.preco_centavos)}</p>`;

  const corpo = `
  <div class="compra${capa ? "" : " sem-capa"}">
    ${capa}
    <div>
      <h1>${esc(livro.titulo)}</h1>
      ${preco}
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
    valor_centavos: precoEfetivo(livro),
  };

  await env.DB.prepare(
    "INSERT INTO pedidos (order_nsu, livro_id, nome, email, telefone, valor_centavos) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(pedido.order_nsu, livro.id, nome, email, pedido.telefone, pedido.valor_centavos).run();

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
  if (!livro) return html(pagina("Livro indisponível", `<p class="aviso">Fale com a loja informando o pedido ${esc(order_nsu.slice(0, 8).toUpperCase())}.</p>`), 404);

  let pago = pedido.status === "pago";
  if (!pago) {
    const info = await conferirPagamento(env, {
      order_nsu, transaction_nsu: p.get("transaction_nsu"), slug: p.get("slug"),
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
      <script>setTimeout(function(){ location.reload(); }, 8000);</script>`));
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
  if (!pedido) return json({ ok: true });
  if (pedido.status === "pago" && pedido.email_enviado === 1) return json({ ok: true });

  const livro = await env.DB.prepare("SELECT * FROM livros WHERE id = ?").bind(pedido.livro_id).first();
  if (!livro) return json({ ok: true });

  const info = await conferirPagamento(env, {
    order_nsu, transaction_nsu: d.transaction_nsu, slug: d.invoice_slug || d.slug,
  });
  if (!info.paid) return json({ ok: false, motivo: "pagamento não confirmado" }, 400);

  await confirmarPedido(env, pedido, livro, {
    ...info,
    transaction_nsu: d.transaction_nsu,
    slug: d.invoice_slug || d.slug,
    receipt_url: d.receipt_url,
    capture_method: d.capture_method || info.capture_method,
  });
  return json({ ok: true });
}

async function servirCapa(id, env) {
  const c = await env.DB.prepare("SELECT mime, dados FROM capas WHERE livro_id = ?").bind(decodeURIComponent(id)).first();
  if (!c) return new Response("Capa não encontrada", { status: 404 });
  const bin = Uint8Array.from(atob(c.dados), (ch) => ch.charCodeAt(0));
  return new Response(bin, {
    headers: { "Content-Type": c.mime, "Cache-Control": "public, max-age=86400" },
  });
}

// ------------------------------------------------------------ Administração

async function rotasAdmin(request, url, env) {
  const { pathname } = url;
  const m = request.method;

  if (!env.ADMIN_SENHA) {
    return html(pagina("Administração", `<h1>Administração</h1>
      <p class="aviso">Falta cadastrar a senha. No painel da Cloudflare, abra este Worker, vá em
      Settings &gt; Variables and Secrets e crie um <strong>Secret</strong> chamado <code>ADMIN_SENHA</code>.</p>`), 503);
  }

  if (m === "GET" && pathname === "/admin/app.js") {
    return new Response(ADMIN_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" } });
  }

  if (m === "POST" && pathname === "/admin/login") {
    const form = await request.formData();
    const senha = String(form.get("senha") || "");
    const certo = (await assinar(env, "login:" + senha)) === (await assinar(env, "login:" + env.ADMIN_SENHA));
    if (!certo) {
      await new Promise((r) => setTimeout(r, 900));
      return html(paginaLogin("Senha incorreta."), 401);
    }
    const token = await criarToken(env);
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/admin",
        "Set-Cookie": `adm=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
      },
    });
  }

  if (m === "GET" && pathname === "/admin/sair") {
    return new Response(null, {
      status: 303,
      headers: { Location: "/admin", "Set-Cookie": "adm=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0" },
    });
  }

  const logado = await autenticado(request, env);

  if (m === "GET" && pathname === "/admin") {
    return html(logado ? paginaAdmin() : paginaLogin(""));
  }

  if (!pathname.startsWith("/admin/api/")) return html(pagina("Página não encontrada", `<p class="aviso">Este endereço não existe.</p>`), 404);
  if (!logado) return json({ erro: "Sessão expirada. Entre de novo." }, 401);
  if (m !== "GET" && request.headers.get("X-Admin") !== "1") return json({ erro: "Requisição recusada." }, 403);

  const partes = pathname.slice("/admin/api/".length).split("/").map(decodeURIComponent);

  // /admin/api/livros
  if (partes[0] === "livros" && partes.length === 1) {
    if (m === "GET") return listarLivros(env);
    if (m === "POST") return salvarLivro(request, env, null);
  }
  // /admin/api/livros/:id
  if (partes[0] === "livros" && partes.length === 2) {
    if (m === "PUT") return salvarLivro(request, env, partes[1]);
    if (m === "DELETE") return excluirLivro(env, partes[1]);
  }
  // /admin/api/livros/:id/capa
  if (partes[0] === "livros" && partes.length === 3 && partes[2] === "capa" && m === "POST") {
    return salvarCapa(request, env, partes[1]);
  }
  // /admin/api/pedidos
  if (partes[0] === "pedidos" && partes.length === 1 && m === "GET") return listarPedidos(env);
  // /admin/api/pedidos/:nsu/reenviar
  if (partes[0] === "pedidos" && partes.length === 3 && partes[2] === "reenviar" && m === "POST") {
    return reenviarEmail(env, partes[1]);
  }

  return json({ erro: "Rota não encontrada." }, 404);
}

async function listarLivros(env) {
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.titulo, l.preco_centavos, l.preco_promocional_centavos, l.codigo, l.link_leitura,
            l.capa_url, l.ativo,
            (SELECT COUNT(*) FROM pedidos p WHERE p.livro_id = l.id AND p.status = 'pago') AS vendas,
            (SELECT COUNT(*) FROM pedidos p WHERE p.livro_id = l.id) AS pedidos
       FROM livros l ORDER BY l.titulo COLLATE NOCASE`
  ).all();
  return json({ livros: results });
}

function validarLivro(d, criando) {
  const livro = {
    id: String(d.id || "").trim(),
    titulo: String(d.titulo || "").trim(),
    preco_centavos: Number(d.preco_centavos),
    preco_promocional_centavos: d.preco_promocional_centavos == null || d.preco_promocional_centavos === ""
      ? null : Number(d.preco_promocional_centavos),
    codigo: String(d.codigo || "").trim(),
    link_leitura: String(d.link_leitura || "").trim(),
    capa_url: String(d.capa_url || "").trim(),
    ativo: d.ativo ? 1 : 0,
  };
  if (criando && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(livro.id)) return { erro: "Identificador inválido: use letras minúsculas, números e hífens." };
  if (livro.id.length > 60) return { erro: "Identificador muito longo." };
  if (!livro.titulo || livro.titulo.length > 200) return { erro: "Informe o título." };
  if (!Number.isInteger(livro.preco_centavos) || livro.preco_centavos < 1) return { erro: "Preço real inválido." };
  if (livro.preco_promocional_centavos !== null) {
    if (!Number.isInteger(livro.preco_promocional_centavos) || livro.preco_promocional_centavos < 1) return { erro: "Preço promocional inválido." };
    if (livro.preco_promocional_centavos >= livro.preco_centavos) return { erro: "O preço promocional precisa ser menor que o preço real." };
  }
  if (!livro.codigo || livro.codigo.length > 100) return { erro: "Informe o código de acesso." };
  if (livro.link_leitura && !/^https?:\/\//i.test(livro.link_leitura)) return { erro: "O link de leitura deve começar com https://" };
  if (livro.capa_url && !/^(https?:\/\/|\/capa\/)/i.test(livro.capa_url)) return { erro: "O endereço da capa deve começar com https://" };
  return { livro };
}

async function salvarLivro(request, env, idExistente) {
  let d;
  try { d = await request.json(); } catch (_) { return json({ erro: "Dados inválidos." }, 400); }
  const criando = !idExistente;
  const { livro, erro } = validarLivro({ ...d, id: criando ? d.id : idExistente }, criando);
  if (erro) return json({ erro }, 400);

  if (criando) {
    const existe = await env.DB.prepare("SELECT 1 FROM livros WHERE id = ?").bind(livro.id).first();
    if (existe) return json({ erro: "Já existe um livro com esse identificador." }, 409);
    await env.DB.prepare(
      `INSERT INTO livros (id, titulo, preco_centavos, preco_promocional_centavos, codigo, link_leitura, capa_url, ativo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(livro.id, livro.titulo, livro.preco_centavos, livro.preco_promocional_centavos, livro.codigo,
           livro.link_leitura || null, livro.capa_url || null, livro.ativo).run();
  } else {
    const r = await env.DB.prepare(
      `UPDATE livros SET titulo = ?, preco_centavos = ?, preco_promocional_centavos = ?, codigo = ?,
         link_leitura = ?, capa_url = ?, ativo = ? WHERE id = ?`
    ).bind(livro.titulo, livro.preco_centavos, livro.preco_promocional_centavos, livro.codigo,
           livro.link_leitura || null, livro.capa_url || null, livro.ativo, livro.id).run();
    if (!r.meta?.changes) return json({ erro: "Livro não encontrado." }, 404);
    if (!livro.capa_url.startsWith("/capa/")) {
      await env.DB.prepare("DELETE FROM capas WHERE livro_id = ?").bind(livro.id).run();
    }
  }
  return json({ ok: true, id: livro.id });
}

async function excluirLivro(env, id) {
  const uso = await env.DB.prepare("SELECT COUNT(*) AS n FROM pedidos WHERE livro_id = ?").bind(id).first();
  if (uso && uso.n > 0) {
    return json({ erro: `Este livro tem ${uso.n} pedido(s) registrado(s), então não pode ser excluído. Use "Pausar venda" para tirá-lo da loja.` }, 409);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM capas WHERE livro_id = ?").bind(id),
    env.DB.prepare("DELETE FROM livros WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

async function salvarCapa(request, env, id) {
  let d;
  try { d = await request.json(); } catch (_) { return json({ erro: "Imagem inválida." }, 400); }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(d.dados || ""));
  if (!m) return json({ erro: "Formato de imagem não aceito. Use JPG, PNG ou WEBP." }, 400);
  if (m[2].length > 1_400_000) return json({ erro: "Imagem grande demais, mesmo depois de reduzida." }, 413);

  const existe = await env.DB.prepare("SELECT 1 FROM livros WHERE id = ?").bind(id).first();
  if (!existe) return json({ erro: "Livro não encontrado." }, 404);

  const capaUrl = `/capa/${encodeURIComponent(id)}?v=${Date.now()}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO capas (livro_id, mime, dados, atualizado_em) VALUES (?, ?, ?, datetime('now'))"
    ).bind(id, m[1], m[2]),
    env.DB.prepare("UPDATE livros SET capa_url = ? WHERE id = ?").bind(capaUrl, id),
  ]);
  return json({ ok: true, capa_url: capaUrl });
}

async function listarPedidos(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.order_nsu, p.nome, p.email, p.telefone, p.valor_centavos, p.status, p.email_enviado,
            p.capture_method, p.criado_em, p.pago_em, COALESCE(l.titulo, p.livro_id) AS livro
       FROM pedidos p LEFT JOIN livros l ON l.id = p.livro_id
      ORDER BY p.criado_em DESC LIMIT 200`
  ).all();
  return json({ pedidos: results });
}

async function reenviarEmail(env, order_nsu) {
  const pedido = await buscarPedido(env, order_nsu);
  if (!pedido) return json({ erro: "Pedido não encontrado." }, 404);
  if (pedido.status !== "pago") return json({ erro: "Este pedido ainda não foi pago." }, 400);
  const livro = await env.DB.prepare("SELECT * FROM livros WHERE id = ?").bind(pedido.livro_id).first();
  if (!livro) return json({ erro: "O livro deste pedido não existe mais." }, 404);
  const ok = await enviarEmail(env, pedido, livro);
  if (!ok) return json({ erro: "O EmailJS recusou o envio. Veja os Logs do Worker." }, 502);
  await env.DB.prepare("UPDATE pedidos SET email_enviado = 1 WHERE order_nsu = ?").bind(order_nsu).run();
  return json({ ok: true });
}

// Sessão: cookie assinado com a própria senha (trocar a senha desconecta todos)
async function assinar(env, texto) {
  const chave = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.ADMIN_SENHA), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(texto));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function criarToken(env) {
  const exp = String(Date.now() + 12 * 60 * 60 * 1000);
  return `${exp}.${await assinar(env, "sessao:" + exp)}`;
}

async function autenticado(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const m = /(?:^|;\s*)adm=([^;]+)/.exec(cookie);
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const esperado = await assinar(env, "sessao:" + exp);
  if (esperado.length !== sig.length) return false;
  let dif = 0;
  for (let i = 0; i < sig.length; i++) dif |= sig.charCodeAt(i) ^ esperado.charCodeAt(i);
  return dif === 0;
}

function paginaLogin(msg) {
  return pagina("Administração", `
    <h1>Administração</h1>
    <form method="post" action="/admin/login" class="login">
      <label>Senha<input type="password" name="senha" autocomplete="current-password" required autofocus></label>
      <p class="erro" role="alert">${esc(msg)}</p>
      <button type="submit">Entrar</button>
    </form>`);
}

function paginaAdmin() {
  return pagina("Administração", `
    <div class="adm-topo">
      <h1>Administração</h1>
      <div class="acoes">
        <button id="novo" type="button">+ Novo livro</button>
        <a class="link" href="/admin/sair">Sair</a>
      </div>
    </div>
    <div class="abas" role="tablist">
      <button type="button" data-aba="livros" class="ativa" role="tab">Livros</button>
      <button type="button" data-aba="vendas" role="tab">Vendas</button>
    </div>
    <section id="aba-livros"><div id="lista-livros" class="lista"><p class="nota">Carregando...</p></div></section>
    <section id="aba-vendas" hidden><div class="rolagem"><div id="lista-vendas"><p class="nota">Carregando...</p></div></div></section>

    <dialog id="dlg">
      <form id="form" novalidate>
        <h2 id="dlg-titulo">Novo livro</h2>
        <label>Título<input name="titulo" required maxlength="200"></label>
        <label>Identificador (vai no link de compra)
          <input name="id" required maxlength="60" pattern="[a-z0-9-]+">
          <small class="nota">Gerado a partir do título. Não pode ser alterado depois de criado.</small>
        </label>
        <div class="duas">
          <label>Preço real (R$)<input name="preco" inputmode="decimal" placeholder="39,90" required></label>
          <label>Preço promocional (R$)<input name="promo" inputmode="decimal" placeholder="vazio = sem promoção"></label>
        </div>
        <label>Código de acesso<input name="codigo" required maxlength="100" autocomplete="off"></label>
        <label>Link da página de leitura<input name="link_leitura" type="url" placeholder="https://www.lojasdecastro.com.br/..."></label>
        <fieldset>
          <legend>Capa</legend>
          <div class="capa-edit">
            <img id="capa-previa" alt="" hidden>
            <div>
              <label class="arquivo">Escolher imagem do computador<input id="capa-arquivo" type="file" accept="image/jpeg,image/png,image/webp"></label>
              <label>ou colar o endereço da imagem<input name="capa_url" placeholder="https://..."></label>
            </div>
          </div>
        </fieldset>
        <label class="check"><input type="checkbox" name="ativo" checked> À venda</label>
        <p id="form-erro" class="erro" role="alert"></p>
        <div class="acoes">
          <button type="button" class="secundario" id="cancelar">Cancelar</button>
          <button type="submit" id="salvar">Salvar</button>
        </div>
      </form>
    </dialog>
    <div id="toast" role="status" aria-live="polite"></div>
    <script src="/admin/app.js"></script>`, true);
}

// Código do painel (executa no navegador)
const ADMIN_JS = String.raw`
(function () {
  var livros = [], editando = null, capaNova = null;
  var $ = function (s) { return document.querySelector(s); };
  var form = $('#form'), dlg = $('#dlg');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function reais(c) { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function paraReais(c) { return c == null ? '' : (c / 100).toFixed(2).replace('.', ','); }
  function paraCentavos(v) {
    v = String(v || '').trim().replace(/R\$|\s/g, '');
    if (!v) return null;
    if (v.indexOf(',') >= 0) v = v.replace(/\./g, '').replace(',', '.');
    var n = Number(v);
    return isFinite(n) && n > 0 ? Math.round(n * 100) : NaN;
  }
  function slug(t) {
    return String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }
  function data(s) { return s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''; }
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.className = 'mostrar'; clearTimeout(toast.h); toast.h = setTimeout(function () { t.className = ''; }, 3000); }

  function api(url, opt) {
    opt = opt || {};
    opt.headers = { 'Content-Type': 'application/json', 'X-Admin': '1' };
    return fetch(url, opt).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('Sessão expirada'); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.erro || 'Falha na operação.');
        return j;
      });
    });
  }

  function linkCompra(id) { return location.origin + '/comprar?livro=' + encodeURIComponent(id); }

  function carregarLivros() {
    return api('/admin/api/livros').then(function (j) { livros = j.livros; desenharLivros(); })
      .catch(function (e) { $('#lista-livros').innerHTML = '<p class="erro">' + esc(e.message) + '</p>'; });
  }

  function desenharLivros() {
    var el = $('#lista-livros');
    if (!livros.length) { el.innerHTML = '<p class="nota">Nenhum livro cadastrado ainda. Clique em "+ Novo livro".</p>'; return; }
    el.innerHTML = livros.map(function (l, i) {
      var promo = l.preco_promocional_centavos && l.preco_promocional_centavos < l.preco_centavos;
      var preco = promo
        ? '<s class="de">' + reais(l.preco_centavos) + '</s> <strong>' + reais(l.preco_promocional_centavos) + '</strong> <span class="selo">promoção</span>'
        : '<strong>' + reais(l.preco_centavos) + '</strong>';
      var capa = l.capa_url ? '<img class="mini" src="' + esc(l.capa_url) + '" alt="">' : '<div class="mini vazia">sem capa</div>';
      return '<article class="item' + (l.ativo ? '' : ' pausado') + '">' + capa +
        '<div class="info">' +
          '<h3>' + esc(l.titulo) + (l.ativo ? '' : ' <span class="selo cinza">pausado</span>') + '</h3>' +
          '<p>' + preco + '</p>' +
          '<p class="nota">Código: <code>' + esc(l.codigo) + '</code> · Vendas: ' + l.vendas + '</p>' +
          '<div class="link-copia"><input readonly value="' + esc(linkCompra(l.id)) + '"><button type="button" class="secundario" data-copiar="' + i + '">Copiar link</button></div>' +
          '<div class="acoes">' +
            '<button type="button" data-editar="' + i + '">Editar</button>' +
            '<button type="button" class="secundario" data-pausar="' + i + '">' + (l.ativo ? 'Pausar venda' : 'Reativar venda') + '</button>' +
            '<button type="button" class="perigo" data-excluir="' + i + '">Excluir</button>' +
          '</div>' +
        '</div></article>';
    }).join('');
  }

  function carregarVendas() {
    return api('/admin/api/pedidos').then(function (j) {
      var el = $('#lista-vendas');
      if (!j.pedidos.length) { el.innerHTML = '<p class="nota">Nenhum pedido ainda.</p>'; return; }
      el.innerHTML = '<table><thead><tr><th>Data</th><th>Comprador</th><th>Livro</th><th>Valor</th><th>Situação</th><th>E-mail</th></tr></thead><tbody>' +
        j.pedidos.map(function (p) {
          var situacao = p.status === 'pago' ? '<span class="selo verde">pago</span>' : '<span class="selo cinza">pendente</span>';
          var email = p.status !== 'pago' ? '—' : (p.email_enviado ? 'enviado ' : '<span class="erro">não enviado</span> ') +
            '<button type="button" class="secundario pequeno" data-reenviar="' + esc(p.order_nsu) + '">Reenviar</button>';
          return '<tr><td>' + data(p.criado_em) + '</td><td>' + esc(p.nome) + '<br><small>' + esc(p.email) + '</small></td><td>' +
            esc(p.livro) + '</td><td>' + reais(p.valor_centavos) + '</td><td>' + situacao + '</td><td>' + email + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(function (e) { $('#lista-vendas').innerHTML = '<p class="erro">' + esc(e.message) + '</p>'; });
  }

  function abrirForm(l) {
    editando = l || null; capaNova = null;
    form.reset();
    $('#form-erro').textContent = '';
    $('#dlg-titulo').textContent = l ? 'Editar livro' : 'Novo livro';
    form.id.readOnly = !!l;
    form.titulo.value = l ? l.titulo : '';
    form.id.value = l ? l.id : '';
    form.preco.value = l ? paraReais(l.preco_centavos) : '';
    form.promo.value = l ? paraReais(l.preco_promocional_centavos) : '';
    form.codigo.value = l ? l.codigo : '';
    form.link_leitura.value = l ? (l.link_leitura || '') : '';
    form.capa_url.value = l && l.capa_url && l.capa_url.indexOf('/capa/') !== 0 ? l.capa_url : '';
    form.ativo.checked = l ? !!l.ativo : true;
    var prev = $('#capa-previa');
    if (l && l.capa_url) { prev.src = l.capa_url; prev.hidden = false; } else { prev.removeAttribute('src'); prev.hidden = true; }
    dlg.showModal();
    form.titulo.focus();
  }

  function reduzirImagem(arquivo) {
    return new Promise(function (ok, falha) {
      var img = new Image(), url = URL.createObjectURL(arquivo);
      img.onload = function () {
        var escala = Math.min(1, 600 / img.width);
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * escala); c.height = Math.round(img.height * escala);
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = function () { URL.revokeObjectURL(url); falha(new Error('Não foi possível ler essa imagem.')); };
      img.src = url;
    });
  }

  form.titulo.addEventListener('input', function () { if (!editando) form.id.value = slug(form.titulo.value); });

  $('#capa-arquivo').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    reduzirImagem(f).then(function (d) {
      if (d.length > 1400000) throw new Error('A imagem continua grande demais. Tente outra.');
      capaNova = d; var prev = $('#capa-previa'); prev.src = d; prev.hidden = false;
      form.capa_url.value = '';
    }).catch(function (err) { $('#form-erro').textContent = err.message; e.target.value = ''; });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var erro = $('#form-erro'); erro.textContent = '';
    var preco = paraCentavos(form.preco.value), promo = paraCentavos(form.promo.value);
    if (!form.titulo.value.trim()) { erro.textContent = 'Informe o título.'; return; }
    if (!editando && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(form.id.value)) { erro.textContent = 'Identificador inválido: use letras minúsculas, números e hífens.'; return; }
    if (!preco) { erro.textContent = 'Preço real inválido. Exemplo: 39,90'; return; }
    if (promo !== null && !promo) { erro.textContent = 'Preço promocional inválido. Exemplo: 29,90'; return; }
    if (promo !== null && promo >= preco) { erro.textContent = 'O preço promocional precisa ser menor que o preço real.'; return; }
    if (!form.codigo.value.trim()) { erro.textContent = 'Informe o código de acesso.'; return; }

    var capaUrl = form.capa_url.value.trim();
    if (!capaUrl && !capaNova && editando && editando.capa_url && editando.capa_url.indexOf('/capa/') === 0) capaUrl = editando.capa_url;

    var corpo = {
      id: form.id.value, titulo: form.titulo.value.trim(), preco_centavos: preco, preco_promocional_centavos: promo,
      codigo: form.codigo.value.trim(), link_leitura: form.link_leitura.value.trim(), capa_url: capaUrl, ativo: form.ativo.checked
    };
    var btn = $('#salvar'); btn.disabled = true; btn.textContent = 'Salvando...';
    var id = editando ? editando.id : corpo.id;
    api(editando ? '/admin/api/livros/' + encodeURIComponent(id) : '/admin/api/livros',
        { method: editando ? 'PUT' : 'POST', body: JSON.stringify(corpo) })
      .then(function () {
        if (capaNova) return api('/admin/api/livros/' + encodeURIComponent(id) + '/capa', { method: 'POST', body: JSON.stringify({ dados: capaNova }) });
      })
      .then(function () { dlg.close(); toast('Livro salvo.'); return carregarLivros(); })
      .catch(function (err) { erro.textContent = err.message; })
      .then(function () { btn.disabled = false; btn.textContent = 'Salvar'; });
  });

  $('#cancelar').addEventListener('click', function () { dlg.close(); });
  $('#novo').addEventListener('click', function () { abrirForm(null); });

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var d = b.dataset, l;
    if (d.aba) {
      document.querySelectorAll('.abas button').forEach(function (x) { x.classList.toggle('ativa', x === b); });
      $('#aba-livros').hidden = d.aba !== 'livros'; $('#aba-vendas').hidden = d.aba !== 'vendas';
      if (d.aba === 'vendas') carregarVendas();
      return;
    }
    if (d.copiar) {
      l = livros[+d.copiar];
      navigator.clipboard.writeText(linkCompra(l.id)).then(function () { toast('Link copiado.'); },
        function () { b.previousSibling.select(); toast('Selecione e copie com Ctrl+C.'); });
      return;
    }
    if (d.editar) { abrirForm(livros[+d.editar]); return; }
    if (d.pausar) {
      l = livros[+d.pausar];
      var corpo = Object.assign({}, l, { ativo: !l.ativo });
      api('/admin/api/livros/' + encodeURIComponent(l.id), { method: 'PUT', body: JSON.stringify(corpo) })
        .then(function () { toast(l.ativo ? 'Venda pausada.' : 'Venda reativada.'); return carregarLivros(); })
        .catch(function (err) { toast(err.message); });
      return;
    }
    if (d.excluir) {
      l = livros[+d.excluir];
      if (!confirm('Excluir o livro "' + l.titulo + '"? Esta ação não pode ser desfeita.')) return;
      api('/admin/api/livros/' + encodeURIComponent(l.id), { method: 'DELETE' })
        .then(function () { toast('Livro excluído.'); return carregarLivros(); })
        .catch(function (err) { alert(err.message); });
      return;
    }
    if (d.reenviar) {
      b.disabled = true;
      api('/admin/api/pedidos/' + encodeURIComponent(d.reenviar) + '/reenviar', { method: 'POST', body: '{}' })
        .then(function () { toast('E-mail reenviado.'); return carregarVendas(); })
        .catch(function (err) { toast(err.message); b.disabled = false; });
    }
  });

  carregarLivros();
})();
`;

// ------------------------------------------------------------------ Utilidades

function normalizarTelefone(v) {
  let n = String(v || "").replace(/\D/g, "");
  if (n.startsWith("55") && (n.length === 12 || n.length === 13)) n = n.slice(2);
  if (n.startsWith("0")) n = n.slice(1);
  return n.length === 10 || n.length === 11 ? `+55${n}` : null;
}

function reais(c) {
  return (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function html(corpo, status = 200) {
  return new Response(corpo, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function pagina(titulo, conteudo, largo = false) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(titulo)} | DeCastro</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --mar: #1B2733; --papel: #E9ECEE; --folha: #FFFFFF; --ouro: #9C7A34;
    --texto: #1B2733; --suave: #56626D; --erro: #A3322B; --linha: #D3D8DC; --verde: #2F6B45;
  }
  @media (prefers-color-scheme: dark) {
    :root { --papel: #121A22; --folha: #1B2733; --texto: #E6EAED; --suave: #A7B1B9; --linha: #2C3A47; --ouro: #C9A45A; --erro: #E07A70; --verde: #6FBF8A; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--papel); color: var(--texto);
    font: 17px/1.55 "Source Sans 3", "Segoe UI", Arial, sans-serif; }
  header { background: var(--mar); color: #E6EAED; padding: 14px 20px;
    font: 600 22px "Cormorant Garamond", Georgia, serif; letter-spacing: .02em; }
  header small { font: 400 14px "Source Sans 3", Arial, sans-serif; color: #A7B1B9; margin-left: 8px; }
  main { max-width: 860px; margin: 32px auto; padding: 32px 28px; background: var(--folha);
    border-top: 3px solid var(--ouro); }
  main.largo { max-width: 1100px; }
  h1 { font: 600 clamp(28px, 4vw, 38px)/1.15 "Cormorant Garamond", Georgia, serif; margin: 0 0 8px; }
  h2 { font: 600 28px/1.2 "Cormorant Garamond", Georgia, serif; margin: 0 0 12px; }
  h3 { font: 600 22px/1.2 "Cormorant Garamond", Georgia, serif; margin: 0 0 4px; }
  .compra { display: grid; grid-template-columns: minmax(0, 220px) 1fr; gap: 32px; align-items: start; }
  .compra.sem-capa { grid-template-columns: 1fr; max-width: 560px; }
  .capa { width: 100%; max-width: 220px; box-shadow: 6px 8px 0 var(--linha); }
  .preco { font: 600 26px "Cormorant Garamond", Georgia, serif; color: var(--ouro); margin: 0 0 4px; }
  .de { color: var(--suave); font-weight: 500; margin-right: 6px; }
  .selo { display: inline-block; font: 600 12px "Source Sans 3", Arial, sans-serif; text-transform: uppercase; letter-spacing: .06em;
    color: var(--ouro); border: 1px solid var(--ouro); padding: 1px 7px; border-radius: 3px; margin: 0 0 12px; vertical-align: middle; }
  .selo.cinza { color: var(--suave); border-color: var(--linha); }
  .selo.verde { color: var(--verde); border-color: var(--verde); margin: 0; }
  .nota { color: var(--suave); } .pequena { font-size: 14px; }
  form { display: grid; gap: 14px; margin-top: 20px; max-width: 440px; }
  label { display: grid; gap: 4px; font-weight: 600; font-size: 15px; }
  label small { font-weight: 400; }
  input { font: inherit; padding: 11px 12px; border: 1px solid var(--linha); background: var(--papel); color: var(--texto); border-radius: 4px; width: 100%; }
  input[readonly] { color: var(--suave); }
  input:focus, button:focus-visible, .botao:focus-visible, a:focus-visible { outline: 2px solid var(--ouro); outline-offset: 2px; }
  button, .botao { font: 600 16px "Source Sans 3", Arial, sans-serif; background: var(--mar); color: #fff;
    border: 1px solid transparent; padding: 11px 16px; border-radius: 4px; cursor: pointer; text-decoration: none; display: inline-block; }
  button.secundario { background: transparent; color: var(--texto); border-color: var(--linha); }
  button.perigo { background: transparent; color: var(--erro); border-color: var(--erro); }
  button.pequeno { padding: 3px 9px; font-size: 13px; }
  @media (prefers-color-scheme: dark) { button:not(.secundario):not(.perigo), .botao { background: var(--ouro); color: #121A22; } }
  button:disabled { opacity: .6; cursor: wait; }
  .erro { color: var(--erro); min-height: 1em; margin: 0; }
  .codigo { font: 600 30px/1.2 "Source Sans 3", Arial, sans-serif; font-variant-numeric: lining-nums tabular-nums; letter-spacing: .12em;
    padding: 18px; border: 1px dashed var(--ouro); text-align: center; margin: 18px 0; word-break: break-all; }
  .aviso { font-size: 18px; }
  code { font-family: Consolas, "Courier New", monospace; font-size: .95em; }
  .link { color: var(--texto); }

  /* Administração */
  .adm-topo { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .acoes { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .abas { display: flex; gap: 4px; border-bottom: 1px solid var(--linha); margin: 20px 0; }
  .abas button { background: transparent; color: var(--suave); border: 0; border-bottom: 3px solid transparent; border-radius: 0; }
  .abas button.ativa { color: var(--texto); border-bottom-color: var(--ouro); }
  .lista { display: grid; gap: 16px; }
  .item { display: grid; grid-template-columns: 96px 1fr; gap: 18px; padding: 16px; border: 1px solid var(--linha); }
  .item.pausado { opacity: .7; }
  .item p { margin: 0 0 6px; }
  .mini { width: 96px; aspect-ratio: 2 / 3; object-fit: cover; background: var(--papel); }
  .mini.vazia { display: grid; place-items: center; font-size: 12px; color: var(--suave); border: 1px dashed var(--linha); }
  .link-copia { display: flex; gap: 8px; margin: 8px 0 12px; }
  .link-copia input { font-size: 14px; padding: 7px 10px; }
  .link-copia button { white-space: nowrap; padding: 7px 12px; font-size: 14px; }
  .rolagem { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 15px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--linha); vertical-align: top; }
  th { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--suave); }
  dialog { border: 0; border-top: 3px solid var(--ouro); padding: 28px; width: min(640px, 94vw); max-height: 92vh; overflow-y: auto;
    background: var(--folha); color: var(--texto); }
  dialog::backdrop { background: rgba(10, 16, 22, .55); }
  dialog form { max-width: none; margin: 0; }
  .duas { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  fieldset { border: 1px solid var(--linha); padding: 12px 14px 14px; margin: 0; }
  legend { font-weight: 600; font-size: 15px; padding: 0 6px; }
  .capa-edit { display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: start; }
  .capa-edit > div { display: grid; gap: 12px; }
  #capa-previa { width: 90px; aspect-ratio: 2 / 3; object-fit: cover; }
  .arquivo input { padding: 8px; background: transparent; }
  .check { display: flex; gap: 8px; align-items: center; }
  .check input { width: auto; }
  .login { max-width: 320px; }
  #toast { position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 20px); background: var(--mar); color: #fff;
    padding: 10px 18px; border-radius: 4px; opacity: 0; transition: .2s; pointer-events: none; }
  #toast.mostrar { opacity: 1; transform: translate(-50%, 0); }

  @media (max-width: 640px) {
    main { margin: 0; padding: 24px 18px; }
    .compra { grid-template-columns: 1fr; }
    .capa { max-width: 160px; }
    .item { grid-template-columns: 64px 1fr; gap: 12px; }
    .mini { width: 64px; }
    .duas, .capa-edit { grid-template-columns: 1fr; }
    .link-copia { flex-direction: column; }
  }
</style>
</head>
<body>
<header>DeCastro <small>O Canal do Conhecimento</small></header>
<main${largo ? ' class="largo"' : ""}>${conteudo}</main>
</body>
</html>`;
}

