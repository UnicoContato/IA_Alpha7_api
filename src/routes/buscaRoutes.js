const express = require('express');
const {
  buscarPorDescricao,
  buscarPorPrincipioAtivo,
  buscarPorPrincipioAtivoIds,
  buscarPrincipiosAtivosPorTermoFlexivel,
  sugerirCorrecaoTermo,
  verificarDisponibilidade
} = require('../db/queries');
const { enriquecerClassificacaoCanonica } = require('../db/classificacaoQueries');
const { ordenarPorIA } = require('../services/aiService');
const { analisarNecessidadeDeClarificacao } = require('../services/clarificacaoService');
const { normalizarBuscaComIA } = require('../services/preBuscaAiService');
const {
  extrairConcentracoes,
  extrairContextoBuscaMedicamento,
  extrairFormasDeTexto,
  gerarVariacoesPrincipioAtivo,
  normalizarTextoBusca: normalizarTextoBuscaMedicamento
} = require('../utils/searchUtils');

const router = express.Router();

const UNIDADE_NEGOCIO_ID_PADRAO = parseInt(process.env.UNIDADE_NEGOCIO_ID || '65984');
const REGEX_TERMO_GENERICO = /\b(generico|genericos|gen)\b/gi;
const REGEX_TERMO_REFERENCIA = /\b(referencia|referencias|ref|etico|etica|marca)\b/gi;
const REGEX_TERMO_SIMILAR = /\b(similar|similares|sim)\b/gi;
const REGEX_TERMO_GENERICO_TESTE = /\b(generico|genericos|gen)\b/i;
const REGEX_TERMO_REFERENCIA_TESTE = /\b(referencia|referencias|ref|etico|etica|marca)\b/i;
const REGEX_TERMO_SIMILAR_TESTE = /\b(similar|similares|sim)\b/i;
const REGEX_TERMO_PERFUMARIA = /\b(shampoo|condicionador|sabonete|hidratante|desodorante|perfume|protetor|fralda|absorvente|escova|pasta|creme dental|cosmetico|cosmético)\b/i;
const STOPWORDS_BUSCA = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'para', 'por', 'na', 'no', 'nas', 'nos',
  'mg', 'ml', 'mcg', 'g', 'ui', 'cp', 'cps', 'caps', 'comp', 'comprimido', 'comprimidos'
]);
const REGEX_TEXTO_COMPOSTO = /[+/]|(?:\b e \b)/i;

