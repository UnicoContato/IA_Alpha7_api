const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_PRODUTOS_IA = 20;
const REGEX_TERMO_COMPOSTO = /\b(composto|composta|associado|associada|combinado|combinada|plus)\b/i;
const STOPWORDS_ATIVO = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'para', 'por',
  'mg', 'ml', 'mcg', 'g', 'ui', 'cp', 'cps', 'caps', 'comp', 'comprimido', 'comprimidos'
]);

function scoreBase(produto) {
  const score = Number(produto?.relevancia_descricao ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function compactarTexto(valor, limite = 120) {
  return String(valor || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, limite);
}

function normalizarTexto(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairTokensAtivo(valor) {
  return normalizarTexto(valor)
    .split(' ')
    .filter(token => token.length >= 3 && !STOPWORDS_ATIVO.has(token));
}

function tokenDiretoCombinaComDescricao(tokenBusca, tokenDescricao) {
  if (!tokenBusca || !tokenDescricao) {
    return false;
  }

  if (tokenBusca === tokenDescricao) {
    return true;
  }

  if (/^\d+$/.test(tokenBusca)) {
    return tokenDescricao.startsWith(tokenBusca);
  }

  if (tokenBusca.length < 5) {
    return false;
  }

  return tokenDescricao.startsWith(tokenBusca);
}

function produtoTemMatchDiretoNaDescricao(produto, termoBusca) {
  const tokensBusca = normalizarTexto(termoBusca)
    .split(' ')
    .filter(Boolean);
  const tokensDescricao = normalizarTexto(produto?.descricao)
    .split(' ')
    .filter(Boolean);

  if (tokensBusca.length === 0 || tokensDescricao.length === 0) {
    return false;
  }

  for (let idx = 0; idx <= tokensDescricao.length - tokensBusca.length; idx += 1) {
    const combina = tokensBusca.every((tokenBusca, offset) => (
      tokenDiretoCombinaComDescricao(tokenBusca, tokensDescricao[idx + offset])
    ));

    if (combina) {
      return true;
    }
  }

  return false;
}

function tokensSaoCompativeis(tokenBusca, tokenProduto) {
  if (!tokenBusca || !tokenProduto) {
    return false;
  }

  if (tokenBusca === tokenProduto) {
    return true;
  }

  const menor = Math.min(tokenBusca.length, tokenProduto.length);
  if (menor < 4) {
    return false;
  }

  return tokenBusca.startsWith(tokenProduto) || tokenProduto.startsWith(tokenBusca);
}

function descreverProdutoParaLog(produto) {
  if (!produto) {
    return 'produto indefinido';
  }

  return [
    `id=${produto.id ?? 'n/a'}`,
    `emb=${produto.embalagem_id ?? 'n/a'}`,
    `sql=${scoreBase(produto)}`,
    `origem=${produto.origem ?? 'n/a'}`,
    String(produto.descricao || '').substring(0, 90)
  ].join(' | ');
}

function logResumoProdutos(etapa, produtos, limite = 5) {
  const lista = Array.isArray(produtos) ? produtos : [];
  console.log(`[ETAPA 4] ${etapa} | total=${lista.length}`);

  if (lista.length === 0) {
    return;
  }

  lista.slice(0, limite).forEach((produto, idx) => {
    console.log(`         ${idx + 1}. ${descreverProdutoParaLog(produto)}`);
  });

  if (lista.length > limite) {
    console.log(`         ... +${lista.length - limite} produto(s)`);
  }
}

function contarTokensCompativeis(tokensBusca, tokensProduto) {
  const usados = new Set();
  let total = 0;

  tokensBusca.forEach(tokenBusca => {
    const indiceCompativel = tokensProduto.findIndex((tokenProduto, idx) => (
      !usados.has(idx) && tokensSaoCompativeis(tokenBusca, tokenProduto)
    ));

    if (indiceCompativel !== -1) {
      usados.add(indiceCompativel);
      total += 1;
    }
  });

  return total;
}

function pontuarCandidatoParaIA(produto, contextoBusca) {
  const termoBase = contextoBusca?.principioAtivoBusca || contextoBusca?.termoBuscaPrincipal || contextoBusca?.termoBusca || '';
  const termoPrincipal = contextoBusca?.termoBuscaPrincipal || contextoBusca?.termoBusca || termoBase;
  const tokensBusca = extrairTokensAtivo(termoBase);
  const tokensProduto = [
    ...extrairTokensAtivo(produto?.principioativo_nome),
    ...extrairTokensAtivo(produto?.descricao)
  ];
  const classificacaoSolicitada = obterClassificacaoSolicitada(contextoBusca?.intencaoClassificacao);
  const buscaComposta = ehBuscaComposta(contextoBusca?.termoBusca);
  const compatibilidades = contarTokensCompativeis(tokensBusca, tokensProduto);
  const matchDiretoNaDescricao = produtoTemMatchDiretoNaDescricao(produto, termoPrincipal);
  let score = scoreBase(produto);

  if (tokensBusca.length > 0) {
    score += compatibilidades * 50;

    if (compatibilidades === tokensBusca.length) {
      score += 180;
    } else if (compatibilidades === 0) {
      score -= 220;
    }
  }

  if (matchDiretoNaDescricao) {
    score += 260;
  }

  if (!buscaComposta) {
    if (produtoTemMultiplosPrincipios(produto)) {
      score += matchDiretoNaDescricao ? 0 : -40;
    } else {
      score += 35;
    }
  }

  if (classificacaoSolicitada) {
    const tipoClassificacao = String(produto?.tipo_classificacao_canonica || '').trim().toUpperCase();
    if (tipoClassificacao === classificacaoSolicitada) {
      score += 45;
    } else if (tipoClassificacao && tipoClassificacao !== 'DESCONHECIDO') {
      score -= 25;
    }
  }

  return score;
}

function selecionarProdutosParaIA(produtos, contextoBusca) {
  const lista = Array.isArray(produtos) ? produtos : [];
  const pontuados = lista
    .map(produto => ({
      produto,
      scoreSelecaoIA: pontuarCandidatoParaIA(produto, contextoBusca)
    }))
    .sort((a, b) => {
      return b.scoreSelecaoIA - a.scoreSelecaoIA
        || scoreBase(b.produto) - scoreBase(a.produto)
        || String(a.produto?.descricao || '').localeCompare(String(b.produto?.descricao || ''));
    });
  const limite = pontuados.length > MAX_PRODUTOS_IA ? MAX_PRODUTOS_IA : pontuados.length;
  const base = pontuados.slice(0, limite).map(item => item.produto);
  console.log(
    `[ETAPA 4] Selecionando lote para IA | total=${lista.length} | selecionados=${base.length}`
  );
  return base;
}

function dividirEmLotes(produtos, tamanhoLote) {
  const lotes = [];

  for (let idx = 0; idx < produtos.length; idx += tamanhoLote) {
    lotes.push(produtos.slice(idx, idx + tamanhoLote));
  }

  return lotes;
}

function criarListaProdutosCompacta(produtos) {
  return produtos.map((p, idx) => ({
    i: idx,
    d: compactarTexto(p.descricao, 120),
    pa: compactarTexto(p.principioativo_nome, 80),
    t: compactarTexto(p.tipo_classificacao_canonica ?? 'DESCONHECIDO', 30),
    o: compactarTexto(p.origem ?? 'desconhecida', 20),
    s: scoreBase(p)
  }));
}

function extrairArrayJSON(texto) {
  const textoLimpo = String(texto || '')
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  const inicio = textoLimpo.indexOf('[');
  const fim = textoLimpo.lastIndexOf(']');

  if (inicio === -1 || fim === -1 || fim < inicio) {
    throw new Error('IA nao retornou array JSON valido.');
  }

  return JSON.parse(textoLimpo.slice(inicio, fim + 1));
}

function extrairDecisoes(texto, tamanhoEsperado) {
  const decisoes = extrairArrayJSON(texto);

  if (!Array.isArray(decisoes) || decisoes.length !== tamanhoEsperado) {
    throw new Error('Quantidade de decisoes incorreta.');
  }

  const normalizadas = decisoes.map(item => ({
    i: Number(item?.i),
    ok: item?.ok === true
  }));

  const indices = new Set(normalizadas.map(item => item.i));
  const indicesEsperados = new Set(Array.from({ length: tamanhoEsperado }, (_, idx) => idx));

  if (indices.size !== tamanhoEsperado) {
    throw new Error('IA retornou indices duplicados ou ausentes.');
  }

  for (const indice of indicesEsperados) {
    if (!indices.has(indice)) {
      throw new Error('IA nao avaliou todos os produtos.');
    }
  }

  return normalizadas.sort((a, b) => a.i - b.i);
}

function logPayloadCompacto(listaProdutos, limite = 5) {
  const payloadJson = JSON.stringify(listaProdutos);
  console.log(
    `[ETAPA 4] Payload compacto pronto | itens=${listaProdutos.length} | caracteres_aprox=${payloadJson.length}`
  );

  listaProdutos.slice(0, limite).forEach(item => {
    console.log(`         payload i=${item.i} | s=${item.s} | d=${item.d}`);
  });

  if (listaProdutos.length > limite) {
    console.log(`         ... +${listaProdutos.length - limite} item(ns) no payload`);
  }
}

function logDecisoesIA(produtos, decisoes, limite = 5) {
  const aprovados = [];
  const rejeitados = [];

  decisoes.forEach(decisao => {
    const produto = produtos[decisao.i];
    if (decisao.ok) {
      aprovados.push(produto);
    } else {
      rejeitados.push(produto);
    }
  });

  console.log(
    `[ETAPA 4] Decisoes da IA | aprovados=${aprovados.length} | rejeitados=${rejeitados.length}`
  );

  aprovados.slice(0, limite).forEach((produto, idx) => {
    console.log(`         aprovado ${idx + 1}. ${descreverProdutoParaLog(produto)}`);
  });

  if (aprovados.length > limite) {
    console.log(`         ... +${aprovados.length - limite} aprovado(s)`);
  }

  rejeitados.slice(0, limite).forEach((produto, idx) => {
    console.log(`         rejeitado ${idx + 1}. ${descreverProdutoParaLog(produto)}`);
  });

  if (rejeitados.length > limite) {
    console.log(`         ... +${rejeitados.length - limite} rejeitado(s)`);
  }
}

function ehBuscaComposta(termoBusca) {
  return REGEX_TERMO_COMPOSTO.test(String(termoBusca || ''));
}

function produtoTemMultiplosPrincipios(produto) {
  const principioAtivo = normalizarTexto(produto?.principioativo_nome);
  if (!principioAtivo) {
    return false;
  }

  return principioAtivo.includes('+') || /\b e \b/.test(principioAtivo);
}

function produtoCombinaComPrincipioSimples(
  produto,
  principioAtivoBusca,
  termoBusca,
  permitirCompostos = false,
  termoBuscaPrincipal = ''
) {
  const tokensBusca = extrairTokensAtivo(principioAtivoBusca);
  const matchDiretoNaDescricao = produtoTemMatchDiretoNaDescricao(
    produto,
    termoBuscaPrincipal || termoBusca
  );
  if (tokensBusca.length === 0) {
    return true;
  }

  const tokensProduto = [
    ...extrairTokensAtivo(produto?.principioativo_nome),
    ...extrairTokensAtivo(produto?.descricao)
  ];
  const buscaComposta = ehBuscaComposta(termoBusca);

  if (tokensProduto.length === 0) {
    return true;
  }

  const contemPrincipioBusca = tokensBusca.every(tokenBusca => (
    tokensProduto.some(tokenProduto => tokensSaoCompativeis(tokenBusca, tokenProduto))
  ));

  if (!contemPrincipioBusca) {
    return matchDiretoNaDescricao;
  }

  if (matchDiretoNaDescricao) {
    return true;
  }

  if (!permitirCompostos && !buscaComposta && produtoTemMultiplosPrincipios(produto)) {
    return false;
  }

  return true;
}

function obterClassificacaoSolicitada(intencaoClassificacao) {
  if (
    intencaoClassificacao?.querGenerico &&
    !intencaoClassificacao?.querReferencia &&
    !intencaoClassificacao?.querSimilar
  ) {
    return 'GENERICO';
  }

  if (
    intencaoClassificacao?.querReferencia &&
    !intencaoClassificacao?.querGenerico &&
    !intencaoClassificacao?.querSimilar
  ) {
    return 'REFERENCIA';
  }

  if (
    intencaoClassificacao?.querSimilar &&
    !intencaoClassificacao?.querGenerico &&
    !intencaoClassificacao?.querReferencia
  ) {
    return 'SIMILAR';
  }

  return null;
}

function produtoCombinaComClassificacaoSolicitada(produto, intencaoClassificacao) {
  const classificacaoSolicitada = obterClassificacaoSolicitada(intencaoClassificacao);
  if (!classificacaoSolicitada) {
    return true;
  }

  const tipoClassificacao = String(produto?.tipo_classificacao_canonica || '').trim().toUpperCase();
  if (!tipoClassificacao || tipoClassificacao === 'DESCONHECIDO') {
    return true;
  }

  return tipoClassificacao === classificacaoSolicitada;
}

function normalizarPrincipioAtivo(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function produtoTemPrincipioAtivoBloqueado(produto) {
  return normalizarPrincipioAtivo(produto?.principioativo_nome) === 'outros';
}

function aplicarRegrasDeterministicasEmLote(produtos, contextoBusca, relacionadoPadrao = null) {
  return (produtos || []).map(produto => aplicarRegrasDeterministicas(
    { ...produto, relacionado_busca: produto?.relacionado_busca ?? relacionadoPadrao },
    contextoBusca
  ));
}

function aplicarRegrasDeterministicas(produto, contextoBusca) {
  const {
    principioAtivoBusca,
    termoBusca,
    termoBuscaPrincipal,
    intencaoClassificacao,
    permitirCompostosComoAlternativa
  } = contextoBusca || {};
  const buscaPerfumaria = contextoBusca?.buscaPerfumaria === true;
  const relacionadoAtual = produto?.relacionado_busca;
  const matchDiretoNaDescricao = produtoTemMatchDiretoNaDescricao(
    produto,
    termoBuscaPrincipal || termoBusca
  );
  const classificacaoCompativel = produtoCombinaComClassificacaoSolicitada(produto, intencaoClassificacao);
  const possuiPrincipioAtivoBusca = Boolean(String(principioAtivoBusca || '').trim());
  const combinaPorPrincipioAtivo = (
    !buscaPerfumaria &&
    possuiPrincipioAtivoBusca &&
    produtoCombinaComPrincipioSimples(
      produto,
      principioAtivoBusca,
      termoBusca,
      permitirCompostosComoAlternativa === true,
      termoBuscaPrincipal
    )
  );

  if (produtoTemPrincipioAtivoBloqueado(produto)) {
    if (relacionadoAtual !== false) {
      console.log(
        `[ETAPA 4] Override deterministico: produto marcado como nao relacionado ` +
        `| motivo=principio_ativo_bloqueado_outros | ${descreverProdutoParaLog(produto)}`
      );
    }

    return {
      ...produto,
      relacionado_busca: false
    };
  }

  if (classificacaoCompativel && (matchDiretoNaDescricao || combinaPorPrincipioAtivo)) {
    if (relacionadoAtual !== true) {
      console.log(
        `[ETAPA 4] Override deterministico: produto marcado como relacionado ` +
        `| motivo=${matchDiretoNaDescricao ? 'match_direto_descricao' : 'principio_ativo_compativel'} | ` +
        `${descreverProdutoParaLog(produto)}`
      );
    }

    return {
      ...produto,
      relacionado_busca: true
    };
  }

  if (relacionadoAtual !== true) {
    return produto;
  }

  if (buscaPerfumaria) {
    return produto;
  }

  if (!combinaPorPrincipioAtivo) {
    console.log(
      `[ETAPA 4] Override deterministico: produto marcado como nao relacionado ` +
      `| motivo=principio_ativo_composto_ou_divergente | ${descreverProdutoParaLog(produto)}`
    );
    return {
      ...produto,
      relacionado_busca: false
    };
  }

  if (!classificacaoCompativel) {
    console.log(
      `[ETAPA 4] Override deterministico: produto marcado como nao relacionado ` +
      `| motivo=classificacao_divergente | ${descreverProdutoParaLog(produto)}`
    );
    return {
      ...produto,
      relacionado_busca: false
    };
  }

  return produto;
}

function aplicarFlagRelacaoBusca(produtos, decisoes, contextoBusca) {
  return produtos.map((produto, idx) => {
    const decisao = decisoes.find(item => item.i === idx);
    const produtoMarcado = {
      ...produto,
      relacionado_busca: decisao ? decisao.ok === true : null
    };

    return aplicarRegrasDeterministicas(produtoMarcado, contextoBusca);
  });
}

function obterChaveProduto(produto) {
  return `${produto?.id ?? 'sem_id'}::${produto?.embalagem_id ?? 'sem_embalagem'}`;
}

function reorganizarProdutosMarcados(produtos) {
  const relacionados = [];
  const neutros = [];
  const naoRelacionados = [];

  produtos.forEach(produto => {
    if (produto?.relacionado_busca === true) {
      relacionados.push(produto);
      return;
    }

    if (produto?.relacionado_busca === false) {
      naoRelacionados.push(produto);
      return;
    }

    neutros.push(produto);
  });

  const produtosOrdenados = [...relacionados, ...neutros, ...naoRelacionados];
  const houveReordenacao = produtosOrdenados.some((produto, idx) => (
    obterChaveProduto(produto) !== obterChaveProduto(produtos[idx])
  ));

  return {
    produtosOrdenados,
    houveReordenacao
  };
}

function filtrarProdutosMarcados(produtos) {
  const produtosRelacionados = produtos.filter(produto => produto?.relacionado_busca !== false);
  const houveFiltragem = produtosRelacionados.length > 0 && produtosRelacionados.length < produtos.length;

  return {
    produtosFiltrados: houveFiltragem ? produtosRelacionados : produtos,
    houveFiltragem
  };
}

function aplicarScoreFinalIA(produtos) {
  const total = produtos.length;

  return produtos.map((produto, pos) => ({
    ...produto,
    relevancia_score: produto?.relacionado_busca === true ? total - pos : 0
  }));
}

async function marcarProdutosComIA(produtos, contextoBusca) {
  const termoBusca = contextoBusca?.termoBusca || '';
  if (!Array.isArray(produtos) || produtos.length <= 1) {
    const produtosMarcados = aplicarRegrasDeterministicasEmLote(produtos, contextoBusca, true);

    return {
      produtosMarcados,
      aprovados: produtosMarcados.filter(produto => produto.relacionado_busca === true).length,
      rejeitados: produtosMarcados.filter(produto => produto.relacionado_busca === false).length
    };
  }

  const listaProdutos = criarListaProdutosCompacta(produtos);
  const classificacaoSolicitada = obterClassificacaoSolicitada(contextoBusca?.intencaoClassificacao);
  logResumoProdutos('Lote recebido para marcacao', produtos);
  logPayloadCompacto(listaProdutos);
  const prompt = `Analise a busca farmacêutica "${termoBusca}" e marque se cada item tem relacao direta com a busca.

Contexto extraido da busca:
- termo_principal: ${contextoBusca?.termoBuscaPrincipal || termoBusca}
- principio_ativo: ${contextoBusca?.principioAtivoBusca || 'nao identificado'}
- forma_farmaceutica: ${contextoBusca?.formaFarmaceutica || 'nao identificada'}
- classificacao_preferida: ${classificacaoSolicitada || 'nao especificada'}

Produtos (total: ${listaProdutos.length}):
${JSON.stringify(listaProdutos, null, 2)}

Cada objeto possui:
- i: indice do item
- d: descricao
- pa: principio ativo
- t: tipo/classificacao
- o: origem da busca
- s: score SQL atual

Marque ok=true apenas quando o produto tiver relacao direta com a busca.
Se o nome comercial/descritivo bater com o termo principal, marque ok=true.
Se o principio ativo do produto for compativel com o principio ativo resolvido da busca, marque ok=true.
Marque ok=false quando o item for generico demais, vier de match fraco, ou contrariar algo explicito da busca como forma/concentracao/nome distintivo.
Se o termo principal aparecer diretamente na descricao/nome comercial do produto, trate isso como forte indicio de relacao direta.
Se a busca mencionar apenas um principio ativo simples, nao marque como relacionado um produto composto com outros principios ativos, a menos que a busca diga "composto" ou equivalente.
Nao rejeite um produto composto apenas por ser composto quando o nome comercial/descritivo dele bater diretamente com o termo principal da busca.
Se classificacao_preferida for GENERICO, prefira apenas itens GENERICO e rejeite REFERENCIA ou SIMILAR sem necessidade.
Se classificacao_preferida for REFERENCIA ou SIMILAR, siga a mesma logica de aderencia para a classificacao solicitada.
Rejeite produtos cujo nome ou principio ativo nao tenham relacao direta com o termo principal ou com o principio ativo resolvido.

IMPORTANTE:
- Retorne APENAS um array JSON de objetos
- Formato exato: [{"i":0,"ok":true},{"i":1,"ok":false}]
- Todos os ${listaProdutos.length} itens devem estar presentes uma unica vez
- Sem texto, explicacoes ou markdown`;

  const response = await axios.post(
    OPENAI_API_URL,
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Voce e um especialista em classificacao de medicamentos. Responda APENAS com um array JSON de objetos com i e ok.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  const texto = response.data.choices[0].message.content;
  console.log(`[ETAPA 4] Resposta bruta da IA: ${String(texto || '').substring(0, 500)}`);
  const decisoes = extrairDecisoes(texto, produtos.length);
  logDecisoesIA(produtos, decisoes);
  const produtosMarcados = aplicarFlagRelacaoBusca(produtos, decisoes, contextoBusca);

  return {
    produtosMarcados,
    aprovados: produtosMarcados.filter(produto => produto.relacionado_busca === true).length,
    rejeitados: produtosMarcados.filter(produto => produto.relacionado_busca === false).length
  };
}

async function ordenarPorIA(produtos, contextoBusca) {
  const termoBusca = contextoBusca?.termoBusca || '';
  console.log(`\n[ETAPA 4] Marcando ${produtos.length} produtos por RELEVANCIA com IA...`);

  if (!OPENAI_API_KEY || OPENAI_API_KEY === 'sua-chave-aqui') {
    console.log(`[ETAPA 4] ⚠️ IA nao configurada - aplicando apenas regras deterministicas`);
    const produtosMarcados = aplicarRegrasDeterministicasEmLote(produtos, contextoBusca, null);
    const aprovados = produtosMarcados.filter(produto => produto.relacionado_busca === true).length;
    const rejeitados = produtosMarcados.filter(produto => produto.relacionado_busca === false).length;
    const { produtosFiltrados, houveFiltragem } = filtrarProdutosMarcados(produtosMarcados);
    return {
      produtos: aplicarScoreFinalIA(produtosFiltrados),
      ordenado: false,
      filtrado: houveFiltragem,
      avaliado: false,
      estatisticasIA: { aprovados, rejeitados, analisados: produtos.length }
    };
  }

  if (produtos.length <= 1) {
    console.log(`[ETAPA 4] ⚠️ Apenas ${produtos.length} produto(s) - marcacao trivial`);
    const resultadoTrivial = await marcarProdutosComIA(produtos, contextoBusca);
    return {
      produtos: aplicarScoreFinalIA(resultadoTrivial.produtosMarcados),
      ordenado: false,
      filtrado: false,
      avaliado: true,
      estatisticasIA: {
        aprovados: resultadoTrivial.aprovados,
        rejeitados: resultadoTrivial.rejeitados,
        analisados: produtos.length
      }
    };
  }

  try {
    const produtosParaIA = selecionarProdutosParaIA(produtos, contextoBusca);
    const lotes = dividirEmLotes(produtosParaIA, MAX_PRODUTOS_IA);

    if (produtosParaIA.length <= 1) {
      console.log(`[ETAPA 4] ⚠️ Menos de 2 produtos relevantes para marcar com IA`);
      const resultadoTrivial = await marcarProdutosComIA(produtosParaIA, contextoBusca);
      return {
        produtos: aplicarScoreFinalIA(resultadoTrivial.produtosMarcados),
        ordenado: false,
        filtrado: false,
        avaliado: true,
        estatisticasIA: {
          aprovados: resultadoTrivial.aprovados,
          rejeitados: resultadoTrivial.rejeitados,
          analisados: produtosParaIA.length
        }
      };
    }

    console.log(
      `[ETAPA 4] Enviando ${produtosParaIA.length} produtos para IA marcar em ${lotes.length} lote(s)`
    );
    logResumoProdutos('Candidatos selecionados para a IA', produtosParaIA);

    const produtosMarcados = [];
    let aprovados = 0;
    let rejeitados = 0;

    for (const [indiceLote, lote] of lotes.entries()) {
      console.log(
        `[ETAPA 4] Processando lote ${indiceLote + 1}/${lotes.length} | itens=${lote.length}`
      );
      const resultadoLote = await marcarProdutosComIA(lote, contextoBusca);
      produtosMarcados.push(...resultadoLote.produtosMarcados);
      aprovados += resultadoLote.aprovados;
      rejeitados += resultadoLote.rejeitados;
    }

    const { produtosOrdenados, houveReordenacao } = reorganizarProdutosMarcados(produtosMarcados);
    const { produtosFiltrados, houveFiltragem } = filtrarProdutosMarcados(produtosOrdenados);
    const produtosComScore = aplicarScoreFinalIA(produtosFiltrados);

    console.log(
      `[ETAPA 4] ✅ IA marcou ${aprovados} relacionado(s) e ${rejeitados} nao relacionado(s) em ${produtosParaIA.length} produto(s)`
    );
    console.log(
      `[ETAPA 4] Resultado final da IA | ordenado=${houveReordenacao ? 'sim' : 'nao'} | ` +
      `filtrado=${houveFiltragem ? 'sim' : 'nao'} | retorno=${produtosComScore.length}`
    );
    logResumoProdutos('Produtos marcados pela IA', produtosComScore);

    return {
      produtos: produtosComScore,
      ordenado: houveReordenacao,
      filtrado: houveFiltragem,
      avaliado: true,
      estatisticasIA: { aprovados, rejeitados, analisados: produtosParaIA.length }
    };
  } catch (error) {
    console.error(`[ETAPA 4] ⚠️ Erro na IA:`, error.message);
    console.log(`[ETAPA 4] Usando apenas regras deterministicas`);
    const produtosMarcados = aplicarRegrasDeterministicasEmLote(produtos, contextoBusca, null);
    const aprovados = produtosMarcados.filter(produto => produto.relacionado_busca === true).length;
    const rejeitados = produtosMarcados.filter(produto => produto.relacionado_busca === false).length;
    const { produtosFiltrados, houveFiltragem } = filtrarProdutosMarcados(produtosMarcados);
    return {
      produtos: aplicarScoreFinalIA(produtosFiltrados),
      ordenado: false,
      filtrado: houveFiltragem,
      avaliado: false,
      estatisticasIA: { aprovados, rejeitados, analisados: produtos.length }
    };
  }
}

module.exports = { ordenarPorIA };
