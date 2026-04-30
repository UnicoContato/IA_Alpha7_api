const { pool } = require('./pool');
const { expandirAbreviacoes, gerarCondicoesBuscaComRanking } = require('../../abreviacoes');
const { gerarVariacoesPrincipioAtivo } = require('../utils/searchUtils');

const STOPWORDS_ATIVO = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'para', 'por',
  'mg', 'ml', 'mcg', 'g', 'ui', 'cp', 'cps', 'caps', 'comp'
]);
const SUFIXOS_DESCARTAVEIS_CORRECAO = new Set([
  'sodica', 'sodico', 'potassica', 'potassico', 'monoidratada', 'monoidratado',
  'monohidratada', 'monohidratado', 'hidratada', 'hidratado', 'cloridrato',
  'cloridrato', 'maleato', 'besilato', 'dicloridrato', 'hemifumarato', 'nimesulida'
]);

function normalizarTextoBusca(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/+.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairTokensBusca(valor) {
  return normalizarTextoBusca(valor)
    .split(' ')
    .filter(token => token.length >= 3 && !STOPWORDS_ATIVO.has(token));
}

function tokensSaoCompativeis(tokenBusca, tokenCandidato) {
  if (!tokenBusca || !tokenCandidato) {
    return false;
  }

  if (tokenBusca === tokenCandidato) {
    return true;
  }

  const menor = Math.min(tokenBusca.length, tokenCandidato.length);
  if (menor < 4) {
    return false;
  }

  return tokenBusca.startsWith(tokenCandidato) || tokenCandidato.startsWith(tokenBusca);
}

function pontuarNomePrincipioAtivo(nomePrincipio, termosBusca) {
  const nomeNormalizado = normalizarTextoBusca(nomePrincipio);
  const tokensNome = extrairTokensBusca(nomePrincipio);
  let score = 0;

  (termosBusca || []).forEach(termo => {
    const termoNormalizado = normalizarTextoBusca(termo);
    const tokensTermo = extrairTokensBusca(termo);

    if (termoNormalizado && nomeNormalizado.includes(termoNormalizado)) {
      score += 200;
    }

    let tokensCompativeis = 0;
    tokensTermo.forEach(token => {
      const combinou = tokensNome.some(tokenNome => tokensSaoCompativeis(token, tokenNome));
      if (combinou) {
        tokensCompativeis += 1;
        score += 25;
      }
    });

    if (tokensTermo.length > 0 && tokensCompativeis === tokensTermo.length) {
      score += 80;
    }
  });

  return score;
}

function removerDuplicacaoSequencial(token) {
  return String(token || '').replace(/(.)\1+/g, '$1');
}

function gerarVariantesCorrecaoToken(token) {
  const base = normalizarTextoBusca(token);
  const variantes = new Set();

  if (!base || base.length < 4) {
    return [];
  }

  variantes.add(base);
  variantes.add(removerDuplicacaoSequencial(base));
  variantes.add(base.slice(0, 4));
  variantes.add(base.slice(0, 5));
  variantes.add(base.slice(0, 6));

  [
    ['z', 's'],
    ['s', 'z'],
    ['y', 'i'],
    ['i', 'y'],
    ['k', 'c'],
    ['c', 'k'],
    ['p', 'r'],
    ['r', 'p']
  ].forEach(([origem, destino]) => {
    if (base.includes(origem)) {
      variantes.add(base.replace(new RegExp(origem, 'g'), destino));
    }
  });

  if (base.endsWith('oo') || base.endsWith('aa')) {
    variantes.add(base.slice(0, -1));
  }

  return [...variantes].filter(item => item.length >= 4);
}

function gerarFragmentosCorrecao(termo) {
  const tokens = extrairTokensBusca(termo);
  const fragmentos = new Set();

  tokens.forEach(token => {
    gerarVariantesCorrecaoToken(token).forEach(variante => {
      if (variante.length >= 4) {
        fragmentos.add(variante.slice(0, 4));
      }

      if (variante.length >= 5) {
        fragmentos.add(variante.slice(0, 5));
        fragmentos.add(variante.slice(-4));
      }

      for (let idx = 0; idx <= variante.length - 3; idx += 1) {
        fragmentos.add(variante.slice(idx, idx + 3));
      }
    });
  });

  return [...fragmentos].filter(Boolean).slice(0, 18);
}

function levenshtein(a, b) {
  const origem = normalizarTextoBusca(a);
  const destino = normalizarTextoBusca(b);

  if (!origem) {
    return destino.length;
  }

  if (!destino) {
    return origem.length;
  }

  const matriz = Array.from({ length: origem.length + 1 }, () => new Array(destino.length + 1).fill(0));

  for (let i = 0; i <= origem.length; i += 1) {
    matriz[i][0] = i;
  }

  for (let j = 0; j <= destino.length; j += 1) {
    matriz[0][j] = j;
  }

  for (let i = 1; i <= origem.length; i += 1) {
    for (let j = 1; j <= destino.length; j += 1) {
      const custo = origem[i - 1] === destino[j - 1] ? 0 : 1;
      matriz[i][j] = Math.min(
        matriz[i - 1][j] + 1,
        matriz[i][j - 1] + 1,
        matriz[i - 1][j - 1] + custo
      );
    }
  }

  return matriz[origem.length][destino.length];
}

function calcularScoreCorrecao(termo, candidato) {
  const termoNormalizado = normalizarTextoBusca(termo);
  const candidatoNormalizado = normalizarTextoBusca(candidato);
  const distancia = levenshtein(termoNormalizado, candidatoNormalizado);
  const tamanhoBase = Math.max(termoNormalizado.length, candidatoNormalizado.length, 1);
  const similaridade = 1 - (distancia / tamanhoBase);
  let score = similaridade;

  if (candidatoNormalizado.startsWith(termoNormalizado) || termoNormalizado.startsWith(candidatoNormalizado)) {
    score += 0.08;
  }

  const tokensTermo = extrairTokensBusca(termoNormalizado);
  const tokensCandidato = extrairTokensBusca(candidatoNormalizado);
  if (
    tokensTermo.length > 0 &&
    tokensTermo.every(token => tokensCandidato.some(item => tokensSaoCompativeis(token, item)))
  ) {
    score += 0.08;
  }

  return {
    score,
    similaridade,
    distancia
  };
}

function gerarVariantesCanonicasCorrecao(candidato) {
  const texto = normalizarTextoBusca(candidato);
  if (!texto) {
    return [];
  }

  const tokens = extrairTokensBusca(texto);
  const tokensCanonicos = tokens.filter(token => !SUFIXOS_DESCARTAVEIS_CORRECAO.has(token));
  const baseCanonica = tokensCanonicos.length > 0 ? tokensCanonicos : tokens;
  const variantes = new Set([texto]);

  if (baseCanonica.length > 0) {
    variantes.add(baseCanonica.join(' '));
    variantes.add(baseCanonica[0]);
  }

  if (baseCanonica.length >= 2) {
    variantes.add(baseCanonica.slice(0, 2).join(' '));
  }

  return [...variantes].filter(Boolean);
}

async function buscarCandidatosCorrecaoTermo(termoBusca, limite = 80) {
  const fragmentos = gerarFragmentosCorrecao(termoBusca);
  if (fragmentos.length === 0) {
    return [];
  }

  const nomeNormalizadoPrincipio = `
    lower(
      translate(
        coalesce(nome, ''),
        'ÃÃ€ÃƒÃ‚Ã„Ã¡Ã Ã£Ã¢Ã¤Ã‰ÃˆÃŠÃ‹Ã©Ã¨ÃªÃ«ÃÃŒÃŽÃÃ­Ã¬Ã®Ã¯Ã“Ã’Ã•Ã”Ã–Ã³Ã²ÃµÃ´Ã¶ÃšÃ™Ã›ÃœÃºÃ¹Ã»Ã¼Ã‡Ã§',
        'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc'
      )
    )
  `;
  const descricaoNormalizada = `
    lower(
      translate(
        coalesce(p.descricao, ''),
        'ÃÃ€ÃƒÃ‚Ã„Ã¡Ã Ã£Ã¢Ã¤Ã‰ÃˆÃŠÃ‹Ã©Ã¨ÃªÃ«ÃÃŒÃŽÃÃ­Ã¬Ã®Ã¯Ã“Ã’Ã•Ã”Ã–Ã³Ã²ÃµÃ´Ã¶ÃšÃ™Ã›ÃœÃºÃ¹Ã»Ã¼Ã‡Ã§',
        'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc'
      )
    )
  `;
  const condicoesPrincipio = fragmentos.map((_, idx) => `${nomeNormalizadoPrincipio} LIKE $${idx + 1}`).join(' OR ');
  const condicoesDescricao = fragmentos.map((_, idx) => `${descricaoNormalizada} LIKE $${idx + 1}`).join(' OR ');
  const params = fragmentos.map(fragmento => `%${fragmento}%`);

  const [principios, produtos] = await Promise.all([
    pool.query(`
      SELECT DISTINCT nome AS texto_candidato, 'principio_ativo' AS origem
      FROM principioativo
      WHERE ${condicoesPrincipio}
      ORDER BY nome
      LIMIT ${limite}
    `, params),
    pool.query(`
      SELECT DISTINCT p.descricao AS texto_candidato, 'descricao_produto' AS origem
      FROM produto p
      WHERE p.status = 'A'
        AND ${condicoesDescricao}
      ORDER BY p.descricao
      LIMIT ${limite}
    `, params)
  ]);

  return [...principios.rows, ...produtos.rows];
}

async function sugerirCorrecaoTermo(termoBusca) {
  const termoNormalizado = normalizarTextoBusca(termoBusca);
  const termosPrioritarios = [
    termoBusca,
    ...gerarVariantesCorrecaoToken(termoBusca)
  ];
  const principiosPrioritarios = await buscarPrincipiosAtivosPorTermoFlexivel(termosPrioritarios, 20);
  const candidatosPrincipio = principiosPrioritarios.map(item => ({
    texto_candidato: item.nome,
    origem: 'principio_ativo_flexivel'
  }));
  const candidatosDescricao = await buscarCandidatosCorrecaoTermo(termoBusca);
  const candidatos = [...candidatosPrincipio, ...candidatosDescricao];

  if (!termoNormalizado || candidatos.length === 0) {
    return null;
  }

  const melhor = candidatos
    .flatMap(candidato => {
      const textoCandidato = String(candidato?.texto_candidato || '').trim();

      return gerarVariantesCanonicasCorrecao(textoCandidato).map(variante => {
        const { score, similaridade, distancia } = calcularScoreCorrecao(termoNormalizado, variante);

        return {
          termo_original: termoBusca,
          termo_corrigido: variante.toUpperCase(),
          origem: candidato.origem,
          score,
          similaridade,
          distancia,
          candidato_original: textoCandidato
        };
      });
    })
    .filter(item => item.distancia > 0)
    .sort((a, b) => {
      return b.score - a.score
        || a.distancia - b.distancia
        || String(a.candidato_original || '').length - String(b.candidato_original || '').length
        || String(a.termo_corrigido).localeCompare(String(b.termo_corrigido));
    })[0];

  if (!melhor) {
    return null;
  }

  const tamanho = termoNormalizado.length;
  const distanciaMaxima = tamanho >= 9 ? 3 : 2;
  const scoreMinimo = tamanho >= 8 ? 0.74 : 0.78;

  if (melhor.distancia > distanciaMaxima || melhor.score < scoreMinimo) {
    return null;
  }

  return melhor;
}

function adicionarFiltrosDescricao(queryProdutos, params, startIdx, { variacoesForma = [], variacoesConcentracao = [] } = {}) {
  const filtros = [];
  let indiceAtual = startIdx;

  if (Array.isArray(variacoesForma) && variacoesForma.length > 0) {
    const formaPlaceholders = variacoesForma.map((_, idx) => (
      `(p.descricao ILIKE $${indiceAtual + idx} OR em.descricao ILIKE $${indiceAtual + idx})`
    ));

    filtros.push(`(${formaPlaceholders.join(' OR ')})`);
    params.push(...variacoesForma.map(v => `%${v}%`));
    indiceAtual += variacoesForma.length;
  }

  if (Array.isArray(variacoesConcentracao) && variacoesConcentracao.length > 0) {
    const concentracaoPlaceholders = variacoesConcentracao.map((_, idx) => (
      `(p.descricao ILIKE $${indiceAtual + idx} OR em.descricao ILIKE $${indiceAtual + idx})`
    ));

    filtros.push(`(${concentracaoPlaceholders.join(' OR ')})`);
    params.push(...variacoesConcentracao.map(v => `%${v}%`));
    indiceAtual += variacoesConcentracao.length;
  }

  if (filtros.length > 0) {
    queryProdutos += ` AND ${filtros.join(' AND ')}`;
  }

  return queryProdutos;
}

function montarQueryBaseProdutosPorPrincipio(principioPlaceholders) {
  return `
    SELECT
      p.id,
      p.codigo,
      p.descricao,
      p.status,
      p.registroms,
      p.fabricanteid,
      pa.id as principioativo_id,
      pa.nome as principioativo_nome,
      em.id as embalagem_id,
      em.descricao as embalagem_descricao,
      em.codigobarras
    FROM produto p
    INNER JOIN principioativo pa ON p.principioativoid = pa.id
    INNER JOIN embalagem em ON em.produtoid = p.id
    WHERE pa.id IN (${principioPlaceholders})
      AND p.status = 'A'
  `;
}

async function buscarProdutosPorPrincipioIdsComFallback(
  principioIds,
  {
    variacoesForma = [],
    variacoesConcentracao = [],
    limite = 100,
    etapaLog = 'ETAPA 2'
  } = {}
) {
  const principioPlaceholders = principioIds.map((_, idx) => `$${idx + 1}`).join(',');
  const filtrosProgressivos = [];
  const filtrosVistos = new Set();

  function registrarFiltro(nome, forma, concentracao) {
    const formaNormalizada = Array.isArray(forma) ? forma.filter(Boolean) : [];
    const concentracaoNormalizada = Array.isArray(concentracao) ? concentracao.filter(Boolean) : [];
    const chave = JSON.stringify([formaNormalizada, concentracaoNormalizada]);

    if (filtrosVistos.has(chave)) {
      return;
    }

    filtrosVistos.add(chave);
    filtrosProgressivos.push({
      nome,
      variacoesForma: formaNormalizada,
      variacoesConcentracao: concentracaoNormalizada
    });
  }

  if (variacoesForma.length > 0 && variacoesConcentracao.length > 0) {
    registrarFiltro('forma_e_concentracao', variacoesForma, variacoesConcentracao);
  }

  if (variacoesForma.length > 0) {
    registrarFiltro('forma', variacoesForma, []);
  }

  if (variacoesConcentracao.length > 0) {
    registrarFiltro('concentracao', [], variacoesConcentracao);
  }

  registrarFiltro('sem_filtros', [], []);

  for (const filtro of filtrosProgressivos) {
    let queryProdutos = montarQueryBaseProdutosPorPrincipio(principioPlaceholders);
    const params = [...principioIds];

    queryProdutos = adicionarFiltrosDescricao(
      queryProdutos,
      params,
      principioIds.length + 1,
      filtro
    );
    queryProdutos += ` ORDER BY p.descricao LIMIT ${limite}`;

    if (filtro.variacoesForma.length > 0) {
      console.log(`[${etapaLog}] Filtrando por formas: ${filtro.variacoesForma.join(', ')}`);
    }

    if (filtro.variacoesConcentracao.length > 0) {
      console.log(`[${etapaLog}] Filtrando por concentracoes: ${filtro.variacoesConcentracao.join(', ')}`);
    }

    const resultado = await pool.query(queryProdutos, params);
    if (resultado.rows.length > 0) {
      if (filtro.nome !== 'sem_filtros') {
        console.log(
          `[${etapaLog}] Encontrados ${resultado.rows.length} produtos com filtro ${filtro.nome}`
        );
      }

      return {
        rows: resultado.rows,
        filtroAplicado: filtro.nome
      };
    }

    if (filtro.nome !== 'sem_filtros') {
      console.log(`[${etapaLog}] Nenhum produto com filtro ${filtro.nome}, relaxando busca...`);
    }
  }

  return {
    rows: [],
    filtroAplicado: 'sem_resultados'
  };
}

async function buscarPrincipiosAtivosPorTermoFlexivel(termosBusca, limite = 30) {
  const listaTermos = [...new Set(
    (Array.isArray(termosBusca) ? termosBusca : [termosBusca])
      .map(item => String(item || '').trim())
      .filter(Boolean)
  )];

  const tokens = [...new Set(listaTermos.flatMap(extrairTokensBusca))];
  if (tokens.length === 0) {
    return [];
  }

  const nomeNormalizado = `
    lower(
      translate(
        coalesce(nome, ''),
        'ÁÀÃÂÄáàãâäÉÈÊËéèêëÍÌÎÏíìîïÓÒÕÔÖóòõôöÚÙÛÜúùûüÇç',
        'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc'
      )
    )
  `;

  const condicoes = tokens.map((_, idx) => `${nomeNormalizado} LIKE $${idx + 1}`).join(' OR ');
  const params = tokens.map(token => `%${token}%`);

  const resultado = await pool.query(`
    SELECT DISTINCT id, nome
    FROM principioativo
    WHERE ${condicoes}
    ORDER BY nome
    LIMIT 250
  `, params);

  return resultado.rows
    .map(row => ({
      ...row,
      score_flexivel: pontuarNomePrincipioAtivo(row.nome, listaTermos)
    }))
    .filter(row => row.score_flexivel > 0)
    .sort((a, b) => b.score_flexivel - a.score_flexivel || String(a.nome).localeCompare(String(b.nome)))
    .slice(0, limite);
}

async function buscarPrecosEOfertas(embalagemIds, unidadeNegocioId) {
  console.log(`\n[PREÇOS] Buscando preços e ofertas para ${embalagemIds.length} embalagens...`);

  if (embalagemIds.length === 0) {
    return {};
  }

  try {
    const placeholders = embalagemIds.map((_, idx) => `$${idx + 1}`).join(',');

    const query = `
      SELECT 
        em.id as embalagem_id,
        
        -- Preços da tabela EMBALAGEM (padrão geral)
        em.precoreferencial as preco_referencial_geral,
        em.precovenda as preco_venda_geral,
        em.markup as markup_geral,
        
        -- Preços específicos da UNIDADE DE NEGÓCIO
        peu.precoreferencial as preco_referencial_loja,
        peu.precovenda as preco_venda_loja,
        peu.markup as markup_loja,
        peu.plugpharmaprecocontrolado,
        
        -- Melhor oferta ativa
        mo.precooferta as preco_melhor_oferta,
        mo.descontooferta as desconto_oferta_percentual,
        mo.precounitariosemdesconto as preco_sem_desconto,
        mo.precounitariocomdesconto as preco_com_desconto,
        mo.vigenciainicio as oferta_inicio,
        mo.vigenciatermino as oferta_fim,
        ico_ativo.precooferta as preco_item_caderno_ativo,
        ico_ativo.descontooferta as desconto_item_caderno_ativo,
        co_ativo.datahorainicial as caderno_ativo_inicio,
        co_ativo.datahorafinal as caderno_ativo_fim,
        
        -- Caderno de oferta relacionado
        COALESCE(co.nome, co_ativo.nome) as nome_caderno_oferta,
        COALESCE(ico.tipooferta, ico_ativo.tipooferta) as tipooferta,
        COALESCE(ico.leve, ico_ativo.leve) as leve,
        COALESCE(ico.pague, ico_ativo.pague) as pague,
        
        -- Preço FINAL (lógica de prioridade)
        CASE
          WHEN mo.precooferta IS NOT NULL 
            AND (mo.vigenciatermino IS NULL OR mo.vigenciatermino >= NOW())
          THEN mo.precooferta
          WHEN ico_ativo.precooferta IS NOT NULL
          THEN ico_ativo.precooferta
          WHEN peu.precovenda IS NOT NULL 
          THEN peu.precovenda
          ELSE em.precovenda
        END as preco_final_venda,
        
        -- Indicador de oferta ativa
        CASE
          WHEN mo.precooferta IS NOT NULL 
            AND (mo.vigenciatermino IS NULL OR mo.vigenciatermino >= NOW())
          THEN true
          WHEN ico_ativo.precooferta IS NOT NULL OR ico_ativo.descontooferta IS NOT NULL
          THEN true
          ELSE false
        END as tem_oferta_ativa

      FROM embalagem em
      
      LEFT JOIN precoembalagemunidadenegocio peu 
        ON peu.embalagemid = em.id 
        AND peu.unidadenegocioid = $${embalagemIds.length + 1}
      
      LEFT JOIN melhoroferta mo 
        ON mo.embalagemid = em.id 
        AND mo.unidadenegocioid = $${embalagemIds.length + 1}
        AND (mo.vigenciatermino IS NULL OR mo.vigenciatermino >= NOW())
      
      LEFT JOIN itemcadernooferta ico 
        ON ico.id = (
          SELECT ico2.id 
          FROM itemcadernooferta ico2
          WHERE ico2.embalagemid = em.id 
            AND ico2.cadernoofertaid = mo.cadernoofertaid
          LIMIT 1
        )
      
      LEFT JOIN cadernooferta co 
        ON co.id = mo.cadernoofertaid

      LEFT JOIN LATERAL (
        SELECT ico2.*
        FROM itemcadernooferta ico2
        INNER JOIN cadernooferta co2 
          ON co2.id = ico2.cadernoofertaid
        INNER JOIN unidadenegocioparticipantecadernooferta un2
          ON un2.cadernoofertaid = co2.id
         AND un2.unidadenegocioid = $${embalagemIds.length + 1}
        WHERE ico2.embalagemid = em.id
          AND co2.status = 'A'
          AND co2.datahorainicial <= NOW()
          AND (co2.datahorafinal IS NULL OR co2.datahorafinal >= NOW())
        ORDER BY
          CASE WHEN ico2.precooferta IS NOT NULL THEN 0 ELSE 1 END,
          co2.datahorafinal DESC NULLS LAST,
          ico2.id DESC
        LIMIT 1
      ) ico_ativo ON true

      LEFT JOIN cadernooferta co_ativo
        ON co_ativo.id = ico_ativo.cadernoofertaid
      
      WHERE em.id IN (${placeholders})
    `;

    const params = [...embalagemIds, unidadeNegocioId];
    const resultado = await pool.query(query, params);

    const precosMap = {};
    resultado.rows.forEach(row => {
      precosMap[row.embalagem_id] = {
        preco_referencial_geral: parseFloat(row.preco_referencial_geral) || null,
        preco_venda_geral: parseFloat(row.preco_venda_geral) || null,
        markup_geral: parseFloat(row.markup_geral) || null,
        preco_referencial_loja: parseFloat(row.preco_referencial_loja) || null,
        preco_venda_loja: parseFloat(row.preco_venda_loja) || null,
        markup_loja: parseFloat(row.markup_loja) || null,
        plugpharma_preco_controlado: parseFloat(row.plugpharmaprecocontrolado) || null,
        preco_melhor_oferta: parseFloat(row.preco_melhor_oferta) || parseFloat(row.preco_item_caderno_ativo) || null,
        desconto_oferta_percentual: parseFloat(row.desconto_oferta_percentual) || parseFloat(row.desconto_item_caderno_ativo) || null,
        preco_sem_desconto: parseFloat(row.preco_sem_desconto) || parseFloat(row.preco_venda_loja) || parseFloat(row.preco_venda_geral) || null,
        preco_com_desconto: parseFloat(row.preco_com_desconto) || parseFloat(row.preco_item_caderno_ativo) || null,
        oferta_inicio: row.oferta_inicio || row.caderno_ativo_inicio,
        oferta_fim: row.oferta_fim || row.caderno_ativo_fim,
        nome_caderno_oferta: row.nome_caderno_oferta,
        tipo_oferta: row.tipooferta,
        leve: row.leve,
        pague: row.pague,
        preco_final_venda: parseFloat(row.preco_final_venda) || null,
        tem_oferta_ativa: row.tem_oferta_ativa || false
      };
    });

    console.log(`[PREÇOS] ✅ Encontrados preços para ${Object.keys(precosMap).length} embalagens`);
    const comOferta = Object.values(precosMap).filter(p => p.tem_oferta_ativa).length;
    if (comOferta > 0) {
      console.log(`[PREÇOS] 🎯 ${comOferta} produto(s) com oferta ativa`);
    }

    return precosMap;
  } catch (error) {
    console.error(`[PREÇOS] ⚠️ Erro:`, error.message);
    return {};
  }
}

async function buscarPorDescricao(termoBusca) {
  console.log(`\n[ETAPA 1] Buscando por DESCRIÇÃO: "${termoBusca}"`);

  try {
    const variacoes = expandirAbreviacoes(termoBusca);

    console.log(`[ETAPA 1] 🔍 Variações geradas: ${variacoes.length}`);
    variacoes.forEach((v, idx) => {
      console.log(`         ${idx + 1}. "${v}"`);
    });

    const { condicoes, parametros, relevanciaSQL, orderBy } = gerarCondicoesBuscaComRanking(variacoes);

    const query = `
      SELECT 
        p.id,
        p.codigo,
        p.descricao,
        p.status,
        p.registroms,
        p.fabricanteid,
        pa.id as principioativo_id,
        pa.nome as principioativo_nome,
        em.id as embalagem_id,
        em.descricao as embalagem_descricao,
        em.codigobarras,
        ${relevanciaSQL} as relevancia_descricao
      FROM produto p
      LEFT JOIN principioativo pa ON p.principioativoid = pa.id
      INNER JOIN embalagem em ON em.produtoid = p.id
      WHERE (${condicoes})
        AND p.status = 'A'
      ORDER BY ${orderBy}
      LIMIT 100
    `;

    const resultado = await pool.query(query, parametros);

    if (resultado.rows.length > 0) {
      console.log(`[ETAPA 1] ✅ Encontrados ${resultado.rows.length} produtos`);
      console.log(`[ETAPA 1] Top 3 por relevância:`);
      resultado.rows.slice(0, 3).forEach((p, idx) => {
        console.log(`         ${idx + 1}. [${p.relevancia_descricao}pts] ${p.descricao.substring(0, 60)}`);
      });

      return {
        encontrado: true,
        produtos: resultado.rows,
        metodo: 'descricao',
        variacoes_usadas: variacoes
      };
    }

    console.log(`[ETAPA 1] ❌ Nenhum produto encontrado`);
    return {
      encontrado: false,
      produtos: [],
      metodo: 'descricao',
      variacoes_usadas: variacoes
    };
  } catch (error) {
    console.error(`[ETAPA 1] ⚠️ Erro:`, error.message);
    throw error;
  }
}

async function buscarPorPrincipioAtivoLegado(principioAtivo, formaFarmaceutica, variacoesForma, variacoesConcentracao = []) {
  console.log(`\n[ETAPA 2] Buscando por PRINCÍPIO ATIVO: "${principioAtivo}"`);

  try {
    const resultadoPrincipios = { rows: [] };
    const principiosEncontrados = (resultadoPrincipios.rows = await buscarPrincipiosAtivosPorTermoFlexivel(principioAtivo));

    if (principiosEncontrados.length === 0) {
      console.log(`[ETAPA 2] ❌ Nenhum princípio ativo encontrado`);
      return {
        encontrado: false,
        produtos: [],
        principiosEncontrados: [],
        metodo: 'principio_ativo'
      };
    }

    console.log(`[ETAPA 2] 📋 Encontrados ${resultadoPrincipios.rows.length} princípios ativos`);
    const principioIds = principiosEncontrados.map(p => p.id);
    const principioPlaceholders = principioIds.map((_, idx) => `$${idx + 1}`).join(',');

    let queryProdutos = `
      SELECT 
        p.id,
        p.codigo,
        p.descricao,
        p.status,
        p.registroms,
        p.fabricanteid,
        pa.id as principioativo_id,
        pa.nome as principioativo_nome,
        em.id as embalagem_id,
        em.descricao as embalagem_descricao,
        em.codigobarras
      FROM produto p
      INNER JOIN principioativo pa ON p.principioativoid = pa.id
      INNER JOIN embalagem em ON em.produtoid = p.id
      WHERE pa.id IN (${principioPlaceholders})
        AND p.status = 'A'
    `;

    let params = [...principioIds];

    if (formaFarmaceutica && variacoesForma.length > 0) {
      const startIdx = principioIds.length + 1;
      const formaPlaceholders = variacoesForma.map((_, idx) => `p.descricao ILIKE $${startIdx + idx}`).join(' OR ');
      queryProdutos += ` AND (${formaPlaceholders})`;
      params.push(...variacoesForma.map(v => `%${v}%`));
      console.log(`[ETAPA 2] 🔍 Filtrando por formas: ${variacoesForma.join(', ')}`);
    }

    queryProdutos += ` ORDER BY p.descricao LIMIT 100`;

    const resultadoProdutos = await pool.query(queryProdutos, params);

    if (resultadoProdutos.rows.length === 0 && formaFarmaceutica) {
      console.log(`[ETAPA 2] 🔄 Tentando sem filtro de forma...`);

      const querySemForma = `
        SELECT 
          p.id,
          p.codigo,
          p.descricao,
          p.status,
          p.registroms,
          p.fabricanteid,
          pa.id as principioativo_id,
          pa.nome as principioativo_nome,
          em.id as embalagem_id,
          em.descricao as embalagem_descricao,
          em.codigobarras
        FROM produto p
        INNER JOIN principioativo pa ON p.principioativoid = pa.id
        INNER JOIN embalagem em ON em.produtoid = p.id
        WHERE pa.id IN (${principioPlaceholders})
          AND p.status = 'A'
        ORDER BY p.descricao
        LIMIT 100
      `;

      const resultadoSemForma = await pool.query(querySemForma, principioIds);

      if (resultadoSemForma.rows.length > 0) {
        console.log(`[ETAPA 2] ✅ Encontrados ${resultadoSemForma.rows.length} produtos (sem forma)`);
        return {
          encontrado: true,
          produtos: resultadoSemForma.rows,
          principiosEncontrados,
          metodo: 'principio_ativo_sem_forma'
        };
      }
    } else if (resultadoProdutos.rows.length > 0) {
      console.log(`[ETAPA 2] ✅ Encontrados ${resultadoProdutos.rows.length} produtos`);
      return {
        encontrado: true,
        produtos: resultadoProdutos.rows,
        principiosEncontrados,
        metodo: 'principio_ativo'
      };
    }

    console.log(`[ETAPA 2] ❌ Nenhum produto encontrado`);
    return {
      encontrado: false,
      produtos: [],
      principiosEncontrados,
      metodo: 'principio_ativo'
    };
  } catch (error) {
    console.error(`[ETAPA 2] ⚠️ Erro:`, error.message);
    throw error;
  }
}

async function buscarPorPrincipioAtivoIdsLegado(principioIds, formaFarmaceutica, variacoesForma, variacoesConcentracao = []) {
  if (!Array.isArray(principioIds) || principioIds.length === 0) {
    return {
      encontrado: false,
      produtos: [],
      metodo: 'principio_ativo_por_ids'
    };
  }

  console.log(`\n[ETAPA 2B] Expandindo por PRINCIPIO ATIVO IDs: ${principioIds.join(', ')}`);

  try {
    const principioPlaceholders = principioIds.map((_, idx) => `$${idx + 1}`).join(',');
    let queryProdutos = `
      SELECT 
        p.id,
        p.codigo,
        p.descricao,
        p.status,
        p.registroms,
        p.fabricanteid,
        pa.id as principioativo_id,
        pa.nome as principioativo_nome,
        em.id as embalagem_id,
        em.descricao as embalagem_descricao,
        em.codigobarras
      FROM produto p
      INNER JOIN principioativo pa ON p.principioativoid = pa.id
      INNER JOIN embalagem em ON em.produtoid = p.id
      WHERE pa.id IN (${principioPlaceholders})
        AND p.status = 'A'
    `;

    let params = [...principioIds];

    if (formaFarmaceutica && variacoesForma.length > 0) {
      const startIdx = principioIds.length + 1;
      const formaPlaceholders = variacoesForma.map((_, idx) => `p.descricao ILIKE $${startIdx + idx}`).join(' OR ');
      queryProdutos += ` AND (${formaPlaceholders})`;
      params.push(...variacoesForma.map(v => `%${v}%`));
      console.log(`[ETAPA 2B] Filtrando por formas: ${variacoesForma.join(', ')}`);
    }

    queryProdutos += ` ORDER BY p.descricao LIMIT 200`;

    const resultadoProdutos = await pool.query(queryProdutos, params);

    if (resultadoProdutos.rows.length === 0 && formaFarmaceutica) {
      const querySemForma = `
        SELECT 
          p.id,
          p.codigo,
          p.descricao,
          p.status,
          p.registroms,
          p.fabricanteid,
          pa.id as principioativo_id,
          pa.nome as principioativo_nome,
          em.id as embalagem_id,
          em.descricao as embalagem_descricao,
          em.codigobarras
        FROM produto p
        INNER JOIN principioativo pa ON p.principioativoid = pa.id
        INNER JOIN embalagem em ON em.produtoid = p.id
        WHERE pa.id IN (${principioPlaceholders})
          AND p.status = 'A'
        ORDER BY p.descricao
        LIMIT 200
      `;

      const resultadoSemForma = await pool.query(querySemForma, principioIds);
      if (resultadoSemForma.rows.length > 0) {
        console.log(`[ETAPA 2B] Encontrados ${resultadoSemForma.rows.length} produtos (sem forma)`);
        return {
          encontrado: true,
          produtos: resultadoSemForma.rows,
          metodo: 'principio_ativo_por_ids_sem_forma'
        };
      }
    } else if (resultadoProdutos.rows.length > 0) {
      console.log(`[ETAPA 2B] Encontrados ${resultadoProdutos.rows.length} produtos`);
      return {
        encontrado: true,
        produtos: resultadoProdutos.rows,
        metodo: 'principio_ativo_por_ids'
      };
    }

    return {
      encontrado: false,
      produtos: [],
      metodo: 'principio_ativo_por_ids'
    };
  } catch (error) {
    console.error(`[ETAPA 2B] Erro:`, error.message);
    throw error;
  }
}

function construirMetodoPrincipioAtivo(baseMetodo, filtroAplicado) {
  if (!filtroAplicado || filtroAplicado === 'sem_resultados') {
    return baseMetodo;
  }

  return filtroAplicado === 'sem_filtros'
    ? `${baseMetodo}_sem_filtros`
    : `${baseMetodo}_${filtroAplicado}`;
}

async function buscarPorPrincipioAtivo(principioAtivo, formaFarmaceutica, variacoesForma, variacoesConcentracao = []) {
  console.log(`\n[ETAPA 2] Buscando por PRINCÍPIO ATIVO: "${principioAtivo}"`);

  try {
    const termosFlexiveis = [...new Set([
      principioAtivo,
      ...gerarVariacoesPrincipioAtivo(principioAtivo)
    ].filter(Boolean))];
    const principiosEncontrados = await buscarPrincipiosAtivosPorTermoFlexivel(termosFlexiveis);

    if (principiosEncontrados.length === 0) {
      console.log(`[ETAPA 2] Nenhum princípio ativo encontrado`);
      return {
        encontrado: false,
        produtos: [],
        principiosEncontrados: [],
        metodo: 'principio_ativo'
      };
    }

    console.log(`[ETAPA 2] Encontrados ${principiosEncontrados.length} princípios ativos`);
    const principioIds = principiosEncontrados.map(principio => principio.id);
    const resultadoProdutos = await buscarProdutosPorPrincipioIdsComFallback(principioIds, {
      variacoesForma,
      variacoesConcentracao,
      limite: 100,
      etapaLog: 'ETAPA 2'
    });

    if (resultadoProdutos.rows.length > 0) {
      console.log(`[ETAPA 2] Encontrados ${resultadoProdutos.rows.length} produtos`);
      return {
        encontrado: true,
        produtos: resultadoProdutos.rows,
        principiosEncontrados,
        metodo: construirMetodoPrincipioAtivo('principio_ativo', resultadoProdutos.filtroAplicado)
      };
    }

    console.log(`[ETAPA 2] Nenhum produto encontrado`);
    return {
      encontrado: false,
      produtos: [],
      principiosEncontrados,
      metodo: 'principio_ativo'
    };
  } catch (error) {
    console.error(`[ETAPA 2] Erro:`, error.message);
    throw error;
  }
}

async function buscarPorPrincipioAtivoIds(principioIds, formaFarmaceutica, variacoesForma, variacoesConcentracao = []) {
  if (!Array.isArray(principioIds) || principioIds.length === 0) {
    return {
      encontrado: false,
      produtos: [],
      metodo: 'principio_ativo_por_ids'
    };
  }

  console.log(`\n[ETAPA 2B] Expandindo por PRINCIPIO ATIVO IDs: ${principioIds.join(', ')}`);

  try {
    const resultadoProdutos = await buscarProdutosPorPrincipioIdsComFallback(principioIds, {
      variacoesForma,
      variacoesConcentracao,
      limite: 200,
      etapaLog: 'ETAPA 2B'
    });

    if (resultadoProdutos.rows.length > 0) {
      console.log(`[ETAPA 2B] Encontrados ${resultadoProdutos.rows.length} produtos`);
      return {
        encontrado: true,
        produtos: resultadoProdutos.rows,
        metodo: construirMetodoPrincipioAtivo('principio_ativo_por_ids', resultadoProdutos.filtroAplicado)
      };
    }

    return {
      encontrado: false,
      produtos: [],
      metodo: 'principio_ativo_por_ids'
    };
  } catch (error) {
    console.error(`[ETAPA 2B] Erro:`, error.message);
    throw error;
  }
}

async function verificarDisponibilidade(produtos, unidadeNegocioId) {
  console.log(`\n[ETAPA 3] Verificando DISPONIBILIDADE de ${produtos.length} produtos...`);

  if (produtos.length === 0) {
    console.log(`[ETAPA 3] ⚠️ Nenhum produto para verificar`);
    return [];
  }

  try {
    const embalagemIds = produtos.map(p => p.embalagem_id);
    const placeholders = embalagemIds.map((_, idx) => `$${idx + 1}`).join(',');

    const resultado = await pool.query(`
      SELECT 
        embalagemid,
        COALESCE(estoque, 0) as estoque_disponivel
      FROM estoque
      WHERE embalagemid IN (${placeholders})
        AND unidadenegocioid = $${embalagemIds.length + 1}
    `, [...embalagemIds, unidadeNegocioId]);

    const estoqueMap = {};
    resultado.rows.forEach(row => {
      estoqueMap[row.embalagemid] = row.estoque_disponivel;
    });

    const precosMap = await buscarPrecosEOfertas(embalagemIds, unidadeNegocioId);

    produtos.forEach(produto => {
      produto.estoque_disponivel = estoqueMap[produto.embalagem_id] || 0;
      produto.tem_estoque = (estoqueMap[produto.embalagem_id] || 0) > 0;

      const precoInfo = precosMap[produto.embalagem_id] || {};
      produto.precos = precoInfo;
    });

    const produtosComEstoque = produtos.filter(p => p.tem_estoque);
    const produtosSemEstoque = produtos.filter(p => !p.tem_estoque);

    console.log(`[ETAPA 3] ✅ ${produtosComEstoque.length} com estoque | ❌ ${produtosSemEstoque.length} sem estoque`);

    return produtosComEstoque;
  } catch (error) {
    console.error(`[ETAPA 3] ⚠️ Erro:`, error.message);
    throw error;
  }
}

module.exports = {
  buscarPrecosEOfertas,
  buscarCandidatosCorrecaoTermo,
  sugerirCorrecaoTermo,
  buscarPorDescricao,
  buscarPorPrincipioAtivo,
  buscarPorPrincipioAtivoIds,
  buscarPrincipiosAtivosPorTermoFlexivel,
  verificarDisponibilidade
};