function normalizarTextoBusca(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectarIntencaoBusca(termo) {
  const texto = String(termo || '');

  return {
    querGenerico: REGEX_TERMO_GENERICO_TESTE.test(texto),
    querReferencia: REGEX_TERMO_REFERENCIA_TESTE.test(texto),
    querSimilar: REGEX_TERMO_SIMILAR_TESTE.test(texto),
    querPerfumaria: REGEX_TERMO_PERFUMARIA.test(texto)
  };
}

function limparTermoBuscaPrincipal(termo) {
  return String(termo || '')
    .replace(REGEX_TERMO_GENERICO, ' ')
    .replace(REGEX_TERMO_REFERENCIA, ' ')
    .replace(REGEX_TERMO_SIMILAR, ' ')
    .replace(/\b(em|de|da|do|das|dos|na|no|nas|nos|com|para|por|mg|ml|mcg|g|ui|cp|cps|caps|comp|comprimido|comprimidos)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairTokensBusca(termo) {
  return normalizarTextoBusca(termo)
    .split(' ')
    .filter(token => token.length >= 3 && !STOPWORDS_BUSCA.has(token));
}

function ehTextoComposto(valor) {
  return REGEX_TEXTO_COMPOSTO.test(normalizarTextoBuscaMedicamento(valor));
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

function pontuarNomePrincipioAtivoParaBusca(nomePrincipioAtivo, termoBuscaPrincipal) {
  const nomeNormalizado = normalizarTextoBuscaMedicamento(nomePrincipioAtivo);
  const buscaNormalizada = normalizarTextoBuscaMedicamento(termoBuscaPrincipal);
  const tokensBusca = extrairTokensAtivoBusca(termoBuscaPrincipal);
  const tokensPrincipio = extrairTokensAtivoBusca(nomePrincipioAtivo);
  const totalCompatibilidades = contarTokensCompativeis(tokensBusca, tokensPrincipio);
  let score = 0;

  if (buscaNormalizada && nomeNormalizado === buscaNormalizada) {
    score += 400;
  } else if (buscaNormalizada && nomeNormalizado.includes(buscaNormalizada)) {
    score += 220;
  }

  if (tokensBusca.length > 0) {
    score += totalCompatibilidades * 70;

    if (totalCompatibilidades === tokensBusca.length) {
      score += 180;
    }
  }

  if (!ehTextoComposto(termoBuscaPrincipal)) {
    score += ehTextoComposto(nomePrincipioAtivo) ? -260 : 120;
  }

  return score;
}

function produtoCombinaComBuscaBase(produto, termoBuscaPrincipal) {
  const tokens = extrairTokensBusca(termoBuscaPrincipal);
  if (tokens.length === 0) {
    return false;
  }

  const tokensProduto = extrairTokensBusca(`${produto?.descricao || ''} ${produto?.principioativo_nome || ''}`);
  return tokens.every(token => tokensProduto.some(tokenProduto => tokensSaoCompativeis(token, tokenProduto)));
}

function selecionarProdutosDescricaoConfiaveis(produtosDescricao, termoBuscaPrincipal, limite = 20) {
  const lista = Array.isArray(produtosDescricao) ? produtosDescricao : [];
  const candidatosEstritos = lista.filter(produto => produtoCombinaComBuscaBase(produto, termoBuscaPrincipal));

  if (candidatosEstritos.length > 0) {
    return candidatosEstritos.slice(0, limite);
  }

  return lista.slice(0, Math.min(limite, 10));
}

function resolverPrincipioAtivoDominante(produtosDescricao, termoBuscaPrincipal) {
  const candidatos = selecionarProdutosDescricaoConfiaveis(produtosDescricao, termoBuscaPrincipal)
    .filter(produto => produto?.principioativo_id && produto?.principioativo_nome);

  if (candidatos.length === 0) {
    return null;
  }

  const resumoPorPrincipio = new Map();

  candidatos.forEach(produto => {
    const chave = String(produto.principioativo_id);
    const existente = resumoPorPrincipio.get(chave) || {
      id: produto.principioativo_id,
      nome: produto.principioativo_nome,
      total: 0,
      melhorScore: 0,
      scoreCompatibilidade: pontuarNomePrincipioAtivoParaBusca(produto.principioativo_nome, termoBuscaPrincipal)
    };

    existente.total += 1;
    existente.melhorScore = Math.max(existente.melhorScore, Number(produto.relevancia_descricao || 0));
    resumoPorPrincipio.set(chave, existente);
  });

  return [...resumoPorPrincipio.values()]
    .sort((a, b) => {
      return b.scoreCompatibilidade - a.scoreCompatibilidade
        || b.total - a.total
        || b.melhorScore - a.melhorScore
        || a.nome.localeCompare(b.nome);
    })[0] || null;
}

function podeUsarPrincipioResolvido(principioResolvido, termoBuscaPrincipal) {
  if (!principioResolvido?.nome) {
    return false;
  }

  if (!ehTextoComposto(termoBuscaPrincipal) && ehTextoComposto(principioResolvido.nome)) {
    return false;
  }

  return pontuarNomePrincipioAtivoParaBusca(principioResolvido.nome, termoBuscaPrincipal) > 0;
}

function selecionarPrincipiosAtivosPrioritarios(principiosAtivos, termoBuscaPrincipal, {
  incluirCompostos = true,
  limite = 20
} = {}) {
  return [...(principiosAtivos || [])]
    .map(principio => ({
      ...principio,
      score_busca: pontuarNomePrincipioAtivoParaBusca(principio?.nome, termoBuscaPrincipal),
      composto: ehTextoComposto(principio?.nome)
    }))
    .filter(principio => principio.score_busca > 0)
    .filter(principio => incluirCompostos || !principio.composto)
    .sort((a, b) => {
      return b.score_busca - a.score_busca
        || Number(b.score_flexivel || 0) - Number(a.score_flexivel || 0)
        || String(a.nome || '').localeCompare(String(b.nome || ''));
    })
    .slice(0, limite);
}

function selecionarPrincipioIdsPreferenciaisDeProdutos(produtos, termoBuscaPrincipal, {
  incluirCompostos = true,
  limite = 10
} = {}) {
  const porPrincipio = new Map();

  (produtos || []).forEach(produto => {
    const principioId = produto?.principioativo_id;
    const principioNome = produto?.principioativo_nome;
    if (!principioId || !principioNome) {
      return;
    }

    if (!incluirCompostos && ehTextoComposto(principioNome)) {
      return;
    }

    const scoreBusca = pontuarNomePrincipioAtivoParaBusca(principioNome, termoBuscaPrincipal)
      + Number(produto?.relevancia_descricao || 0);

    if (scoreBusca <= 0) {
      return;
    }

    const chave = String(principioId);
    const existente = porPrincipio.get(chave);
    if (!existente || scoreBusca > existente.scoreBusca) {
      porPrincipio.set(chave, {
        id: principioId,
        scoreBusca
      });
    }
  });

  return [...porPrincipio.values()]
    .sort((a, b) => b.scoreBusca - a.scoreBusca || String(a.id).localeCompare(String(b.id)))
    .slice(0, limite)
    .map(item => item.id);
}

function obterTipoClassificacaoSolicitada(intencaoBusca) {
  if (intencaoBusca?.querGenerico && !intencaoBusca?.querReferencia && !intencaoBusca?.querSimilar) {
    return 'GENERICO';
  }

  if (intencaoBusca?.querReferencia && !intencaoBusca?.querGenerico && !intencaoBusca?.querSimilar) {
    return 'REFERENCIA';
  }

  if (intencaoBusca?.querSimilar && !intencaoBusca?.querGenerico && !intencaoBusca?.querReferencia) {
    return 'SIMILAR';
  }

  return null;
}

function aplicarFiltroPorIntencaoClassificacao(produtos, intencaoBusca) {
  if (intencaoBusca?.querPerfumaria) {
    return {
      produtos,
      aplicado: false,
      tipoSolicitado: null
    };
  }

  const tipoSolicitado = obterTipoClassificacaoSolicitada(intencaoBusca);
  if (!tipoSolicitado) {
    return {
      produtos,
      aplicado: false,
      tipoSolicitado: null
    };
  }

  const filtrados = produtos.filter(produto => produto?.tipo_classificacao_canonica === tipoSolicitado);
  if (filtrados.length === 0) {
    return {
      produtos,
      aplicado: false,
      tipoSolicitado
    };
  }

  return {
    produtos: filtrados,
    aplicado: true,
    tipoSolicitado
  };
}

function obterChaveProduto(produto) {
  return `${produto?.id ?? 'sem_id'}::${produto?.embalagem_id ?? 'sem_embalagem'}`;
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

function extrairTokensAtivoBusca(termo) {
  return normalizarTextoBuscaMedicamento(termo)
    .split(' ')
    .filter(token => token.length >= 3 && !STOPWORDS_BUSCA.has(token));
}

function pontuarProdutoPorPrincipioAtivo(produto, principioAtivoBase, tipoSolicitado) {
  const tokensBusca = extrairTokensAtivoBusca(principioAtivoBase);
  const textoProduto = `${produto?.principioativo_nome || ''} ${produto?.descricao || ''}`;
  const tokensProduto = extrairTokensAtivoBusca(textoProduto);
  let score = Number(produto?.relevancia_descricao || 0);

  if (tokensBusca.length > 0) {
    const todosCompatíveis = tokensBusca.every(tokenBusca => (
      tokensProduto.some(tokenProduto => tokensSaoCompativeis(tokenBusca, tokenProduto))
    ));

    if (todosCompatíveis) {
      score += 120;
    }

    tokensBusca.forEach(tokenBusca => {
      const combinacoes = tokensProduto.filter(tokenProduto => tokensSaoCompativeis(tokenBusca, tokenProduto)).length;
      score += combinacoes * 12;
    });
  }

  if (!String(produto?.principioativo_nome || '').includes('+')) {
    score += 20;
  } else {
    score -= 10;
  }

  if (tipoSolicitado && produto?.tipo_classificacao_canonica === tipoSolicitado) {
    score += 35;
  }

  return score;
}

function ordenarProdutosPorPrincipioAtivo(produtos, principioAtivoBase, intencaoBusca) {
  const tipoSolicitado = obterTipoClassificacaoSolicitada(intencaoBusca);

  return [...(produtos || [])]
    .map(produto => ({
      ...produto,
      relevancia_descricao: pontuarProdutoPorPrincipioAtivo(produto, principioAtivoBase, tipoSolicitado)
    }))
    .sort((a, b) => {
      const scoreA = Number(a?.relevancia_descricao || 0);
      const scoreB = Number(b?.relevancia_descricao || 0);
      return scoreB - scoreA || String(a?.descricao || '').localeCompare(String(b?.descricao || ''));
    });
}

async function prepararProdutosRecuperados(produtos, unidadeNegocioId, intencaoBusca, principioAtivoBase, contextoAtributos = {}) {
  let lista = ordenarProdutosPorPrincipioAtivo(produtos, principioAtivoBase, intencaoBusca);

  if (lista.length > 0) {
    lista = await verificarDisponibilidade(lista, unidadeNegocioId);
  }

  if (lista.length > 0) {
    lista = await enriquecerClassificacaoCanonica(lista);
  }

  if (lista.length > 0) {
    const resultadoFiltroClassificacao = aplicarFiltroPorIntencaoClassificacao(lista, intencaoBusca);
    lista = resultadoFiltroClassificacao.produtos;
  }

  if (lista.length > 0) {
    const resultadoFiltroAtributos = aplicarFiltroEstritoPorAtributos(lista, contextoAtributos);
    lista = resultadoFiltroAtributos.produtos;
  }

  return ordenarProdutosPorPrincipioAtivo(lista, principioAtivoBase, intencaoBusca);
}

async function executarFallbackPorPrincipioAtivo({
  termoBusca,
  termoBuscaPrincipal,
  principioAtivoBusca,
  principioAtivoResolvido,
  produtosAtuais,
  formaFarmaceutica,
  variacoesForma,
  concentracoesBusca,
  variacoesConcentracao,
  unidadeNegocioId,
  intencaoBusca
}) {
  const termoBase = principioAtivoBusca || termoBuscaPrincipal || termoBusca;
  const buscaComposta = ehTextoComposto(termoBase);
  const termosBase = [
    !buscaComposta && ehTextoComposto(principioAtivoResolvido) ? null : principioAtivoResolvido,
    principioAtivoBusca,
    termoBuscaPrincipal,
    termoBusca
  ].filter(Boolean);
  const variacoes = [...new Set(termosBase.flatMap(gerarVariacoesPrincipioAtivo))];
  const principiosAtivos = await buscarPrincipiosAtivosPorTermoFlexivel([...termosBase, ...variacoes], 40);
  const principioIdsPrioritarios = [...new Set([
    ...selecionarPrincipioIdsPreferenciaisDeProdutos(produtosAtuais, termoBase, {
      incluirCompostos: buscaComposta,
      limite: 12
    }),
    ...selecionarPrincipiosAtivosPrioritarios(principiosAtivos, termoBase, {
      incluirCompostos: buscaComposta,
      limite: 18
    }).map(item => item.id)
  ])];

  async function executarRodadaFallback(principioIds, permitirCompostosComoAlternativa) {
    if (!Array.isArray(principioIds) || principioIds.length === 0) {
      return null;
    }

    const resultadoBuscaIds = await buscarPorPrincipioAtivoIds(
      principioIds,
      formaFarmaceutica,
      variacoesForma,
      variacoesConcentracao
    );

    if (!resultadoBuscaIds.encontrado) {
      return null;
    }

    const produtosPreparados = await prepararProdutosRecuperados(
      resultadoBuscaIds.produtos.map(produto => ({ ...produto, origem: 'fallback_principio_ativo' })),
      unidadeNegocioId,
      intencaoBusca,
      termoBase,
      {
        formaFarmaceutica,
        variacoesForma,
        concentracoesBusca,
        variacoesConcentracao
      }
    );

    const resultadoIA = await ordenarPorIA(produtosPreparados, {
      termoBusca,
      termoBuscaPrincipal,
      principioAtivoBusca: termoBase,
      formaFarmaceutica,
      intencaoClassificacao: intencaoBusca,
      permitirCompostosComoAlternativa,
      modoFallbackPrincipioAtivo: true
    });

    return {
      aplicado: true,
      produtos: resultadoIA.produtos,
      resultadoIA,
      principiosAtivos,
      principioIds,
      metodo: resultadoBuscaIds.metodo
    };
  }

  const primeiraRodada = await executarRodadaFallback(principioIdsPrioritarios, buscaComposta);
  if (primeiraRodada && (primeiraRodada.resultadoIA?.estatisticasIA?.aprovados || 0) > 0) {
    return primeiraRodada;
  }

  if (!buscaComposta) {
    const principioIdsCompostos = [...new Set([
      ...principioIdsPrioritarios,
      ...selecionarPrincipioIdsPreferenciaisDeProdutos(produtosAtuais, termoBase, {
        incluirCompostos: true,
        limite: 16
      }),
      ...selecionarPrincipiosAtivosPrioritarios(principiosAtivos, termoBase, {
        incluirCompostos: true,
        limite: 24
      }).map(item => item.id)
    ])];

    const segundaRodada = await executarRodadaFallback(principioIdsCompostos, true);
    if (segundaRodada) {
      return segundaRodada;
    }
  }

  return primeiraRodada || {
    aplicado: false,
    produtos: [],
    resultadoIA: null,
    principiosAtivos,
    principioIds: principioIdsPrioritarios,
    metodo: null
  };
}

function descreverProdutoParaLog(produto) {
  if (!produto) {
    return 'produto indefinido';
  }

  const partes = [
    `id=${produto.id ?? 'n/a'}`,
    `emb=${produto.embalagem_id ?? 'n/a'}`,
    `origem=${produto.origem ?? 'n/a'}`,
    `sql=${produto.relevancia_descricao ?? 0}`,
    `ia=${produto.relevancia_score ?? 'n/a'}`
  ];

  if (produto.principioativo_nome) {
    partes.push(`pa=${produto.principioativo_nome}`);
  }

  return `${partes.join(' | ')} | ${String(produto.descricao || '').substring(0, 90)}`;
}

function logResumoProdutos(etapa, produtos, limite = 5) {
  const lista = Array.isArray(produtos) ? produtos : [];
  console.log(`[TRACE] ${etapa} | total=${lista.length}`);

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

function logDistribuicao(etapa, produtos, campo) {
  const lista = Array.isArray(produtos) ? produtos : [];
  const contagem = new Map();

  lista.forEach(produto => {
    const chave = produto?.[campo] || 'SEM_VALOR';
    contagem.set(chave, (contagem.get(chave) || 0) + 1);
  });

  const resumo = [...contagem.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([chave, total]) => `${chave}:${total}`)
    .join(' | ');

  console.log(`[TRACE] ${etapa} | ${campo} => ${resumo || 'vazio'}`);
}

function pontuarProdutoPerfumaria(produto) {
  let score = Number(produto?.relevancia_descricao || 0);
  const descricao = normalizarTextoBuscaMedicamento(produto?.descricao || '');
  const temPrincipioAtivo = Boolean(produto?.principioativo_nome);
  const tipoClassificacao = String(produto?.tipo_classificacao_canonica || '').trim().toUpperCase();

  if (!temPrincipioAtivo) {
    score += 120;
  } else {
    score -= 80;
  }

  if (!tipoClassificacao || tipoClassificacao === 'DESCONHECIDO') {
    score += 60;
  } else {
    score -= 40;
  }

  if (/\b(shampoo|condicionador|hidratante|sabonete|perfume)\b/.test(descricao)) {
    score += 25;
  }

  return score;
}

function obterCategoriaNaoMedicamento(query) {
  const texto = normalizarTextoBuscaMedicamento(query);

  if (/\b(fralda|fraldas|frd)\b/.test(texto)) {
    return 'fralda';
  }

  if (/\b(shampoo|xampu|sh)\b/.test(texto)) {
    return 'shampoo';
  }

  if (/\b(absorvente|absorventes)\b/.test(texto)) {
    return 'absorvente';
  }

  return null;
}

function pontuarProdutoCategoriaNaoMedicamento(produto, query) {
  let score = pontuarProdutoPerfumaria(produto);
  const descricao = normalizarTextoBuscaMedicamento(produto?.descricao || '');
  const embalagem = normalizarTextoBuscaMedicamento(produto?.embalagem_descricao || '');
  const classificacao = normalizarTextoBuscaMedicamento(produto?.classificacao_nome_origem || '');
  const categoria = obterCategoriaNaoMedicamento(query);
  const queryNormalizada = normalizarTextoBuscaMedicamento(query);
  const textoProduto = `${descricao} ${embalagem} ${classificacao}`;

  if (categoria === 'fralda') {
    if (/\b(fralda|fraldas|frd)\b/.test(textoProduto)) {
      score += 160;
    }

    if (/\bfraldas\b/.test(classificacao) || /\bfralda\b/.test(classificacao)) {
      score += 180;
    }

    if (!/\bgeriatr/i.test(queryNormalizada) && /\bgeriatr/i.test(textoProduto)) {
      score -= 220;
    }

    if (!/\babsorvente\b/.test(queryNormalizada) && /\babsorvente\b/.test(textoProduto)) {
      score -= 260;
    }

    if (/\bfita\b/.test(textoProduto)) {
      score -= 280;
    }
  }

  if (categoria === 'shampoo') {
    if (/\bshampoo\b/.test(textoProduto)) {
      score += 140;
    }

    if (/\bshampoo\b/.test(classificacao)) {
      score += 160;
    }

    if (!/\bbaby\b/.test(queryNormalizada) && /\bbaby\b/.test(textoProduto)) {
      score -= 140;
    }

    if (/\bkit\b/.test(textoProduto)) {
      score -= 120;
    }
  }

  if (categoria === 'absorvente') {
    if (/\babsorvente\b/.test(textoProduto)) {
      score += 160;
    }

    if (/\bfralda|fraldas|frd\b/.test(textoProduto)) {
      score -= 180;
    }
  }

  return score;
}

function aplicarFiltroCategoriaNaoMedicamento(produtos, query) {
  const categoria = obterCategoriaNaoMedicamento(query);
  const lista = Array.isArray(produtos) ? produtos : [];

  if (!categoria || lista.length === 0) {
    return {
      produtos: lista,
      aplicado: false
    };
  }

  if (categoria === 'fralda') {
    const candidatosDiretos = lista.filter(produto => {
      const texto = normalizarTextoBuscaMedicamento(
        `${produto?.descricao || ''} ${produto?.embalagem_descricao || ''} ${produto?.classificacao_nome_origem || ''}`
      );

      if (!/\b(fralda|fraldas|frd)\b/.test(texto)) {
        return false;
      }

      if (/\bfita\b/.test(texto)) {
        return false;
      }

      if (/\babsorvente\b/.test(texto)) {
        return false;
      }

      if (/\bgeriatr/i.test(texto) && !/\bgeriatr/i.test(normalizarTextoBuscaMedicamento(query))) {
        return false;
      }

      return true;
    });

    if (candidatosDiretos.length > 0) {
      return {
        produtos: candidatosDiretos,
        aplicado: true
      };
    }
  }

  return {
    produtos: lista,
    aplicado: false
  };
}

function priorizarProdutosPerfumaria(produtos, query = '') {
  return [...(produtos || [])]
    .map(produto => ({
      ...produto,
      relevancia_descricao: pontuarProdutoCategoriaNaoMedicamento(produto, query)
    }))
    .sort((a, b) => {
      return Number(b.relevancia_descricao || 0) - Number(a.relevancia_descricao || 0)
        || String(a?.descricao || '').localeCompare(String(b?.descricao || ''));
    });
}

function reconstruirTermoComAtributos(termoBase, { formaFarmaceutica, concentracoesBusca } = {}) {
  const partes = [String(termoBase || '').trim()];

  if (formaFarmaceutica) {
    partes.push(String(formaFarmaceutica).trim());
  }

  (concentracoesBusca || []).forEach(concentracao => {
    partes.push(String(concentracao).trim());
  });

  return partes.filter(Boolean).join(' ').trim();
}

function deveExecutarFallbackDescricaoOriginal({ termoBusca, termoBuscaPrincipal, concentracoesBusca, correcaoAplicada }) {
  if (correcaoAplicada) {
    return false;
  }

  if (termoBuscaPrincipal === termoBusca) {
    return false;
  }

  if (Array.isArray(concentracoesBusca) && concentracoesBusca.length > 0) {
    return false;
  }

  return true;
}

function extrairAtributosProdutoBusca(produto) {
  const texto = `${produto?.descricao || ''} ${produto?.embalagem_descricao || ''}`;

  return {
    concentracoes: extrairConcentracoes(texto),
    formas: extrairFormasDeTexto(texto)
  };
}

function aplicarFiltroEstritoPorAtributos(produtos, contextoBusca) {
  let lista = Array.isArray(produtos) ? [...produtos] : [];
  const regrasAplicadas = [];
  const concentracoesSolicitadas = [...new Set(contextoBusca?.concentracoesBusca || [])];
  const formasSolicitadas = [...new Set(contextoBusca?.variacoesForma || [])];
  const formaCanonicaSolicitada = contextoBusca?.formaFarmaceutica
    ? normalizarTextoBuscaMedicamento(contextoBusca.formaFarmaceutica)
    : null;

  if (concentracoesSolicitadas.length > 0 && lista.length > 0) {
    const comMatchConcentracao = lista.filter(produto => {
      const atributos = extrairAtributosProdutoBusca(produto);
      return atributos.concentracoes.some(concentracao => concentracoesSolicitadas.includes(concentracao));
    });

    if (comMatchConcentracao.length > 0 && comMatchConcentracao.length < lista.length) {
      lista = comMatchConcentracao;
      regrasAplicadas.push(`concentracao:${concentracoesSolicitadas.join('|')}`);
    }
  }

  if ((formaCanonicaSolicitada || formasSolicitadas.length > 0) && lista.length > 0) {
    const formasSolicitadasNormalizadas = new Set([
      ...formasSolicitadas.map(item => normalizarTextoBuscaMedicamento(item)),
      formaCanonicaSolicitada
    ].filter(Boolean));

    const comMatchForma = lista.filter(produto => {
      const atributos = extrairAtributosProdutoBusca(produto);
      return atributos.formas.some(forma => formasSolicitadasNormalizadas.has(normalizarTextoBuscaMedicamento(forma)));
    });

    if (comMatchForma.length > 0 && comMatchForma.length < lista.length) {
      lista = comMatchForma;
      regrasAplicadas.push(`forma:${[...formasSolicitadasNormalizadas].join('|')}`);
    }
  }

  return {
    produtos: lista,
    aplicado: regrasAplicadas.length > 0,
    regrasAplicadas
  };
}

router.post('/api/buscar-medicamentos', async (req, res) => {
  try {
    const { query, unidade_negocio_id } = req.body;

    if (!query || query.trim() === '') {
      return res.status(400).json({ erro: 'Query vazia' });
    }

    const unidadeNegocioId = unidade_negocio_id || UNIDADE_NEGOCIO_ID_PADRAO;
    const termoBusca = query.trim().toLowerCase();

    console.log(`\n========================================`);
    console.log(`[BUSCA] Termo: "${termoBusca}"`);
    console.log(`[BUSCA] Unidade Negócio ID: ${unidadeNegocioId}`);
    console.log(`========================================`);

    const intencaoBusca = detectarIntencaoBusca(termoBusca);
    const {
      principioAtivoBusca: principioAtivoExtraido,
      termoBuscaLimpo,
      formaFarmaceutica,
      variacoesForma,
      concentracoesBusca,
      variacoesConcentracao
    } = extrairContextoBuscaMedicamento(termoBusca);
    let termoBuscaPrincipal = limparTermoBuscaPrincipal(termoBuscaLimpo)
      || limparTermoBuscaPrincipal(principioAtivoExtraido)
      || limparTermoBuscaPrincipal(termoBusca)
      || termoBuscaLimpo
      || principioAtivoExtraido
      || termoBusca;
    let principioAtivoBusca = termoBuscaPrincipal;
    let principioAtivoResolvido = null;
    const buscaPerfumaria = intencaoBusca.querPerfumaria === true;

    if (buscaPerfumaria) {
      termoBuscaPrincipal = termoBusca;
      principioAtivoBusca = termoBusca;
    }
    let correcaoTermo = null;

    const normalizacaoIA = await normalizarBuscaComIA({
      termoOriginal: termoBusca,
      termoBase: termoBuscaPrincipal,
      formaFarmaceutica,
      concentracoesBusca
    });

    if (
      normalizacaoIA?.termo_corrigido &&
      normalizacaoIA.manter_original !== true &&
      normalizacaoIA.confianca >= 0.9 &&
      normalizarTextoBusca(normalizacaoIA.termo_corrigido) !== normalizarTextoBusca(termoBuscaPrincipal)
    ) {
      console.log(
        `[TRACE] IA pre-busca normalizou termo: "${termoBuscaPrincipal}" -> "${normalizacaoIA.termo_corrigido}" ` +
        `| confianca=${normalizacaoIA.confianca.toFixed(3)} | motivo=${normalizacaoIA.justificativa_curta || 'n/a'}`
      );
      principioAtivoBusca = normalizacaoIA.termo_corrigido;
      correcaoTermo = {
        termo_original: termoBuscaPrincipal,
        termo_corrigido: normalizacaoIA.termo_corrigido,
        origem: 'ia_pre_busca',
        score: normalizacaoIA.confianca
      };
    }

    console.log(`[INFO] Termo principal de busca: "${termoBuscaPrincipal}"`);
    console.log(
      `[INFO] Intencao: generico=${intencaoBusca.querGenerico ? 'sim' : 'nao'} | ` +
      `referencia=${intencaoBusca.querReferencia ? 'sim' : 'nao'} | similar=${intencaoBusca.querSimilar ? 'sim' : 'nao'}`
    );

    console.log(`[INFO] Princípio ativo extraído: "${principioAtivoBusca}"`);
    console.log(`[INFO] Forma farmacêutica: "${formaFarmaceutica || 'nenhuma'}"`);

    if (concentracoesBusca.length > 0) {
      console.log(`[INFO] Concentracoes: ${concentracoesBusca.join(' | ')}`);
    }

    let produtosPrincipioAtivo = [];
    let produtosDescricao = [];
    let principiosEncontrados = [];
    let metodosUtilizados = [];
    let termoBuscaDescricao = principioAtivoBusca;
    let termoBuscaDescricaoExpandido = reconstruirTermoComAtributos(principioAtivoBusca, {
      formaFarmaceutica,
      concentracoesBusca
    });

    if (correcaoTermo?.origem === 'ia_pre_busca') {
      metodosUtilizados.push('ia_pre_busca');
    }

    let [resultadoPrincipioAtivo, resultadoDescricao] = await Promise.all([
      buscaPerfumaria
        ? Promise.resolve({ encontrado: false, produtos: [], principiosEncontrados: [], metodo: 'principio_ativo_ignorado_perfumaria' })
        : buscarPorPrincipioAtivo(principioAtivoBusca, formaFarmaceutica, variacoesForma, variacoesConcentracao),
      buscarPorDescricao(termoBuscaDescricao)
    ]);

    if (resultadoPrincipioAtivo.encontrado) {
      produtosPrincipioAtivo = resultadoPrincipioAtivo.produtos;
      principiosEncontrados = resultadoPrincipioAtivo.principiosEncontrados || [];
      metodosUtilizados.push(resultadoPrincipioAtivo.metodo);
      console.log(`[TRACE] Principios ativos encontrados: ${principiosEncontrados.map(p => p.nome).slice(0, 10).join(' | ') || 'nenhum'}`);
      logResumoProdutos('Resultado bruto por principio ativo', produtosPrincipioAtivo);
    }

    if (resultadoDescricao.produtos && resultadoDescricao.produtos.length > 0) {
      produtosDescricao = resultadoDescricao.produtos;
      metodosUtilizados.push(resultadoDescricao.metodo);
      logResumoProdutos('Resultado bruto por descricao', produtosDescricao);
    }

    if (buscaPerfumaria && produtosDescricao.length > 0) {
      const resultadoFiltroCategoriaDescricao = aplicarFiltroCategoriaNaoMedicamento(produtosDescricao, termoBusca);
      if (resultadoFiltroCategoriaDescricao.aplicado) {
        produtosDescricao = resultadoFiltroCategoriaDescricao.produtos;
        metodosUtilizados.push('filtro_categoria_nao_medicamento_descricao');
        logResumoProdutos('Resultado bruto por descricao apos filtro semantico de categoria', produtosDescricao);
      }
    }

    if (!resultadoPrincipioAtivo.encontrado && produtosDescricao.length === 0) {
      const sugestaoCorrecao = await sugerirCorrecaoTermo(termoBuscaPrincipal);

      if (sugestaoCorrecao?.termo_corrigido) {
        console.log(
          `[TRACE] Correcao automatica candidata: "${termoBuscaPrincipal}" -> "${sugestaoCorrecao.termo_corrigido}" ` +
          `| origem=${sugestaoCorrecao.origem} | score=${sugestaoCorrecao.score.toFixed(3)}`
        );

        const contextoCorrigido = extrairContextoBuscaMedicamento(sugestaoCorrecao.termo_corrigido);
        const termoCorrigidoPrincipal = limparTermoBuscaPrincipal(contextoCorrigido.termoBuscaLimpo)
          || limparTermoBuscaPrincipal(contextoCorrigido.principioAtivoBusca)
          || sugestaoCorrecao.termo_corrigido;
        const termoCorrigidoExpandido = reconstruirTermoComAtributos(termoCorrigidoPrincipal, {
          formaFarmaceutica: contextoCorrigido.formaFarmaceutica || formaFarmaceutica,
          concentracoesBusca
        });

        const [resultadoPrincipioCorrigido, resultadoDescricaoCorrigida] = await Promise.all([
          buscaPerfumaria
            ? Promise.resolve({ encontrado: false, produtos: [], principiosEncontrados: [], metodo: 'principio_ativo_ignorado_perfumaria' })
            : buscarPorPrincipioAtivo(
              termoCorrigidoPrincipal,
              contextoCorrigido.formaFarmaceutica || formaFarmaceutica,
              contextoCorrigido.variacoesForma.length > 0 ? contextoCorrigido.variacoesForma : variacoesForma,
              contextoCorrigido.variacoesConcentracao.length > 0
                ? contextoCorrigido.variacoesConcentracao
                : variacoesConcentracao
            ),
          buscarPorDescricao(termoCorrigidoExpandido)
        ]);

        if (resultadoPrincipioCorrigido.encontrado) {
          correcaoTermo = correcaoTermo || sugestaoCorrecao;
          resultadoPrincipioAtivo = resultadoPrincipioCorrigido;
          produtosPrincipioAtivo = resultadoPrincipioCorrigido.produtos;
          principiosEncontrados = resultadoPrincipioCorrigido.principiosEncontrados || [];
          metodosUtilizados.push(`correcao_termo_${resultadoPrincipioCorrigido.metodo}`);
          principioAtivoBusca = termoCorrigidoPrincipal;
          termoBuscaDescricao = termoCorrigidoPrincipal;
          termoBuscaDescricaoExpandido = termoCorrigidoExpandido;
        }

        if (resultadoDescricaoCorrigida.encontrado) {
          correcaoTermo = correcaoTermo || sugestaoCorrecao;
          resultadoDescricao = resultadoDescricaoCorrigida;
          produtosDescricao = resultadoDescricaoCorrigida.produtos;
          metodosUtilizados.push(`correcao_termo_${resultadoDescricaoCorrigida.metodo}`);
          termoBuscaDescricao = termoCorrigidoPrincipal;
          termoBuscaDescricaoExpandido = termoCorrigidoExpandido;
        }
      }
    }

    if (
      (!resultadoDescricao.produtos || resultadoDescricao.produtos.length === 0) &&
      deveExecutarFallbackDescricaoOriginal({
        termoBusca,
        termoBuscaPrincipal,
        concentracoesBusca,
        correcaoAplicada: correcaoTermo !== null
      })
    ) {
      console.log(`[TRACE] Fallback de descricao com termo original: "${termoBusca}"`);
      resultadoDescricao = await buscarPorDescricao(termoBusca);

      if (resultadoDescricao.produtos && resultadoDescricao.produtos.length > 0) {
        termoBuscaDescricao = termoBusca;
        termoBuscaDescricaoExpandido = termoBusca;
      }
    }

    const produtosDescricaoConfiaveis = buscaPerfumaria
      ? priorizarProdutosPerfumaria(produtosDescricao, termoBusca).slice(0, 60)
      : selecionarProdutosDescricaoConfiaveis(produtosDescricao, termoBuscaDescricao);
    const produtosDescricaoBase = produtosDescricaoConfiaveis.length > 0
      ? produtosDescricaoConfiaveis
      : produtosDescricao;
    if (produtosDescricaoConfiaveis.length > 0) {
      logResumoProdutos('Resultado confiavel por descricao', produtosDescricaoConfiaveis);
    }

    const principioResolvido = buscaPerfumaria
      ? null
      : resolverPrincipioAtivoDominante(produtosDescricaoConfiaveis, termoBuscaDescricao);
    if (principioResolvido && podeUsarPrincipioResolvido(principioResolvido, principioAtivoBusca || termoBuscaDescricao)) {
      principioAtivoResolvido = principioResolvido.nome;
      principioAtivoBusca = principioAtivoResolvido;
      console.log(
        `[TRACE] Principio ativo resolvido via descricao: "${principioAtivoResolvido}" ` +
        `| id=${principioResolvido.id} | ocorrencias=${principioResolvido.total}`
      );
    } else if (principioResolvido) {
      console.log(
        `[TRACE] Principio ativo resolvido via descricao ignorado por divergencia: "${principioResolvido.nome}" ` +
        `| id=${principioResolvido.id}`
      );
    }

    if (
      !buscaPerfumaria &&
      principioAtivoResolvido &&
      normalizarTextoBusca(principioAtivoResolvido) !== normalizarTextoBusca(principioAtivoExtraido) &&
      !resultadoPrincipioAtivo.encontrado
    ) {
      const resultadoPrincipioAtivoResolvido = await buscarPorPrincipioAtivo(
        principioAtivoResolvido,
        formaFarmaceutica,
        variacoesForma,
        variacoesConcentracao
      );

      if (resultadoPrincipioAtivoResolvido.encontrado) {
        produtosPrincipioAtivo = [...produtosPrincipioAtivo, ...resultadoPrincipioAtivoResolvido.produtos];
        principiosEncontrados = resultadoPrincipioAtivoResolvido.principiosEncontrados || [];
        metodosUtilizados.push('principio_ativo_resolvido_descricao');
        logResumoProdutos(
          'Resultado por principio ativo resolvido via descricao',
          resultadoPrincipioAtivoResolvido.produtos
        );
      }
    }

    const principioAtivoIdsDaDescricaoPrioritarios = buscaPerfumaria
      ? []
      : selecionarPrincipioIdsPreferenciaisDeProdutos(
        produtosDescricaoBase,
        principioAtivoBusca,
        {
          incluirCompostos: ehTextoComposto(principioAtivoBusca),
          limite: 10
        }
      );
    const principioAtivoIdsDaDescricao = buscaPerfumaria
      ? []
      : (principioAtivoIdsDaDescricaoPrioritarios.length > 0
        ? principioAtivoIdsDaDescricaoPrioritarios
        : [...new Set(
          produtosDescricaoBase
            .map(p => p.principioativo_id)
            .filter(id => id !== null && id !== undefined)
        )].slice(0, 10));

    if (!buscaPerfumaria && principioAtivoIdsDaDescricao.length > 0) {
      console.log(`[TRACE] IDs de principio ativo herdados da descricao: ${principioAtivoIdsDaDescricao.slice(0, 10).join(', ')}`);
      const resultadoExpandidoPorPrincipio = await buscarPorPrincipioAtivoIds(
        principioAtivoIdsDaDescricao.slice(0, 10),
        formaFarmaceutica,
        variacoesForma,
        variacoesConcentracao
      );

      if (resultadoExpandidoPorPrincipio.encontrado) {
        produtosPrincipioAtivo = [...produtosPrincipioAtivo, ...resultadoExpandidoPorPrincipio.produtos];
        metodosUtilizados.push(resultadoExpandidoPorPrincipio.metodo);
        logResumoProdutos('Resultado expandido por principio ativo vindo da descricao', resultadoExpandidoPorPrincipio.produtos);
      }
    }

    const produtosMap = new Map();

    produtosPrincipioAtivo.forEach(p => {
      produtosMap.set(p.id, { ...p, origem: 'principio_ativo' });
    });

    produtosDescricaoBase.forEach(p => {
      if (!produtosMap.has(p.id)) {
        produtosMap.set(p.id, { ...p, origem: 'descricao' });
      } else {
        const produto = produtosMap.get(p.id);
        produto.origem = 'ambos';
        produto.relevancia_descricao = p.relevancia_descricao;
        produtosMap.set(p.id, produto);
      }
    });

    let produtos = Array.from(produtosMap.values());

    if (buscaPerfumaria) {
      produtos = priorizarProdutosPerfumaria(produtos, termoBusca);
    } else {
      produtos.sort((a, b) => {
        const scoreA = a.relevancia_descricao || 0;
        const scoreB = b.relevancia_descricao || 0;
        return scoreB - scoreA;
      });
    }

    console.log(`[INFO] Total de produtos únicos combinados: ${produtos.length}`);
    logDistribuicao('Distribuicao apos merge', produtos, 'origem');
    logResumoProdutos('Produtos combinados apos merge e ordenacao SQL', produtos);

    if (produtos.length > 0) {
      if (buscaPerfumaria) {
        const resultadoFiltroCategoria = aplicarFiltroCategoriaNaoMedicamento(produtos, termoBusca);
        if (resultadoFiltroCategoria.aplicado) {
          produtos = priorizarProdutosPerfumaria(resultadoFiltroCategoria.produtos, termoBusca);
          metodosUtilizados.push('filtro_categoria_nao_medicamento');
          console.log('[TRACE] Filtro semantico de categoria nao-medicamento aplicado');
          logResumoProdutos('Produtos apos filtro semantico de categoria', produtos);
        }
      }

      produtos = await verificarDisponibilidade(produtos, unidadeNegocioId);
      console.log(`[INFO] Após verificação de estoque: ${produtos.length} produtos`);
      logResumoProdutos('Produtos apos filtro de estoque', produtos);
    }

    if (produtos.length > 0) {
      produtos = await enriquecerClassificacaoCanonica(produtos);
      logDistribuicao('Distribuicao apos classificacao canonica', produtos, 'tipo_classificacao_canonica');
      logResumoProdutos('Produtos apos enriquecimento de classificacao', produtos);
    }

    if (produtos.length > 0) {
      const resultadoFiltroAtributos = aplicarFiltroEstritoPorAtributos(produtos, {
        formaFarmaceutica,
        variacoesForma,
        concentracoesBusca,
        variacoesConcentracao
      });

      if (resultadoFiltroAtributos.aplicado) {
        produtos = resultadoFiltroAtributos.produtos;
        metodosUtilizados.push(`filtro_atributos_${resultadoFiltroAtributos.regrasAplicadas.join('__')}`);
        console.log(
          `[TRACE] Filtro estrito por atributos aplicado: ${resultadoFiltroAtributos.regrasAplicadas.join(' | ')}`
        );
        logResumoProdutos('Produtos apos filtro estrito por atributos', produtos);
      }
    }

    if (produtos.length > 0) {
      const resultadoFiltroClassificacao = aplicarFiltroPorIntencaoClassificacao(produtos, intencaoBusca);

      if (resultadoFiltroClassificacao.aplicado) {
        produtos = resultadoFiltroClassificacao.produtos;
        metodosUtilizados.push(`filtro_classificacao_${String(resultadoFiltroClassificacao.tipoSolicitado || '').toLowerCase()}`);
        console.log(
          `[TRACE] Filtro por intencao de classificacao aplicado: ${resultadoFiltroClassificacao.tipoSolicitado}`
        );
        logResumoProdutos('Produtos apos filtro por intencao de classificacao', produtos);
      } else if (resultadoFiltroClassificacao.tipoSolicitado) {
        console.log(
          `[TRACE] Nenhum produto da classificacao solicitada (${resultadoFiltroClassificacao.tipoSolicitado}) ` +
          `para aplicar filtro estrito`
        );
      }
    }

    let ordenadoPorIA = false;
    let filtradoPorIA = false;
    let avaliadoPorIA = false;
    let estatisticasIA = { aprovados: 0, rejeitados: 0, analisados: 0 };
    console.log(`[INFO] Iniciando IA para marcar candidatos`);
    if (produtos.length > 0 ) {
      logResumoProdutos('Candidatos enviados para etapa de IA', produtos);
      const resultadoIA = await ordenarPorIA(produtos, {
        termoBusca,
        termoBuscaPrincipal,
        principioAtivoBusca,
        formaFarmaceutica,
        intencaoClassificacao: intencaoBusca,
        buscaPerfumaria
      });
      produtos = resultadoIA.produtos;
      ordenadoPorIA = resultadoIA.ordenado;
      filtradoPorIA = resultadoIA.filtrado;
      avaliadoPorIA = resultadoIA.avaliado === true;
      estatisticasIA = resultadoIA.estatisticasIA || estatisticasIA;
      logResumoProdutos('Produtos apos marcacao da IA', produtos);
    }

    if (produtos.length > 0 && avaliadoPorIA && estatisticasIA.aprovados === 0) {
      console.log('[INFO] IA zerou relacionados - iniciando fallback por principio ativo + IDs');
      const resultadoFallback = await executarFallbackPorPrincipioAtivo({
        termoBusca,
        termoBuscaPrincipal,
        principioAtivoBusca,
        principioAtivoResolvido,
        produtosAtuais: produtos,
        formaFarmaceutica,
        variacoesForma,
        concentracoesBusca,
        variacoesConcentracao,
        unidadeNegocioId,
        intencaoBusca
      });

      if (resultadoFallback.aplicado) {
        const aprovadosFallback = resultadoFallback.resultadoIA?.estatisticasIA?.aprovados || 0;
        console.log(
          `[INFO] Fallback por principio ativo retornou ${resultadoFallback.produtos.length} produto(s) ` +
          `| relacionados=${aprovadosFallback}`
        );

        if (aprovadosFallback > 0) {
          produtos = resultadoFallback.produtos;
          ordenadoPorIA = resultadoFallback.resultadoIA.ordenado;
          filtradoPorIA = resultadoFallback.resultadoIA.filtrado;
          avaliadoPorIA = resultadoFallback.resultadoIA.avaliado === true;
          estatisticasIA = resultadoFallback.resultadoIA.estatisticasIA || estatisticasIA;
          metodosUtilizados.push('fallback_principio_ativo_ids');
          if (resultadoFallback.metodo) {
            metodosUtilizados.push(resultadoFallback.metodo);
          }
          logResumoProdutos('Produtos apos fallback por principio ativo', produtos);
        } else {
          console.log('[INFO] Fallback executado, mas sem ganho de relacionados aprovados');
        }
      }
    }

    const produtosParaClarificacao = produtos.filter(produto => produto.relacionado_busca !== false);
    console.log(
      `[CLARIFICACAO] Base considerada para clarificacao: ${produtosParaClarificacao.length} produto(s)`
    );
    const clarificacao = analisarNecessidadeDeClarificacao({
      query: termoBusca,
      produtos: produtosParaClarificacao
    });

    console.log(
      `[CLARIFICACAO] ${clarificacao.precisa_clarificar ? 'Necessaria' : 'Nao'} ` +
      `| Produtos analisados: ${clarificacao.total_produtos_analisados || 0}`
    );
    if (clarificacao.precisa_clarificar) {
      console.log(`[CLARIFICACAO] Pergunta: ${clarificacao.pergunta}`);
      console.log(`[CLARIFICACAO] Opcoes: ${(clarificacao.opcoes || []).join(' | ')}`);
    }

    const metodoBusca = metodosUtilizados.length > 0
      ? metodosUtilizados.join(' + ')
      : 'nenhum método encontrou resultados';
    const classificacoesDisponiveis = [...new Set(produtos.map(p => p.tipo_classificacao_canonica).filter(Boolean))];
    const classificacoesNaoMapeadas = [...new Set(
      produtos
        .filter(p => p.tipo_classificacao_canonica === 'DESCONHECIDO')
        .map(p => `${p.classificacao_id_origem || 'sem_id'}:${p.classificacao_nome_origem || 'sem_nome'}`)
    )];

    console.log(`\n========================================`);
    console.log(`[RESULTADO] ${produtos.length} produto(s) encontrado(s)`);
    console.log(`[RESULTADO] Métodos: ${metodoBusca}`);
    console.log(`[RESULTADO] Ordenado por IA: ${ordenadoPorIA ? 'Sim' : 'Não'}`);
    console.log(`[RESULTADO] Filtrado por IA: ${filtradoPorIA ? 'Sim' : 'Não'}`);
    console.log(`[RESULTADO] Avaliado por IA: ${avaliadoPorIA ? 'Sim' : 'Não'}`);
    console.log(
      `[RESULTADO] IA relacionados=${estatisticasIA.aprovados} | nao_relacionados=${estatisticasIA.rejeitados} | analisados=${estatisticasIA.analisados}`
    );
    logDistribuicao('Distribuicao final por origem', produtos, 'origem');
    logDistribuicao('Distribuicao final por classificacao', produtos, 'tipo_classificacao_canonica');
    logResumoProdutos('Resultado final retornado', produtos);
    console.log(`========================================\n`);

    return res.status(200).json({
      busca: {
        termo_original: termoBusca,
        termo_corrigido: correcaoTermo?.termo_corrigido || null,
        principio_ativo_extraido: principioAtivoResolvido || principioAtivoBusca || principioAtivoExtraido || null,
        forma_farmaceutica: formaFarmaceutica
      },
      metadados: {
        metodo_busca: metodoBusca,
        correcao_automatica_aplicada: correcaoTermo !== null,
        ordenado_por_ia: ordenadoPorIA,
        filtrado_por_ia: filtradoPorIA,
        avaliado_por_ia: avaliadoPorIA,
        produtos_relacionados_busca_ia: estatisticasIA.aprovados,
        produtos_nao_relacionados_busca_ia: estatisticasIA.rejeitados,
        produtos_analisados_ia: estatisticasIA.analisados,
        busca_ambigua: clarificacao.precisa_clarificar,
        total_produtos: produtos.length,
        unidade_negocio_id: unidadeNegocioId,
        classificacoes_disponiveis: classificacoesDisponiveis,
        classificacoes_nao_mapeadas: classificacoesNaoMapeadas
      },
      clarificacao,
      produtos: produtos.map(p => ({
        id: p.id,
        codigo: p.codigo,
        codigo_barras: p.codigobarras,
        descricao: p.descricao,
        principio_ativo: p.principioativo_nome || null,
        tipo_classificacao: p.tipo_classificacao_canonica || null,
        classificacao_id_origem: p.classificacao_id_origem || null,
        classificacao_nome_origem: p.classificacao_nome_origem || null,
        embalagem_id: p.embalagem_id,
        estoque_disponivel: p.estoque_disponivel || 0,
        relevancia_score: p.relevancia_score ?? p.relevancia_descricao ?? null,
        relacionado_busca: p.relacionado_busca ?? null,
        origem_busca: p.origem,
        precos: {
          preco_venda: p.precos?.preco_final_venda || null,
          tem_oferta_ativa: p.precos?.tem_oferta_ativa || false,
          preco_sem_desconto: p.precos?.preco_sem_desconto || null,
          preco_com_desconto: p.precos?.preco_com_desconto || null,
          desconto_percentual: p.precos?.desconto_oferta_percentual || null,
          nome_caderno_oferta: p.precos?.nome_caderno_oferta || null,
          tipo_oferta: p.precos?.tipo_oferta || null,
          leve: p.precos?.leve || null,
          pague: p.precos?.pague || null,
          oferta_inicio: p.precos?.oferta_inicio || null,
          oferta_fim: p.precos?.oferta_fim || null,
          preco_referencial_geral: p.precos?.preco_referencial_geral || null,
          preco_venda_geral: p.precos?.preco_venda_geral || null,
          preco_referencial_loja: p.precos?.preco_referencial_loja || null,
          preco_venda_loja: p.precos?.preco_venda_loja || null,
          markup_geral: p.precos?.markup_geral || null,
          markup_loja: p.precos?.markup_loja || null,
          plugpharma_preco_controlado: p.precos?.plugpharma_preco_controlado || null
        }
      }))
    });
  } catch (error) {
    console.error('❌ Erro ao buscar medicamento:', error);
    return res.status(500).json({
      erro: 'Erro ao processar busca',
      detalhes: error.message
    });
  }
});

router.get('/', (req, res) => {
  res.json({ mensagem: 'API de busca de medicamentos está rodando!' });
});

module.exports = { router };
